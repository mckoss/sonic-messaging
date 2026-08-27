import { describe, expect, it } from 'vitest';
import { realFftMagnitude } from './fft';
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
});

function pull(ring: Float32RingBuffer, length: number): Float32Array {
  const output = new Float32Array(length);
  ring.pull(output);
  return output;
}

