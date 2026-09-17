import { FRAME_OVERHEAD_BYTES, FRAME_TYPE, frameId, PAYLOAD_OFFSET, senderHex, type FrameAddress } from './dsp/frame';
import { fskToneSet } from './dsp/fsk-frequencies';
import { fskFrameSymbols, MAX_GAP_PERCENT } from './dsp/fsk';
/** Cooperative experiments use an acoustic control link; no shared schedule is required. */
export interface TrialSettings {
  tones: number; lowestFrequency: number; symbolRate: number;
  payloadBytes: number; seed: number;
  /**
   * Test-packet output level, as a percentage of full scale. A percentage rather than a fraction so that it sweeps
   * like every other parameter — whole numbers with a whole-number step — and reads unambiguously on the wire.
   */
  amplitudePercent: number;
  /**
   * Silence at the end of each symbol period, as a percentage of it. The room decays in the gap before the next
   * symbol is judged; the receiver's window covers only the tone, so the tone plan is spaced by the window rate.
   */
  gapPercent: number;
}
/**
 * Every parameter a run can sweep, each with the range that suits it — a frequency sweep in hundreds of hertz means
 * nothing as a percentage, and vice versa, so selecting a parameter resets the range to its own.
 *
 * The type is derived from this list rather than written alongside it. When the two were separate, amplitude was
 * added to the type but not to validateSearch's runtime check, and every amplitude run was rejected as an invalid
 * range — a mistake the compiler could not see, because the check was an array of plain strings.
 */
export const SEARCH_PARAMETERS = [
  { key: 'lowestFrequency', label: 'Base frequency', minimum: 1000, maximum: 3000, step: 500 },
  // The range is unused for tones, which always tests all four counts, but must stay valid.
  { key: 'tones', label: 'Number of tones', minimum: 2, maximum: 16, step: 1 },
  { key: 'symbolRate', label: 'Test baud', minimum: 25, maximum: 200, step: 25 },
  { key: 'amplitudePercent', label: 'Amplitude %', minimum: 20, maximum: 100, step: 20 },
  { key: 'gapPercent', label: 'Silence gap %', minimum: 0, maximum: 60, step: 20 }
] as const;
export type SearchParameter = typeof SEARCH_PARAMETERS[number]['key'];
export const searchParameterPlan = (parameter: SearchParameter) =>
  SEARCH_PARAMETERS.find(p => p.key === parameter) ?? SEARCH_PARAMETERS[0];
export interface SearchSettings {
  trial: TrialSettings; parameter: SearchParameter; minimum: number; maximum: number; step: number;
  /** How many times each value of the parameter is tested. */
  repetitions: number;
}
/**
 * Output level for every transmission, control and test alike.
 *
 * Lowered from 0.8 after field recordings showed a phone fading its own output 8.8 dB across a single frame while a
 * laptop on the same run faded 2.1 dB: that is a speaker-protection limiter reacting to a sustained loud tone, and it
 * is triggered by level, not by content. The fade is worse than the level it buys, because a frame that starts loud
 * and ends quiet spends its last symbols near the decision boundary. Nothing was clipping at 0.8 — the recordings
 * show no flat-topped samples — so this is about the limiter, not headroom. There is margin to spend: the same
 * recordings measured a median in-window S/N of 14.6 dB, and halving amplitude costs 6 dB of it.
 */
export const TRANSMIT_AMPLITUDE = 0.4;
/** Below this a test packet is too quiet to tell a weak channel from a weak transmitter. */
export const MIN_AMPLITUDE_PERCENT = 5;
/** Test packets start at the control link's level, so an unswept run measures the channel both links share. */
export const DEFAULT_AMPLITUDE_PERCENT = Math.round(TRANSMIT_AMPLITUDE * 100);

