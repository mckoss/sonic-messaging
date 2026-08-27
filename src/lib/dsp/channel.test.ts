import { describe, expect, it } from 'vitest';
import { simulateChannel } from './channel';

describe('deterministic channel', () => {
  it('is repeatable for a fixed seed and mixes interferers', () => {
    const input = Float32Array.from([1, -1, 1, -1]);
    const options = { snrDb: 10, seed: 42, interferers: [{ waveform: Float32Array.from([1, 1]), gain: 0.5 }] };
    expect(simulateChannel(input, options)).toEqual(simulateChannel(input, options));
    expect(simulateChannel(input, { interferers: options.interferers })[0]).toBeCloseTo(1.5);
  });
});
