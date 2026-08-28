import { expect, test } from '@playwright/test';

test('receiver waterfalls expose one shared captured-audio time scale', async ({ page }) => {
  await page.goto('/sonic-messaging/');
  const spectrum = page.getByTestId('spectrum-waterfall');
  const symbols = page.getByTestId('symbol-waterfall');
  await expect(spectrum).toBeVisible();
  await expect(symbols).toBeVisible();
  await expect(spectrum).toHaveAttribute('data-samples-per-css-pixel', '512');
  await expect(symbols).toHaveAttribute('data-samples-per-css-pixel', '512');
  await expect(page.getByText('RX TIME', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Microphone')).toHaveValue('default');
});

test('updates the symbol waterfall axis when tone settings change', async ({ page }) => {
  await page.goto('/sonic-messaging/');
  const labels = page.getByTestId('symbol-waterfall').locator('.labels span');
  await expect(labels).toHaveCount(4);
  await expect(labels.first()).toHaveText('S3 · 800Hz');
  await expect(labels.last()).toHaveText('S0 · 500Hz');
  await page.getByLabel('Tones').selectOption('8');
  await page.getByLabel('Lowest frequency').fill('1000');
  await page.getByLabel('Lowest frequency').press('Tab');
  await expect(labels).toHaveCount(8);
  await expect(labels.first()).toHaveText('S7 · 1700Hz');
  await expect(labels.last()).toHaveText('S0 · 1000Hz');
});

test('shows the raw bit rate for the configured symbol rate and tone count', async ({ page }) => {
  await page.goto('/sonic-messaging/');
  const bitRate = page.getByTestId('fsk-bit-rate');
  await expect(bitRate).toHaveText('50 bps');
  await page.getByLabel('Tones').selectOption('16');
  await expect(bitRate).toHaveText('100 bps');
  await page.getByLabel('Symbol rate').fill('400');
  await page.getByLabel('Symbol rate').press('Tab');
  await expect(bitRate).toHaveText('1,600 bps');
});

test('offers and applies a suggested frequency plan when the symbol rate invalidates it', async ({ page }) => {
  await page.goto('/sonic-messaging/');
  const suggest = page.getByRole('button', { name: /Use suggested plan/ });
  await expect(suggest).toHaveCount(0);
  await page.getByLabel('Symbol rate').fill('400');
  await page.getByLabel('Symbol rate').press('Tab');
  await suggest.click();
  await expect(page.getByLabel('Lowest frequency')).toHaveValue('2800');
  await expect(page.getByLabel('Tone spacing')).toHaveValue('800');
  await expect(suggest).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Lowest frequency')).toHaveValue('2800');
  await expect(page.getByLabel('Tone spacing')).toHaveValue('800');
});

test('restores user-defined modem settings after reload', async ({ page }) => {
  await page.goto('/sonic-messaging/');
  await expect(page.getByLabel('Lowest frequency')).toHaveValue('500');
  await expect(page.getByLabel('Tone spacing')).toHaveValue('100');
  await expect(page.getByLabel('Tones')).toHaveValue('4');
  await expect(page.getByLabel('Symbol rate')).toHaveValue('25');
  await expect(page.getByLabel('Waterfall scroll speed')).toHaveValue('Medium');
  await page.getByLabel('Lowest frequency').fill('4100');
  await page.getByLabel('Tone spacing').fill('900');
  await page.getByLabel('Tones').selectOption('8');
  await page.getByLabel('Symbol rate').fill('125');
  await page.getByLabel('Waterfall scroll speed').selectOption('Fast');
  await page.getByLabel(/Test payload/).fill('PERSIST ME');
  await page.getByLabel('Symbol rate').press('Tab');
  await page.reload();
  await expect(page.getByLabel(/Test payload/)).toHaveValue('PERSIST ME');
  await expect(page.getByLabel('Lowest frequency')).toHaveValue('4100');
  await expect(page.getByLabel('Tone spacing')).toHaveValue('900');
  await expect(page.getByLabel('Tones')).toHaveValue('8');
  await expect(page.getByLabel('Symbol rate')).toHaveValue('125');
  await expect(page.getByLabel('Waterfall scroll speed')).toHaveValue('Fast');
  await expect(page.getByTestId('spectrum-waterfall')).toHaveAttribute('data-samples-per-css-pixel', '256');
  await expect(page.getByTestId('symbol-waterfall')).toHaveAttribute('data-samples-per-css-pixel', '256');
});
