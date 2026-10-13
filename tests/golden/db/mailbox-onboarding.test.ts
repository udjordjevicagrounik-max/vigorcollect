import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit } from '@/server/auth/audit';
import { NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import { parseMasterKeyring } from '@/server/crypto/keyring';
import {
  finishMicrosoft,
  getMailbox,
  processMailbox,
  requestMailboxTest,
  saveMailboxForm,
  startMicrosoft,
} from '@/server/integrations/mailbox';
import { sameTx } from '@/server/jobs/tenant-job';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant } from './helpers';

// Golden (never delete or skip) — task 5.3:
//   - the mailbox password (and user, sender) never exists in clear in the database or the audit
//     log; the API view only says "set";
//   - tenant A never sees tenant B's mailbox;
//   - Microsoft 365 OAuth: the state is single use and bound to the member AND the session;
//   - "check connection": probes first; only a working mailbox reaches n8n; failures keep a code.

const keyring = parseMasterKeyring(`1:${randomBytes(32).toString('base64')}`);
process.env.PII_MASTER_KEYS = `1:${randomBytes(32).toString('base64')}`;
const PASSWORD = 'Tajna-Lozinka-4711!';
const USER = 'naplata@golden-mail.example.test';
const ENV = {
  MS_CLIENT_ID: 'golden-client',
  MS_CLIENT_SECRET: 'golden-secret',
  MS_TENANT: 'common',
  BETTER_AUTH_URL: 'https://collect.example.test',
  N8N_BASE_URL: 'https://n8n.example.test',
  N8N_API_KEY: 'golden-key',
} as unknown as NodeJS.ProcessEnv;

beforeAll(ensureFixtures);
afterAll(closePools);

function ctxFor(
  db: PoolClient,
  tenantId: string = FX.tenantA,
  userId: string = FX.userA,
): TenantContext {
  const requestId = randomUUID();
  return {
    db,
    tenantId,
    userId,
    authUserId: 'golden',
    requestId,
    requirePermission: async (key) => ({ key, scope: 'ORGANIZATION' }),
    requireAnyPermission: async (keys) => ({ key: keys[0] ?? '', scope: 'ORGANIZATION' }),
    audit: (entry) => writeAudit(db, { type: 'user', id: userId }, entry, requestId),
  };
}

const form = {
  imapHost: 'imap.golden-mail.example.test',
  imapPort: 993 as const,
  imapTls: true,
  smtpHost: 'smtp.golden-mail.example.test',
  smtpPort: 587 as const,
  smtpSecurity: 'starttls' as const,
  username: USER,
  password: PASSWORD,
  folder: 'Collect',
  fromAddress: USER,
};

/** userA really holds integration.manage in the (rolled back) test — the worker creates the integration. */
async function grantManage(db: PoolClient): Promise<void> {
  await db.query(
    `INSERT INTO user_roles (tenant_id, user_id, role_id, scope) VALUES ($1, $2, $3, 'ORGANIZATION')
     ON CONFLICT DO NOTHING`,
    [FX.tenantA, FX.userA, FX.roleA],
  );
  await db.query(
    `INSERT INTO role_permissions (tenant_id, role_id, permission_id)
     SELECT $1, $2, p.id FROM permissions p WHERE p.key = 'integration.manage' ON CONFLICT DO NOTHING`,
    [FX.tenantA, FX.roleA],
  );
}

describe('golden/db: mailbox form (5.3)', () => {
  it('the password, user and sender are never in clear — not in the row, not in the audit log', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      await saveMailboxForm(ctx, form, keyring);
      const row = await db.query<{ raw: string }>(
        `SELECT encode(convert_to(m::text, 'UTF8'), 'escape') AS raw FROM mailbox_connections m`,
      );
      const audit = await db.query<{ raw: string }>(
        `SELECT coalesce(before::text, '') || coalesce(after::text, '') AS raw FROM audit_log
         WHERE request_id = $1`,
        [ctx.requestId],
      );
      return {
        row: row.rows[0]?.raw ?? '',
        audit: audit.rows.map((r) => r.raw).join(''),
        view: await getMailbox(ctx),
      };
    });
    for (const secret of [PASSWORD, USER, 'Tajna']) {
      expect(out.row).not.toContain(secret);
      expect(out.audit).not.toContain(secret);
      expect(JSON.stringify(out.view)).not.toContain(secret);
    }
    expect(out.audit).toContain('password_set');
    expect(out.view).toMatchObject({
      status: 'saved',
      passwordSet: true,
      usernameSet: true,
      folder: 'Collect',
    });
  });

  it('tenant A never sees the mailbox of tenant B', async () => {
    const out = await inTenant(appPool, FX.tenantB, async (db) => {
      await saveMailboxForm(ctxFor(db, FX.tenantB, FX.userB), form, keyring);
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [FX.tenantA]);
      const seen = await db.query('SELECT 1 FROM mailbox_connections');
      return { seen: seen.rowCount, view: await getMailbox(ctxFor(db)) };
    });
    expect(out.seen).toBe(0);
    expect(out.view.status).toBeNull();
  });
});

