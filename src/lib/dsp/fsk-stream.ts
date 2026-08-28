import { bitsToBytes } from './bits';
import { SYNC_BYTES, unframe } from './frame';
import { detectFskSymbol, toneScore, windowPowerDbfs } from './fsk-detector';
import type { FskConfig } from './types';

const SYNC = SYNC_BYTES;
const HEADER_BYTES = 6;
const TRAILER_BYTES = 2;
const MAX_LIVE_PAYLOAD_BYTES = 4096;
/**
 * A corrupted length field must not leave the decoder waiting on a frame for minutes.
 * Matches the one-minute capture history so legitimate very-low-baud frames still fit.
 */
const MAX_LIVE_FRAME_SECONDS = 60;
/**
 * Mean per-symbol margin (expected-tone score minus best other tone) for the
 * matched-filter sync statistic to declare a candidate. Noise and payload data
 * average near or below zero because they do not follow the sync hop pattern;
 * a true sync accumulates positive margin on every template symbol.
 */
const SYNC_DETECT_MARGIN = 0.1;
/** Consecutive collapsed-power symbol windows that abandon a mid-frame candidate. */
const CARRIER_LOSS_ABORT_SYMBOLS = 4;
/**
 * Power drop below the frame's own sync level that counts as a lost carrier.
 * Referenced to the received signal rather than an absolute squelch, so weak
 * signals stay decodable; at low SNR ambient noise keeps windows within the
 * drop and the CRC (bounded by the frame cap) remains the arbiter.
 */
const CARRIER_LOSS_DROP_DB = 12;

/** Sync symbols whose bits are fully determined by the sync bytes (drops a mixed tail symbol). */
function syncSymbolTemplate(bitsPerSymbol: number): number[] {
  const bits: number[] = [];
  for (const byte of SYNC) for (let bit = 7; bit >= 0; bit--) bits.push((byte >>> bit) & 1);
  const template: number[] = [];
  for (let index = 0; index + bitsPerSymbol <= bits.length; index += bitsPerSymbol) {
    let value = 0;
    for (let bit = 0; bit < bitsPerSymbol; bit++) value = (value << 1) | bits[index + bit];
    template.push(value);
  }
  return template;
}

export interface FskStreamPacket {
  payload: Uint8Array;
  confidence: number;
}

