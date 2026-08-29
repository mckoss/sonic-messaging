export const WATERFALL_FLOOR_DB = -110;
export const WATERFALL_CEILING_DB = -12;
export const WATERFALL_SAMPLES_PER_CSS_PIXEL = 512;
export const WATERFALL_SPEED_SAMPLES = { Slow: 1024, Medium: 512, Fast: 256 } as const;
/**
 * Detector display cadence. Half the spectrum lane's 1024-sample hop so the
 * confidence lane resolves several cumulative-evidence points within one
 * symbol even at low baud rates.
 */
export const DETECTOR_HOP_SAMPLES = 512;
/** Scrub-back history retained by the waterfall lanes. */
export const WATERFALL_HISTORY_SECONDS = 60;
/** Ring-canvas width cap; stays under every browser's canvas dimension limit. */
export const WATERFALL_MAX_RING_PIXELS = 32_000;
/** While capturing, lanes free-run this far past the last worker data before halting. */
export const WATERFALL_STALL_FREE_RUN_SECONDS = 5;
/**
 * Free-run speed while ahead of worker data: a whisker under real time, so
 * animation-clock drift bleeds off instead of accumulating into a standing gap.
 */
export const WATERFALL_AHEAD_TRIM = 0.995;

export interface RingSpan { x: number; w: number }

/** Maps the unwrapped pixel range [start, start+width) onto 1-2 ring-canvas spans. */
export function ringSpans(start: number, width: number, ringWidth: number): RingSpan[] {
  if (width <= 0 || ringWidth <= 0) return [];
  const clipped = Math.min(width, ringWidth);
  const x = ((Math.floor(start) % ringWidth) + ringWidth) % ringWidth;
  if (x + clipped <= ringWidth) return [{ x, w: clipped }];
  return [{ x, w: ringWidth - x }, { x: 0, w: clipped - (ringWidth - x) }];
}

export interface BinRange { start: number; end: number }

export function waterfallPixelAdvance(
  samples: number, devicePixelRatio = 1, samplesPerCssPixel = WATERFALL_SAMPLES_PER_CSS_PIXEL
): number {
  return Math.max(0, samples) * Math.max(1, devicePixelRatio) / Math.max(1, samplesPerCssPixel);
}

/** Returns the half-open FFT-bin range covered by the requested frequencies. */
export function frequencyBinRange(binCount: number, sampleRate: number, minFrequency: number, maxFrequency: number): BinRange {
  if (binCount <= 0 || sampleRate <= 0) return { start: 0, end: 0 };
  const nyquist = sampleRate / 2;
  const low = Math.max(0, Math.min(nyquist, Math.min(minFrequency, maxFrequency)));
  const high = Math.max(low, Math.min(nyquist, Math.max(minFrequency, maxFrequency)));
  // One-sided real FFT output includes both DC and the Nyquist bin.
  const highestBin = binCount - 1;
  const start = Math.min(highestBin, Math.floor((low / nyquist) * highestBin));
  const end = Math.max(start + 1, Math.min(binCount, Math.ceil((high / nyquist) * highestBin) + 1));
  return { start, end };
}

/** Converts a spectrum level into a perceptually useful 0..1 display intensity. */
export function dbToIntensity(db: number, floorDb = WATERFALL_FLOOR_DB, ceilingDb = WATERFALL_CEILING_DB): number {
  if (!Number.isFinite(db)) return 0;
  const normalized = Math.max(0, Math.min(1, (db - floorDb) / Math.max(1, ceilingDb - floorDb)));
  return Math.sqrt(normalized);
}

/** Dark blue to cyan to yellow palette with monotonic luminance. */
export function intensityToRgb(intensity: number): readonly [number, number, number] {
  const value = Math.max(0, Math.min(1, Number.isFinite(intensity) ? intensity : 0));
  const stops = [[5, 10, 24], [16, 40, 84], [16, 122, 147], [72, 211, 164], [244, 211, 94], [255, 250, 220]] as const;
  const scaled = value * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const fraction = scaled - index;
  const from = stops[index], to = stops[index + 1];
  return [
    Math.round(from[0] + (to[0] - from[0]) * fraction),
    Math.round(from[1] + (to[1] - from[1]) * fraction),
    Math.round(from[2] + (to[2] - from[2]) * fraction),
  ];
}
