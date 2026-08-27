export interface DecodeResult {
  payload?: Uint8Array;
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
}

export interface CssConfig {
  sampleRate: number;
  bandwidth: number;
  centerFrequency: number;
  spreadingFactor?: number;
  samplesPerSymbol?: number;
  amplitude?: number;
}

export interface DsssConfig {
  sampleRate: number;
  chipRate: number;
  carrierFrequency: number;
  code: Int8Array;
  amplitude?: number;
}

export interface ChannelConfig {
  attenuation?: number;
  snrDb?: number;
  frequencyOffsetHz?: number;
  referenceCarrierHz?: number;
  seed?: number;
  interferers?: Array<{ waveform: Float32Array; gain?: number; offsetSamples?: number }>;
}
