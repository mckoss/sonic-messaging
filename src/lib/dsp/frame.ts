/**
 * CCSDS attached sync marker: chosen for low aperiodic autocorrelation, so a
 * matched-filter search sees one sharp peak instead of the half-length false
 * peak a repeated pattern produces.
 */
export const SYNC_BYTES = Object.freeze([0x1a, 0xcf, 0xfc, 0x1d]) as readonly number[];

const SYNC = new Uint8Array(SYNC_BYTES);
/**
 * Sync marker of a frame whose header and body are convolutionally coded: the bitwise complement of the plain
 * marker. Complementing every bit keeps the word's autocorrelation and puts a different tone in every sync symbol,
 * so the receiver reads the framing off the sync itself and the two can never be confused for each other.
 */
export const FEC_SYNC_BYTES = Object.freeze(SYNC_BYTES.map(byte => byte ^ 0xff)) as readonly number[];
/** The coded frame's first block: length and address together, so a corrupted length is a corrected length. */
export const FEC_HEADER_BYTES = 7;

export function crc16(data: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = ((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
  }
  return crc;
}

/** Maximum payload representable by the 16-bit length field. */
export const MAX_PAYLOAD_BYTES = 0xffff;
/**
 * Frame layout, modeled on a UDP datagram:
 *   SYNC(4) + length(2) + sender(2) + sequence(2) + type(1) + payload + CRC16(2)
 * The CRC covers everything after the sync, so a corrupted length, address or type is rejected like corrupted data.
 * The length has no error correction of its own: a corrupted length loses the frame.
 */
export const LENGTH_BYTES = 2;
export const ADDRESS_BYTES = 5;
export const CRC_BYTES = 2;
export const LENGTH_OFFSET = SYNC_BYTES.length;
/** Offset of the sender field, just past the length. */
export const ADDRESS_OFFSET = LENGTH_OFFSET + LENGTH_BYTES;
export const PAYLOAD_OFFSET = ADDRESS_OFFSET + ADDRESS_BYTES;
export const FRAME_OVERHEAD_BYTES = PAYLOAD_OFFSET + CRC_BYTES;
/** Like a UDP port: tells the receiver which handler owns the payload. */
export const FRAME_TYPE = { control: 0x01, test: 0x02, message: 0x03, ack: 0x04 } as const;
export const FRAME_TYPE_NAMES: Record<number, string> = { 0x01: 'control', 0x02: 'test packet', 0x03: 'message', 0x04: 'ACK' };
/** High bit of the type byte: the sender wants an ACK frame for this one. */
export const ACK_REQUESTED = 0x80;
export interface FrameAddress {
  sender: number;
  /** Per-sender sequence number; a retransmission reuses the original. */
  seq?: number;
  type: number;
  ackRequested?: boolean;
}
/** Senders are random 16-bit device IDs, shown as 4 hex digits. */
export const senderHex = (sender: number) => sender.toString(16).toUpperCase().padStart(4, '0');
/** A frame's identity in logs, e.g. 9F04#12. */
export const frameId = (sender: number, seq: number) => `${senderHex(sender)}#${seq}`;

export function decodeFrameLength(bytes: Uint8Array, offset = LENGTH_OFFSET): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

export function frame(payload: Uint8Array, address: FrameAddress = { sender: 0, type: FRAME_TYPE.message }): Uint8Array {
  const seq = address.seq ?? 0;
  if (payload.length > MAX_PAYLOAD_BYTES) throw new RangeError('payload exceeds 65535 bytes');
  if (![address.sender, seq].every(v => Number.isInteger(v) && v >= 0 && v <= 0xffff) ||
      !(Number.isInteger(address.type) && address.type >= 0 && address.type < ACK_REQUESTED)) throw new RangeError('invalid frame address');
  const out = new Uint8Array(payload.length + FRAME_OVERHEAD_BYTES);
  out.set(SYNC);
  out[LENGTH_OFFSET] = payload.length >>> 8;
  out[LENGTH_OFFSET + 1] = payload.length & 0xff;
  out[ADDRESS_OFFSET] = address.sender >>> 8;
  out[ADDRESS_OFFSET + 1] = address.sender & 0xff;
  out[ADDRESS_OFFSET + 2] = seq >>> 8;
  out[ADDRESS_OFFSET + 3] = seq & 0xff;
  out[ADDRESS_OFFSET + 4] = address.type | (address.ackRequested ? ACK_REQUESTED : 0);
  out.set(payload, PAYLOAD_OFFSET);
  const crc = crc16(out.subarray(LENGTH_OFFSET, out.length - CRC_BYTES));
  out[out.length - 2] = crc >>> 8;
  out[out.length - 1] = crc;
  return out;
}

/** Sender, sequence and type from the address bytes (not yet CRC-verified). */
export function readFrameAddress(bytes: Uint8Array, offset = ADDRESS_OFFSET): Required<FrameAddress> {
  const typeByte = bytes[offset + 4];
  return { sender: (bytes[offset] << 8) | bytes[offset + 1], seq: (bytes[offset + 2] << 8) | bytes[offset + 3],
    type: typeByte & ~ACK_REQUESTED, ackRequested: (typeByte & ACK_REQUESTED) !== 0 };
}

export function unframe(input: Uint8Array): { payload?: Uint8Array; sender?: number; seq?: number; type?: number; ackRequested?: boolean; error?: string; offset?: number } {
  outer: for (let start = 0; start <= input.length - FRAME_OVERHEAD_BYTES; start++) {
    for (let j = 0; j < SYNC.length; j++) if (input[start + j] !== SYNC[j]) continue outer;
    const end = start + PAYLOAD_OFFSET + decodeFrameLength(input, start + LENGTH_OFFSET);
    if (end + CRC_BYTES > input.length) return { error: 'truncated frame', offset: start };
    const expected = (input[end] << 8) | input[end + 1];
    if (crc16(input.subarray(start + LENGTH_OFFSET, end)) !== expected) return { error: 'CRC mismatch', offset: start };
    return { payload: input.slice(start + PAYLOAD_OFFSET, end), ...readFrameAddress(input, start + ADDRESS_OFFSET), offset: start };
  }
  return { error: 'sync not found' };
}

/** ACK frame payload: the confirmed frame's sender and sequence number. */
export const ACK_PAYLOAD_BYTES = 4;
export const encodeAck = (sender: number, seq: number) => Uint8Array.of(sender >>> 8, sender & 0xff, seq >>> 8, seq & 0xff);
export function decodeAck(payload: Uint8Array): { sender: number; seq: number } | undefined {
  if (payload.length !== 4) return;
  return { sender: (payload[0] << 8) | payload[1], seq: (payload[2] << 8) | payload[3] };
}
