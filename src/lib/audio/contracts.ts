import type { SearchSettings, CooperativeEvent } from '../experiment';
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
  | { type: 'playback-progress'; samples: number }
  | { type: 'playback-cleared'; requestId: string }
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
  | { type: 'configure-cooperative'; role: 'controller' | 'partner' | 'replay'; config?: SearchSettings; sender: number; sampleRate: number }
  | { type: 'cooperative-played'; token: number }
  | { type: 'stop-cooperative'; reason?: string }
  | { type: 'replay-samples'; samples: TransferableSamples; sampleRate: number; sequence: number }
  | { type: 'configure-spectrum'; options: SpectrumOptions }
  | { type: 'configure-detector'; mode: 'off' | 'FSK'; fsk?: FskDetectorOptions }
  | { type: 'samples'; samples: TransferableSamples; sampleRate: number; sequence: number }
  | { type: 'decode'; requestId: string; modem: string; command: string; payload: unknown }
  | { type: 'audio-request'; requestId: string; from: number; to: number; mode: 'raw' | 'fft' }
  | { type: 'reset' };

export type DspWorkerResponse =
  | { type: 'cooperative-event'; event: CooperativeEvent }
  | { type: 'cooperative-audio'; token: number; samples: TransferableSamples; sampleRate: number }
  | { type: 'replay-ack'; sequence: number }
  | { type: 'spectrum'; bins: TransferableSamples; sampleRate: number; fftSize: number; sequence: number; samplePosition: number }
  | { type: 'symbol-scores'; mode: 'FSK'; scores: TransferableSamples; symbol: number; confidence: number; powerDbfs: number; sequence: number; samplePosition: number }
  | { type: 'packet'; mode: 'FSK'; payload: Uint8Array; sender: number; seq: number; frameType: number; confidence: number }
  /**
   * Slot-aligned re-analysis of the span already painted before a sync lock
   * existed (the sync's own airtime), emitted once per acquired lock so the
   * display can repaint that region on true symbol boundaries.
   */
  | { type: 'symbol-backfill'; samplesPerSymbol: number;
      slots: Array<{ position: number; scores: number[]; confidence: number }> }
  | { type: 'fsk-reception'; token: 'sync' | 'length' | 'address' | 'byte' | 'crc-confirm' | 'crc-error';
      position: number; byte?: number; length?: number; sender?: number; seq?: number; frameType?: number }
  | { type: 'capture-gap'; samples: number; sampleRate: number;
      /**
       * Omitted for zeroed-capture gaps the worker detects; 'backpressure' for chunks the engine dropped while the
       * worker lagged; 'dropped' for the same loss seen from the worker's side, as a break in capture numbering.
       */
      source?: 'backpressure' | 'dropped' }
  | { type: 'audio-data'; requestId: string; samples: TransferableSamples; sampleRate: number }
  | { type: 'decode-result'; requestId: string; modem: string; result?: unknown; error?: string }
  | { type: 'worker-error'; message: string };

export interface AudioEngineState {
  supported: boolean;
  running: boolean;
  listening: boolean;
  transmitting: boolean;
  replaying?: boolean;
  playbackSamples?: number;
  sampleRate?: number;
  inputSettings?: MediaTrackSettings;
}
