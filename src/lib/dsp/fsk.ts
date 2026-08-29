import { bitsToBytes, bytesToBits } from './bits';
import { frame, unframe } from './frame';
import { golayRadiusForBitsPerSymbol } from './golay';
import type { DecodeResult, FskConfig, Waveform } from './types';

function validate(config: FskConfig) {
  const bits = Math.log2(config.frequencies.length);
  if (!Number.isInteger(bits) || bits < 1) throw new Error('FSK tone count must be a power of two');
  const n = Math.round(config.sampleRate / config.symbolRate);
  if (n < 4) throw new Error('symbol rate is too high');
  return { bits, n };
}

export function encodeFsk(payload: Uint8Array, config: FskConfig): Waveform {
  const { bits: bitsPerSymbol, n } = validate(config);
  const bits = bytesToBits(frame(payload));
  while (bits.length % bitsPerSymbol) bits.push(0);
  const samples = new Float32Array((bits.length / bitsPerSymbol) * n);
  const amplitude = config.amplitude ?? 0.8;
  let phase = 0;
  for (let s = 0; s < bits.length / bitsPerSymbol; s++) {
    let value = 0;
    for (let b = 0; b < bitsPerSymbol; b++) value = (value << 1) | bits[s * bitsPerSymbol + b];
    const step = 2 * Math.PI * config.frequencies[value] / config.sampleRate;
    for (let i = 0; i < n; i++) { samples[s * n + i] = amplitude * Math.sin(phase); phase += step; }
  }
  return { samples, sampleRate: config.sampleRate };
}

export function decodeFsk(samples: Float32Array, config: FskConfig): DecodeResult {
  const { bits: bitsPerSymbol, n } = validate(config);
  const bits: number[] = []; let confidence = 0; const symbols = Math.floor(samples.length / n);
  for (let s = 0; s < symbols; s++) {
    const energies = config.frequencies.map(f => {
      let re = 0, im = 0;
      for (let i = 0; i < n; i++) { const p = 2 * Math.PI * f * i / config.sampleRate; const x = samples[s * n + i]; re += x * Math.cos(p); im -= x * Math.sin(p); }
      return re * re + im * im;
    });
    let best = 0, second = 0;
    for (let i = 1; i < energies.length; i++) if (energies[i] > energies[best]) best = i;
    for (let i = 0; i < energies.length; i++) if (i !== best) second = Math.max(second, energies[i]);
    confidence += (energies[best] - second) / (energies[best] + 1e-12);
    for (let b = bitsPerSymbol - 1; b >= 0; b--) bits.push((best >>> b) & 1);
  }
  const parsed = unframe(bitsToBytes(bits), golayRadiusForBitsPerSymbol(bitsPerSymbol));
  return { payload: parsed.payload, ok: !!parsed.payload, confidence: confidence / Math.max(1, symbols), errors: parsed.error ? [parsed.error] : [] };
}
