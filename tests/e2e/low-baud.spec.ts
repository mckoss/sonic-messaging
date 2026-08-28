import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { encodeFsk } from '../../src/lib/dsp/fsk';

const SAMPLE_RATE = 48_000;
const PAYLOAD = 'HI!';
const CONFIG = { sampleRate: SAMPLE_RATE, symbolRate: 10, frequencies: [500, 600, 700, 800] };

function toWav(samples: Float32Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[index])) * 0x7fff), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function buildCaptureFile(): string {
  const burst = encodeFsk(new TextEncoder().encode(PAYLOAD), CONFIG).samples;
  const silence = Math.round(SAMPLE_RATE * 0.4);
  const samples = new Float32Array(silence + burst.length + silence);
  samples.set(burst, silence);
  const directory = join(tmpdir(), 'sonic-messaging-e2e');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'fsk-low-baud-capture.wav');
  writeFileSync(path, toWav(samples, SAMPLE_RATE));
  return path;
}

test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${buildCaptureFile()}`
    ]
  }
});

test('decodes a 10 baud packet live, spanning multi-second sync acquisition', async ({ page }) => {
  await page.goto('/sonic-messaging/');
  await page.getByLabel('Symbol rate').fill(String(CONFIG.symbolRate));
  await page.getByLabel('Symbol rate').press('Tab');
  await page.getByRole('button', { name: 'Start listening' }).click();
  // 16 sync symbols alone take 1.6 s; the 44-symbol frame about 4.4 s.
  await expect(page.getByTestId('symbol-waterfall')).toContainText(`${PAYLOAD} ✓`, { timeout: 25_000 });
});
