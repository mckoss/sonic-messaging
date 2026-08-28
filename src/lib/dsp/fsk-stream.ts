import { bitsToBytes } from './bits';
import { unframe } from './frame';
import { detectFskSymbol, windowPowerDbfs } from './fsk-detector';
import type { FskConfig } from './types';

const SYNC = [0xd3, 0x91, 0xd3, 0x91];
const HEADER_BYTES = 6;
const TRAILER_BYTES = 2;
const MAX_SYNC_BIT_ERRORS = 2;
const MAX_LIVE_PAYLOAD_BYTES = 4096;
/** A corrupted length field must not leave the decoder waiting on a frame for minutes. */
const MAX_LIVE_FRAME_SECONDS = 10;

function syncBitErrors(bytes: Uint8Array): number {
  let errors = 0;
  for (let index = 0; index < SYNC.length; index++) {
    let difference = (bytes[index] ?? 0) ^ SYNC[index];
    while (difference) { errors += difference & 1; difference >>>= 1; }
  }
  return errors;
}

export interface FskStreamPacket {
  payload: Uint8Array;
  confidence: number;
}

/** position is the absolute stream sample index where the reported item ends. */
export type FskStreamProgress =
  | { type: 'sync' | 'length'; position: number }
  | { type: 'byte'; byte: number; position: number }
  | { type: 'crc-confirm' | 'crc-error'; position: number };

/** Acquires framed FSK packets in an arbitrarily chunked continuous sample stream. */
export class FskStreamDecoder {
  private samples = new Float32Array(0);
  /** Valid samples in the buffer; capacity beyond this is growth headroom. */
  private sampleCount = 0;
  private searchOffset = 0;
  private candidateOffset: number | undefined;
  private readonly samplesPerSymbol: number;
  private readonly bitsPerSymbol: number;
  private readonly phaseStep: number;
  private progress: FskStreamProgress[] = [];
  private reportedPayloadBytes = 0;
  private reportedLength = false;
  /** Absolute stream sample index of samples[0]. */
  private streamPosition: number;
  /** Decoded symbols/confidences for the current candidate, relative to its start. */
  private candidateSymbols: number[] = [];
  private candidateConfidences: number[] = [];
  /** Argmax symbols by absolute offset, shared across overlapping sync-search trials. */
  private readonly syncScanCache = new Map<number, number>();

  constructor(
    private readonly config: FskConfig,
    private readonly squelchDbfs = -Infinity,
    basePosition = 0
  ) {
    this.streamPosition = basePosition;
    this.bitsPerSymbol = Math.log2(config.frequencies.length);
    if (!Number.isInteger(this.bitsPerSymbol) || this.bitsPerSymbol < 1) {
      throw new Error('FSK tone count must be a power of two');
    }
    this.samplesPerSymbol = Math.round(config.sampleRate / config.symbolRate);
    this.phaseStep = Math.max(1, Math.floor(this.samplesPerSymbol / 8));
  }

  push(input: Float32Array): FskStreamPacket[] {
    if (this.sampleCount + input.length > this.samples.length) {
      const grown = new Float32Array(Math.max(this.sampleCount + input.length, this.samples.length * 2, 16_384));
      grown.set(this.samples.subarray(0, this.sampleCount));
      this.samples = grown;
    }
    this.samples.set(input, this.sampleCount);
    this.sampleCount += input.length;
    const packets: FskStreamPacket[] = [];

    while (true) {
      if (this.candidateOffset === undefined && !this.findSync()) break;
      const result = this.readCandidate();
      if (result === undefined) break;
      if (result) packets.push(result);
    }
    this.trim();
    return packets;
  }

  reset(): void {
    this.samples = new Float32Array(0); this.sampleCount = 0;
    this.searchOffset = 0; this.candidateOffset = undefined;
    this.progress = []; this.reportedPayloadBytes = 0; this.reportedLength = false;
    this.streamPosition = 0;
    this.candidateSymbols = []; this.candidateConfidences = [];
    this.syncScanCache.clear();
  }

