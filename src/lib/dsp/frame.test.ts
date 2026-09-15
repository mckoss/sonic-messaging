import { describe, expect, it } from 'vitest';
import { ACK_REQUESTED, crc16, decodeAck, encodeAck, frame, frameId, FRAME_TYPE, PAYLOAD_OFFSET, unframe } from './frame';

describe('packet framing', () => {
  it('round trips and rejects corruption', () => {
    const payload = new TextEncoder().encode('sonic');
    expect(unframe(frame(payload)).payload).toEqual(payload);
    const damaged = frame(payload); damaged[7] ^= 1;
    expect(unframe(damaged).error).toBe('CRC mismatch');
  });
  it('carries sender, sequence, type and the ACK flag like a UDP header, all covered by the CRC', () => {
    const payload = Uint8Array.of(1, 2, 3);
    const framed = frame(payload, { sender: 0x9f04, seq: 0x0102, type: FRAME_TYPE.control, ackRequested: true });
    expect(framed.length).toBe(payload.length + 13);
    expect([...framed.subarray(4, 11)]).toEqual([0x00, 0x03, 0x9f, 0x04, 0x01, 0x02, FRAME_TYPE.control | ACK_REQUESTED]);
    expect([...framed.subarray(PAYLOAD_OFFSET, PAYLOAD_OFFSET + 3)]).toEqual([1, 2, 3]);
    expect(unframe(framed)).toEqual({ payload, sender: 0x9f04, seq: 0x0102, type: FRAME_TYPE.control, ackRequested: true, offset: 0 });
    for (const index of [5, 6, 8, 10]) { const damaged = framed.slice(); damaged[index] ^= 0x01; expect(unframe(damaged).error).not.toBeUndefined(); }
    expect(unframe(frame(payload, { sender: 1, type: FRAME_TYPE.message }))).toMatchObject({ seq: 0, ackRequested: false });
    expect(() => frame(payload, { sender: 0x10000, type: 1 })).toThrow('address');
    expect(() => frame(payload, { sender: 1, type: ACK_REQUESTED })).toThrow('address');
    expect(decodeAck(encodeAck(0x9f04, 0xfffe))).toEqual({ sender: 0x9f04, seq: 0xfffe });
    expect(frameId(0x9f04, 12)).toBe('9F04#12');
  });
  it('uses the standard CRC-16/CCITT check value', () => expect(crc16(new TextEncoder().encode('123456789'))).toBe(0x29b1));
});
