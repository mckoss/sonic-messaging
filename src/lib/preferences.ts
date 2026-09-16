import { validateSearch, type SearchSettings } from './experiment';

export type Mode = 'FSK' | 'CSS' | 'DSSS';
export type ModemSettings = Record<Mode, Record<string, number | string | boolean>>;

export interface UserPreferences {
  mode: Mode;
  settings: ModemSettings;
  snr: number;
  noiseType: string;
  interferer: boolean;
  interfererPower: number;
  inputDeviceId: string;
  payload: string;
}

export const PREFERENCES_KEY = 'sonic-messaging:preferences:v1';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function settingValues(value: unknown): Record<string, number | string | boolean> {
  if (!record(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number | string | boolean] =>
    ['number', 'string', 'boolean'].includes(typeof entry[1]) &&
    (typeof entry[1] !== 'number' || Number.isFinite(entry[1]))
  ));
}

export function loadUserPreferences(storage: Pick<Storage, 'getItem'>, defaults: UserPreferences): UserPreferences {
  try {
    const value: unknown = JSON.parse(storage.getItem(PREFERENCES_KEY) ?? 'null');
    if (!record(value)) return structuredClone(defaults);
    const savedSettings = record(value.settings) ? value.settings : {};
    return {
      mode: value.mode === 'FSK' || value.mode === 'CSS' || value.mode === 'DSSS' ? value.mode : defaults.mode,
      settings: {
        FSK: { ...defaults.settings.FSK, ...settingValues(savedSettings.FSK) },
        CSS: { ...defaults.settings.CSS, ...settingValues(savedSettings.CSS) },
        DSSS: { ...defaults.settings.DSSS, ...settingValues(savedSettings.DSSS) }
      },
      snr: typeof value.snr === 'number' && Number.isFinite(value.snr) ? value.snr : defaults.snr,
      noiseType: typeof value.noiseType === 'string' ? value.noiseType : defaults.noiseType,
      interferer: typeof value.interferer === 'boolean' ? value.interferer : defaults.interferer,
      interfererPower: typeof value.interfererPower === 'number' && Number.isFinite(value.interfererPower)
        ? value.interfererPower : defaults.interfererPower,
      inputDeviceId: typeof value.inputDeviceId === 'string' ? value.inputDeviceId : defaults.inputDeviceId,
      // Match the payload editor's maxlength so storage can't overflow the UI limit.
      payload: typeof value.payload === 'string' ? value.payload.slice(0, 256) : defaults.payload
    };
  } catch {
    return structuredClone(defaults);
  }
}

export function saveUserPreferences(storage: Pick<Storage, 'setItem'>, preferences: UserPreferences): boolean {
  try {
    storage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

/**
 * Test Suite settings, kept separate from the Send page's preferences so that a corrupt or outdated value on one
 * page cannot take out the other.
 */
export const EXPERIMENT_KEY = 'sonic-messaging:experiment:v1';
export interface ExperimentPreferences { config: SearchSettings; notes: string }

/**
 * Restores saved Test Suite settings, falling back to the defaults for anything that no longer validates. Running the
 * stored settings through the same validator the UI uses means a config saved by an older build — a parameter that no
 * longer exists, a range that is no longer legal — is discarded rather than loaded into a form that then refuses to
 * start.
 */
export function loadExperimentPreferences(
  storage: Pick<Storage, 'getItem'>, defaults: ExperimentPreferences
): ExperimentPreferences {
  try {
    const value: unknown = JSON.parse(storage.getItem(EXPERIMENT_KEY) ?? 'null');
    if (!record(value)) return structuredClone(defaults);
    // Match the notes editor's maxlength so storage can't overflow the UI limit.
    const notes = typeof value.notes === 'string' ? value.notes.slice(0, 4000) : defaults.notes;
    try {
      return { config: validateSearch(value.config as SearchSettings), notes };
    } catch {
      return { config: structuredClone(defaults.config), notes };
    }
  } catch {
    return structuredClone(defaults);
  }
}

export function saveExperimentPreferences(
  storage: Pick<Storage, 'setItem'>, preferences: ExperimentPreferences
): boolean {
  try {
    storage.setItem(EXPERIMENT_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}
