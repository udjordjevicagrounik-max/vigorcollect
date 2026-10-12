import { existsSync } from 'node:fs';

/** Session saved by the `setup` project (auth.setup.ts) for the other projects. */
export const STORAGE_STATE = 'test-results/.auth/session.json';

// E2E runs the production build against the TEST database (collect_test), never the dev one.
// Same derivation as scripts/lib/env.sh: database name → "<POSTGRES_DB>_test".
export function loadDotEnv(): void {
  if (!process.env.MIGRATE_DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
}

function toTestDb(url: string | undefined): string {
  if (!url) throw new Error('DATABASE_URL / MIGRATE_DATABASE_URL are not set (.env).');
  const parsed = new URL(url);
  parsed.pathname = `/${process.env.TEST_DB_NAME ?? `${process.env.POSTGRES_DB ?? 'collect'}_test`}`;
  return parsed.toString();
}

export function e2eDatabaseUrls(): { app: string; migrate: string } {
  loadDotEnv();
  const app = process.env.TEST_DATABASE_URL ?? toTestDb(process.env.DATABASE_URL);
  const migrate =
    process.env.TEST_MIGRATE_DATABASE_URL ?? toTestDb(process.env.MIGRATE_DATABASE_URL);
  if (!/_test(\?|$)/.test(new URL(app).pathname) || !/_test$/.test(new URL(migrate).pathname)) {
    throw new Error('E2E must run against a *_test database.');
  }
  return { app, migrate };
}

/** Waits until the Turnstile widget has produced a token (test keys solve automatically). */
export async function waitForCaptcha(page: import('@playwright/test').Page): Promise<void> {
  await page
    .locator('[data-testid="turnstile"] input[name="cf-turnstile-response"]')
    .first()
    .evaluate(
      (el) =>
        new Promise<void>((resolve) => {
          const input = el as HTMLInputElement;
          const check = () => (input.value ? resolve() : setTimeout(check, 100));
          check();
        }),
    );
}

/** Collects CSP violations reported by the browser on this page. */
export function cspViolations(page: import('@playwright/test').Page): string[] {
  const found: string[] = [];
  page.on('console', (msg) => {
    if (
      msg.type() === 'error' &&
      /Content Security Policy|Content-Security-Policy/i.test(msg.text())
    ) {
      found.push(msg.text());
    }
  });
  return found;
}