  /** Drops the oldest `count` samples in place, keeping the buffer's capacity. */
  private discard(count: number): void {
    if (count <= 0) return;
    this.samples.copyWithin(0, count, this.sampleCount);
    this.sampleCount -= count;
    this.streamPosition += count;
  }

  /** Argmax symbol for the window at an absolute stream offset, cached for sync trials. */
  private scanSymbolAt(absolute: number): number {
    const cached = this.syncScanCache.get(absolute);
    if (cached !== undefined) return cached;
    const offset = absolute - this.streamPosition;
    const decision = detectFskSymbol(
      this.samples.subarray(offset, offset + this.samplesPerSymbol),
      this.config.sampleRate,
      this.config.frequencies
    );
    let symbol = 0;
    for (let index = 1; index < decision.scores.length; index++) {
      if (decision.scores[index] > decision.scores[symbol]) symbol = index;
    }
    this.syncScanCache.set(absolute, symbol);
    return symbol;
  }

  /** Sync-length bytes at a trial offset, assembled from cached scan symbols. */
  private scanSyncBytes(searchOffset: number): Uint8Array {
    const symbolCount = Math.ceil((SYNC.length * 8) / this.bitsPerSymbol);
    const absolute = this.streamPosition + searchOffset;
    const bits: number[] = [];
    for (let index = 0; index < symbolCount; index++) {
      const symbol = this.scanSymbolAt(absolute + index * this.samplesPerSymbol);
      for (let bit = this.bitsPerSymbol - 1; bit >= 0; bit--) bits.push((symbol >>> bit) & 1);
    }
    return bitsToBytes(bits).slice(0, SYNC.length);
  }

  /** Absolute stream sample index where the frame's first `bytes` bytes end (exact bit time). */
  private frameBytePosition(start: number, bytes: number): number {
    return this.streamPosition + start +
      Math.round((bytes * 8 * this.samplesPerSymbol) / this.bitsPerSymbol);
  }

  drainProgress(): FskStreamProgress[] { return this.progress.splice(0); }

  private findSync(): boolean {
    const syncSymbols = Math.ceil((SYNC.length * 8) / this.bitsPerSymbol);
    const required = syncSymbols * this.samplesPerSymbol;
    while (this.searchOffset + required <= this.sampleCount) {
      const firstWindow = this.samples.subarray(this.searchOffset, this.searchOffset + this.samplesPerSymbol);
      if (windowPowerDbfs(firstWindow) < this.squelchDbfs) {
        this.searchOffset += this.phaseStep;
        continue;
      }
      if (syncBitErrors(this.scanSyncBytes(this.searchOffset)) <= MAX_SYNC_BIT_ERRORS) {
        // Wait for one symbol of lookahead so phase refinement has samples to trial;
        // accepting immediately locks a coarse phase that can corrupt the whole frame.
        const lookahead = required + this.samplesPerSymbol + this.phaseStep;
        if (this.searchOffset + lookahead > this.sampleCount) return false;
        const decoded = this.decodeBytes(this.searchOffset, SYNC.length);
        this.candidateOffset = this.refineSyncPhase(this.searchOffset, decoded.confidence);
        this.reportedPayloadBytes = 0;
        this.reportedLength = false;
        this.candidateSymbols = []; this.candidateConfidences = [];
        this.progress.push({ type: 'sync', position: this.frameBytePosition(this.candidateOffset, SYNC.length) });
        return true;
      }
      this.searchOffset += this.phaseStep;
    }
    return false;
  }

