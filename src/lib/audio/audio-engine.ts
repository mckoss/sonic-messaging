import type {
  AudioEngineState, CaptureWorkletMessage, DspWorkerRequest, DspWorkerResponse,
  PlaybackWorkletMessage, SpectrumOptions
} from './contracts';

export interface AudioEngineOptions {
  constraints?: MediaTrackConstraints;
  spectrum?: Partial<SpectrumOptions>;
}

export type SpectrumListener = (event: Extract<DspWorkerResponse, { type: 'spectrum' }>) => void;
export type StateListener = (state: Readonly<AudioEngineState>) => void;

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
  private stateListeners = new Set<StateListener>();
  private drainWaiters: Array<() => void> = [];
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
      await Promise.all([
        this.context.audioWorklet.addModule(new URL('../../worklets/capture.worklet.ts', import.meta.url)),
        this.context.audioWorklet.addModule(new URL('../../worklets/playback.worklet.ts', import.meta.url))
      ]);
      this.worker = new Worker(new URL('../../workers/dsp.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }: MessageEvent<DspWorkerResponse>) => this.handleWorker(data);
      this.worker.onerror = (event) => console.error('DSP worker error:', event.message);
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

  async startListening(): Promise<void> {
    await this.start();
    if (this.stream) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...DEFAULT_CONSTRAINTS, ...this.options.constraints }, video: false
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
    } catch (error) {
      this.stopListening();
      throw new Error(`Unable to access microphone: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  stopListening(): void {
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
    if (message.type === 'spectrum') this.spectrumListeners.forEach((listener) => listener(message));
    else if (message.type === 'worker-error') console.error('DSP worker:', message.message);
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