/**
 * The control link runs slow and high. 25 baud makes a symbol (40 ms) longer than a small room's first reflections
 * (a 10-foot surface echoes at ~18 ms), which is what corrupted 100-baud control messages at two feet in field
 * recordings.
 *
 * The band starts at 2800 Hz because of what a phone speaker actually delivers at a distance. Two feet from a phone
 * lying on a desk, a recording measured 2900 Hz arriving 14 dB louder than 1500 Hz; the 2900 Hz symbols decoded 48
 * of 48 and the 1700 Hz symbols 10 of 43, with the loud tones' reverberant tails winning the quiet tones' windows.
 * Held near the laptop the tilt reversed and everything decoded, which is the cliff between "works on the desk" and
 * "nothing at two feet". No receiver-side correction recovers a tone that isn't arriving, so every control tone now
 * sits at or above the frequency that was arriving well. The plan stays inside an octave (no tone is another's
 * harmonic) and its top, 5425 Hz, is well within what phones and laptop microphones reproduce.
 */
export const CONTROL_FSK = { frequencies: fskToneSet(2800, 25, 4), symbolRate: 25, amplitude: TRANSMIT_AMPLITUDE };
/** Quiet lead-in and tail wrapped around every transmission, so a frame never starts in a speaker's turn-on click. */
export const GUARD_SECONDS = 0.5;
/**
 * Seconds of air a control frame with this payload occupies, guards included.
 *
 * The control link is deliberately slow, which makes air time the dominant timing constant in the protocol: at 25
 * baud and 2 bits per symbol a 4-byte ACK already takes 3.7 s and a result(…) line takes about 9 s. Every timeout
 * that waits on a reply has to be derived from this rather than guessed, or the protocol retransmits into replies
 * that are still being played.
 */
export function controlAirtimeSeconds(payloadBytes: number): number {
  // Control frames are convolutionally coded (rate ½), which roughly doubles their symbols.
  return fskFrameSymbols(payloadBytes, Math.log2(CONTROL_FSK.frequencies.length), true) / CONTROL_FSK.symbolRate + 2 * GUARD_SECONDS;
}
export const MAX_SESSION_SECONDS = 600;
export const MAX_TESTS = 200;
export const MAX_REPETITIONS = 50;
/** The rate the receiver's window sees: with a silence gap the tone is shorter than the period, and orthogonal tone spacing follows the tone. */
export const windowRate = (t: TrialSettings) => t.symbolRate / (1 - t.gapPercent / 100);
/**
 * A trial's tones: unequal gaps computed from its base frequency and the window rate, so no tone is another's
 * harmonic. The level and silence gap are the trial's own, so a run can sweep them; only test packets vary, never
 * the control link.
 */
export const trialFsk = (t: TrialSettings) => ({ frequencies: fskToneSet(t.lowestFrequency, windowRate(t), t.tones), symbolRate: t.symbolRate,
  amplitude: t.amplitudePercent / 100, gapPercent: t.gapPercent });
