export type TransferableSamples = Float32Array;

export type CaptureWorkletMessage =
  | { type: 'samples'; samples: TransferableSamples; sampleRate: number; sequence: number }
  | { type: 'capture-state'; active: boolean };

export type CaptureWorkletCommand =
  | { type: 'set-capture'; active: boolean };

export type PlaybackWorkletCommand =
  | { type: 'enqueue'; samples: TransferableSamples }
  | { type: 'clear' }
  | { type: 'set-gain'; gain: number };

export type PlaybackWorkletMessage =
  | { type: 'playback-drained' }
  | { type: 'playback-state'; queuedSamples: number };

export interface SpectrumOptions {
  fftSize: number;
  minDecibels?: number;
  maxDecibels?: number;
}

export interface FskDetectorOptions {
  frequencies: number[];
  symbolRate: number;
}

export type DspWorkerRequest =
  | { type: 'configure-spectrum'; options: SpectrumOptions }
  | { type: 'configure-detector'; mode: 'off' | 'FSK'; fsk?: FskDetectorOptions }
  | { type: 'samples'; samples: TransferableSamples; sampleRate: number; sequence: number }
  | { type: 'decode'; requestId: string; modem: string; command: string; payload: unknown }
  | { type: 'reset' };

export type DspWorkerResponse =
  | { type: 'spectrum'; bins: TransferableSamples; sampleRate: number; fftSize: number; sequence: number }
  | { type: 'symbol-scores'; mode: 'FSK'; scores: TransferableSamples; symbol: number; confidence: number; powerDbfs: number; sequence: number }
  | { type: 'packet'; mode: 'FSK'; payload: Uint8Array; confidence: number }
  | { type: 'decode-result'; requestId: string; modem: string; result?: unknown; error?: string }
  | { type: 'worker-error'; message: string };

export interface AudioEngineState {
  supported: boolean;
  running: boolean;
  listening: boolean;
  transmitting: boolean;
  sampleRate?: number;
  inputSettings?: MediaTrackSettings;
}
