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
});
