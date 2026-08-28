import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { encodeFsk } from '../../src/lib/dsp/fsk';

const SAMPLE_RATE = 48_000;
const PAYLOAD = 'HI!';
const CONFIG = { sampleRate: SAMPLE_RATE, symbolRate: 100, frequencies: [500, 600, 700, 800] };

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
  const path = join(directory, 'fsk-capture.wav');
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

test('streams decoded characters into the RX lane and paints RX TIME markers', async ({ page }) => {
    await page.goto('/sonic-messaging/');
    await page.getByLabel('Symbol rate').fill(String(CONFIG.symbolRate));
    await page.getByLabel('Symbol rate').press('Tab');
    await page.getByRole('button', { name: 'Start listening' }).click();

    const waterfall = page.getByTestId('symbol-waterfall');
    await expect(waterfall).toContainText(`${PAYLOAD} ✓`, { timeout: 20_000 });

    const paintedPixels = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        '[data-testid="symbol-waterfall"] .timeline-history canvas'
      );
      if (!canvas) return -1;
      const ctx = canvas.getContext('2d');
      if (!ctx) return -1;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index] !== 5 || data[index + 1] !== 10 || data[index + 2] !== 24) painted++;
      }
      return painted;
    });
    expect(paintedPixels).toBeGreaterThan(50);

    const detector = page.locator('[data-testid="symbol-waterfall"] .detector');
    const box = await detector.boundingBox();
    if (!box) throw new Error('detector lane not laid out');
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 240, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const live = page.getByRole('button', { name: /LIVE/ });
    await expect(live.first()).toBeVisible();
    await live.first().click();
    await expect(live).toHaveCount(0);
});

test('sweeps a playback cursor across the waterfalls while replaying visible audio', async ({ page }) => {
    await page.goto('/sonic-messaging/');
    await page.getByLabel('Symbol rate').fill(String(CONFIG.symbolRate));
    await page.getByLabel('Symbol rate').press('Tab');
    await page.getByRole('button', { name: 'Start listening' }).click();
    await expect(page.getByTestId('symbol-waterfall')).toContainText(`${PAYLOAD} ✓`, { timeout: 20_000 });

    await page.getByRole('button', { name: '▶ Replay visible audio' }).click();
    const sweeps = page.getByTestId('replay-sweep');
    await expect(sweeps).toHaveCount(2, { timeout: 5_000 });

    const sweep = sweeps.first();
    const leftAt = async () => parseFloat(await sweep.evaluate(element => (element as HTMLElement).style.left));
    const first = await leftAt();
    await page.waitForTimeout(800);
    const second = await leftAt();
    expect(second).toBeGreaterThan(first);
});
