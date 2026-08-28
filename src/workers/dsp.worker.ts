/// <reference lib="webworker" />
import { hannWindow, magnitudesToDecibels, realFftMagnitude, reconstructFromMagnitudes } from '../lib/audio/fft';
import { DETECTOR_HOP_SAMPLES } from '../lib/audio/waterfall';
import type { DspWorkerRequest, DspWorkerResponse, SpectrumOptions } from '../lib/audio/contracts';
import { decodeCss, decodeDsss, decodeFsk, detectDsssUsers, encodeCss, encodeDsss, encodeFsk, fskFrequencies,
  goldCodes, mSequence, simulateChannel, smallKasamiCodes, detectFskSymbol } from '../lib/dsp';
import type { CssConfig, DecodeResult, DsssConfig, FskConfig, Waveform } from '../lib/dsp';
import { FskStreamDecoder } from '../lib/dsp/fsk-stream';
import type { EncodeResult, SimulationRequest, SimulationResult } from '../lib/modem-lab';
import { gateFskDetection } from '../lib/dsp/fsk-detector';

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
let options: SpectrumOptions = { fftSize: 2048, minDecibels: -110, maxDecibels: 0 };
let pending = new Float32Array(options.fftSize);
let pendingLength = 0;
let spectrumSequence = 0;
let spectrumSamplePosition = 0;
let detector: { frequencies: number[]; symbolRate: number; squelchDbfs: number; confidenceThreshold: number } | undefined;
let detectorWindow = new Float32Array(0);
let detectorFilled = 0;
let detectorSinceEmit = 0;
let detectorSequence = 0;
let detectorSamplePosition = 0;
let fskStreamDecoder: FskStreamDecoder | undefined;
let detectorSampleRate = 0;

