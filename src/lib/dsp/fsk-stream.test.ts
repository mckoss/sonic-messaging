import { describe, expect, it } from 'vitest';
import { encodeFsk } from './fsk';
import { FskStreamDecoder } from './fsk-stream';

const config = { sampleRate: 48_000, symbolRate: 400, frequencies: [2400, 3200, 4000, 4800] };

/** Modulates raw frame bytes as phase-continuous FSK, bypassing encodeFsk's framing. */
function frameSymbolWaveform(cfg: typeof config, bytes: number[]): Float32Array {
  const bitsPerSymbol = Math.log2(cfg.frequencies.length);
  const n = Math.round(cfg.sampleRate / cfg.symbolRate);
  const bits = bytes.flatMap(byte => Array.from({ length: 8 }, (_, i) => (byte >>> (7 - i)) & 1));
  while (bits.length % bitsPerSymbol) bits.push(0);
  const samples = new Float32Array((bits.length / bitsPerSymbol) * n);
  let phase = 0;
  for (let s = 0; s < bits.length / bitsPerSymbol; s++) {
    let value = 0;
    for (let b = 0; b < bitsPerSymbol; b++) value = (value << 1) | bits[s * bitsPerSymbol + b];
    const step = 2 * Math.PI * cfg.frequencies[value] / cfg.sampleRate;
    for (let i = 0; i < n; i++) { samples[s * n + i] = 0.8 * Math.sin(phase); phase += step; }
  }
  return samples;
}

