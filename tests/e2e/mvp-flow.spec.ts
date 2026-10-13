import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { parseMasterKeyring } from '../../src/server/crypto/keyring';
import { createContact } from '../../src/server/customers/repository';
import { readOutbox } from '../../src/server/mail/adapter';
import { e2eDatabaseUrls } from './e2e-env';
import { E2E } from './global-setup';

// Sprint 5 at 375 px, one run: dispute on Customer 360 → bulk reminder (the disputed customer is
// skipped by the worker) → CSV export → disputes report → aging bucket setting → daily digest in
// the sink. Data of this run carries its own tag, so runs never see each other's customers.

const RUN = randomUUID().slice(0, 6);
const SPOR = `E2E Spor ${RUN} d.o.o.`;
const CLEAN = `E2E Podsetnik ${RUN} d.o.o.`;

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Two customers of the e2e tenant, each with an e-mail contact and one invoice 20 days overdue. */
async function seed(): Promise<void> {
  const keyring = parseMasterKeyring(process.env.PII_MASTER_KEYS);
  const client = new Client({ connectionString: e2eDatabaseUrls().migrate });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [E2E.tenantId]);
    for (const name of [SPOR, CLEAN]) {
      const le = await client.query<{ id: string }>(
        `SELECT find_or_create_legal_entity('XX', $1, $2, 'UTC', NULL) AS id`,
        [`E2E-${RUN}-${name.length}`, name],
      );
      const c = await client.query<{ id: string }>(
        `INSERT INTO customers (tenant_id, legal_entity_id, display_name, owner_user_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [E2E.tenantId, le.rows[0]?.id, name, E2E.userId],
      );
      const id = c.rows[0]?.id ?? '';
      await createContact(client, keyring, {
        customerId: id,
        name: 'Kontakt',
        email: `kontakt-${RUN}-${name.length}@e2e.example.test`,
        isPrimary: true,
      });
      await client.query(
        `INSERT INTO invoices (tenant_id, company_id, customer_id, source_id, external_id, number, issue_date,
                               due_date, currency, amount_total, amount_open)
         SELECT $1, $2, $3, s.id, $4, $4, current_date - 50, current_date - 20, 'EUR', '1200.00', '1200.00'
         FROM data_sources s WHERE s.name = 'file-import'`,
        [E2E.tenantId, E2E.companyId, id, `E2E-${RUN}-${name.length}`],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

test('dispute → bulk reminder → CSV export → report → aging setting → digest in the sink', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'mobile-375', 'one end-to-end run is enough');
  test.setTimeout(240_000);
  await seed();

  // 1. Dispute on Customer 360.
  await page.goto(`/customers?q=${encodeURIComponent(`E2E Spor ${RUN}`)}`);
  await page.locator('[data-customer-cards] a').first().click();
  await expect(page.locator('[data-customer-name]')).toContainText(SPOR);
  await page.locator('[data-tab="disputes"]').click();
  await expect(page.locator('[data-disputes]')).toBeVisible();
  await page.locator('[data-action="dispute"] summary').click();
  await page.locator('[data-action="dispute"] input[name="invoiceIds"]').first().check();
  await page.locator('[data-action="dispute"] button[type="submit"]').click();
  await expect(page.locator('[data-dispute="open"]')).toBeVisible();
  await noHorizontalOverflow(page);

  // 2. Bulk reminder on both customers: the disputed one is skipped by the worker.
  await page.goto(`/customers?q=${encodeURIComponent(RUN)}`);
  await expect(page.locator('[data-customer-cards] li')).toHaveCount(2);
  for (const box of await page.locator('[data-customer-cards] input[name="ids"]').all())
    await box.check();
  await page.locator('[data-bulk-action]').selectOption('send_reminder');
  await page.locator('[data-bulk-param]').selectOption('reminder_overdue');
  await page.locator('[data-bulk-preview]').click();
  await expect(page.locator('[data-bulk-preview-result]')).toContainText('2');
  await noHorizontalOverflow(page);
  await page.locator('[data-bulk-confirm]').click();
  await expect(page).toHaveURL(/\/bulk\/[0-9a-f-]{36}$/);
  await expect(page.locator('[data-bulk-report="completed"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-bulk-item="ok"]')).toHaveCount(1);
  await expect(page.locator('[data-bulk-item="skipped"]')).toHaveCount(1);
  await noHorizontalOverflow(page);

  // 3. CSV export of the list (synchronous, export_log on the server).
  await page.goto(`/customers?q=${encodeURIComponent(RUN)}`);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-export-format="csv"]').first().click(),
  ]);
  const csv = await download.createReadStream().then(
    (stream) =>
      new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }),
  );
  expect(csv).toContain(CLEAN);
  expect(csv).toContain(SPOR);

  // 4. Disputes report.
  await page.goto('/reports');
  await page.locator('[data-report-link="disputes"]').click();
  await expect(page.locator('[data-visual]').first()).toBeVisible();
  await noHorizontalOverflow(page);

  // 5. Aging bucket setting: 1–29 / 30–60 (idempotent across runs).
  await page.goto('/admin/settings');
  const aging = page.locator('[data-config-section="aging"]');
  const rows = aging.locator('[data-bucket]');
  await rows.nth(1).locator('input[name^="max:"]').fill('29');
  await rows.nth(2).locator('input[name^="min:"]').fill('30');
  await aging.locator('button[type="submit"]').click();
  await expect(aging.locator('.text-status-success-fg, [role="status"]').first()).toBeVisible();
  await noHorizontalOverflow(page);

  // 6. "My day" digest of the owner, on request → the demo tenant's sink.
  await page.goto('/settings/notifications');
  await page.locator('[data-digest-now]').click();
  await expect(
    page
      .locator('[data-digest-now] ~ .text-status-success-fg, [data-digest-now] ~ [role="status"]')
      .first(),
  ).toBeVisible();
  await noHorizontalOverflow(page);
  const client = new Client({ connectionString: e2eDatabaseUrls().app });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [E2E.tenantId]);
    const mails = await readOutbox(client, parseMasterKeyring(process.env.PII_MASTER_KEYS), {
      kind: 'digest',
      limit: 20,
    });
    const transports = await client.query<{ transport: string }>(
      `SELECT DISTINCT transport FROM mail_outbox WHERE kind = 'digest'`,
    );
    await client.query('COMMIT');
    expect(mails.some((m) => m.to === 'owner@golden-e2e.example.test')).toBe(true);
    expect(transports.rows).toEqual([{ transport: 'sink' }]);
  } finally {
    await client.end();
  }
});
