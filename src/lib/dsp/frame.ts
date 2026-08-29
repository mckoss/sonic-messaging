import { golayDecode, golayEncode } from './golay';

/**
 * CCSDS attached sync marker: chosen for low aperiodic autocorrelation, so a
 * matched-filter search sees one sharp peak instead of the half-length false
 * peak a repeated pattern produces.
 */
export const SYNC_BYTES = Object.freeze([0x1a, 0xcf, 0xfc, 0x1d]) as readonly number[];

const SYNC = new Uint8Array(SYNC_BYTES);

export function crc16(data: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = ((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
  }
  return crc;
}

/** Maximum payload representable by the Golay-protected 12-bit length field. */
export const MAX_PAYLOAD_BYTES = 0xfff;
/** Frame layout: SYNC(4) + Golay(24,12) length(3) + payload + CRC16(2). */
export const LENGTH_BYTES = 3;

/** Reads the protected length field, correcting up to 2 bit errors; undefined if uncorrectable. */
export function decodeFrameLength(bytes: Uint8Array, offset: number): number | undefined {
  return golayDecode((bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]);
}

export function frame(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_PAYLOAD_BYTES) throw new RangeError('payload exceeds 4095 bytes');
  const out = new Uint8Array(SYNC.length + LENGTH_BYTES + payload.length + 2);
  out.set(SYNC);
  const length = golayEncode(payload.length);
  out[4] = length >>> 16;
  out[5] = length >>> 8;
  out[6] = length;
  out.set(payload, 7);
  const crc = crc16(payload);
  out[out.length - 2] = crc >>> 8;
  out[out.length - 1] = crc;
  return out;
}

export function unframe(input: Uint8Array): { payload?: Uint8Array; error?: string; offset?: number } {
  const headerBytes = SYNC.length + LENGTH_BYTES;
  outer: for (let start = 0; start <= input.length - headerBytes - 2; start++) {
    for (let j = 0; j < SYNC.length; j++) if (input[start + j] !== SYNC[j]) continue outer;
    const length = decodeFrameLength(input, start + SYNC.length);
    if (length === undefined) return { error: 'length field uncorrectable', offset: start };
    const end = start + headerBytes + length;
    if (end + 2 > input.length) return { error: 'truncated frame', offset: start };
    const payload = input.slice(start + headerBytes, end);
    const expected = (input[end] << 8) | input[end + 1];
    if (crc16(payload) !== expected) return { error: 'CRC mismatch', offset: start };
    return { payload, offset: start };
  }
  return { error: 'sync not found' };
}
