function parity(value: number): number { let p = 0; while (value) { p ^= value & 1; value >>>= 1; } return p; }

function lfsrSequence(degree: number, mask: number): Int8Array {
  const length = 2 ** degree - 1, out = new Int8Array(length); let state = length;
  for (let i = 0; i < length; i++) {
    out[i] = (state & 1) ? 1 : -1;
    state = (state >>> 1) | (parity(state & mask) << (degree - 1));
  }
  return out;
}

function primitiveMasks(degree: number): number[] {
  const period = 2 ** degree - 1, found: number[] = [];
  for (let mask = 1; mask <= period && found.length < 2; mask += 2) {
    let state = period, steps = 0;
    do { state = (state >>> 1) | (parity(state & mask) << (degree - 1)); steps++; } while (state !== period && state !== 0 && steps <= period);
    if (steps === period && state === period) found.push(mask);
  }
  if (found.length < 2) throw new Error(`could not construct code family for degree ${degree}`);
  return found;
}

export function mSequence(degree: number, variant = 0): Int8Array {
  if (!Number.isInteger(degree) || degree < 3 || degree > 12) throw new RangeError('degree must be an integer from 3 to 12');
  return lfsrSequence(degree, primitiveMasks(degree)[variant % 2]);
}

export function goldCodes(degree: number): Int8Array[] {
  const a = mSequence(degree, 0), b = mSequence(degree, 1), family: Int8Array[] = [a, b];
  for (let shift = 0; shift < a.length; shift++) {
    const code = new Int8Array(a.length);
    for (let i = 0; i < a.length; i++) code[i] = a[i] * b[(i + shift) % b.length];
    family.push(code);
  }
  return family;
}

export function smallKasamiCodes(degree: number): Int8Array[] {
  if (degree % 2 || degree < 4 || degree > 12) throw new RangeError('small Kasami codes require an even degree from 4 to 12');
  const base = mSequence(degree), n = base.length, decimation = 2 ** (degree / 2) + 1;
  const decimated = new Int8Array(n); for (let i = 0; i < n; i++) decimated[i] = base[(i * decimation) % n];
  const family: Int8Array[] = [base];
  for (let shift = 0; shift < 2 ** (degree / 2) - 1; shift++) {
    const code = new Int8Array(n); for (let i = 0; i < n; i++) code[i] = base[i] * decimated[(i + shift) % n];
    family.push(code);
  }
  return family;
}

export function normalizedCrossCorrelation(a: Int8Array, b: Int8Array): number {
  if (a.length !== b.length) throw new Error('codes must have equal lengths');
  let worst = 0;
  for (let shift = 0; shift < a.length; shift++) { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i] * b[(i + shift) % b.length]; worst = Math.max(worst, Math.abs(sum / a.length)); }
  return worst;
}
