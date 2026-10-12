import { expect, test } from '@playwright/test';

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
  await page.locator('form button[type="submit"]').click();
  const alert = page.locator('main [role="alert"]');
  await expect(alert).toBeVisible();
  const unknownText = await alert.textContent();

  await page.locator('#email').fill(process.env.E2E_EMAIL ?? '');
  await page.locator('#password').fill('not-the-password-123');
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
