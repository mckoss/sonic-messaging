import { describe, expect, it } from 'vitest';
import { hannWindow, isPowerOfTwo, magnitudesToDecibels, realFftMagnitude } from './fft';
import { Float32RingBuffer } from './ring-buffer';

describe('Float32RingBuffer', () => {
  it('preserves order across wraparound and zero-fills underruns', () => {
    const ring = new Float32RingBuffer(4);
    ring.push([1, 2, 3]);
    expect([...pull(ring, 2)]).toEqual([1, 2]);
    ring.push([4, 5, 6]);
    expect([...pull(ring, 5)]).toEqual([3, 4, 5, 6, 0]);
  });

  it('discards the oldest samples on overflow', () => {
    const ring = new Float32RingBuffer(3);
    expect(ring.push([1, 2, 3, 4])).toBe(1);
    expect([...pull(ring, 3)]).toEqual([2, 3, 4]);
  });
});

describe('realFftMagnitude', () => {
  it('locates a bin-centred sine wave', () => {
    const size = 1024, bin = 37;
    const samples = Float32Array.from({ length: size }, (_, i) => Math.sin(2 * Math.PI * bin * i / size));
    const spectrum = realFftMagnitude(samples);
    let peak = 0;
    for (let i = 1; i < spectrum.length; i++) if (spectrum[i] > spectrum[peak]) peak = i;
    expect(peak).toBe(bin);
    expect(spectrum[bin]).toBeCloseTo(1, 4);
  });

  it('reports analytically known amplitudes for multiple tones', () => {
    const size = 2048;
    const samples = Float32Array.from({ length: size }, (_, i) =>
      0.75 * Math.sin(2 * Math.PI * 91 * i / size)
      + 0.2 * Math.cos(2 * Math.PI * 311 * i / size));
    const spectrum = realFftMagnitude(samples);

    expect(spectrum).toHaveLength(size / 2 + 1);
    expect(spectrum[91]).toBeCloseTo(0.75, 4);
    expect(spectrum[311]).toBeCloseTo(0.2, 4);
    expect(spectrum[90]).toBeLessThan(1e-5);
    expect(spectrum[312]).toBeLessThan(1e-5);
  });

  it('normalizes DC and Nyquist bins without doubling them', () => {
    const size = 256;
    const dc = realFftMagnitude(new Float32Array(size).fill(0.4));
    const nyquist = realFftMagnitude(Float32Array.from({ length: size }, (_, i) => 0.3 * (-1) ** i));

    expect(dc[0]).toBeCloseTo(0.4, 5);
    expect(nyquist[size / 2]).toBeCloseTo(0.3, 5);
  });

  it('rejects non-power-of-two input sizes', () => {
    expect(() => realFftMagnitude(new Float32Array(1000))).toThrow(RangeError);
  });
});

describe('FFT helpers', () => {
  it('recognizes powers of two', () => {
    expect(isPowerOfTwo(1024)).toBe(true);
    expect(isPowerOfTwo(1023)).toBe(false);
    expect(isPowerOfTwo(0)).toBe(false);
  });

  it('applies a Hann window with zero endpoints', () => {
    const windowed = hannWindow(new Float32Array(5).fill(1));
    expect([...windowed]).toEqual([0, 0.5, 1, 0.5, 0]);
  });

  it('converts magnitudes to bounded decibels', () => {
    const decibels = magnitudesToDecibels(Float32Array.of(1, 0.1, 0), -80, -3);
    expect([...decibels]).toEqual([-3, -20, -80]);
  });
});

function pull(ring: Float32RingBuffer, length: number): Float32Array {
  const output = new Float32Array(length);
  ring.pull(output);
  return output;
}
