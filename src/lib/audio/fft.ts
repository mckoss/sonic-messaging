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

/**
 * Rebuilds audio from magnitude-only STFT frames (Griffin-Lim with deterministic
 * initial phases), so what the spectrogram displays becomes audible for comparison.
 * Uses the display's analysis parameters: Hann window, 50% overlap.
 */
export function reconstructFromMagnitudes(input: Float32Array, size = 2048, iterations = 6): Float32Array {
  if (!isPowerOfTwo(size)) throw new RangeError('FFT size must be a power of two');
  if (input.length < size) return new Float32Array(input.length);
  const hop = size / 2;
  const fft = fftPlan(size);
  const frameCount = Math.floor((input.length - size) / hop) + 1;
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));

  const scratch = new Float32Array(size);
  const spectrum = fft.createComplexArray();
  const magnitudes: Float64Array[] = [];
  for (let frame = 0; frame < frameCount; frame++) {
    for (let i = 0; i < size; i++) scratch[i] = input[frame * hop + i] * window[i];
    fft.realTransform(spectrum, scratch);
    fft.completeSpectrum(spectrum);
    const frameMagnitudes = new Float64Array(size);
    for (let bin = 0; bin < size; bin++) {
      frameMagnitudes[bin] = Math.hypot(spectrum[2 * bin], spectrum[2 * bin + 1]);
    }
    magnitudes.push(frameMagnitudes);
  }

  let seed = 0x2f6e2b1;
  const nextPhase = () => { seed = (seed * 48271) % 2147483647; return (seed / 2147483647) * 2 * Math.PI; };
  const spectra = magnitudes.map(frameMagnitudes => {
    const complex = new Float64Array(2 * size);
    for (let bin = 0; bin < size; bin++) {
      const phase = nextPhase();
      complex[2 * bin] = frameMagnitudes[bin] * Math.cos(phase);
      complex[2 * bin + 1] = frameMagnitudes[bin] * Math.sin(phase);
    }
    return complex;
  });

  const outLength = (frameCount - 1) * hop + size;
  const time = new Float64Array(outLength);
  const norm = new Float64Array(outLength);
  const complexTime = fft.createComplexArray();
  const synthesize = () => {
    time.fill(0); norm.fill(0);
    for (let frame = 0; frame < frameCount; frame++) {
      fft.inverseTransform(complexTime, spectra[frame]);
      for (let i = 0; i < size; i++) {
        time[frame * hop + i] += complexTime[2 * i] * window[i];
        norm[frame * hop + i] += window[i] * window[i];
      }
    }
    // Where window overlap coverage vanishes (signal edges), mute rather than
    // divide by a near-zero norm and blow up.
    for (let i = 0; i < outLength; i++) time[i] = norm[i] > 1e-3 ? time[i] / norm[i] : 0;
  };

  for (let iteration = 0; iteration < iterations; iteration++) {
    synthesize();
    for (let frame = 0; frame < frameCount; frame++) {
      for (let i = 0; i < size; i++) scratch[i] = time[frame * hop + i] * window[i];
      fft.realTransform(spectrum, scratch);
      fft.completeSpectrum(spectrum);
      const frameMagnitudes = magnitudes[frame];
      const complex = spectra[frame];
      for (let bin = 0; bin < size; bin++) {
        const magnitude = Math.hypot(spectrum[2 * bin], spectrum[2 * bin + 1]);
        const scale = magnitude > 1e-12 ? frameMagnitudes[bin] / magnitude : 0;
        complex[2 * bin] = spectrum[2 * bin] * scale;
        complex[2 * bin + 1] = spectrum[2 * bin + 1] * scale;
      }
    }
  }
  synthesize();
  const out = new Float32Array(input.length);
  for (let i = 0; i < Math.min(input.length, outLength); i++) out[i] = time[i];
  return out;
}

export function magnitudesToDecibels(magnitudes: Float32Array, floor = -120, ceiling = 0): Float32Array {
  const result = new Float32Array(magnitudes.length);
  for (let i = 0; i < result.length; i++) {
    const db = 20 * Math.log10(Math.max(magnitudes[i], 1e-12));
    result[i] = Math.min(ceiling, Math.max(floor, db));
  }
  return result;
}
