import { expect, test as setup } from '@playwright/test';
import { totp } from '../golden/db/auth-client';
import { STORAGE_STATE } from './e2e-env';

// Rule 16 + task 1.1c: the whole sign-in path on a 375 px screen, through the real screens:
// login → MFA setup (QR + manual key) → first code → shell → sign out → login → MFA code →
// shell. The identity is created per run by global-setup.ts; nothing is printed.

const email = () => process.env.E2E_EMAIL ?? '';
const password = () => process.env.E2E_PASSWORD ?? '';

async function noHorizontalOverflow(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

setup('login → MFA setup → MFA → shell at 375 px', async ({ page }) => {
  expect(email()).not.toBe('');

  // Anonymous → the shell sends you to /login.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator('[data-mobile-class="mobile-full"]')).toBeVisible();
  await noHorizontalOverflow(page);

  await page.locator('#email').fill(email());
  await page.locator('#password').fill(password());
  await page.locator('form button[type="submit"]').click();

  // No authenticator yet → mandatory setup.
  await expect(page).toHaveURL(/\/settings\/mfa-setup$/);
  await page.locator('#password').fill(password());
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByRole('img')).toBeVisible(); // QR (SVG)
  await page.locator('details summary').click();
  const secret = (await page.getByTestId('totp-secret').textContent())?.trim() ?? '';
  expect(secret).toMatch(/^[A-Z2-7]+=*$/);
  await noHorizontalOverflow(page);
  const uri = `otpauth://totp/e2e?secret=${secret}`;
  await page.locator('#code').fill(totp(uri));
  await page.locator('form button[type="submit"]').click();

  // Enrolled; one membership → tenant bound automatically → shell.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('[data-nav-group="work"]')).toBeVisible();

  // Second sign-in asks for the code (next 30 s window: a code is never reused).
  await page.getByRole('button', { name: /odjava|sign out/i }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.locator('#email').fill(email());
  await page.locator('#password').fill(password());
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/login\/mfa$/);
  await noHorizontalOverflow(page);
  await page.locator('#code').fill(totp(uri, Date.now() + 30_000));
  await page.locator('form button[type="submit"]').click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('[data-mobile-class]')).toHaveAttribute(
    'data-mobile-class',
    /^mobile-/,
  );
  await noHorizontalOverflow(page);

  // HttpOnly session cookie — never readable by page scripts.
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name.includes('session_token'));
  expect(session?.httpOnly).toBe(true);
  expect(await page.evaluate(() => document.cookie)).not.toContain('session_token');

  await page.context().storageState({ path: STORAGE_STATE });
});
