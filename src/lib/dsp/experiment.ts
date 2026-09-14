import { CHECKPOINT_BYTES, CHECKPOINT_FSK, experimentTimeline, planId, trialFsk, trialPayload, validatePlan,
  type ExperimentPlan, type ExperimentReport, type TrialResult } from '../experiment';
import { encodeFsk } from './fsk';
import { FskStreamDecoder } from './fsk-stream';
import { detectFskSymbol } from './fsk-detector';
import { bytesToBits } from './bits';
import { frame } from './frame';

function markerPayload(plan: ExperimentPlan, index: number, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(CHECKPOINT_BYTES), view = new DataView(bytes.buffer);
  bytes.set([0x53, 0x58, 1]); view.setUint32(3, planId(plan)); bytes[7] = index; view.setUint32(8, sampleRate);
  return bytes;
}
function validateRate(plan: ExperimentPlan, sampleRate: number) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
      plan.trials.some(t => trialFsk(t).frequencies.slice(-1)[0]! >= sampleRate / 2)) throw new Error('Experiment tones exceed this audio device sample rate');
}
export function encodeExperiment(input: ExperimentPlan, sampleRate: number): Float32Array {
  const plan = validatePlan(input); validateRate(plan, sampleRate);
  const timeline = experimentTimeline(plan, sampleRate);
  const samples = new Float32Array(timeline.slice(-1)[0]!.end);
  timeline.forEach((slot, index) => {
    samples.set(encodeFsk(markerPayload(plan, index, sampleRate), { ...CHECKPOINT_FSK, sampleRate }).samples, slot.markerStart);
    samples.set(encodeFsk(trialPayload(plan, index), { ...trialFsk(plan.trials[index]), sampleRate,
      amplitude: plan.trials[index].amplitude }).samples, slot.packetStart);
  });
  return samples;
}

/** Measures independently acquired raw symbols before Golay length correction or CRC gating. */
export function analyzeTrial(samples: Float32Array, sampleRate: number, plan: ExperimentPlan, index: number,
  base: number, expectedStart: number): TrialResult {
  const config = { ...trialFsk(plan.trials[index]), sampleRate }, decoder = new FskStreamDecoder(config, base);
  const packets = [], progress = [];
  for (let offset = 0; offset < samples.length; offset += 128) {
    packets.push(...decoder.push(samples.subarray(offset, offset + 128)));
    progress.push(...decoder.drainProgress());
  }
  const bitsPerSymbol = Math.log2(config.frequencies.length), perSymbol = Math.round(sampleRate / config.symbolRate);
  const anchors = progress.filter(p => p.type === 'sync')
    .map(p => p.position - Math.round(32 * perSymbol / bitsPerSymbol))
    .filter(p => Math.abs(p - expectedStart) < plan.guardSeconds * sampleRate / 2)
    .sort((a, b) => Math.abs(a - expectedStart) - Math.abs(b - expectedStart));
  const result: TrialResult = { index, status: 'measured', startSample: expectedStart,
    endSample: base + samples.length, acquired: !!anchors.length, crcOk: false, messageOk: false, correction: 'none' };
  if (!anchors.length) return result;
  const anchor = anchors[0], expected = trialPayload(plan, index), bits = bytesToBits(frame(expected));
  const symbols = Math.ceil(bits.length / bitsPerSymbol), start = anchor - base;
  if (start < 0 || start + symbols * perSymbol > samples.length) return { ...result, status: 'incomplete' };
  let errors = 0;
  for (let s = 0; s < symbols; s++) {
    const scores = detectFskSymbol(samples.subarray(start + s * perSymbol, start + (s + 1) * perSymbol),
      sampleRate, config.frequencies).scores;
    let winner = 0;
    for (let tone = 1; tone < scores.length; tone++) if (scores[tone] > scores[winner]) winner = tone;
    for (let b = 0; b < bitsPerSymbol && s * bitsPerSymbol + b < bits.length; b++) {
      if (((winner >>> (bitsPerSymbol - b - 1)) & 1) !== bits[s * bitsPerSymbol + b]) errors++;
    }
  }
  const packet = packets.find(p => Math.abs(p.startPosition - anchor) <= 1);
  return { ...result, startSample: anchor, bitErrors: errors, comparedBits: bits.length, crcOk: !!packet,
    messageOk: !!packet && packet.payload.length === expected.length && packet.payload.every((b, i) => b === expected[i]) };
}

