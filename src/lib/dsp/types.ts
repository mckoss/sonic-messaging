import type { FrameAddress } from './frame';

export interface DecodeResult {
  payload?: Uint8Array;
  sender?: number;
  seq?: number;
  frameType?: number;
  ok: boolean;
  confidence: number;
  errors: string[];
  metrics?: Record<string, number>;
}

export interface Waveform {
  samples: Float32Array;
  sampleRate: number;
}

export interface FskConfig {
  sampleRate: number;
  symbolRate: number;
  frequencies: number[];
  amplitude?: number;
  /**
   * Silence at the end of every symbol period, as a percentage of the period (0 = tone throughout). The tone plays
   * for the rest with raised-cosine edges, and the receiver's window covers only that part, so a reverberant room
   * has the gap to decay in before the next symbol is judged. Tone spacing must then be multiples of the *window*
   * rate, symbolRate / (1 − gap), not the symbol rate.
   */
  gapPercent?: number;
  /** Frame sender and type; defaults to sender 0000, type message. */
  address?: FrameAddress;
}

export interface CssConfig {
  sampleRate: number;
  bandwidth: number;
  centerFrequency: number;
  spreadingFactor?: number;
  samplesPerSymbol?: number;
  amplitude?: number;
  address?: FrameAddress;
}

export interface DsssConfig {
  sampleRate: number;
  chipRate: number;
  carrierFrequency: number;
  code: Int8Array;
  amplitude?: number;
  address?: FrameAddress;
}

export interface ChannelConfig {
  attenuation?: number;
  snrDb?: number;
  frequencyOffsetHz?: number;
  referenceCarrierHz?: number;
  seed?: number;
  interferers?: Array<{ waveform: Float32Array; gain?: number; offsetSamples?: number }>;
}