  /** Locks sync timing to the sample by maximizing sync confidence near the first match. */
  private refineSyncPhase(start: number, confidence: number): number {
    const required = Math.ceil((SYNC.length * 8) / this.bitsPerSymbol) * this.samplesPerSymbol;
    const trial = (offset: number, best: { offset: number; confidence: number }) => {
      if (offset < 0 || offset === best.offset || offset + required > this.sampleCount) return;
      const decoded = this.decodeBytes(offset, SYNC.length);
      if (syncBitErrors(decoded.bytes) <= MAX_SYNC_BIT_ERRORS && decoded.confidence > best.confidence) {
        best.offset = offset; best.confidence = decoded.confidence;
      }
    };
    const best = { offset: start, confidence };
    for (let offset = start + this.phaseStep; offset < start + this.samplesPerSymbol; offset += this.phaseStep) {
      trial(offset, best);
    }
    // Descend to sample accuracy with shrinking radius instead of an exhaustive scan.
    let radius = this.phaseStep, step = Math.max(1, Math.floor(this.phaseStep / 8));
    while (true) {
      const center = best.offset;
      for (let offset = center - radius; offset <= center + radius; offset += step) trial(offset, best);
      if (step === 1) break;
      radius = step; step = Math.max(1, Math.floor(step / 8));
    }
    return best.offset;
  }

  /** undefined means incomplete, null means rejected, and a value is a valid packet. */
  private readCandidate(): FskStreamPacket | null | undefined {
    const start = this.candidateOffset!;
    const headerSymbols = Math.ceil((HEADER_BYTES * 8) / this.bitsPerSymbol);
    if (start + headerSymbols * this.samplesPerSymbol > this.sampleCount) return undefined;
    const header = this.decodeCandidateBytes(HEADER_BYTES).bytes;
    const payloadLength = (header[4] << 8) | header[5];
    const maxPayload = Math.min(MAX_LIVE_PAYLOAD_BYTES, Math.floor(
      (MAX_LIVE_FRAME_SECONDS * this.config.symbolRate * this.bitsPerSymbol) / 8
    ) - HEADER_BYTES - TRAILER_BYTES);
    if (payloadLength > Math.max(0, maxPayload)) {
      this.rejectCandidate();
      return null;
    }
    if (!this.reportedLength) {
      this.reportedLength = true;
      this.progress.push({ type: 'length', position: this.frameBytePosition(start, HEADER_BYTES) });
    }
    const frameBytes = HEADER_BYTES + payloadLength + TRAILER_BYTES;
    const frameSymbols = Math.ceil((frameBytes * 8) / this.bitsPerSymbol);
    const availableBytes = Math.floor(
      (Math.floor((this.sampleCount - start) / this.samplesPerSymbol) * this.bitsPerSymbol) / 8
    );
    const reportThrough = Math.min(payloadLength, Math.max(0, availableBytes - HEADER_BYTES));
    if (reportThrough > this.reportedPayloadBytes) {
      const partial = this.decodeCandidateBytes(HEADER_BYTES + reportThrough).bytes;
      for (let index = this.reportedPayloadBytes; index < reportThrough; index++) {
        this.progress.push({ type: 'byte', byte: partial[HEADER_BYTES + index],
          position: this.frameBytePosition(start, HEADER_BYTES + index + 1) });
      }
      this.reportedPayloadBytes = reportThrough;
    }
    if (start + frameSymbols * this.samplesPerSymbol > this.sampleCount) return undefined;

    const decoded = this.decodeCandidateBytes(frameBytes);
    decoded.bytes.set(SYNC, 0);
    const parsed = unframe(decoded.bytes);
    const framePosition = this.frameBytePosition(start, frameBytes);
    if (!parsed.payload) {
      this.progress.push({ type: 'crc-error', position: framePosition });
      // The sync itself was validated, so resume the search beyond it rather than
      // re-matching the same sync at slightly shifted phases.
      this.rejectCandidate(Math.ceil((SYNC.length * 8) / this.bitsPerSymbol) * this.samplesPerSymbol);
      return null;
    }
    this.progress.push({ type: 'crc-confirm', position: framePosition });
    this.discard(start + frameSymbols * this.samplesPerSymbol);
    this.searchOffset = 0; this.candidateOffset = undefined;
    this.reportedPayloadBytes = 0; this.reportedLength = false;
    this.candidateSymbols = []; this.candidateConfidences = [];
    return { payload: parsed.payload, confidence: decoded.confidence };
  }

