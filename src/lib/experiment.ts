import { FRAME_OVERHEAD_BYTES, FRAME_TYPE, frameId, PAYLOAD_OFFSET, senderHex, type FrameAddress } from './dsp/frame';
/** Cooperative experiments use an acoustic control link; no shared schedule is required. */
export interface TrialSettings {
  tones: number; lowestFrequency: number; spacing: number; symbolRate: number;
  payloadBytes: number; seed: number;
}
export type SearchParameter = 'lowestFrequency' | 'spacing' | 'tones';
export interface SearchSettings {
  trial: TrialSettings; parameter: SearchParameter; minimum: number; maximum: number; step: number; budget: number;
}
export const CONTROL_FSK = { frequencies: [1000, 1200, 1400, 1600], symbolRate: 100, amplitude: 0.8 };
// 0.8 leaves headroom so output resampling and device processing don't clip the control tones.
export const MAX_SESSION_SECONDS = 600;
/** Test packets always play at the control amplitude, which leaves headroom below clipping. */
export const TEST_AMPLITUDE = 0.8;
export const MAX_TESTS = 100;
export const trialFsk = (t: TrialSettings) => ({ frequencies: Array.from({ length: t.tones }, (_, i) => t.lowestFrequency + i * t.spacing), symbolRate: t.symbolRate, amplitude: TEST_AMPLITUDE });
export function validateTrial(value: unknown): TrialSettings {
  const t = value as TrialSettings;
  if (!t || ![2,4,8,16].includes(t.tones) || !Number.isInteger(t.lowestFrequency) || t.lowestFrequency < 100 ||
      !Number.isInteger(t.spacing) || t.spacing < 10 || t.lowestFrequency + (t.tones - 1) * t.spacing > 20000 ||
      !Number.isInteger(t.symbolRate) || t.symbolRate < 25 || t.symbolRate > 1000 ||
      !Number.isInteger(t.payloadBytes) || t.payloadBytes < 4 || t.payloadBytes > 64 ||
      !Number.isInteger(t.seed) || t.seed < 0 || t.seed > 0xffffffff ||
      (t.payloadBytes + FRAME_OVERHEAD_BYTES) * 8 / Math.log2(t.tones) / t.symbolRate > 15) throw new Error('Invalid trial settings (packet duration at most 15 seconds)');
  const { tones, lowestFrequency, spacing, symbolRate, payloadBytes, seed } = t;
  return { tones, lowestFrequency, spacing, symbolRate, payloadBytes, seed };
}
export function defaultSearch(): SearchSettings {
  return { trial: { tones: 4, lowestFrequency: 1000, spacing: 200, symbolRate: 100,
    payloadBytes: 16, seed: 719 }, parameter: 'lowestFrequency', minimum: 600, maximum: 3000, step: 100, budget: 8 };
}
export function validateSearch(value: SearchSettings): SearchSettings {
  const s = { ...value, trial: validateTrial(value.trial) };
  if (!['lowestFrequency','spacing','tones'].includes(s.parameter) || !Number.isInteger(s.budget) || s.budget < 1 || s.budget > MAX_TESTS ||
      !Number.isInteger(s.minimum) || !Number.isInteger(s.maximum) || s.minimum >= s.maximum ||
      !Number.isInteger(s.step) || s.step < 1) throw new Error(`Invalid search range or number of tests (1–${MAX_TESTS})`);
  const values = s.parameter === 'tones' ? [2,4,8,16] : [s.minimum, s.maximum];
  for (const v of values) validateTrial({ ...s.trial, [s.parameter]: v });
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
 *   test_suite(1, 1000, 200, 4, 100, 16, 719)
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
      return [m.trial + 1, t.lowestFrequency, t.spacing, t.tones, t.symbolRate, t.payloadBytes, t.seed];
    }
    case 'result': return [m.trial + 1, m.raw.symbolErrors, m.raw.symbols, m.raw.bitErrors, m.raw.bits, decimal(m.raw.confidence, 2), decimal(m.raw.snrMedianDb, 1), m.raw.crcOk ? 1 : 0];
    case 'done': return [m.trial];
    default: return [m.trial + 1];
  }
}
export const controlText = (m: ControlMessage) => `${m.kind}(${args(m).join(', ')})`;
export const encodeControl = (m: ControlMessage): Uint8Array => new TextEncoder().encode(controlText(m));
export const controlAddress = (m: ControlMessage, seq = 0, ackRequested = false): FrameAddress => ({ sender: m.sender, seq, type: FRAME_TYPE.control, ackRequested });
const ARG_COUNTS: Record<ControlKind, number> = { test_suite: 7, result: 8, done: 1, lost: 1 };
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
        const [lowestFrequency, spacing, tones, symbolRate, payloadBytes, seed] = numbers;
        return { kind, ...common, settings: validateTrial({ lowestFrequency, spacing, tones, symbolRate, payloadBytes, seed }) };
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
/** Coarse exploration, repeated references, then local refinement. Best means best measured, not a global optimum. */
export class ParameterSearch {
  readonly observations: SearchObservation[]=[];
  private coarse:number[];
  private spacing:number;
  constructor(readonly config:SearchSettings) {
    validateSearch(config);
    this.coarse=config.parameter==='tones'?[2,4,8,16]:Array.from({length:5},(_,i)=>Math.round(config.minimum+(config.maximum-config.minimum)*i/4));
    this.coarse=this.coarse.filter(v=>v!==config.trial[config.parameter]); this.spacing=Math.max(config.step,Math.round((config.maximum-config.minimum)/8));
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
    const n=this.observations.length,c=this.config;if(n>=c.budget)return;
    let value=c.trial[c.parameter];
    if(n>0){
      if(n%3===0)value=this.best()!.value;
      else if(this.coarse.length)value=this.coarse.shift()!;
      else if(c.parameter==='tones')value=[2,4,8,16][n%4];
      else { value=Math.max(c.minimum,Math.min(c.maximum,this.best()!.value+(n%2?1:-1)*this.spacing));if(n%2===0)this.spacing=Math.max(c.step,Math.floor(this.spacing/2)); }
    }
    return validateTrial({...c.trial,[c.parameter]:value});
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
  `Base=${t.lowestFrequency}, Delta=${t.spacing}, Tones=${t.tones}, Baud=${t.symbolRate}, Bytes=${t.payloadBytes}, Seed=${t.seed}`;
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
  `${frameId(m.sender, m.seq)} test packet ${hexBytes(m.received)} · trial ${m.trial + 1}: ${m.raw.crcOk ? 'received' : 'CRC failed'}, ${symbolsReceived(m.raw)}, S/N dB [${m.snrDb.map(v => Math.round(v)).join(' ')}] median ${m.raw.snrMedianDb.toFixed(1)} · drift ${signedMs(m.timingDriftMs)}`;
const signedMs = (ms: number) => `${ms >= 0 ? '+' : '−'}${Math.abs(ms).toFixed(1)} ms`;

/** Air time of one guarded FSK frame carrying `payloadBytes`, in seconds. */
function frameSeconds(payloadBytes: number, tones: number, symbolRate: number, guardSeconds = 1): number {
  return Math.ceil((payloadBytes + FRAME_OVERHEAD_BYTES) * 8 / Math.log2(tones)) / symbolRate + guardSeconds;
}
const controlSeconds = (m: ControlMessage) => frameSeconds(encodeControl(m).length, CONTROL_FSK.frequencies.length, CONTROL_FSK.symbolRate);
/** An ACK frame's payload is the confirmed frame's sender and sequence number. */
const ackSeconds = () => frameSeconds(4, CONTROL_FSK.frequencies.length, CONTROL_FSK.symbolRate);
const testPacketSeconds = (t: TrialSettings) => frameSeconds(t.payloadBytes, t.tones, t.symbolRate);
/**
 * Rough duration of one clean test (no retries): test_suite, its ACK, test packet, result, its ACK, each with 0.5 s quiet
 * guards on both sides plus ~0.4 s of decode and audio latency per exchange.
 */
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
