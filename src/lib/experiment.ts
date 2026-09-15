/** Cooperative experiments use an acoustic control link; no shared schedule is required. */
export interface TrialSettings {
  tones: number; lowestFrequency: number; spacing: number; symbolRate: number; amplitude: number;
  payloadBytes: number; seed: number; guardSeconds: number;
}
export type SearchParameter = 'lowestFrequency' | 'spacing' | 'tones';
export interface SearchSettings {
  trial: TrialSettings; parameter: SearchParameter; minimum: number; maximum: number; step: number; budget: number;
}
export const CONTROL_FSK = { frequencies: [1000, 1200, 1400, 1600], symbolRate: 100, amplitude: 0.8 };
// 0.8 leaves headroom so output resampling and device processing don't clip the control tones.
export const MAX_SESSION_SECONDS = 600;
/** Text replies are longer: a result is ~2 s of air plus a 0.5 s quiet lead, then decode and audio latency. */
export const REPLY_TIMEOUT_MS = 6000;
export const MAX_RETRIES = 5;
export const trialFsk = (t: TrialSettings) => ({ frequencies: Array.from({ length: t.tones }, (_, i) => t.lowestFrequency + i * t.spacing), symbolRate: t.symbolRate, amplitude: t.amplitude });
export function validateTrial(value: unknown): TrialSettings {
  const t = value as TrialSettings;
  if (!t || ![2,4,8,16].includes(t.tones) || !Number.isInteger(t.lowestFrequency) || t.lowestFrequency < 100 ||
      !Number.isInteger(t.spacing) || t.spacing < 10 || t.lowestFrequency + (t.tones - 1) * t.spacing > 20000 ||
      !Number.isInteger(t.symbolRate) || t.symbolRate < 25 || t.symbolRate > 1000 ||
      !Number.isFinite(t.amplitude) || t.amplitude < 0.01 || t.amplitude > 0.5 ||
      !Number.isInteger(t.payloadBytes) || t.payloadBytes < 4 || t.payloadBytes > 64 ||
      !Number.isInteger(t.seed) || t.seed < 0 || t.seed > 0xffffffff ||
      !Number.isFinite(t.guardSeconds) || t.guardSeconds < 0.25 || t.guardSeconds > 1.5 ||
      (t.payloadBytes + 9) * 8 / Math.log2(t.tones) / t.symbolRate > 15) throw new Error('Invalid trial settings (test power 0.01–0.5; packet duration at most 15 seconds)');
  return { ...t, amplitude: Math.max(656, Math.min(32767, Math.round(t.amplitude * 65535))) / 65535, guardSeconds: Math.round(t.guardSeconds * 1000) / 1000 };
}
export function defaultSearch(): SearchSettings {
  return { trial: { tones: 4, lowestFrequency: 1000, spacing: 200, symbolRate: 100, amplitude: 0.15,
    payloadBytes: 16, seed: 719, guardSeconds: 0.5 }, parameter: 'lowestFrequency', minimum: 600, maximum: 3000, step: 100, budget: 8 };
}
export function validateSearch(value: SearchSettings): SearchSettings {
  const s = { ...value, trial: validateTrial(value.trial) };
  if (!['lowestFrequency','spacing','tones'].includes(s.parameter) || !Number.isInteger(s.budget) || s.budget < 1 || s.budget > 16 ||
      !Number.isInteger(s.minimum) || !Number.isInteger(s.maximum) || s.minimum >= s.maximum ||
      !Number.isInteger(s.step) || s.step < 1) throw new Error('Invalid search range or trial budget');
  const values = s.parameter === 'tones' ? [2,4,8,16] : [s.minimum, s.maximum];
  for (const v of values) validateTrial({ ...s.trial, [s.parameter]: v });
  return s;
}
export function trialPayload(t: TrialSettings): Uint8Array {
  let state = t.seed || 1;
  return Uint8Array.from({ length: t.payloadBytes }, () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state & 255; });
}
export interface Proposal { session: number; trial: number; settings: TrialSettings }
export interface RawResult {
  symbolErrors: number; symbols: number; bitErrors: number; bits: number; confidence: number;
  /** Median over payload symbols of the in-window S/N: winning tone energy vs. the rest of the window, in dB. */
  snrMedianDb: number;
}
export interface AcquisitionResult { offsetSamples: number; acquired: boolean; crcOk: boolean; exact: boolean }
export interface TrialMeasurement extends Proposal {
  /** Payload bytes as hard-decided from the received symbols, errors included. */
  received: number[];
  /** In-window S/N per payload symbol, in dB. */
  snrDb: number[];
  raw: RawResult; sampleRate: number; testStart: number; testEnd: number; samplesPerSymbol: number;
  startMarker: number; endMarker: number; confusion: number[][]; acquisition: AcquisitionResult[];
}
export type ControlMessage =
  | ({ kind: 'test_suite' } & Proposal)
  | { kind: 'ready' | 'query' | 'ack' | 'done' | 'lost'; session: number; trial: number }
  | { kind: 'test'; session: number; trial: number; sampleRate: number }
  | { kind: 'end'; session: number; trial: number }
  | { kind: 'result'; session: number; trial: number; raw: RawResult };
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
 * Control messages are plain ASCII method calls inside the usual CRC frame, e.g.
 *   test_suite(1A2B, 1, 1000, 200, 4, 100, 16, 0.15, 719, 0.5)
 * Session is 4 hex digits; trial numbers on the wire are 1-based. Each method is parsed on its own, so one
 * can change without versioning the rest. Test packets stay binary.
 */
