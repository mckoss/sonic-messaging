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

export const WORKER_REQUEST_TIMEOUT_MS = 30_000;

type PendingJob = {
  resolve: (result: SimulationResult | EncodeResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class ModemLabWorker {
  private worker = new Worker(new URL('../workers/dsp.worker.ts', import.meta.url), { type: 'module' });
  private pending = new Map<string, PendingJob>();

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<DspWorkerResponse>) => {
      if (data.type === 'worker-error') {
        for (const job of this.pending.values()) {
          clearTimeout(job.timeout);
          job.reject(new Error(data.message));
        }
        this.pending.clear();
        return;
      }
      if (data.type !== 'decode-result') return;
      const job = this.pending.get(data.requestId);
      if (!job) return;
      this.pending.delete(data.requestId);
      clearTimeout(job.timeout);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data.result as SimulationResult | EncodeResult);
    };
    this.worker.onerror = (event) => {
      for (const job of this.pending.values()) {
        clearTimeout(job.timeout);
        job.reject(new Error(event.message));
      }
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
      const timeout = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        reject(new Error(`DSP worker did not respond within ${WORKER_REQUEST_TIMEOUT_MS / 1000} seconds`));
      }, WORKER_REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timeout });
      try {
        this.worker.postMessage(message);
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose(): void {
    this.worker.terminate();
    for (const job of this.pending.values()) {
      clearTimeout(job.timeout);
      job.reject(new Error('Worker disposed'));
    }
    this.pending.clear();
  }
}
