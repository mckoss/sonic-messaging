import { describe, expect, it } from 'vitest';
import { dbToIntensity, frequencyBinRange, intensityToRgb, waterfallPixelAdvance } from './waterfall';

describe('waterfall mapping', () => {
  it('maps a selected frequency span to a bounded half-open bin range', () => {
    expect(frequencyBinRange(513, 48_000, 6_000, 18_000)).toEqual({ start: 128, end: 385 });
    expect(frequencyBinRange(513, 48_000, -100, 30_000)).toEqual({ start: 0, end: 513 });
  });

  it('handles reversed, empty, and invalid ranges safely', () => {
    expect(frequencyBinRange(513, 48_000, 18_000, 6_000)).toEqual({ start: 128, end: 385 });
    expect(frequencyBinRange(0, 48_000, 0, 1_000)).toEqual({ start: 0, end: 0 });
    expect(frequencyBinRange(512, 0, 0, 1_000)).toEqual({ start: 0, end: 0 });
  });

  it('clamps levels and gives quiet signals useful contrast', () => {
    expect(dbToIntensity(-120)).toBe(0);
    expect(dbToIntensity(-110)).toBe(0);
    expect(dbToIntensity(-61)).toBeCloseTo(Math.SQRT1_2);
    expect(dbToIntensity(0)).toBe(1);
    expect(dbToIntensity(Number.NaN)).toBe(0);
  });

  it('maps intensity to stable bounded colors', () => {
    expect(intensityToRgb(0)).toEqual([5, 10, 24]);
    expect(intensityToRgb(1)).toEqual([255, 250, 220]);
    expect(intensityToRgb(-1)).toEqual(intensityToRgb(0));
    expect(intensityToRgb(2)).toEqual(intensityToRgb(1));
  });

  it('maps modem windows onto the same 1024-sample waterfall time scale', () => {
    expect(waterfallPixelAdvance(480)).toBeCloseTo(0.46875);
    expect(waterfallPixelAdvance(480, 2)).toBeCloseTo(0.9375);
    expect(waterfallPixelAdvance(1024)).toBe(1);
  });
});
