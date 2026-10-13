import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit } from '@/server/auth/audit';
import type { TenantContext } from '@/server/auth/with-tenant';
import { parseMasterKeyring } from '@/server/crypto/keyring';
import { createCustomer } from '@/server/customers/repository';
import { applyImport } from '@/server/imports/process';
import { confirmImport, uploadImport, validateImport } from '@/server/imports/service';
import { listSuspiciousParties } from '@/server/imports/suspicious';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, inTenantCommit, migratePool } from './helpers';

// Golden (never delete or skip) — security review S-02 (rules 19, 20, 25): an import never turns
// a natural person into a company. The identifier rules of the customer's country decide
// (jurisdiction_profiles.party_id_rules, here the RS rules on the test country XX), together
// with the optional "natural person" column:
//   - a personal identifier → a consumer: no legal entity, the identifier is never stored, the
//     name only encrypted; found again only by the source system's customer id;
//   - uncertain (no match, a contradiction, a consumer without a customer id) → the row is not
//     imported, exception review_required;
//   - existing company customers with a personal identifier are LISTED, never changed.

const keyring = parseMasterKeyring(`1:${randomBytes(32).toString('base64')}`);
const RS_RULES = { natural_person: '^[0-9]{13}$', company: '^[0-9]{9}$' };
const digits = (n: number) =>
  Array.from(randomBytes(n), (b) => String(b % 10))
    .join('')
    .replace(/^0/, '1');
const JMBG = digits(13);
const JMBG_2 = digits(13);
const PIB = digits(9);
const RUN = randomUUID().slice(0, 8);

const HEADER =
  'ID;Broj fakture;Datum fakture;Datum dospeća;Iznos;Saldo;PIB;Naziv kupca;Šifra kupca;Fizičko lice';
const row = (n: number, taxId: string, name: string, customerId: string, natural: string) =>
  `P-${RUN}-${n};F-${n};01.09.2026;30.09.2026;100,00;100,00;${taxId};${name};${customerId};${natural}`;

const setRules = (rules: object) =>
  migratePool.query(
    `UPDATE jurisdiction_profiles SET party_id_rules = $1::jsonb WHERE country_code = 'XX'`,
    [JSON.stringify(rules)],
  );

beforeAll(async () => {
  await ensureFixtures();
  await inTenantCommit(migratePool, FX.tenantA, async (c) => {
    await c.query('SELECT provision_receivables_defaults()');
  });
  await setRules(RS_RULES);
});
afterAll(async () => {
  await setRules({});
  await closePools();
});

function ctxFor(db: PoolClient): TenantContext {
  const requestId = randomUUID();
  return {
    db,
    tenantId: FX.tenantA,
    userId: FX.userA,
    authUserId: 'golden',
    requestId,
    requirePermission: async (key) => ({ key, scope: 'ORGANIZATION' }),
    requireAnyPermission: async (keys) => ({ key: keys[0] ?? '', scope: 'ORGANIZATION' }),
    audit: (entry) => writeAudit(db, { type: 'user', id: FX.userA }, entry, requestId),
  };
}

async function runImport(ctx: TenantContext, lines: string[]) {
  const content = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64');
  const up = await uploadImport(ctx, { fileName: 'p.csv', format: 'csv', content }, keyring);
  await validateImport(ctx, up.id, { mapping: up.mapping }, keyring);
  await confirmImport(ctx, up.id);
  await applyImport(ctx.db, ctx.audit, keyring, FX.tenantA, up.id);
  return up;
}

describe('golden/db: natural persons in the invoice import (S-02)', () => {
  it('classifies every row by the country rules; uncertain rows are not imported', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const ctx = ctxFor(db);
      const up = await runImport(ctx, [
        HEADER,
        row(1, JMBG, 'Petar Potrošač', `C-${RUN}-1`, ''), // personal id → consumer
        row(2, JMBG_2, 'Bez Šifre', '', ''), // consumer without a customer id → review
        row(3, PIB, 'Firma d.o.o.', '', ''), // business id → company
        row(4, `X-${RUN}`, 'Nepoznato', '', ''), // matches nothing → review
        row(5, JMBG, 'Kontradikcija', `C-${RUN}-5`, 'ne'), // "not a natural person" + JMBG → review
        row(6, JMBG, 'Petar Potrošač', `C-${RUN}-1`, 'da'), // same consumer again → same customer
      ]);
      expect(up.mapping.columns.customer_is_natural_person).toBe(9);
      const invoices = await db.query<{
        external_id: string;
        natural: boolean;
        le: string | null;
        name: string | null;
      }>(
        `SELECT i.external_id, c.is_natural_person AS natural, c.legal_entity_id AS le, c.display_name AS name
         FROM invoices i JOIN customers c ON c.id = i.customer_id
         WHERE i.external_id LIKE $1 ORDER BY i.external_id`,
        [`P-${RUN}-%`],
      );
      const exceptions = await db.query<{ row_number: number; kind: string }>(
        `SELECT row_number, kind FROM reconciliation_exceptions WHERE run_id = $1 ORDER BY row_number`,
        [up.id],
      );
      const consumers = await db.query(
        `SELECT 1 FROM customers WHERE external_id = $1 AND is_natural_person AND legal_entity_id IS NULL`,
        [`C-${RUN}-1`],
      );
      return {
        invoices: invoices.rows,
        exceptions: exceptions.rows,
        consumers: consumers.rowCount,
      };
    });
    expect(out.invoices).toEqual([
      { external_id: `P-${RUN}-1`, natural: true, le: null, name: null },
      { external_id: `P-${RUN}-3`, natural: false, le: expect.any(String), name: 'Firma d.o.o.' },
      { external_id: `P-${RUN}-6`, natural: true, le: null, name: null },
    ]);
    expect(out.exceptions).toEqual([
      { row_number: 3, kind: 'review_required' },
      { row_number: 5, kind: 'review_required' },
      { row_number: 6, kind: 'review_required' },
    ]);
    expect(out.consumers).toBe(1);
    // The personal identifier never became a canonical (platform-wide) identity.
    const leaked = await migratePool.query('SELECT 1 FROM legal_entities WHERE tax_id = ANY($1)', [
      [JMBG, JMBG_2],
    ]);
    expect(leaked.rowCount).toBe(0);
  });

  it('existing company customers with a personal identifier are listed, never changed', async () => {
    const out = await inTenant(appPool, FX.tenantA, async (db) => {
      const { id } = await createCustomer(db, keyring, {
        countryCode: 'XX',
        taxId: digits(13),
        legalName: 'Stari Uvoz',
        timezone: 'UTC',
        isNaturalPerson: false,
        displayName: 'Stari Uvoz',
      });
      const listed = await listSuspiciousParties(ctxFor(db));
      const flag = await db.query<{ natural: boolean }>(
        'SELECT is_natural_person AS natural FROM customers WHERE id = $1',
        [id],
      );
      return { listed: listed.filter((p) => p.customerId === id), natural: flag.rows[0]?.natural };
    });
    expect(out.listed).toEqual([
      { customerId: expect.any(String), displayName: 'Stari Uvoz', reason: 'personal_identifier' },
    ]);
    expect(out.natural).toBe(false);
  });
});