const MAX_CONTROL_BYTES = 120;
const session = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');
const decimal = (v: number, digits: number) => String(Number(v.toFixed(digits)));
const INT = /^\d+$/, SIGNED = /^-?\d+(\.\d+)?$/, HEX4 = /^[0-9A-F]{4}$/;
function args(m: ControlMessage): (string | number)[] {
  const head = [session(m.session), m.trial + 1];
  switch (m.kind) {
    case 'test_suite': {
      const t = validateTrial(m.settings);
      return [...head, t.lowestFrequency, t.spacing, t.tones, t.symbolRate, t.payloadBytes, decimal(t.amplitude, 5), t.seed, decimal(t.guardSeconds, 3)];
    }
    case 'test': return [...head, m.sampleRate];
    case 'result': return [...head, m.raw.symbolErrors, m.raw.symbols, m.raw.bitErrors, m.raw.bits, decimal(m.raw.confidence, 2), decimal(m.raw.snrMedianDb, 1)];
    case 'done': return [session(m.session), m.trial];
    default: return head;
  }
}
export const controlText = (m: ControlMessage) => `${m.kind}(${args(m).join(', ')})`;
export function encodeControl(m: ControlMessage): Uint8Array {
  if (m.session < 0 || m.session > 0xffff) throw new RangeError('Session must fit in 4 hex digits');
  return new TextEncoder().encode(controlText(m));
}
const ARG_COUNTS: Record<ControlKind, number> = { test_suite: 10, ready: 2, test: 3, end: 2, result: 8, query: 2, ack: 2, done: 2, lost: 2 };
export function decodeControl(bytes: Uint8Array): ControlMessage | undefined {
  if (bytes.length > MAX_CONTROL_BYTES || bytes.some(b => b < 0x20 || b > 0x7e)) return;
  const match = /^([a-z_]+)\(([^()]*)\)$/.exec(String.fromCharCode(...bytes));
  if (!match || !(match[1] in ARG_COUNTS)) return;
  const kind = match[1] as ControlKind, fields = match[2].split(',').map(f => f.trim());
  if (fields.length !== ARG_COUNTS[kind] || !HEX4.test(fields[0]) || !INT.test(fields[1])) return;
  const numbers = fields.slice(2).map(Number);
  if (fields.slice(2).some(f => !SIGNED.test(f))) return;
  const common = { session: parseInt(fields[0], 16), trial: Number(fields[1]) - 1 };
  try {
    switch (kind) {
      case 'test_suite': {
        if (common.trial < 0) return;
        const [lowestFrequency, spacing, tones, symbolRate, payloadBytes, amplitude, seed, guardSeconds] = numbers;
        return { kind, ...common, settings: validateTrial({ lowestFrequency, spacing, tones, symbolRate, amplitude, payloadBytes, seed, guardSeconds }) };
      }
      case 'test': {
        const sampleRate = numbers[0];
        if (common.trial < 0 || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) return;
        return { kind, ...common, sampleRate };
      }
      case 'result': {
        const [symbolErrors, symbols, bitErrors, bits, confidence, snrMedianDb] = numbers;
        if (common.trial < 0 || !symbols || !bits || symbolErrors > symbols || bitErrors > bits || confidence > 1) return;
        return { kind, ...common, raw: { symbolErrors, symbols, bitErrors, bits, confidence, snrMedianDb } };
      }
      case 'done': return { kind, session: common.session, trial: common.trial + 1 };
      default: return common.trial < 0 ? undefined : { kind, ...common };
    }
  } catch { return; }
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
    if(this.observations.some(p=>p.session===r.session&&p.trial===r.trial))return false;
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
  /** One line of what went over the air: `<-` sent, `->` received, `X` heard but garbled. */
  | { kind:'wire'; line:string }
  | { kind:'measurement'; measurement:TrialMeasurement }
  | { kind:'feedback'; observation:SearchObservation; best?:{value:number;errors:number;symbols:number} };

/** Binary data is shown as bracketed hex, e.g. [1A EF]. */
export const hexBytes = (bytes: ArrayLike<number>) => `[${Array.from(bytes, b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}]`;
const symbolsReceived = (raw: { symbols: number; symbolErrors: number }) => `${raw.symbols - raw.symbolErrors}/${raw.symbols} symbols received`;
export const describeSettings = (t: TrialSettings) =>
  `Base=${t.lowestFrequency}, Delta=${t.spacing}, Tones=${t.tones}, Baud=${t.symbolRate}, Bytes=${t.payloadBytes}, Amp=${Number(t.amplitude.toFixed(3))}, Seed=${t.seed}, Guard=${t.guardSeconds}`;
/** What a control message means, for the log. */
export function describeControl(m: ControlMessage): string {
  const trial = `trial ${m.trial + 1}`;
  switch (m.kind) {
    case 'test_suite': return `${trial} settings: ${describeSettings(m.settings)}`;
    case 'ready': return `partner ready for ${trial}`;
    case 'test': return `${trial} test packet follows (sender at ${m.sampleRate} Hz)`;
    case 'end': return `${trial} test packet ended`;
    case 'result': return `${trial}: ${symbolsReceived(m.raw)}, median S/N ${m.raw.snrMedianDb.toFixed(1)} dB`;
    case 'query': return `asking for ${trial} result`;
    case 'ack': return `${trial} result received`;
    case 'done': return `run finished after ${m.trial} trials`;
    case 'lost': return `partner missed ${trial} (timing markers not heard)`;
  }
}
/** Raw wire text, then its meaning; for text payloads the raw data is already readable. */
export const describeWire = (m: ControlMessage, bytes?: Uint8Array) =>
  `${bytes ? String.fromCharCode(...bytes) : controlText(m)} · ${describeControl(m)}`;
export const describeTestSent = (p: Proposal) => `${hexBytes(trialPayload(p.settings))} · trial ${p.trial + 1} test packet`;
export const describeTestReceived = (m: TrialMeasurement) =>
  `${hexBytes(m.received)} · trial ${m.trial + 1} test packet: ${symbolsReceived(m.raw)}, S/N dB [${m.snrDb.map(v => Math.round(v)).join(' ')}] median ${m.raw.snrMedianDb.toFixed(1)}`;
