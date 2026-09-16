import { describe, expect, it } from 'vitest';
import { fskCenterFrequency, fskFrequencies, fskPlanWarnings, fskSuggestedPlan, fskToneSet, fskToneSpan } from './fsk-frequencies';

describe('FSK frequency plan', () => {
  it('places tones at fixed intervals starting at the lowest frequency', () => {
    expect(fskFrequencies(3_800, 800, 4)).toEqual([3_800, 4_600, 5_400, 6_200]);
    expect(fskToneSpan(800, 4)).toBe(2_400);
    expect(fskCenterFrequency(3_800, 800, 4)).toBe(5_000);
  });

  it('derives the center for an odd tone count', () => {
    expect(fskFrequencies(6_000, 1_000, 5)).toEqual([6_000, 7_000, 8_000, 9_000, 10_000]);
    expect(fskCenterFrequency(6_000, 1_000, 5)).toBe(8_000);
  });

  it('handles the degenerate single-tone case', () => {
    expect(fskFrequencies(2_000, 600, 1)).toEqual([2_000]);
    expect(fskToneSpan(600, 1)).toBe(0);
    expect(fskCenterFrequency(2_000, 600, 1)).toBe(2_000);
  });

  it('builds tone sets with unequal gaps, no harmonics, and every gap a multiple of the symbol rate', () => {
    expect(fskToneSet(1_500, 25, 4)).toEqual([1_500, 1_700, 2_100, 2_900]);
    expect(fskToneSet(1_500, 25, 2)).toEqual([1_500, 2_975]); // an octave apart would be a harmonic
    for (const [base, rate, count] of [[1_500, 25, 4], [500, 25, 4], [1_000, 100, 4], [1_500, 25, 8]] as const) {
      const tones = fskToneSet(base, rate, count);
      expect(tones).toHaveLength(count);
      const gaps = tones.slice(1).map((tone, index) => tone - tones[index]);
      expect(gaps.every(gap => gap % rate === 0)).toBe(true);
      expect(new Set(gaps).size).toBe(gaps.length); // unequal, so difference products miss the other tones
      expect(fskPlanWarnings(tones, rate)).toEqual([]);
    }
  });

  it('advises about non-orthogonal gaps and harmonic coincidences', () => {
    expect(fskPlanWarnings([3_800, 4_600, 5_400, 6_200], 100)).toEqual([]);
    expect(fskPlanWarnings([1_000, 2_000], 300)).toEqual([
      'Tone gaps are not integer multiples of the symbol rate; detector leakage may increase.',
      'Lowest frequency is not an integer multiple of the symbol rate; detector leakage may increase.',
      'Lowest tone completes fewer than 4 cycles per symbol; detection degrades.',
      '2,000 Hz is the 2× harmonic of 1,000 Hz.',
    ]);
  });

  it('advises about a lowest tone under the acoustic floor', () => {
    expect(fskPlanWarnings([200, 250, 300, 350], 25)).toEqual([
      'Tones below 500 Hz sit in speaker/mic rolloff and ambient rumble.',
    ]);
  });

  it('suggests a base above the acoustic floor and cycle minimum, with a clean plan', () => {
    for (const [rate, count] of [[25, 4], [30, 4], [400, 4], [400, 8]] as const) {
      const suggested = fskSuggestedPlan(rate, count)!;
      expect(suggested.lowestFrequency % rate).toBe(0);
      expect(suggested.lowestFrequency).toBeGreaterThanOrEqual(500);
      expect(fskPlanWarnings(fskToneSet(suggested.lowestFrequency, rate, count), rate)).toEqual([]);
    }
    expect(fskSuggestedPlan(0, 4)).toBeUndefined();
  });
});
