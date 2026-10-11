import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Golden test (never delete or skip — CLAUDE.md "Radni proces").
// Static check over the migration SQL (the live-DB counterpart is tests/golden/db/rls.test.ts):
//   * rule 1: every table with tenant_id has RLS ENABLE + FORCE + at least one policy;
//   * schema v1: EVERY table has ENABLE + FORCE + a policy, so the owner (vigor_migrate) can
//     never bypass RLS. Only the migration ledger from 000 is exempt (no tenant data, app = SELECT).

const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');
const EXEMPT_TABLES = new Set(['schema_migrations']);

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function normalizeName(name: string): string {
  return name.replace(/"/g, '').toLowerCase().split('.').pop() ?? '';
}

function tablesMatching(sql: string, re: RegExp): Set<string> {
  return new Set([...sql.matchAll(re)].map((m) => normalizeName(m[1] ?? '')));
}

type Violation = { table: string; missing: string[] };

function findRlsViolations(sql: string): Violation[] {
  const clean = stripComments(sql);
  const allTables = new Set<string>();
  const tenantTables = new Set<string>();

  const createTable = /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*\(([\s\S]*?)\);/gi;
  for (const match of clean.matchAll(createTable)) {
    const name = normalizeName(match[1] ?? '');
    allTables.add(name);
    if (/\btenant_id\b/i.test(match[2] ?? '')) tenantTables.add(name);
  }
  const addColumn =
    /alter\s+table\s+(?:only\s+)?([\w."]+)[^;]*?add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?tenant_id\b/gi;
  for (const match of clean.matchAll(addColumn)) tenantTables.add(normalizeName(match[1] ?? ''));

  const enabled = tablesMatching(
    clean,
    /alter\s+table\s+(?:only\s+)?([\w."]+)\s+enable\s+row\s+level\s+security/gi,
  );
  const forced = tablesMatching(
    clean,
    /alter\s+table\s+(?:only\s+)?([\w."]+)\s+force\s+row\s+level\s+security/gi,
  );
  const withPolicy = tablesMatching(clean, /create\s+policy\s+[\w"]+\s+on\s+([\w."]+)/gi);

  const checked = new Set([...allTables].filter((t) => !EXEMPT_TABLES.has(t)));
  for (const t of tenantTables) checked.add(t); // tenant tables are never exempt

  return [...checked]
    .sort()
    .map((table) => ({
      table,
      missing: [
        enabled.has(table) ? null : 'ENABLE',
        forced.has(table) ? null : 'FORCE',
        withPolicy.has(table) ? null : 'POLICY',
      ].filter((m): m is string => m !== null),
    }))
    .filter((v) => v.missing.length > 0);
}

function readUpMigrations(): string {
  if (!existsSync(MIGRATIONS_DIR)) return '';
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*up\.sql$/.test(f))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
}

describe('golden: RLS coverage in db/migrations', () => {
  it('every table has RLS ENABLE + FORCE + a policy', () => {
    expect(findRlsViolations(readUpMigrations())).toEqual([]);
  });

  it('detector flags a tenant table without RLS (self-check)', () => {
    const bad = 'create table invoices (id uuid, tenant_id uuid not null);';
    expect(findRlsViolations(bad)).toEqual([
      { table: 'invoices', missing: ['ENABLE', 'FORCE', 'POLICY'] },
    ]);
  });

  it('detector flags ENABLE without FORCE (self-check)', () => {
    const bad = `
      create table invoices (id uuid, tenant_id uuid not null);
      alter table invoices enable row level security;
      create policy tenant_isolation on invoices using (tenant_id = app_tenant_id());`;
    expect(findRlsViolations(bad)).toEqual([{ table: 'invoices', missing: ['FORCE'] }]);
  });

  it('detector flags a platform table without RLS (self-check)', () => {
    expect(findRlsViolations('create table currencies (code char(3));')).toEqual([
      { table: 'currencies', missing: ['ENABLE', 'FORCE', 'POLICY'] },
    ]);
  });

  it('detector accepts a table with ENABLE + FORCE + policy (self-check)', () => {
    const good = `
      create table public.invoices (id uuid, tenant_id uuid not null);
      alter table public.invoices enable row level security;
      alter table public.invoices force row level security;
      create policy tenant_isolation on public.invoices
        using (tenant_id = current_setting('app.tenant_id')::uuid);`;
    expect(findRlsViolations(good)).toEqual([]);
  });
});
