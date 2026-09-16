import { describe, expect, it } from 'vitest';
import { missingCaptureSamples } from './capture-sequence';

/** Web Audio's render quantum, and so the size of every chunk the capture worklet posts. */
const QUANTUM = 128;

describe('capture chunk continuity', () => {
  it('reports nothing while the numbering runs consecutively', () => {
    expect(missingCaptureSamples(7, 7, QUANTUM)).toBeUndefined();
  });

  it('reports nothing for the first chunk, whatever number it starts at', () => {
    // A worklet that has just started numbers from zero; one restarted mid-session does not.
    expect(missingCaptureSamples(undefined, 0, QUANTUM)).toBeUndefined();
    expect(missingCaptureSamples(undefined, 91_447, QUANTUM)).toBeUndefined();
  });

  it('measures the dropped audio exactly when chunks go missing', () => {
    // The main thread stops posting under backpressure without renumbering, so the hole is the loss.
    expect(missingCaptureSamples(100, 101, QUANTUM)).toBe(QUANTUM);
    expect(missingCaptureSamples(100, 150, QUANTUM)).toBe(50 * QUANTUM);
    // A second of lost audio at 48 kHz is 375 quanta.
    expect(missingCaptureSamples(0, 375, QUANTUM)).toBe(48_000);
  });

  it('reports a break of unknown length when capture restarts and renumbers', () => {
    // Zero still counts as a break — the decoders must be rebuilt — but no audio can be accounted for.
    expect(missingCaptureSamples(4_000, 0, QUANTUM)).toBe(0);
    expect(missingCaptureSamples(4_000, 3_999, QUANTUM)).toBe(0);
  });

  it('reports nothing when the chunk carries no numbering', () => {
    // Replay feeds many slices under one sequence number; judging continuity there would flag every slice.
    expect(missingCaptureSamples(12, undefined, QUANTUM)).toBeUndefined();
    expect(missingCaptureSamples(undefined, undefined, QUANTUM)).toBeUndefined();
  });

  it('scales the gap by the chunk size in hand', () => {
    expect(missingCaptureSamples(0, 10, 256)).toBe(2_560);
  });
});
