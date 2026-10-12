import { expect, test } from '@playwright/test';

// /settings/password with the session from the setup project: validation messages only — the
// real change is covered by the golden DB test (it would end the shared session).
test('password screen: mobile-full, mismatch is caught before sending', async ({ page }) => {
  await page.goto('/settings/password');
  await expect(page.locator('[data-mobile-class="mobile-full"]')).toBeVisible();
  await page.locator('#current').fill('whatever-current');
  await page.locator('#next').fill('a-new-long-password-1');
  await page.locator('#confirm').fill('a-new-long-password-2');
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('main [role="alert"]')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
