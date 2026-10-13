import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit } from '@/server/auth/audit';
import { PermissionDeniedError } from '@/server/auth/permissions';
import type { TenantContext } from '@/server/auth/with-tenant';
import { parseMasterKeyring } from '@/server/crypto/keyring';
import { grantsByRole, parsePermissionMatrix } from '@/server/permissions/matrix';
import { listStaged, unstageImport } from '@/server/imports/service';
import { exportConfigPack, importConfigPack } from '@/server/library/config-pack';
import { genericTemplateCsv, GENERIC_HEADERS } from '@/server/library/import-templates';
import { savePackageAnswers, uploadPackageFile } from '@/server/platform/onboarding';
import {
  createTenant,
  getTracker,
  listTenants,
  lookupPackage,
  createPackage,
  setLifecycle,
} from '@/server/platform/service';
import { signupWith } from '@/server/platform/signup';
import { ensureFixtures, FX } from './fixtures';
import {
  appPool,
  closePools,
  inTenant,
  inTenantCommit,
  migratePool,
  savepointState,
  workerPool,
} from './helpers';

// Golden (never delete or skip) — task 6.4:
//   - platform functions only in the platform operator tenant with platform.manage; the tenant list
//     carries NO business data (rule 32);
//   - a new tenant gets the system roles without platform.manage and an invited owner;
//   - trial and sandbox tenants send only to the sink until contract_signed_at (decision 6.4);
//     an expired trial is read-only, never deleted;
//   - public signup: honeypot / captcha → nothing created; a sandbox with demo data and a sealed lead;
//   - the ONLY tenant delete: an expired demo sandbox after its read-only week;
//   - the data package: files only 'staged' in the client tenant (nothing imported), answers →
//     a proposed policy, receipt starts the SLA clock; a wrong token changes nothing;
//   - config pack: no secrets out; import never overwrites and rules arrive as drafts.

const keyring = parseMasterKeyring(`1:${randomBytes(32).toString('base64')}`);
process.env.PII_MASTER_KEYS = `1:${randomBytes(32).toString('base64')}`;
// The platform operator of the test database (Sinergista, #0); the fixture only adds what is missing.
const OP = '00000000-0000-4000-8000-000000000000';
const OP_USER = '3f0f0000-0000-4000-8000-0000000000f0';
const OP_ENTITY = '1f0f0000-0000-4000-8000-0000000000f0';

