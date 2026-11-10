import { expect, test } from '@playwright/test';

test('generated starter renders locally without third-party requests or browser errors', async ({ page }) => {
  const externalRequests = [];
  const pageErrors = [];
  const appOrigin = new URL(test.info().project.use.baseURL).origin;
  page.on('request', request => {
    if (new URL(request.url()).origin !== appOrigin) externalRequests.push(request.url());
  });
  page.on('pageerror', error => pageErrors.push(error.message));

  const response = await page.goto('/');
  expect(response?.ok()).toBe(true);
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome');
  await expect(page.locator('h1')).toHaveCount(1);
  expect(externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
