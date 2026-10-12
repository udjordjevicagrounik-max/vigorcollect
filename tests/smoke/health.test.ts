import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { proxy } from '@/proxy';
import { healthReport } from '@/server/health';
import pkg from '../../package.json' with { type: 'json' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('/health smoke', () => {
  const jobs = { pending: 0, failed: 0, oldestPendingSeconds: null, lastRetentionAt: null };

  it('status ok with the database up; job aggregates are reported', async () => {
    const report = await healthReport({ pingDb: async () => {}, jobs: async () => jobs });
    expect(report).toEqual({ status: 'ok', db: 'ok', jobs });
  });

  it('database down → degraded (the route answers 503); a job error is not fatal', async () => {
    const down = await healthReport({
      pingDb: async () => {
        throw new Error('connection refused');
      },
      jobs: async () => jobs,
    });
    expect(down).toEqual({ status: 'degraded', db: 'down', jobs: null });
    const noJobs = await healthReport({
      pingDb: async () => {},
      jobs: async () => {
        throw new Error('x');
      },
    });
    expect(noJobs).toEqual({ status: 'ok', db: 'ok', jobs: null });
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
