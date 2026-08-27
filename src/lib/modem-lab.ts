import type { DspWorkerRequest, DspWorkerResponse } from './audio/contracts';

export type LabMode = 'FSK' | 'CSS' | 'DSSS';

export interface SimulationRequest {
  mode: LabMode;
  payload: string;
  settings: Record<string, unknown>;
  snr: number;
  interferer: boolean;
  interfererPower: number;
}

export interface SimulationResult {
  ok: boolean;
  decoded: string;
  confidence: number;
  errors: string[];
  elapsedMs: number;
  sampleCount: number;
  sampleRate: number;
  spectrum: Float32Array;
  userScores?: Array<{ index: number; score: number }>;
}

export interface EncodeResult { samples: Float32Array; sampleRate: number }

export class ModemLabWorker {
  private worker = new Worker(new URL('../workers/dsp.worker.ts', import.meta.url), { type: 'module' });
  private pending = new Map<string, { resolve: (result: SimulationResult) => void; reject: (error: Error) => void }>();

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<DspWorkerResponse>) => {
      if (data.type !== 'decode-result') return;
      const job = this.pending.get(data.requestId);
      if (!job) return;
      this.pending.delete(data.requestId);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data.result as SimulationResult);
    };
    this.worker.onerror = (event) => {
      for (const job of this.pending.values()) job.reject(new Error(event.message));
      this.pending.clear();
    };
  }

  simulate(request: SimulationRequest): Promise<SimulationResult> {
    return this.request('simulate', request) as Promise<SimulationResult>;
  }

  encode(request: Omit<SimulationRequest, 'snr' | 'interferer' | 'interfererPower'>): Promise<EncodeResult> {
    return this.request('encode', request) as Promise<EncodeResult>;
  }

  private request(command: 'simulate' | 'encode', request: unknown): Promise<SimulationResult | EncodeResult> {
    const requestId = crypto.randomUUID();
    const modem = (request as { mode: LabMode }).mode;
    const message: DspWorkerRequest = { type: 'decode', requestId, modem, command, payload: request };
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage(message);
    });
  }

  dispose(): void {
    this.worker.terminate();
    for (const job of this.pending.values()) job.reject(new Error('Worker disposed'));
    this.pending.clear();
  }
}
