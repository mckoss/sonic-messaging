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

export function fskPlanWarnings(frequencies: number[], toneSpacing: number, symbolRate: number): string[] {
  const warnings: string[] = [];
  const ratio = toneSpacing / symbolRate;
  if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - Math.round(ratio)) > 0.02) {
    warnings.push('Tone spacing is not an integer multiple of the symbol rate; detector leakage may increase.');
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
