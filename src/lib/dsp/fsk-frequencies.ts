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
export function fskSuggestedPlan(symbolRate: number, toneCount: number): { lowestFrequency: number; toneSpacing: number } | undefined {
  if (!Number.isFinite(symbolRate) || symbolRate <= 0) return undefined;
  const count = Math.max(2, Math.trunc(toneCount) || 2);
  const toneSpacing = 2 * symbolRate;
  const span = toneSpacing * (count - 1);
  // Keeping the plan within one octave avoids low-order harmonic coincidences,
  // unless that would push the top tone past usable acoustic bandwidth.
  let floor = Math.max(FSK_ACOUSTIC_FLOOR_HZ, FSK_MIN_CYCLES_PER_SYMBOL * symbolRate, span + symbolRate);
  if (floor + span > 16_000) floor = Math.max(FSK_ACOUSTIC_FLOOR_HZ, FSK_MIN_CYCLES_PER_SYMBOL * symbolRate);
  return { lowestFrequency: Math.ceil(floor / symbolRate) * symbolRate, toneSpacing };
}

export function fskPlanWarnings(frequencies: number[], toneSpacing: number, symbolRate: number): string[] {
  const warnings: string[] = [];
  const ratio = toneSpacing / symbolRate;
  if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - Math.round(ratio)) > 0.02) {
    warnings.push('Tone spacing is not an integer multiple of the symbol rate; detector leakage may increase.');
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
