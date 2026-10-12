import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Golden (never delete or skip) — task 1.6: every query over a scoped entity goes through
// scopeFilter() (src/server/auth/scope.ts). The repository is an exception: it writes and
// decrypts by id, and is reached only with ids a scoped read returned.
// Task 2.3: receivables (invoices, payments, promises, activities, cases) are scoped through
// their customer. Import (2.2) is a tenant-wide operation behind import.create and works on the
// rows of its own run — the second exception.

const SRC = join(process.cwd(), 'src');
const SCOPED_TABLES = [
  'customers',
  'invoices',
  'invoice_positions',
  'payments',
  'promises',
  'activities',
  'collection_cases',
];
const ALLOWED = new Set([
  'server/customers/repository.ts',
  'server/imports/service.ts',
  'server/imports/process.ts',
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

export function scopeViolations(source: string, tables = SCOPED_TABLES): string[] {
  const reads = tables.filter((t) => new RegExp(`\\b(FROM|JOIN)\\s+${t}\\b`, 'i').test(source));
  return reads.length && !/scopeFilter\(/.test(source) ? reads : [];
}

describe('golden: scoped entities are read only through scopeFilter()', () => {
  it('no query over customers outside scopeFilter (repository excepted)', () => {
    const violations = files(SRC)
      .map((f) => ({ file: relative(SRC, f), tables: scopeViolations(readFileSync(f, 'utf8')) }))
      .filter((v) => v.tables.length && !ALLOWED.has(v.file));
    expect(violations).toEqual([]);
  });

  it('the checker catches a raw read', () => {
    expect(scopeViolations('SELECT id FROM customers WHERE id = $1')).toEqual(['customers']);
    expect(scopeViolations('SELECT 1 FROM x JOIN customers c ON true; scopeFilter(')).toEqual([]);
  });
});
