import { describe, expect, it } from 'vitest';
import { ResultsRecorder, resultsFileName, resultsJson } from './experiment-results';
import { CONTROL_FSK, defaultSearch, validateSearch, type TrialMeasurement } from './experiment';

const config = validateSearch(defaultSearch());
const measurement: TrialMeasurement = {
  sender: 0x02cf, trial: 0, settings: config.trial, seq: 2, received: [1, 2, 3], snrDb: [12, 14, 9], snrByToneDb: [12, 14, 9, 8],
  raw: { symbolErrors: 1, symbols: 64, bitErrors: 1, bits: 128, confidence: 0.9, snrMedianDb: 12, crcOk: true },
  sampleRate: 48000, startPosition: 96000, timingDriftMs: 0.4, confusion: [[19, 0, 0, 0], [0, 15, 0, 0], [0, 0, 18, 1], [0, 0, 0, 11]]
};
const start = Date.parse('2026-09-17T18:00:00.000Z');
const init = { appVersion: '6.10.0', sender: 0x42d7, role: 'partner' as const, userAgent: 'test', control: { ...CONTROL_FSK, fec: true }, notes: 'two feet' };

describe('experiment results files', () => {
  it('names the device that wrote the file and the role it played', () => {
    const recorder = new ResultsRecorder(init, start);
    expect(recorder.results).toMatchObject({ format: 'sonic-experiment', version: 1, appVersion: '6.10.0', createdAt: '2026-09-17T18:00:00.000Z',
      device: { sender: '42D7', role: 'partner', userAgent: 'test' }, control: { frequencies: CONTROL_FSK.frequencies, symbolRate: 25, fec: true }, notes: 'two feet' });
    expect(recorder.results.config).toBeUndefined();
    expect(resultsFileName(recorder.results)).toBe('sonic-results-partner-2026-09-17T18-00-00-000Z.json');
    const controller = new ResultsRecorder({ ...init, role: 'controller', config }, start);
    expect(controller.results.config).toEqual(config);
  });

  it('records trials in full detail, frames with what the receiver learned, transmissions and the log, each timed', () => {
    const recorder = new ResultsRecorder(init, start);
    recorder.event({ kind: 'wire', line: '<- 02CF#1 test_suite(…)' }, start + 1000);
    recorder.event({ kind: 'frame', frame: { sender: '02CF', seq: 1, frameType: 1, typeName: 'control', crcOk: true, payloadLength: 42, fec: true, fecCorrected: 3, fecSymbols: 420,
      levelsDb: [0, -1, -2, -10], tails: [0.06, 0, 0.01, 0.03], confidence: 0.9, timingDriftMs: 0.3, startPosition: 1000, endPosition: 2000, text: 'test_suite(…)' } }, start + 1000);
    recorder.event({ kind: 'sent', sent: { seq: 7, kind: 'ack', attempt: 0, line: '-> 42D7#7 ACK 02CF#1' } }, start + 8000);
    recorder.event({ kind: 'measurement', measurement }, start + 15000);
    recorder.event({ kind: 'lost', proposal: { sender: 0x02cf, trial: 1, settings: config.trial } }, start + 40000);
    recorder.event({ kind: 'status', phase: 'listening', detail: 'Controller finished; still listening for the next run.', log: true }, start + 50000);
    const r = recorder.results;
    expect(r.log.map(l => [l.at, l.line])).toEqual([[1000, '<- 02CF#1 test_suite(…)'], [50000, 'Controller finished; still listening for the next run.']]);
    expect(r.frames).toEqual([expect.objectContaining({ at: 1000, sender: '02CF', fec: true, fecCorrected: 3, fecSymbols: 420, levelsDb: [0, -1, -2, -10], text: 'test_suite(…)' })]);
    expect(r.sent).toEqual([{ at: 8000, seq: 7, kind: 'ack', attempt: 0, line: '-> 42D7#7 ACK 02CF#1' }]);
    expect(r.trials).toEqual([
      expect.objectContaining({ at: 15000, trial: 0, sender: '02CF', outcome: 'received', raw: measurement.raw, snrDb: [12, 14, 9], snrByToneDb: [12, 14, 9, 8], confusion: measurement.confusion, received: [1, 2, 3], timingDriftMs: 0.4 }),
      expect.objectContaining({ at: 40000, trial: 1, outcome: 'lost' })
    ]);
    expect(r.status).toEqual({ phase: 'listening', detail: 'Controller finished; still listening for the next run.', finished: false });
    expect(r.finishedAt).toBeUndefined();
  });

  it('closes the document when the run finishes or is stopped, and serialises as readable JSON', () => {
    const finished = new ResultsRecorder(init, start);
    finished.event({ kind: 'status', phase: 'complete', detail: 'Search complete.', finished: true }, start + 90000);
    expect(finished.results.finishedAt).toBe('2026-09-17T18:01:30.000Z');
    expect(finished.results.status.finished).toBe(true);
    const stopped = new ResultsRecorder(init, start);
    stopped.finish(start + 5000);
    expect(stopped.results.finishedAt).toBe('2026-09-17T18:00:05.000Z');
    stopped.finish(start + 9000);
    expect(stopped.results.finishedAt).toBe('2026-09-17T18:00:05.000Z');
    const parsed = JSON.parse(resultsJson(stopped.results));
    expect(parsed).toEqual(stopped.results);
    expect(resultsJson(stopped.results)).toContain('\n  "device": {');
  });

  it('keeps the latest notes and the controller\'s best value', () => {
    const recorder = new ResultsRecorder({ ...init, role: 'controller', config }, start);
    recorder.event({ kind: 'feedback', observation: { sender: 0x42d7, trial: 0, settings: config.trial, raw: measurement.raw }, best: { value: 1500, errors: 1, symbols: 64 } }, start + 20000);
    recorder.setNotes('two feet, phone on the desk');
    expect(recorder.results.best).toEqual({ value: 1500, errors: 1, symbols: 64 });
    expect(recorder.results.notes).toBe('two feet, phone on the desk');
    expect(recorder.results.trials[0]).toMatchObject({ outcome: 'received', raw: measurement.raw });
    // The controller only ever learns the counts a result carries; the partner's per-symbol detail is not invented.
    expect('snrDb' in recorder.results.trials[0]).toBe(false);
  });
});
