import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { totp } from '../golden/db/auth-client';
import { waitForCaptcha } from './e2e-env';
import { invitationLink } from './sink';

// Task 1.5 at 375 px: owner invites → invitee accepts and signs in (MFA setup) → owner sees the
// list → deactivates → the person loses access at once. Runs once (mobile-375).

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test('invite → accept → login → users list → deactivation', async ({ page, browser }, info) => {
  test.skip(info.project.name !== 'mobile-375', 'one end-to-end run is enough');
  test.setTimeout(120_000);
  const email = `e2e-invite-${randomUUID().slice(0, 8)}@e2e.example.test`;
  const password = `pw-${randomBytes(16).toString('base64url')}`;

  // Owner: Admin → Users, invite a collector.
  await page.goto('/admin/users');
  await expect(page.locator('[data-mobile-class="mobile-compact"]')).toBeVisible();
  await noHorizontalOverflow(page);
  await page.locator('#invite-email').fill(email);
  await page.locator('#invite-name').fill('E2E Invitee');
  await page.locator('#invite-role').selectOption('collector');
  await page.getByRole('button', { name: /pošalji pozivnicu|send invitation/i }).click();
  await expect(page.locator(`[data-member="${email}"]`)).toHaveAttribute('data-status', 'invited');

  // Invitee (no session): open the link from the mail sink, set a password.
  const invitee = await browser.newContext({
    viewport: { width: 375, height: 812 },
    storageState: { cookies: [], origins: [] },
  });
  const p2 = await invitee.newPage();
  await p2.goto(await invitationLink(email));
  await noHorizontalOverflow(p2);
  await p2.locator('#password').fill(password);
  await p2.locator('#confirm').fill(password);
  await waitForCaptcha(p2);
  await p2.locator('form button[type="submit"]').click();
  await p2.getByRole('link', { name: /prijav|sign in/i }).click();

  // First sign-in: password → mandatory MFA setup → shell (no admin items for a collector).
  await p2.locator('#email').fill(email);
  await p2.locator('#password').fill(password);
  await waitForCaptcha(p2);
  await p2.locator('form button[type="submit"]').click();
  await expect(p2).toHaveURL(/\/settings\/mfa-setup$/);
  await p2.locator('#password').fill(password);
  await p2.locator('form button[type="submit"]').click();
  await p2.locator('details summary').click();
  const secret = (await p2.getByTestId('totp-secret').textContent())?.trim() ?? '';
  await p2.locator('#code').fill(totp(`otpauth://totp/x?secret=${secret}`));
  await p2.locator('form button[type="submit"]').click();
  await expect(p2).toHaveURL(/\/$/);
  await expect(p2.locator('[data-nav-item="home"]')).toBeVisible();
  await expect(p2.locator('[data-nav-item="users"]')).toHaveCount(0);

  // Owner: the list shows the active member; deactivate with confirmation.
  await page.reload();
  const row = page.locator(`[data-member="${email}"]`);
  await expect(row).toHaveAttribute('data-status', 'active');
  await row.getByRole('button', { name: /^(deaktiviraj|deactivate)$/i }).click();
  await row.getByRole('button', { name: /potvrdi deaktivaciju|confirm deactivation/i }).click();
  await expect(row).toHaveAttribute('data-status', 'disabled');
  await noHorizontalOverflow(page);

  // The deactivated person loses the tenant on the next request.
  await p2.goto('/');
  await expect(p2).toHaveURL(/\/select-tenant$/);
  await invitee.close();
});

test('owner navigation follows permissions; settings and status pages at 375 px', async ({
  page,
}) => {
  await page.goto('/');
  for (const item of ['home', 'users', 'teams', 'approvals', 'tenantSettings', 'systemStatus']) {
    await expect(page.locator(`[data-nav-item="${item}"]`)).toBeVisible();
  }
  await expect(page.locator('[data-tenant-badge]')).toContainText('E2E Company');
  for (const path of [
    '/admin/settings',
    '/admin/status',
    '/admin/teams',
    '/admin/approvals',
    '/import',
  ]) {
    await page.goto(path);
    await expect(page.locator('[data-mobile-class]')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await noHorizontalOverflow(page);
  }
});

test('PWA: manifest is installable (name, standalone, 192 + 512 PNG icons)', async ({
  request,
}) => {
  const manifest = (await (await request.get('/manifest.webmanifest')).json()) as {
    display: string;
    start_url: string;
    icons: { src: string; sizes: string; type: string }[];
  };
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/');
  expect(manifest.icons.map((i) => i.sizes)).toEqual(
    expect.arrayContaining(['192x192', '512x512']),
  );
  for (const icon of manifest.icons) {
    const res = await request.get(icon.src);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/png');
  }
});
