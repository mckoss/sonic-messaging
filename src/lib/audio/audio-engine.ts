import type {
  AudioEngineState, CaptureWorkletMessage, DspWorkerRequest, DspWorkerResponse,
  PlaybackWorkletMessage, SpectrumOptions
} from './contracts';

export interface AudioEngineOptions {
  constraints?: MediaTrackConstraints;
  spectrum?: Partial<SpectrumOptions>;
}

export type SpectrumListener = (event: Extract<DspWorkerResponse, { type: 'spectrum' }>) => void;
export type SymbolListener = (event: Extract<DspWorkerResponse, { type: 'symbol-scores' }>) => void;
export type PacketListener = (event: Extract<DspWorkerResponse, { type: 'packet' }>) => void;
export type ReceptionListener = (event: Extract<DspWorkerResponse, { type: 'fsk-reception' }>) => void;
export type CaptureGapListener = (event: Extract<DspWorkerResponse, { type: 'capture-gap' }>) => void;
export type StateListener = (state: Readonly<AudioEngineState>) => void;
export type WorkerHealthListener = (event: { healthy: boolean; reason?: string }) => void;

/** Listening with no worker output for this long is reported as a stalled/dead worker. */
const WORKER_STALL_ERROR_MS = 5_000;

const DEFAULT_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: { ideal: 1 }, echoCancellation: { ideal: false },
  noiseSuppression: { ideal: false }, autoGainControl: { ideal: false }
};

/** Owns browser audio resources. Call start() from a user gesture, and dispose() when finished. */
export class AudioEngine {
  private context?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private capture?: AudioWorkletNode;
  private playback?: AudioWorkletNode;
  private worker?: Worker;
  private spectrumListeners = new Set<SpectrumListener>();
  private symbolListeners = new Set<SymbolListener>();
  private packetListeners = new Set<PacketListener>();
  private receptionListeners = new Set<ReceptionListener>();
  private captureGapListeners = new Set<CaptureGapListener>();
  private stateListeners = new Set<StateListener>();
  private drainWaiters: Array<() => void> = [];
  private workerHealthListeners = new Set<WorkerHealthListener>();
  private workerHealthy = true;
  private lastWorkerMessageAt?: number;
  private healthTimer?: ReturnType<typeof setInterval>;
  private audioRequests = new Map<string, (data: { samples: Float32Array; sampleRate: number }) => void>();
  private lastAnalysisAt?: number;
  private options: AudioEngineOptions;
  private stateValue: AudioEngineState = {
    supported: AudioEngine.isSupported(), running: false, listening: false, transmitting: false
  };

  constructor(options: AudioEngineOptions = {}) { this.options = options; }

  static isSupported(): boolean {
    return typeof window !== 'undefined' && typeof AudioContext !== 'undefined' &&
      typeof navigator?.mediaDevices?.getUserMedia === 'function' && typeof Worker !== 'undefined';
  }

  get state(): Readonly<AudioEngineState> { return this.stateValue; }

  onSpectrum(listener: SpectrumListener): () => void {
    this.spectrumListeners.add(listener); return () => this.spectrumListeners.delete(listener);
  }

  onSymbols(listener: SymbolListener): () => void {
    this.symbolListeners.add(listener); return () => this.symbolListeners.delete(listener);
  }

  onPackets(listener: PacketListener): () => void {
    this.packetListeners.add(listener); return () => this.packetListeners.delete(listener);
  }

  onReception(listener: ReceptionListener): () => void {
    this.receptionListeners.add(listener); return () => this.receptionListeners.delete(listener);
  }

  onCaptureGaps(listener: CaptureGapListener): () => void {
    this.captureGapListeners.add(listener); return () => this.captureGapListeners.delete(listener);
  }

  /** Notifies on transitions between a responsive and a stalled/errored DSP worker. */
  onWorkerHealth(listener: WorkerHealthListener): () => void {
    this.workerHealthListeners.add(listener); return () => this.workerHealthListeners.delete(listener);
  }

