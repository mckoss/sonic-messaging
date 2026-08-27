import { describe, expect, it } from 'vitest';
import { dbToIntensity, frequencyBinRange, intensityToRgb, waterfallPixelAdvance, waterfallSampleDelta, waterfallSequenceSteps } from './waterfall';

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
    expect(waterfallPixelAdvance(480)).toBeCloseTo(1.875);
    expect(waterfallPixelAdvance(480, 2)).toBeCloseTo(3.75);
    expect(waterfallPixelAdvance(1024)).toBe(4);
  });

  it('keeps spectrum and symbol travel locked when UI updates are coalesced', () => {
    const spectrumSamples = waterfallSampleDelta(17_408, 2_048, 1024);
    const symbolSamples = waterfallSampleDelta(17_280, 1_920, 1920);
    const spectrumTravel = waterfallPixelAdvance(spectrumSamples);
    const symbolTravel = waterfallPixelAdvance(symbolSamples);
    expect(spectrumSamples).toBe(15_360);
    expect(symbolSamples).toBe(15_360);
    expect(symbolTravel).toBe(spectrumTravel);
    expect(waterfallSequenceSteps(0, 100)).toBe(1);
    expect(waterfallSampleDelta(1920, -1, 1920)).toBe(1920);
  });
});
