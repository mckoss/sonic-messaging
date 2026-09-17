import { bitsToBytes, bytesToBits } from './bits';
import { FEC_HEADER_BYTES, FEC_SYNC_BYTES, frame, SYNC_BYTES, unframe } from './frame';
import { codedSteps, convolutionalEncode, toneCosts, viterbiDecode } from './convolutional';
import type { DecodeResult, FskConfig, Waveform } from './types';

function validate(config: FskConfig) {
  const bits = Math.log2(config.frequencies.length);
  if (!Number.isInteger(bits) || bits < 1) throw new Error('FSK tone count must be a power of two');
  const n = Math.round(config.sampleRate / config.symbolRate);
  if (n < 4) throw new Error('symbol rate is too high');
  return { bits, n };
}

/** Longest silence gap: below a quarter of the period on, a symbol carries too little energy to judge. */
export const MAX_GAP_PERCENT = 75;
/** Raised-cosine edge on a gated tone; a hard gate to silence clicks across the whole band. */
const RAMP_SECONDS = 0.002;

/** Samples of each symbol period the tone actually occupies. */
export function fskToneSamples(config: FskConfig): number {
  const n = Math.round(config.sampleRate / config.symbolRate);
  const gap = Math.min(MAX_GAP_PERCENT, Math.max(0, config.gapPercent ?? 0));
  return gap ? Math.max(4, Math.round(n * (1 - gap / 100))) : n;
}

/** Amplitude envelope of a gated tone at sample `i` of its period: raised-cosine in and out, silence after `on`. */
function envelope(i: number, on: number, ramp: number): number {
  if (i >= on) return 0;
  if (!ramp) return 1;
  if (i < ramp) return 0.5 * (1 - Math.cos(Math.PI * i / ramp));
  if (i >= on - ramp) return 0.5 * (1 - Math.cos(Math.PI * (on - i) / ramp));
  return 1;
}

/**
 * The bits a framed byte sequence puts on the air. Uncoded, it is the bytes. Coded, it is the coded sync marker,
 * then the header (length + address) and the body (payload + CRC) each convolutionally encoded as its own
 * terminated block — the header first, so the receiver can size the frame from a *protected* length.
 */
export function fskFrameBits(framed: Uint8Array, fec: boolean): number[] {
  if (!fec) return bytesToBits(framed);
  const header = framed.subarray(SYNC_BYTES.length, SYNC_BYTES.length + FEC_HEADER_BYTES), body = framed.subarray(SYNC_BYTES.length + FEC_HEADER_BYTES);
  return [...bytesToBits(Uint8Array.from(FEC_SYNC_BYTES)), ...convolutionalEncode(bytesToBits(header)), ...convolutionalEncode(bytesToBits(body))];
}

/** Symbols a frame with `payloadBytes` occupies on the air: the whole basis of every air-time estimate. */
export function fskFrameSymbols(payloadBytes: number, bitsPerSymbol: number, fec = false): number {
  const overhead = SYNC_BYTES.length + FEC_HEADER_BYTES + 2;
  if (!fec) return Math.ceil((payloadBytes + overhead) * 8 / bitsPerSymbol);
  // Two coded bits per information bit, and with 2 bits per symbol one symbol per trellis step.
  const sync = Math.ceil(SYNC_BYTES.length * 8 / bitsPerSymbol);
  return sync + codedSteps(FEC_HEADER_BYTES * 8) + codedSteps((payloadBytes + 2) * 8);
}

