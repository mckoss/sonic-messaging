export interface FskSymbolDetection {
  scores: Float32Array;
  symbol: number;
  confidence: number;
  powerDbfs: number;
}

/** Suppresses detector output below the configured full-window RMS threshold. */
export function squelchFskDetection(result: FskSymbolDetection, thresholdDbfs: number): FskSymbolDetection {
  if (result.powerDbfs >= thresholdDbfs) return result;
  return { ...result, scores: new Float32Array(result.scores.length), symbol: -1, confidence: 0 };
}

const MIN_SYMBOL_SCORE = 0.25;
const MIN_SYMBOL_MARGIN = 0.15;

/** Measures coherent energy at each configured tone over one candidate symbol window. */
export function detectFskSymbol(
  samples: Float32Array, sampleRate: number, frequencies: readonly number[]
): FskSymbolDetection {
  const powers = new Float64Array(frequencies.length);
  let samplePower = 0;
  for (let i = 0; i < samples.length; i++) samplePower += samples[i] * samples[i];

  for (let tone = 0; tone < frequencies.length; tone++) {
    const frequency = frequencies[tone];
    if (!(frequency > 0 && frequency < sampleRate / 2)) continue;
    let inPhase = 0, quadrature = 0;
    const step = 2 * Math.PI * frequency / sampleRate;
    const stepCos = Math.cos(step), stepSin = Math.sin(step);
    let phaseCos = 1, phaseSin = 0;
    for (let i = 0; i < samples.length; i++) {
      inPhase += samples[i] * phaseCos;
      quadrature -= samples[i] * phaseSin;
      const nextCos = phaseCos * stepCos - phaseSin * stepSin;
      phaseSin = phaseSin * stepCos + phaseCos * stepSin;
      phaseCos = nextCos;
    }
    powers[tone] = inPhase * inPhase + quadrature * quadrature;
  }

  // For a full-window sinusoid, 2 * coherentPower / (N * samplePower) is one.
  // Referencing all window energy (rather than only the configured tone bins)
  // prevents noise from being normalized into a guaranteed false winner. It
  // also penalizes tones that occupy only part of the configured symbol time.
  const coherentScale = samples.length * samplePower;
  const scores = Float32Array.from(powers, value => coherentScale > 0
    ? Math.min(1, 2 * value / coherentScale)
    : 0);
  let winnerIndex = -1, winner = 0, runnerUp = 0;
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] > winner) { runnerUp = winner; winner = scores[i]; winnerIndex = i; }
    else if (scores[i] > runnerUp) runnerUp = scores[i];
  }
  const confidence = Math.max(0, winner - runnerUp);
  const symbol = winner >= MIN_SYMBOL_SCORE && confidence >= MIN_SYMBOL_MARGIN ? winnerIndex : -1;
  const rms = Math.sqrt(samplePower / Math.max(1, samples.length));
  return {
    scores, symbol, confidence,
    powerDbfs: 20 * Math.log10(Math.max(rms, 1e-12))
  };
}

export function windowPowerDbfs(samples: Float32Array): number {
  let power = 0;
  for (const sample of samples) power += sample * sample;
  return 20 * Math.log10(Math.max(Math.sqrt(power / Math.max(1, samples.length)), 1e-12));
}
