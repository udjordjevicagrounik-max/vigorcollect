import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit } from '@/server/auth/audit';
import { InvalidRequestError, type TenantContext } from '@/server/auth/with-tenant';
import { parseMasterKeyring } from '@/server/crypto/keyring';
import {
  createDefinition,
  getValues,
  listDefinitions,
  setValues,
  updateDefinition,
} from '@/server/custom-fields/service';
import { applyImport } from '@/server/imports/process';
import { confirmImport, uploadImport, validateImport } from '@/server/imports/service';
import { listReceivableCustomers } from '@/server/receivables/service';
import { evaluateConditions, type Facts } from '@/server/workflows/definition';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant } from './helpers';

// Golden (never delete or skip) — task 6.1:
//   - tenant A never sees definitions or values of tenant B;
//   - a P1 value is never in clear in the database, and never filterable;
//   - an archived field keeps its values in the history and takes no new ones;
//   - every definition gets its pii_field_registry row (rule 20);
//   - list filters and rule conditions use custom fields; amounts never through a float.

const keyring = parseMasterKeyring(`1:${randomBytes(32).toString('base64')}`);
process.env.PII_MASTER_KEYS = `1:${randomBytes(32).toString('base64')}`;
const SECRET = 'Lični-podatak-8812';

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

async function customer(
  db: PoolClient,
  name: string,
  tenantId: string = FX.tenantA,
): Promise<string> {
  const le = await db.query<{ id: string }>(
    `SELECT find_or_create_legal_entity('XX', $1, $2, 'UTC', NULL) AS id`,
    [`CF-${randomUUID().slice(0, 12)}`, name],
  );
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, legal_entity_id, display_name) VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, le.rows[0]?.id, name],
  );
  return rows[0]?.id ?? '';
}

const labels = (s: string) => ({ 'sr-Latn': s, en: s });

