/// <reference lib="webworker" />
import { hannWindow, magnitudesToDecibels, realFftMagnitude } from '../lib/audio/fft';
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
let detector: { frequencies: number[]; symbolRate: number; squelchDbfs: number; confidenceThreshold: number } | undefined;
let detectorPending = new Float32Array(0);
let detectorLength = 0;
let detectorSequence = 0;
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
}

function configureDetector(mode: 'off' | 'FSK', fsk?: {
  frequencies: number[]; symbolRate: number; squelchDbfs: number; confidenceThreshold: number
}): void {
  detector = mode === 'FSK' && fsk && fsk.frequencies.length >= 2 && fsk.symbolRate > 0
    ? { frequencies: [...fsk.frequencies], symbolRate: fsk.symbolRate,
        squelchDbfs: fsk.squelchDbfs, confidenceThreshold: fsk.confidenceThreshold }
    : undefined;
  detectorPending = new Float32Array(0);
  detectorLength = 0;
  detectorSequence = 0;
  fskStreamDecoder = undefined;
  detectorSampleRate = 0;
}

function acceptDetectorSamples(samples: Float32Array, sampleRate: number): void {
  if (!detector) return;
  const samplesPerSymbol = Math.max(1, Math.round(sampleRate / detector.symbolRate));
  if (detectorPending.length !== samplesPerSymbol) {
    detectorPending = new Float32Array(samplesPerSymbol);
    detectorLength = 0;
  }
  let offset = 0;
  while (offset < samples.length) {
    const count = Math.min(samples.length - offset, samplesPerSymbol - detectorLength);
    detectorPending.set(samples.subarray(offset, offset + count), detectorLength);
    detectorLength += count;
    offset += count;
    if (detectorLength === samplesPerSymbol) {
      const result = gateFskDetection(
        detectFskSymbol(detectorPending, sampleRate, detector.frequencies),
        detector.squelchDbfs, detector.confidenceThreshold
      );
      send({ type: 'symbol-scores', mode: 'FSK', ...result, sequence: detectorSequence++ },
        [result.scores.buffer as ArrayBuffer]);
      detectorLength = 0;
    }
  }
}

function acceptSamples(samples: Float32Array, sampleRate: number, sequence: number): void {
  if (detector && detectorSampleRate !== sampleRate) {
    fskStreamDecoder = new FskStreamDecoder(
      { sampleRate, symbolRate: detector.symbolRate, frequencies: detector.frequencies },
      detector.squelchDbfs, detector.confidenceThreshold
    );
    detectorSampleRate = sampleRate;
  }
  if (fskStreamDecoder) {
    const packets = fskStreamDecoder.push(samples);
    for (const progress of fskStreamDecoder.drainProgress()) {
      send({ type: 'fsk-reception', token: progress.type, ...('byte' in progress ? { byte: progress.byte } : {}) });
    }
    for (const packet of packets) {
      send({ type: 'packet', mode: 'FSK', ...packet }, [packet.payload.buffer as ArrayBuffer]);
    }
  }
  acceptDetectorSamples(samples, sampleRate);
  let sourceOffset = 0;
  while (sourceOffset < samples.length) {
    const count = Math.min(samples.length - sourceOffset, pending.length - pendingLength);
    pending.set(samples.subarray(sourceOffset, sourceOffset + count), pendingLength);
    pendingLength += count; sourceOffset += count;
    if (pendingLength === pending.length) {
      const bins = magnitudesToDecibels(
        realFftMagnitude(hannWindow(pending)), options.minDecibels, options.maxDecibels
      );
      send({ type: 'spectrum', bins, sampleRate, fftSize: pending.length, sequence }, [bins.buffer as ArrayBuffer]);
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
      case 'reset': pendingLength = 0; pending.fill(0); detectorLength = 0; detectorPending.fill(0); fskStreamDecoder?.reset(); break;
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