export function validateTrial(value: unknown): TrialSettings {
  const t = value as TrialSettings;
  if (!t || ![2,4,8,16].includes(t.tones) || !Number.isInteger(t.lowestFrequency) || t.lowestFrequency < 100 ||
      !Number.isInteger(t.gapPercent) || t.gapPercent < 0 || t.gapPercent > MAX_GAP_PERCENT ||
      fskToneSet(t.lowestFrequency, windowRate(t), t.tones).slice(-1)[0] > 20000 ||
      !Number.isInteger(t.symbolRate) || t.symbolRate < 25 || t.symbolRate > 1000 ||
      !Number.isInteger(t.payloadBytes) || t.payloadBytes < 4 || t.payloadBytes > 64 ||
      !Number.isInteger(t.seed) || t.seed < 0 || t.seed > 0xffffffff ||
      !Number.isInteger(t.amplitudePercent) || t.amplitudePercent < MIN_AMPLITUDE_PERCENT || t.amplitudePercent > 100 ||
      (t.payloadBytes + FRAME_OVERHEAD_BYTES) * 8 / Math.log2(t.tones) / t.symbolRate > 15) throw new Error('Invalid trial settings (packet duration at most 15 seconds)');
  const { tones, lowestFrequency, symbolRate, payloadBytes, seed, amplitudePercent, gapPercent } = t;
  return { tones, lowestFrequency, symbolRate, payloadBytes, seed, amplitudePercent, gapPercent };
}
export function defaultSearch(): SearchSettings {
  const { key, minimum, maximum, step } = searchParameterPlan('lowestFrequency');
  return { trial: { tones: 4, lowestFrequency: 1500, symbolRate: 25, payloadBytes: 16, seed: 719, amplitudePercent: DEFAULT_AMPLITUDE_PERCENT, gapPercent: 0 },
    parameter: key, minimum, maximum, step, repetitions: 1 };
}
/** One trial's settings with the swept parameter set to `value`; tones follow the base frequency and baud. */
export const withValue = (t: TrialSettings, parameter: SearchParameter, value: number): TrialSettings => ({ ...t, [parameter]: value });
/** Every value the run tests: all four tone counts, or minimum..maximum in steps. */
export function searchValues(s: SearchSettings): number[] {
  if (s.parameter === 'tones') return [2, 4, 8, 16];
  const values: number[] = [];
  for (let value = s.minimum; value <= s.maximum; value += s.step) values.push(value);
  return values;
}
/** Total test packets a run sends: every value, once per repetition. */
export const totalTests = (s: SearchSettings) => searchValues(s).length * s.repetitions;
export function validateSearch(value: SearchSettings): SearchSettings {
  const s = { ...value, trial: validateTrial(value.trial) };
  if (!SEARCH_PARAMETERS.some(p => p.key === s.parameter) || !Number.isInteger(s.repetitions) || s.repetitions < 1 || s.repetitions > MAX_REPETITIONS ||
      !Number.isInteger(s.minimum) || !Number.isInteger(s.maximum) || s.minimum >= s.maximum ||
      !Number.isInteger(s.step) || s.step < 1) throw new Error(`Invalid search range or repetitions (1–${MAX_REPETITIONS})`);
  const values = searchValues(s);
  if (!values.length || values.length * s.repetitions > MAX_TESTS) throw new Error(`A run may send at most ${MAX_TESTS} test packets`);
  for (const v of values) validateTrial(withValue(s.trial, s.parameter, v));
  return s;
}
export function trialPayload(t: TrialSettings): Uint8Array {
  let state = t.seed || 1;
  return Uint8Array.from({ length: t.payloadBytes }, () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state & 255; });
}
export interface Proposal { sender: number; trial: number; settings: TrialSettings }
export interface RawResult {
  symbolErrors: number; symbols: number; bitErrors: number; bits: number; confidence: number;
  /** Median over payload symbols of the in-window S/N: winning tone energy vs. the rest of the window, in dB. */
  snrMedianDb: number;
  /** The receiver decoded the frame and its CRC passed; otherwise it was heard but corrupted. */
  crcOk: boolean;
}
export interface TrialMeasurement extends Proposal {
  /** Payload bytes as hard-decided from the received symbols, errors included. */
  received: number[];
  /** In-window S/N per payload symbol, in dB. */
  snrDb: number[];
  /**
   * Mean in-window S/N of the payload symbols sent on each tone, in dB, in tone order; NaN for a tone the payload
   * never used. A tone the room or speaker delivers 20 dB below the others hides inside a healthy median — this is
   * where it shows.
   */
  snrByToneDb: number[];
  raw: RawResult; sampleRate: number;
  /** The test packet frame's sequence number. */
  seq: number;
  /** Absolute sample position where the receiver locked the frame's sync. */
  startPosition: number;
  /** How far symbol tracking moved the sampling windows by the end of the frame. */
  timingDriftMs: number;
  confusion: number[][];
}
export type ControlMessage =
  | ({ kind: 'test_suite' } & Proposal)
  | { kind: 'done' | 'lost'; sender: number; trial: number }
  | { kind: 'result'; sender: number; trial: number; raw: RawResult };
