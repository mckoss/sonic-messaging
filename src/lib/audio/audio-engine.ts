import type {
  AudioEngineState, CaptureWorkletMessage, DspWorkerRequest, DspWorkerResponse,
  PlaybackWorkletMessage, SpectrumOptions
} from './contracts';
import type { FskDetectorOptions } from './contracts';
import { validateMetadata, type Recording } from './recording';
import type { ExperimentPlan, ExperimentReport } from '../experiment';

export interface AudioEngineOptions {
  constraints?: MediaTrackConstraints;
  spectrum?: Partial<SpectrumOptions>;
}

export type SpectrumListener = (event: Extract<DspWorkerResponse, { type: 'spectrum' }>) => void;
export type SymbolListener = (event: Extract<DspWorkerResponse, { type: 'symbol-scores' }>) => void;
export type PacketListener = (event: Extract<DspWorkerResponse, { type: 'packet' }>) => void;
export type ReceptionListener = (event: Extract<DspWorkerResponse, { type: 'fsk-reception' }>) => void;
export type CaptureGapListener = (event: Extract<DspWorkerResponse, { type: 'capture-gap' }>) => void;
export type SymbolBackfillListener = (event: Extract<DspWorkerResponse, { type: 'symbol-backfill' }>) => void;
export type StateListener = (state: Readonly<AudioEngineState>) => void;
export type WorkerHealthListener = (event: { healthy: boolean; reason?: string }) => void;

/** Listening with no worker output for this long is reported as a stalled/dead worker. */
const WORKER_STALL_ERROR_MS = 5_000;
/**
 * Maximum seconds the DSP worker may lag behind posted capture before further
 * chunks are dropped at the source. Bounds the worker's message backlog so
 * control messages always apply within about this long, and a stalled worker
 * cannot balloon memory with queued sample buffers. Must exceed the worker's
 * baseline reporting slack (an FFT window plus a capture chunk, well under 0.2 s).
 */
