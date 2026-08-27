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
    expect(progress[progress.length - 1]).toEqual({ type: 'crc-confirm' });
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
});