export function encodeFsk(payload: Uint8Array, config: FskConfig): Waveform {
  const { bits: bitsPerSymbol, n } = validate(config);
  if (config.fec && bitsPerSymbol !== 2) throw new Error('coded frames need 4 tones: one symbol per trellis step');
  const bits = fskFrameBits(frame(payload, config.address), !!config.fec);
  while (bits.length % bitsPerSymbol) bits.push(0);
  const samples = new Float32Array((bits.length / bitsPerSymbol) * n);
  const amplitude = config.amplitude ?? 0.8;
  // Without a gap this is plain continuous-phase FSK, sample for sample: the envelope is one throughout.
  const on = fskToneSamples(config), ramp = on < n ? Math.min(Math.round(RAMP_SECONDS * config.sampleRate), Math.floor(on / 5)) : 0;
  let phase = 0;
  for (let s = 0; s < bits.length / bitsPerSymbol; s++) {
    let value = 0;
    for (let b = 0; b < bitsPerSymbol; b++) value = (value << 1) | bits[s * bitsPerSymbol + b];
    const step = 2 * Math.PI * config.frequencies[value] / config.sampleRate;
    for (let i = 0; i < n; i++) { samples[s * n + i] = amplitude * envelope(i, on, ramp) * Math.sin(phase); phase += step; }
  }
  return { samples, sampleRate: config.sampleRate };
}

/**
 * Bytes of a coded frame from per-symbol tone shares: the sync symbols are skipped, the header block decoded to
 * learn the length, then the body. The plain sync marker is put back in front so unframe() reads it as usual.
 */
function decodeCodedBlock(shares: number[][], bitsPerSymbol: number): Uint8Array {
  if (bitsPerSymbol !== 2) return new Uint8Array(0);
  const sync = Math.ceil(SYNC_BYTES.length * 8 / bitsPerSymbol), headerSteps = codedSteps(FEC_HEADER_BYTES * 8);
  if (shares.length < sync + headerSteps) return new Uint8Array(0);
  const costs = shares.map(toneCosts);
  const header = bitsToBytes(viterbiDecode(costs.slice(sync, sync + headerSteps), FEC_HEADER_BYTES * 8).bits);
  const bodyBytes = ((header[0] << 8) | header[1]) + 2, bodySteps = codedSteps(bodyBytes * 8);
  if (shares.length < sync + headerSteps + bodySteps) return new Uint8Array(0);
  const body = bitsToBytes(viterbiDecode(costs.slice(sync + headerSteps, sync + headerSteps + bodySteps), bodyBytes * 8).bits);
  const out = new Uint8Array(SYNC_BYTES.length + header.length + body.length);
  out.set(SYNC_BYTES, 0); out.set(header, SYNC_BYTES.length); out.set(body, SYNC_BYTES.length + header.length);
  return out;
}

export function decodeFsk(samples: Float32Array, config: FskConfig): DecodeResult {
  const { bits: bitsPerSymbol, n } = validate(config);
  const bits: number[] = []; let confidence = 0; const symbols = Math.floor(samples.length / n), on = fskToneSamples(config);
  const shares: number[][] = [];
  for (let s = 0; s < symbols; s++) {
    const energies = config.frequencies.map(f => {
      let re = 0, im = 0;
      for (let i = 0; i < on; i++) { const p = 2 * Math.PI * f * i / config.sampleRate; const x = samples[s * n + i]; re += x * Math.cos(p); im -= x * Math.sin(p); }
      return re * re + im * im;
    });
    let best = 0, second = 0;
    for (let i = 1; i < energies.length; i++) if (energies[i] > energies[best]) best = i;
    for (let i = 0; i < energies.length; i++) if (i !== best) second = Math.max(second, energies[i]);
    confidence += (energies[best] - second) / (energies[best] + 1e-12);
    for (let b = bitsPerSymbol - 1; b >= 0; b--) bits.push((best >>> b) & 1);
    const total = energies.reduce((sum, e) => sum + e, 0) || 1;
    shares.push(energies.map(e => e / total));
  }
  const parsed = unframe(config.fec ? decodeCodedBlock(shares, bitsPerSymbol) : bitsToBytes(bits));
  return { payload: parsed.payload, sender: parsed.sender, seq: parsed.seq, frameType: parsed.type, ok: !!parsed.payload, confidence: confidence / Math.max(1, symbols), errors: parsed.error ? [parsed.error] : [] };
}
