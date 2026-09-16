import { bitsToBytes } from './bits';
import { ADDRESS_OFFSET, decodeFrameLength, LENGTH_BYTES, LENGTH_OFFSET, MAX_PAYLOAD_BYTES, PAYLOAD_OFFSET, readFrameAddress, SYNC_BYTES, unframe } from './frame';
import { detectFskSymbol, toneScore, windowPowerDbfs } from './fsk-detector';
import { SymbolTimingLoop } from './symbol-timing';
import { cancelEcho, estimateEchoTaps } from './echo-canceller';
import { softCandidates } from './soft-decode';
import type { FskConfig } from './types';

const SYNC = SYNC_BYTES;
/** Sync and length: enough to size the frame before its address and payload arrive. */
const HEADER_BYTES = SYNC.length + LENGTH_BYTES;
const TRAILER_BYTES = 2;
const MAX_LIVE_PAYLOAD_BYTES = MAX_PAYLOAD_BYTES;
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
/**
 * Hard verification after the soft prefilter: at the refined alignment, every
 * sync symbol but at most this many must decode to its expected tone. One
 * mismatch is tolerated so a single impulse hit does not drop an otherwise
 * clean packet; the false-sync rate stays ~(1+3K)·M^-K per trial (months
 * between false syncs), where soft-score-only gating fired constantly on
 * fluctuating in-band interference. A frame whose sync symbols cannot be read
 * would not survive the payload CRC anyway, so the hard gate costs no real
 * sensitivity.
 */
const SYNC_VERIFY_MAX_MISMATCHES = 1;
/** Consecutive collapsed-power symbol windows that abandon a mid-frame candidate. */
const CARRIER_LOSS_ABORT_SYMBOLS = 4;
/**
 * Power drop below the frame's *tracked* level that counts as a lost carrier.
 * Referenced to the received signal rather than an absolute squelch, so weak
 * signals stay decodable; at low SNR ambient noise keeps windows within the
 * drop and the CRC (bounded by the frame cap) remains the arbiter.
 */
const CARRIER_LOSS_DROP_DB = 12;
/**
 * How fast the reference level follows the frame it is already receiving.
 *
 * A phone transmitting a multi-second tone does not hold its level: the speaker's
 * protection limiter pulls the output down as the voice coil heats, and recordings
 * show 13 dB of fade over the first 2.5 s of an 8 s frame. Referenced to the sync
 * power alone, that ordinary fade looks exactly like the transmitter going away,
 * and a perfectly readable frame gets abandoned a quarter of the way in. Tracking
 * the level per symbol absorbs any fade gradual enough to still be a carrier,
 * while a transmitter that actually stops drops tens of dB within one symbol and
 * still trips the guard.
 */
const CARRIER_LEVEL_TRACK = 0.25;

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
  sender: number;
  seq: number;
  frameType: number;
  ackRequested: boolean;
  confidence: number;
  startPosition: number;
  endPosition: number;
  /** The frame decoded only after its echoes were cancelled. */
  echoCancelled?: boolean;
  /** The frame decoded only after this many weak symbols were flipped to their runner-up tone. */
  softCorrected?: number;
}

/**
 * Every fully decoded frame, whether or not its CRC passed, with the symbol decisions the receiver made. Lets
 * experiments score ordinary reception: symbol errors and S/N of what was actually heard, including corrupted frames.
 */
export interface FskStreamFrame {
  crcOk: boolean;
  /** The CRC only passed after echo cancellation, with these fitted echo gains (strongest first delay first). */
  echoCancelled?: boolean;
  echoTaps?: number[];
  /** The CRC only passed after this many weak symbols were flipped to their runner-up tone. */
  softCorrected?: number;
  /** From the address bytes; unverified when the CRC failed. */
  sender: number;
  seq: number;
  frameType: number;
  ackRequested: boolean;
  payloadLength: number;
  /** Decided tone index and winning-tone score for every frame symbol, sync included. */
  symbols: number[];
  scores: number[];
  confidence: number;
  startPosition: number;
  endPosition: number;
  /** Where symbol tracking had moved the sampling windows by the end of the frame, in samples. */
  timingOffset: number;
}