function send(message: DspWorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function configure(next: SpectrumOptions): void {
  if (next.fftSize < 256 || next.fftSize > 32768 || (next.fftSize & (next.fftSize - 1))) {
    throw new RangeError('fftSize must be a power of two from 256 through 32768');
  }
  options = { minDecibels: -110, maxDecibels: 0, ...next };
  pending = new Float32Array(options.fftSize);
  pendingLength = 0;
  spectrumSequence = 0;
  spectrumSamplePosition = 0;
}

function configureDetector(mode: 'off' | 'FSK', fsk?: {
  frequencies: number[]; symbolRate: number; squelchDbfs: number; confidenceThreshold: number
}): void {
  detector = mode === 'FSK' && fsk && fsk.frequencies.length >= 2 && fsk.symbolRate > 0
    ? { frequencies: [...fsk.frequencies], symbolRate: fsk.symbolRate,
        squelchDbfs: fsk.squelchDbfs, confidenceThreshold: fsk.confidenceThreshold }
    : undefined;
  detectorWindow = new Float32Array(0);
  detectorFilled = 0;
  detectorSinceEmit = 0;
  detectorSequence = 0;
  detectorSamplePosition = 0;
  fskStreamDecoder = undefined;
  detectorSampleRate = 0;
}

function appendDetectorWindow(chunk: Float32Array): void {
  if (chunk.length >= detectorWindow.length) {
    detectorWindow.set(chunk.subarray(chunk.length - detectorWindow.length));
    detectorFilled = detectorWindow.length;
    return;
  }
  const keep = Math.min(detectorFilled, detectorWindow.length - chunk.length);
  detectorWindow.copyWithin(0, detectorFilled - keep, detectorFilled);
  detectorWindow.set(chunk, keep);
  detectorFilled = keep + chunk.length;
}

/** Analyzes a sliding symbol-length window on a fixed hop so the display scrolls smoothly. */
function acceptDetectorSamples(samples: Float32Array, sampleRate: number, chunkBase: number): void {
  if (!detector) return;
  // Positions share the capture clock so replay and history stay aligned across reconfigures.
  detectorSamplePosition = chunkBase;
  const samplesPerSymbol = Math.max(1, Math.round(sampleRate / detector.symbolRate));
  if (detectorWindow.length !== samplesPerSymbol) {
    detectorWindow = new Float32Array(samplesPerSymbol);
    detectorFilled = 0;
    detectorSinceEmit = 0;
  }
  let offset = 0;
  while (offset < samples.length) {
    const count = Math.min(samples.length - offset, DETECTOR_HOP_SAMPLES - detectorSinceEmit);
    appendDetectorWindow(samples.subarray(offset, offset + count));
    detectorSinceEmit += count;
    offset += count;
    detectorSamplePosition += count;
    if (detectorSinceEmit < DETECTOR_HOP_SAMPLES) continue;
    detectorSinceEmit = 0;
    if (detectorFilled < detectorWindow.length) continue;
    const result = gateFskDetection(
      detectFskSymbol(detectorWindow, sampleRate, detector.frequencies),
      detector.squelchDbfs, detector.confidenceThreshold
    );
    send({ type: 'symbol-scores', mode: 'FSK', ...result, sequence: detectorSequence++,
      samplePosition: detectorSamplePosition },
      [result.scores.buffer as ArrayBuffer]);
  }
}

// Retain the last minute of captured audio for scrub-position replay.
const AUDIO_HISTORY_SECONDS = 60;
let audioRing = new Float32Array(0);
let audioRingRate = 48_000;

function storeCapturedAudio(samples: Float32Array, sampleRate: number): void {
  const size = AUDIO_HISTORY_SECONDS * sampleRate;
  if (audioRing.length !== size || audioRingRate !== sampleRate) {
    audioRing = new Float32Array(size);
    audioRingRate = sampleRate;
  }
  let offset = 0;
  while (offset < samples.length) {
    const x = (captureSamples + offset) % size;
    const count = Math.min(samples.length - offset, size - x);
    audioRing.set(samples.subarray(offset, offset + count), x);
    offset += count;
  }
}

function extractCapturedAudio(fromInput: number, toInput: number, mode: 'raw' | 'fft'): Float32Array {
  const size = audioRing.length;
  if (!size) return new Float32Array(0);
  const head = captureSamples;
  const from = Math.max(Math.floor(fromInput), head - size, 0);
  const to = Math.max(from, Math.min(Math.ceil(toInput), head));
  const out = new Float32Array(to - from);
  for (let index = 0; index < out.length; ) {
    const x = (from + index) % size;
    const count = Math.min(out.length - index, size - x);
    out.set(audioRing.subarray(x, x + count), index);
    index += count;
  }
  return mode === 'fft' ? reconstructFromMagnitudes(out) : out;
}

// A microphone never delivers long runs of exact zeros; the OS/browser audio
// pipeline inserts them when capture underruns. Surface those glitches.
const CAPTURE_GAP_RUN = 256;
let captureZeroRun = 0, captureGapSamples = 0, captureSamples = 0, captureGapReported = 0;

function detectCaptureGaps(samples: Float32Array, sampleRate: number): void {
  for (let index = 0; index < samples.length; index++) {
    if (samples[index] === 0) captureZeroRun++;
    else {
      if (captureZeroRun >= CAPTURE_GAP_RUN) captureGapSamples += captureZeroRun;
      captureZeroRun = 0;
    }
  }
  captureSamples += samples.length;
  if (captureGapSamples > 0 && captureSamples - captureGapReported >= sampleRate * 2) {
    send({ type: 'capture-gap', samples: captureGapSamples, sampleRate });
    captureGapSamples = 0;
    captureGapReported = captureSamples;
  }
}

function acceptSamples(samples: Float32Array, sampleRate: number, sequence: number): void {
  const chunkBase = captureSamples;
  storeCapturedAudio(samples, sampleRate);
  detectCaptureGaps(samples, sampleRate);
  // Keep visualization responsive even when multi-phase packet acquisition is busy.
  acceptDetectorSamples(samples, sampleRate, chunkBase);
  if (detector && detectorSampleRate !== sampleRate) {
    fskStreamDecoder = new FskStreamDecoder(
      { sampleRate, symbolRate: detector.symbolRate, frequencies: detector.frequencies },
      detector.squelchDbfs, chunkBase
    );
    detectorSampleRate = sampleRate;
  }
  if (fskStreamDecoder) {
    const packets = fskStreamDecoder.push(samples);
    for (const progress of fskStreamDecoder.drainProgress()) {
      send({ type: 'fsk-reception', token: progress.type, position: progress.position,
        ...('byte' in progress ? { byte: progress.byte } : {}) });
    }
    for (const packet of packets) {
      send({ type: 'packet', mode: 'FSK', ...packet }, [packet.payload.buffer as ArrayBuffer]);
    }
  }
  let sourceOffset = 0;
  while (sourceOffset < samples.length) {
    const count = Math.min(samples.length - sourceOffset, pending.length - pendingLength);
    pending.set(samples.subarray(sourceOffset, sourceOffset + count), pendingLength);
    pendingLength += count; sourceOffset += count;
    if (pendingLength === pending.length) {
      const bins = magnitudesToDecibels(
        realFftMagnitude(hannWindow(pending)), options.minDecibels, options.maxDecibels
      );
      spectrumSamplePosition += spectrumSamplePosition === 0 ? pending.length : pending.length / 2;
      send({ type: 'spectrum', bins, sampleRate, fftSize: pending.length, sequence: spectrumSequence++,
        samplePosition: spectrumSamplePosition }, [bins.buffer as ArrayBuffer]);
      // 50% overlap improves display responsiveness without changing AudioWorklet traffic.
      pending.copyWithin(0, pending.length / 2);
      pendingLength = pending.length / 2;
    }
  }
}

function numeric(value: unknown, fallback: number): number {
  const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback;
}

function buildModem(request: SimulationRequest): {
  waveform: Waveform; decode: (samples: Float32Array) => DecodeResult;
  interferer?: Waveform; users?: DsssConfig[];
} {
  const bytes = new TextEncoder().encode(request.payload), s = request.settings, sampleRate = 48_000;
  if (request.mode === 'FSK') {
    const tones = numeric(s.tones, 4), lowest = numeric(s.lowestFrequency, 3_800);
    const frequencies = fskFrequencies(lowest, numeric(s.toneSpacing, 800), tones);
    const config: FskConfig = { sampleRate, symbolRate: numeric(s.symbolRate, 100), frequencies };
    return { waveform: encodeFsk(bytes, config), decode: samples => decodeFsk(samples, config) };
  }
  if (request.mode === 'CSS') {
    const config: CssConfig = { sampleRate, centerFrequency: numeric(s.centerFrequency, 8_000),
      bandwidth: numeric(s.bandwidth, 6_000), spreadingFactor: numeric(s.spreadingFactor, 8) };
    return { waveform: encodeCss(bytes, config), decode: samples => decodeCss(samples, config) };
  }
  const length = numeric(s.codeLength, 127), degree = Math.round(Math.log2(length + 1));
  const familyName = String(s.codeFamily ?? 'Gold');
  const codes = familyName === 'Kasami' ? smallKasamiCodes(degree) :
    familyName === 'm-sequence' ? [mSequence(degree)] : goldCodes(degree);
  const index = Math.abs(Math.trunc(numeric(s.codeIndex, 0))) % codes.length;
  const base = { sampleRate, chipRate: numeric(s.chipRate, 4_000), carrierFrequency: numeric(s.centerFrequency, 6_000) };
  const config: DsssConfig = { ...base, code: codes[index] };
  const users = codes.slice(0, Math.min(codes.length, 32)).map(code => ({ ...base, code }));
  const other = { ...base, code: codes[(index + 1) % codes.length] };
  return { waveform: encodeDsss(bytes, config), decode: samples => decodeDsss(samples, config),
    interferer: encodeDsss(new TextEncoder().encode('OTHER USER'), other), users };
}

function simulationSpectrum(samples: Float32Array): Float32Array {
  const size = 2048, block = new Float32Array(size);
  block.set(samples.subarray(0, size));
  return magnitudesToDecibels(realFftMagnitude(hannWindow(block)), -110, 0);
}

function simulate(request: SimulationRequest): SimulationResult {
  const started = performance.now(), modem = buildModem(request);
  const interferer = request.interferer
    ? modem.interferer ?? modem.waveform
    : undefined;
  const samples = simulateChannel(modem.waveform.samples, { snrDb: request.snr, seed: 0x51ced,
    interferers: interferer ? [{ waveform: interferer.samples, gain: 10 ** (request.interfererPower / 20) }] : [] });
  const decoded = modem.decode(samples);
  return { ok: decoded.ok, decoded: decoded.payload ? new TextDecoder().decode(decoded.payload) : '',
    confidence: decoded.confidence, errors: decoded.errors, elapsedMs: performance.now() - started,
    sampleCount: samples.length, sampleRate: modem.waveform.sampleRate, spectrum: simulationSpectrum(samples),
    userScores: modem.users ? detectDsssUsers(samples, modem.users).slice(0, 5) : undefined };
}

scope.onmessage = ({ data }: MessageEvent<DspWorkerRequest>) => {
  try {
    switch (data.type) {
      case 'configure-spectrum': configure(data.options); break;
      case 'configure-detector': configureDetector(data.mode, data.fsk); break;
      case 'samples': acceptSamples(data.samples, data.sampleRate, data.sequence); break;
      case 'audio-request': {
        const samples = extractCapturedAudio(data.from, data.to, data.mode);
        send({ type: 'audio-data', requestId: data.requestId, samples, sampleRate: audioRingRate },
          [samples.buffer as ArrayBuffer]);
        break;
      }
      case 'reset': pendingLength = 0; pending.fill(0); spectrumSequence = 0; spectrumSamplePosition = 0; detectorFilled = 0; detectorSinceEmit = 0; detectorWindow.fill(0); fskStreamDecoder = undefined; detectorSampleRate = 0; break;
      case 'decode':
        if (data.command === 'simulate') {
          const result = simulate(data.payload as SimulationRequest);
          send({ type: 'decode-result', requestId: data.requestId, modem: data.modem, result },
            [result.spectrum.buffer as ArrayBuffer]);
        } else if (data.command === 'encode') {
          const request = data.payload as SimulationRequest;
          const waveform = buildModem(request).waveform;
          const result: EncodeResult = { samples: waveform.samples, sampleRate: waveform.sampleRate };
          send({ type: 'decode-result', requestId: data.requestId, modem: data.modem, result },
            [result.samples.buffer as ArrayBuffer]);
        } else {
          throw new Error(`Unknown decoder command: ${data.command}`);
        }
        break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (data.type === 'decode') {
      send({ type: 'decode-result', requestId: data.requestId, modem: data.modem, error: message });
    } else {
      send({ type: 'worker-error', message });
    }
  }
};

export {};
