import { defineConfig, devices } from '@playwright/test';
import { e2eDatabaseUrls, loadDotEnv, STORAGE_STATE } from './tests/e2e/e2e-env';

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WORKER_PORT = Number(process.env.E2E_WORKER_PORT ?? 3191);

loadDotEnv();
const db = e2eDatabaseUrls();

// E2E runs against a production build and the TEST database (collect_test). The `setup`
// project signs in through the real screens (login → MFA setup → MFA → shell, 375 px) and
// stores the session for the other projects (rule 16: every screen is tested at 375 px).
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    timezoneId: 'UTC',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 } },
    },
    {
      name: 'mobile-375',
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 375, height: 812 },
        storageState: STORAGE_STATE,
      },
    },
    {
      name: 'desktop',
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        storageState: STORAGE_STATE,
      },
    },
  ],
  webServer: [
    {
      // Same standalone server as the Docker image.
      command: 'npm run build && npm run start',
      url: `${BASE_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        PORT: String(PORT),
        HOSTNAME: '127.0.0.1',
        PRODUCT_NAME: process.env.PRODUCT_NAME ?? 'E2E Product',
        DATABASE_URL: db.app,
        MIGRATE_DATABASE_URL: db.migrate,
        BETTER_AUTH_URL: BASE_URL,
        // Cloudflare's PUBLIC Turnstile test keys ("always passes", documented by Cloudflare) —
        // not secrets. Production refuses to start without real keys (rule 27).
        TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
        TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
      },
    },
    {
      // The job worker of the same build (task 2.4): applies confirmed imports, as in production.
      command: 'node .next/standalone/worker.mjs',
      url: `http://127.0.0.1:${WORKER_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        WORKER_PORT: String(WORKER_PORT),
        HOSTNAME: '127.0.0.1',
        PRODUCT_NAME: process.env.PRODUCT_NAME ?? 'E2E Product',
        DATABASE_URL: db.app,
        WORKER_DATABASE_URL: db.worker,
        MIGRATE_DATABASE_URL: db.migrate,
        BETTER_AUTH_URL: BASE_URL,
        TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
        TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
      },
    },
  ],
});
