/**
 * CRC-assisted soft-decision correction.
 *
 * The detector throws away most of what it knows. It reports one tone per symbol, but it computed a score for every
 * tone, and the gap between the winner and the runner-up says how much to trust that choice. A frame that fails its
 * CRC has usually lost only its weakest symbol or two, and the tone actually sent is almost always the runner-up:
 * field recordings of the 25-baud control link show single-symbol failures in 192-symbol frames, every time at the
 * lowest-margin symbol in the frame, with the correct tone second.
 *
 * So instead of discarding the frame, re-try it: flip the least-confident symbols to their runner-up tone, weakest
 * first, and let the CRC say when the frame is right. This is Chase decoding with the CRC as the acceptance test. It
 * costs nothing on a frame that already passed, needs no redundancy on the wire, and — unlike a real error-correcting
 * code — changes no bit of the frame format, so recordings made before it still decode.
 *
 * The cost is false accepts: a 16-bit CRC clears a wrong guess about one time in 65,536, so the number of candidates
 * is kept small and deliberate. Flipping only to the runner-up (not to every other tone) holds singles to
 * SOFT_SINGLE_SYMBOLS and pairs to a handful of combinations, leaving the false-accept rate per garbled frame near
 * one in a thousand — and a control payload that survives the CRC still has to parse as a known message.
 */

/** Least-confident symbols tried one at a time. */
export const SOFT_SINGLE_SYMBOLS = 16;
/** Least-confident symbols tried two at a time; C(6,2) = 15 extra candidates. */
export const SOFT_PAIR_SYMBOLS = 6;
/**
 * Only symbols this uncertain are worth flipping. A confidently decoded symbol that is nonetheless wrong is not a
 * near-miss the runner-up would fix, and including it would only spend candidates on noise.
 */
export const SOFT_MARGIN_CEILING = 0.8;

/** A symbol's runner-up tone and how far it trailed the decision, on the detector's 0..1 score scale. */
function runnerUp(scores: ArrayLike<number>, decided: number): { tone: number; margin: number } {
  let tone = -1;
  for (let candidate = 0; candidate < scores.length; candidate++) {
    if (candidate === decided) continue;
    if (tone < 0 || scores[candidate] > scores[tone]) tone = candidate;
  }
  return { tone, margin: tone < 0 ? Infinity : scores[decided] - scores[tone] };
}

/**
 * Symbol arrays to re-check, in order of decreasing likelihood: the weakest symbol flipped to its runner-up, then the
 * next weakest, then pairs of the weakest few. The input array is never modified.
 */
export function* softCandidates(
  scores: readonly Float32Array[], symbols: readonly number[]
): Generator<number[]> {
  const weak = symbols
    .map((decided, index) => ({ index, ...runnerUp(scores[index] ?? [], decided) }))
    .filter(candidate => candidate.tone >= 0 && candidate.margin <= SOFT_MARGIN_CEILING)
    .sort((a, b) => a.margin - b.margin);
  const singles = weak.slice(0, SOFT_SINGLE_SYMBOLS);
  for (const { index, tone } of singles) {
    const flipped = symbols.slice();
    flipped[index] = tone;
    yield flipped;
  }
  const pairs = weak.slice(0, SOFT_PAIR_SYMBOLS);
  for (let first = 0; first < pairs.length; first++) {
    for (let second = first + 1; second < pairs.length; second++) {
      const flipped = symbols.slice();
      flipped[pairs[first].index] = pairs[first].tone;
      flipped[pairs[second].index] = pairs[second].tone;
      yield flipped;
    }
  }
}
