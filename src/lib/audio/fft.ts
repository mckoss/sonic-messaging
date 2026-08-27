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
  const real = Float64Array.from(input);
  const imag = new Float64Array(n);

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = -2 * Math.PI / size;
    const stepR = Math.cos(angle), stepI = Math.sin(angle);
    for (let offset = 0; offset < n; offset += size) {
      let wr = 1, wi = 0;
      for (let j = 0; j < size / 2; j++) {
        const even = offset + j, odd = even + size / 2;
        const tr = wr * real[odd] - wi * imag[odd];
        const ti = wr * imag[odd] + wi * real[odd];
        real[odd] = real[even] - tr; imag[odd] = imag[even] - ti;
        real[even] += tr; imag[even] += ti;
        const nextWr = wr * stepR - wi * stepI;
        wi = wr * stepI + wi * stepR; wr = nextWr;
      }
    }
  }
  const result = new Float32Array(n / 2 + 1);
  for (let i = 0; i < result.length; i++) result[i] = (2 / n) * Math.hypot(real[i], imag[i]);
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

