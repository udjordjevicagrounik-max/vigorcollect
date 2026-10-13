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

  test('home: empty state with a next step before the first import, otherwise the dashboard', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('[data-mobile-class]')).toHaveAttribute(
      'data-mobile-class',
      /^(mobile-full|mobile-compact|desktop-only)$/,
    );
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // The tenant is shared with receivables.spec.ts (import in parallel): either state is valid.
    const emptyState = page.locator('section[aria-labelledby="empty-state-title"]');
    if (await emptyState.count()) {
      await expect(emptyState.getByRole('link')).toBeVisible();
    } else {
      await expect(page.locator('[data-kpi="overdue_total"]')).toBeVisible();
      await expect(page.locator('[data-kpi="overdue_total"] a')).toHaveAttribute(
        'href',
        /\/customers/,
      );
    }
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

test.describe('platform and libraries (6.4)', () => {
  test('a client tenant has no Platform item and /platform/tenants is forbidden', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('[data-nav-item="platform"]')).toHaveCount(0);
    await page.goto('/platform/tenants');
    await expect(page.locator('[data-platform-tenants]')).toHaveCount(0);
  });

  test('libraries: policy templates, generic import template (CSV), config pack', async ({
    page,
    request,
  }) => {
    await page.goto('/admin/settings/library');
    await expect(page.locator('[data-apply-template="standard"]')).toBeVisible();
    await expect(page.locator('[data-config-pack]')).toBeVisible();
    const csv = await request.get('/api/library/import-template');
    expect(csv.status()).toBe(200);
    expect(csv.headers()['content-type']).toContain('text/csv');
    expect(await csv.text()).toContain('Broj fakture');
    const pack = await request.get('/api/config-pack');
    expect(pack.status()).toBe(200);
    expect(((await pack.json()) as { version: number }).version).toBe(1);
  });
});

test.describe('navigation items (preview finding, 2026-10-13)', () => {
  test('Disputes opens the invoice list filtered to disputed; Fields is under Administration', async ({
    page,
  }) => {
    await page.goto('/');
    const disputes = page.locator('[data-nav-group="work"] [data-nav-item="disputes"]');
    await expect(disputes).toHaveAttribute('href', '/invoices?disputed=only');
    await expect(page.locator('[data-nav-group="admin"] [data-nav-item="fields"]')).toHaveAttribute(
      'href',
      '/admin/settings/fields',
    );
    await disputes.click();
    await expect(page).toHaveURL(/\/invoices\?disputed=only$/);
    await expect(page.locator('select[name="disputed"]')).toHaveValue('only');
  });
});
