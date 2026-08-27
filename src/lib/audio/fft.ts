import FFT from 'fft.js';

const plans = new Map<number, FFT>();

function fftPlan(size: number): FFT {
  let fft = plans.get(size);
  if (!fft) {
    fft = new FFT(size);
    plans.set(size, fft);
  }
  return fft;
}

export function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

export function hannWindow(input: Float32Array): Float32Array {
  const out = new Float32Array(input.length);
  const scale = input.length > 1 ? (2 * Math.PI) / (input.length - 1) : 0;
  for (let i = 0; i < input.length; i++) out[i] = input[i] * (0.5 - 0.5 * Math.cos(scale * i));
  return out;
}

/** Returns one-sided magnitudes normalized so a bin-centred full-scale sine is near 1. */
export function realFftMagnitude(input: Float32Array): Float32Array {
  const n = input.length;
  if (!isPowerOfTwo(n)) throw new RangeError('FFT size must be a power of two');
  const fft = fftPlan(n);
  const complex = fft.createComplexArray();
  fft.realTransform(complex, input);
  const result = new Float32Array(n / 2 + 1);
  for (let i = 0; i < result.length; i++) {
    result[i] = (2 / n) * Math.hypot(complex[2 * i], complex[2 * i + 1]);
  }
  result[0] *= 0.5;
  result[result.length - 1] *= 0.5;
  return result;
}

export function magnitudesToDecibels(magnitudes: Float32Array, floor = -120, ceiling = 0): Float32Array {
  const result = new Float32Array(magnitudes.length);
  for (let i = 0; i < result.length; i++) {
    const db = 20 * Math.log10(Math.max(magnitudes[i], 1e-12));
    result[i] = Math.min(ceiling, Math.max(floor, db));
  }
  return result;
}
