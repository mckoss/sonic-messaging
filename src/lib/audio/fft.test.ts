import { expect, it } from 'vitest';
import { hannWindow, realFftMagnitude, reconstructFromMagnitudes } from './fft';

it('preserves the dominant tone when rebuilding audio from magnitudes', () => {
  const sampleRate = 48_000;
  const input = Float32Array.from({ length: sampleRate / 2 },
    (_, i) => 0.5 * Math.sin(2 * Math.PI * 1500 * i / sampleRate));
  const out = reconstructFromMagnitudes(input);
  expect(out.length).toBe(input.length);
  const magnitudes = realFftMagnitude(hannWindow(out.subarray(8192, 8192 + 2048)));
  let peak = 0;
  for (let bin = 1; bin < magnitudes.length; bin++) if (magnitudes[bin] > magnitudes[peak]) peak = bin;
  expect(Math.abs(peak * sampleRate / 2048 - 1500)).toBeLessThan(50);
  const rms = Math.sqrt(out.reduce((sum, value) => sum + value * value, 0) / out.length);
  expect(rms).toBeGreaterThan(0.1);
  expect(rms).toBeLessThan(1);
});