export type ControlKind = ControlMessage['kind'];

/** In-window S/N from a detector score (the winning tone's share of window energy), clamped to a displayable range. */
export function snrDbFromScore(score: number): number {
  const s = Math.min(Math.max(score, 1e-4), 1 - 1e-4);
  return Math.max(-40, Math.min(40, 10 * Math.log10(s / (1 - s))));
}
export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/*
 * Control messages are plain ASCII method calls in a frame of type control, e.g.
 *   test_suite(1, 1500, 4, 25, 16, 719, 40, 0)
 * Who sent it travels in the frame's sender field, not the text. Trial numbers on the wire are 1-based. Each
 * method is parsed on its own, so one can change without versioning the rest. Test packets stay binary.
 */
const MAX_CONTROL_BYTES = 120;
const decimal = (v: number, digits: number) => String(Number(v.toFixed(digits)));
const INT = /^\d+$/, SIGNED = /^-?\d+(\.\d+)?$/;
function args(m: ControlMessage): (string | number)[] {
  switch (m.kind) {
    case 'test_suite': {
      const t = validateTrial(m.settings);
      return [m.trial + 1, t.lowestFrequency, t.tones, t.symbolRate, t.payloadBytes, t.seed, t.amplitudePercent, t.gapPercent];
    }
    case 'result': return [m.trial + 1, m.raw.symbolErrors, m.raw.symbols, m.raw.bitErrors, m.raw.bits, decimal(m.raw.confidence, 2), decimal(m.raw.snrMedianDb, 1), m.raw.crcOk ? 1 : 0];
    case 'done': return [m.trial];
    default: return [m.trial + 1];
  }
}
export const controlText = (m: ControlMessage) => `${m.kind}(${args(m).join(', ')})`;
export const encodeControl = (m: ControlMessage): Uint8Array => new TextEncoder().encode(controlText(m));
export const controlAddress = (m: ControlMessage, seq = 0, ackRequested = false): FrameAddress => ({ sender: m.sender, seq, type: FRAME_TYPE.control, ackRequested });
const ARG_COUNTS: Record<ControlKind, number> = { test_suite: 8, result: 8, done: 1, lost: 1 };
/** Parses a control payload; `sender` comes from the frame it arrived in. */
export function decodeControl(bytes: Uint8Array, sender: number): ControlMessage | undefined {
  if (bytes.length > MAX_CONTROL_BYTES || bytes.some(b => b < 0x20 || b > 0x7e)) return;
  const match = /^([a-z_]+)\(([^()]*)\)$/.exec(String.fromCharCode(...bytes));
  if (!match || !(match[1] in ARG_COUNTS)) return;
  const kind = match[1] as ControlKind, fields = match[2].split(',').map(f => f.trim());
  if (fields.length !== ARG_COUNTS[kind] || !INT.test(fields[0]) || fields.slice(1).some(f => !SIGNED.test(f))) return;
  const count = Number(fields[0]), numbers = fields.slice(1).map(Number);
  if (kind === 'done') return { kind, sender, trial: count };
  const common = { sender, trial: count - 1 };
  if (common.trial < 0) return;
  try {
    switch (kind) {
      case 'test_suite': {
        const [lowestFrequency, tones, symbolRate, payloadBytes, seed, amplitudePercent, gapPercent] = numbers;
        return { kind, ...common, settings: validateTrial({ lowestFrequency, tones, symbolRate, payloadBytes, seed, amplitudePercent, gapPercent }) };
      }
      case 'result': {
        const [symbolErrors, symbols, bitErrors, bits, confidence, snrMedianDb, crc] = numbers;
        if (!symbols || !bits || symbolErrors > symbols || bitErrors > bits || confidence > 1 || (crc !== 0 && crc !== 1)) return;
        return { kind, ...common, raw: { symbolErrors, symbols, bitErrors, bits, confidence, snrMedianDb, crcOk: crc === 1 } };
      }
      default: return { kind, ...common };
    }
  } catch { return; }
}
/** Test packet symbols lying wholly inside the payload, i.e. the ones a trial scores. */
export function testSymbolCount(t: TrialSettings): number {
  const bps = Math.log2(t.tones), header = PAYLOAD_OFFSET * 8;
  return Math.floor((header + t.payloadBytes * 8) / bps) - Math.ceil(header / bps);
}
export interface SearchObservation extends Proposal { raw: RawResult }
/**
 * Balanced coverage rather than adaptive search: every value of the parameter is tested the same number of times,
 * one shuffled pass per repetition, so no value gets more evidence than another. Order is randomized within each
 * pass so drift in the room (someone moves, a fan starts) doesn't fall on the same values every run. A trial the
 * partner never received is simply re-sent, keeping the coverage exact. Best means best measured, not a global optimum.
 */
