import { expect, test, type Page } from '@playwright/test';
import { fskSuggestedPlan, fskToneSet } from '../../src/lib/dsp/fsk-frequencies';

/** The scale follows the receiver's measured width, which settles a frame or more after the tab is shown. */
async function settledWaterfallScale(page: Page): Promise<number> {
  let previous: string | null = null;
  await expect.poll(async () => {
    const symbols = await page.getByTestId('symbol-waterfall').getAttribute('data-samples-per-css-pixel');
    const spectrum = await page.getByTestId('spectrum-waterfall').getAttribute('data-samples-per-css-pixel');
    const settled = symbols !== null && symbols === spectrum && symbols === previous;
    previous = symbols;
    return settled;
  }, { intervals: [100] }).toBe(true);
  return Number(previous);
}

test('receiver waterfalls expose one shared captured-audio time scale', async ({ page }) => {
  await page.goto('/sonic-messaging/#receive');
  const spectrum = page.getByTestId('spectrum-waterfall');
  const symbols = page.getByTestId('symbol-waterfall');
  await expect(spectrum).toBeVisible();
  await expect(symbols).toBeVisible();
  // Scroll speed derives from the symbol rate; both lanes must share the scale.
  const scale = await spectrum.getAttribute('data-samples-per-css-pixel');
  expect(Number(scale)).toBeGreaterThan(0);
  await expect(symbols).toHaveAttribute('data-samples-per-css-pixel', scale!);
  await expect(page.getByText('RX TIME', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Microphone')).toHaveValue('default');
});

test('updates the symbol waterfall axis when tone settings change', async ({ page }) => {
  await page.goto('/sonic-messaging/#receive');
  const labels = page.getByTestId('symbol-waterfall').locator('.labels span');
  await expect(labels).toHaveCount(4);
  const defaultTones = fskToneSet(1500, 25, 4);
  await expect(labels.first()).toHaveText(`S3 · ${defaultTones[3]}Hz`);
  await expect(labels.last()).toHaveText(`S0 · ${defaultTones[0]}Hz`);
  await page.getByRole('tab', { name: /Send Single/ }).click();
  await page.locator('.composer').getByLabel('Tones').selectOption('8');
  await page.locator('.composer').getByLabel('Lowest frequency').fill('1000');
  await page.locator('.composer').getByLabel('Lowest frequency').press('Tab');
  await page.getByRole('tab', { name: /Receive/ }).click();
  await expect(labels).toHaveCount(8);
  const eight = fskToneSet(1000, 25, 8);
  await expect(labels.first()).toHaveText(`S7 · ${eight[7]}Hz`);
  await expect(labels.last()).toHaveText(`S0 · ${eight[0]}Hz`);
});

test('zooms the spectrogram to the tone band plus a 10% margin per side', async ({ page }) => {
  await page.goto('/sonic-messaging/#receive');
  const axis = page.getByTestId('spectrum-waterfall').locator('.axis span');
  // The tone plan's own band, plus a 10% margin on each side.
  const kHz = (tones: number[], edge: 'low' | 'high') => {
    const span = tones[tones.length - 1] - tones[0], margin = span * 0.1;
    const hz = edge === 'low' ? tones[0] - margin : tones[tones.length - 1] + margin;
    return `${(hz / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} kHz`;
  };
  const four = fskToneSet(1500, 25, 4);
  await expect(axis.first()).toHaveText(kHz(four, 'high'));
  await expect(axis.last()).toHaveText(kHz(four, 'low'));
  await page.getByRole('tab', { name: /Send Single/ }).click();
  await page.locator('.composer').getByLabel('Tones').selectOption('16');
  await page.getByRole('tab', { name: /Receive/ }).click();
  const sixteen = fskToneSet(1500, 25, 16);
  await expect(axis.first()).toHaveText(kHz(sixteen, 'high'));
  await expect(axis.last()).toHaveText(kHz(sixteen, 'low'));
});

test('shows the raw bit rate for the configured symbol rate and tone count', async ({ page }) => {
  await page.goto('/sonic-messaging/');
  const bitRate = page.getByTestId('fsk-bit-rate');
  await expect(bitRate).toHaveText('50 bps');
  await page.locator('.composer').getByLabel('Tones').selectOption('16');
  await expect(bitRate).toHaveText('100 bps');
  await page.getByLabel('Symbol rate').fill('400');
  await page.getByLabel('Symbol rate').press('Tab');
  await expect(bitRate).toHaveText('1,600 bps');
});

test('offers and applies a suggested frequency plan when the symbol rate invalidates it', async ({ page }) => {
  await page.goto('/sonic-messaging/');
  const suggest = page.getByRole('button', { name: /Use suggested base/ });
  await expect(suggest).toHaveCount(0);
  await page.getByLabel('Symbol rate').fill('400');
  await page.getByLabel('Symbol rate').press('Tab');
  const suggested = String(fskSuggestedPlan(400, 4)!.lowestFrequency);
  await suggest.click();
  await expect(page.locator('.composer').getByLabel('Lowest frequency')).toHaveValue(suggested);
  await expect(suggest).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.composer').getByLabel('Lowest frequency')).toHaveValue(suggested);
});

test('restores user-defined modem settings after reload', async ({ page }) => {
  await page.goto('/sonic-messaging/');
  await expect(page.locator('.composer').getByLabel('Lowest frequency')).toHaveValue('1500');
  await expect(page.locator('.composer').getByLabel('Tones')).toHaveValue('4');
  await expect(page.getByLabel('Symbol rate')).toHaveValue('25');
  await page.getByRole('tab', { name: /Receive/ }).click();
  const slowScale = await settledWaterfallScale(page);
  await page.getByRole('tab', { name: /Send Single/ }).click();
  await page.locator('.composer').getByLabel('Lowest frequency').fill('4100');
  await page.locator('.composer').getByLabel('Tones').selectOption('8');
  await page.getByLabel('Symbol rate').fill('125');
  await page.getByLabel(/Test payload/).fill('PERSIST ME');
  await page.getByLabel('Symbol rate').press('Tab');
  await page.reload();
  await expect(page.getByLabel(/Test payload/)).toHaveValue('PERSIST ME');
  await expect(page.locator('.composer').getByLabel('Lowest frequency')).toHaveValue('4100');
  await expect(page.locator('.composer').getByLabel('Tones')).toHaveValue('8');
  await expect(page.getByLabel('Symbol rate')).toHaveValue('125');
  // The 5x symbol rate scrolls 5x faster (fewer samples per pixel), same on both lanes.
  await page.getByRole('tab', { name: /Receive/ }).click();
  const fastScale = await settledWaterfallScale(page);
  expect(fastScale).toBeLessThan(slowScale);
  // A hidden Receive tab measures 0 px wide; that must not rescale (and clear) the waterfalls.
  await page.getByRole('tab', { name: /Send Single/ }).click();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('symbol-waterfall')).toHaveAttribute('data-samples-per-css-pixel', String(fastScale), { timeout: 0 });
});
