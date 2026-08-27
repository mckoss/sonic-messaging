import { describe, expect, it } from 'vitest';
import { crc16, frame, unframe } from './frame';

describe('packet framing', () => {
  it('round trips and rejects corruption', () => {
    const payload = new TextEncoder().encode('sonic');
    expect(unframe(frame(payload)).payload).toEqual(payload);
    const damaged = frame(payload); damaged[7] ^= 1;
    expect(unframe(damaged).error).toBe('CRC mismatch');
  });
  it('uses the standard CRC-16/CCITT check value', () => expect(crc16(new TextEncoder().encode('123456789'))).toBe(0x29b1));
});
