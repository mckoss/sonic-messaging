import { describe, expect, it } from 'vitest';
import { encodeExperiment, ExperimentReceiver } from './experiment';
import { applyTransmitterLog, experimentTimeline, planId, trialPayload, validatePlan, type ExperimentPlan } from '../experiment';
import { frame } from './frame';
import { bytesToBits } from './bits';
import { simulateChannel } from './channel';
import { decodeRecording, encodeRecording } from '../audio/recording';

const rate = 8000;
const plan: ExperimentPlan = validatePlan({ format: 'sonic-experiment', version: 1, seed: 719, payloadBytes: 4, guardSeconds: 0.25,
  trials: [2, 4, 8].map(tones => ({ tones, lowestFrequency: 1000, spacing: 200, symbolRate: 100, amplitude: 0.8, coding: 'none' })) });
function receive(samples: Float32Array, input = plan, chunkSize = 128) {
  const receiver = new ExperimentReceiver(input, rate);
  for (let offset = 0; offset < samples.length; offset += chunkSize) receiver.push(samples.subarray(offset, offset + chunkSize));
  return receiver.finish();
}

describe('shared-schedule experiments', () => {
  it('has canonical identities and deterministic distinct payloads, and validates scope and duration', () => {
    expect(planId(JSON.parse(JSON.stringify(plan)))).toBe(planId(plan));
    expect(trialPayload(plan, 0)).toEqual(trialPayload(plan, 0));
    expect(trialPayload(plan, 0)).not.toEqual(trialPayload(plan, 1));
    expect(() => validatePlan({ ...plan, trials: [{ ...plan.trials[0], coding: 'rs' }] })).toThrow();
    expect(() => validatePlan({ ...plan, payloadBytes: 128, trials: Array(32).fill({ ...plan.trials[0], symbolRate: 10 }) })).toThrow('100 seconds');
  });

  it('acquires arbitrary recording offsets and measures clean 2/4/8-FSK with identical replay outcomes', () => {
    const wave = encodeExperiment(plan, rate), samples = new Float32Array(wave.length + 555);
    samples.set(wave, 555);
    const first = receive(samples);
    expect(first.complete).toBe(true);
    expect(first.checkpoints).toHaveLength(3);
    expect(first.results.every(r => r.acquired && r.messageOk && r.crcOk && r.bitErrors === 0)).toBe(true);
    expect(first.results.map(r => r.comparedBits)).toEqual([104, 104, 104]);
    expect(receive(samples)).toEqual(first);
    expect(receive(samples, plan, 4096).results.map(r => [r.acquired, r.bitErrors, r.messageOk]))
      .toEqual(first.results.map(r => [r.acquired, r.bitErrors, r.messageOk]));
  });

  it('counts a corrupt payload and a missed packet separately; BER is unavailable without acquisition', () => {
    const wave = encodeExperiment(plan, rate), timeline = experimentTimeline(plan, rate);
    const bits = bytesToBits(frame(trialPayload(plan, 1))), tone = ((bits[56] * 2 + bits[57]) + 1) % 4;
    const offset = timeline[1].packetStart + 28 * 80;
    for (let i = 0; i < 80; i++) wave[offset + i] = 0.8 * Math.sin(2 * Math.PI * (1000 + tone * 200) * i / rate);
    wave.fill(0, timeline[2].packetStart, timeline[2].packetEnd);
    const report = receive(simulateChannel(wave, { snrDb: 25, seed: 919 }));
    expect(report.complete).toBe(true);
    expect(report.results[0].messageOk).toBe(true);
    expect(report.results[1]).toMatchObject({ acquired: true, crcOk: false, messageOk: false });
    expect(report.results[1].bitErrors).toBeGreaterThan(0);
    expect(report.results[2]).toMatchObject({ status: 'measured', acquired: false, messageOk: false });
    expect(report.results[2].comparedBits).toBeUndefined();
  });

  it('retains the schedule when a checkpoint is missed and rejects a different schedule', () => {
    const wave = encodeExperiment(plan, rate), timeline = experimentTimeline(plan, rate);
    wave.fill(0, timeline[1].markerStart, timeline[1].packetStart);
    const report = receive(wave);
    expect(report.checkpoints.map(c => c.index)).toEqual([0, 2]);
    expect(report.results.every(r => r.messageOk)).toBe(true);
    expect(receive(wave, { ...plan, seed: 720 }).results.every(r => r.status === 'unsynchronized')).toBe(true);
  });

  it('tracks checkpoint clock drift and keeps sample-rate and schedule metadata through WAV round trips', () => {
    const wave = encodeExperiment(plan, rate), factor = 1.0005;
    const stretched = Float32Array.from({ length: Math.floor(wave.length * factor) }, (_, i) => {
      const x = i / factor, a = Math.floor(x), fraction = x - a;
      return wave[a] * (1 - fraction) + (wave[a + 1] ?? 0) * fraction;
    });
    const recording = decodeRecording(encodeRecording({ samples: stretched, metadata: {
      format: 'sonic-recording', version: 1, appVersion: 'test', createdAt: '2026-09-14', sampleRate: rate,
      fsk: { frequencies: [1000,1200,1400,1600], symbolRate: 100 }, inputSettings: {}, userAgent: 'test', notes: '', experiment: { plan }
    } }));
    const report = receive(recording.samples, recording.metadata.experiment!.plan);
    expect(report.results.every(r => r.messageOk)).toBe(true);
    expect(report.checkpoints.slice(-1)[0]!.samplesPerSecond).toBeGreaterThan(rate + 1);
  });

  it('does not score truncated capture or trials not fully transmitted', () => {
    const wave = encodeExperiment(plan, rate), timeline = experimentTimeline(plan, rate);
    const cut = timeline[1].packetStart + 10;
    const report = receive(wave.subarray(0, cut));
    expect(report.results[0].status).toBe('measured');
    expect(report.results[1].status).toBe('incomplete');
    const rows = applyTransmitterLog(report, plan, { format: 'sonic-transmission', version: 1,
      planId: planId(plan), sampleRate: rate, playedSamples: cut, completed: false, appVersion: 'test' });
    expect(rows.map(r => r.status)).toEqual(['measured', 'not-transmitted', 'not-transmitted']);
    const receiver = new ExperimentReceiver(plan, rate);
    receiver.push(wave.subarray(0, cut));
    expect(receiver.finish(true).captureLoss).toBe(true);
  });
});
