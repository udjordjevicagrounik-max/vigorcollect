import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantClockTick } from '@/server/jobs/clock';
import { jobHealth } from '@/server/jobs/health';
import { dispatchMail } from '@/server/jobs/mail-dispatch';
import { dispatchPending, processEvent, type EventHandlers } from '@/server/jobs/outbox';
import { runRetention } from '@/server/jobs/retention';
import { startWorker } from '@/server/jobs/worker';
import {
  appPool,
  closePools,
  inTenant,
  inTenantCommit,
  migratePool,
  sqlState,
  workerPool,
} from './helpers';

// Golden (never delete or skip) — task 1.3: the job runner role sees only the outbox and the
// mail outbox (never tenant data), every handler runs inside its event's tenant, events are
// idempotent by id, failures retry and stay visible, retention deletes only what the policies
// allow, and the daily tenant run follows the tenant's local date. Own tenants J and K.

const T = {
  tenantJ: '0b100000-0000-4000-8000-0000000000b1',
  tenantK: '0b200000-0000-4000-8000-0000000000b2',
  userJ: '3b100000-0000-4000-8000-0000000000b1',
  userK: '3b200000-0000-4000-8000-0000000000b2',
  entityNY: '1b100000-0000-4000-8000-0000000000b1',
  entityTokyo: '1b100000-0000-4000-8000-0000000000b2',
  companyNY: '2b100000-0000-4000-8000-0000000000b1',
  companyTokyo: '2b100000-0000-4000-8000-0000000000b2',
} as const;
const RUN = randomUUID().slice(0, 8);

