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
/**
 * Frame layout, modeled on a UDP datagram:
 *   SYNC(4) + Golay(24,12) payload length(3) + sender(2) + type(1) + payload + CRC16(2)
 * The CRC covers sender, type and payload, so a corrupted address is rejected like corrupted data.
 */
export const LENGTH_BYTES = 3;
export const ADDRESS_BYTES = 3;
export const CRC_BYTES = 2;
/** Offset of the sender field, just past the length. */
export const ADDRESS_OFFSET = SYNC_BYTES.length + LENGTH_BYTES;
export const PAYLOAD_OFFSET = ADDRESS_OFFSET + ADDRESS_BYTES;
export const FRAME_OVERHEAD_BYTES = PAYLOAD_OFFSET + CRC_BYTES;
/** Like a UDP port: tells the receiver which handler owns the payload. */
export const FRAME_TYPE = { control: 0x01, test: 0x02, message: 0x03 } as const;
export const FRAME_TYPE_NAMES: Record<number, string> = { 0x01: 'control', 0x02: 'test packet', 0x03: 'message' };
export interface FrameAddress { sender: number; type: number }
/** Senders are random 16-bit device IDs, shown as 4 hex digits. */
export const senderHex = (sender: number) => sender.toString(16).toUpperCase().padStart(4, '0');

/**
 * Reads the protected length field, correcting bit errors up to the Golay
 * radius for the caller's modulation (golayRadiusForBitsPerSymbol); undefined
 * if uncorrectable.
 */
export function decodeFrameLength(bytes: Uint8Array, offset: number, radius = 2): number | undefined {
  return golayDecode((bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2], radius);
}

export function frame(payload: Uint8Array, address: FrameAddress = { sender: 0, type: FRAME_TYPE.message }): Uint8Array {
  if (payload.length > MAX_PAYLOAD_BYTES) throw new RangeError('payload exceeds 4095 bytes');
  if (!(Number.isInteger(address.sender) && address.sender >= 0 && address.sender <= 0xffff) ||
      !(Number.isInteger(address.type) && address.type >= 0 && address.type <= 0xff)) throw new RangeError('invalid frame address');
  const out = new Uint8Array(payload.length + FRAME_OVERHEAD_BYTES);
  out.set(SYNC);
  const length = golayEncode(payload.length);
  out[4] = length >>> 16;
  out[5] = length >>> 8;
  out[6] = length;
  out[ADDRESS_OFFSET] = address.sender >>> 8;
  out[ADDRESS_OFFSET + 1] = address.sender & 0xff;
  out[ADDRESS_OFFSET + 2] = address.type;
  out.set(payload, PAYLOAD_OFFSET);
  const crc = crc16(out.subarray(ADDRESS_OFFSET, out.length - CRC_BYTES));
  out[out.length - 2] = crc >>> 8;
  out[out.length - 1] = crc;
  return out;
}

/** Sender and type from the address bytes (not yet CRC-verified). */
export function readFrameAddress(bytes: Uint8Array, offset = ADDRESS_OFFSET): FrameAddress {
  return { sender: (bytes[offset] << 8) | bytes[offset + 1], type: bytes[offset + 2] };
}

/** lengthRadius: Golay correction radius for the length field, from the caller's modulation. */
export function unframe(input: Uint8Array, lengthRadius = 2): { payload?: Uint8Array; sender?: number; type?: number; error?: string; offset?: number } {
  outer: for (let start = 0; start <= input.length - FRAME_OVERHEAD_BYTES; start++) {
    for (let j = 0; j < SYNC.length; j++) if (input[start + j] !== SYNC[j]) continue outer;
    const length = decodeFrameLength(input, start + SYNC.length, lengthRadius);
    if (length === undefined) return { error: 'length field uncorrectable', offset: start };
    const end = start + PAYLOAD_OFFSET + length;
    if (end + CRC_BYTES > input.length) return { error: 'truncated frame', offset: start };
    const expected = (input[end] << 8) | input[end + 1];
    if (crc16(input.subarray(start + ADDRESS_OFFSET, end)) !== expected) return { error: 'CRC mismatch', offset: start };
    return { payload: input.slice(start + PAYLOAD_OFFSET, end), ...readFrameAddress(input, start + ADDRESS_OFFSET), offset: start };
  }
  return { error: 'sync not found' };
}
