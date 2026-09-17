import type { CooperativeEvent, RawResult, ReceivedFrame, SearchSettings, SentFrame, TrialSettings } from './experiment';
import { senderHex } from './dsp/frame';

/**
 * A run's results as a file: everything this device measured, heard and sent, structured for analysis rather than
 * for reading. Saved to browser storage as the run goes and downloadable as JSON, like the recordings — but where a
 * recording is the audio, this is the evidence: per-trial symbol errors and per-symbol, per-tone S/N; every control
 * frame's calibrated tone levels, room tails and FEC corrections; every transmission; and the whole wire log, each
 * with a time. Which device wrote it and in which role is on the file, because a controller and a partner see the
 * same run from opposite ends.
 */
export interface ExperimentDevice { sender: string; role: 'controller' | 'partner' | 'replay'; userAgent: string }
export interface TrialRecord {
  trial: number; sender: string; settings: TrialSettings; outcome: 'received' | 'CRC failed' | 'lost';
  /** Milliseconds since the run started. */
  at: number;
  raw?: RawResult; seq?: number;
  /** Partner only: what it heard, symbol by symbol. */
  received?: number[]; snrDb?: number[]; snrByToneDb?: number[]; confusion?: number[][];
  startPosition?: number; timingDriftMs?: number; sampleRate?: number;
}
export interface FrameRecord extends ReceivedFrame { at: number }
export interface SentRecord extends SentFrame { at: number }
export interface ExperimentResults {
  format: 'sonic-experiment'; version: 1;
  appVersion: string; createdAt: string; finishedAt?: string;
  device: ExperimentDevice;
  control: { frequencies: number[]; symbolRate: number; amplitude: number; fec: boolean };
  /** The controller's sweep; a partner has none. */
  config?: SearchSettings;
  notes: string;
  status: { phase: string; detail: string; finished: boolean };
  best?: { value: number; errors: number; symbols: number };
  trials: TrialRecord[];
  /** Every control-band frame this device heard from another, decoded or not. */
  frames: FrameRecord[];
  /** Every frame this device put on the air. */
  sent: SentRecord[];
  log: { at: number; line: string }[];
}

export interface ResultsInit {
  appVersion: string; sender: number; role: ExperimentDevice['role']; userAgent: string;
  control: { frequencies: readonly number[]; symbolRate: number; amplitude: number; fec: boolean };
  config?: SearchSettings; notes: string;
}

/** Accumulates a run's cooperative events into an ExperimentResults document. */
export class ResultsRecorder {
  readonly results: ExperimentResults;
  private readonly startedMs: number;

  constructor(init: ResultsInit, now = Date.now()) {
    this.startedMs = now;
    this.results = {
      format: 'sonic-experiment', version: 1, appVersion: init.appVersion, createdAt: new Date(now).toISOString(),
      device: { sender: senderHex(init.sender), role: init.role, userAgent: init.userAgent },
      control: { frequencies: [...init.control.frequencies], symbolRate: init.control.symbolRate, amplitude: init.control.amplitude, fec: init.control.fec },
      config: init.config, notes: init.notes,
      status: { phase: 'idle', detail: '', finished: false },
      trials: [], frames: [], sent: [], log: []
    };
  }

  private at(now: number): number { return Math.max(0, now - this.startedMs); }

  /** Notes can be edited while a run is under way; the file carries the latest. */
  setNotes(notes: string): void { this.results.notes = notes; }

  event(event: CooperativeEvent, now = Date.now()): void {
    const at = this.at(now), r = this.results;
    switch (event.kind) {
      case 'status':
        r.status = { phase: event.phase, detail: event.detail, finished: !!event.finished };
        if (event.finished || event.log) r.log.push({ at, line: event.detail });
        if (event.finished) r.finishedAt = new Date(now).toISOString();
        break;
      case 'wire': r.log.push({ at, line: event.line }); break;
      case 'measurement': {
        const m = event.measurement;
        r.trials.push({ trial: m.trial, sender: senderHex(m.sender), settings: m.settings, outcome: m.raw.crcOk ? 'received' : 'CRC failed', at,
          raw: m.raw, seq: m.seq, received: m.received, snrDb: m.snrDb, snrByToneDb: m.snrByToneDb, confusion: m.confusion,
          startPosition: m.startPosition, timingDriftMs: m.timingDriftMs, sampleRate: m.sampleRate });
        break;
      }
      case 'feedback': {
        const o = event.observation;
        r.trials.push({ trial: o.trial, sender: senderHex(o.sender), settings: o.settings, outcome: o.raw.crcOk ? 'received' : 'CRC failed', at, raw: o.raw });
        if (event.best) r.best = event.best;
        break;
      }
      case 'lost': r.trials.push({ trial: event.proposal.trial, sender: senderHex(event.proposal.sender), settings: event.proposal.settings, outcome: 'lost', at }); break;
      case 'frame': r.frames.push({ ...event.frame, at }); break;
      case 'sent': r.sent.push({ ...event.sent, at }); break;
    }
  }

  /** Marks the run over, whether it finished or was stopped. */
  finish(now = Date.now()): void {
    this.results.finishedAt ??= new Date(now).toISOString();
  }
}

export const resultsJson = (results: ExperimentResults): string => JSON.stringify(results, null, 2);
export const resultsFileName = (results: ExperimentResults): string =>
  `sonic-results-${results.device.role}-${results.createdAt.replace(/[:.]/g, '-')}.json`;