async function insertEvent(tenantId: string, eventType: string): Promise<string> {
  let id = '';
  await inTenantCommit(appPool, tenantId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO domain_events (tenant_id, event_type, aggregate_type, payload)
       VALUES ($1, $2, 'golden', jsonb_build_object('run', $3::text)) RETURNING id`,
      [tenantId, eventType, RUN],
    );
    id = rows[0]?.id ?? '';
  });
  return id;
}

async function eventState(tenantId: string, id: string) {
  return inTenant(appPool, tenantId, async (c) => {
    const { rows } = await c.query<{ status: string; attempts: number; last_error: string | null }>(
      'SELECT status, attempts, last_error FROM domain_events WHERE id = $1',
      [id],
    );
    return rows[0];
  });
}

/** Claims every pending event of this run and returns the claimed ids (fake enqueue). */
async function claim(): Promise<string[]> {
  const claimed: string[] = [];
  await dispatchPending(workerPool(), async (_client, e) => {
    claimed.push(e.id);
  });
  return claimed;
}

beforeAll(async () => {
  await inTenantCommit(migratePool, null, async (c) => {
    await c.query(
      `INSERT INTO jurisdiction_profiles (country_code, default_currency, default_locale, default_timezone)
       VALUES ('XX', 'EUR', 'en', 'UTC') ON CONFLICT (country_code) DO NOTHING`,
    );
    for (const [id, tz, tax] of [
      [T.entityNY, 'America/New_York', 'GOLDEN-WORKER-NY'],
      [T.entityTokyo, 'Asia/Tokyo', 'GOLDEN-WORKER-TOKYO'],
    ] as const) {
      await c.query(
        `INSERT INTO legal_entities (id, country_code, tax_id, legal_name, normalized_name, timezone)
         VALUES ($1, 'XX', $2, $2, lower($2), $3) ON CONFLICT (id) DO NOTHING`,
        [id, tax, tz],
      );
    }
  });
  for (const [tenantId, slug, userId, tz, isDemo] of [
    [T.tenantJ, 'golden-worker-j', T.userJ, 'Europe/Belgrade', false],
    [T.tenantK, 'golden-worker-k', T.userK, 'UTC', true],
  ] as const) {
    await inTenantCommit(migratePool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, display_name, is_demo) VALUES ($1, $2, $2, $3)
         ON CONFLICT (id) DO UPDATE SET is_demo = EXCLUDED.is_demo`,
        [tenantId, slug, isDemo],
      );
      await c.query(
        `INSERT INTO tenant_settings (tenant_id, timezone, default_currency, country_code)
         VALUES ($1, $2, 'EUR', 'XX') ON CONFLICT (tenant_id) DO UPDATE SET timezone = EXCLUDED.timezone`,
        [tenantId, tz],
      );
      await c.query(
        `INSERT INTO users (id, tenant_id, email, display_name, timezone, status)
         VALUES ($1, $2, $3, 'Golden Worker', 'UTC', 'active') ON CONFLICT (id) DO NOTHING`,
        [userId, tenantId, `member@${slug}.example.test`],
      );
    });
  }
  // Tenant J: two companies in other zones than the tenant (rule 26 test).
  await inTenantCommit(migratePool, T.tenantJ, async (c) => {
    for (const [id, entity, name] of [
      [T.companyNY, T.entityNY, 'NY branch'],
      [T.companyTokyo, T.entityTokyo, 'Tokyo branch'],
    ] as const) {
      await c.query(
        `INSERT INTO tenant_companies (id, tenant_id, legal_entity_id, display_name)
         VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [id, T.tenantJ, entity, name],
      );
    }
  });
});

afterAll(async () => {
  for (const tenantId of [T.tenantJ, T.tenantK]) {
    await inTenantCommit(migratePool, tenantId, async (c) => {
      await c.query(`DELETE FROM domain_events WHERE payload->>'run' = $1`, [RUN]);
      await c.query('DELETE FROM mail_outbox');
    });
  }
  await closePools();
});

// ---------------------------------------------------------------------------------------------

describe('golden/db: vigor_worker sees the outbox, never tenant data', () => {
  it('no access to customers, users, tenant_settings, audit_log, subject_keys, schema auth', async () => {
    const states: Record<string, string> = {};
    for (const table of [
      'customers',
      'users',
      'tenant_settings',
      'tenants',
      'audit_log',
      'subject_keys',
      'customer_contacts',
      'auth."user"',
    ]) {
      states[table] = await sqlState(workerPool().query(`SELECT 1 FROM ${table} LIMIT 1`));
    }
    expect(Object.values(states).every((s) => s === '42501')).toBe(true);
  });

  it('is neither SUPERUSER nor BYPASSRLS', async () => {
    const { rows } = await workerPool().query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it('reads events of every tenant but cannot write payload, tenant or new events', async () => {
    const j = await insertEvent(T.tenantJ, 'golden.read');
    const k = await insertEvent(T.tenantK, 'golden.read');
    const { rows } = await workerPool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM domain_events WHERE id = ANY($1::uuid[])',
      [[j, k]],
    );
    expect(rows[0]?.n).toBe(2);
    expect(
      await sqlState(
        workerPool().query(`UPDATE domain_events SET payload = '{}' WHERE id = $1`, [j]),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        workerPool().query(`UPDATE domain_events SET tenant_id = $2 WHERE id = $1`, [j, T.tenantK]),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        workerPool().query(
          `INSERT INTO domain_events (tenant_id, event_type, aggregate_type) VALUES ($1, 'x.y', 'x')`,
          [T.tenantJ],
        ),
      ),
    ).toBe('42501');
    await claim(); // leave nothing pending for other tests
  });

  it('tenant_clock() exposes only (tenant_id, timezone); the owner has no read path outside it', async () => {
    const { rows } = await workerPool().query<Record<string, unknown>>(
      'SELECT * FROM tenant_clock() WHERE tenant_id = $1',
      [T.tenantJ],
    );
    expect(rows).toEqual([{ tenant_id: T.tenantJ, timezone: 'Europe/Belgrade' }]);
    const owner = await inTenant(migratePool, null, (c) =>
      c.query<{ n: number }>('SELECT count(*)::int AS n FROM tenant_settings'),
    );
    expect(owner.rows[0]?.n).toBe(0);
    expect(await sqlState(appPool.query('SELECT * FROM tenant_clock()'))).toBe('42501');
  });

  it('the status machine holds for every role: processed is final', async () => {
    const id = await insertEvent(T.tenantJ, 'golden.final');
    await claim();
    await workerPool().query(
      `UPDATE domain_events SET status = 'processed', processed_at = now() WHERE id = $1`,
      [id],
    );
    expect(
      await sqlState(
        workerPool().query(
          `UPDATE domain_events SET status = 'pending', processed_at = NULL WHERE id = $1`,
          [id],
        ),
      ),
    ).toBe('23514');
  });
});

describe('golden/db: outbox processing (tenant per event, idempotent, retries visible)', () => {
  it('each handler runs inside its event’s tenant and sees only that tenant', async () => {
    const seen: { tenant: string; users: string[] }[] = [];
    const handlers: EventHandlers = {
      'golden.tenant': async (ctx) => {
        const tenant = await ctx.db.query<{ t: string }>(
          `SELECT current_setting('app.tenant_id') AS t`,
        );
        const users = await ctx.db.query<{ id: string }>('SELECT id FROM users ORDER BY id');
        seen.push({ tenant: tenant.rows[0]?.t ?? '', users: users.rows.map((u) => u.id) });
      },
    };
    const j = await insertEvent(T.tenantJ, 'golden.tenant');
    const k = await insertEvent(T.tenantK, 'golden.tenant');
    expect(await claim()).toEqual(expect.arrayContaining([j, k]));
    const deps = { workerPool: workerPool(), appPool, handlers };
    for (const id of [j, k]) await processEvent(deps, id, { retryCount: 0, retryLimit: 3 });
    expect(seen).toEqual([
      { tenant: T.tenantJ, users: [T.userJ] },
      { tenant: T.tenantK, users: [T.userK] },
    ]);
    expect((await eventState(T.tenantJ, j))?.status).toBe('processed');
  });

  it('idempotency key = event id: a second delivery is skipped, the handler ran once', async () => {
    let calls = 0;
    const handlers: EventHandlers = {
      'golden.once': async () => {
        calls += 1;
      },
    };
    const id = await insertEvent(T.tenantJ, 'golden.once');
    await claim();
    const deps = { workerPool: workerPool(), appPool, handlers };
    expect(await processEvent(deps, id, { retryCount: 0, retryLimit: 3 })).toBe('processed');
    expect(await processEvent(deps, id, { retryCount: 0, retryLimit: 3 })).toBe('skipped');
    expect(calls).toBe(1);
  });

  it('a failing handler retries 3× and then the event is failed — with an error code, still there', async () => {
    const handlers: EventHandlers = {
      'golden.fails': async (ctx) => {
        await ctx.db.query('SELECT 1/0'); // SQLSTATE 22012, rolls the tenant transaction back
      },
    };
    const id = await insertEvent(T.tenantJ, 'golden.fails');
    await claim();
    const deps = { workerPool: workerPool(), appPool, handlers };
    for (let retryCount = 0; retryCount <= 3; retryCount += 1) {
      await expect(processEvent(deps, id, { retryCount, retryLimit: 3 })).rejects.toThrow();
      expect((await eventState(T.tenantJ, id))?.status).toBe(
        retryCount < 3 ? 'processing' : 'failed',
      );
    }
    expect(await eventState(T.tenantJ, id)).toEqual({
      status: 'failed',
      attempts: 4,
      last_error: '22012',
    });
  });

  it('an event type without a handler is acknowledged (processed), not lost', async () => {
    const id = await insertEvent(T.tenantK, 'golden.nobody_listens');
    await claim();
    expect(
      await processEvent({ workerPool: workerPool(), appPool, handlers: {} }, id, {
        retryCount: 0,
        retryLimit: 3,
      }),
    ).toBe('no_handler');
    expect((await eventState(T.tenantK, id))?.status).toBe('processed');
  });
});

describe('golden/db: the real worker (pg-boss) end to end', () => {
  it('dispatches and processes an event; re-enqueueing the same id is ignored; health has numbers', async () => {
    let handled = 0;
    const worker = await startWorker(
      {
        workerUrl: process.env.TEST_WORKER_DATABASE_URL ?? '',
        appUrl: process.env.TEST_DATABASE_URL ?? '',
      },
      {
        'golden.boss': async () => {
          handled += 1;
        },
      },
    );
    try {
      const id = await insertEvent(T.tenantJ, 'golden.boss');
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && (await eventState(T.tenantJ, id))?.status !== 'processed') {
        await new Promise((r) => setTimeout(r, 250));
      }
      expect((await eventState(T.tenantJ, id))?.status).toBe('processed');
      expect(handled).toBe(1);
      expect(await worker.boss.send('domain-event', { eventId: id }, { id })).toBeNull();

      const health = await jobHealth(appPool);
      expect(typeof health.pending).toBe('number');
      expect(typeof health.failed).toBe('number');
    } finally {
      await worker.stop();
    }
  }, 40_000);
});

// Review S-05: job_health() was SECURITY DEFINER owned by vigor_migrate and read pgboss.job,
// which the worker owns. A compromised worker could put a view there whose function then ran as
// vigor_migrate (owner of every table) on the next /health. The attack itself is the test.
describe('golden/db: /health never runs worker-controlled code as the table owner', () => {
  it('a view the worker puts in place of pgboss.job runs as vigor_worker, not vigor_migrate', async () => {
    const w = workerPool();
    const mod = (await import('@/server/jobs/worker')) as {
      installJobHealth?: (pool: typeof w) => Promise<void>;
    };
    await mod.installJobHealth?.(w);
    await w.query('CREATE TABLE pgboss.golden_spy (who text)');
    await w.query('GRANT INSERT ON pgboss.golden_spy TO PUBLIC');
    await w.query(
      `CREATE FUNCTION pgboss.golden_spy_fn() RETURNS boolean LANGUAGE sql VOLATILE
       AS $$ INSERT INTO pgboss.golden_spy VALUES (current_user); SELECT true $$`,
    );
    await w.query('GRANT EXECUTE ON FUNCTION pgboss.golden_spy_fn() TO PUBLIC');
    await w.query('ALTER TABLE pgboss.job RENAME TO golden_job_saved');
    try {
      await w.query(
        `CREATE VIEW pgboss.job AS
         SELECT j.* FROM (SELECT pgboss.golden_spy_fn()) spy
         LEFT JOIN pgboss.golden_job_saved j ON true`,
      );
      await w.query('GRANT SELECT ON pgboss.job TO PUBLIC');
      await jobHealth(appPool).catch(() => null);
      const { rows } = await w.query<{ who: string }>('SELECT DISTINCT who FROM pgboss.golden_spy');
      expect(rows.map((r) => r.who)).not.toContain('vigor_migrate');
      expect(rows.map((r) => r.who)).toEqual(['vigor_worker']);
    } finally {
      await w.query('DROP VIEW IF EXISTS pgboss.job');
      await w.query('ALTER TABLE pgboss.golden_job_saved RENAME TO job');
      await w.query('DROP FUNCTION IF EXISTS pgboss.golden_spy_fn()');
      await w.query('DROP TABLE IF EXISTS pgboss.golden_spy');
    }
  });
});

describe('golden/db: retention deletes only what the policies allow', () => {
  it('mail > 7 days, processed events > 90 days, expired sessions; fresh rows stay', async () => {
    const ids = { oldMail: randomUUID(), newMail: randomUUID(), oldEvent: '', newEvent: '' };
    await inTenantCommit(migratePool, T.tenantK, async (c) => {
      for (const [id, age] of [
        [ids.oldMail, '8 days'],
        [ids.newMail, '1 day'],
      ] as const) {
        await c.query(
          `INSERT INTO mail_outbox (id, tenant_id, kind, transport, status, recipient_enc,
                                    recipient_key_version, body_enc, body_key_version, created_at)
           VALUES ($1, $2, 'invitation', 'sink', 'captured', '\\x00', 1, '\\x00', 1, now() - $3::interval)`,
          [id, T.tenantK, age],
        );
      }
      for (const [key, age] of [
        ['oldEvent', '91 days'],
        ['newEvent', '89 days'],
      ] as const) {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO domain_events (tenant_id, event_type, aggregate_type, payload, status,
                                      processed_at, occurred_at)
           VALUES ($1, 'golden.old', 'golden', jsonb_build_object('run', $2::text), 'processed',
                   now() - $3::interval, now() - $3::interval) RETURNING id`,
          [T.tenantK, RUN, age],
        );
        ids[key] = rows[0]?.id ?? '';
      }
    });
    const counts = await runRetention({ workerPool: workerPool(), appPool });
    expect(counts.mailOutbox).toBeGreaterThanOrEqual(1);
    expect(counts.domainEvents).toBeGreaterThanOrEqual(1);

    const left = await inTenant(migratePool, T.tenantK, async (c) => ({
      mail: (
        await c.query<{ id: string }>('SELECT id FROM mail_outbox WHERE id = ANY($1::uuid[])', [
          [ids.oldMail, ids.newMail],
        ])
      ).rows.map((r) => r.id),
      events: (
        await c.query<{ id: string }>('SELECT id FROM domain_events WHERE id = ANY($1::uuid[])', [
          [ids.oldEvent, ids.newEvent],
        ])
      ).rows.map((r) => r.id),
    }));
    expect(left).toEqual({ mail: [ids.newMail], events: [ids.newEvent] });
  });

  it('the worker cannot delete a young mail or an unprocessed event (policy, not code)', async () => {
    const id = await insertEvent(T.tenantK, 'golden.young');
    const del = await workerPool().query('DELETE FROM domain_events WHERE id = $1', [id]);
    expect(del.rowCount).toBe(0);
    await claim();

    const young = randomUUID();
    await inTenantCommit(migratePool, T.tenantK, async (c) => {
      await c.query(
        `INSERT INTO mail_outbox (id, tenant_id, kind, transport, status, recipient_enc,
                                  recipient_key_version, body_enc, body_key_version)
         VALUES ($1, $2, 'invitation', 'sink', 'captured', '\\x00', 1, '\\x00', 1)`,
        [young, T.tenantK],
      );
    });
    const mail = await workerPool().query('DELETE FROM mail_outbox WHERE id = $1', [young]);
    expect(mail.rowCount).toBe(0);
  });
});

