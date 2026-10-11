import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { GET } from '@/app/health/route';
import { proxy } from '@/proxy';
import pkg from '../../package.json' with { type: 'json' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('/health smoke', () => {
  it('handler returns 200 with status ok', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('proxy adds X-Request-Id and X-App-Version to the response', () => {
    const res = proxy(new NextRequest('http://localhost/health'));
    expect(res.headers.get('x-request-id')).toMatch(UUID_RE);
    expect(res.headers.get('x-app-version')).toBe(process.env.APP_VERSION || pkg.version);
  });

  it('proxy reuses a valid upstream request id and replaces an invalid one', () => {
    const upstream = '3f1c2a4e-9b7d-4c1e-8a2b-5d6e7f8a9b0c';
    const kept = proxy(
      new NextRequest('http://localhost/health', { headers: { 'x-request-id': upstream } }),
    );
    expect(kept.headers.get('x-request-id')).toBe(upstream);

    const replaced = proxy(
      new NextRequest('http://localhost/health', { headers: { 'x-request-id': '<script>' } }),
    );
    expect(replaced.headers.get('x-request-id')).toMatch(UUID_RE);
  });
});
