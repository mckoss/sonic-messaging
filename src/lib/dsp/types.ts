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
