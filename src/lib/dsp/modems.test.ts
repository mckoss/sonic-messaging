import { describe, expect, it } from 'vitest';
import { decodeCss, decodeDsss, decodeFsk, detectDsssUsers, encodeCss, encodeDsss, encodeFsk, goldCodes, simulateChannel, smallKasamiCodes } from './index';

const payload = new TextEncoder().encode('test');

describe('waveform modem round trips', () => {
  it('decodes 4-FSK without errors and through noise', () => {
    const config = { sampleRate: 48000, symbolRate: 400, frequencies: [2400, 3200, 4000, 4800] };
    const tx = encodeFsk(payload, config).samples;
    expect(decodeFsk(tx, config).payload).toEqual(payload);
    expect(decodeFsk(simulateChannel(tx, { snrDb: 8, attenuation: 0.4, seed: 7 }), config).payload).toEqual(payload);
  });

  it('decodes cyclic CSS without errors and through noise', () => {
    const config = { sampleRate: 48000, bandwidth: 4000, centerFrequency: 7000, spreadingFactor: 4, samplesPerSymbol: 192 };
    const tx = encodeCss(payload, config).samples;
    expect(decodeCss(tx, config).payload).toEqual(payload);
    expect(decodeCss(simulateChannel(tx, { snrDb: 6, seed: 11 }), config).payload).toEqual(payload);
  });

  it('decodes DSSS without errors and through noise', () => {
    const code = goldCodes(5)[7], config = { sampleRate: 48000, chipRate: 6000, carrierFrequency: 9000, code };
    const tx = encodeDsss(payload, config).samples;
    expect(decodeDsss(tx, config).payload).toEqual(payload);
    expect(decodeDsss(simulateChannel(tx, { snrDb: -2, seed: 19 }), config).payload).toEqual(payload);
  });
});

describe('DSSS code families and competing users', () => {
  it('constructs Gold and small Kasami families', () => {
    expect(goldCodes(5)).toHaveLength(33);
    expect(goldCodes(5)[0]).toHaveLength(31);
    expect(smallKasamiCodes(6)).toHaveLength(8);
    expect(smallKasamiCodes(6)[0]).toHaveLength(63);
  });

  it('identifies and decodes the intended code amid an interfering user', () => {
    const codes = smallKasamiCodes(6), base = { sampleRate: 48000, chipRate: 6000, carrierFrequency: 9000 };
    const desired = encodeDsss(payload, { ...base, code: codes[2] }).samples;
    const other = encodeDsss(new TextEncoder().encode('noise'), { ...base, code: codes[5] }).samples;
    const channel = simulateChannel(desired, { snrDb: 4, seed: 23, interferers: [{ waveform: other, gain: 0.45 }] });
    const ranked = detectDsssUsers(channel, codes.map(code => ({ ...base, code })));
    expect(ranked[0].index).toBe(2);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(decodeDsss(channel, { ...base, code: codes[2] }).payload).toEqual(payload);
    expect(decodeDsss(channel, { ...base, code: codes[5] }).ok).toBe(false);
  });
});
