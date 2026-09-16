import { describe, expect, it } from 'vitest';
import { softCandidates, SOFT_MARGIN_CEILING, SOFT_PAIR_SYMBOLS, SOFT_SINGLE_SYMBOLS } from './soft-decode';

/** Per-tone scores where `decided` wins by `margin` and `runnerUp` is second. */
const window = (decided: number, runnerUp: number, margin: number, tones = 4) =>
  Float32Array.from({ length: tones }, (_, tone) =>
    tone === decided ? margin + 0.05 : tone === runnerUp ? 0.05 : 0);

describe('CRC-assisted soft decisions', () => {
  it('tries the least-confident symbol first, flipped to its runner-up', () => {
    const scores = [window(0, 1, 0.6), window(2, 3, 0.1), window(1, 0, 0.4)];
    const symbols = [0, 2, 1];
    const [first, second, third] = [...softCandidates(scores, symbols)];
    expect(first).toEqual([0, 3, 1]);
    expect(second).toEqual([0, 2, 0]);
    expect(third).toEqual([1, 2, 1]);
    // The caller's decisions are never modified in place.
    expect(symbols).toEqual([0, 2, 1]);
  });

  it('leaves confidently decoded symbols alone', () => {
    const scores = [window(0, 1, SOFT_MARGIN_CEILING + 0.1), window(2, 3, 0.2)];
    expect([...softCandidates(scores, [0, 2])]).toEqual([[0, 3]]);
  });

  it('bounds how many candidates the CRC is asked to clear', () => {
    // Every symbol is uncertain: a garbled frame must not turn into an unbounded search.
    const scores = Array.from({ length: 200 }, () => window(0, 1, 0.01));
    const symbols = Array.from({ length: 200 }, () => 0);
    const candidates = [...softCandidates(scores, symbols)];
    expect(candidates).toHaveLength(SOFT_SINGLE_SYMBOLS + (SOFT_PAIR_SYMBOLS * (SOFT_PAIR_SYMBOLS - 1)) / 2);
    expect(candidates.every(candidate => candidate.length === 200)).toBe(true);
    // Pairs change exactly two symbols; singles exactly one.
    const changed = candidates.map(c => c.filter((tone, i) => tone !== symbols[i]).length);
    expect(changed.slice(0, SOFT_SINGLE_SYMBOLS).every(n => n === 1)).toBe(true);
    expect(changed.slice(SOFT_SINGLE_SYMBOLS).every(n => n === 2)).toBe(true);
  });

  it('yields nothing when there is no alternative tone to try', () => {
    expect([...softCandidates([Float32Array.of(1)], [0])]).toEqual([]);
  });
});