/** position is the absolute stream sample index where the reported item ends. */
export type FskStreamProgress =
  | { type: 'sync'; position: number }
  | { type: 'length'; length: number; position: number }
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
  /** Carrier-loss scan state for the current candidate. */
  private candidateScannedSymbols = 0;
  private candidateSilentRun = 0;
  private candidateSyncPowerDbfs = -Infinity;
  /** Per-tone score vectors by absolute offset, shared across overlapping sync-search trials. */
  private readonly syncScanCache = new Map<number, Float32Array>();
  /** Expected tone index per sync symbol for the matched-filter search. */
  private readonly syncTemplate: number[];

  constructor(
    private readonly config: FskConfig,
    basePosition = 0
  ) {
    this.streamPosition = basePosition;
    this.bitsPerSymbol = Math.log2(config.frequencies.length);
    if (!Number.isInteger(this.bitsPerSymbol) || this.bitsPerSymbol < 1) {
      throw new Error('FSK tone count must be a power of two');
    }
    this.samplesPerSymbol = Math.round(config.sampleRate / config.symbolRate);
    this.phaseStep = Math.max(1, Math.floor(this.samplesPerSymbol / 8));
    this.syncTemplate = syncSymbolTemplate(this.bitsPerSymbol);
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
    this.candidateScannedSymbols = 0; this.candidateSilentRun = 0;
    this.syncScanCache.clear();
  }

  /** Drops the oldest `count` samples in place, keeping the buffer's capacity. */
  private discard(count: number): void {
    if (count <= 0) return;
    this.samples.copyWithin(0, count, this.sampleCount);
    this.sampleCount -= count;
    this.streamPosition += count;
  }

  /** Per-tone scores for the window at an absolute stream offset, cached for sync trials. */
  private scanScoresAt(absolute: number): Float32Array {
    const cached = this.syncScanCache.get(absolute);
    if (cached !== undefined) return cached;
    const offset = absolute - this.streamPosition;
    const decision = detectFskSymbol(
      this.samples.subarray(offset, offset + this.samplesPerSymbol),
      this.config.sampleRate,
      this.config.frequencies
    );
    this.syncScanCache.set(absolute, decision.scores);
    return decision.scores;
  }

  /**
   * Matched-filter sync statistic: mean margin of the template's expected tone over
   * the best other tone, accumulated softly across every fully-known sync symbol.
   */
  private syncScoreAt(searchOffset: number): number {
    const absolute = this.streamPosition + searchOffset;
    let sum = 0;
    for (let index = 0; index < this.syncTemplate.length; index++) {
      const scores = this.scanScoresAt(absolute + index * this.samplesPerSymbol);
      const expected = this.syncTemplate[index];
      let other = 0;
      for (let tone = 0; tone < scores.length; tone++) {
        if (tone !== expected) other = Math.max(other, scores[tone]);
      }
      sum += scores[expected] - other;
    }
    return sum / this.syncTemplate.length;
  }

  /** Sum of expected-tone scores at a trial offset; sharp in alignment, cheap to evaluate. */
  private syncAlignmentScore(offset: number): number {
    let sum = 0;
    for (let index = 0; index < this.syncTemplate.length; index++) {
      const start = offset + index * this.samplesPerSymbol;
      sum += toneScore(
        this.samples.subarray(start, start + this.samplesPerSymbol),
        this.config.sampleRate,
        this.config.frequencies[this.syncTemplate[index]]
      );
    }
    return sum;
  }

  /** Absolute stream sample index where the frame's first `bytes` bytes end (exact bit time). */
  private frameBytePosition(start: number, bytes: number): number {
    return this.streamPosition + start +
      Math.round((bytes * 8 * this.samplesPerSymbol) / this.bitsPerSymbol);
  }

  drainProgress(): FskStreamProgress[] { return this.progress.splice(0); }

  /**
   * Absolute stream position where the locked candidate frame starts, or undefined
   * while searching. Symbol boundaries fall at anchor + k * samplesPerSymbol, letting
   * displays analyze the same sample-aligned windows the decoder decides on.
   */
  lockedSymbolAnchor(): number | undefined {
    return this.candidateOffset === undefined ? undefined : this.streamPosition + this.candidateOffset;
  }

  private findSync(): boolean {
    const syncSymbols = Math.ceil((SYNC.length * 8) / this.bitsPerSymbol);
    const required = syncSymbols * this.samplesPerSymbol;
    // One symbol plus one phase step of lookahead lets phase refinement trial
    // offsets past the coarse match without running off the buffer.
    while (this.searchOffset + required + this.samplesPerSymbol + this.phaseStep <= this.sampleCount) {
      if (this.syncScoreAt(this.searchOffset) >= SYNC_DETECT_MARGIN) {
        this.candidateOffset = this.refineSyncPhase(this.searchOffset);
        this.reportedPayloadBytes = 0;
        this.reportedLength = false;
        this.candidateSymbols = []; this.candidateConfidences = [];
        this.candidateScannedSymbols = 0; this.candidateSilentRun = 0;
        // Reference power for carrier-loss detection: what this frame's sync measured.
        let syncPower = 0;
        for (let index = 0; index < this.syncTemplate.length; index++) {
          const windowStart = this.candidateOffset + index * this.samplesPerSymbol;
          syncPower += windowPowerDbfs(
            this.samples.subarray(windowStart, windowStart + this.samplesPerSymbol));
        }
        this.candidateSyncPowerDbfs = syncPower / this.syncTemplate.length;
        this.progress.push({ type: 'sync', position: this.frameBytePosition(this.candidateOffset, SYNC.length) });
        return true;
      }
      this.searchOffset += this.phaseStep;
    }
    return false;
  }

  /** Locks sync timing to the sample by maximizing the matched-filter alignment score. */
  private refineSyncPhase(start: number): number {
    const span = this.syncTemplate.length * this.samplesPerSymbol;
    const trial = (offset: number, best: { offset: number; score: number }) => {
      if (offset < 0 || offset === best.offset || offset + span > this.sampleCount) return;
      const score = this.syncAlignmentScore(offset);
      if (score > best.score) { best.offset = offset; best.score = score; }
    };
    const best = { offset: start, score: this.syncAlignmentScore(start) };
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
      // Skip the whole validated sync: a phase-step skip re-matches the same sync
      // and re-runs phase refinement repeatedly, stalling the worker for seconds.
      this.rejectCandidate(Math.ceil((SYNC.length * 8) / this.bitsPerSymbol) * this.samplesPerSymbol);
      return null;
    }
    if (!this.reportedLength) {
      this.reportedLength = true;
      this.progress.push({ type: 'length', length: payloadLength,
        position: this.frameBytePosition(start, HEADER_BYTES) });
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
    // Noise can jitter the refined phase a few samples past the true frame start,
    // so a stream that ends exactly with the frame would otherwise never complete.
    // One phase step of slack truncates at most 1/8 of the final symbol's window.
    if (start + frameSymbols * this.samplesPerSymbol > this.sampleCount + this.phaseStep) {
      // A corrupted length field can promise a frame lasting up to a minute. If the
      // carrier collapses mid-frame — several consecutive symbol windows far below
      // this frame's own sync power — abandon it instead of decoding background noise.
      const availableSymbols = Math.floor((this.sampleCount - start) / this.samplesPerSymbol);
      const lossFloor = this.candidateSyncPowerDbfs - CARRIER_LOSS_DROP_DB;
      while (this.candidateScannedSymbols < availableSymbols) {
        const windowStart = start + this.candidateScannedSymbols * this.samplesPerSymbol;
        const power = windowPowerDbfs(
          this.samples.subarray(windowStart, windowStart + this.samplesPerSymbol));
        this.candidateSilentRun = power < lossFloor ? this.candidateSilentRun + 1 : 0;
        this.candidateScannedSymbols++;
        if (this.candidateSilentRun >= CARRIER_LOSS_ABORT_SYMBOLS) {
          this.progress.push({ type: 'crc-error',
            position: this.streamPosition + windowStart + this.samplesPerSymbol });
          this.rejectCandidate(Math.ceil((SYNC.length * 8) / this.bitsPerSymbol) * this.samplesPerSymbol);
          return null;
        }
      }
      return undefined;
    }

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
    this.discard(Math.min(start + frameSymbols * this.samplesPerSymbol, this.sampleCount));
    this.searchOffset = 0; this.candidateOffset = undefined;
    this.reportedPayloadBytes = 0; this.reportedLength = false;
    this.candidateSymbols = []; this.candidateConfidences = [];
    this.candidateScannedSymbols = 0; this.candidateSilentRun = 0;
    return { payload: parsed.payload, confidence: decoded.confidence };
  }

  private rejectCandidate(skip = this.phaseStep): void {
    this.searchOffset = this.candidateOffset! + skip;
    this.candidateOffset = undefined;
    this.reportedPayloadBytes = 0;
    this.reportedLength = false;
    this.candidateSymbols = []; this.candidateConfidences = [];
    this.candidateScannedSymbols = 0; this.candidateSilentRun = 0;
  }

  /** Decodes the candidate's first `count` bytes, reusing symbols decoded on earlier calls. */
  private decodeCandidateBytes(count: number): { bytes: Uint8Array; confidence: number } {
    const start = this.candidateOffset!;
    const symbolCount = Math.ceil((count * 8) / this.bitsPerSymbol);
    while (this.candidateSymbols.length < symbolCount) {
      const offset = start + this.candidateSymbols.length * this.samplesPerSymbol;
      const decision = detectFskSymbol(
        // The final window may fall short of the buffer by the tail slack.
        this.samples.subarray(offset, Math.min(offset + this.samplesPerSymbol, this.sampleCount)),
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