describe('continuous FSK receiver', () => {
  it('acquires an offset packet across arbitrary microphone chunks', () => {
    const payload = new TextEncoder().encode('Hello 🌍');
    const waveform = encodeFsk(payload, config).samples;
    const samples = new Float32Array(73 + waveform.length + 211);
    samples.set(waveform, 73);
    const receiver = new FskStreamDecoder(config);
    const packets = [
      ...receiver.push(samples.subarray(0, 317)),
      ...receiver.push(samples.subarray(317, 2003)),
      ...receiver.push(samples.subarray(2003))
    ];
    expect(packets).toHaveLength(1);
    expect(packets[0].payload).toEqual(payload);
    expect(packets[0].confidence).toBeGreaterThan(0.5);
    const progress = receiver.drainProgress();
    expect(progress[0].type).toBe('sync');
    expect(progress[1].type).toBe('length');
    expect(progress[progress.length - 1].type).toBe('crc-confirm');
    // Sync ends 16 symbols after the 73-sample offset; the phase lock is sample-accurate.
    const samplesPerSymbol = Math.round(config.sampleRate / config.symbolRate);
    expect(Math.abs(progress[0].position - (73 + 16 * samplesPerSymbol))).toBeLessThanOrEqual(2);
  });

  it('decodes consecutive packets and ignores leading noise', () => {
    const first = encodeFsk(new TextEncoder().encode('one'), config).samples;
    const second = encodeFsk(new TextEncoder().encode('two'), config).samples;
    const samples = new Float32Array(53 + first.length + second.length);
    for (let i = 0; i < 53; i++) samples[i] = Math.sin(i * 0.31) * 0.01;
    samples.set(first, 53); samples.set(second, 53 + first.length);
    const packets = new FskStreamDecoder(config).push(samples);
    expect(packets.map(packet => new TextDecoder().decode(packet.payload))).toEqual(['one', 'two']);
  });

  it('decodes a soft noisy signal whose confidence sits below the display gate', () => {
    const payload = new TextEncoder().encode('soft signal');
    const waveform = encodeFsk(payload, { ...config, amplitude: 0.05 }).samples;
    let seed = 1;
    const noise = () => {
      seed = (seed * 48271) % 2147483647;
      return (seed / 2147483647 - 0.5) * 0.15;
    };
    const samples = Float32Array.from(waveform, value => value + noise());
    const packets = new FskStreamDecoder(config, -45).push(samples);
    expect(packets).toHaveLength(1);
    expect(packets[0].payload).toEqual(payload);
    // The app's default display gate is 0.8; packet decoding must not use it.
    expect(packets[0].confidence).toBeLessThan(0.8);
  });

  it('reports progress positions on the caller-supplied stream clock', () => {
    const payload = new TextEncoder().encode('hi');
    const waveform = encodeFsk(payload, config).samples;
    const receiver = new FskStreamDecoder(config, -Infinity, 5_000);
    receiver.push(waveform);
    const progress = receiver.drainProgress();
    expect(progress[0].type).toBe('sync');
    expect(progress[0].position).toBeGreaterThanOrEqual(5_000);
  });

  it('rejects a corrupted frame and still decodes the packet that follows', () => {
    const first = encodeFsk(new TextEncoder().encode('corrupt me'), config).samples;
    const second = encodeFsk(new TextEncoder().encode('clean'), config).samples;
    const samples = new Float32Array(first.length + second.length);
    samples.set(first); samples.set(second, first.length);
    const samplesPerSymbol = Math.round(config.sampleRate / config.symbolRate);
    samples.fill(0, 30 * samplesPerSymbol, 33 * samplesPerSymbol);
    const receiver = new FskStreamDecoder(config);
    const packets = receiver.push(samples);
    expect(packets.map(packet => new TextDecoder().decode(packet.payload))).toEqual(['clean']);
    expect(receiver.drainProgress().some(progress => progress.type === 'crc-error')).toBe(true);
  });

  it('acquires through one damaged sync symbol while retaining CRC payload validation', () => {
    const payload = new TextEncoder().encode('sync recovery');
    const samples = encodeFsk(payload, config).samples;
    const samplesPerSymbol = Math.round(config.sampleRate / config.symbolRate);
    for (let index = 0; index < samplesPerSymbol; index++) {
      samples[index] = 0.8 * Math.sin(2 * Math.PI * config.frequencies[2] * index / config.sampleRate);
    }
    const packets = new FskStreamDecoder(config).push(samples);
    expect(packets).toHaveLength(1);
    expect(packets[0].payload).toEqual(payload);
  });

  it('exposes the locked symbol anchor during a frame and clears it after decode', () => {
    const payload = new TextEncoder().encode('anchor test payload');
    const waveform = encodeFsk(payload, config).samples;
    const lead = 73;
    const samples = new Float32Array(lead + waveform.length);
    samples.set(waveform, lead);
    const base = 10_000;
    const receiver = new FskStreamDecoder(config, -Infinity, base);
    expect(receiver.lockedSymbolAnchor()).toBeUndefined();
    // Push through sync plus lookahead but stop before the frame completes.
    const partial = lead + 24 * Math.round(config.sampleRate / config.symbolRate);
    receiver.push(samples.subarray(0, partial));
    const anchor = receiver.lockedSymbolAnchor();
    expect(anchor).toBeDefined();
    expect(Math.abs(anchor! - (base + lead))).toBeLessThanOrEqual(2);
    const packets = receiver.push(samples.subarray(partial));
    expect(packets).toHaveLength(1);
    expect(receiver.lockedSymbolAnchor()).toBeUndefined();
  });

  it('decodes a very-low-baud frame whose duration exceeds the old 10-second cap', () => {
    const slow = {
      sampleRate: 48_000, symbolRate: 2,
      frequencies: Array.from({ length: 16 }, (_, i) => 500 + 20 * i)
    };
    const payload = new TextEncoder().encode('HI!');
    const waveform = encodeFsk(payload, slow).samples;
    const packets = new FskStreamDecoder(slow, -Infinity).push(waveform);
    expect(packets).toHaveLength(1);
    expect(packets[0].payload).toEqual(payload);
  });

  it('skips past a whole sync after an oversized length instead of re-refining it', () => {
    const oversized = frameSymbolWaveform(config, [0xd3, 0x91, 0xd3, 0x91, 0xff, 0xff, 0, 0, 0, 0]);
    const clean = encodeFsk(new TextEncoder().encode('ok'), config).samples;
    const samples = new Float32Array(oversized.length + clean.length);
    samples.set(oversized); samples.set(clean, oversized.length);
    const receiver = new FskStreamDecoder(config);
    const packets = receiver.push(samples);
    expect(packets.map(packet => new TextDecoder().decode(packet.payload))).toEqual(['ok']);
    // One rejected sync and one accepted one; a phase-step skip would re-report the first repeatedly.
    const syncs = receiver.drainProgress().filter(progress => progress.type === 'sync');
    expect(syncs).toHaveLength(2);
  });

  it('decodes a 16-tone stream with byte-aligned symbols', () => {
    const wide = {
      sampleRate: 48_000, symbolRate: 400,
      frequencies: Array.from({ length: 16 }, (_, i) => 2400 + 800 * i)
    };
    const payload = new TextEncoder().encode('16-FSK ✓');
    const waveform = encodeFsk(payload, wide).samples;
    const samples = new Float32Array(91 + waveform.length + 130);
    samples.set(waveform, 91);
    const receiver = new FskStreamDecoder(wide);
    const packets = [...receiver.push(samples.subarray(0, 1024)), ...receiver.push(samples.subarray(1024))];
    expect(packets).toHaveLength(1);
    expect(packets[0].payload).toEqual(payload);
    expect(packets[0].confidence).toBeGreaterThan(0.5);
  });
});
