import { describe, expect, it } from 'vitest';
import { detectFskSymbol, squelchFskDetection } from './fsk-detector';

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
    expect(result.symbol).toBe(-1);
    expect(result.scores[0]).toBeCloseTo(result.scores[1], 4);
    expect(result.confidence).toBeLessThan(0.01);
  });

  it('does not normalize broadband noise into a false symbol match', () => {
    let state = 0x51ced;
    const noise = Float32Array.from({ length: 480 }, () => {
      state = (1664525 * state + 1013904223) >>> 0;
      return (state / 0x1_0000_0000 - 0.5) * 1.6;
    });
    const result = detectFskSymbol(noise, sampleRate, frequencies);
    expect(result.symbol).toBe(-1);
    expect(Math.max(...result.scores)).toBeLessThan(0.05);
    expect(result.confidence).toBeLessThan(0.05);
  });

  it('penalizes a tone that occupies only part of the configured symbol window', () => {
    const partial = tone(frequencies[1]);
    partial.fill(0, partial.length / 2);
    const result = detectFskSymbol(partial, sampleRate, frequencies);
    expect(result.symbol).toBe(1);
    expect(result.scores[1]).toBeCloseTo(0.5, 1);
    expect(result.confidence).toBeLessThan(0.55);
  });

  it('squelches a valid tone below the configured dBFS floor', () => {
    const quiet = detectFskSymbol(tone(frequencies[0], 0.004), sampleRate, frequencies);
    expect(quiet.symbol).toBe(0);
    expect(quiet.powerDbfs).toBeLessThan(-45);
    const result = squelchFskDetection(quiet, -45);
    expect(result.symbol).toBe(-1);
    expect(result.confidence).toBe(0);
    expect([...result.scores]).toEqual([0, 0, 0, 0]);
  });

});
