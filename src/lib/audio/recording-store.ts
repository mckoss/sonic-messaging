import { MAX_EXPERIMENT_SECONDS, recordingWavBlob, validateMetadata, type Recording, type RecordingMetadata } from './recording';
import type { TrialMeasurement } from '../experiment';

/**
 * Experiment recordings stream into IndexedDB in small chunks, so a 10-minute run never has to fit in
 * memory and survives a reload. Samples stay Float32 so a stored run exports byte-identical WAVs.
 */
export interface StoredRecording {
  id: string; createdAt: string; role: 'controller' | 'partner' | 'unknown';
  samples: number; seconds: number; bytes: number; chunks: number; trials: number; complete: boolean;
  metadata: RecordingMetadata;
}
interface StoredChunk { id: string; index: number; samples: Float32Array }

const DB_NAME = 'sonic-recordings', DB_VERSION = 1, CHUNK_SECONDS = 5;
const chunkRange = (id: string) => IDBKeyRange.bound([id, 0], [id, Infinity]);

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Recording storage write was aborted'));
  });
}

let opening: Promise<IDBDatabase> | undefined;
export function openRecordings(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Browser storage is unavailable')); return; }
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('recordings', { keyPath: 'id' });
      open.result.createObjectStore('chunks', { keyPath: ['id', 'index'] });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('Browser storage is unavailable'));
  }).catch(error => { opening = undefined; throw error; });
  return opening;
}

export async function listRecordings(): Promise<StoredRecording[]> {
  const db = await openRecordings();
  const all = await request(db.transaction('recordings').objectStore('recordings').getAll()) as StoredRecording[];
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteRecording(id: string): Promise<void> {
  const db = await openRecordings(), tx = db.transaction(['recordings', 'chunks'], 'readwrite');
  tx.objectStore('recordings').delete(id); tx.objectStore('chunks').delete(chunkRange(id));
  await committed(tx);
}

export async function clearRecordings(): Promise<void> {
  const db = await openRecordings(), tx = db.transaction(['recordings', 'chunks'], 'readwrite');
  tx.objectStore('recordings').clear(); tx.objectStore('chunks').clear();
  await committed(tx);
}

async function read(id: string): Promise<{ info: StoredRecording; chunks: Float32Array[] }> {
  const db = await openRecordings(), tx = db.transaction(['recordings', 'chunks']);
  const [info, chunks] = await Promise.all([
    request(tx.objectStore('recordings').get(id)) as Promise<StoredRecording | undefined>,
    request(tx.objectStore('chunks').getAll(chunkRange(id))) as Promise<StoredChunk[]>
  ]);
  if (!info) throw new Error('That recording is no longer stored');
  return { info, chunks: chunks.sort((a, b) => a.index - b.index).map(c => c.samples) };
}

export async function loadStoredRecording(id: string): Promise<Recording> {
  const { info, chunks } = await read(id);
  const samples = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
  return { metadata: validateMetadata(info.metadata), samples };
}

export async function storedRecordingBlob(id: string): Promise<Blob> {
  const { info, chunks } = await read(id);
  return recordingWavBlob(info.metadata, chunks);
}

/** Appends are synchronous and cheap; writes are serialized in the background and failures reported once. */
export class RecordingWriter {
  readonly id = crypto.randomUUID();
  private pending: Float32Array[] = [];
  private pendingCount = 0;
  private count = 0;
  private stored = 0;
  private chunkIndex = 0;
  private nextSequence?: number;
  private queue: Promise<void> = Promise.resolve();
  private failure?: Error;
  private closed = false;

  private constructor(private db: IDBDatabase, readonly metadata: RecordingMetadata,
    private onError: (error: Error) => void, readonly maxSeconds: number) {
    validateMetadata(metadata);
    this.enqueue(() => this.write(false, 0));
  }

  static async create(metadata: RecordingMetadata, onError: (error: Error) => void,
    maxSeconds = MAX_EXPERIMENT_SECONDS): Promise<RecordingWriter> {
    const db = await openRecordings();
    // Best effort: ask the browser not to evict long experiment captures under storage pressure.
    void navigator.storage?.persist?.().catch(() => false);
    return new RecordingWriter(db, metadata, onError, maxSeconds);
  }

  get seconds(): number { return this.count / this.metadata.sampleRate; }
  get failed(): boolean { return !!this.failure; }

  /** Returns true once the duration cap is reached. */
  append(samples: Float32Array, sampleRate: number, sequence: number): boolean {
    if (this.closed) return true;
    if (sampleRate !== this.metadata.sampleRate ||
        (this.nextSequence !== undefined && sequence !== this.nextSequence)) {
      throw new Error('Capture interrupted; recording stopped at the last continuous sample');
    }
    this.nextSequence = sequence + 1;
    const copy = samples.slice(0, this.maxSeconds * sampleRate - this.count);
    this.pending.push(copy); this.pendingCount += copy.length; this.count += copy.length;
    if (this.pendingCount >= CHUNK_SECONDS * sampleRate) this.flush(false);
    return this.count >= this.maxSeconds * sampleRate;
  }

  /** Writes the tail and final metadata; resolves once everything is committed. */
  async finish(trials: number, measurements?: TrialMeasurement[]): Promise<void> {
    if (this.closed) return this.queue;
    this.closed = true;
    if (measurements?.length && this.metadata.cooperative) this.metadata.cooperative.measurements = measurements;
    this.flush(true, trials);
    await this.queue;
    if (this.failure) throw this.failure;
  }

  private flush(complete: boolean, trials = 0): void {
    const data = new Float32Array(this.pendingCount);
    let offset = 0;
    for (const chunk of this.pending) { data.set(chunk, offset); offset += chunk.length; }
    this.pending = []; this.pendingCount = 0;
    this.enqueue(async () => {
      const tx = this.db.transaction(['recordings', 'chunks'], 'readwrite');
      if (data.length) tx.objectStore('chunks').put({ id: this.id, index: this.chunkIndex++, samples: data } satisfies StoredChunk);
      this.stored += data.length;
      tx.objectStore('recordings').put(this.info(complete, trials));
      await committed(tx);
    });
  }

  private write(complete: boolean, trials: number): Promise<void> {
    const tx = this.db.transaction('recordings', 'readwrite');
    tx.objectStore('recordings').put(this.info(complete, trials));
    return committed(tx);
  }

  private info(complete: boolean, trials: number): StoredRecording {
    const rate = this.metadata.sampleRate;
    return { id: this.id, createdAt: this.metadata.createdAt, role: this.metadata.cooperative?.role ?? 'unknown',
      samples: this.stored, seconds: this.stored / rate, bytes: this.stored * 4, chunks: this.chunkIndex,
      trials, complete, metadata: this.metadata };
  }

  private enqueue(job: () => Promise<void>): void {
    this.queue = this.queue.then(() => this.failure ? undefined : job()).catch(error => {
      if (this.failure) return;
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.onError(this.failure);
    });
  }
}
