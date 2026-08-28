import { describe, expect, it } from 'vitest';
import { loadUserPreferences, PREFERENCES_KEY, saveUserPreferences, type UserPreferences } from './preferences';

const defaults: UserPreferences = {
  mode: 'FSK',
  settings: { FSK: { frequency: 3800, tones: 4 }, CSS: { bandwidth: 6000 }, DSSS: { chipRate: 4000 } },
  snr: 10, noiseType: 'White noise', interferer: false, interfererPower: -6,
  scrollSpeed: 'Medium', inputDeviceId: 'default', payload: 'SONIC TEST 001'
};

describe('user preferences', () => {
  it('merges partial saved settings with current defaults', () => {
    const storage = { getItem: () => JSON.stringify({
      mode: 'CSS', settings: { FSK: { frequency: 4100 } }, snr: 4, interferer: true
    }) };
    const result = loadUserPreferences(storage, defaults);
    expect(result.mode).toBe('CSS');
    expect(result.settings.FSK).toEqual({ frequency: 4100, tones: 4 });
    expect(result.settings.CSS).toEqual(defaults.settings.CSS);
    expect(result.snr).toBe(4);
    expect(result.interferer).toBe(true);
  });

  it('restores the saved test payload and clamps it to the editor limit', () => {
    const saved = loadUserPreferences({ getItem: () => JSON.stringify({ payload: 'hello 🌍' }) }, defaults);
    expect(saved.payload).toBe('hello 🌍');
    const oversized = loadUserPreferences({ getItem: () => JSON.stringify({ payload: 'x'.repeat(300) }) }, defaults);
    expect(oversized.payload).toHaveLength(256);
    const invalid = loadUserPreferences({ getItem: () => JSON.stringify({ payload: 42 }) }, defaults);
    expect(invalid.payload).toBe(defaults.payload);
  });

  it('falls back safely for corrupt storage and invalid values', () => {
    expect(loadUserPreferences({ getItem: () => '{bad' }, defaults)).toEqual(defaults);
    const result = loadUserPreferences({ getItem: () => JSON.stringify({
      mode: 'NOPE', settings: { FSK: { frequency: null, tones: Infinity } }, snr: 'loud'
    }) }, defaults);
    expect(result).toEqual(defaults);
  });

  it('saves under the versioned local-storage key and handles write failures', () => {
    let savedKey = '', savedValue = '';
    expect(saveUserPreferences({ setItem: (key, value) => { savedKey = key; savedValue = value; } }, defaults)).toBe(true);
    expect(savedKey).toBe(PREFERENCES_KEY);
    expect(JSON.parse(savedValue)).toEqual(defaults);
    expect(saveUserPreferences({ setItem: () => { throw new Error('quota'); } }, defaults)).toBe(false);
  });
});
