/** Shared, serializable experiment definitions. No audio hardware or DSP here. */
export interface TrialSettings {
  tones: number; lowestFrequency: number; spacing: number; symbolRate: number;
  amplitude: number; coding: 'none';
}
export interface ExperimentPlan {
  format: 'sonic-experiment'; version: 1; seed: number; payloadBytes: number;
  guardSeconds: number; trials: TrialSettings[];
}
export const CHECKPOINT_FSK = { frequencies: [1000, 1200, 1400, 1600], symbolRate: 100 };
export const CHECKPOINT_BYTES = 12;
export const EXPERIMENT_MAX_SECONDS = 100;
export const trialFsk = (trial: TrialSettings) => ({
  frequencies: Array.from({ length: trial.tones }, (_, i) => trial.lowestFrequency + i * trial.spacing),
  symbolRate: trial.symbolRate
});
export function trialPayload(plan: ExperimentPlan, index: number): Uint8Array {
  let state = (plan.seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0 || 1;
  return Uint8Array.from({ length: plan.payloadBytes }, () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return state & 255;
  });
}
const packetSamples = (bytes: number, tones: number, rate: number, sampleRate: number) =>
  Math.ceil((bytes + 9) * 8 / Math.log2(tones)) * Math.round(sampleRate / rate);
export function experimentTimeline(plan: ExperimentPlan, sampleRate: number) {
  let position = Math.round(sampleRate * 0.5);
  const guard = Math.round(plan.guardSeconds * sampleRate);
  const marker = packetSamples(CHECKPOINT_BYTES, 4, 100, sampleRate);
  return plan.trials.map(trial => {
    const markerStart = position, packetStart = markerStart + marker + guard;
    const packetEnd = packetStart + packetSamples(plan.payloadBytes, trial.tones, trial.symbolRate, sampleRate);
    position = packetEnd + guard;
    return { markerStart, packetStart, packetEnd, end: position };
  });
}
export function validatePlan(value: unknown): ExperimentPlan {
  const p = value as ExperimentPlan;
  if (!p || p.format !== 'sonic-experiment' || p.version !== 1 || !Number.isInteger(p.seed) || p.seed < 0 || p.seed > 0xffffffff ||
      !Number.isInteger(p.payloadBytes) || p.payloadBytes < 1 || p.payloadBytes > 128 ||
      !Number.isFinite(p.guardSeconds) || p.guardSeconds < 0.25 || p.guardSeconds > 2 ||
      !Array.isArray(p.trials) || !p.trials.length || p.trials.length > 32) throw new Error('Invalid experiment plan');
  for (const t of p.trials) {
    if (!t || ![2, 4, 8, 16].includes(t.tones) || t.coding !== 'none' ||
        !Number.isFinite(t.lowestFrequency) || t.lowestFrequency < 100 ||
        !Number.isFinite(t.spacing) || t.spacing < 10 || t.lowestFrequency + (t.tones - 1) * t.spacing > 20000 ||
        !Number.isFinite(t.symbolRate) || t.symbolRate < 10 || t.symbolRate > 1000 ||
        !Number.isFinite(t.amplitude) || t.amplitude <= 0 || t.amplitude > 1) throw new Error('Invalid FSK trial; payload coding currently supports none');
  }
  // Normalize property order so independently imported copies have the same identity.
  const plan: ExperimentPlan = { format: p.format, version: 1, seed: p.seed, payloadBytes: p.payloadBytes,
    guardSeconds: p.guardSeconds, trials: p.trials.map(t => ({ tones: t.tones, lowestFrequency: t.lowestFrequency,
      spacing: t.spacing, symbolRate: t.symbolRate, amplitude: t.amplitude, coding: 'none' })) };
  if (experimentTimeline(plan, 48000).slice(-1)[0]!.end > 48000 * EXPERIMENT_MAX_SECONDS) throw new Error('Keep the experiment under 100 seconds; reduce trials or payload length');
  return plan;
}
/** Non-security fingerprint to reject a checkpoint from a different test schedule. */
export function planId(plan: ExperimentPlan): number {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(JSON.stringify(validatePlan(plan)))) hash = Math.imul(hash ^ byte, 16777619);
  return hash >>> 0;
}
export function defaultPlan(): ExperimentPlan {
  return validatePlan({ format: 'sonic-experiment', version: 1, seed: 20260914, payloadBytes: 8, guardSeconds: 0.5,
    trials: Array.from({ length: 2 }, () => [[2, 25], [4, 50], [8, 100], [2, 50], [4, 100], [8, 25]]
      .map(([tones, symbolRate]) => ({ tones, symbolRate, lowestFrequency: 1000, spacing: 200, amplitude: 0.8, coding: 'none' }))).flat() });
}
export interface TrialResult {
  index: number; status: 'pending' | 'measured' | 'incomplete' | 'unsynchronized' | 'not-transmitted';
  startSample?: number; endSample?: number; acquired?: boolean;
  bitErrors?: number; comparedBits?: number; crcOk?: boolean; messageOk?: boolean;
  correction: 'none';
}
export interface Checkpoint { index: number; sample: number; samplesPerSecond: number }
export interface ExperimentReport {
  planId: number; results: TrialResult[]; checkpoints: Checkpoint[]; complete: boolean; captureLoss: boolean;
}
export interface TransmitterLog {
  format: 'sonic-transmission'; version: 1; planId: number; sampleRate: number;
  playedSamples: number; completed: boolean; appVersion: string;
}
export function validateTransmitterLog(value: unknown, plan: ExperimentPlan): TransmitterLog {
  const log = value as TransmitterLog;
  if (!log || log.format !== 'sonic-transmission' || log.version !== 1 || log.planId !== planId(plan) ||
      !Number.isInteger(log.sampleRate) || log.sampleRate < 8000 || log.sampleRate > 192000 ||
      !Number.isInteger(log.playedSamples) || log.playedSamples < 0 ||
      log.playedSamples > experimentTimeline(plan, log.sampleRate).slice(-1)[0]!.end ||
      typeof log.completed !== 'boolean' || typeof log.appVersion !== 'string') throw new Error('Transmitter log does not match this experiment');
  return log;
}
export function applyTransmitterLog(report: ExperimentReport, plan: ExperimentPlan, log?: TransmitterLog): TrialResult[] {
  if (!log) return report.results;
  validateTransmitterLog(log, plan);
  const timeline = experimentTimeline(plan, log.sampleRate);
  return report.results.map(r => timeline[r.index].packetEnd > log.playedSamples
    ? { index: r.index, status: 'not-transmitted', correction: 'none' } : r);
}
