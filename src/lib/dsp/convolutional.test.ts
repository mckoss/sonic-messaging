import { describe, expect, it } from 'vitest';
import { codedSteps, convolutionalEncode, FLUSH_BITS, toneCosts, viterbiDecode } from './convolutional';

/** Deterministic pseudo-random bits. */
function randomBits(count: number, seed = 7): number[] {
  let state = seed;
  return Array.from({ length: count }, () => { state = (state * 48271) % 2147483647; return state & 1; });
}
/** Tone shares that say "this tone, confidently": share 0.9 on the tone, the rest split. */
const confident = (tone: number, tones = 4): number[] => Array.from({ length: tones }, (_, k) => k === tone ? 0.9 : 0.1 / (tones - 1));
/** The tone each trellis step of a coded sequence would put on the air. */
const tones = (coded: number[]): number[] => Array.from({ length: coded.length / 2 }, (_, i) => (coded[2 * i] << 1) | coded[2 * i + 1]);

describe('rate-½ K=7 convolutional code with soft Viterbi', () => {
  it('produces two coded bits per information bit plus the flush, and decodes them back exactly', () => {
    const bits = randomBits(200);
    const coded = convolutionalEncode(bits);
    expect(coded).toHaveLength(2 * (bits.length + FLUSH_BITS));
    const costs = tones(coded).map(tone => toneCosts(confident(tone)));
    expect(costs).toHaveLength(codedSteps(bits.length));
    const decoded = viterbiDecode(costs, bits.length);
    expect(decoded.bits).toEqual(bits);
  });

  it('corrects hard symbol errors that would corrupt an uncoded frame', () => {
    const bits = randomBits(400, 3);
    const sent = tones(convolutionalEncode(bits));
    // Every eleventh symbol arrives as a confidently wrong tone: about 9% symbol errors.
    let flipped = 0;
    const costs = sent.map((tone, i) => { if (i % 11 === 5) { flipped++; return toneCosts(confident((tone + 2) % 4)); } return toneCosts(confident(tone)); });
    expect(flipped).toBeGreaterThan(30);
    expect(viterbiDecode(costs, bits.length).bits).toEqual(bits);
  });

  it('uses the soft information: near-misses cost little, so a path through them is preferred', () => {
    const bits = randomBits(300, 11);
    const sent = tones(convolutionalEncode(bits));
    // A stretch where the true tone is only the runner-up, narrowly, in every symbol — twenty consecutive hard
    // decisions wrong, far beyond what any code corrects. Soft decisions see how close each one was: the true path
    // pays a sliver per symbol, while any other legal path must take at least one tone that was nowhere close.
    const near = (tone: number) => { const shares = [0.05, 0.05, 0.05, 0.05]; shares[tone] = 0.44; shares[tone ^ 3] = 0.46; return toneCosts(shares); };
    const costs = sent.map((tone, i) => i >= 100 && i < 120 ? near(tone) : toneCosts(confident(tone)));
    expect(viterbiDecode(costs, bits.length).bits).toEqual(bits);
    // The same stretch with the runner-up information thrown away (hard decisions) does not decode.
    const hard = sent.map((tone, i) => toneCosts(confident(i >= 100 && i < 120 ? tone ^ 3 : tone)));
    expect(viterbiDecode(hard, bits.length).bits).not.toEqual(bits);
  });

  it('reports the path cost, which grows with how much the received tones disagreed with the decoded path', () => {
    const bits = randomBits(120, 5);
    const sent = tones(convolutionalEncode(bits));
    const clean = viterbiDecode(sent.map(tone => toneCosts(confident(tone))), bits.length);
    const noisy = viterbiDecode(sent.map((tone, i) => toneCosts(confident(i % 9 === 0 ? (tone + 1) % 4 : tone))), bits.length);
    expect(noisy.cost).toBeGreaterThan(clean.cost);
  });

  it('never lets one confidently wrong tone veto the path: costs are floored', () => {
    const costs = toneCosts([0, 0, 1, 0]);
    expect(Number.isFinite(costs[0])).toBe(true);
    expect(costs[2]).toBeLessThan(costs[0]);
  });
});
