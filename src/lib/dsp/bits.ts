export function bytesToBits(bytes: Uint8Array): number[] {
  const bits: number[] = [];
  for (const byte of bytes) for (let bit = 7; bit >= 0; bit--) bits.push((byte >>> bit) & 1);
  return bits;
}

export function bitsToBytes(bits: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) {
    let value = 0;
    for (let bit = 0; bit < 8; bit++) value = (value << 1) | (bits[i * 8 + bit] ? 1 : 0);
    out[i] = value;
  }
  return out;
}
