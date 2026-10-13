import { expect, test } from '@playwright/test';
import { waitForCaptcha } from './e2e-env';

// Public auth screens without a session: generic error (no enumeration, rule 27), invalid
// invitation with a way back (rule 29), and the signed-in screens' redirects.
test.use({ storageState: { cookies: [], origins: [] } });

test('login: unknown e-mail gets the same generic message as a wrong password', async ({
  page,
}) => {
  await page.goto('/login');
  await expect(page.getByText(/pozivnic|invitation/i)).toBeVisible(); // first-time text
  await page.locator('#email').fill('nobody@e2e.example.test');
  await page.locator('#password').fill('not-the-password-123');
  await waitForCaptcha(page);
  await page.locator('form button[type="submit"]').click();
  const alert = page.locator('main [role="alert"]');
  await expect(alert).toBeVisible();
  const unknownText = await alert.textContent();

  await page.locator('#email').fill(process.env.E2E_EMAIL ?? '');
  await page.locator('#password').fill('not-the-password-123');
  await waitForCaptcha(page);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('main [role="alert"]')).toHaveText(unknownText ?? '');
});

test('invite: an unknown token shows "not valid" with a way back to sign in', async ({ page }) => {
  await page.goto(`/invite/${'A'.repeat(43)}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /prijav|sign in/i })).toHaveAttribute(
    'href',
    '/login',
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('signed-in screens send an anonymous visitor to /login', async ({ page }) => {
  for (const path of ['/', '/settings/password', '/settings/mfa-setup', '/select-tenant']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  }
});

test('security headers on pages: nonce CSP, no framing, no referrer', async ({ request }) => {
  const res = await request.get('/login');
  const csp = res.headers()['content-security-policy'] ?? '';
  expect(csp).toMatch(/script-src [^;]*'nonce-/);
  expect(csp).not.toMatch(/script-src [^;]*'unsafe-inline'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(res.headers()['x-frame-options']).toBe('DENY');
  expect(res.headers()['referrer-policy']).toBe('no-referrer');
  expect(res.headers()['strict-transport-security']).toMatch(/max-age=/);
});

test('login: when the browser does not navigate, "Continue" appears after 2 s', async ({
  page,
}) => {
  // An aborted navigation = the browser stays where it is (what an extension did on
  // the preview); the form must not leave the person stuck.
  await page.route('**/login/mfa', (route) => route.abort('aborted'));
  await page.goto('/login');
  await page.locator('#email').fill(process.env.E2E_EMAIL ?? '');
  await page.locator('#password').fill(process.env.E2E_PASSWORD ?? '');
  await waitForCaptcha(page);
  await page.locator('form button[type="submit"]').click();
  const fallback = page.getByTestId('continue-fallback');
  await expect(fallback).toBeVisible({ timeout: 6_000 });
  await expect(fallback.getByRole('link')).toHaveAttribute('href', '/login/mfa');
  await expect(page).toHaveURL(/\/login$/);
});

test('signup (6.4): a filled honeypot gets the same "check your e-mail" answer; no overflow', async ({
  page,
}) => {
  await page.goto('/signup');
  const form = page.locator('[data-signup-form]');
  await form.locator('input[name="company"]').fill('E2E Bot d.o.o.');
  await form.locator('input[name="name"]').fill('E2E Bot');
  await form.locator('input[name="email"]').fill('bot@e2e.example.test');
  await form.locator('input[name="website"]').fill('http://spam.example.test', { force: true });
  await waitForCaptcha(page);
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('[data-signup-done]')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('data package (6.4): an unknown link shows "not valid", nothing else', async ({ page }) => {
  await page.goto(`/onboarding/${'A'.repeat(43)}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
});
