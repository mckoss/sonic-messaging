import { describe, expect, it } from 'vitest';
import { loadExperimentPreferences, loadUserPreferences, PREFERENCES_KEY, saveExperimentPreferences, saveUserPreferences, type UserPreferences } from './preferences';
import { defaultSearch, searchParameterPlan } from './experiment';

const defaults: UserPreferences = {
  mode: 'FSK',
  settings: { FSK: { frequency: 3800, tones: 4 }, CSS: { bandwidth: 6000 }, DSSS: { chipRate: 4000 } },
  snr: 10, noiseType: 'White noise', interferer: false, interfererPower: -6,
  inputDeviceId: 'default', payload: 'SONIC TEST 001'
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

describe('Test Suite settings', () => {
  const defaults = { config: defaultSearch(), notes: '' };
  const roundTrip = (value: unknown) =>
    loadExperimentPreferences({ getItem: () => JSON.stringify(value) }, defaults);

  it('restores saved settings and notes', () => {
    const plan = searchParameterPlan('amplitudePercent');
    const config = { ...defaults.config, parameter: plan.key, minimum: plan.minimum, maximum: plan.maximum, step: plan.step, repetitions: 3 };
    let stored = '';
    expect(saveExperimentPreferences({ setItem: (_k, v) => { stored = v; } }, { config, notes: 'two feet, kitchen' })).toBe(true);
    const restored = loadExperimentPreferences({ getItem: () => stored }, defaults);
    expect(restored.config).toEqual(config);
    expect(restored.notes).toBe('two feet, kitchen');
  });

  it('falls back to defaults rather than restoring settings that would refuse to run', () => {
    // A config saved by an older build may name a parameter or range that is no longer legal; loading it into the
    // form would leave the page unable to start, with nothing to say why.
    expect(roundTrip({ config: { ...defaults.config, parameter: 'retired' } }).config).toEqual(defaults.config);
    expect(roundTrip({ config: { ...defaults.config, minimum: 3000, maximum: 1000 } }).config).toEqual(defaults.config);
    expect(roundTrip({ config: 'nonsense' }).config).toEqual(defaults.config);
    expect(loadExperimentPreferences({ getItem: () => '{bad' }, defaults)).toEqual(defaults);
    expect(loadExperimentPreferences({ getItem: () => null }, defaults)).toEqual(defaults);
  });

  it('keeps notes even when the stored settings are discarded, and caps their length', () => {
    expect(roundTrip({ config: 'nonsense', notes: 'kept' }).notes).toBe('kept');
    expect(roundTrip({ notes: 'x'.repeat(5000) }).notes).toHaveLength(4000);
    expect(roundTrip({ notes: 42 }).notes).toBe(defaults.notes);
  });

  it('reports a storage that refuses to save', () => {
    expect(saveExperimentPreferences({ setItem: () => { throw new Error('full'); } }, defaults)).toBe(false);
  });
});
