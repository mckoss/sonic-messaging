import type { FskDetectorOptions } from './contracts';

// Bound memory on mobile; recordings remain available to download at the limit.
export const MAX_RECORDING_SECONDS = 120;
export const MAX_RECORDING_BYTES = 100 * 1024 * 1024;
export interface RecordingMetadata {
  format: 'sonic-recording';
  version: 1;
  createdAt: string;
  appVersion: string;
  sampleRate: number;
  fsk: FskDetectorOptions;
  inputSettings: MediaTrackSettings;
  userAgent: string;
  notes: string;
}
export interface Recording { metadata: RecordingMetadata; samples: Float32Array }

export function validateMetadata(value: unknown): RecordingMetadata {
  const m = value as RecordingMetadata | undefined;
  if (!m || m.format !== 'sonic-recording' || m.version !== 1 ||
      !Number.isInteger(m.sampleRate) || m.sampleRate < 8000 || m.sampleRate > 192000 ||
      typeof m.createdAt !== 'string' || typeof m.appVersion !== 'string' ||
      typeof m.notes !== 'string' || typeof m.userAgent !== 'string' ||
      !m.inputSettings || typeof m.inputSettings !== 'object' ||
      !m.fsk || !Array.isArray(m.fsk.frequencies) ||
      ![2, 4, 8, 16].includes(m.fsk.frequencies.length) ||
      !Number.isFinite(m.fsk.symbolRate) || m.fsk.symbolRate < 1 || m.fsk.symbolRate > 2000 ||
      m.fsk.frequencies.some((f, i, a) => !Number.isFinite(f) || f <= 0 || f >= m.sampleRate / 2 ||
        (i > 0 && Math.abs(f - a[0] - i * (a[1] - a[0])) > 0.001)) ||
      m.fsk.frequencies[1] <= m.fsk.frequencies[0]) {
    throw new Error('Unsupported or invalid Sonic Messaging recording settings');
  }
  return m;
}

/** Retains copies before capture buffers are transferred or dropped by live DSP. */
export class RecordingCapture {
  private chunks: Float32Array[] = [];
  private count = 0;
  private nextSequence?: number;
  constructor(readonly metadata: RecordingMetadata) { validateMetadata(metadata); }
  get seconds(): number { return this.count / this.metadata.sampleRate; }
  append(samples: Float32Array, sampleRate: number, sequence: number): boolean {
    if (sampleRate !== this.metadata.sampleRate ||
        (this.nextSequence !== undefined && sequence !== this.nextSequence)) {
      throw new Error('Capture interrupted; recording stopped at the last continuous sample');
    }
    this.nextSequence = sequence + 1;
    const remaining = MAX_RECORDING_SECONDS * sampleRate - this.count;
    const copy = samples.slice(0, remaining);
    this.chunks.push(copy); this.count += copy.length;
    return this.count >= MAX_RECORDING_SECONDS * sampleRate;
  }
  finish(): Recording {
    const samples = new Float32Array(this.count);
    let offset = 0;
    for (const chunk of this.chunks) { samples.set(chunk, offset); offset += chunk.length; }
    this.chunks = [];
    return { metadata: this.metadata, samples };
  }
}

/** IEEE float WAV preserves captured Float32 values; sMET embeds experiment settings. */
export function encodeRecording(recording: Recording): ArrayBuffer {
  const { metadata, samples } = recording;
  validateMetadata(metadata);
  const json = new TextEncoder().encode(JSON.stringify(metadata));
  const padded = json.length + (json.length % 2);
  const buffer = new ArrayBuffer(64 + padded + samples.length * 4);
  const view = new DataView(buffer);
  const tag = (at: number, text: string) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  tag(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); view.setUint16(22, 1, true);
  view.setUint32(24, metadata.sampleRate, true); view.setUint32(28, metadata.sampleRate * 4, true);
  view.setUint16(32, 4, true); view.setUint16(34, 32, true);
  tag(36, 'fact'); view.setUint32(40, 4, true); view.setUint32(44, samples.length, true);
  tag(48, 'sMET'); view.setUint32(52, json.length, true); new Uint8Array(buffer, 56, json.length).set(json);
  tag(56 + padded, 'data'); view.setUint32(60 + padded, samples.length * 4, true);
  for (let i = 0; i < samples.length; i++) view.setFloat32(64 + padded + i * 4, samples[i], true);
  return buffer;
}

export function decodeRecording(buffer: ArrayBuffer): Recording {
  const fail = () => { throw new Error('Load a lossless WAV saved by Sonic Messaging with embedded recording settings'); };
  if (buffer.byteLength < 64 || buffer.byteLength > MAX_RECORDING_BYTES) return fail();
  const view = new DataView(buffer);
  const tag = (at: number) => String.fromCharCode(...new Uint8Array(buffer, at, 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) !== buffer.byteLength - 8) return fail();
  let sampleRate = 0, metadata: RecordingMetadata | undefined, data: { offset: number; size: number } | undefined;
  for (let offset = 12; offset < buffer.byteLength;) {
    if (offset + 8 > buffer.byteLength) return fail();
    const id = tag(offset), size = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + size + size % 2 > buffer.byteLength) return fail();
    if (id === 'fmt ') {
      if (sampleRate || size < 16 || view.getUint16(start, true) !== 3 ||
          view.getUint16(start + 2, true) !== 1 || view.getUint16(start + 14, true) !== 32 ||
          view.getUint16(start + 12, true) !== 4) return fail();
      sampleRate = view.getUint32(start + 4, true);
    } else if (id === 'sMET') {
      if (metadata || size > 65536) return fail();
      metadata = validateMetadata(JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, size))));
    } else if (id === 'data') {
      if (data || size % 4) return fail();
      data = { offset: start, size };
    }
    offset = start + size + size % 2;
  }
  if (!metadata || metadata.sampleRate !== sampleRate || !data?.size ||
      data.size / 4 > MAX_RECORDING_SECONDS * sampleRate) return fail();
  const samples = new Float32Array(data.size / 4);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getFloat32(data.offset + i * 4, true);
    if (!Number.isFinite(samples[i])) return fail();
  }
  return { metadata, samples };
}
