/**
 * Tone plans with unequal gaps, from a base frequency and the symbol rate.
 *
 * Non-coherent FSK needs its tones an integer number of symbol rates apart to stay orthogonal, which leaves the
 * *pattern* of gaps free. Equal gaps are the worst choice acoustically: speaker distortion puts harmonics and
 * difference tones (f2 − f1) straight onto other tones of the set, and a room's comb filtering nulls evenly spaced
 * tones together. These offsets form a Sidon set, where every pairwise difference is distinct, so no difference
 * product lands on another tone, and the plan stays inside an octave so no tone is another's harmonic.
 */
const SIDON_OFFSETS: Record<number, number[]> = {
  2: [0, 1],
  4: [0, 1, 3, 7],
  8: [0, 1, 3, 7, 12, 20, 30, 44],
  16: [0, 1, 3, 7, 12, 20, 30, 44, 65, 80, 96, 122, 147, 181, 203, 251]
};
/** Smallest gap between tones, in symbol rates: 2 leaves margin for timing and frequency error. */
const MIN_GAP_RATE_MULTIPLE = 2;
/** Above this, phone speakers and microphones fall away; tone plans stay below it. */
export const FSK_USABLE_CEILING_HZ = 16_000;

/** True when any tone sits on another's 2x, 3x or 4x harmonic, where speaker distortion would land. */
const harmonicCollision = (tones: number[]) => tones.some((high, i) => tones.slice(0, i).some(low => {
  const multiple = Math.round(high / low);
  return multiple >= 2 && multiple <= 4 && Math.abs(high - multiple * low) < 1;
}));

/** The tones for a plan: `base`, then gaps that are all multiples of the symbol rate, unequal where they fit. */
export function fskToneSet(base: number, symbolRate: number, toneCount: number): number[] {
  const count = Math.max(1, Math.trunc(toneCount));
  if (!Number.isFinite(base) || !Number.isFinite(symbolRate) || symbolRate <= 0) return Array.from({ length: count }, () => base);
  const uneven = SIDON_OFFSETS[count], even = Array.from({ length: count }, (_, i) => i);
  const headroom = FSK_USABLE_CEILING_HZ - base;
  // Unequal gaps are worth a lot acoustically, but many tones at a high baud simply cannot fit; then space them evenly.
  const patterns = uneven && uneven[uneven.length - 1] * MIN_GAP_RATE_MULTIPLE * symbolRate <= headroom ? [uneven, even] : [even];
  let fallback: number[] | undefined;
  for (const offsets of patterns) {
    const span = offsets[offsets.length - 1] || 1;
    const octave = Math.floor((base - 1) / (span * symbolRate));
    const ceiling = Math.floor(headroom / (span * symbolRate));
    const multiples: number[] = [];
    // Prefer the widest plan inside an octave, where no tone can be another's harmonic at all.
    for (let multiple = Math.min(octave, ceiling); multiple >= MIN_GAP_RATE_MULTIPLE; multiple--) multiples.push(multiple);
    // More tones than an octave holds: widen past it, but stay inside the band speakers and microphones reproduce.
    for (let multiple = Math.max(MIN_GAP_RATE_MULTIPLE, octave + 1); multiple <= ceiling; multiple++) multiples.push(multiple);
    for (const multiple of multiples) {
      const tones = offsets.map(offset => base + offset * multiple * symbolRate);
      if (!harmonicCollision(tones)) return tones;
      fallback ??= tones;
    }
  }
  return fallback ?? even.map(offset => base + offset * MIN_GAP_RATE_MULTIPLE * symbolRate);
}

/** Returns FSK tones starting at `lowestFrequency` with fixed adjacent-tone spacing. */
export function fskFrequencies(lowestFrequency: number, toneSpacing: number, toneCount: number): number[] {
  const count = Math.max(1, Math.trunc(toneCount));
  return Array.from({ length: count }, (_, index) => lowestFrequency + toneSpacing * index);
}

export function fskToneSpan(toneSpacing: number, toneCount: number): number {
  return toneSpacing * Math.max(0, Math.trunc(toneCount) - 1);
}

