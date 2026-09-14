import { describe, expect, it } from 'vitest';
import { decodeRecording, encodeRecording, RecordingCapture, type RecordingMetadata } from './recording';
import { encodeFsk } from '../dsp/fsk';
import { FskStreamDecoder } from '../dsp/fsk-stream';
import { simulateChannel } from '../dsp/channel';

const metadata: RecordingMetadata = {
  format: 'sonic-recording', version: 1, createdAt: '2026-09-13T00:00:00Z', appVersion: 'test',
  sampleRate: 44100, fsk: { frequencies: [1000, 1200, 1400, 1600], symbolRate: 100 },
  inputSettings: { autoGainControl: false }, userAgent: 'fixture', notes: 'Two devices · 2 metres'
};

describe('recorded microphone fixtures', () => {
  it('preserves every float bit, metadata, and quiet samples through WAV export/import', () => {
    const samples = Float32Array.of(0, -0, 0.123456789, -0.987654321, 1.125, 1e-20, 0);
    const decoded = decodeRecording(encodeRecording({ metadata, samples }));
    expect(decoded.metadata).toEqual(metadata);
    expect(new Uint8Array(decoded.samples.buffer)).toEqual(new Uint8Array(samples.buffer));
  });

  it('owns captured samples before transfer and stops on discontinuity', () => {
    const capture = new RecordingCapture(metadata), samples = Float32Array.of(0.25, -0.5);
    capture.append(samples, metadata.sampleRate, 50);
    samples.fill(0);
    expect(() => capture.append(samples, metadata.sampleRate, 52)).toThrow('interrupted');
    expect([...capture.finish().samples]).toEqual([0.25, -0.5]);
  });

  it('caps recording duration without losing the retained audio', () => {
    const capture = new RecordingCapture({ ...metadata, sampleRate: 8000 });
    expect(capture.append(new Float32Array(8000 * 121).fill(0.1), 8000, 0)).toBe(true);
    expect(capture.finish().samples.length).toBe(8000 * 120);
  });

  it('rejects truncated, corrupt, unsupported and non-finite recordings', () => {
    const wav = encodeRecording({ metadata, samples: Float32Array.of(0.5) });
    expect(() => decodeRecording(wav.slice(0, -1))).toThrow();
    const corrupt = wav.slice(0); new DataView(corrupt).setUint32(52, 0xffffffff, true);
    expect(() => decodeRecording(corrupt)).toThrow();
    const nan = wav.slice(0); new DataView(nan).setFloat32(nan.byteLength - 4, NaN, true);
    expect(() => decodeRecording(nan)).toThrow();
    expect(() => encodeRecording({ metadata: { ...metadata, version: 2 } as unknown as RecordingMetadata,
      samples: Float32Array.of(1) })).toThrow();
  });

  it('repeatedly decodes the same noisy recording at its original sample rate', () => {
    const config = { ...metadata.fsk, sampleRate: metadata.sampleRate };
    const waveform = encodeFsk(new TextEncoder().encode('RECORDED'), config).samples;
    const samples = new Float32Array(waveform.length + 20000);
    samples.set(waveform, 7777);
    const input = simulateChannel(samples, { snrDb: 15, seed: 729 });
    const recording = decodeRecording(encodeRecording({ metadata, samples: input }));
    const run = () => {
      const decoder = new FskStreamDecoder(config), packets = [], progress = [];
      for (let offset = 0; offset < recording.samples.length; offset += 128) {
        packets.push(...decoder.push(recording.samples.subarray(offset, offset + 128)));
        progress.push(...decoder.drainProgress());
      }
      return { packets, progress };
    };
    const first = run();
    expect(first.packets.map(p => new TextDecoder().decode(p.payload))).toEqual(['RECORDED']);
    expect(first.progress.filter(p => p.type === 'crc-confirm')).toHaveLength(1);
    expect(run()).toEqual(first);
  });
});
