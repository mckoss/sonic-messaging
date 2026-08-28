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

export function frame(payload: Uint8Array): Uint8Array {
  if (payload.length > 0xffff) throw new RangeError('payload exceeds 65535 bytes');
  const out = new Uint8Array(SYNC.length + 2 + payload.length + 2);
  out.set(SYNC);
  out[4] = payload.length >>> 8;
  out[5] = payload.length;
  out.set(payload, 6);
  const crc = crc16(payload);
  out[out.length - 2] = crc >>> 8;
  out[out.length - 1] = crc;
  return out;
}

export function unframe(input: Uint8Array): { payload?: Uint8Array; error?: string; offset?: number } {
  outer: for (let start = 0; start <= input.length - 8; start++) {
    for (let j = 0; j < SYNC.length; j++) if (input[start + j] !== SYNC[j]) continue outer;
    const length = (input[start + 4] << 8) | input[start + 5];
    const end = start + 6 + length;
    if (end + 2 > input.length) return { error: 'truncated frame', offset: start };
    const payload = input.slice(start + 6, end);
    const expected = (input[end] << 8) | input[end + 1];
    if (crc16(payload) !== expected) return { error: 'CRC mismatch', offset: start };
    return { payload, offset: start };
  }
  return { error: 'sync not found' };
}
