import { bitsToBytes, bytesToBits } from './bits';
import { ADDRESS_OFFSET, decodeFrameLength, FEC_HEADER_BYTES, FEC_SYNC_BYTES, LENGTH_BYTES, LENGTH_OFFSET, MAX_PAYLOAD_BYTES, PAYLOAD_OFFSET, readFrameAddress, SYNC_BYTES, unframe } from './frame';
import { codedSteps, convolutionalEncode, toneCosts, viterbiDecode } from './convolutional';
import { detectFskSymbol, toneScore, windowPowerDbfs } from './fsk-detector';
import { SymbolTimingLoop } from './symbol-timing';
import { cancelEcho, estimateEchoTaps } from './echo-canceller';
import { fskToneSamples } from './fsk';
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
/**
 * A reverberant room defeats the hard check without defeating the sync. Two feet from a phone lying on a desk, field
 * recordings show the matched filter firing at four times its threshold while 4–5 of 16 sync symbols decode as the
 * *previous* symbol's tone: the loud tones' reverberant tails out-shout the quiet tones' direct signal, one symbol
 * later. Refusing those frames left nothing in the log at all. So a sync whose soft statistic is this strong is
 * accepted with more misreads, and the CRC arbitrates as it does for every frame. Noise cannot reach this margin —
 * it averages near zero — so the false-sync rate the hard check exists to bound is untouched.
 */
const SYNC_STRONG_MARGIN = 0.35;
const SYNC_REVERB_MAX_MISMATCHES = 5;
/**
 * Fraction of a tone's power that must persist into the next symbol before decision feedback subtracts it. Fitted
 * on the sync, whose tones are known. Near a device the fitted tails are ~0.01 and this leaves decoding untouched;
 * in the reverberant case above they are 0.1–0.3 on the tones that arrive well, and the subtraction is what lets
 * the symbol after a loud one be read.
 */
const TAIL_MIN = 0.05;
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
/**
 * A window whose best tone still holds this share of its energy is carrying a tone, however quiet. Two feet from a
 * phone, one control tone arrived 20 dB below the others, and four of it in a row — the sync has exactly such a run —
 * read as four silent windows and abandoned the frame. Silence has no dominant tone; a weak tone does.
 */
const CARRIER_TONE_SCORE = 0.4;
/**
 * Largest fraction of a tone's power that can plausibly persist into the next symbol. Even a one-second reverberation
 * time leaves under 0.6 after a 40 ms symbol; a measured "tail" above this means the tone barely arrived and the
 * next window's energy at its frequency is something else. Subtracting on that basis zeroed a tone that was
 * genuinely sent twice in a row, and the wrong decision then steered the timing loop. Such a tone gets no tail.
 */
const MAX_TAIL = 0.5;
/**
 * Per-tone likelihood calibration. A tone's raw energy is not its likelihood: two feet from a phone one control tone
 * arrived 12–20 dB below the others, and in its own windows it lost to the small tails of louder tones — every error
 * in those frames was on that tone. Its level when sent is known from the sync, so each tone's power is judged
 * against that level. Only tones clearly below the strongest are boosted (the dead band keeps small, noisy estimates
 * from moving decisions on a clean frame, which they did), by at most this much, and the level estimate keeps
 * learning from the frame's own confident decisions, which soon outnumber the sync's two-to-seven samples per tone.
 */
const EQUALIZE_DEADBAND_DB = 3;
const EQUALIZE_MAX_DB = 20;
const LEVEL_TRACK = 0.1;
/** A decision this far ahead of the runner-up (in power) is trusted to refine its tone's level. */
const LEVEL_CONFIDENT_RATIO = 2;

