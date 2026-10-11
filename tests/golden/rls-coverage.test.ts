import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Golden test (never delete or skip — CLAUDE.md "Radni proces").
// Rule 1: every table with tenant_id has RLS enabled AND at least one policy.
// Static check over the migration SQL; tests against a live DB arrive in 1.6.

const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function normalizeName(name: string): string {
  return name.replace(/"/g, '').toLowerCase().split('.').pop() ?? '';
}

function findRlsViolations(sql: string): string[] {
  const clean = stripComments(sql);
  const tenantTables = new Set<string>();

  const createTable = /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*\(([\s\S]*?)\);/gi;
  for (const match of clean.matchAll(createTable)) {
    if (/\btenant_id\b/i.test(match[2] ?? '')) tenantTables.add(normalizeName(match[1] ?? ''));
  }
  const addColumn =
    /alter\s+table\s+(?:only\s+)?([\w."]+)[^;]*?add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?tenant_id\b/gi;
  for (const match of clean.matchAll(addColumn)) tenantTables.add(normalizeName(match[1] ?? ''));

  const rlsEnabled = new Set(
    [
      ...clean.matchAll(
        /alter\s+table\s+(?:only\s+)?([\w."]+)\s+enable\s+row\s+level\s+security/gi,
      ),
    ].map((m) => normalizeName(m[1] ?? '')),
  );
  const withPolicy = new Set(
    [...clean.matchAll(/create\s+policy\s+[\w"]+\s+on\s+([\w."]+)/gi)].map((m) =>
      normalizeName(m[1] ?? ''),
    ),
  );

  return [...tenantTables].filter((t) => !rlsEnabled.has(t) || !withPolicy.has(t)).sort();
}

function readUpMigrations(): string {
  if (!existsSync(MIGRATIONS_DIR)) return '';
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*up\.sql$/.test(f))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
}

describe('golden: RLS coverage for tenant tables', () => {
  it('no table with tenant_id lacks RLS + policy in db/migrations', () => {
    expect(findRlsViolations(readUpMigrations())).toEqual([]);
  });

  it('detector flags a tenant table without RLS (self-check)', () => {
    const bad = 'create table invoices (id uuid, tenant_id uuid not null);';
    expect(findRlsViolations(bad)).toEqual(['invoices']);
  });

  it('detector accepts a tenant table with RLS and a policy (self-check)', () => {
    const good = `
      create table public.invoices (id uuid, tenant_id uuid not null);
      alter table public.invoices enable row level security;
      create policy tenant_isolation on public.invoices
        using (tenant_id = current_setting('app.tenant_id')::uuid);`;
    expect(findRlsViolations(good)).toEqual([]);
  });
});
