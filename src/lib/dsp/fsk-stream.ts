import { bitsToBytes } from './bits';
import { unframe } from './frame';
import { detectFskSymbol } from './fsk-detector';
import type { FskConfig } from './types';

const SYNC = [0xd3, 0x91, 0xd3, 0x91];
const HEADER_BYTES = 6;
const TRAILER_BYTES = 2;

export interface FskStreamPacket {
  payload: Uint8Array;
  confidence: number;
}

/** Acquires framed FSK packets in an arbitrarily chunked continuous sample stream. */
export class FskStreamDecoder {
  private samples = new Float32Array(0);
  private searchOffset = 0;
  private candidateOffset: number | undefined;
  private readonly samplesPerSymbol: number;
  private readonly bitsPerSymbol: number;
  private readonly phaseStep: number;

  constructor(private readonly config: FskConfig) {
    this.bitsPerSymbol = Math.log2(config.frequencies.length);
    if (!Number.isInteger(this.bitsPerSymbol) || this.bitsPerSymbol < 1) {
      throw new Error('FSK tone count must be a power of two');
    }
    this.samplesPerSymbol = Math.round(config.sampleRate / config.symbolRate);
    this.phaseStep = Math.max(1, Math.floor(this.samplesPerSymbol / 8));
  }

  push(input: Float32Array): FskStreamPacket[] {
    const joined = new Float32Array(this.samples.length + input.length);
    joined.set(this.samples); joined.set(input, this.samples.length); this.samples = joined;
    const packets: FskStreamPacket[] = [];

    while (true) {
      if (this.candidateOffset === undefined && !this.findSync()) break;
      const result = this.readCandidate();
      if (result === undefined) break;
      if (result) packets.push(result);
    }
    this.trim();
    return packets;
  }

  reset(): void {
    this.samples = new Float32Array(0); this.searchOffset = 0; this.candidateOffset = undefined;
  }

  private findSync(): boolean {
    const syncSymbols = Math.ceil((SYNC.length * 8) / this.bitsPerSymbol);
    const required = syncSymbols * this.samplesPerSymbol;
    while (this.searchOffset + required <= this.samples.length) {
      const decoded = this.decodeBytes(this.searchOffset, SYNC.length);
      if (SYNC.every((byte, index) => decoded.bytes[index] === byte)) {
        this.candidateOffset = this.searchOffset;
        return true;
      }
      this.searchOffset += this.phaseStep;
    }
    return false;
  }

  /** undefined means incomplete, null means rejected, and a value is a valid packet. */
  private readCandidate(): FskStreamPacket | null | undefined {
    const start = this.candidateOffset!;
    const headerSymbols = Math.ceil((HEADER_BYTES * 8) / this.bitsPerSymbol);
    if (start + headerSymbols * this.samplesPerSymbol > this.samples.length) return undefined;
    const header = this.decodeBytes(start, HEADER_BYTES).bytes;
    const payloadLength = (header[4] << 8) | header[5];
    const frameBytes = HEADER_BYTES + payloadLength + TRAILER_BYTES;
    const frameSymbols = Math.ceil((frameBytes * 8) / this.bitsPerSymbol);
    if (start + frameSymbols * this.samplesPerSymbol > this.samples.length) return undefined;

    const decoded = this.decodeBytes(start, frameBytes);
    const parsed = unframe(decoded.bytes);
    if (!parsed.payload) {
      this.rejectCandidate();
      return null;
    }
    const consumed = start + frameSymbols * this.samplesPerSymbol;
    this.samples = this.samples.slice(consumed);
    this.searchOffset = 0; this.candidateOffset = undefined;
    return { payload: parsed.payload, confidence: decoded.confidence };
  }

  private rejectCandidate(): void {
    this.searchOffset = this.candidateOffset! + this.phaseStep;
    this.candidateOffset = undefined;
  }

  private decodeBytes(offset: number, count: number): { bytes: Uint8Array; confidence: number } {
    const bitCount = count * 8;
    const symbolCount = Math.ceil(bitCount / this.bitsPerSymbol);
    const bits: number[] = [];
    let confidence = 0;
    for (let symbolIndex = 0; symbolIndex < symbolCount; symbolIndex++) {
      const start = offset + symbolIndex * this.samplesPerSymbol;
      const decision = detectFskSymbol(
        this.samples.subarray(start, start + this.samplesPerSymbol),
        this.config.sampleRate,
        this.config.frequencies
      );
      confidence += decision.confidence;
      for (let bit = this.bitsPerSymbol - 1; bit >= 0; bit--) {
        bits.push((decision.symbol >>> bit) & 1);
      }
    }
    return { bytes: bitsToBytes(bits).slice(0, count), confidence: confidence / Math.max(1, symbolCount) };
  }

  private trim(): void {
    if (this.candidateOffset !== undefined) {
      if (this.candidateOffset > 0) {
        this.samples = this.samples.slice(this.candidateOffset);
        this.searchOffset = 0; this.candidateOffset = 0;
      }
      return;
    }
    const retain = Math.ceil((SYNC.length * 8) / this.bitsPerSymbol) * this.samplesPerSymbol;
    const removable = Math.max(0, this.searchOffset - retain);
    if (removable > 0) {
      this.samples = this.samples.slice(removable);
      this.searchOffset -= removable;
    }
  }
}
