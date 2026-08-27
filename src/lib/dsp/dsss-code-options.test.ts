import { describe, expect, it } from 'vitest';
import { dsssCodeLengths, normalizeDsssCodeLength } from './dsss-code-options';

describe('DSSS code length options', () => {
  it('offers only even-degree lengths for small-set Kasami codes', () => {
    expect(dsssCodeLengths('Kasami')).toEqual([63, 255, 1023]);
  });

  it('normalizes the default 127-chip selection when switching to Kasami', () => {
    expect(normalizeDsssCodeLength('Kasami', 127)).toBe(63);
    expect(normalizeDsssCodeLength('Kasami', 255)).toBe(255);
  });
});
