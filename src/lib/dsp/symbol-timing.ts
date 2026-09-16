import { toneScore } from './fsk-detector';

// Low gains average many transitions: higher gains jittered by a few samples even on clean signals, costing S/N.
const PHASE_GAIN = 0.1;
const DRIFT_GAIN = 0.003;
/** Largest tracked clock-rate error, as a fraction of a symbol per symbol (about 0.5%). */
const MAX_DRIFT = 0.005;

/**
 * Decision-directed symbol timing for FSK, needing no knowledge of the data. Sync gives the initial alignment; this
 * holds it through the frame. After each decision, a symbol that differs from both neighbors has a transition on
 * each edge, so its winning tone's energy in a window shifted slightly early versus slightly late shows which way
 * the true boundary lies (repeated tones have no edge and are skipped, which also avoids biasing the estimate).
 * A proportional term corrects phase and a small integral term follows sample-clock drift.
 *
 * Positions are relative to the frame start, so callers can move their sample buffers freely.
 */
export class SymbolTimingLoop {
  /** Current window offset from the nominal grid, in samples. */
  offset = 0;
  /** Estimated clock-rate error, in samples per symbol. */
  drift = 0;
  private readonly probe: number;
  private previous?: { symbol: number; at: number };
  private beforePrevious?: number;

  /** `windowSamples` is how much of each period the tone occupies; the probes measure over that, not the gap. */
  constructor(readonly samplesPerSymbol: number, readonly sampleRate: number, readonly frequencies: readonly number[],
    readonly windowSamples = samplesPerSymbol) {
    this.probe = Math.max(1, Math.round(samplesPerSymbol / 8));
  }

  /** Window start of symbol `index`, relative to the frame start. */
  at(index: number): number {
    return index * this.samplesPerSymbol + this.offset;
  }

  /** Records the decision for the symbol just decided at relative position `at`, then updates the timing. */
  observe(samples: Float32Array, frameStart: number, symbol: number, at: number): void {
    const middle = this.previous;
    if (middle && this.beforePrevious !== undefined && this.beforePrevious !== middle.symbol && middle.symbol !== symbol) {
      const n = this.windowSamples, frequency = this.frequencies[middle.symbol];
      const score = (shift: number) => {
        const from = Math.round(frameStart + middle.at + shift);
        return from < 0 || from + n > samples.length ? NaN : toneScore(samples.subarray(from, from + n), this.sampleRate, frequency);
      };
      const early = score(-this.probe), late = score(this.probe);
      if (early + late > 0.2) {
        // For a boundary error τ smaller than the probe, (late − early)/(late + early) ≈ 2τ/(n − probe).
        const error = Math.max(-this.probe, Math.min(this.probe, (late - early) / (late + early) * (n - this.probe) / 2));
        this.drift = Math.max(-MAX_DRIFT * n, Math.min(MAX_DRIFT * n, this.drift + DRIFT_GAIN * error));
        this.offset += PHASE_GAIN * error;
      }
    }
    this.offset += this.drift;
    this.offset = Math.max(-this.samplesPerSymbol / 2, Math.min(this.samplesPerSymbol / 2, this.offset));
    this.beforePrevious = middle?.symbol;
    this.previous = { symbol, at };
  }
}