export class ParameterSearch {
  readonly observations: SearchObservation[]=[];
  private schedule:number[]=[];
  constructor(readonly config:SearchSettings,private random:()=>number=Math.random) { validateSearch(config); }
  private shuffled():number[] {
    const values=searchValues(this.config);
    for(let i=values.length-1;i>0;i--){const j=Math.floor(this.random()*(i+1));[values[i],values[j]]=[values[j],values[i]];}
    return values;
  }
  best(): { value:number; errors:number; symbols:number } | undefined {
    const sums=new Map<number,{value:number;errors:number;symbols:number}>();
    for(const r of this.observations){const value=r.settings[this.config.parameter], s=sums.get(value)??{value,errors:0,symbols:0};s.errors+=r.raw.symbolErrors;s.symbols+=r.raw.symbols;sums.set(value,s);}
    return [...sums.values()].sort((a,b)=>a.errors/a.symbols-b.errors/b.symbols)[0];
  }
  add(r:SearchObservation):boolean {
    if(this.observations.some(p=>p.sender===r.sender&&p.trial===r.trial))return false;
    this.observations.push(r);return true;
  }
  next():TrialSettings|undefined {
    const n=this.observations.length,c=this.config;
    if(n>=totalTests(c))return;
    while(this.schedule.length<=n)this.schedule.push(...this.shuffled());
    return validateTrial(withValue(c.trial,c.parameter,this.schedule[n]));
  }
}
export type CooperativeEvent =
  | { kind:'status'; phase:string; detail:string; finished?:boolean; log?:boolean }
  /** One line of what went over the air: `->` sent from this device, `<-` received, `X` heard but garbled. */
  | { kind:'wire'; line:string }
  | { kind:'measurement'; measurement:TrialMeasurement }
  | { kind:'feedback'; observation:SearchObservation; best?:{value:number;errors:number;symbols:number} }
  /** A trial whose test packet was never received (partner timeout, or the controller hearing lost()). */
  | { kind:'lost'; proposal:Proposal };

/** Binary data is shown as bracketed hex, e.g. [1A EF]. */
export const hexBytes = (bytes: ArrayLike<number>) => `[${Array.from(bytes, b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}]`;
const symbolsReceived = (raw: { symbols: number; symbolErrors: number }) => `${raw.symbols - raw.symbolErrors}/${raw.symbols} symbols received`;
export const describeSettings = (t: TrialSettings) =>
  `Base=${t.lowestFrequency}, Tones=${t.tones}, Baud=${t.symbolRate}, Bytes=${t.payloadBytes}, Seed=${t.seed}, Amp=${t.amplitudePercent}%, Gap=${t.gapPercent}% (${trialFsk(t).frequencies.join('/')} Hz)`;
