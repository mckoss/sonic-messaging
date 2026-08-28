import { describe, expect, it } from 'vitest';
import { fskCenterFrequency, fskFrequencies, fskPlanWarnings, fskSuggestedPlan, fskToneSpan } from './fsk-frequencies';

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

  it('advises about non-orthogonal spacing and harmonic coincidences', () => {
    expect(fskPlanWarnings([3_800, 4_600, 5_400, 6_200], 800, 100)).toEqual([]);
    expect(fskPlanWarnings([1_000, 2_000], 1_000, 300)).toEqual([
      'Tone spacing is not an integer multiple of the symbol rate; detector leakage may increase.',
      'Lowest frequency is not an integer multiple of the symbol rate; detector leakage may increase.',
      'Lowest tone completes fewer than 4 cycles per symbol; detection degrades.',
      '2,000 Hz is the 2× harmonic of 1,000 Hz.',
    ]);
  });

  it('advises about a lowest tone under the acoustic floor', () => {
    expect(fskPlanWarnings([200, 250, 300, 350], 50, 25)).toEqual([
      'Tones below 500 Hz sit in speaker/mic rolloff and ambient rumble.',
    ]);
  });

  it('suggests an orthogonal plan above the acoustic floor and cycle minimum', () => {
    expect(fskSuggestedPlan(25, 4)).toEqual({ lowestFrequency: 500, toneSpacing: 50 });
    expect(fskSuggestedPlan(30, 4)).toEqual({ lowestFrequency: 510, toneSpacing: 60 });
    expect(fskSuggestedPlan(400, 4)).toEqual({ lowestFrequency: 2_800, toneSpacing: 800 });
    expect(fskSuggestedPlan(0, 4)).toBeUndefined();
  });

  it('keeps suggested plans free of harmonic coincidences within acoustic bandwidth', () => {
    const suggested = fskSuggestedPlan(400, 8)!;
    expect(suggested).toEqual({ lowestFrequency: 6_000, toneSpacing: 800 });
    const tones = fskFrequencies(suggested.lowestFrequency, suggested.toneSpacing, 8);
    expect(fskPlanWarnings(tones, suggested.toneSpacing, 400)).toEqual([]);
  });
});
