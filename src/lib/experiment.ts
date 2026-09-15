/** Cooperative experiments use an acoustic control link; no shared schedule is required. */
export interface TrialSettings {
  tones: number; lowestFrequency: number; spacing: number; symbolRate: number; amplitude: number;
  payloadBytes: number; seed: number; guardSeconds: number;
}
export type SearchParameter = 'lowestFrequency' | 'spacing' | 'tones';
export interface SearchSettings {
  trial: TrialSettings; parameter: SearchParameter; minimum: number; maximum: number; step: number; budget: number;
}
export const CONTROL_FSK = { frequencies: [1000, 1200, 1400, 1600], symbolRate: 100, amplitude: 0.9 };
export const MAX_SESSION_SECONDS = 110;
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
export interface RawResult { symbolErrors: number; symbols: number; bitErrors: number; bits: number; confidence: number }
export interface AcquisitionResult { offsetSamples: number; acquired: boolean; crcOk: boolean; exact: boolean }
export interface TrialMeasurement extends Proposal {
  raw: RawResult; sampleRate: number; testStart: number; testEnd: number; samplesPerSymbol: number;
  startMarker: number; endMarker: number; confusion: number[][]; acquisition: AcquisitionResult[];
}
export type ControlMessage =
  | ({ kind: 'propose' } & Proposal)
  | { kind: 'ready' | 'query' | 'ack' | 'done'; session: number; trial: number }
  | { kind: 'start'; session: number; trial: number; sampleRate: number }
  | { kind: 'end'; session: number; trial: number }
  | { kind: 'result'; session: number; trial: number; raw: RawResult };
const kinds = ['propose','ready','start','end','result','query','ack','done'] as const;
/** Compact CRC-framed control payload; never transports acoustic samples or unknown timing. */
export function encodeControl(m: ControlMessage): Uint8Array {
  const extra = m.kind === 'propose' ? 17 : m.kind === 'start' ? 4 : m.kind === 'result' ? 10 : 0;
  const out = new Uint8Array(10 + extra), v = new DataView(out.buffer);
  out.set([0x43,0x58,2,kinds.indexOf(m.kind)]); v.setUint32(4, m.session); v.setUint16(8, m.trial);
  if (m.kind === 'propose') {
    const t = validateTrial(m.settings);
    v.setUint16(10,t.lowestFrequency); v.setUint16(12,t.spacing); out[14]=t.tones; v.setUint16(15,t.symbolRate);
    v.setUint16(17,Math.round(t.amplitude*65535)); out[19]=t.payloadBytes; v.setUint32(20,t.seed); v.setUint16(24,Math.round(t.guardSeconds*1000)); out[26]=0;
  } else if (m.kind === 'start') v.setUint32(10,m.sampleRate);
  else if (m.kind === 'result') {
    v.setUint16(10,m.raw.symbolErrors); v.setUint16(12,m.raw.symbols); v.setUint16(14,m.raw.bitErrors); v.setUint16(16,m.raw.bits); v.setUint16(18,Math.round(m.raw.confidence*65535));
  }
  return out;
}
export function decodeControl(bytes: Uint8Array): ControlMessage | undefined {
  if (bytes.length < 10 || bytes[0]!==0x43 || bytes[1]!==0x58 || bytes[2]!==2 || bytes[3]>=kinds.length) return;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length), kind=kinds[bytes[3]];
  const common={session:v.getUint32(4),trial:v.getUint16(8)};
  const expected=kind==='propose'?27:kind==='start'?14:kind==='result'?20:10;
  if (bytes.length!==expected) return;
  try {
    if(kind==='propose') return {kind,...common,settings:validateTrial({lowestFrequency:v.getUint16(10),spacing:v.getUint16(12),tones:bytes[14],symbolRate:v.getUint16(15),amplitude:v.getUint16(17)/65535,payloadBytes:bytes[19],seed:v.getUint32(20),guardSeconds:v.getUint16(24)/1000})};
    if(kind==='start') { const sampleRate=v.getUint32(10); if(sampleRate<8000||sampleRate>192000)return; return {kind,...common,sampleRate}; }
    if(kind==='result') {
      const raw={symbolErrors:v.getUint16(10),symbols:v.getUint16(12),bitErrors:v.getUint16(14),bits:v.getUint16(16),confidence:v.getUint16(18)/65535};
      if(!raw.symbols||!raw.bits||raw.symbolErrors>raw.symbols||raw.bitErrors>raw.bits)return;
      return {kind,...common,raw};
    }
    return {kind,...common};
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
  | { kind:'status'; phase:string; detail:string; finished?:boolean }
  | { kind:'trial'; direction:'sent'|'received'; proposal:Proposal }
  | { kind:'measurement'; measurement:TrialMeasurement }
  | { kind:'feedback'; observation:SearchObservation; best?:{value:number;errors:number;symbols:number} };
