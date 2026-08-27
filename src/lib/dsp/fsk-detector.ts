export interface FskSymbolDetection {
  scores: Float32Array;
  symbol: number;
  confidence: number;
  powerDbfs: number;
}

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
    for (let i = 0; i < samples.length; i++) {
      const phase = 2 * Math.PI * frequency * i / sampleRate;
      inPhase += samples[i] * Math.cos(phase);
      quadrature -= samples[i] * Math.sin(phase);
    }
    powers[tone] = inPhase * inPhase + quadrature * quadrature;
  }

  const total = powers.reduce((sum, value) => sum + value, 0);
  const scores = Float32Array.from(powers, value => total > 0 ? value / total : 0);
  let symbol = -1, winner = 0, runnerUp = 0;
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] > winner) { runnerUp = winner; winner = scores[i]; symbol = i; }
    else if (scores[i] > runnerUp) runnerUp = scores[i];
  }
  const rms = Math.sqrt(samplePower / Math.max(1, samples.length));
  return {
    scores, symbol, confidence: winner > 0 ? (winner - runnerUp) / winner : 0,
    powerDbfs: 20 * Math.log10(Math.max(rms, 1e-12))
  };
}
