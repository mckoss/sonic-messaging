import { describe, expect, it } from 'vitest';
import { golayDecode, golayEncode, golayRadiusForBitsPerSymbol } from './golay';

function popcount(value: number): number {
  let count = 0;
  for (let v = value; v !== 0; v &= v - 1) count++;
  return count;
}

describe('extended Golay (24,12)', () => {
  it('has minimum codeword weight 8, the distance that guarantees 3-bit correction', () => {
    let minimum = 24;
    for (let data = 1; data < 4096; data++) minimum = Math.min(minimum, popcount(golayEncode(data)));
    expect(minimum).toBe(8);
  });

  it('round-trips every 12-bit value', () => {
    for (let data = 0; data < 4096; data++) expect(golayDecode(golayEncode(data))).toBe(data);
  });

  it('corrects every 1- and 2-bit error pattern, covering one bad 4-FSK symbol', () => {
    for (const data of [0x000, 0x001, 0x5b3, 0xfff]) {
      const codeword = golayEncode(data);
      for (let a = 0; a < 24; a++) {
        expect(golayDecode(codeword ^ (1 << a))).toBe(data);
        for (let b = a + 1; b < 24; b++) {
          expect(golayDecode(codeword ^ (1 << a) ^ (1 << b))).toBe(data);
        }
      }
    }
  });

  it('detects every 3-bit error at the default radius 2, and corrects it at radius 3', () => {
    const codeword = golayEncode(0x2a5);
    for (let a = 0; a < 24; a++) {
      for (let b = a + 1; b < 24; b++) {
        for (let c = b + 1; c < 24; c++) {
          const corrupted = codeword ^ (1 << a) ^ (1 << b) ^ (1 << c);
          expect(golayDecode(corrupted)).toBeUndefined();
          expect(golayDecode(corrupted, 3)).toBe(0x2a5);
        }
      }
    }
  });

  it('sizes the radius to one corrupted symbol of each FSK order', () => {
    expect(golayRadiusForBitsPerSymbol(1)).toBe(2); // 2-FSK: two bad symbols still covered
    expect(golayRadiusForBitsPerSymbol(2)).toBe(2); // 4-FSK: one bad symbol
    expect(golayRadiusForBitsPerSymbol(3)).toBe(3); // 8-FSK: one bad symbol
    expect(golayRadiusForBitsPerSymbol(4)).toBe(3); // 16-FSK: best partial cover
  });

  it('detects 4- and 5-bit error patterns', () => {
    const codeword = golayEncode(0xd1e);
    let seed = 0xbeef;
    const random = () => (seed = (seed * 1_664_525 + 1_013_904_223) >>> 0) % 24;
    for (const size of [4, 5]) {
      for (let trial = 0; trial < 300; trial++) {
        const bits = new Set<number>();
        while (bits.size < size) bits.add(random());
        let corrupted = codeword;
        for (const bit of bits) corrupted ^= 1 << bit;
        expect(golayDecode(corrupted)).toBeUndefined();
      }
    }
  });
});