  private setWorkerHealth(healthy: boolean, reason?: string): void {
    if (healthy === this.workerHealthy) return;
    this.workerHealthy = healthy;
    if (!healthy) console.error(`DSP worker unhealthy: ${reason}`);
    else console.info('DSP worker recovered');
    this.workerHealthListeners.forEach((listener) => listener({ healthy, reason }));
  }

  /** Fetches captured audio between two absolute sample positions from the worker's history ring. */
  requestCapturedAudio(from: number, to: number, mode: 'raw' | 'fft'): Promise<{ samples: Float32Array; sampleRate: number }> {
    if (!this.worker) return Promise.resolve({ samples: new Float32Array(0), sampleRate: 48_000 });
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.audioRequests.delete(requestId);
        reject(new Error('Timed out fetching captured audio from the DSP worker'));
      }, 10_000);
      this.audioRequests.set(requestId, data => { clearTimeout(timer); resolve(data); });
      this.worker!.postMessage({ type: 'audio-request', requestId, from, to, mode } satisfies DspWorkerRequest);
    });
  }

  configureFskDetector(
    frequencies: number[], symbolRate: number, squelchDbfs: number
  ): void {
    this.worker?.postMessage({ type: 'configure-detector', mode: 'FSK',
      fsk: { frequencies, symbolRate, squelchDbfs } } satisfies DspWorkerRequest);
    this.lastAnalysisAt = undefined;
  }

  disableDetector(): void {
    this.worker?.postMessage({ type: 'configure-detector', mode: 'off' } satisfies DspWorkerRequest);
    this.lastAnalysisAt = undefined;
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener); listener(this.state); return () => this.stateListeners.delete(listener);
  }

  private update(patch: Partial<AudioEngineState>): void {
    this.stateValue = { ...this.stateValue, ...patch };
    this.stateListeners.forEach((listener) => listener(this.stateValue));
  }

  async start(): Promise<void> {
    if (this.state.running) { await this.context?.resume(); return; }
    if (!AudioEngine.isSupported()) throw new Error('This browser does not support microphone AudioWorklets');
    if (!window.isSecureContext && location.hostname !== 'localhost') {
      throw new Error('Microphone access requires HTTPS (or localhost)');
    }
    try {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      if (!this.context.audioWorklet) throw new Error('AudioWorklet is unavailable in this browser');
      const workletBase = `${import.meta.env.BASE_URL}worklets/`;
      await Promise.all([
        this.context.audioWorklet.addModule(`${workletBase}capture.worklet.js`),
        this.context.audioWorklet.addModule(`${workletBase}playback.worklet.js`)
      ]);
      this.worker = new Worker(new URL('../../workers/dsp.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }: MessageEvent<DspWorkerResponse>) => this.handleWorker(data);
      this.worker.onerror = (event) => {
        console.error('DSP worker error:', event.message, `(${event.filename}:${event.lineno})`);
        this.setWorkerHealth(false, `worker error: ${event.message || 'unknown'}`);
      };
      this.worker.postMessage({ type: 'configure-spectrum', options: {
        fftSize: 2048, minDecibels: -110, maxDecibels: 0, ...this.options.spectrum
      } } satisfies DspWorkerRequest);

      this.playback = new AudioWorkletNode(this.context, 'sonic-playback', { outputChannelCount: [1] });
      this.playback.port.onmessage = ({ data }: MessageEvent<PlaybackWorkletMessage>) => {
        if (data.type === 'playback-drained') {
          this.update({ transmitting: false });
          this.drainWaiters.splice(0).forEach((resolve) => resolve());
        }
      };
      this.playback.connect(this.context.destination);
      await this.context.resume();
      this.update({ running: true, sampleRate: this.context.sampleRate });
    } catch (error) {
      await this.dispose();
      throw new Error(`Unable to start audio: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async startListening(deviceId?: string): Promise<void> {
    await this.start();
    if (this.stream) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...DEFAULT_CONSTRAINTS, ...this.options.constraints,
          ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}) }, video: false
      });
      this.source = this.context!.createMediaStreamSource(this.stream);
      this.capture = new AudioWorkletNode(this.context!, 'sonic-capture', { numberOfOutputs: 0 });
      this.capture.port.onmessage = ({ data }: MessageEvent<CaptureWorkletMessage>) => {
        if (data.type === 'samples' && this.worker) {
          const request: DspWorkerRequest = {
            type: 'samples', samples: data.samples, sampleRate: data.sampleRate, sequence: data.sequence
          };
          this.worker.postMessage(request, [data.samples.buffer as ArrayBuffer]);
        }
      };
      this.source.connect(this.capture);
      this.update({ listening: true, inputSettings: this.stream.getAudioTracks()[0]?.getSettings() });
      this.lastWorkerMessageAt = performance.now();
      this.healthTimer = setInterval(() => {
        const elapsed = performance.now() - (this.lastWorkerMessageAt ?? 0);
        if (elapsed > WORKER_STALL_ERROR_MS) {
          this.setWorkerHealth(false, `no DSP output for ${Math.round(elapsed / 1000)} s`);
        }
      }, 1_000);
    } catch (error) {
      this.stopListening();
      throw new Error(`Unable to access microphone: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async listInputDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    return (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput');
  }

  stopListening(): void {
    if (this.healthTimer !== undefined) { clearInterval(this.healthTimer); this.healthTimer = undefined; }
    this.setWorkerHealth(true);
    this.capture?.disconnect(); this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.capture = undefined; this.source = undefined; this.stream = undefined;
    this.update({ listening: false, inputSettings: undefined });
  }

  /** Queue mono PCM. The input is copied, so callers retain ownership. */
  async transmit(samples: Float32Array, gain = 1): Promise<void> {
    await this.start();
    if (!samples.length) return;
    const copy = samples.slice();
    this.playback!.port.postMessage({ type: 'set-gain', gain });
    this.playback!.port.postMessage({ type: 'enqueue', samples: copy }, [copy.buffer]);
    this.update({ transmitting: true });
  }

  waitForPlayback(): Promise<void> {
    if (!this.state.transmitting) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  stopTransmission(): void {
    this.playback?.port.postMessage({ type: 'clear' });
    this.update({ transmitting: false });
    this.drainWaiters.splice(0).forEach((resolve) => resolve());
  }

  private handleWorker(message: DspWorkerResponse): void {
    this.lastWorkerMessageAt = performance.now();
    this.setWorkerHealth(true);
    if (message.type === 'spectrum') this.spectrumListeners.forEach((listener) => listener(message));
    else if (message.type === 'symbol-scores') {
      const now = performance.now();
      if (this.lastAnalysisAt !== undefined && now - this.lastAnalysisAt > 250) {
        console.warn(`DSP worker stall: ${Math.round(now - this.lastAnalysisAt)} ms between symbol analyses`);
      }
      this.lastAnalysisAt = now;
      this.symbolListeners.forEach((listener) => listener(message));
    }
    else if (message.type === 'packet') this.packetListeners.forEach((listener) => listener(message));
    else if (message.type === 'fsk-reception') this.receptionListeners.forEach((listener) => listener(message));
    else if (message.type === 'capture-gap') this.captureGapListeners.forEach((listener) => listener(message));
    else if (message.type === 'audio-data') {
      this.audioRequests.get(message.requestId)?.({ samples: message.samples, sampleRate: message.sampleRate });
      this.audioRequests.delete(message.requestId);
    }
    else if (message.type === 'worker-error') {
      console.error('DSP worker:', message.message);
      this.setWorkerHealth(false, message.message);
    }
  }

  async dispose(): Promise<void> {
    this.stopListening(); this.stopTransmission();
    this.worker?.terminate(); this.worker = undefined;
    this.playback?.disconnect(); this.playback = undefined;
    const context = this.context; this.context = undefined;
    if (context && context.state !== 'closed') await context.close();
    this.update({ running: false, sampleRate: undefined });
  }
}
