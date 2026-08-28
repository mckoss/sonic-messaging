import { describe, expect, it } from 'vitest';
import { encodeFsk } from './fsk';
import { FskStreamDecoder } from './fsk-stream';

const config = { sampleRate: 48_000, symbolRate: 400, frequencies: [2400, 3200, 4000, 4800] };

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
});