const WORKER_BACKPRESSURE_SECONDS = 1;

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
  private symbolBackfillListeners = new Set<SymbolBackfillListener>();
  private stateListeners = new Set<StateListener>();
  private drainWaiters: Array<() => void> = [];
  private workerHealthListeners = new Set<WorkerHealthListener>();
  private workerHealthy = true;
  private lastWorkerMessageAt?: number;
  private healthTimer?: ReturnType<typeof setInterval>;
  /** Set on stop: the worker still serves history replay but is replaced on the next listen. */
  private staleWorker = false;
  /** Backpressure accounting: samples posted to vs. processed by the current worker. */
  private postedSamples = 0;
  private processedSamples = 0;
  private droppedSamples = 0;
  private audioRequests = new Map<string, (data: { samples: Float32Array; sampleRate: number }) => void>();
  private lastAnalysisAt?: number;
  private options: AudioEngineOptions;
  private captureListeners = new Set<(event: Extract<CaptureWorkletMessage, { type: 'samples' }>) => void>();
  private replayGeneration = 0;
  private replayAck?: { sequence: number; resolve: () => void; reject: (error: Error) => void };
  private experimentListeners = new Set<(report: ExperimentReport) => void>();
  private experimentConfigured = false;
  private experimentFinish?: (report: ExperimentReport) => void;
  private playbackClears = new Map<string, () => void>();
  private stateValue: AudioEngineState = {
    supported: AudioEngine.isSupported(), running: false, listening: false, transmitting: false
  };

  constructor(options: AudioEngineOptions = {}) { this.options = options; }

  static isSupported(): boolean {
    return typeof window !== 'undefined' && typeof AudioContext !== 'undefined' &&
      typeof navigator?.mediaDevices?.getUserMedia === 'function' && typeof Worker !== 'undefined';
  }

  get state(): Readonly<AudioEngineState> { return this.stateValue; }

  /** Synchronous observers must copy samples before ownership transfers to DSP. */
  onCapture(listener: (event: Extract<CaptureWorkletMessage, { type: 'samples' }>) => void): () => void {
    this.captureListeners.add(listener); return () => this.captureListeners.delete(listener);
  }
  onExperiment(listener: (report: ExperimentReport) => void): () => void {
    this.experimentListeners.add(listener); return () => this.experimentListeners.delete(listener);
  }
  configureExperiment(plan: ExperimentPlan, sampleRate: number): void {
    this.experimentConfigured = true;
    this.worker?.postMessage({ type: 'configure-experiment', plan, sampleRate } satisfies DspWorkerRequest);
  }
  finishExperiment(): Promise<ExperimentReport> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.experimentFinish = undefined; reject(new Error('Experiment worker timed out')); }, 10000);
      this.experimentFinish = report => { clearTimeout(timeout); this.experimentFinish = undefined; resolve(report); };
      this.worker?.postMessage({ type: 'finish-experiment' } satisfies DspWorkerRequest);
    });
  }

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

  /** Slot-aligned repaint data for the span painted before each sync lock existed. */
  onSymbolBackfill(listener: SymbolBackfillListener): () => void {
    this.symbolBackfillListeners.add(listener); return () => this.symbolBackfillListeners.delete(listener);
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
    frequencies: number[], symbolRate: number
  ): void {
    this.worker?.postMessage({ type: 'configure-detector', mode: 'FSK',
      fsk: { frequencies, symbolRate } } satisfies DspWorkerRequest);
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

  private spawnWorker(): void {
    this.experimentConfigured = false;
    this.worker?.terminate();
    this.audioRequests.forEach(resolve => resolve({ samples: new Float32Array(0), sampleRate: this.state.sampleRate ?? 48000 }));
    this.audioRequests.clear();
    this.lastAnalysisAt = undefined;
    this.postedSamples = 0; this.processedSamples = 0; this.droppedSamples = 0;
    this.setWorkerHealth(true);
    this.worker = new Worker(new URL('../../workers/dsp.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }: MessageEvent<DspWorkerResponse>) => this.handleWorker(data);
    this.worker.onerror = (event) => {
      console.error('DSP worker error:', event.message, `(${event.filename}:${event.lineno})`);
      this.setWorkerHealth(false, `worker error: ${event.message || 'unknown'}`);
      this.replayAck?.reject(new Error(event.message || 'Replay worker failed'));
    };
    this.worker.postMessage({ type: 'configure-spectrum', options: {
      fftSize: 2048, minDecibels: -110, maxDecibels: 0, ...this.options.spectrum
    } } satisfies DspWorkerRequest);
  }

  async start(): Promise<void> {
    if (this.state.running) {
      await this.context?.resume();
      // Replay reports the recording's clock; transmission uses the hardware clock.
      this.update({ sampleRate: this.context!.sampleRate });
      return;
    }
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
      this.spawnWorker();

      this.playback = new AudioWorkletNode(this.context, 'sonic-playback', { outputChannelCount: [1] });
      this.playback.port.onmessage = ({ data }: MessageEvent<PlaybackWorkletMessage>) => {
        if (data.type === 'playback-progress') this.update({ playbackSamples: data.samples });
        else if (data.type === 'playback-cleared') { this.playbackClears.get(data.requestId)?.(); this.playbackClears.delete(data.requestId); }
        else if (data.type === 'playback-drained') {
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
    this.stopReplay();
    await this.start();
    if (this.stream) return;
    // Each listen is a fresh session: replace a worker left over from a prior
    // one so its FIFO backlog of queued sample messages — behind which every
    // control message waits, replaying old audio through the decoder — and its
    // capture-history ring are both discarded. (The ring survives the stop
    // itself so scrub-back and replay keep working until the restart.)
    if (this.staleWorker) {
      this.staleWorker = false;
      this.worker?.terminate();
      this.spawnWorker();
      const sampleRate = this.context?.sampleRate ?? 48_000;
      this.audioRequests.forEach((resolve) => resolve({ samples: new Float32Array(0), sampleRate }));
      this.audioRequests.clear();
      this.lastAnalysisAt = undefined;
      this.postedSamples = 0; this.processedSamples = 0; this.droppedSamples = 0;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...DEFAULT_CONSTRAINTS, ...this.options.constraints,
          ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}) }, video: false
      });
      this.source = this.context!.createMediaStreamSource(this.stream);
      this.capture = new AudioWorkletNode(this.context!, 'sonic-capture', { numberOfOutputs: 0 });
      this.capture.port.onmessage = ({ data }: MessageEvent<CaptureWorkletMessage>) => {
        if (data.type === 'samples' && this.worker) {
          this.captureListeners.forEach(listener => listener(data));
          // Backpressure: a worker running behind real time queues sample
          // messages without bound, and every control message applies only
          // after that backlog drains. Once the worker lags by more than the
          // allowance, drop chunks at the source instead of posting them; the
          // loss is reported as a capture gap when posting resumes.
          if (this.postedSamples - this.processedSamples >
              data.sampleRate * WORKER_BACKPRESSURE_SECONDS) {
            if (this.experimentConfigured) {
              this.worker.postMessage({ type: 'finish-experiment', captureLoss: true } satisfies DspWorkerRequest);
              this.experimentConfigured = false;
            }
            this.droppedSamples += data.samples.length;
            return;
          }
          if (this.droppedSamples > 0) {
            console.warn(`DSP backpressure: dropped ${this.droppedSamples} samples while the worker lagged`);
            const gap = { type: 'capture-gap', samples: this.droppedSamples,
              sampleRate: data.sampleRate, source: 'backpressure' } as const;
            this.captureGapListeners.forEach((listener) => listener(gap));
            this.droppedSamples = 0;
          }
          this.postedSamples += data.samples.length;
          const request: DspWorkerRequest = {
            type: 'samples', samples: data.samples, sampleRate: data.sampleRate, sequence: data.sequence
          };
          this.worker.postMessage(request, [data.samples.buffer as ArrayBuffer]);
        }
      };
      this.source.connect(this.capture);
      this.update({ listening: true, inputSettings: this.stream.getAudioTracks()[0]?.getSettings() });
      this.update({ sampleRate: this.context!.sampleRate });
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

  /**
   * The DSP worker — with its 60 s capture-history ring — survives a stop, so
   * scrub-back and replay keep working; the reset happens on the next
   * startListening instead (see staleWorker there).
   */
  stopListening(): void {
    if (this.healthTimer !== undefined) { clearInterval(this.healthTimer); this.healthTimer = undefined; }
    this.setWorkerHealth(true);
    if (this.capture) this.capture.port.onmessage = null;
    this.capture?.disconnect(); this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.capture = undefined; this.source = undefined; this.stream = undefined;
    if (this.worker) this.staleWorker = true;
    this.update({ listening: false, inputSettings: undefined });
  }

  /** Queue mono PCM. The input is copied, so callers retain ownership. */
  async transmit(samples: Float32Array, gain = 1): Promise<void> {
    this.stopReplay();
    await this.start();
    if (!samples.length) return;
    this.update({ playbackSamples: 0 });
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
  /** Wait for the worklet's exact consumed-sample count before finalizing an interrupted trial log. */
  async stopTransmissionPrecisely(): Promise<void> {
    if (!this.playback) return;
    const requestId = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.playbackClears.delete(requestId); reject(new Error('Playback stop timed out')); }, 5000);
      this.playbackClears.set(requestId, () => { clearTimeout(timer); resolve(); });
      this.playback!.port.postMessage({ type: 'clear', requestId });
    });
    this.update({ transmitting: false });
    this.drainWaiters.splice(0).forEach(resolve => resolve());
  }

  /** Decode original samples without audio hardware or resampling; ack bounds the queue. */
  async replayRecording(recording: Recording, fsk: FskDetectorOptions,
    progress: (seconds: number) => void): Promise<void> {
    validateMetadata({ ...recording.metadata, fsk });
    this.stopReplay(); this.stopListening(); this.stopTransmission();
    const generation = this.replayGeneration;
    this.spawnWorker(); this.staleWorker = true;
    this.configureFskDetector(fsk.frequencies, fsk.symbolRate);
    if (recording.metadata.experiment) this.configureExperiment(recording.metadata.experiment.plan, recording.metadata.sampleRate);
    this.update({ replaying: true, sampleRate: recording.metadata.sampleRate });
    const started = performance.now();
    try {
      for (let offset = 0, sequence = 0; offset < recording.samples.length; offset += 4096, sequence++) {
        if (generation !== this.replayGeneration) return;
        const samples = recording.samples.slice(offset, offset + 4096);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Replay decoder timed out')), 10000);
          this.replayAck = { sequence,
            resolve: () => { clearTimeout(timer); resolve(); },
            reject: error => { clearTimeout(timer); reject(error); } };
          this.worker!.postMessage({ type: 'replay-samples', samples,
            sampleRate: recording.metadata.sampleRate, sequence } satisfies DspWorkerRequest, [samples.buffer]);
        });
        if (generation !== this.replayGeneration) return;
        this.replayAck = undefined;
        const seconds = Math.min(offset + 4096, recording.samples.length) / recording.metadata.sampleRate;
        progress(seconds);
        const delay = seconds * 1000 - (performance.now() - started);
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      }
      if (recording.metadata.experiment && generation === this.replayGeneration) await this.finishExperiment();
    } catch (error) {
      if (generation === this.replayGeneration) { this.worker?.terminate(); this.worker = undefined; }
      throw error;
    } finally {
      if (generation === this.replayGeneration) {
        this.replayAck = undefined;
        this.update({ replaying: false });
      }
    }
  }

  stopReplay(): void {
    this.replayGeneration++;
    this.replayAck?.resolve(); this.replayAck = undefined;
    if (this.state.replaying) {
      this.worker?.terminate(); this.worker = undefined;
      this.update({ replaying: false });
    }
  }

  private handleWorker(message: DspWorkerResponse): void {
    if (message.type === 'experiment-report') {
      this.experimentListeners.forEach(listener => listener(message.report));
      if (message.final) this.experimentFinish?.(message.report);
      return;
    }
    if (message.type === 'replay-ack') {
      if (this.replayAck?.sequence === message.sequence) this.replayAck.resolve();
      return;
    }
    this.lastWorkerMessageAt = performance.now();
    this.setWorkerHealth(true);
    // Both position-bearing streams count cumulative processed capture samples
    // (within one analysis window), which is what backpressure compares against.
    if (message.type === 'spectrum' || message.type === 'symbol-scores') {
      this.processedSamples = Math.max(this.processedSamples, message.samplePosition);
    }
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
    else if (message.type === 'symbol-backfill') this.symbolBackfillListeners.forEach((listener) => listener(message));
    else if (message.type === 'audio-data') {
      this.audioRequests.get(message.requestId)?.({ samples: message.samples, sampleRate: message.sampleRate });
      this.audioRequests.delete(message.requestId);
    }
    else if (message.type === 'worker-error') {
      console.error('DSP worker:', message.message);
      this.setWorkerHealth(false, message.message);
      this.replayAck?.reject(new Error(message.message));
    }
  }

  async dispose(): Promise<void> {
    this.stopReplay();
    // Drop the worker first so stopListening does not respawn one just to kill it.
    this.worker?.terminate(); this.worker = undefined;
    this.stopListening(); this.stopTransmission();
    this.playback?.disconnect(); this.playback = undefined;
    const context = this.context; this.context = undefined;
    if (context && context.state !== 'closed') await context.close();
    this.update({ running: false, sampleRate: undefined });
  }
}
