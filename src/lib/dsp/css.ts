import { bitsToBytes, bytesToBits } from './bits';
import { frame, unframe } from './frame';
import type { CssConfig, DecodeResult, Waveform } from './types';

function params(c: CssConfig) {
  const sf = c.spreadingFactor ?? 4, alphabet = 2 ** sf;
  const n = c.samplesPerSymbol ?? Math.round(c.sampleRate * alphabet / c.bandwidth);
  if (c.centerFrequency - c.bandwidth / 2 <= 0 || c.centerFrequency + c.bandwidth / 2 >= c.sampleRate / 2) throw new Error('CSS band is outside Nyquist limits');
  return { sf, alphabet, n };
}

function template(symbol: number, c: CssConfig, n: number, alphabet: number, amplitude = 1): Float32Array {
  const out = new Float32Array(n), low = c.centerFrequency - c.bandwidth / 2;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const fraction = (i / n + symbol / alphabet) % 1;
    phase += 2 * Math.PI * (low + c.bandwidth * fraction) / c.sampleRate;
    out[i] = amplitude * Math.sin(phase);
  }
  return out;
}

export function encodeCss(payload: Uint8Array, config: CssConfig): Waveform {
  const { sf, alphabet, n } = params(config), bits = bytesToBits(frame(payload));
  while (bits.length % sf) bits.push(0);
  const out = new Float32Array(bits.length / sf * n);
  for (let s = 0; s < bits.length / sf; s++) {
    let value = 0; for (let b = 0; b < sf; b++) value = (value << 1) | bits[s * sf + b];
    out.set(template(value, config, n, alphabet, config.amplitude ?? 0.8), s * n);
  }
  return { samples: out, sampleRate: config.sampleRate };
}

export function decodeCss(samples: Float32Array, config: CssConfig): DecodeResult {
  const { sf, alphabet, n } = params(config), refs = Array.from({ length: alphabet }, (_, i) => template(i, config, n, alphabet));
  const bits: number[] = []; let totalConfidence = 0; const count = Math.floor(samples.length / n);
  for (let s = 0; s < count; s++) {
    const scores = refs.map(ref => { let dot = 0; for (let i = 0; i < n; i++) dot += samples[s * n + i] * ref[i]; return dot; });
    let best = 0, second = -Infinity; for (let i = 1; i < alphabet; i++) if (scores[i] > scores[best]) best = i;
    for (let i = 0; i < alphabet; i++) if (i !== best) second = Math.max(second, scores[i]);
    totalConfidence += Math.max(0, (scores[best] - second) / (Math.abs(scores[best]) + 1e-12));
    for (let b = sf - 1; b >= 0; b--) bits.push((best >>> b) & 1);
  }
  const parsed = unframe(bitsToBytes(bits));
  return { payload: parsed.payload, ok: !!parsed.payload, confidence: totalConfidence / Math.max(1, count), errors: parsed.error ? [parsed.error] : [] };
}
