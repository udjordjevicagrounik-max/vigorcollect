import { afterAll, describe, expect, it } from 'vitest';
import { closePools, migratePool } from './helpers';

// Golden (never delete or skip): every column has a PII class (rule 20).

afterAll(closePools);

describe('golden/db: pii_field_registry', () => {
  // Registry names: bare for schema public, schema-qualified otherwise (auth.user, 005).
  const REGISTRY_NAME = `CASE WHEN c.table_schema = 'public' THEN c.table_name
                              ELSE c.table_schema || '.' || c.table_name END`;

  it('every column of every public and auth table is registered', async () => {
    const { rows } = await migratePool.query<{ column: string }>(
      `SELECT ${REGISTRY_NAME} || '.' || c.column_name AS column
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       LEFT JOIN pii_field_registry r
         ON r.table_name = ${REGISTRY_NAME} AND r.column_name = c.column_name
       WHERE c.table_schema IN ('public', 'auth') AND t.table_type = 'BASE TABLE' AND r.id IS NULL
       ORDER BY 1`,
    );
    expect(rows.map((r) => r.column)).toEqual([]);
  });

  it('registry has no rows for columns that do not exist', async () => {
    const { rows } = await migratePool.query<{ column: string }>(
      `SELECT r.table_name || '.' || r.column_name AS column
       FROM pii_field_registry r
       LEFT JOIN information_schema.columns c
         ON c.table_schema IN ('public', 'auth') AND ${REGISTRY_NAME} = r.table_name
        AND c.column_name = r.column_name
       -- 6.1: one row per custom field definition ('cf:<id>', written by the 027 trigger) —
       -- virtual columns of custom_field_values, checked in custom-fields.test.ts.
       WHERE c.column_name IS NULL
         AND NOT (r.table_name = 'custom_field_values' AND r.column_name LIKE 'cf:%')
       ORDER BY 1`,
    );
    expect(rows.map((r) => r.column)).toEqual([]);
  });

  it('natural-person identity fields are conditionally P1/P2 (sole trader); users.email is an auth-identity exception', async () => {
    const { rows } = await migratePool.query(
      `SELECT table_name, column_name, pii_class, conditional_pii_class, encrypted, exception_reason
       FROM pii_field_registry
       WHERE (table_name, column_name) IN (('users','email'), ('legal_entities','registration_number'),
                                           ('legal_entities','legal_name'))
       ORDER BY table_name, column_name`,
    );
    expect(rows).toEqual([
      {
        table_name: 'legal_entities',
        column_name: 'legal_name',
        pii_class: 'P0',
        conditional_pii_class: 'P1',
        encrypted: false,
        exception_reason: 'sole trader: public business register',
      },
      {
        table_name: 'legal_entities',
        column_name: 'registration_number',
        pii_class: 'P0',
        conditional_pii_class: 'P2',
        encrypted: false,
        exception_reason: 'sole trader: public business register',
      },
      {
        table_name: 'users',
        column_name: 'email',
        pii_class: 'P1',
        conditional_pii_class: null,
        encrypted: false,
        exception_reason: 'auth identity',
      },
    ]);
  });

  it('every P1–P3 column is encrypted or carries a documented exception_reason (rule 20)', async () => {
    const { rows } = await migratePool.query<{ column: string }>(
      `SELECT table_name || '.' || column_name AS column
       FROM pii_field_registry
       WHERE pii_class IN ('P1', 'P2', 'P3') AND NOT encrypted AND exception_reason IS NULL
       ORDER BY 1`,
    );
    expect(rows.map((r) => r.column)).toEqual([]);
  });

  it('every conditionally P1–P3 column is encrypted or carries a documented exception_reason', async () => {
    const { rows } = await migratePool.query<{ column: string }>(
      `SELECT table_name || '.' || column_name AS column
       FROM pii_field_registry
       WHERE conditional_pii_class IN ('P1', 'P2', 'P3') AND NOT encrypted AND exception_reason IS NULL
       ORDER BY 1`,
    );
    expect(rows.map((r) => r.column)).toEqual([]);
  });

  it('every *_enc column is registered as encrypted and has a *_key_version column', async () => {
    const { rows } = await migratePool.query<{
      column: string;
      encrypted: boolean;
      versioned: boolean;
    }>(
      `SELECT c.table_name || '.' || c.column_name AS column,
              coalesce(r.encrypted, false) AS encrypted,
              EXISTS (SELECT 1 FROM information_schema.columns v
                      WHERE v.table_schema = 'public' AND v.table_name = c.table_name
                        AND v.column_name = regexp_replace(c.column_name, '_enc$', '_key_version')) AS versioned
       FROM information_schema.columns c
       LEFT JOIN pii_field_registry r ON r.table_name = c.table_name AND r.column_name = c.column_name
       WHERE c.table_schema = 'public' AND right(c.column_name, 4) = '_enc'
       ORDER BY 1`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !r.encrypted || !r.versioned)).toEqual([]);
  });
});
