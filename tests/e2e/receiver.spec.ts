import { expect, test } from '@playwright/test';

test('receiver waterfalls expose one shared captured-audio time scale', async ({ page }) => {
  await page.goto('/sonic-messaging/');
  const spectrum = page.getByTestId('spectrum-waterfall');
  const symbols = page.getByTestId('symbol-waterfall');
  await expect(spectrum).toBeVisible();
  await expect(symbols).toBeVisible();
  await expect(spectrum).toHaveAttribute('data-samples-per-css-pixel', '256');
  await expect(symbols).toHaveAttribute('data-samples-per-css-pixel', '256');
  await expect(page.getByText('RX TIME', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Microphone')).toHaveValue('default');
});

test('updates the symbol waterfall axis when tone settings change', async ({ page }) => {
  await page.goto('/sonic-messaging/');
  const labels = page.getByTestId('symbol-waterfall').locator('.labels span');
  await expect(labels).toHaveCount(4);
  await expect(labels.first()).toHaveText('S0 · 500Hz');
  await page.getByLabel('Tones').selectOption('8');
  await page.getByLabel('Lowest frequency').fill('1000');
  await page.getByLabel('Lowest frequency').press('Tab');
  await expect(labels).toHaveCount(8);
  await expect(labels.first()).toHaveText('S0 · 1000Hz');
});

test('restores user-defined modem settings after reload', async ({ page }) => {
  await page.goto('/sonic-messaging/');
  await expect(page.getByLabel('Lowest frequency')).toHaveValue('500');
  await expect(page.getByLabel('Tone spacing')).toHaveValue('100');
  await expect(page.getByLabel('Tones')).toHaveValue('4');
  await expect(page.getByLabel('Symbol rate')).toHaveValue('25');
  await expect(page.getByLabel('Confidence threshold')).toHaveValue('80');
  await expect(page.getByLabel('Waterfall scroll speed')).toHaveValue('Medium');
  await page.getByLabel('Lowest frequency').fill('4100');
  await page.getByLabel('Tone spacing').fill('900');
  await page.getByLabel('Tones').selectOption('8');
  await page.getByLabel('Symbol rate').fill('125');
  await page.getByLabel('Confidence threshold').fill('22');
  await page.getByLabel('Waterfall scroll speed').selectOption('Fast');
  await page.getByLabel('Symbol rate').press('Tab');
  await page.reload();
  await expect(page.getByLabel('Lowest frequency')).toHaveValue('4100');
  await expect(page.getByLabel('Tone spacing')).toHaveValue('900');
  await expect(page.getByLabel('Tones')).toHaveValue('8');
  await expect(page.getByLabel('Symbol rate')).toHaveValue('125');
  await expect(page.getByLabel('Confidence threshold')).toHaveValue('22');
  await expect(page.getByLabel('Waterfall scroll speed')).toHaveValue('Fast');
  await expect(page.getByTestId('spectrum-waterfall')).toHaveAttribute('data-samples-per-css-pixel', '128');
  await expect(page.getByTestId('symbol-waterfall')).toHaveAttribute('data-samples-per-css-pixel', '128');
});