/** Sample-clock scheduler shared by live capture and replay; bounded to recording duration. */
export class ExperimentReceiver {
  readonly report: ExperimentReport;
  private samples: Float32Array;
  private length = 0;
  private marker: FskStreamDecoder;
  private timeline;
  private origin?: number;
  private scale: number;
  private transmitterRate = 48000;
  private active = -2;
  private identity: number;
  constructor(readonly plan: ExperimentPlan, readonly sampleRate: number,
    private changed: (report: ExperimentReport) => void = () => {},
    private configure: (fsk: typeof CHECKPOINT_FSK) => void = () => {}) {
    validatePlan(plan); validateRate(plan, sampleRate);
    this.identity = planId(plan);
    this.samples = new Float32Array(120 * sampleRate);
    this.marker = new FskStreamDecoder({ ...CHECKPOINT_FSK, sampleRate });
    this.timeline = experimentTimeline(plan, this.transmitterRate);
    this.scale = sampleRate;
    this.report = { planId: this.identity, results: plan.trials.map((_, index) => ({ index, status: 'pending', correction: 'none' })),
      checkpoints: [], complete: false, captureLoss: false };
  }
  push(chunk: Float32Array): void {
    if (this.report.complete || this.report.captureLoss) return;
    if (this.length + chunk.length > this.samples.length) { this.finish(); return; }
    this.samples.set(chunk, this.length); this.length += chunk.length;
    let changed = false;
    for (const packet of this.marker.push(chunk)) {
      const p = packet.payload;
      if (p.length !== CHECKPOINT_BYTES || p[0] !== 0x53 || p[1] !== 0x58 || p[2] !== 1) continue;
      const view = new DataView(p.buffer, p.byteOffset, p.byteLength), index = p[7], rate = view.getUint32(8);
      if (view.getUint32(3) !== this.identity || index >= this.plan.trials.length || rate < 8000 || rate > 192000 ||
          index <= (this.report.checkpoints.slice(-1)[0]?.index ?? -1)) continue;
      if (this.report.checkpoints.length && rate !== this.transmitterRate) continue;
      this.transmitterRate = rate; this.timeline = experimentTimeline(this.plan, rate);
      const first = this.report.checkpoints[0];
      if (first) {
        const elapsed = (this.timeline[index].markerStart - this.timeline[first.index].markerStart) / rate;
        const estimate = (packet.startPosition - first.sample) / elapsed;
        if (Math.abs(estimate / this.sampleRate - 1) > 0.01) continue;
        this.scale = estimate;
      }
      this.origin = packet.startPosition - this.timeline[index].markerStart / rate * this.scale;
      this.report.checkpoints.push({ index, sample: packet.startPosition, samplesPerSecond: this.scale }); changed = true;
    }
    this.marker.drainProgress();
    if (this.origin !== undefined) {
      let active = -1;
      this.timeline.forEach((slot, index) => {
        const from = this.origin! + slot.packetStart / this.transmitterRate * this.scale;
        const to = this.origin! + slot.packetEnd / this.transmitterRate * this.scale;
        const margin = this.plan.guardSeconds * this.scale / 2;
        if (this.length >= from - margin && this.length < to + margin) active = index;
        if (this.report.results[index].status !== 'pending' || this.length < to + margin) return;
        const start = Math.floor(from - margin), end = Math.ceil(to + margin);
        if (end > this.length) return;
        this.report.results[index] = start < 0
          ? { index, status: 'incomplete', correction: 'none' }
          : analyzeTrial(this.samples.subarray(start, end), this.sampleRate, this.plan, index, start, from);
        changed = true;
      });
      if (active !== this.active) { this.active = active; this.configure(active < 0 ? CHECKPOINT_FSK : trialFsk(this.plan.trials[active])); }
      if (this.report.results.every(r => r.status !== 'pending')) { this.report.complete = true; changed = true; }
    }
    if (changed) this.changed(this.report);
  }
  finish(captureLoss = false): ExperimentReport {
    this.report.captureLoss ||= captureLoss;
    this.report.results = this.report.results.map(r => r.status === 'pending'
      ? { ...r, status: this.origin === undefined ? 'unsynchronized' : 'incomplete' } : r);
    this.changed(this.report);
    return this.report;
  }
}
