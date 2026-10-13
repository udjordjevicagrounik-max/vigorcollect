import { describe, expect, it } from 'vitest';
import { devGuardViolations } from '../../scripts/lib/dev-guard';
import { Pool } from 'pg';
import { buildAuthOptions, resolveSecureCookies } from '@/server/auth/better-auth';
import { mayInvite } from '@/server/auth/invitations';
import { selectTransport } from '@/server/mail/adapter';

// Decisions after 1.1a / 1.1b (NEXT.md): every combination is pinned down here.

describe('resolveSecureCookies: off only for non-production on http://localhost|127.0.0.1', () => {
  const cases: [string | undefined, string, boolean][] = [
    // non-production + local plain http → the only case without Secure
    ['development', 'http://localhost:13000', false],
    ['development', 'http://127.0.0.1:3000', false],
    ['test', 'http://localhost', false],
    [undefined, 'http://127.0.0.1', false],
    // production → always Secure
    ['production', 'http://localhost:13000', true],
    ['production', 'http://127.0.0.1:3000', true],
    ['production', 'https://app.example.com', true],
    // non-production but not local plain http → Secure
    ['development', 'https://localhost:13000', true],
    ['development', 'http://app.example.com', true],
    ['development', 'http://localhost.evil.example', true],
    ['development', 'http://127.0.0.2', true],
    ['development', 'http://0.0.0.0:3000', true],
    ['development', 'http://[::1]:3000', true],
    ['development', 'not a url', true],
    ['development', '', true],
  ];
  it.each(cases)('NODE_ENV=%s, %s → secure=%s', (nodeEnv, url, secure) => {
    expect(resolveSecureCookies(nodeEnv, url)).toBe(secure);
  });
});

describe('selectTransport: a demo tenant never gets SMTP (rule 24)', () => {
  it.each([
    [true, true, 'sink'],
    [true, false, 'sink'],
    [false, true, 'smtp'],
    [false, false, 'sink'],
  ] as const)('isDemo=%s, smtpEnabled=%s → %s', (isDemo, smtpEnabled, transport) => {
    expect(selectTransport({ isDemo, smtpEnabled })).toBe(transport);
  });
});

describe('mayInvite: owner → all roles, admin → all but owner', () => {
  it.each([
    [['owner'], 'owner', true],
    [['owner'], 'collector', true],
    [['admin'], 'admin', true],
    [['admin'], 'owner', false],
    [['collector'], 'collector', false],
    [['cfo', 'auditor'], 'read_only', false],
    [[], 'read_only', false],
  ] as const)('%j invites %s → %s', (roles, roleKey, allowed) => {
    expect(mayInvite([...roles], roleKey)).toBe(allowed);
  });
});

describe('dev-admin-password guard', () => {
  const ok = {
    nodeEnv: 'development',
    databaseUrl: 'postgres://vigor_migrate:x@172.17.0.1:5432/collect',
    appUrl: 'http://localhost:13000',
    stdoutIsTTY: true,
  };

  it('runs only when every condition holds', () => {
    expect(devGuardViolations(ok)).toEqual([]);
    expect(devGuardViolations({ ...ok, appUrl: 'http://127.0.0.1:3000' })).toEqual([]);
  });

  it.each([
    [{ nodeEnv: 'production' }],
    [{ databaseUrl: 'postgres://u:x@172.17.0.1:5432/collect_test' }],
    [{ databaseUrl: 'postgres://u:x@db.example.com:5432/prod' }],
    [{ databaseUrl: undefined }],
    [{ appUrl: 'https://app.example.com' }],
    [{ appUrl: 'https://localhost:13000' }],
    [{ appUrl: 'http://localhost.evil.example' }],
    [{ appUrl: undefined }],
    [{ stdoutIsTTY: false }],
  ])('refuses %j', (override) => {
    expect(devGuardViolations({ ...ok, ...override }).length).toBeGreaterThan(0);
  });
});

// Review S-07: Better Auth's own rate limit (sign-in, reset) keys on the IP src/proxy.ts resolved
// from the trusted end of X-Forwarded-For — never on the client-controlled first entry.
describe('Better Auth reads the client IP only from x-client-ip', () => {
  it('ipAddressHeaders is exactly the proxy-set header', () => {
    const options = buildAuthOptions(
      {
        connectionString: 'postgres://u:p@127.0.0.1:1/x',
        secret: 's'.repeat(32),
        baseURL: 'http://localhost:3000',
        issuer: 'Test',
      },
      new Pool({ connectionString: 'postgres://u:p@127.0.0.1:1/x' }),
    );
    expect(options.advanced?.ipAddress?.ipAddressHeaders).toEqual(['x-client-ip']);
  });
});