/** What a control message means, for the log. */
export function describeControl(m: ControlMessage): string {
  const trial = `trial ${m.trial + 1}`;
  switch (m.kind) {
    case 'test_suite': return `${trial} settings: ${describeSettings(m.settings)}`;
    case 'result': return `${trial}: ${m.raw.crcOk ? 'received' : 'CRC failed'}, ${symbolsReceived(m.raw)}, median S/N ${m.raw.snrMedianDb.toFixed(1)} dB`;
    case 'done': return `run finished after ${m.trial} trials`;
    case 'lost': return `partner did not receive the ${trial} test packet`;
  }
}
/** Frame ID (sender#seq) and raw wire text, then its meaning; for text payloads the raw data is already readable. */
export const describeWire = (m: ControlMessage, seq: number, bytes?: Uint8Array) =>
  `${frameId(m.sender, seq)} ${bytes ? String.fromCharCode(...bytes) : controlText(m)} · ${describeControl(m)}`;
export const describeTestSent = (p: Proposal, seq: number) => `${frameId(p.sender, seq)} test packet ${hexBytes(trialPayload(p.settings))} · trial ${p.trial + 1}`;
export const describeTestReceived = (m: TrialMeasurement) =>
  `${frameId(m.sender, m.seq)} test packet ${hexBytes(m.received)} · trial ${m.trial + 1}: ${m.raw.crcOk ? 'received' : 'CRC failed'}, ${symbolsReceived(m.raw)}, S/N dB [${m.snrDb.map(v => Math.round(v)).join(' ')}] median ${m.raw.snrMedianDb.toFixed(1)} · by tone ${trialFsk(m.settings).frequencies.map((f, k) => `${f}:${Number.isFinite(m.snrByToneDb[k]) ? Math.round(m.snrByToneDb[k]) : '—'}`).join(' ')} dB · drift ${signedMs(m.timingDriftMs)}`;
const signedMs = (ms: number) => `${ms >= 0 ? '+' : '−'}${Math.abs(ms).toFixed(1)} ms`;

/** Air time of one guarded FSK frame carrying `payloadBytes`, in seconds; control frames are coded, test packets are not. */
function frameSeconds(payloadBytes: number, tones: number, symbolRate: number, fec = false, guardSeconds = 1): number {
  return fskFrameSymbols(payloadBytes, Math.log2(tones), fec) / symbolRate + guardSeconds;
}
const controlSeconds = (m: ControlMessage) => frameSeconds(encodeControl(m).length, CONTROL_FSK.frequencies.length, CONTROL_FSK.symbolRate, true);
/** An ACK frame's payload is the confirmed frame's sender and sequence number. */
const ackSeconds = () => frameSeconds(4, CONTROL_FSK.frequencies.length, CONTROL_FSK.symbolRate, true);
const testPacketSeconds = (t: TrialSettings) => frameSeconds(t.payloadBytes, t.tones, t.symbolRate);
/**
 * Rough duration of one clean test (no retries): test_suite, its ACK, test packet, result, its ACK, each with 0.5 s quiet
 * guards on both sides plus ~0.4 s of decode and audio latency per exchange.
 */
/** Estimated length of a whole run: every value, once per repetition, at that value's own air time. */
export function estimateRunSeconds(s: SearchSettings): number {
  return searchValues(s).reduce((total, value) => total + estimateTestSeconds(withValue(s.trial, s.parameter, value)), 0) * s.repetitions;
}
export function estimateTestSeconds(t: TrialSettings): number {
  const trial = 9, raw = { symbolErrors: 10, symbols: 64, bitErrors: 10, bits: 128, confidence: 0.85, snrMedianDb: 18.5, crcOk: true };
  return [controlSeconds({ kind: 'test_suite', sender: 0, trial, settings: t }), ackSeconds(),
    testPacketSeconds(t), controlSeconds({ kind: 'result', sender: 0, trial, raw }), ackSeconds()]
    .reduce((total, seconds) => total + seconds + 0.4, 0);
}
/**
 * How long the partner's test listener stays open after hearing test_suite: its own ACK, the controller's
 * reaction and the test packet's air time, plus generous latency. A retried test_suite restarts the window.
 */
export function testListenSeconds(t: TrialSettings): number {
  return ackSeconds() + testPacketSeconds(t) + 3;
}