export function fskCenterFrequency(lowestFrequency: number, toneSpacing: number, toneCount: number): number {
  return lowestFrequency + fskToneSpan(toneSpacing, toneCount) / 2;
}

/** Below this, consumer speakers/mics roll off and ambient rumble dominates. */
export const FSK_ACOUSTIC_FLOOR_HZ = 500;
/** Fewer full cycles per symbol than this degrades the symbol correlator. */
export const FSK_MIN_CYCLES_PER_SYMBOL = 4;

/** Lowest tone and spacing suggested for a symbol rate: orthogonal multiples, enough cycles per symbol, above the acoustic floor. */
export function fskSuggestedPlan(symbolRate: number, toneCount: number): { lowestFrequency: number } | undefined {
  if (!Number.isFinite(symbolRate) || symbolRate <= 0) return undefined;
  const count = Math.max(2, Math.trunc(toneCount) || 2);
  const span = fskToneSet(Math.max(FSK_ACOUSTIC_FLOOR_HZ, FSK_MIN_CYCLES_PER_SYMBOL * symbolRate), symbolRate, count).slice(-1)[0];
  // Keeping the plan within one octave avoids low-order harmonic coincidences,
  // unless that would push the top tone past usable acoustic bandwidth.
  let floor = Math.max(FSK_ACOUSTIC_FLOOR_HZ, FSK_MIN_CYCLES_PER_SYMBOL * symbolRate, span + symbolRate);
  if (floor + span > FSK_USABLE_CEILING_HZ) floor = Math.max(FSK_ACOUSTIC_FLOOR_HZ, FSK_MIN_CYCLES_PER_SYMBOL * symbolRate);
  const lowest = Math.ceil(floor / symbolRate) * symbolRate;
  // Walk the base up until its computed tones carry no warnings: a wider base leaves room for unequal, harmonic-free gaps.
  for (let base = lowest; base <= lowest * 4 && base + span < FSK_USABLE_CEILING_HZ; base += symbolRate) {
    if (!fskPlanWarnings(fskToneSet(base, symbolRate, count), symbolRate).length) return { lowestFrequency: base };
  }
  return { lowestFrequency: lowest };
}

export function fskPlanWarnings(frequencies: number[], symbolRate: number): string[] {
  const warnings: string[] = [];
  const gaps = frequencies.slice(1).map((tone, index) => tone - frequencies[index]);
  if (gaps.some(gap => !Number.isFinite(gap / symbolRate) || gap <= 0 || Math.abs(gap / symbolRate - Math.round(gap / symbolRate)) > 0.02)) {
    warnings.push('Tone gaps are not integer multiples of the symbol rate; detector leakage may increase.');
  }
  const lowest = frequencies[0];
  if (lowest !== undefined && Number.isFinite(symbolRate) && symbolRate > 0) {
    const cycles = lowest / symbolRate;
    if (Math.abs(cycles - Math.round(cycles)) > 0.02) {
      warnings.push('Lowest frequency is not an integer multiple of the symbol rate; detector leakage may increase.');
    }
    if (cycles < FSK_MIN_CYCLES_PER_SYMBOL) {
      warnings.push(`Lowest tone completes fewer than ${FSK_MIN_CYCLES_PER_SYMBOL} cycles per symbol; detection degrades.`);
    }
    if (lowest < FSK_ACOUSTIC_FLOOR_HZ) {
      warnings.push(`Tones below ${FSK_ACOUSTIC_FLOOR_HZ} Hz sit in speaker/mic rolloff and ambient rumble.`);
    }
  }
  for (let low = 0; low < frequencies.length; low++) {
    for (let high = low + 1; high < frequencies.length; high++) {
      const multiple = Math.round(frequencies[high] / frequencies[low]);
      if (multiple >= 2 && multiple <= 4 && Math.abs(frequencies[high] - multiple * frequencies[low]) <= 1) {
        warnings.push(`${frequencies[high].toLocaleString()} Hz is the ${multiple}× harmonic of ${frequencies[low].toLocaleString()} Hz.`);
      }
    }
  }
  return warnings;
}
