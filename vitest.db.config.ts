import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Golden tests against the isolated test database (collect_test). Run through
// scripts/test-db.sh, which checks the DB is up and applies migrations first.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/golden/db/**/*.test.ts'],
    env: { TZ: 'UTC' },
    // Files share one database; run them one after another.
    fileParallelism: false,
  },
});
