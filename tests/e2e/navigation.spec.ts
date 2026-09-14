import { expect, test } from '@playwright/test';

test('switches between four accessible workspace views and preserves signal state', async ({ page }) => {
  await page.goto('/sonic-messaging/');

  const tabs = page.getByRole('tablist', { name: 'Application mode' }).getByRole('tab');
  await expect(tabs).toHaveCount(4);
  await expect(page.getByRole('tab', { name: /Send Single/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  await page.getByLabel(/Test payload/).fill('STATE SURVIVES');

  await page.getByRole('tab', { name: /Receive/ }).click();
  await expect(page.getByRole('heading', { name: 'Receiver' })).toBeVisible();
  await expect(page.getByRole('tabpanel')).toHaveCount(1);

  await page.getByRole('tab', { name: /Simulation/ }).click();
  await expect(page.getByRole('heading', { name: 'Channel simulation' })).toBeVisible();
  await expect(page.getByText('FSK · 14 byte payload')).toBeVisible();

  await page.getByRole('tab', { name: /Test Suite/ }).click();
  await expect(page.getByRole('heading', { name: 'Cooperative FSK experiment' })).toBeVisible();
  await page.getByRole('tab', { name: /Send Single/ }).click();
  await expect(page.getByLabel(/Test payload/)).toHaveValue('STATE SURVIVES');
});

test('supports keyboard tab navigation without horizontal page overflow', async ({ page }) => {
  await page.goto('/sonic-messaging/');
  const send = page.getByRole('tab', { name: /Send Single/ });
  await send.focus();
  await send.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /Receive/ })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Receiver' })).toBeVisible();
  await page.getByRole('tab', { name: /Receive/ }).press('End');
  await expect(page.getByRole('tab', { name: /Test Suite/ })).toBeFocused();
  await page.getByRole('tab', { name: /Test Suite/ }).press('Home');
  await expect(send).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
