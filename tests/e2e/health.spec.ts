import { expect, test } from '@playwright/test';

test('/health returns 200 with correlation and version headers', async ({ request }) => {
  const res = await request.get('/health');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok' });
  expect(res.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  expect(res.headers()['x-app-version']).toBeTruthy();
});

test('every page response carries X-Request-Id and X-App-Version', async ({ request }) => {
  const res = await request.get('/');
  expect(res.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  expect(res.headers()['x-app-version']).toBeTruthy();
});
