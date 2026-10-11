import { afterAll, describe, expect, it } from 'vitest';
import { closePools, migratePool } from './helpers';

// Golden (never delete or skip): every column has a PII class (rule 20).

afterAll(closePools);

describe('golden/db: pii_field_registry', () => {
  it('every column of every public table is registered', async () => {
    const { rows } = await migratePool.query<{ column: string }>(
      `SELECT c.table_name || '.' || c.column_name AS column
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       LEFT JOIN pii_field_registry r
         ON r.table_name = c.table_name AND r.column_name = c.column_name
       WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND r.id IS NULL
       ORDER BY 1`,
    );
    expect(rows.map((r) => r.column)).toEqual([]);
  });

  it('registry has no rows for columns that do not exist', async () => {
    const { rows } = await migratePool.query<{ column: string }>(
      `SELECT r.table_name || '.' || r.column_name AS column
       FROM pii_field_registry r
       LEFT JOIN information_schema.columns c
         ON c.table_schema = 'public' AND c.table_name = r.table_name AND c.column_name = r.column_name
       WHERE c.column_name IS NULL
       ORDER BY 1`,
    );
    expect(rows.map((r) => r.column)).toEqual([]);
  });

  it('natural-person identity fields are conditionally P1/P2; P1+ fields are not yet encrypted (0.2b)', async () => {
    const { rows } = await migratePool.query(
      `SELECT table_name, column_name, pii_class, conditional_pii_class, encrypted
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
      },
      {
        table_name: 'legal_entities',
        column_name: 'registration_number',
        pii_class: 'P0',
        conditional_pii_class: 'P2',
        encrypted: false,
      },
      {
        table_name: 'users',
        column_name: 'email',
        pii_class: 'P1',
        conditional_pii_class: null,
        encrypted: false,
      },
    ]);
  });
});