  private rejectCandidate(skip = this.phaseStep): void {
    this.searchOffset = this.candidateOffset! + skip;
    this.candidateOffset = undefined;
    this.reportedPayloadBytes = 0;
    this.reportedLength = false;
    this.candidateSymbols = []; this.candidateConfidences = [];
  }

  /** Decodes the candidate's first `count` bytes, reusing symbols decoded on earlier calls. */
  private decodeCandidateBytes(count: number): { bytes: Uint8Array; confidence: number } {
    const start = this.candidateOffset!;
    const symbolCount = Math.ceil((count * 8) / this.bitsPerSymbol);
    while (this.candidateSymbols.length < symbolCount) {
      const offset = start + this.candidateSymbols.length * this.samplesPerSymbol;
      const decision = detectFskSymbol(
        this.samples.subarray(offset, offset + this.samplesPerSymbol),
        this.config.sampleRate,
        this.config.frequencies
      );
      let symbol = 0;
      for (let index = 1; index < decision.scores.length; index++) {
        if (decision.scores[index] > decision.scores[symbol]) symbol = index;
      }
      this.candidateSymbols.push(symbol);
      this.candidateConfidences.push(decision.confidence);
    }
    const bits: number[] = [];
    let confidence = 0;
    for (let index = 0; index < symbolCount; index++) {
      confidence += this.candidateConfidences[index];
      for (let bit = this.bitsPerSymbol - 1; bit >= 0; bit--) {
        bits.push((this.candidateSymbols[index] >>> bit) & 1);
      }
    }
    return { bytes: bitsToBytes(bits).slice(0, count), confidence: confidence / Math.max(1, symbolCount) };
  }

  private decodeBytes(offset: number, count: number): { bytes: Uint8Array; confidence: number } {
    const bitCount = count * 8;
    const symbolCount = Math.ceil(bitCount / this.bitsPerSymbol);
    const bits: number[] = [];
    let confidence = 0;
    for (let symbolIndex = 0; symbolIndex < symbolCount; symbolIndex++) {
      const start = offset + symbolIndex * this.samplesPerSymbol;
      const decision = detectFskSymbol(
        this.samples.subarray(start, start + this.samplesPerSymbol),
        this.config.sampleRate,
        this.config.frequencies
      );
      confidence += decision.confidence;
      // Always take the strongest tone: sync matching and the CRC validate the
      // frame, so display-oriented confidence gates must not corrupt bits here.
      let symbol = 0;
      for (let index = 1; index < decision.scores.length; index++) {
        if (decision.scores[index] > decision.scores[symbol]) symbol = index;
      }
      for (let bit = this.bitsPerSymbol - 1; bit >= 0; bit--) {
        bits.push((symbol >>> bit) & 1);
      }
    }
    return { bytes: bitsToBytes(bits).slice(0, count), confidence: confidence / Math.max(1, symbolCount) };
  }

  private trim(): void {
    if (this.candidateOffset !== undefined) {
      if (this.candidateOffset > 0) {
        this.discard(this.candidateOffset);
        this.searchOffset = 0; this.candidateOffset = 0;
      }
    } else {
      const retain = Math.ceil((SYNC.length * 8) / this.bitsPerSymbol) * this.samplesPerSymbol;
      const removable = Math.max(0, this.searchOffset - retain);
      if (removable > 0) {
        this.discard(removable);
        this.searchOffset -= removable;
      }
    }
    for (const key of this.syncScanCache.keys()) {
      if (key < this.streamPosition) this.syncScanCache.delete(key);
    }
  }
}