describe('golden/db: Microsoft 365 OAuth state (5.3)', () => {
  const tokenOk: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        access_token: 'at',
        refresh_token: 'golden-refresh-token-xyz',
        expires_in: 3600,
      }),
      {
        status: 200,
      },
    );

  it('bound to the session: another session fails, a reused state fails, the right one connects', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      const { url } = await startMicrosoft(ctx, 'session-1', keyring, ENV);
      const params = new URL(url).searchParams;
      const state = params.get('state') ?? '';
      const other = await finishMicrosoft(
        ctx,
        'session-2',
        { state, code: 'c' },
        keyring,
        ENV,
        tokenOk,
      ).catch((e: unknown) => e);
      const { url: url2 } = await startMicrosoft(ctx, 'session-1', keyring, ENV);
      const state2 = new URL(url2).searchParams.get('state') ?? '';
      const foreign = await finishMicrosoft(
        ctxFor(db, FX.tenantA, FX.userA2),
        'session-1',
        { state: state2, code: 'c' },
        keyring,
        ENV,
        tokenOk,
      ).catch((e: unknown) => e);
      const { url: url3 } = await startMicrosoft(ctx, 'session-1', keyring, ENV);
      const state3 = new URL(url3).searchParams.get('state') ?? '';
      const ok = await finishMicrosoft(
        ctx,
        'session-1',
        { state: state3, code: 'c' },
        keyring,
        ENV,
        tokenOk,
      );
      const reused = await finishMicrosoft(
        ctx,
        'session-1',
        { state: state3, code: 'c' },
        keyring,
        ENV,
        tokenOk,
      ).catch((e: unknown) => e);
      const row = await db.query<{ provider: string; status: string; raw: string }>(
        `SELECT provider, status, encode(ms_refresh_token_enc, 'escape') AS raw FROM mailbox_connections`,
      );
      return { params: Object.fromEntries(params), other, foreign, ok, reused, row: row.rows[0] };
    });
    expect(out.params).toMatchObject({
      client_id: 'golden-client',
      response_type: 'code',
      code_challenge_method: 'S256',
      redirect_uri: 'https://collect.example.test/api/integrations/microsoft/callback',
    });
    expect(out.params.scope).toContain('Mail.Read');
    expect(out.params.scope).toContain('offline_access');
    expect(out.other).toBeInstanceOf(NotFoundError);
    expect(out.foreign).toBeInstanceOf(NotFoundError);
    expect(out.ok).toBe('connected');
    expect(out.reused).toBeInstanceOf(NotFoundError);
    expect(out.row).toMatchObject({ provider: 'microsoft365', status: 'test_requested' });
    expect(out.row?.raw).not.toContain('golden-refresh-token');
  });

  it('without app keys the consent cannot start', async () => {
    const out = await inTenant(appPool, FX.tenantA, (db) =>
      startMicrosoft(ctxFor(db), 's', keyring, {} as unknown as NodeJS.ProcessEnv).catch((e: unknown) => e),
    );
    expect(out).toMatchObject({ code: 'unsupported' });
  });
});

describe('golden/db: check connection (5.3)', () => {
  it('a failed IMAP login keeps a code and never reaches n8n', async () => {
    const calls: string[] = [];
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      await saveMailboxForm(ctxFor(db), form, keyring);
      await requestMailboxTest(ctxFor(db));
      const outcome = await processMailbox(sameTx(db), keyring, {
        env: ENV,
        probeImap: async () => ({ ok: false, error: 'auth_failed' }),
        probeSmtp: async () => ({ ok: true }),
        n8n: async (method, path) => {
          calls.push(`${method} ${path}`);
          return {} as never;
        },
      });
      return { outcome, view: await getMailbox(ctxFor(db)) };
    });
    expect(out.outcome).toBe('failed');
    expect(out.view).toMatchObject({ status: 'failed', lastError: 'imap_auth_failed' });
    expect(calls).toEqual([]);
  });

  it('a working mailbox: n8n gets the credentials and both workflows; the folder is set', async () => {
    const sent: { method: string; path: string; body: unknown }[] = [];
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      await grantManage(db);
      await db.query(`UPDATE integrations SET status = 'disabled' WHERE type = 'mailbox'`);
      await saveMailboxForm(ctxFor(db), form, keyring);
      await requestMailboxTest(ctxFor(db));
      let n = 0;
      const outcome = await processMailbox(sameTx(db), keyring, {
        env: ENV,
        probeImap: async (t) =>
          t.password === PASSWORD && t.user === USER
            ? { ok: true }
            : { ok: false, error: 'auth_failed' },
        probeSmtp: async () => ({ ok: true }),
        n8n: async (method, path, body) => {
          sent.push({ method, path, body });
          n += 1;
          if (path.startsWith('credentials?') || path.startsWith('workflows?'))
            return { data: [] } as never;
          return { id: `n8n-${n}`, name: 'x' } as never;
        },
      });
      const row = await db.query<{
        status: string;
        n8n_refs: { workflows: { inbound: string } };
        integration_id: string;
      }>('SELECT status, n8n_refs, integration_id FROM mailbox_connections');
      const integration = await db.query<{ config: { outboundUrl: string } }>(
        'SELECT config FROM integrations WHERE id = $1',
        [row.rows[0]?.integration_id],
      );
      return { outcome, row: row.rows[0], integration: integration.rows[0] };
    });
    expect(out.outcome).toBe('connected');
    expect(out.row?.status).toBe('connected');
    expect(out.row?.n8n_refs.workflows.inbound).toMatch(/^n8n-/);
    expect(out.integration?.config.outboundUrl).toBe(
      'https://n8n.example.test/webhook/collect-mail-outbound-golden-a',
    );
    const creds = sent
      .filter((s) => s.method === 'POST' && s.path === 'credentials')
      .map((s) => (s.body as { type: string }).type);
    expect(creds).toEqual(['crypto', 'imap', 'smtp']);
    const inbound = sent.find(
      (s) =>
        s.method === 'POST' &&
        s.path === 'workflows' &&
        (s.body as { name: string }).name.includes('inbound'),
    )?.body as { nodes: { type: string; parameters: { mailbox?: string } }[] };
    expect(
      inbound.nodes.find((x) => x.type === 'n8n-nodes-base.emailReadImap')?.parameters.mailbox,
    ).toBe('Collect');
    expect(sent.filter((s) => s.path.endsWith('/activate'))).toHaveLength(2);
  });
});
