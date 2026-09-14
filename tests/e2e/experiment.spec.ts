import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeExperiment } from '../../src/lib/dsp/experiment';
import { encodeRecording } from '../../src/lib/audio/recording';
import { CHECKPOINT_FSK } from '../../src/lib/experiment';
import { experimentTimeline, planId, validatePlan } from '../../src/lib/experiment';
import manifest from '../../package.json' with { type: 'json' };

const sampleRate = 48000;
const plan = validatePlan({ format: 'sonic-experiment', version: 1, seed: 18, payloadBytes: 2, guardSeconds: 0.25,
  trials: [2,4].map(tones => ({ tones, lowestFrequency: 1000, spacing: 200, symbolRate: 100, amplitude: 0.8, coding: 'none' })) });
const samples = encodeExperiment(plan, sampleRate);
const header = Buffer.alloc(44), data = Buffer.alloc(samples.length * 2);
header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(data.length, 40);
for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(samples[i] * 32767), i * 2);
const dir = join(tmpdir(), 'sonic-experiment-tests'); mkdirSync(dir, { recursive: true });
const path = join(dir, 'schedule.wav'); writeFileSync(path, Buffer.concat([header, data]));
const sharedFile = { name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(plan)) };
test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${path}`] } });

test('captures a mixed FSK schedule, saves trial results with audio, and repeats the results on replay', async ({ page }) => {
  await page.goto('/sonic-messaging/');
  await expect(page.locator('.brand-copy small')).toHaveText(`v${manifest.version}`);
  await page.getByLabel('Load shared plan').setInputFiles(sharedFile);
  await page.getByRole('button', { name: 'Start experiment receiver', exact: true }).click();
  await expect(page.getByTestId('experiment-status')).toContainText('Experiment received.', { timeout: 20000 });
  await expect(page.getByTestId('experiment-summary')).toContainText('2/2 exact messages');
  await expect(page.getByTestId('experiment-summary')).toContainText('0/176 raw bit errors');
  const original = await page.getByTestId('experiment-results').innerText();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save experiment WAV', exact: true }).click();
  const download = await pending, saved = await download.path();
  if (!saved) throw new Error('Missing saved recording');
  await page.getByLabel('Load experiment WAV').setInputFiles(saved);
  await page.getByRole('button', { name: 'Replay experiment', exact: true }).click();
  await expect(page.getByTestId('experiment-status')).toContainText('Experiment replay complete.', { timeout: 20000 });
  await expect(page.getByTestId('experiment-results')).toHaveText(original, { useInnerText: true });
  const log = { format: 'sonic-transmission', version: 1, planId: planId(plan), sampleRate,
    playedSamples: experimentTimeline(plan, sampleRate)[0].end, completed: false, appVersion: manifest.version };
  await page.getByLabel('Load transmitter log').setInputFiles({ name: 'log.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(log)) });
  await expect(page.getByTestId('experiment-results')).toContainText('not-transmitted');
  await expect(page.getByTestId('experiment-summary')).toContainText('1/1 exact messages');
});

test('transmits the imported schedule at the playback sample rate and exports an exact execution log', async ({ page }) => {
  test.setTimeout(45000);
  await page.goto('/sonic-messaging/');
  await page.getByLabel('Load shared plan').setInputFiles(sharedFile);
  await page.getByRole('button', { name: 'Transmit experiment', exact: true }).click();
  await expect(page.getByTestId('experiment-status')).toContainText('Transmission complete.', { timeout: 20000 });
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save transmitter log', exact: true }).click();
  const file = await (await pending).path();
  if (!file) throw new Error('Missing log');
  const log = JSON.parse(readFileSync(file, 'utf8'));
  expect(log.planId).toBe(planId(plan));
  expect(log.completed).toBe(true);
  expect(log.playedSamples).toBe(experimentTimeline(plan, log.sampleRate).slice(-1)[0].end);
  // A replay's sample clock must not become the subsequent speaker clock.
  const replayRate = log.sampleRate === 44100 ? 48000 : 44100;
  const wav = encodeRecording({ samples: encodeExperiment(plan, replayRate), metadata: {
    format: 'sonic-recording', version: 1, appVersion: manifest.version, createdAt: '2026-09-14',
    sampleRate: replayRate, fsk: CHECKPOINT_FSK, inputSettings: {}, userAgent: 'fixture', notes: '', experiment: { plan }
  } });
  await page.getByLabel('Load experiment WAV').setInputFiles({ name: 'other-clock.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav) });
  await page.getByRole('button', { name: 'Replay experiment', exact: true }).click();
  await expect(page.getByTestId('experiment-status')).toContainText('Experiment replay complete.', { timeout: 20000 });
  await page.getByRole('button', { name: 'Transmit experiment', exact: true }).click();
  await expect(page.getByTestId('experiment-status')).toContainText('Transmission complete.', { timeout: 20000 });
  const again = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save transmitter log', exact: true }).click();
  const againFile = await (await again).path();
  if (!againFile) throw new Error('Missing second log');
  expect(JSON.parse(readFileSync(againFile, 'utf8')).sampleRate).toBe(log.sampleRate);
});

test('stopping playback produces a partial execution log', async ({ page }) => {
  await page.goto('/sonic-messaging/');
  await page.getByLabel('Load shared plan').setInputFiles(sharedFile);
  await page.getByRole('button', { name: 'Transmit experiment', exact: true }).click();
  await expect(page.getByTestId('experiment-status')).toContainText('Transmitting scheduled');
  await page.getByRole('button', { name: 'Stop experiment', exact: true }).click();
  await expect(page.getByTestId('experiment-status')).toContainText('Transmission interrupted.');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save transmitter log', exact: true }).click();
  const file = await (await pending).path();
  if (!file) throw new Error('Missing log');
  const log = JSON.parse(readFileSync(file, 'utf8'));
  expect(log.completed).toBe(false);
  expect(log.playedSamples).toBeLessThan(experimentTimeline(plan, log.sampleRate)[0].packetStart);
});
