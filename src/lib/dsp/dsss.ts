import { bitsToBytes, bytesToBits } from './bits';
import { frame, unframe } from './frame';
import type { DecodeResult, DsssConfig, Waveform } from './types';

function samplesPerChip(c: DsssConfig) { const n = Math.round(c.sampleRate / c.chipRate); if (n < 2) throw new Error('chip rate is too high'); return n; }

export function encodeDsss(payload: Uint8Array, config: DsssConfig): Waveform {
  const spc = samplesPerChip(config), bits = bytesToBits(frame(payload)), n = bits.length * config.code.length * spc;
  const out = new Float32Array(n), amp = config.amplitude ?? 0.8;
  for (let bit = 0; bit < bits.length; bit++) for (let chip = 0; chip < config.code.length; chip++) {
    const sign = (bits[bit] ? 1 : -1) * config.code[chip];
    for (let j = 0; j < spc; j++) { const i = (bit * config.code.length + chip) * spc + j; out[i] = amp * sign * Math.cos(2 * Math.PI * config.carrierFrequency * i / config.sampleRate); }
  }
  return { samples: out, sampleRate: config.sampleRate };
}

function correlations(samples: Float32Array, c: DsssConfig): number[] {
  const spc = samplesPerChip(c), perBit = spc * c.code.length, count = Math.floor(samples.length / perBit), out: number[] = [];
  for (let bit = 0; bit < count; bit++) { let sum = 0, energy = 0;
    for (let chip = 0; chip < c.code.length; chip++) for (let j = 0; j < spc; j++) { const i = bit * perBit + chip * spc + j, carrier = Math.cos(2 * Math.PI * c.carrierFrequency * i / c.sampleRate); sum += samples[i] * carrier * c.code[chip]; energy += Math.abs(samples[i] * carrier); }
    out.push(sum / (energy + 1e-12));
  }
  return out;
}

export function dsssDetectionMetric(samples: Float32Array, config: DsssConfig): number {
  const values = correlations(samples, config); return values.reduce((a, v) => a + Math.abs(v), 0) / Math.max(1, values.length);
}

export function detectDsssUsers(samples: Float32Array, configs: DsssConfig[]): Array<{ index: number; score: number }> {
  return configs.map((config, index) => ({ index, score: dsssDetectionMetric(samples, config) })).sort((a, b) => b.score - a.score);
}

export function decodeDsss(samples: Float32Array, config: DsssConfig): DecodeResult {
  const values = correlations(samples, config), parsed = unframe(bitsToBytes(values.map(v => v >= 0 ? 1 : 0)));
  const confidence = values.reduce((a, v) => a + Math.min(1, Math.abs(v)), 0) / Math.max(1, values.length);
  return { payload: parsed.payload, ok: !!parsed.payload, confidence, errors: parsed.error ? [parsed.error] : [], metrics: { userCorrelation: dsssDetectionMetric(samples, config) } };
}
