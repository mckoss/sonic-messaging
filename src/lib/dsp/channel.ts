import type { ChannelConfig } from './types';

function random(seed: number) { let state = seed >>> 0; return () => { state += 0x6d2b79f5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

export function simulateChannel(input: Float32Array, config: ChannelConfig = {}): Float32Array {
  const attenuation = config.attenuation ?? 1, rand = random(config.seed ?? 1), shifted = new Float32Array(input.length);
  const ratio = config.frequencyOffsetHz && config.referenceCarrierHz ? 1 + config.frequencyOffsetHz / config.referenceCarrierHz : 1;
  for (let i = 0; i < shifted.length; i++) { const at = i * ratio, lo = Math.floor(at), frac = at - lo; shifted[i] = attenuation * ((input[lo] ?? 0) * (1 - frac) + (input[lo + 1] ?? 0) * frac); }
  for (const item of config.interferers ?? []) { const offset = item.offsetSamples ?? 0, gain = item.gain ?? 1; for (let i = 0; i < item.waveform.length; i++) if (i + offset >= 0 && i + offset < shifted.length) shifted[i + offset] += gain * item.waveform[i]; }
  if (config.snrDb !== undefined) {
    let power = 0; for (const x of shifted) power += x * x; power /= Math.max(1, shifted.length);
    const sigma = Math.sqrt(power / 10 ** (config.snrDb / 10));
    for (let i = 0; i < shifted.length; i += 2) { const r = Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))), theta = 2 * Math.PI * rand(); shifted[i] += sigma * r * Math.cos(theta); if (i + 1 < shifted.length) shifted[i + 1] += sigma * r * Math.sin(theta); }
  }
  return shifted;
}
