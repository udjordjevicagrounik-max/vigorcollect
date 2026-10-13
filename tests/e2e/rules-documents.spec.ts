import { expect, test, type Page } from '@playwright/test';

// Tasks 3.1 + 3.2 at 375 px: Admin → Rules (the Standard policy is provisioned, versions and the
// WHEN / IF / THEN form), Admin → Templates, a statement document for a customer (generated and
// previewed in the app), and the dashboard "Needs attention" section. Depends on the demo import
// of receivables.spec.ts only for the customer; it creates nothing else permanent but a document.

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test('rules, templates, a customer document and attention', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile-375', 'one end-to-end run is enough');
  test.setTimeout(120_000);

  await page.goto('/admin/rules');
  await expect(page.locator('[data-rule="std_overdue_d7"]')).toBeVisible();
  await noHorizontalOverflow(page);
  await page.locator('[data-rule="std_overdue_d7"] a').click();
  await expect(page.locator('[data-rule-editor]')).toBeVisible();
  await expect(page.locator('[data-version-status="published"]')).toBeVisible();
  await expect(page.locator('[data-trigger-offset]')).toHaveValue('7');
  await noHorizontalOverflow(page);

  await page.goto('/admin/templates');
  await expect(page.locator('[data-template="statement"]')).toBeVisible();
  await noHorizontalOverflow(page);

  await page.goto('/customers?q=Demo%20Agro');
  const card = page.locator('[data-customer-cards] a').first();
  test.skip((await card.count()) === 0, 'needs the demo import (receivables.spec.ts)');
  await card.click();
  await page.locator('[data-tab="documents"]').click();
  await expect(page.locator('[data-tab-panel="documents"] [data-generate-documents]')).toBeVisible();
  const rows = page.locator('[data-tab-panel="documents"] [data-row="statement"]');
  const before = await rows.count();
  await page.locator('[data-generate="statement"]').click();
  await expect(rows).toHaveCount(before + 1);
  await page.locator('[data-tab-panel="documents"] [data-row="statement"] a').first().click();
  await expect(page.locator('[data-document-preview]')).toContainText('Demo Agro');
  await expect(page.locator('[data-document-preview] script')).toHaveCount(0);
  await noHorizontalOverflow(page);

  await page.goto('/');
  await expect(page.locator('[data-attention]')).toBeVisible();
  await noHorizontalOverflow(page);
});
