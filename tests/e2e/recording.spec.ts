import { expect, test } from '@playwright/test';
import { encodeRecording } from '../../src/lib/audio/recording';
import manifest from '../../package.json' with { type: 'json' };
import { encodeFsk } from '../../src/lib/dsp/fsk';

const sampleRate = 44100, fsk = { frequencies: [1000, 1200, 1400, 1600], symbolRate: 100 };
const burst = encodeFsk(new TextEncoder().encode('REPLAY'), { sampleRate, ...fsk }).samples;
const samples = new Float32Array(burst.length + 16000); samples.set(burst, 8000);
const buffer = Buffer.from(encodeRecording({ samples, metadata: {
  format: 'sonic-recording', version: 1, createdAt: '2026-09-13T00:00:00Z', appVersion: 'fixture',
  sampleRate, fsk, inputSettings: {}, userAgent: 'test fixture', notes: 'Known packet at 44.1 kHz'
} }));

test('imports and repeatedly decodes original samples without microphone or speaker access', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new Error('Replay must not request a microphone'); };
    window.AudioContext = class { constructor() { throw new Error('Replay must not open audio hardware'); } } as unknown as typeof AudioContext;
  });
  await page.goto('/sonic-messaging/');
  await expect(page.locator('.brand-copy small')).toHaveText(`v${manifest.version}`);
  await page.getByLabel('Load recording WAV').setInputFiles({ name: 'fixture.wav', mimeType: 'audio/wav', buffer });
  await expect(page.getByLabel('Symbol rate')).toHaveValue('100');
  await expect(page.getByLabel('Lowest frequency')).toHaveValue('1000');
  for (let run = 0; run < 2; run++) {
    await page.getByRole('button', { name: '▶ Decode recording', exact: true }).click();
    await expect(page.getByTestId('recording-status')).toHaveText('Replay complete.');
    await expect(page.getByTestId('recording-results')).toContainText('1 CRC-valid packets · 0 CRC failures');
    await expect(page.getByTestId('symbol-waterfall')).toContainText('REPLAY ✓');
  }
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save recording WAV' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.wav$/);
});

test('rejects a malformed recording and can cancel then restart a valid replay', async ({ page }) => {
  await page.goto('/sonic-messaging/');
  await expect(page.locator('.brand-copy small')).toHaveText(`v${manifest.version}`);
  const input = page.getByLabel('Load recording WAV');
  await input.setInputFiles({ name: 'broken.wav', mimeType: 'audio/wav', buffer: Buffer.from('broken') });
  await expect(page.getByRole('alert')).toContainText('Load a lossless WAV');
  await input.setInputFiles({ name: 'fixture.wav', mimeType: 'audio/wav', buffer });
  await page.getByRole('button', { name: '▶ Decode recording', exact: true }).click();
  await page.getByRole('button', { name: '■ Stop decoding', exact: true }).click();
  await expect(page.getByTestId('recording-status')).toHaveText('Replay stopped.');
  await page.getByRole('button', { name: '▶ Decode recording', exact: true }).click();
  await expect(page.getByTestId('recording-status')).toHaveText('Replay complete.');
  await expect(page.getByTestId('recording-results')).toContainText('1 CRC-valid packets');
});