describe('golden/db: custom fields (6.1)', () => {
  it('tenant A never sees the definitions or values of tenant B', async () => {
    const out = await inTenant(appPool, FX.tenantB, async (db) => {
      const ctxB = ctxFor(db, FX.tenantB, FX.userB);
      await createDefinition(ctxB, {
        entityType: 'customer',
        key: 'golden_b_only',
        type: 'text',
        piiClass: 'P0',
        labels: labels('B'),
      });
      await setValues(ctxB, 'customer', FX.customerB, { golden_b_only: 'tajna B' }, keyring);
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [FX.tenantA]);
      const defs = await listDefinitions(ctxFor(db));
      const vals = await db.query('SELECT 1 FROM custom_field_values');
      return { keys: defs.map((d) => d.key), values: vals.rowCount };
    });
    expect(out.keys).not.toContain('golden_b_only');
    expect(out.values).toBe(0);
  });

  it('a P1 value is sealed (never in clear) and can never be a filter; the registry knows it', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      const { id } = await createDefinition(ctx, {
        entityType: 'customer',
        key: 'golden_contact_note',
        type: 'text',
        piiClass: 'P1',
        labels: labels('Napomena'),
      });
      const c = await customer(db, 'CF P1 d.o.o.');
      await setValues(ctx, 'customer', c, { golden_contact_note: SECRET }, keyring);
      const raw = await db.query<{ raw: string }>(
        `SELECT encode(convert_to(v::text, 'UTF8'), 'escape') AS raw FROM custom_field_values v WHERE entity_id = $1`,
        [c],
      );
      const audit = await db.query<{ raw: string }>(
        `SELECT coalesce(after::text, '') AS raw FROM audit_log WHERE request_id = $1`,
        [ctx.requestId],
      );
      const read = await getValues(ctx, 'customer', c, keyring);
      const filterable = await createDefinition(ctx, {
        entityType: 'customer',
        key: 'golden_p1_filter',
        type: 'text',
        piiClass: 'P1',
        filterable: true,
        labels: labels('X'),
      }).catch((e: unknown) => e);
      const makeFilterable = await updateDefinition(ctx, id, { filterable: true }).catch(
        (e: unknown) => e,
      );
      const listFilter = await listReceivableCustomers(ctx, {
        'cf.golden_contact_note': SECRET,
      }).catch((e: unknown) => e);
      const registry = await db.query<{ pii_class: string; encrypted: boolean }>(
        `SELECT pii_class, encrypted FROM pii_field_registry WHERE table_name = 'custom_field_values' AND column_name = $1`,
        [`cf:${id}`],
      );
      return {
        raw: raw.rows[0]?.raw ?? '',
        audit: audit.rows.map((r) => r.raw).join(''),
        read,
        filterable,
        makeFilterable,
        listFilter,
        registry: registry.rows,
      };
    });
    expect(out.raw).not.toContain(SECRET);
    expect(out.raw).not.toContain('8812');
    expect(out.audit).not.toContain(SECRET);
    expect(out.read.golden_contact_note).toBe(SECRET);
    expect(out.filterable).toBeTruthy();
    expect(out.filterable).not.toHaveProperty('id');
    expect(out.makeFilterable).toMatchObject({ code: 'invalid_request' });
    expect(out.listFilter).toBeInstanceOf(InvalidRequestError);
    expect(out.registry).toEqual([{ pii_class: 'P1', encrypted: true }]);
  });

  it('an archived field keeps its value in the history and takes no new value', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      const { id } = await createDefinition(ctx, {
        entityType: 'customer',
        key: 'golden_archived',
        type: 'number',
        piiClass: 'P0',
        labels: labels('Broj'),
      });
      const c = await customer(db, 'CF Arhiva d.o.o.');
      await setValues(ctx, 'customer', c, { golden_archived: '1234.50' }, keyring);
      await updateDefinition(ctx, id, { status: 'archived' });
      const history = await getValues(ctx, 'customer', c, keyring);
      const write = await setValues(ctx, 'customer', c, { golden_archived: '1.00' }, keyring).catch(
        (e: unknown) => e,
      );
      const del = await db.query('DELETE FROM custom_field_definitions WHERE id = $1', [id]).then(
        () => 'deleted',
        (e: { code?: string }) => e.code,
      );
      return { history, write, del };
    });
    expect(out.history.golden_archived).toBe('1234.50');
    expect(out.write).toBeInstanceOf(InvalidRequestError);
    expect(out.del).toBe('42501');
  });

  it('a select field filters the customer list; a rule condition compares a decimal without a float', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      await createDefinition(ctx, {
        entityType: 'customer',
        key: 'golden_region',
        type: 'select',
        piiClass: 'P0',
        filterable: true,
        labels: labels('Region'),
        options: [
          { code: 'vojvodina', labels: labels('Vojvodina') },
          { code: 'sumadija', labels: labels('Šumadija') },
        ],
      });
      const a = await customer(db, 'CF Region A d.o.o.');
      const b = await customer(db, 'CF Region B d.o.o.');
      await setValues(ctx, 'customer', a, { golden_region: 'vojvodina' }, keyring);
      await setValues(ctx, 'customer', b, { golden_region: 'sumadija' }, keyring);
      const bad = await setValues(
        ctx,
        'customer',
        b,
        { golden_region: 'nepostoji' },
        keyring,
      ).catch((e: unknown) => e);
      const listed = await listReceivableCustomers(ctx, {
        q: 'CF Region',
        'cf.golden_region': 'vojvodina',
      });
      return { names: listed.map((r) => r.displayName), bad };
    });
    expect(out.names).toEqual(['CF Region A d.o.o.']);
    expect(out.bad).toBeInstanceOf(InvalidRequestError);

    const facts = {
      custom: { limit: '100000.10', since: '2026-01-15', vip: true },
    } as unknown as Facts;
    const r = evaluateConditions(
      [
        { field: 'custom_field.limit', op: 'gt', value: '100000.09' },
        { field: 'custom_field.since', op: 'lt', value: '2026-02-01' },
        { field: 'custom_field.vip', op: 'eq', value: true },
      ],
      facts,
    );
    expect(r.ok).toBe(true);
    expect(
      evaluateConditions([{ field: 'custom_field.limit', op: 'gt', value: '100000.10' }], facts).ok,
    ).toBe(false);
  });

  it('import maps columns to custom fields: decimals as in the file, labels to option codes', async () => {
    const tax = `CFI${randomUUID().slice(0, 8)}`;
    const ext = `CFI-${randomUUID().slice(0, 6)}`;
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      await createDefinition(ctx, {
        entityType: 'customer',
        key: 'golden_import_region',
        type: 'select',
        piiClass: 'P0',
        labels: labels('Region'),
        options: [{ code: 'srem', labels: labels('Srem') }],
      });
      await createDefinition(ctx, {
        entityType: 'invoice',
        key: 'golden_import_limit',
        type: 'number',
        piiClass: 'P0',
        labels: labels('Limit'),
      });
      const lines = [
        'ID;Broj fakture;Datum fakture;Datum dospeća;Iznos;Saldo;PIB;Naziv kupca;Fizičko lice;Region;Limit',
        `${ext};F-1;01.09.2026;01.10.2026;100,00;100,00;${tax};CF Uvoz d.o.o.;ne;srem;1.234,56`,
      ];
      const up = await uploadImport(
        ctx,
        {
          fileName: 'f.csv',
          format: 'csv',
          content: Buffer.from(lines.join('\r\n'), 'utf8').toString('base64'),
        },
        keyring,
      );
      const mapping = {
        ...up.mapping,
        custom: { 'customer.golden_import_region': 9, 'invoice.golden_import_limit': 10 },
      };
      await validateImport(ctx, up.id, { mapping }, keyring);
      await confirmImport(ctx, up.id);
      await applyImport(ctx.db, ctx.audit, keyring, FX.tenantA, up.id);
      const inv = await db.query<{ id: string; customer_id: string }>(
        `SELECT i.id, i.customer_id FROM invoices i WHERE i.external_id = $1`,
        [ext],
      );
      const row = inv.rows[0];
      return {
        customer: await getValues(ctx, 'customer', row?.customer_id ?? '', keyring),
        invoice: await getValues(ctx, 'invoice', row?.id ?? '', keyring),
      };
    });
    expect(out.customer.golden_import_region).toBe('srem');
    expect(out.invoice.golden_import_limit).toBe('1234.56');
  });

  it('at most custom_fields_max active fields per entity', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      await db.query('UPDATE tenant_settings SET custom_fields_max = 1');
      const ctx = ctxFor(db);
      const n = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM custom_field_definitions WHERE entity_type = 'invoice' AND status = 'active'`,
      );
      if ((n.rows[0]?.n ?? 0) === 0)
        await createDefinition(ctx, {
          entityType: 'invoice',
          key: 'golden_first',
          type: 'text',
          piiClass: 'P0',
          labels: labels('1'),
        });
      return createDefinition(ctx, {
        entityType: 'invoice',
        key: 'golden_second',
        type: 'text',
        piiClass: 'P0',
        labels: labels('2'),
      }).catch((e: unknown) => e);
    });
    expect(out).toMatchObject({ code: 'limit_exceeded' });
  });
});
