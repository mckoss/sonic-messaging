import { describe, expect, it } from 'vitest';
import { crc16, frame, FRAME_TYPE, PAYLOAD_OFFSET, unframe } from './frame';

describe('packet framing', () => {
  it('round trips and rejects corruption', () => {
    const payload = new TextEncoder().encode('sonic');
    expect(unframe(frame(payload)).payload).toEqual(payload);
    const damaged = frame(payload); damaged[7] ^= 1;
    expect(unframe(damaged).error).toBe('CRC mismatch');
  });
  it('carries sender and type like a UDP header, protected by the CRC', () => {
    const payload = Uint8Array.of(1, 2, 3), framed = frame(payload, { sender: 0x9f04, type: FRAME_TYPE.control });
    expect(framed.length).toBe(payload.length + 12);
    expect([...framed.subarray(7, 10)]).toEqual([0x9f, 0x04, FRAME_TYPE.control]);
    expect([...framed.subarray(PAYLOAD_OFFSET, PAYLOAD_OFFSET + 3)]).toEqual([1, 2, 3]);
    expect(unframe(framed)).toEqual({ payload, sender: 0x9f04, type: FRAME_TYPE.control, offset: 0 });
    for (const index of [7, 8, 9]) { const damaged = framed.slice(); damaged[index] ^= 0x10; expect(unframe(damaged).error).toBe('CRC mismatch'); }
    expect(() => frame(payload, { sender: 0x10000, type: 1 })).toThrow('address');
  });
  it('uses the standard CRC-16/CCITT check value', () => expect(crc16(new TextEncoder().encode('123456789'))).toBe(0x29b1));
});