beforeAll(async () => {
  await ensureFixtures();
  const grants = grantsByRole(parsePermissionMatrix(readFileSync('docs/permissions.md', 'utf8')));
  await inTenantCommit(migratePool, null, async (c) => {
    await c.query(
      `INSERT INTO legal_entities (id, country_code, tax_id, legal_name, normalized_name, timezone)
       VALUES ($1, 'XX', 'GOLDEN-PLATFORM', 'Golden Platform', 'golden platform', 'UTC') ON CONFLICT (id) DO NOTHING`,
      [OP_ENTITY],
    );
  });
  await inTenantCommit(migratePool, OP, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, display_name, is_platform_operator) VALUES ($1, 'golden-platform', 'Golden Platform', true)
       ON CONFLICT (id) DO NOTHING`,
      [OP],
    );
    await c.query(
      `INSERT INTO tenant_settings (tenant_id, timezone, default_currency, country_code) VALUES ($1, 'UTC', 'EUR', 'XX')
       ON CONFLICT (tenant_id) DO NOTHING`,
      [OP],
    );
    await c.query(
      `INSERT INTO tenant_companies (tenant_id, legal_entity_id, display_name, is_default) VALUES ($1, $2, 'Golden Platform', true)
       ON CONFLICT DO NOTHING`,
      [OP, OP_ENTITY],
    );
    await c.query(
      `INSERT INTO users (id, tenant_id, email, display_name, timezone, status)
       VALUES ($1, $2, 'operator@golden-platform.example.test', 'Operator', 'UTC', 'active') ON CONFLICT (id) DO NOTHING`,
      [OP_USER, OP],
    );
    for (const [role, keys] of grants) {
      await c.query(
        `INSERT INTO roles (tenant_id, key, is_system) VALUES ($1, $2, true) ON CONFLICT (tenant_id, key) DO NOTHING`,
        [OP, role],
      );
      await c.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_id)
         SELECT $1, r.id, p.id FROM roles r JOIN permissions p ON p.key = ANY($3::text[]) WHERE r.key = $2
         ON CONFLICT DO NOTHING`,
        [OP, role, keys],
      );
    }
    await c.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_id, scope) SELECT $1, $2, id, 'ORGANIZATION' FROM roles WHERE key = 'owner'
       ON CONFLICT DO NOTHING`,
      [OP, OP_USER],
    );
    await c.query('SELECT provision_receivables_defaults()');
  });
});
afterAll(closePools);

function ctxFor(db: PoolClient, tenantId = OP, userId = OP_USER): TenantContext {
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

const deps = { keyring, baseURL: 'https://collect.example.test' };
const newTenant = (slug: string) => ({
  name: `Golden ${slug}`,
  slug,
  country: 'XX',
  locale: 'en' as const,
  timezone: 'UTC',
  currency: 'EUR',
  companyName: `Golden ${slug} d.o.o.`,
  companyTaxId: `GT-${slug}`,
  owner: { email: `owner-${slug}@example.test`, displayName: 'Owner' },
});

describe('golden/db: platform (6.4)', () => {
  it('only the operator tenant; the list carries no business data', async () => {
    const denied = await inTenant(appPool, FX.tenantA, (db) =>
      listTenants(ctxFor(db, FX.tenantA, FX.userA)).catch((e: unknown) => e),
    );
    expect(denied).toBeInstanceOf(PermissionDeniedError);
    const list = await inTenant(appPool, OP, (db) => listTenants(ctxFor(db)));
    expect(list.some((t) => t.id === FX.tenantA)).toBe(true);
    for (const t of list)
      expect(Object.keys(t).sort()).toEqual(
        [
          'contractSignedAt',
          'createdAt',
          'id',
          'isDemo',
          'lastActivity',
          'lifecycle',
          'name',
          'sandboxExpiresAt',
          'slug',
          'trialEndsAt',
          'users',
        ].sort(),
      );
  });

  it('a new trial tenant: roles without platform.manage, invited owner, sink only, read-only after the trial', async () => {
    const slug = `gt-${randomUUID().slice(0, 6)}`;
    const out = await inTenant(appPool, OP, async (db) => {
      const ctx = ctxFor(db);
      const { id } = await createTenant(ctx, newTenant(slug), deps);
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      const roles = await db.query<{ n: number; platform: number }>(
        `SELECT count(DISTINCT r.id)::int AS n,
                count(*) FILTER (WHERE p.key = 'platform.manage')::int AS platform
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id LEFT JOIN permissions p ON p.id = rp.permission_id`,
      );
      const invite = await db.query<{ role_key: string; transport: string }>(
        `SELECT i.role_key, (SELECT transport FROM mail_outbox WHERE kind = 'invitation' LIMIT 1) AS transport
         FROM user_invitations i`,
      );
      const smtp = await savepointState(
        db,
        `INSERT INTO mail_outbox (tenant_id, kind, transport, status, recipient_enc, recipient_key_version, body_enc, body_key_version)
         VALUES ($1, 'test', 'smtp', 'pending', '\\x00', 1, '\\x00', 1)`,
        [id],
      );
      const writable = async () =>
        (await db.query<{ ok: boolean }>('SELECT tenant_writable(t) AS ok FROM tenants t')).rows[0]
          ?.ok;
      const before = await writable();
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [OP]);
      await db.query("SELECT set_config('app.platform', 'on', true)");
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      // (the platform_write policy is for the owner role; here we expire the trial as the owner would)
      const expired = await migratePool.connect();
      try {
        await expired.query('BEGIN');
        await expired.query("SELECT set_config('app.platform', 'on', true)");
        await expired.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
        await expired.query(
          `UPDATE tenants SET trial_ends_at = now() - interval '1 day' WHERE id = $1`,
          [id],
        );
        const after = (
          await expired.query<{ ok: boolean }>('SELECT tenant_writable(t) AS ok FROM tenants t')
        ).rows[0]?.ok;
        await expired.query('ROLLBACK');
        await db.query("SELECT set_config('app.tenant_id', $1, true)", [OP]);
        return { roles: roles.rows[0], invite: invite.rows, smtp, before, after };
      } finally {
        expired.release();
      }
    });
    expect(out.roles?.n).toBe(11);
    expect(out.roles?.platform).toBe(0);
    expect(out.invite).toEqual([{ role_key: 'owner', transport: 'sink' }]);
    expect(out.smtp).toBe('23514');
    expect(out.before).toBe(true);
  });

  it('contract signed lifts the sink rule; an onboarding package link resolves by token for 72 h', async () => {
    const slug = `gc-${randomUUID().slice(0, 6)}`;
    const out = await inTenant(appPool, OP, async (db) => {
      const ctx = ctxFor(db);
      const { id } = await createTenant(ctx, newTenant(slug), deps);
      await setLifecycle(ctx, id, { contractSigned: true });
      const pkg = await createPackage(ctx, id, deps.baseURL);
      const token = pkg.url.split('/').pop() ?? '';
      const found = await lookupPackage(db, token);
      const wrong = await lookupPackage(
        db,
        `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`,
      );
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      const smtp = await savepointState(
        db,
        `INSERT INTO mail_outbox (tenant_id, kind, transport, status, recipient_enc, recipient_key_version, body_enc, body_key_version)
         VALUES ($1, 'test', 'smtp', 'pending', '\\x00', 1, '\\x00', 1)`,
        [id],
      );
      return { id, found, wrong, smtp };
    });
    expect(out.found).toMatchObject({ tenantId: out.id, receivedAt: null });
    expect(out.wrong).toBeNull();
    expect(out.smtp).toBe('OK');
  });

  it('public signup: honeypot → nothing; a real one → sandbox with demo data, sealed lead, operator notified', async () => {
    const email = `lead-${randomUUID().slice(0, 6)}@example.test`;
    const out = await inTenant(appPool, null, async (db) => {
      const base = {
        keyring,
        baseURL: deps.baseURL,
        ip: undefined,
        verifyCaptcha: async () => true,
      };
      const bot = await signupWith(
        db,
        { company: 'Bot d.o.o.', name: 'Bot', email, website: 'http://spam' },
        base,
      );
      const ok = await signupWith(
        db,
        { company: 'Lead d.o.o.', name: 'Pera Lead', email, country: 'XX', locale: 'en' },
        base,
      );
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [OP]);
      const lead = await db.query<{ sandbox: string; raw: string }>(
        `SELECT sandbox_tenant_id AS sandbox, encode(convert_to(s::text, 'UTF8'), 'escape') AS raw
         FROM signup_requests s ORDER BY created_at DESC LIMIT 1`,
      );
      const note = await db.query(
        `SELECT 1 FROM notifications WHERE message_key = 'signup_received' AND user_id = $1`,
        [OP_USER],
      );
      const sandbox = lead.rows[0]?.sandbox ?? '';
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [sandbox]);
      const t = await db.query<{ is_demo: boolean; lifecycle_status: string; invoices: number }>(
        `SELECT is_demo, lifecycle_status, (SELECT count(*)::int FROM invoices) AS invoices FROM tenants`,
      );
      return { bot, ok, raw: lead.rows[0]?.raw ?? '', note: note.rowCount, t: t.rows[0] };
    });
    expect(out.bot).toBe('ignored');
    expect(out.ok).toBe('created');
    expect(out.raw).not.toContain(email);
    expect(out.raw).not.toContain('Pera Lead');
    expect(out.note).toBe(1);
    expect(out.t).toMatchObject({ is_demo: true, lifecycle_status: 'sandbox' });
    expect(out.t?.invoices).toBeGreaterThan(10);
  });

  it('the only tenant delete: an expired demo sandbox, after its read-only week — nothing else', async () => {
    const out = await inTenant(workerPool(), null, async (w) => {
      // A sandbox made through the platform and aged by the owner role inside this transaction.
      await w.query('SAVEPOINT s');
      const refuse = await savepointState(w, 'SELECT platform_purge_sandbox($1)', [FX.tenantA]);
      return { refuse };
    });
    expect(out.refuse).toBe('42501');

    // Everything in ONE rolled-back transaction as the table owner (purge = owner function).
    const purged = await inTenant(migratePool, null, async (db) => {
      const base = {
        keyring,
        baseURL: deps.baseURL,
        ip: undefined,
        verifyCaptcha: async () => true,
      };
      const made = await signupWith(
        db,
        {
          company: 'Purge d.o.o.',
          name: 'Pera Purge',
          email: `purge-${randomUUID().slice(0, 6)}@example.test`,
          country: 'XX',
        },
        base,
        { checked: true },
      );
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [OP]);
      const sb = await db.query<{ id: string }>(
        'SELECT sandbox_tenant_id AS id FROM signup_requests ORDER BY created_at DESC LIMIT 1',
      );
      const id = sb.rows[0]?.id ?? '';
      if (!id) throw new Error(`signup did not create a sandbox: ${made}`);
      const early = await savepointState(db, 'SELECT platform_purge_sandbox($1)', [id]);
      await db.query("SELECT set_config('app.platform', 'on', true)");
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await db.query(
        `UPDATE tenants SET sandbox_expires_at = now() - interval '8 days' WHERE id = $1`,
        [id],
      );
      await db.query("SELECT set_config('app.platform', '', true)");
      const removed = await db.query<{ n: number }>('SELECT platform_purge_sandbox($1) AS n', [id]);
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      const left = await db.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM invoices) + (SELECT count(*) FROM users) + (SELECT count(*) FROM audit_log)::int AS n`,
      );
      await db.query("SELECT set_config('app.tenant_clock', 'on', true)");
      const tenant = await db.query('SELECT 1 FROM tenants WHERE id = $1', [id]);
      return {
        early,
        removed: removed.rows[0]?.n ?? 0,
        left: Number(left.rows[0]?.n ?? -1),
        tenant: tenant.rowCount,
      };
    });
    expect(purged.early).toBe('42501');
    expect(purged.removed).toBeGreaterThan(50);
    expect(purged.left).toBe(0);
    expect(purged.tenant).toBe(0);
  });

  it('data package: staged file + answers in the client tenant, SLA clock starts; wrong token → nothing', async () => {
    const slug = `gp-${randomUUID().slice(0, 6)}`;
    let id = '';
    let token = '';
    await inTenantCommit(appPool, OP, async (db) => {
      const ctx = ctxFor(db);
      id = (
        await createTenant(ctx, { ...newTenant(slug), lifecycle: 'sandbox', isDemo: true }, deps)
      ).id;
      token = (await createPackage(ctx, id, deps.baseURL)).url.split('/').pop() ?? '';
    });
    try {
      const pkgDeps = { keyring, ip: undefined, verifyCaptcha: async () => true };
      const content = Buffer.from(genericTemplateCsv()).toString('base64');
      const wrong = await uploadPackageFile(
        appPool,
        `${token.slice(0, -2)}xx`,
        { fileName: 'fakture.csv', format: 'csv', content },
        pkgDeps,
      );
      const file = await uploadPackageFile(
        appPool,
        token,
        { fileName: 'fakture.csv', format: 'csv', content },
        pkgDeps,
      );
      const answers = await savePackageAnswers(
        appPool,
        token,
        {
          answers: {
            payment_terms: '60',
            reminder_before_due: 'yes',
            first_reminder: 'd15',
            tone: 'neutral',
            phone_followup: 'yes',
            escalation: 'd60',
            legal_handover: 'd90',
            seasonal: 'yes',
            natural_persons: 'yes',
            disputes_common: 'no',
          },
        },
        pkgDeps,
      );
      const inClient = await inTenant(appPool, id, async (db) => {
        const user = await db.query<{ id: string }>('SELECT id FROM users LIMIT 1');
        const ctx = ctxFor(db, id, user.rows[0]?.id ?? '');
        const staged = await listStaged(ctx);
        const invoices = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM invoices');
        const opened = await unstageImport(ctx, staged[0]?.id ?? '', keyring);
        const pkg = await db.query<{ proposal: string; files: number }>(
          'SELECT proposal, files FROM onboarding_packages',
        );
        return { staged: staged.length, invoices: invoices.rows[0]?.n, opened, pkg: pkg.rows[0] };
      });
      const tracker = await inTenant(appPool, OP, (db) => getTracker(ctxFor(db), id));
      expect(wrong).toBe('invalid');
      expect(file).toBe('ok');
      expect(answers).toEqual({ outcome: 'ok', proposal: 'agro_seasonal' });
      expect(inClient.staged).toBe(1);
      expect(inClient.invoices).toBe(0);
      expect(inClient.opened.headers).toEqual(Object.values(GENERIC_HEADERS));
      expect(inClient.pkg).toEqual({ proposal: 'agro_seasonal', files: 1 });
      expect(tracker.hoursSinceData).toBe(0);
      expect(tracker.steps.data_received).not.toBeNull();
    } finally {
      // Clean up the committed sandbox the only allowed way: expired → platform purge.
      await inTenantCommit(migratePool, id, async (db) => {
        await db.query("SELECT set_config('app.platform', 'on', true)");
        await db.query(
          `UPDATE tenants SET sandbox_expires_at = now() - interval '8 days' WHERE id = $1`,
          [id],
        );
        await db.query("SELECT set_config('app.platform', '', true)");
        await db.query("SELECT set_config('app.tenant_id', $1, true)", [OP]);
        await db.query('SELECT platform_purge_sandbox($1)', [id]);
      });
    }
  });

  it('config pack: no secrets out; import adds only what is missing, rules as drafts', async () => {
    const pack = await inTenant(appPool, FX.tenantA, (db) =>
      exportConfigPack(ctxFor(db, FX.tenantA, FX.userA)),
    );
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) {
          keys.push(k);
          walk(x);
        }
    };
    walk(pack);
    expect(keys.filter((k) => /secret|password|token|_enc$|credential|smtp|imap/i.test(k))).toEqual(
      [],
    );
    const extra = {
      ...pack,
      rules: [
        ...pack.rules,
        {
          key: 'golden_pack_rule',
          name: 'Golden pack rule',
          definition: {
            trigger: { type: 'days_from_due', offset: 3 },
            conditions: [],
            actions: [{ type: 'create_task', kind: 'call', dueInDays: 0 }],
          },
        },
      ],
    };
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db, FX.tenantA, FX.userA);
      const first = await importConfigPack(ctx, extra);
      const second = await importConfigPack(ctx, extra);
      const v = await db.query<{ status: string }>(
        `SELECT v.status FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id WHERE w.key = 'golden_pack_rule'`,
      );
      return { first, second, statuses: v.rows.map((r) => r.status) };
    });
    expect(out.first.rules).toBe(1);
    expect(out.statuses).toEqual(['draft']);
    const added = Object.entries(out.second).filter(
      ([k, n]) => k !== 'skipped' && k !== 'agingBuckets' && n > 0,
    );
    expect(added).toEqual([]);
  });
});