/** Sync symbols whose bits are fully determined by the sync bytes (drops a mixed tail symbol). */
function syncSymbolTemplate(bitsPerSymbol: number, sync: readonly number[] = SYNC): number[] {
  const bits: number[] = [];
  for (const byte of sync) for (let bit = 7; bit >= 0; bit--) bits.push((byte >>> bit) & 1);
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
  /** Per-tone fraction of a symbol's power the room carried into the next symbol, measured on the sync; absent when negligible. */
  tails?: number[];
  /** Each tone's measured level when sent, in dB relative to the strongest (NaN if never measured); absent when nothing was measured. */
  levelsDb?: number[];
  /** The frame was convolutionally coded and decoded by soft-decision Viterbi; `symbols` are still the raw tone decisions. */
  fec?: boolean;
  /** Coded frames: symbols whose raw tone decision the decoded path overrode, of `fecSymbols` coded symbols — the channel's health. */
  fecCorrected?: number;
  fecSymbols?: number;
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
  /** Per-tone fraction of a symbol's power the room carried into the next symbol, measured on the sync; absent when negligible. */
  tails?: number[];
  /** Each tone's measured level when sent, in dB relative to the strongest (NaN if never measured); absent when nothing was measured. */
  levelsDb?: number[];
  /** The frame was convolutionally coded and decoded by soft-decision Viterbi; `symbols` are still the raw tone decisions. */
  fec?: boolean;
  /** Coded frames: symbols whose raw tone decision the decoded path overrode, of `fecSymbols` coded symbols — the channel's health. */
  fecCorrected?: number;
  fecSymbols?: number;
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
  /** A sync heard unmistakably but misread past what the CRC could rescue: the frame is there, and lost. */
  | { type: 'sync-unreadable'; mismatches: number; of: number; position: number }
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
  /** Samples of each period the tone occupies: every detection window is this long, stepped by samplesPerSymbol. */
  private readonly windowSamples: number;
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
  /** Per-tone fraction of one window's power that carries into the next, fitted on this frame's sync; empty when negligible. */
  private candidateTails: number[] = [];
  /** Raw absolute per-tone power of every decoded window, the reference the tail subtraction scales from. */
  private candidatePowers: Float64Array[] = [];
  /** Each tone's absolute power when sent, from the sync and then the frame's confident decisions; 0 = unmeasured. */
  private candidateLevels: number[] = [];
  /** Tracks symbol timing through the current candidate after sync acquisition. */
  private timing!: SymbolTimingLoop;
  /** Carrier-loss scan state for the current candidate. */
  private candidateScannedSymbols = 0;
  private candidateSilentRun = 0;
  /** Reference level for carrier loss: starts at the sync power and follows the frame's own level as it is read. */
  private candidateLevelDbfs = -Infinity;
  /** Per-tone score vectors by absolute offset, shared across overlapping sync-search trials. */
  private readonly syncScanCache = new Map<number, Float32Array>();
  /** Expected tone index per sync symbol for the matched-filter search: the template of the sync last accepted. */
  private syncTemplate: number[];
  /** Every sync the receiver listens for: the plain marker, and the coded one when a symbol carries two bits. */
  private readonly syncTemplates: { coded: boolean; symbols: number[] }[];
  /** The candidate frame's header and body are convolutionally coded. */
  private candidateCoded = false;
  /** The decoded header of the coded candidate, once its block has been read. */
  private codedHeader?: Uint8Array;

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
    this.windowSamples = fskToneSamples(config);
    this.phaseStep = Math.max(1, Math.floor(this.samplesPerSymbol / 8));
    this.syncTemplates = [{ coded: false, symbols: syncSymbolTemplate(this.bitsPerSymbol) }];
    // Coded frames put one trellis step in each symbol, which needs exactly two bits per symbol.
    if (this.bitsPerSymbol === 2) this.syncTemplates.push({ coded: true, symbols: syncSymbolTemplate(this.bitsPerSymbol, FEC_SYNC_BYTES) });
    this.syncTemplate = this.syncTemplates[0].symbols;
    this.resetTiming();
  }

  private resetTiming(): void {
    this.timing = new SymbolTimingLoop(this.samplesPerSymbol, this.config.sampleRate, this.config.frequencies, this.windowSamples);
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
    this.candidateSymbols = []; this.candidateConfidences = []; this.candidateScores = []; this.candidateToneScores = []; this.candidateTails = []; this.candidatePowers = []; this.candidateLevels = []; this.resetTiming();
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
      this.samples.subarray(offset, offset + this.windowSamples),
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
  private syncScoreAt(searchOffset: number, template = this.syncTemplate): number {
    const absolute = this.streamPosition + searchOffset;
    const count = template.length;
    if (this.config.frequencies.length === 2) {
      let sumDiff = 0, sumSigned = 0, signTotal = 0;
      for (let index = 0; index < count; index++) {
        const scores = this.scanScoresAt(absolute + index * this.samplesPerSymbol);
        const diff = scores[0] - scores[1];
        const sign = template[index] === 0 ? 1 : -1;
        sumDiff += diff; sumSigned += sign * diff; signTotal += sign;
      }
      return (sumSigned - (signTotal / count) * sumDiff) / count;
    }
    let sum = 0;
    for (let index = 0; index < count; index++) {
      const scores = this.scanScoresAt(absolute + index * this.samplesPerSymbol);
      const expected = template[index];
      let other = 0;
      for (let tone = 0; tone < scores.length; tone++) {
        if (tone !== expected) other = Math.max(other, scores[tone]);
      }
      sum += scores[expected] - other;
    }
    return sum / count;
  }

  /** Sum of expected-tone scores at a trial offset; sharp in alignment, cheap to evaluate. */
  private syncAlignmentScore(offset: number, template = this.syncTemplate): number {
    let sum = 0;
    for (let index = 0; index < template.length; index++) {
      const start = offset + index * this.samplesPerSymbol;
      sum += toneScore(
        this.samples.subarray(start, start + this.windowSamples),
        this.config.sampleRate,
        this.config.frequencies[template[index]]
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
      // the refined alignment is what actually establishes sync. Each sync marker is tried; the one that fits best
      // says whether the frame is coded.
      let best = this.syncTemplates[0], bestMargin = -Infinity;
      for (const candidate of this.syncTemplates) {
        const margin = this.syncScoreAt(this.searchOffset, candidate.symbols);
        if (margin > bestMargin) { bestMargin = margin; best = candidate; }
      }
      if (bestMargin >= SYNC_DETECT_MARGIN) {
        const template = best.symbols;
        const refined = this.refineSyncPhase(this.searchOffset, template);
        const mismatches = this.syncMismatches(refined, template);
        const margin = this.syncScoreAt(refined, template);
        const accepted = mismatches <= SYNC_VERIFY_MAX_MISMATCHES ||
          (margin >= SYNC_STRONG_MARGIN && mismatches <= SYNC_REVERB_MAX_MISMATCHES);
        if (!accepted) {
          if (margin >= SYNC_STRONG_MARGIN) {
            // Unmistakably a sync, and unreadable at the best alignment within a symbol: report it once and move on.
            this.progress.push({ type: 'sync-unreadable', mismatches, of: template.length,
              position: this.frameBytePosition(refined, SYNC.length) });
            this.searchOffset = refined + this.samplesPerSymbol;
          } else this.searchOffset += this.phaseStep;
          continue;
        }
        this.candidateOffset = refined;
        this.syncTemplate = template; this.candidateCoded = best.coded; this.codedHeader = undefined;
        this.reportedPayloadBytes = 0;
        this.reportedLength = false; this.reportedAddress = false;
        this.candidateSymbols = []; this.candidateConfidences = []; this.candidateScores = []; this.candidateToneScores = []; this.candidatePowers = []; this.candidateLevels = []; this.resetTiming();
        this.candidateScannedSymbols = 0; this.candidateSilentRun = 0;
        // Measured after the candidate state is cleared, so it survives into the frame's decoding.
        const measured = this.measureSync(refined);
        this.candidateTails = measured.tails; this.candidateLevels = measured.levels;
        // Reference power for carrier-loss detection: what this frame's sync measured.
        let syncPower = 0;
        for (let index = 0; index < this.syncTemplate.length; index++) {
          const windowStart = this.candidateOffset + index * this.samplesPerSymbol;
          syncPower += windowPowerDbfs(
            this.samples.subarray(windowStart, windowStart + this.windowSamples));
        }
        this.candidateLevelDbfs = syncPower / this.syncTemplate.length;
        this.progress.push({ type: 'sync', position: this.frameBytePosition(this.candidateOffset, SYNC.length) });
        return true;
      }
      this.searchOffset += this.phaseStep;
    }
    return false;
  }

  /** Hard sync check: how many symbols at the refined alignment decode to a tone other than the expected one. */
  private syncMismatches(offset: number, template = this.syncTemplate): number {
    let mismatches = 0;
    for (let index = 0; index < template.length; index++) {
      const start = offset + index * this.samplesPerSymbol;
      const decision = detectFskSymbol(
        this.samples.subarray(start, start + this.windowSamples),
        this.config.sampleRate, this.config.frequencies);
      let winner = 0;
      for (let tone = 1; tone < decision.scores.length; tone++) {
        if (decision.scores[tone] > decision.scores[winner]) winner = tone;
      }
      if (winner !== template[index]) mismatches++;
    }
    return mismatches;
  }

  /**
   * What the sync, whose tones are known, says about the channel: each tone's level when sent, and how much of it
   * carries into the window after it.
   *
   * Only a window actually heard as its template tone counts. A sync symbol the room or an impulse replaced with
   * another tone has no power at the tone it was supposed to carry; one such window once produced an astronomical
   * tail that made the decoder subtract every repeated tone to nothing. The tail's destination window is taken as
   * it is — being misread is often exactly the tail at work. A tone's tail is the median of its ratios, and a median
   * above MAX_TAIL is discarded: that tone is not tailing, it is barely arriving. Tails come back empty when every
   * one is negligible, so decoding near a device stays exactly as it was; levels are 0 for a tone never heard as sent.
   */
  private measureSync(offset: number): { tails: number[]; levels: number[] } {
    const tones = this.config.frequencies.length;
    const powers: Float64Array[] = [], heard: number[] = [];
    for (let index = 0; index < this.syncTemplate.length; index++) {
      const start = offset + index * this.samplesPerSymbol;
      const decision = detectFskSymbol(this.samples.subarray(start, start + this.windowSamples),
        this.config.sampleRate, this.config.frequencies);
      const rmsSquared = Math.pow(10, decision.powerDbfs / 10);
      powers.push(Float64Array.from(decision.scores, score => score * rmsSquared));
      let winner = 0;
      for (let tone = 1; tone < decision.scores.length; tone++) if (decision.scores[tone] > decision.scores[winner]) winner = tone;
      heard.push(winner);
    }
    const levelSum = new Array<number>(tones).fill(0), levelCount = new Array<number>(tones).fill(0);
    for (let index = 0; index < this.syncTemplate.length; index++) {
      const tone = this.syncTemplate[index];
      if (heard[index] === tone) { levelSum[tone] += powers[index][tone]; levelCount[tone]++; }
    }
    const levels = levelSum.map((sum, tone) => levelCount[tone] ? sum / levelCount[tone] : 0);
    const ratios: number[][] = Array.from({ length: tones }, () => []);
    for (let index = 1; index < this.syncTemplate.length; index++) {
      const previous = this.syncTemplate[index - 1];
      if (previous === this.syncTemplate[index] || heard[index - 1] !== previous || powers[index - 1][previous] <= 0) continue;
      ratios[previous].push(Math.min(1, powers[index][previous] / powers[index - 1][previous]));
    }
    const tails = ratios.map(values => {
      if (!values.length) return 0;
      const sorted = values.slice().sort((a, b) => a - b), middle = sorted.length >> 1;
      const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
      return median <= MAX_TAIL ? median : 0;
    });
    return { tails: tails.some(tail => tail >= TAIL_MIN) ? tails : [], levels };
  }

  /** Gain per tone that judges its power against its own level when sent: 1 unless the tone is clearly weak. */
  private equalizerGains(): number[] | undefined {
    const measured = this.candidateLevels.filter(level => level > 0);
    if (!measured.length) return;
    const strongest = Math.max(...measured), deadband = Math.pow(10, EQUALIZE_DEADBAND_DB / 10), cap = Math.pow(10, EQUALIZE_MAX_DB / 10);
    const gains = this.candidateLevels.map(level => level > 0 && level * deadband < strongest ? Math.min(cap, strongest / level) : 1);
    return gains.some(gain => gain !== 1) ? gains : undefined;
  }

  /** The measured tone levels in dB relative to the strongest, for reports; undefined when nothing was measured. */
  private levelsDb(): number[] | undefined {
    const measured = this.candidateLevels.filter(level => level > 0);
    if (!measured.length) return;
    const strongest = Math.max(...measured);
    return this.candidateLevels.map(level => level > 0 ? 10 * Math.log10(level / strongest) : NaN);
  }

  /** Locks sync timing to the sample by maximizing the matched-filter alignment score. */
  private refineSyncPhase(start: number, template = this.syncTemplate): number {
    const span = template.length * this.samplesPerSymbol;
    const trial = (offset: number, best: { offset: number; score: number }) => {
      if (offset < 0 || offset === best.offset || offset + span > this.sampleCount) return;
      const score = this.syncAlignmentScore(offset, template);
      if (score > best.score) { best.offset = offset; best.score = score; }
    };
    const best = { offset: start, score: this.syncAlignmentScore(start, template) };
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
  /**
   * Watches an incomplete frame for a collapsed carrier — several consecutive symbol windows far below the level
   * this frame has been arriving at, with no tone dominant — and abandons it, returning true, rather than decoding
   * background noise for up to a minute on the strength of a corrupted length. The level is tracked, so a fading
   * transmitter keeps its frame (CARRIER_LEVEL_TRACK), and a quiet tone is not silence (CARRIER_TONE_SCORE).
   */
  private carrierLost(start: number): boolean {
    const availableSymbols = Math.floor((this.sampleCount - start) / this.samplesPerSymbol);
    while (this.candidateScannedSymbols < availableSymbols) {
      const windowStart = start + this.candidateScannedSymbols * this.samplesPerSymbol;
      const window = this.samples.subarray(windowStart, windowStart + this.windowSamples);
      const power = windowPowerDbfs(window);
      const lost = power < this.candidateLevelDbfs - CARRIER_LOSS_DROP_DB &&
        Math.max(...detectFskSymbol(window, this.config.sampleRate, this.config.frequencies).scores) < CARRIER_TONE_SCORE;
      this.candidateSilentRun = lost ? this.candidateSilentRun + 1 : 0;
      if (!lost) this.candidateLevelDbfs += (power - this.candidateLevelDbfs) * CARRIER_LEVEL_TRACK;
      this.candidateScannedSymbols++;
      if (this.candidateSilentRun >= CARRIER_LOSS_ABORT_SYMBOLS) {
        this.progress.push({ type: 'crc-error', position: this.streamPosition + windowStart + this.samplesPerSymbol });
        this.rejectCandidate(this.syncTemplate.length * this.samplesPerSymbol);
        return true;
      }
    }
    return false;
  }

  /** Absolute stream sample index `symbols` symbol periods after the candidate start. */
  private symbolPosition(start: number, symbols: number): number {
    return this.streamPosition + start + symbols * this.samplesPerSymbol;
  }

  /**
   * Viterbi-decodes the candidate's symbols [from, to) as one terminated block of `bytes` bytes. Re-encoding the
   * result gives the tone each symbol should have carried, and the number of raw tone decisions the path overrode
   * is how hard the code had to work — the frame's channel-health figure.
   */
  private decodeCodedBlock(from: number, to: number, bytes: number): { bytes: Uint8Array; cost: number; corrected: number } {
    const costs = this.candidateToneScores.slice(from, to).map(scores => toneCosts(scores));
    const decoded = viterbiDecode(costs, bytes * 8);
    const coded = convolutionalEncode(decoded.bits);
    let corrected = 0;
    for (let step = 0; from + step < to; step++) {
      if (this.candidateSymbols[from + step] !== ((coded[2 * step] << 1) | coded[2 * step + 1])) corrected++;
    }
    return { bytes: bitsToBytes(decoded.bits).slice(0, bytes), cost: decoded.cost, corrected };
  }

  /**
   * A coded frame: the sync, then a terminated block carrying length and address, then one carrying payload and
   * CRC. The header decodes as soon as its block is in, so the frame is sized from a corrected length; the body
   * is decoded whole, by soft-decision Viterbi over the tone shares, and the CRC still has the last word.
   */
  private readCodedCandidate(): FskStreamPacket | null | undefined {
    const start = this.candidateOffset!, syncSymbols = this.syncTemplate.length;
    const headerEnd = syncSymbols + codedSteps(FEC_HEADER_BYTES * 8);
    if (start + headerEnd * this.samplesPerSymbol > this.sampleCount) return this.carrierLost(start) ? null : undefined;
    this.decodeCandidateSymbols(headerEnd);
    const headerBlock = this.decodeCodedBlock(syncSymbols, headerEnd, FEC_HEADER_BYTES);
    this.codedHeader ??= headerBlock.bytes;
    const header = this.codedHeader, payloadLength = decodeFrameLength(header, 0);
    const maxPayload = Math.min(MAX_LIVE_PAYLOAD_BYTES, Math.floor((MAX_LIVE_FRAME_SECONDS * this.config.symbolRate - headerEnd - 8) / 8) - TRAILER_BYTES);
    if (payloadLength > Math.max(0, maxPayload)) {
      this.progress.push({ type: 'crc-error', position: this.symbolPosition(start, headerEnd) });
      this.rejectCandidate(syncSymbols * this.samplesPerSymbol);
      return null;
    }
    if (!this.reportedLength) {
      this.reportedLength = true; this.reportedAddress = true;
      const address = readFrameAddress(header, LENGTH_BYTES);
      this.progress.push({ type: 'length', length: payloadLength, position: this.symbolPosition(start, headerEnd) });
      this.progress.push({ type: 'address', sender: address.sender, seq: address.seq, frameType: address.type, ackRequested: address.ackRequested,
        position: this.symbolPosition(start, headerEnd) });
    }
    const frameSymbols = headerEnd + codedSteps((payloadLength + TRAILER_BYTES) * 8);
    if (start + frameSymbols * this.samplesPerSymbol > this.sampleCount + this.phaseStep) return this.carrierLost(start) ? null : undefined;
    this.decodeCandidateSymbols(frameSymbols);
    const body = this.decodeCodedBlock(headerEnd, frameSymbols, payloadLength + TRAILER_BYTES);
    const bytes = new Uint8Array(SYNC.length + header.length + body.bytes.length);
    bytes.set(SYNC, 0); bytes.set(header, SYNC.length); bytes.set(body.bytes, SYNC.length + header.length);
    for (let index = 0; index < payloadLength; index++) {
      this.progress.push({ type: 'byte', byte: body.bytes[index], position: this.symbolPosition(start, headerEnd + codedSteps((index + 1) * 8)) });
    }
    const tails = this.candidateTails.length ? this.candidateTails : undefined, levelsDb = this.levelsDb();
    const parsed = unframe(bytes), framePosition = this.symbolPosition(start, frameSymbols);
    const address = readFrameAddress(bytes, ADDRESS_OFFSET);
    let confidence = 0;
    for (let index = 0; index < frameSymbols; index++) confidence += this.candidateConfidences[index];
    confidence /= Math.max(1, frameSymbols);
    const fecCorrected = headerBlock.corrected + body.corrected, fecSymbols = frameSymbols - syncSymbols;
    this.frames.push({ crcOk: !!parsed.payload, sender: address.sender, seq: address.seq, frameType: address.type, ackRequested: address.ackRequested, payloadLength,
      symbols: this.candidateSymbols.slice(0, frameSymbols), scores: this.candidateScores.slice(0, frameSymbols), tails, levelsDb, fec: true, fecCorrected, fecSymbols,
      confidence, startPosition: this.streamPosition + start, endPosition: framePosition, timingOffset: this.timing.offset });
    if (!parsed.payload) {
      this.progress.push({ type: 'crc-error', position: framePosition });
      this.rejectCandidate(syncSymbols * this.samplesPerSymbol);
      return null;
    }
    this.progress.push({ type: 'crc-confirm', position: framePosition });
    const startPosition = this.streamPosition + start;
    this.discard(Math.min(start + frameSymbols * this.samplesPerSymbol, this.sampleCount));
    this.searchOffset = 0; this.candidateOffset = undefined; this.codedHeader = undefined;
    this.reportedPayloadBytes = 0; this.reportedLength = false; this.reportedAddress = false;
    this.candidateSymbols = []; this.candidateConfidences = []; this.candidateScores = []; this.candidateToneScores = []; this.candidateTails = []; this.candidatePowers = []; this.candidateLevels = []; this.resetTiming();
    this.candidateScannedSymbols = 0; this.candidateSilentRun = 0;
    return { payload: parsed.payload, sender: parsed.sender!, seq: parsed.seq!, frameType: parsed.type!, ackRequested: parsed.ackRequested!,
      confidence, startPosition, endPosition: framePosition, tails, levelsDb, fec: true, fecCorrected, fecSymbols };
  }

  private readCandidate(): FskStreamPacket | null | undefined {
    if (this.candidateCoded) return this.readCodedCandidate();
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
      return this.carrierLost(start) ? null : undefined;
    }

    const decoded = this.decodeCandidateBytes(frameBytes);
    decoded.bytes.set(SYNC, 0);
    // Read now: the candidate state, tails and levels included, is cleared before a valid packet is returned.
    const tails = this.candidateTails.length ? this.candidateTails : undefined, levelsDb = this.levelsDb();
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
      symbols, scores, echoCancelled: !!echo, echoTaps: echo?.taps, softCorrected: soft?.corrected, tails, levelsDb,
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
    this.candidateSymbols = []; this.candidateConfidences = []; this.candidateScores = []; this.candidateToneScores = []; this.candidateTails = []; this.candidatePowers = []; this.candidateLevels = []; this.resetTiming();
    this.candidateScannedSymbols = 0; this.candidateSilentRun = 0;
    return { payload: parsed.payload, sender: parsed.sender!, seq: parsed.seq!, frameType: parsed.type!, ackRequested: parsed.ackRequested!,
      confidence: decoded.confidence, startPosition, endPosition: framePosition, echoCancelled: !!echo, softCorrected: soft?.corrected, tails, levelsDb };
  }

  private rejectCandidate(skip = this.phaseStep): void {
    this.searchOffset = this.candidateOffset! + skip;
    this.candidateOffset = undefined; this.codedHeader = undefined;
    this.reportedPayloadBytes = 0;
    this.reportedLength = false; this.reportedAddress = false;
    this.candidateSymbols = []; this.candidateConfidences = []; this.candidateScores = []; this.candidateToneScores = []; this.candidateTails = []; this.candidatePowers = []; this.candidateLevels = []; this.resetTiming();
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
    const symbolCount = Math.ceil((count * 8) / this.bitsPerSymbol);
    this.decodeCandidateSymbols(symbolCount);
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

  /** Decides the candidate's symbols up to `symbolCount`, reusing those decided on earlier calls. */
  private decodeCandidateSymbols(symbolCount: number): void {
    const start = this.candidateOffset!;
    const buffered = this.samples.subarray(0, this.sampleCount);
    while (this.candidateSymbols.length < symbolCount) {
      const at = this.timing.at(this.candidateSymbols.length);
      const offset = Math.max(0, Math.round(start + at));
      const decision = detectFskSymbol(
        // The final window may fall short of the buffer by the tail slack.
        this.samples.subarray(offset, Math.min(offset + this.windowSamples, this.sampleCount)),
        this.config.sampleRate,
        this.config.frequencies
      );
      // Decision feedback in absolute power: the previous decision's tone carried a known fraction of its power into
      // this window, so take that back before deciding. Absolute rather than the detector's normalized share,
      // because the share of a window whose energy is mostly reverberation says little about the tone underneath.
      const index = this.candidateSymbols.length;
      const rmsSquared = Math.pow(10, decision.powerDbfs / 10);
      const raw = Float64Array.from(decision.scores, score => score * rmsSquared);
      const power = Float64Array.from(raw);
      if (index > 0 && this.candidateTails.length) {
        const previous = this.candidateSymbols[index - 1];
        power[previous] = Math.max(0, power[previous] - this.candidateTails[previous] * this.candidatePowers[index - 1][previous]);
      }
      // Judge each tone against its own level when sent: the likelihood of a tone that arrives weakly is not its raw
      // energy. Without a measured imbalance the powers pass through unchanged.
      const gains = this.equalizerGains();
      const judged = gains ? Float64Array.from(power, (value, tone) => value * gains[tone]) : power;
      let symbol = 0, runnerUp = 0;
      for (let tone = 1; tone < judged.length; tone++) {
        if (judged[tone] > judged[symbol]) { runnerUp = symbol; symbol = tone; }
        else if (judged[tone] > judged[runnerUp] || runnerUp === symbol) runnerUp = tone;
      }
      // Shares of the window, on the detector's scale, so margins and S/N read as before; a boosted window is
      // renormalised so its shares still sum to at most one.
      let judgedTotal = 0; for (let tone = 0; tone < judged.length; tone++) judgedTotal += judged[tone];
      const scale = Math.max(rmsSquared, judgedTotal);
      const scores = scale > 0 ? Float32Array.from(judged, value => value / scale) : Float32Array.from(decision.scores);
      // A confident decision refines its tone's level, so the sync's few samples stop being the whole estimate.
      if (this.candidateLevels.length && judged.length > 1 && judged[symbol] >= LEVEL_CONFIDENT_RATIO * judged[runnerUp]) {
        const level = this.candidateLevels[symbol];
        this.candidateLevels[symbol] = level > 0 ? level + LEVEL_TRACK * (raw[symbol] - level) : raw[symbol];
      }
      this.candidateSymbols.push(symbol);
      this.candidateConfidences.push(Math.max(0, scores[symbol] - (power.length > 1 ? scores[runnerUp] : 0)));
      this.candidateScores.push(scores[symbol]);
      this.candidateToneScores.push(scores);
      this.candidatePowers.push(raw);
      this.timing.observe(buffered, start, symbol, at);
    }
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
