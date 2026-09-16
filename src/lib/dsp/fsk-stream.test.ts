import { describe, expect, it } from 'vitest';
import { frame, FRAME_TYPE, SYNC_BYTES } from './frame';
import { encodeFsk } from './fsk';
import { FskStreamDecoder } from './fsk-stream';
import { simulateChannel } from './channel';

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
    expect(progress[1]).toMatchObject({ type: 'length', length: payload.length });
    expect(progress[2]).toMatchObject({ type: 'address', sender: 0, frameType: FRAME_TYPE.message });
    expect(progress.filter(p => p.type === 'byte').map(p => 'byte' in p ? p.byte : -1)).toEqual([...payload]);
    expect(progress[progress.length - 1].type).toBe('crc-confirm');
    // Sync ends 16 symbols after the 73-sample offset; the phase lock is sample-accurate.
    const samplesPerSymbol = Math.round(config.sampleRate / config.symbolRate);
    expect(Math.abs(progress[0].position - (73 + 16 * samplesPerSymbol))).toBeLessThanOrEqual(2);
  });

  it('reports the frame sender and type with each packet', () => {
    const payload = new TextEncoder().encode('from me');
    const samples = encodeFsk(payload, { ...config, address: { sender: 0x9f04, type: FRAME_TYPE.control } }).samples;
    const receiver = new FskStreamDecoder(config), packets = receiver.push(samples);
    expect(packets).toMatchObject([{ payload, sender: 0x9f04, frameType: FRAME_TYPE.control }]);
    expect(receiver.drainProgress().find(p => p.type === 'address')).toMatchObject({ sender: 0x9f04, frameType: FRAME_TYPE.control });
  });

  it.each([0.997, 1.003])('tracks symbol timing through a long frame with clock rate %s', factor => {
    // 60 bytes = 288 symbols; 0.3% clock error slides a fixed grid ~0.9 symbol by the end, which fails without tracking.
    const payload = Uint8Array.from({ length: 60 }, (_, i) => (i * 73 + 11) & 255);
    const clean = encodeFsk(payload, config).samples;
    const stretched = new Float32Array(Math.ceil(clean.length * factor) + 400);
    for (let i = 0; i < stretched.length - 400; i++) {
      const x = i / factor, lo = Math.floor(x), f = x - lo;
      stretched[i + 200] = (clean[lo] ?? 0) * (1 - f) + (clean[lo + 1] ?? 0) * f;
    }
    const packets = new FskStreamDecoder(config).push(simulateChannel(stretched, { snrDb: 20, seed: 5 }));
    expect(packets.map(p => [...p.payload])).toEqual([[...payload]]);
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
    const packets = new FskStreamDecoder(config).push(samples);
    expect(packets).toHaveLength(1);
    expect(packets[0].payload).toEqual(payload);
    // The app's default display gate is 0.8; packet decoding must not use it.
    expect(packets[0].confidence).toBeLessThan(0.8);
  });

  it('reports progress positions on the caller-supplied stream clock', () => {
    const payload = new TextEncoder().encode('hi');
    const waveform = encodeFsk(payload, config).samples;
    const receiver = new FskStreamDecoder(config, 5_000);
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
    // Symbols 42-45 fall in the payload, past sync, length and the sender/type address.
    samples.fill(0, 42 * samplesPerSymbol, 45 * samplesPerSymbol);
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
    const receiver = new FskStreamDecoder(config, base);
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

  it('acquires sync timing in noise too deep for reliable per-symbol decisions', () => {
    const payload = new TextEncoder().encode('deep noise');
    const waveform = encodeFsk(payload, config).samples;
    const lead = 4_000;
    const clean = new Float32Array(lead + waveform.length + 2_000);
    clean.set(waveform, lead);
    const noisy = simulateChannel(clean, { snrDb: -3, seed: 7 });
    const receiver = new FskStreamDecoder(config);
    receiver.push(noisy);
    const sync = receiver.drainProgress().find(progress => progress.type === 'sync');
    expect(sync).toBeDefined();
    // Sync position reports where the sync word ends: 16 symbols past the packet start.
    const samplesPerSymbol = Math.round(config.sampleRate / config.symbolRate);
    expect(Math.abs(sync!.position - (lead + 16 * samplesPerSymbol)))
      .toBeLessThanOrEqual(samplesPerSymbol / 2);
  });

  it('reports no sync candidates in pure noise', () => {
    let state = 12345;
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0xffffffff - 0.5;
    };
    const noise = Float32Array.from({ length: 5 * config.sampleRate }, () => 0.3 * random());
    const receiver = new FskStreamDecoder(config);
    receiver.push(noise);
    expect(receiver.drainProgress().filter(progress => progress.type === 'sync')).toHaveLength(0);
  });

  it('decodes a very-low-baud frame whose duration exceeds the old 10-second cap', () => {
    const slow = {
      sampleRate: 48_000, symbolRate: 2,
      frequencies: Array.from({ length: 16 }, (_, i) => 500 + 20 * i)
    };
    const payload = new TextEncoder().encode('HI!');
    const waveform = encodeFsk(payload, slow).samples;
    const packets = new FskStreamDecoder(slow).push(waveform);
    expect(packets).toHaveLength(1);
    expect(packets[0].payload).toEqual(payload);
  });

  it('skips past a whole sync after an oversized length instead of re-refining it', () => {
    const oversized = frameSymbolWaveform(config, [...SYNC_BYTES, 0xff, 0xff, 0, 0, 0, 0]);
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

  it('abandons a truncated frame with a valid length once the carrier disappears', () => {
    // Sync plus a well-formed header claiming 200 payload bytes, then only a moment of data.
    const bogus = frameSymbolWaveform(config, [...SYNC_BYTES, 0, 200, 0x55]);
    const clean = encodeFsk(new TextEncoder().encode('after'), config).samples;
    const gap = new Float32Array(20 * Math.round(config.sampleRate / config.symbolRate));
    const samples = new Float32Array(bogus.length + gap.length + clean.length);
    samples.set(bogus); samples.set(clean, bogus.length + gap.length);
    const receiver = new FskStreamDecoder(config);
    const packets = receiver.push(samples);
    expect(packets.map(packet => new TextDecoder().decode(packet.payload))).toEqual(['after']);
    const progress = receiver.drainProgress();
    expect(progress.some(event => event.type === 'crc-error')).toBe(true);
    expect(progress.some(event => event.type === 'length' && event.length === 200)).toBe(true);
  });

  it('keeps a frame whose transmitter fades while sending it', () => {
    // A phone's speaker limiter pulls its output down as a long tone heats the voice coil: field recordings show
    // 13 dB of fade across one frame. Judged against the sync level alone that looks like a carrier that went away,
    // and a perfectly readable frame was being abandoned a quarter of the way in.
    const payload = new TextEncoder().encode('a'.repeat(200));
    const waveform = encodeFsk(payload, config).samples.slice();
    for (let i = 0; i < waveform.length; i++) waveform[i] *= 10 ** (-15 * (i / waveform.length) / 20);
    const receiver = new FskStreamDecoder(config);
    const packets: ReturnType<FskStreamDecoder['push']> = [];
    // Small chunks so the frame arrives gradually and the carrier-loss scan actually runs.
    for (let i = 0; i < waveform.length; i += 512) packets.push(...receiver.push(waveform.subarray(i, i + 512)));
    expect(packets.map(packet => new TextDecoder().decode(packet.payload))).toEqual([new TextDecoder().decode(payload)]);
    expect(receiver.drainProgress().some(event => event.type === 'crc-error')).toBe(false);
  });

  it('recovers a frame whose weakest symbol was misread, and reports the correction', () => {
    const payload = new TextEncoder().encode('one weak symbol');
    const spp = Math.round(config.sampleRate / config.symbolRate);
    const clean = encodeFsk(payload, config).samples;
    const symbol = 40;
    const sent = new FskStreamDecoder(config);
    sent.push(clean);
    const trueTone = sent.drainFrames()[0].symbols[symbol];
    // Add a competing tone just loud enough to win the window, leaving the tone actually sent as runner-up.
    // Two tones of amplitude a and b split the window's energy as a² : b², so b ≈ 1.36a puts the margin near 0.3 —
    // a near miss, which is what a real weak symbol looks like, rather than an obliterated one.
    const damaged = clean.slice(), wrong = config.frequencies[(trueTone + 1) % config.frequencies.length];
    for (let i = 0; i < spp; i++) {
      damaged[symbol * spp + i] += 1.09 * Math.sin(2 * Math.PI * wrong * i / config.sampleRate);
    }
    const receiver = new FskStreamDecoder(config);
    const packets = receiver.push(damaged);
    expect(packets.map(packet => new TextDecoder().decode(packet.payload))).toEqual([new TextDecoder().decode(payload)]);
    expect(packets[0].softCorrected).toBe(1);
    const frame = receiver.drainFrames()[0];
    expect(frame.crcOk).toBe(true);
    expect(frame.softCorrected).toBe(1);
  });

  it('acquires and decodes a frame through a reverberant, tilted channel that misreads several sync symbols', () => {
    // Two effects from a two-foot field recording, synthesized: the speaker delivers the low tones far more weakly
    // than the high ones, and the room carries a large fraction of each symbol's energy into the next symbol time.
    // The loud tones' tails then out-shout the quiet tones' direct signal one symbol later, misreading three of the
    // sixteen sync symbols and many payload symbols. The matched filter still fires unmistakably; the sync is
    // accepted on that strength, the tails are measured on the known sync tones, and decision feedback takes each
    // one back before the next decision.
    const payload = new TextEncoder().encode('reverberant room, tilted speaker');
    const gain = [0.4, 0.45, 0.8, 1.0], n = Math.round(config.sampleRate / config.symbolRate);
    const bits = [...frame(payload)].flatMap(byte => Array.from({ length: 8 }, (_, i) => (byte >>> (7 - i)) & 1));
    const symbols: number[] = [];
    for (let i = 0; i + 2 <= bits.length; i += 2) symbols.push((bits[i] << 1) | bits[i + 1]);
    const direct = new Float32Array(symbols.length * n);
    let phase = 0;
    for (let s = 0; s < symbols.length; s++) {
      const step = 2 * Math.PI * config.frequencies[symbols[s]] / config.sampleRate;
      for (let i = 0; i < n; i++) { direct[s * n + i] = 0.8 * gain[symbols[s]] * Math.sin(phase); phase += step; }
    }
    // The room: half of what was heard one symbol ago is heard again, recursively, as reverberation is.
    const heard = new Float32Array(direct.length + 3 * n);
    heard.set(direct);
    for (let i = 0; i + n < heard.length; i++) heard[i + n] += 0.5 * heard[i];
    const receiver = new FskStreamDecoder(config);
    const packets = receiver.push(heard);
    expect(packets.map(packet => new TextDecoder().decode(packet.payload))).toEqual([new TextDecoder().decode(payload)]);
    expect(receiver.drainProgress().some(event => event.type === 'sync')).toBe(true);
    // The room's memory was measured on the sync and reported: about a quarter of each tone's power carried over.
    expect(packets[0].tails).toBeDefined();
    for (const tail of packets[0].tails!) { expect(tail).toBeGreaterThan(0.1); expect(tail).toBeLessThan(0.5); }
  });

  it('reports a sync it hears unmistakably but cannot read, then acquires the next frame', () => {
    const spp = Math.round(config.sampleRate / config.symbolRate);
    const first = encodeFsk(new TextEncoder().encode('unreadable'), config).samples.slice();
    // Six sync windows get a competing tone just loud enough to win: too many misreads to decode, but no doubt a
    // frame is there. That must be reported, not silently skipped, and must not stop the next frame being heard.
    const template = [0, 1, 2, 2, 3, 0, 3, 3, 3, 3, 3, 0, 0, 1, 3, 1];
    for (const index of [1, 3, 5, 7, 9, 13]) {
      const wrong = config.frequencies[(template[index] + 1) % 4];
      for (let i = 0; i < spp; i++) first[index * spp + i] += 0.88 * Math.sin(2 * Math.PI * wrong * i / config.sampleRate);
    }
    const second = encodeFsk(new TextEncoder().encode('next'), config).samples;
    const gap = new Float32Array(40 * spp), samples = new Float32Array(first.length + gap.length + second.length);
    samples.set(first); samples.set(second, first.length + gap.length);
    const receiver = new FskStreamDecoder(config);
    expect(receiver.push(samples).map(packet => new TextDecoder().decode(packet.payload))).toEqual(['next']);
    const progress = receiver.drainProgress();
    const unreadable = progress.filter(event => event.type === 'sync-unreadable');
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toMatchObject({ type: 'sync-unreadable', mismatches: 6, of: 16 });
    expect(progress.filter(event => event.type === 'sync')).toHaveLength(1);
  });

  it('loses a frame whose length symbol is corrupted, then decodes the next frame', () => {
    const payload = new TextEncoder().encode('length hit');
    const spp = Math.round(config.sampleRate / config.symbolRate);
    // Length field = bytes 4-5 = symbols 16..23 at 2 bits/symbol; there is no length FEC, so the CRC rejects it.
    const damaged = encodeFsk(payload, config).samples.slice();
    for (let i = 0; i < spp; i++) damaged[21 * spp + i] = 0.8 * Math.sin(2 * Math.PI * config.frequencies[3] * i / config.sampleRate);
    const next = encodeFsk(new TextEncoder().encode('next'), config).samples;
    const gap = new Float32Array(40 * spp), samples = new Float32Array(damaged.length + gap.length + next.length);
    samples.set(damaged); samples.set(next, damaged.length + gap.length);
    const receiver = new FskStreamDecoder(config);
    expect(receiver.push(samples).map(packet => new TextDecoder().decode(packet.payload))).toEqual(['next']);
    expect(receiver.drainProgress().some(event => event.type === 'crc-error')).toBe(true);
  });

  it('reports no 2-FSK sync on a steady tone parked at the mark frequency', () => {
    // The unbalanced 32-bit sync (19 ones, 13 zeros) once let a constant tone
    // at one frequency — e.g. a mains-hum harmonic — fire continuous false
    // syncs through the plain margin statistic.
    const binary = { sampleRate: 48_000, symbolRate: 25, frequencies: [500, 600] };
    const samples = new Float32Array(3 * binary.sampleRate);
    let seed = 42;
    const random = () => ((seed = (seed * 1_664_525 + 1_013_904_223) >>> 0) / 0xffffffff - 0.5);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = 0.05 * Math.sin(2 * Math.PI * 600 * i / binary.sampleRate) + 0.005 * random();
    }
    const receiver = new FskStreamDecoder(binary);
    receiver.push(samples);
    expect(receiver.drainProgress().filter(event => event.type === 'sync')).toEqual([]);
  });

  it('reports no sync on fluctuating in-band rumble thanks to hard symbol verification', () => {
    // Both tones amplitude-modulated by independent slow random walks, mimicking
    // ambient room rumble under a low-frequency tone plan. The soft statistic
    // alone crossed its margin several times per ten seconds; the per-symbol
    // hard check makes random energy match ≥31 of 32 sync symbols effectively never.
    const binary = { sampleRate: 48_000, symbolRate: 30, frequencies: [210, 300] };
    let seed = 7;
    const random = () => ((seed = (seed * 1_664_525 + 1_013_904_223) >>> 0) / 0xffffffff - 0.5);
    const samples = new Float32Array(10 * binary.sampleRate);
    let a0 = 0.05, a1 = 0.05;
    for (let i = 0; i < samples.length; i++) {
      if (i % 480 === 0) {
        a0 = Math.max(0, Math.min(0.12, a0 + 0.02 * random()));
        a1 = Math.max(0, Math.min(0.12, a1 + 0.02 * random()));
      }
      const t = i / binary.sampleRate;
      samples[i] = a0 * Math.sin(2 * Math.PI * 210 * t) + a1 * Math.sin(2 * Math.PI * 300 * t)
        + 0.01 * random();
    }
    const receiver = new FskStreamDecoder(binary);
    receiver.push(samples);
    expect(receiver.drainProgress().filter(event => event.type === 'sync')).toEqual([]);
  });

  it('decodes a 2-FSK stream with the balanced sync statistic', () => {
    const binary = { sampleRate: 48_000, symbolRate: 400, frequencies: [2400, 3200] };
    const payload = new TextEncoder().encode('two tones');
    const waveform = encodeFsk(payload, binary).samples;
    const samples = new Float32Array(150 + waveform.length + 150);
    samples.set(waveform, 150);
    const packets = new FskStreamDecoder(binary).push(samples);
    expect(packets.map(packet => new TextDecoder().decode(packet.payload))).toEqual(['two tones']);
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
