import { resultsJson, type ExperimentResults } from './experiment-results';

/**
 * Experiment results files live in their own IndexedDB database, beside the recordings' but separate from it, so
 * that neither store's failures or migrations can touch the other. A run's document is written whole and rewritten
 * as it grows; they are small (a long run is under a megabyte), so a full rewrite per trial is cheap.
 */
export interface StoredResults {
  id: string; createdAt: string; role: ExperimentResults['device']['role']; sender: string;
  trials: number; frames: number; bytes: number; finished: boolean;
  results: ExperimentResults;
}

const DB_NAME = 'sonic-results', DB_VERSION = 1, STORE = 'results';

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Results storage write was aborted'));
  });
}

let opening: Promise<IDBDatabase> | undefined;
export function openResults(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Browser storage is unavailable')); return; }
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => { open.result.createObjectStore(STORE, { keyPath: 'id' }); };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('Browser storage is unavailable'));
  }).catch(error => { opening = undefined; throw error; });
  return opening;
}

/** One document per run: its start time and the device that wrote it name it. */
export const resultsId = (results: ExperimentResults): string => `${results.createdAt}-${results.device.sender}`;

export async function listResults(): Promise<StoredResults[]> {
  const db = await openResults();
  const all = await request(db.transaction(STORE).objectStore(STORE).getAll()) as StoredResults[];
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Writes (or rewrites) a run's document. */
export async function putResults(results: ExperimentResults): Promise<StoredResults> {
  const entry: StoredResults = {
    id: resultsId(results), createdAt: results.createdAt, role: results.device.role, sender: results.device.sender,
    trials: results.trials.length, frames: results.frames.length, bytes: resultsJson(results).length, finished: !!results.finishedAt,
    results
  };
  const db = await openResults(), tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(entry);
  await committed(tx);
  return entry;
}

export async function deleteResults(id: string): Promise<void> {
  const db = await openResults(), tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(id);
  await committed(tx);
}

export async function clearResults(): Promise<void> {
  const db = await openResults(), tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  await committed(tx);
}

export async function loadResults(id: string): Promise<ExperimentResults> {
  const db = await openResults();
  const entry = await request(db.transaction(STORE).objectStore(STORE).get(id)) as StoredResults | undefined;
  if (!entry) throw new Error('Those results are no longer stored');
  return entry.results;
}