describe('golden/db: mail dispatcher', () => {
  it('a queued SMTP mail stays pending without a sender and is marked sent with one; sink rows untouched', async () => {
    const smtpId = randomUUID();
    const sinkId = randomUUID();
    await inTenantCommit(migratePool, T.tenantJ, async (c) => {
      await c.query(
        `INSERT INTO mail_outbox (id, tenant_id, kind, transport, status, recipient_enc,
                                  recipient_key_version, body_enc, body_key_version)
         VALUES ($1, $3, 'invitation', 'smtp', 'pending', '\\x00', 1, '\\x00', 1),
                ($2, $3, 'invitation', 'sink', 'captured', '\\x00', 1, '\\x00', 1)`,
        [smtpId, sinkId, T.tenantJ],
      );
    });
    expect((await dispatchMail(workerPool())).pending).toBeGreaterThanOrEqual(1);
    const sent: string[] = [];
    await dispatchMail(workerPool(), async (id) => {
      sent.push(id);
    });
    expect(sent).toContain(smtpId);
    expect(sent).not.toContain(sinkId);
    const sink = await workerPool().query(
      `UPDATE mail_outbox SET status = 'sent', sent_at = now() WHERE id = $1`,
      [sinkId],
    );
    expect(sink.rowCount).toBe(0);
  });
});

describe('golden/db: daily tenant run at 06:00 tenant-local (rule 26)', () => {
  it('two companies in New York and Tokyo do not change the tenant’s day: one run per local date', async () => {
    const seen = new Set<string>();
    const enqueue = async (id: string, job: { tenantId: string; localDate: string }) => {
      if (job.tenantId !== T.tenantJ || seen.has(id)) return false;
      seen.add(id);
      return true;
    };
    // 2026-10-25 is the fall-back day in Belgrade: 06:00 local = 05:00Z.
    expect(await tenantClockTick(workerPool(), new Date('2026-10-25T04:59:00Z'), enqueue)).toEqual(
      [],
    );
    const first = await tenantClockTick(workerPool(), new Date('2026-10-25T05:00:00Z'), enqueue);
    const again = await tenantClockTick(workerPool(), new Date('2026-10-25T21:45:00Z'), enqueue);
    expect(first).toHaveLength(1);
    expect(again).toEqual([]);
    // The next local day is a new run.
    const next = await tenantClockTick(workerPool(), new Date('2026-10-26T05:15:00Z'), enqueue);
    expect(next).toHaveLength(1);
    expect(next[0]).not.toBe(first[0]);
  });
});
