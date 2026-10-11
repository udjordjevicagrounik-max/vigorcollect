import { expect, test } from '@playwright/test';

test.describe('app shell', () => {
  test('renders nav groups with Resolution hidden while settlement flags are off', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('[data-nav-group="work"]')).toBeVisible();
    await expect(page.locator('[data-nav-group="intelligence"]')).toBeVisible();
    await expect(page.locator('[data-nav-group="admin"]')).toBeVisible();
    // Rule 31: hidden, not disabled — the element must not exist at all.
    await expect(page.locator('[data-nav-group="resolution"]')).toHaveCount(0);
  });

  test('home shows an empty state with a next-step action and a declared mobile class', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('[data-mobile-class]')).toHaveAttribute(
      'data-mobile-class',
      /^(mobile-full|mobile-compact|desktop-only)$/,
    );
    const emptyState = page.locator('section[aria-labelledby="empty-state-title"]');
    await expect(emptyState.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(emptyState.getByRole('link')).toBeVisible();
  });

  test('no horizontal overflow', async ({ page }) => {
    await page.goto('/');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('locale follows Accept-Language (sr → sr-Latn, otherwise en)', async ({ browser }) => {
    const sr = await browser.newContext({ locale: 'sr-Latn-RS' });
    const srPage = await sr.newPage();
    await srPage.goto('/');
    await expect(srPage.locator('html')).toHaveAttribute('lang', 'sr-Latn');
    await sr.close();

    const de = await browser.newContext({ locale: 'de-DE' });
    const dePage = await de.newPage();
    await dePage.goto('/');
    await expect(dePage.locator('html')).toHaveAttribute('lang', 'en');
    await de.close();
  });

  test('unknown route shows not-found with a way back', async ({ page }) => {
    const res = await page.goto('/does-not-exist');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('link', { name: /./ }).last()).toHaveAttribute('href', '/');
  });
});
