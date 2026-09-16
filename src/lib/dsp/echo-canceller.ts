/**
 * Decision-feedback echo cancellation in the tone-energy domain.
 *
 * A room reflection arrives a whole number of symbol times later (a 10-foot surface is ~18 ms, about two symbols at
 * 100 baud) carrying the tone of a symbol the receiver has already decoded. The per-symbol detector has no memory, so
 * that echo simply adds energy to one tone of a later window, and when it lands on a quieter tone it wins. Field
 * recordings show exactly that: every error was a tone the speaker drives weakly, with the loudest tone two symbols
 * earlier.
 *
 * Because each echo is a delayed copy of a *known* symbol, its contribution can be estimated and subtracted:
 *   score[i][k] ≈ direct(i, k) + Σ_j tap[j] · (symbol i−j was tone k)
 * The taps are fitted by least squares over the frame's own decisions, then the scores are corrected and the symbols
 * decided again. It needs no protocol change, and costs nothing until a frame fails its CRC.
 */

/** Longest echo modelled, in symbols. At 100 baud this covers 60 ms, beyond any small room's first reflections. */
export const MAX_ECHO_SYMBOLS = 6;

const decide = (scores: ArrayLike<number>): number => {
  let best = 0;
  for (let tone = 1; tone < scores.length; tone++) if (scores[tone] > scores[best]) best = tone;
  return best;
};

/**
 * Fits one gain per echo delay from the frame's decided symbols, by least squares over the energy each tone shows
 * when it was *not* the symbol sent. Returns a gain per delay of 1..MAX_ECHO_SYMBOLS symbols, all non-negative.
 */
export function estimateEchoTaps(scores: readonly Float32Array[], symbols: readonly number[], maxTaps = MAX_ECHO_SYMBOLS): number[] {
  const taps = Math.min(maxTaps, Math.max(0, symbols.length - 1));
  if (taps <= 0) return [];
  // Normal equations for the delays, using only windows whose tone differs from the symbol sent then.
  const ata = Array.from({ length: taps }, () => new Float64Array(taps)), atb = new Float64Array(taps);
  for (let i = taps; i < symbols.length; i++) {
    for (let tone = 0; tone < scores[i].length; tone++) {
      if (tone === symbols[i]) continue;
      const row = new Float64Array(taps);
      for (let j = 1; j <= taps; j++) if (symbols[i - j] === tone) row[j - 1] = 1;
      if (!row.some(v => v)) continue;
      for (let a = 0; a < taps; a++) {
        if (!row[a]) continue;
        atb[a] += row[a] * scores[i][tone];
        for (let b = 0; b < taps; b++) ata[a][b] += row[a] * row[b];
      }
    }
  }
  // Gauss-Jordan with a small ridge term; delays that never occur stay zero.
  for (let a = 0; a < taps; a++) ata[a][a] += 1e-6;
  const solution = new Float64Array(atb);
  for (let column = 0; column < taps; column++) {
    let pivot = column;
    for (let row = column + 1; row < taps; row++) if (Math.abs(ata[row][column]) > Math.abs(ata[pivot][column])) pivot = row;
    if (Math.abs(ata[pivot][column]) < 1e-9) continue;
    [ata[column], ata[pivot]] = [ata[pivot], ata[column]];
    [solution[column], solution[pivot]] = [solution[pivot], solution[column]];
    for (let row = 0; row < taps; row++) {
      if (row === column) continue;
      const factor = ata[row][column] / ata[column][column];
      if (!factor) continue;
      for (let c = column; c < taps; c++) ata[row][c] -= factor * ata[column][c];
      solution[row] -= factor * solution[column];
    }
  }
  return Array.from({ length: taps }, (_, j) => {
    const value = ata[j][j] ? solution[j] / ata[j][j] : 0;
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  });
}

/**
 * Subtracts each decided symbol's echo from later windows and decides again, feeding corrected decisions forward.
 * Returns the corrected symbols and the winning score of each.
 */
export function cancelEcho(scores: readonly Float32Array[], taps: readonly number[]): { symbols: number[]; scores: number[] } {
  const symbols: number[] = [], winners: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    const corrected = Float32Array.from(scores[i]);
    for (let j = 1; j <= taps.length && j <= i; j++) {
      const tone = symbols[i - j];
      if (tone !== undefined) corrected[tone] = Math.max(0, corrected[tone] - taps[j - 1]);
    }
    const winner = decide(corrected);
    symbols.push(winner);
    winners.push(corrected[winner]);
  }
  return { symbols, scores: winners };
}
