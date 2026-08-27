export const DSSS_CODE_LENGTHS = [31, 63, 127, 255, 511, 1023] as const;
export const KASAMI_CODE_LENGTHS = [63, 255, 1023] as const;

export function dsssCodeLengths(family: string): readonly number[] {
  return family === 'Kasami' ? KASAMI_CODE_LENGTHS : DSSS_CODE_LENGTHS;
}

export function normalizeDsssCodeLength(family: string, length: number): number {
  const allowed = dsssCodeLengths(family);
  return allowed.includes(length as never) ? length : allowed[0];
}