/** position is the absolute stream sample index where the reported item ends. */
export type FskStreamProgress =
  | { type: 'sync'; position: number }
  | { type: 'length'; length: number; position: number }
  /** Unverified until crc-confirm; lets displays label the sender while the payload streams in. */
  | { type: 'address'; sender: number; seq: number; frameType: number; ackRequested: boolean; position: number }
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
  private frames: FskStreamFrame[] = [];
  private reportedPayloadBytes = 0;
  private reportedLength = false;
  private reportedAddress = false;
  /** Absolute stream sample index of samples[0]. */
  private streamPosition: number;
  /** Decoded symbols/confidences for the current candidate, relative to its start. */
  private candidateSymbols: number[] = [];
  private candidateConfidences: number[] = [];
  private candidateScores: number[] = [];
  /** Every tone's score per symbol, kept so a failed frame can be re-decided with echoes removed. */
  private candidateToneScores: Float32Array[] = [];
  /** Echo gains fitted on an earlier frame: the room doesn't change between frames, but short frames can't fit them. */
  private roomEcho: number[] = [];
  /** Tracks symbol timing through the current candidate after sync acquisition. */
  private timing!: SymbolTimingLoop;
  /** Carrier-loss scan state for the current candidate. */
  private candidateScannedSymbols = 0;
  private candidateSilentRun = 0;
  /** Reference level for carrier loss: starts at the sync power and follows the frame's own level as it is read. */
  private candidateLevelDbfs = -Infinity;
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
    this.resetTiming();
  }

  private resetTiming(): void {
    this.timing = new SymbolTimingLoop(this.samplesPerSymbol, this.config.sampleRate, this.config.frequencies);
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
    this.progress = []; this.frames = []; this.reportedPayloadBytes = 0; this.reportedLength = false; this.reportedAddress = false;
    this.streamPosition = 0;
    this.candidateSymbols = []; this.candidateConfidences = []; this.candidateScores = []; this.candidateToneScores = []; this.resetTiming();
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
   *
   * Two tones need a balanced variant. The plain margin at 2-FSK reduces to
   * ±(score₀ − score₁) per symbol, and the 32-bit sync is unbalanced (19 ones
   * to 13 zeros), so a steady interferer parked on one tone — a mains-hum
   * harmonic at 600 Hz, say — biases every trial offset by imbalance × its
   * score and fires continuous false syncs. Correlating the per-symbol tone
   * difference against the zero-meaned ±1 template cancels any constant bias
   * exactly while a genuine sync keeps 1 − (6/32)² ≈ 96% of its statistic.
   * With four or more tones the max over the other tones already biases noise
   * and steady interferers negative, so the plain margin stands.
   */
  private syncScoreAt(searchOffset: number): number {
    const absolute = this.streamPosition + searchOffset;
    const count = this.syncTemplate.length;
    if (this.config.frequencies.length === 2) {
      let sumDiff = 0, sumSigned = 0, signTotal = 0;
      for (let index = 0; index < count; index++) {
        const scores = this.scanScoresAt(absolute + index * this.samplesPerSymbol);
        const diff = scores[0] - scores[1];
        const sign = this.syncTemplate[index] === 0 ? 1 : -1;
        sumDiff += diff; sumSigned += sign * diff; signTotal += sign;
      }
      return (sumSigned - (signTotal / count) * sumDiff) / count;
    }
    let sum = 0;
    for (let index = 0; index < count; index++) {
      const scores = this.scanScoresAt(absolute + index * this.samplesPerSymbol);
      const expected = this.syncTemplate[index];
      let other = 0;
      for (let tone = 0; tone < scores.length; tone++) {
        if (tone !== expected) other = Math.max(other, scores[tone]);
      }
      sum += scores[expected] - other;
    }
    return sum / count;
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
  /** Frames completed since the last call, CRC-valid or not. */
  drainFrames(): FskStreamFrame[] { return this.frames.splice(0); }

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
      // The soft score is only a cheap prefilter; the hard per-symbol check at
      // the refined alignment is what actually establishes sync.
      if (this.syncScoreAt(this.searchOffset) >= SYNC_DETECT_MARGIN) {
        const refined = this.refineSyncPhase(this.searchOffset);
        if (!this.verifySyncSymbols(refined)) {
          this.searchOffset += this.phaseStep;
          continue;
        }
        this.candidateOffset = refined;
        this.reportedPayloadBytes = 0;
        this.reportedLength = false; this.reportedAddress = false;
        this.candidateSymbols = []; this.candidateConfidences = []; this.candidateScores = []; this.candidateToneScores = []; this.resetTiming();
        this.candidateScannedSymbols = 0; this.candidateSilentRun = 0;
        // Reference power for carrier-loss detection: what this frame's sync measured.
        let syncPower = 0;
        for (let index = 0; index < this.syncTemplate.length; index++) {
          const windowStart = this.candidateOffset + index * this.samplesPerSymbol;
          syncPower += windowPowerDbfs(
            this.samples.subarray(windowStart, windowStart + this.samplesPerSymbol));
        }
        this.candidateLevelDbfs = syncPower / this.syncTemplate.length;
        this.progress.push({ type: 'sync', position: this.frameBytePosition(this.candidateOffset, SYNC.length) });
        return true;
      }
      this.searchOffset += this.phaseStep;
    }
    return false;
  }

  /** Hard sync check: every symbol at the refined alignment must decode to its
   * expected tone, with at most SYNC_VERIFY_MAX_MISMATCHES exceptions. */
  private verifySyncSymbols(offset: number): boolean {
    let mismatches = 0;
    for (let index = 0; index < this.syncTemplate.length; index++) {
      const start = offset + index * this.samplesPerSymbol;
      const decision = detectFskSymbol(
        this.samples.subarray(start, start + this.samplesPerSymbol),
        this.config.sampleRate, this.config.frequencies);
      let winner = 0;
      for (let tone = 1; tone < decision.scores.length; tone++) {
        if (decision.scores[tone] > decision.scores[winner]) winner = tone;
      }
      if (winner !== this.syncTemplate[index] && ++mismatches > SYNC_VERIFY_MAX_MISMATCHES) return false;
    }
    return true;
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
    // The length has no error correction: a corrupted one is caught by the CRC at the end of the frame, an
    // impossible one by the size limit below, and a spuriously long one by carrier loss.
    const payloadLength = decodeFrameLength(header, LENGTH_OFFSET);
    const maxPayload = Math.min(MAX_LIVE_PAYLOAD_BYTES, Math.floor(
      (MAX_LIVE_FRAME_SECONDS * this.config.symbolRate * this.bitsPerSymbol) / 8
    ) - PAYLOAD_OFFSET - TRAILER_BYTES);
    if (payloadLength > Math.max(0, maxPayload)) {
      this.progress.push({ type: 'crc-error', position: this.frameBytePosition(start, HEADER_BYTES) });
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
    const frameBytes = PAYLOAD_OFFSET + payloadLength + TRAILER_BYTES;
    const frameSymbols = Math.ceil((frameBytes * 8) / this.bitsPerSymbol);
    const availableBytes = Math.floor(
      (Math.floor((this.sampleCount - start) / this.samplesPerSymbol) * this.bitsPerSymbol) / 8
    );
    if (!this.reportedAddress && availableBytes >= PAYLOAD_OFFSET) {
      this.reportedAddress = true;
      const address = readFrameAddress(this.decodeCandidateBytes(PAYLOAD_OFFSET).bytes, ADDRESS_OFFSET);
      this.progress.push({ type: 'address', sender: address.sender, seq: address.seq, frameType: address.type, ackRequested: address.ackRequested,
        position: this.frameBytePosition(start, PAYLOAD_OFFSET) });
    }
    const reportThrough = Math.min(payloadLength, Math.max(0, availableBytes - PAYLOAD_OFFSET));
    if (reportThrough > this.reportedPayloadBytes) {
      const partial = this.decodeCandidateBytes(PAYLOAD_OFFSET + reportThrough).bytes;
      for (let index = this.reportedPayloadBytes; index < reportThrough; index++) {
        this.progress.push({ type: 'byte', byte: partial[PAYLOAD_OFFSET + index],
          position: this.frameBytePosition(start, PAYLOAD_OFFSET + index + 1) });
      }
      this.reportedPayloadBytes = reportThrough;
    }
    // Noise can jitter the refined phase a few samples past the true frame start,
    // so a stream that ends exactly with the frame would otherwise never complete.
    // One phase step of slack truncates at most 1/8 of the final symbol's window.
    if (start + frameSymbols * this.samplesPerSymbol > this.sampleCount + this.phaseStep) {
      // A corrupted length field can promise a frame lasting up to a minute. If the
      // carrier collapses mid-frame — several consecutive symbol windows far below
      // the level this frame has been arriving at — abandon it instead of decoding
      // background noise. The level is tracked rather than fixed, so a transmitter
      // that merely fades (see CARRIER_LEVEL_TRACK) keeps its frame.
      const availableSymbols = Math.floor((this.sampleCount - start) / this.samplesPerSymbol);
      while (this.candidateScannedSymbols < availableSymbols) {
        const windowStart = start + this.candidateScannedSymbols * this.samplesPerSymbol;
        const power = windowPowerDbfs(
          this.samples.subarray(windowStart, windowStart + this.samplesPerSymbol));
        const lost = power < this.candidateLevelDbfs - CARRIER_LOSS_DROP_DB;
        this.candidateSilentRun = lost ? this.candidateSilentRun + 1 : 0;
        if (!lost) this.candidateLevelDbfs += (power - this.candidateLevelDbfs) * CARRIER_LEVEL_TRACK;
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
    let parsed = unframe(decoded.bytes);
    let symbols = this.candidateSymbols.slice(0, frameSymbols), scores = this.candidateScores.slice(0, frameSymbols);
    // A room echo carries an already-decoded symbol's tone into a later window; subtract it and decide again.
    const echo = parsed.payload ? undefined : this.cancelEcho(frameSymbols, frameBytes);
    if (echo) { parsed = echo.parsed; symbols = echo.symbols; scores = echo.scores; }
    // Still failing: the loss is usually one weak symbol, so let the CRC test its runner-up tone.
    const soft = parsed.payload ? undefined : this.softDecode(frameSymbols, frameBytes);
    if (soft) { parsed = soft.parsed; symbols = soft.symbols; scores = soft.scores; }
    // Remember the room's echo from any frame long enough to fit it, for short frames that can't.
    if (frameSymbols >= 120) {
      const fitted = estimateEchoTaps(this.candidateToneScores.slice(0, frameSymbols), symbols);
      if (fitted.some(tap => tap > 0.02)) this.roomEcho = fitted;
    }
    const framePosition = this.frameBytePosition(start, frameBytes);
    const address = readFrameAddress(soft?.bytes ?? echo?.bytes ?? decoded.bytes, ADDRESS_OFFSET);
    this.frames.push({ crcOk: !!parsed.payload, sender: address.sender, seq: address.seq, frameType: address.type, ackRequested: address.ackRequested, payloadLength,
      symbols, scores, echoCancelled: !!echo, echoTaps: echo?.taps, softCorrected: soft?.corrected,
      confidence: decoded.confidence, startPosition: this.streamPosition + start, endPosition: framePosition,
      timingOffset: this.timing.offset });
    if (!parsed.payload) {
      this.progress.push({ type: 'crc-error', position: framePosition });
      // The sync itself was validated, so resume the search beyond it rather than
      // re-matching the same sync at slightly shifted phases.
      this.rejectCandidate(Math.ceil((SYNC.length * 8) / this.bitsPerSymbol) * this.samplesPerSymbol);
      return null;
    }
    this.progress.push({ type: 'crc-confirm', position: framePosition });
    const startPosition = this.streamPosition + start;
    this.discard(Math.min(start + frameSymbols * this.samplesPerSymbol, this.sampleCount));
    this.searchOffset = 0; this.candidateOffset = undefined;
    this.reportedPayloadBytes = 0; this.reportedLength = false; this.reportedAddress = false;
    this.candidateSymbols = []; this.candidateConfidences = []; this.candidateScores = []; this.candidateToneScores = []; this.resetTiming();
    this.candidateScannedSymbols = 0; this.candidateSilentRun = 0;
    return { payload: parsed.payload, sender: parsed.sender!, seq: parsed.seq!, frameType: parsed.type!, ackRequested: parsed.ackRequested!,
      confidence: decoded.confidence, startPosition, endPosition: framePosition, echoCancelled: !!echo, softCorrected: soft?.corrected };
  }

  private rejectCandidate(skip = this.phaseStep): void {
    this.searchOffset = this.candidateOffset! + skip;
    this.candidateOffset = undefined;
    this.reportedPayloadBytes = 0;
    this.reportedLength = false; this.reportedAddress = false;
    this.candidateSymbols = []; this.candidateConfidences = []; this.candidateScores = []; this.candidateToneScores = []; this.resetTiming();
    this.candidateScannedSymbols = 0; this.candidateSilentRun = 0;
  }

  /**
   * Re-decides a failed frame with its own echoes removed: fits one gain per echo delay from the decisions just made,
   * subtracts each decided symbol's tone from later windows, and re-checks the CRC. Undefined when it still fails.
   */
  private cancelEcho(frameSymbols: number, frameBytes: number) {
    const scores = this.candidateToneScores.slice(0, frameSymbols);
    if (scores.length < frameSymbols) return;
    const fitted = estimateEchoTaps(scores, this.candidateSymbols.slice(0, frameSymbols));
    // A short frame has too few symbols per delay to fit reliable gains; the room's own, fitted on a longer frame, serves.
    for (const taps of [fitted, this.roomEcho]) {
      if (!taps.some(tap => tap > 0.02)) continue;
      const corrected = cancelEcho(scores, taps);
      const bytes = this.symbolsToBytes(corrected.symbols, frameBytes);
      bytes.set(SYNC, 0);
      const parsed = unframe(bytes);
      if (parsed.payload) return { parsed, bytes, taps, symbols: corrected.symbols, scores: corrected.scores };
    }
    return;
  }

  /**
   * Re-checks a failed frame with its least-confident symbols flipped to their runner-up tone, accepting the first
   * candidate whose CRC passes. Undefined when none does. Reports how many symbols the accepted guess changed.
   */
  private softDecode(frameSymbols: number, frameBytes: number) {
    const scores = this.candidateToneScores.slice(0, frameSymbols);
    if (scores.length < frameSymbols) return;
    const decided = this.candidateSymbols.slice(0, frameSymbols);
    for (const symbols of softCandidates(scores, decided)) {
      const bytes = this.symbolsToBytes(symbols, frameBytes);
      bytes.set(SYNC, 0);
      const parsed = unframe(bytes);
      if (!parsed.payload) continue;
      return { parsed, bytes, symbols,
        scores: symbols.map((tone, index) => scores[index][tone]),
        corrected: symbols.reduce((count, tone, index) => count + (tone === decided[index] ? 0 : 1), 0) };
    }
    return;
  }

  /** Packs decided symbols into the frame's first `count` bytes. */
  private symbolsToBytes(symbols: readonly number[], count: number): Uint8Array {
    const bits: number[] = [];
    for (const symbol of symbols) for (let bit = this.bitsPerSymbol - 1; bit >= 0; bit--) bits.push((symbol >>> bit) & 1);
    return bitsToBytes(bits).slice(0, count);
  }

  /** Decodes the candidate's first `count` bytes, reusing symbols decoded on earlier calls. */
  private decodeCandidateBytes(count: number): { bytes: Uint8Array; confidence: number } {
    const start = this.candidateOffset!;
    const symbolCount = Math.ceil((count * 8) / this.bitsPerSymbol);
    const buffered = this.samples.subarray(0, this.sampleCount);
    while (this.candidateSymbols.length < symbolCount) {
      const at = this.timing.at(this.candidateSymbols.length);
      const offset = Math.max(0, Math.round(start + at));
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
      this.candidateScores.push(decision.scores[symbol]);
      this.candidateToneScores.push(Float32Array.from(decision.scores));
      this.timing.observe(buffered, start, symbol, at);
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
