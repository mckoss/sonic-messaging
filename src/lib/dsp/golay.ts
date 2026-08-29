/**
 * Extended binary Golay code (24,12): 12 data bits become a 24-bit codeword
 * with minimum Hamming distance 8, decoded here at radius 2 — correcting any
 * 2 bit errors and detecting all 3-, 4-, and 5-bit errors. Protects the
 * frame's length field, whose corruption would otherwise commit the stream
 * decoder to an arbitrarily long bogus frame.
 */

/** Generator polynomial of the perfect (23,12) Golay code: x^11+x^10+x^6+x^5+x^4+x^2+1. */
const GENERATOR = 0xc75;

function popcount(value: number): number {
  let count = 0;
  for (let v = value; v !== 0; v &= v - 1) count++;
  return count;
}

/** Systematic cyclic check bits: remainder of data·x^11 modulo the generator. */
function checkBits(data12: number): number {
  let register = data12 << 11;
  for (let bit = 22; bit >= 11; bit--) {
    if (register & (1 << bit)) register ^= GENERATOR << (bit - 11);
  }
  return register & 0x7ff;
}

/** Codeword layout: [data 12 | cyclic check 11 | overall parity 1], MSB first. */
export function golayEncode(data12: number): number {
  const word23 = ((data12 & 0xfff) << 11) | checkBits(data12 & 0xfff);
  return (word23 << 1) | (popcount(word23) & 1);
}

let codewords: Uint32Array | undefined;

function codewordTable(): Uint32Array {
  if (!codewords) {
    codewords = new Uint32Array(4096);
    for (let data = 0; data < 4096; data++) codewords[data] = golayEncode(data);
  }
  return codewords;
}

/**
 * Correction radius that covers one corrupted symbol of the given modulation
 * without giving up more garbage rejection than that requires: at least 2
 * (one bad 4-FSK symbol), at most the code's full radius 3 (one bad 8-FSK
 * symbol; also the best partial cover for 16-FSK's 4-bit symbols).
 */
export function golayRadiusForBitsPerSymbol(bitsPerSymbol: number): number {
  return Math.min(3, Math.max(2, bitsPerSymbol));
}

/**
 * Nearest-codeword decode over all 4096 codewords — run only once per validated
 * sync, so brute force beats table-based syndrome decoding in clarity for free.
 *
 * The radius sets the correction/rejection trade: errors within it are
 * corrected, and everything up to distance 8 − radius − 1 beyond it is
 * detected with certainty (minimum distance 8). Radius 2 corrects one bad
 * 4-FSK symbol and lets only 7% of arbitrary garbage — a false sync inside
 * payload data — "correct" to a plausible length; the full radius 3 covers
 * one bad 8-FSK symbol at 57% garbage acceptance, so callers should pass the
 * smallest radius their modulation needs (golayRadiusForBitsPerSymbol).
 * Returns the corrected 12 data bits, or undefined on detected corruption.
 */
export function golayDecode(word24: number, radius = 2): number | undefined {
  const table = codewordTable();
  const clamped = Math.max(0, Math.min(3, radius));
  for (let data = 0; data < 4096; data++) {
    if (popcount(table[data] ^ word24) <= clamped) return data;
  }
  return undefined;
}
