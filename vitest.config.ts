import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/{smoke,golden,unit}/**/*.test.ts'],
    // Live-DB golden tests run separately against collect_test (npm run test:db).
    exclude: ['tests/golden/db/**', 'node_modules/**'],
    env: { TZ: 'UTC' },
  },
});
