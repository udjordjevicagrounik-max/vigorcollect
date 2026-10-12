import { expect, test, type Page } from '@playwright/test';
import { demoCsv } from '../../scripts/demo-import/generate';

// Task 2.4 at 375 px, one end-to-end run: import the demo CSV (the job worker applies it) →
// customer list → Customer 360 → open a case → promise on the case → payment marked by hand →
// the promise is fulfilled. Amounts are typed the Serbian way ("1.000,00").

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const today = () => new Date().toISOString().slice(0, 10);

test('import → customers → 360 → case → promise → payment → promise fulfilled', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'mobile-375', 'one end-to-end run is enough');
  test.setTimeout(180_000);

  // 1. Import the demo file.
  await page.goto('/import');
  await expect(page.locator('[data-mobile-class="mobile-compact"]')).toBeVisible();
  await page.locator('#import-file-input').setInputFiles({
    name: 'fakture-demo.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(demoCsv(new Date(), 'EUR'), 'utf8'),
  });
  await page.locator('[data-import-step="1"] button.bg-brand-green').click();
  await expect(page.locator('[data-import-step="2"]')).toBeVisible();
  await expect(page.locator('[data-map-field="customer_tax_id"] select')).not.toHaveValue('');
  await noHorizontalOverflow(page);
  await page.locator('[data-import-step="2"] button.bg-brand-green').click();
  await expect(page.locator('[data-preview-valid]')).toHaveText('22');
  await noHorizontalOverflow(page);
  await page.locator('[data-import-step="3"] button.bg-brand-green').click();
  await expect(page.locator('[data-import-done]')).toBeVisible({ timeout: 60_000 });
  await noHorizontalOverflow(page);

  // 2. Customer list → search → Customer 360.
  await page.goto('/customers?q=Demo%20Agro');
  await noHorizontalOverflow(page);
  await page.locator('[data-customer-cards] a').first().click();
  await expect(page.locator('[data-customer-name]')).toContainText('Demo Agro');
  await expect(page.locator('[data-kpi="overdue"]')).not.toHaveText('');
  await noHorizontalOverflow(page);

  // 3. Open a case with the first open invoice.
  await page.locator('[data-action="case"] summary').click();
  await page.locator('[data-case-invoice]').first().check();
  await page.locator('[data-action="case"] button[type="submit"]').click();
  await expect(page.locator('[role="status"], .text-status-success-fg').first()).toBeVisible();
  await page.locator('[data-tab="cases"]').click();
  await page.locator('[data-tab-panel="cases"] li a').first().click();
  await expect(page.locator('[data-case-title]')).toBeVisible();
  await expect(page.locator('[data-timeline="case.opened"]')).toContainText(/Case otvoren|Case opened/);
  await noHorizontalOverflow(page);

  // 4. A promise on the case, due today.
  await page.locator('[data-action="promise"] summary').click();
  await page.locator('[data-action="promise"] input[name="amount"]').fill('1.000,00');
  await page.locator('[data-action="promise"] input[name="promisedOn"]').fill(today());
  await page.locator('[data-action="promise"] button[type="submit"]').click();
  await expect(page.locator('[data-timeline="promise.created"]')).toBeVisible();

  // 5. Back on the customer: mark a payment of the promised amount.
  await page.locator('header a').first().click();
  await expect(page.locator('[data-customer-name]')).toContainText('Demo Agro');
  await page.locator('[data-action="payment"] summary').click();
  await page.locator('[data-action="payment"] input[name="amount"]').fill('1.000,00');
  await page.locator('[data-action="payment"] button[type="submit"]').click();
  await expect(page.locator('.text-status-success-fg, [role="status"]').first()).toBeVisible();

  // 6. The promise is fulfilled.
  await page.locator('[data-tab="promises"]').click();
  await expect(page.locator('[data-promise-status="fulfilled"]').first()).toBeVisible();
  await noHorizontalOverflow(page);
});
