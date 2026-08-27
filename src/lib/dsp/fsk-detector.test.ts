import { describe, expect, it } from 'vitest';
import { detectFskSymbol } from './fsk-detector';

describe('FSK raw-symbol detector', () => {
  const sampleRate = 48_000, frequencies = [3800, 4600, 5400, 6200];

  function tone(frequency: number, amplitude = 0.8): Float32Array {
    return Float32Array.from({ length: 480 }, (_, i) => amplitude * Math.cos(2 * Math.PI * frequency * i / sampleRate));
  }

  it('selects the configured tone and reports a strong margin', () => {
    const result = detectFskSymbol(tone(frequencies[2]), sampleRate, frequencies);
    expect(result.symbol).toBe(2);
    expect(result.scores[2]).toBeGreaterThan(0.99);
    expect(result.confidence).toBeGreaterThan(0.99);
    expect(result.powerDbfs).toBeCloseTo(-4.95, 1);
  });

  it('shows ambiguity when two tones have equal amplitude', () => {
    const a = tone(frequencies[0], 0.4), b = tone(frequencies[1], 0.4);
    const mixed = Float32Array.from(a, (value, i) => value + b[i]);
    const result = detectFskSymbol(mixed, sampleRate, frequencies);
    expect(result.scores[0]).toBeCloseTo(result.scores[1], 4);
    expect(result.confidence).toBeLessThan(0.01);
  });
});
