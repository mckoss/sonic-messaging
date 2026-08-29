import { describe, expect, it } from 'vitest';
import { dbToIntensity, estimateNoiseFloorDb, frequencyBinRange, intensityToRgb, ringSpans, waterfallPixelAdvance } from './waterfall';

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

  it('maps modem and FFT windows onto the same captured-sample time scale', () => {
    expect(waterfallPixelAdvance(480)).toBeCloseTo(0.9375);
    expect(waterfallPixelAdvance(480, 2)).toBeCloseTo(1.875);
    expect(waterfallPixelAdvance(1024)).toBe(2);
  });

  it('maps unwrapped pixel ranges onto ring-canvas spans', () => {
    expect(ringSpans(0, 100, 1000)).toEqual([{ x: 0, w: 100 }]);
    expect(ringSpans(2950, 100, 1000)).toEqual([{ x: 950, w: 50 }, { x: 0, w: 50 }]);
    expect(ringSpans(-30, 60, 1000)).toEqual([{ x: 970, w: 30 }, { x: 0, w: 30 }]);
    expect(ringSpans(5, 2000, 1000)).toEqual([{ x: 5, w: 995 }, { x: 0, w: 5 }]);
    expect(ringSpans(5, 0, 1000)).toEqual([]);
    expect(ringSpans(5, 10, 0)).toEqual([]);
  });

  it('estimates the noise floor from the background, ignoring narrowband tones', () => {
    // 90 background bins near -80 with 10 strong tone bins must report the background.
    const spectrum = new Float32Array(100).fill(-80);
    for (let bin = 40; bin < 50; bin++) spectrum[bin] = -30;
    expect(estimateNoiseFloorDb(spectrum, 0, 100)).toBe(-80);
    // Restricting the range to mostly-signal bins raises the estimate.
    expect(estimateNoiseFloorDb(spectrum, 40, 50)).toBe(-30);
  });

  it('handles out-of-range, non-finite, and empty spectra safely', () => {
    expect(estimateNoiseFloorDb(new Float32Array(0), 0, 10)).toBeUndefined();
    expect(estimateNoiseFloorDb([Number.NaN, -70, Number.POSITIVE_INFINITY], -5, 99)).toBe(-70);
    expect(estimateNoiseFloorDb([-60, -50], 2, 5)).toBeUndefined();
  });

});
