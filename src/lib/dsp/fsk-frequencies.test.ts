import { describe, expect, it } from 'vitest';
import { fskCenterFrequency, fskFrequencies, fskPlanWarnings, fskToneSpan } from './fsk-frequencies';

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
    expect(fskPlanWarnings([3_850, 4_650, 5_450, 6_250], 800, 100)).toEqual([]);
    expect(fskPlanWarnings([1_000, 2_000], 1_000, 300)).toEqual([
      'Tone spacing is not an integer multiple of the symbol rate; detector leakage may increase.',
      '2,000 Hz is the 2× harmonic of 1,000 Hz.',
    ]);
  });
});
