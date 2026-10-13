import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { Client } from 'pg';
import { totp } from '../golden/db/auth-client';
import { e2eDatabaseUrls, waitForCaptcha } from './e2e-env';
import { E2E } from './global-setup';

// Task 3.3 at 375 px (rules 11 and 19): Standard D+90 proposes a legal handover → the owner runs
// the daily job from Admin → System status (instead of waiting for 06:00) → the proposal is in
// "Needs attention" → "Submit for approval" → a pending request → ANOTHER person (the checker,
// own sign-in with MFA) approves it → the case is with the legal department.

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function withTenant<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: e2eDatabaseUrls().migrate });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [E2E.tenantId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

/** The checker signs in through the real screens (login → MFA setup) in its own context. */
async function checkerPage(browser: Browser): Promise<Page> {
  // Fresh cookies: the project's storageState (the owner's session) must not leak in.
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  const email = process.env.E2E_CHECKER_EMAIL ?? '';
  const password = process.env.E2E_CHECKER_PASSWORD ?? '';
  expect(email).not.toBe('');
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await waitForCaptcha(page);
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/settings\/mfa-setup$/);
  await page.locator('#password').fill(password);
  await page.locator('form button[type="submit"]').click();
  await page.locator('details summary').click();
  const secret = (await page.getByTestId('totp-secret').textContent())?.trim() ?? '';
  await page.locator('#code').fill(totp(`otpauth://totp/e2e?secret=${secret}`));
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/$/);
  return page;
}

test('rule D+90 → proposal → submit → pending approval → checker approves', async ({
  page,
  browser,
}, info) => {
  test.skip(info.project.name !== 'mobile-375', 'one end-to-end run is enough');
  test.setTimeout(180_000);

  const name = `E2E Pravna ${randomUUID().slice(0, 6)}`;
  const customerId = await withTenant(async (c) => {
    const le = await c.query<{ id: string }>(
      `SELECT find_or_create_legal_entity('XX', $1, $2, 'UTC', NULL) AS id`,
      [`E2E-L-${randomUUID().slice(0, 10)}`, name],
    );
    const cu = await c.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, legal_entity_id, display_name, owner_user_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [E2E.tenantId, le.rows[0]?.id, name, E2E.userId],
    );
    const inv = await c.query(
      `INSERT INTO invoices (tenant_id, company_id, customer_id, source_id, external_id, number, issue_date, due_date,
                             currency, amount_total, amount_open)
       SELECT $1, $2, $3, s.id, $4, $4, current_date - 120, current_date - 90, 'EUR', '9100.00', '9100.00'
       FROM data_sources s WHERE s.name = 'file-import'`,
      [E2E.tenantId, E2E.companyId, cu.rows[0]?.id, `E2E-L-${randomUUID().slice(0, 8)}`],
    );
    expect(inv.rowCount).toBe(1);
    return cu.rows[0]?.id ?? '';
  });

  // Admin → System status: run today's daily job now (the worker picks it up from the outbox).
  await page.goto('/admin/status');
  await expect(page.locator('[data-daily-run]')).toBeVisible();
  await noHorizontalOverflow(page);
  await page.locator('[data-daily-run] button').click();
  await expect(page.locator('[data-daily-run] [role="status"]')).toBeVisible();

  // The rule's proposal appears in "Needs attention" (worker: outbox poll + run).
  // The same daily run also scores risk, so the customer may have a credit status proposal too.
  const item = page.locator(
    '[data-attention-item="rule_proposal"][data-attention-code="legal_handover"]',
    {
      hasText: name,
    },
  );
  await expect(async () => {
    await page.goto('/');
    await expect(item).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
  await noHorizontalOverflow(page);
  await item.locator('[data-proposal-submit]').click();
  // Submitted: the item leaves the list (refresh) and a pending request exists.
  await expect(item).toHaveCount(0);

  const approval = await withTenant(async (c) => {
    const r = await c.query<{ id: string; status: string; requested_by: string }>(
      `SELECT a.id, a.status, a.requested_by FROM approval_requests a
       JOIN decisions d ON d.approval_request_id = a.id
       WHERE d.customer_id = $1 AND d.source = 'rule' AND a.action_type = 'case.legal_handover'`,
      [customerId],
    );
    return r.rows[0];
  });
  expect(approval).toMatchObject({ status: 'pending', requested_by: E2E.userId });

  // The maker cannot decide their own request.
  await page.goto('/admin/approvals');
  const mine = page.locator(`[data-approval="${approval?.id}"]`);
  await expect(mine).toBeVisible();
  await expect(mine.getByRole('button')).toHaveCount(0);

  // The checker approves.
  const checker = await checkerPage(browser);
  await checker.goto('/admin/approvals');
  const theirs = checker.locator(`[data-approval="${approval?.id}"]`);
  await expect(theirs).toBeVisible();
  await noHorizontalOverflow(checker);
  await theirs.getByRole('button').first().click();
  await expect(theirs).toHaveCount(0);
  await checker.context().close();

  const after = await withTenant(async (c) => {
    const d = await c.query<{ status: string; approved_by: string | null; stage: string }>(
      `SELECT d.status, d.approved_by, k.stage_code AS stage FROM decisions d
       JOIN collection_cases k ON k.id = d.case_id
       WHERE d.customer_id = $1 AND d.source = 'rule'`,
      [customerId],
    );
    return d.rows[0];
  });
  expect(after).toEqual({ status: 'approved', approved_by: E2E.checkerId, stage: 'legal' });
});
