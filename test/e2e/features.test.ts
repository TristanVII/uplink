import { test, expect } from '@playwright/test';

test('dark/light mode toggle', async ({ page }) => {
  await page.goto('/');

  const html = page.locator('html');
  const initialTheme = await html.getAttribute('class');
  const themeToggle = page.locator('#theme-toggle');

  // Toggle theme
  await themeToggle.click();
  const toggledTheme = initialTheme === 'dark' ? 'light' : 'dark';
  await expect(html).toHaveClass(toggledTheme);

  // Toggle back
  await themeToggle.click();
  await expect(html).toHaveClass(initialTheme!);
});

test('shell command execution', async ({ page }) => {
  await page.goto('/');

  const input = page.locator('#prompt-input');
  await input.fill('!echo hello world');
  await page.locator('#send-btn').click();

  const shellOutput = page.locator('.shell-output');
  await expect(shellOutput).toBeVisible({ timeout: 10000 });
  await expect(shellOutput.locator('.stdout')).toContainText('hello world');
});

test('thinking/reasoning display', async ({ page }) => {
  await page.goto('/');

  const input = page.locator('#prompt-input');
  await input.fill('reason');
  await page.locator('#send-btn').click();

  const thinking = page.locator('.tool-call-thinking');
  await expect(thinking).toBeVisible({ timeout: 10000 });

  // Verify it's a <details> element
  const tagName = await thinking.evaluate(el => el.tagName.toLowerCase());
  expect(tagName).toBe('details');

  // Verify it contains thinking text
  await expect(thinking).toContainText('think', { ignoreCase: true });
});
