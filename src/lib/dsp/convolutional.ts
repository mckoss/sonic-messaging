/**
 * Rate-½, constraint-length-7 convolutional code with soft-decision Viterbi decoding.
 *
 * Generators 171 and 133 (octal): the code NASA flew on Voyager and that every satellite modem since has used,
 * because with soft decisions it buys about 5 dB. Each information bit produces two coded bits, and a 4-tone FSK
 * symbol carries exactly two bits — so on the control link one symbol is one trellis step, and the branch metric
 * is simply how unlikely the tone that step would have produced is, given what the detector measured. The decoder
 * never makes a hard symbol decision; it finds the whole-frame bit sequence the received tones make most likely.
 *
 * Blocks are terminated: K−1 = 6 zero bits flush the register so the trellis ends in state 0 and every bit,
 * including the last, is protected by the bits after it.
 */

export const CONSTRAINT = 7;
/** Zero bits appended to every block so its trellis ends in a known state. */
export const FLUSH_BITS = CONSTRAINT - 1;
const STATES = 1 << FLUSH_BITS;
const G1 = 0o171, G2 = 0o133;

const parity = (x: number): number => { x ^= x >>> 16; x ^= x >>> 8; x ^= x >>> 4; x ^= x >>> 2; x ^= x >>> 1; return x & 1; };

/** The coded pair (g1 g2, as a 2-bit number) for input `bit` in `state`; the register holds the newest bit highest. */
function output(state: number, bit: number): number {
  const register = (bit << FLUSH_BITS) | state;
  return (parity(register & G1) << 1) | parity(register & G2);
}
const nextState = (state: number, bit: number): number => (bit << (FLUSH_BITS - 1)) | (state >>> 1);

/** Trellis tables, built once: for each state and input bit, the coded pair and the next state. */
const OUTPUT: number[][] = [], NEXT: number[][] = [];
for (let state = 0; state < STATES; state++) { OUTPUT.push([output(state, 0), output(state, 1)]); NEXT.push([nextState(state, 0), nextState(state, 1)]); }

/** Coded bits for `bits` followed by FLUSH_BITS zeros: 2 × (bits.length + FLUSH_BITS) of them, g1 before g2. */
export function convolutionalEncode(bits: readonly number[]): number[] {
  const coded: number[] = [];
  let state = 0;
  for (let index = 0; index < bits.length + FLUSH_BITS; index++) {
    const bit = index < bits.length ? bits[index] & 1 : 0;
    const pair = OUTPUT[state][bit];
    coded.push(pair >>> 1, pair & 1);
    state = NEXT[state][bit];
  }
  return coded;
}

/** Steps in the trellis for a block of `infoBits` bits: one per bit, plus the flush. */
export const codedSteps = (infoBits: number): number => infoBits + FLUSH_BITS;

/**
 * Cost of each possible coded pair at one step, from the detector's four tone shares (tone index = pair): the
 * negative log of the share, normalised so the costs compare across steps. A share is never taken below a floor,
 * so one confidently wrong window cannot veto a path that every other window supports.
 */
export function toneCosts(shares: ArrayLike<number>): Float64Array {
  let total = 0;
  for (let tone = 0; tone < shares.length; tone++) total += Math.max(0, shares[tone]);
  const floor = 1e-3;
  return Float64Array.from({ length: shares.length }, (_, tone) =>
    -Math.log(Math.max(floor, total > 0 ? Math.max(0, shares[tone]) / total : 1 / shares.length)));
}

/**
 * Soft-decision Viterbi over a terminated block. `costs[step][pair]` is the cost of the trellis emitting `pair` at
 * that step (see toneCosts); there must be codedSteps(infoBits) of them. Returns the most likely `infoBits` bits and
 * the total cost of that path — the smaller, the better the received tones agreed with it.
 */
export function viterbiDecode(costs: readonly ArrayLike<number>[], infoBits: number): { bits: number[]; cost: number } {
  const steps = codedSteps(infoBits);
  if (costs.length < steps) throw new RangeError(`need ${steps} steps of costs, got ${costs.length}`);
  let metric = new Float64Array(STATES).fill(Infinity);
  metric[0] = 0;
  // Survivor per step and state: which state and bit led here.
  const fromState = new Uint8Array(steps * STATES), fromBit = new Uint8Array(steps * STATES);
  for (let step = 0; step < steps; step++) {
    const stepCosts = costs[step], next = new Float64Array(STATES).fill(Infinity);
    // After the information bits only zeros are sent, which prunes the trellis to the paths that can end in state 0.
    const inputs = step < infoBits ? 2 : 1;
    for (let state = 0; state < STATES; state++) {
      const here = metric[state];
      if (here === Infinity) continue;
      for (let bit = 0; bit < inputs; bit++) {
        const candidate = here + stepCosts[OUTPUT[state][bit]], to = NEXT[state][bit];
        if (candidate < next[to]) { next[to] = candidate; fromState[step * STATES + to] = state; fromBit[step * STATES + to] = bit; }
      }
    }
    metric = next;
  }
  const bits = new Array<number>(infoBits);
  let state = 0;
  for (let step = steps - 1; step >= 0; step--) {
    const bit = fromBit[step * STATES + state];
    if (step < infoBits) bits[step] = bit;
    state = fromState[step * STATES + state];
  }
  return { bits, cost: metric[0] };
}
