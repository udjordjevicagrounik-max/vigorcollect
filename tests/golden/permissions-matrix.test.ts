import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  grantsByRole,
  MatrixError,
  parsePermissionMatrix,
  RULE_11_APPROVALS,
} from '@/server/permissions/matrix';

// Golden (never delete or skip): shape of docs/permissions.md (rule 7) and maker-checker
// permissions (rule 11). The DB side lives in tests/golden/db/permissions-catalog.test.ts.

const matrix = parsePermissionMatrix(
  readFileSync(join(process.cwd(), 'docs/permissions.md'), 'utf8'),
);

const ROLES = [
  'owner',
  'admin',
  'cfo',
  'finance_manager',
  'collection_manager',
  'collector',
  'sales_manager',
  'sales_rep',
  'legal_manager',
  'auditor',
  'read_only',
];

const OBJECTS = [
  'tenant',
  'user',
  'role',
  // Sprint 1 close-out (migration 011): teams get their own keys.
  'team',
  'customer',
  'contact',
  'invoice',
  'payment',
  'case',
  'promise',
  'activity',
  'dispute',
  'decision',
  'approval',
  'document',
  'report',
  'export',
  'import',
  'integration',
  'audit',
  'settings',
  'feature_flag',
];

const ACTIONS = ['read', 'create', 'update', 'assign', 'approve', 'export', 'manage'];

describe('golden: permission matrix (docs/permissions.md)', () => {
  it('has exactly the 11 system roles; external parties are not a role (rule 34)', () => {
    expect(matrix.roles).toEqual(ROLES);
    expect(matrix.roles).not.toContain('external_lawyer');
  });

  it('covers every MVP object with known actions only', () => {
    const objects = new Set(matrix.permissions.map((p) => p.key.split('.')[0]));
    expect([...objects].sort()).toEqual([...OBJECTS].sort());
    const unknown = matrix.permissions
      .map((p) => p.key)
      .filter((k) => {
        const action = k.split('.')[1] ?? '';
        return !ACTIONS.includes(action) && !(RULE_11_APPROVALS as readonly string[]).includes(k);
      });
    expect(unknown).toEqual([]);
  });

  it('rule 11 actions exist as approval.* and are held only as checker (🅼)', () => {
    for (const key of RULE_11_APPROVALS) {
      const row = matrix.permissions.find((p) => p.key === key);
      expect(row, key).toBeDefined();
      expect(row?.roles.length, key).toBeGreaterThan(0);
      expect(row?.checkerOnly, key).toEqual(row?.roles);
    }
  });

  it('collector and sales_rep never hold a rule 11 decision; they may only submit requests', () => {
    const grants = grantsByRole(matrix);
    for (const role of ['collector', 'sales_rep']) {
      const held = grants.get(role) ?? [];
      expect(held.filter((k) => (RULE_11_APPROVALS as readonly string[]).includes(k))).toEqual([]);
      expect(held).toContain('approval.create');
    }
  });

  it('owner holds every permission; read_only and auditor hold reads only', () => {
    const grants = grantsByRole(matrix);
    expect(grants.get('owner')).toEqual(matrix.permissions.map((p) => p.key));
    for (const role of ['read_only', 'auditor']) {
      const writes = (grants.get(role) ?? []).filter(
        (k) => !k.endsWith('.read') && !(role === 'auditor' && k.endsWith('.export')),
      );
      expect(writes, role).toEqual([]);
    }
  });

  it('the parser rejects unknown cells instead of dropping a permission', () => {
    const bad = [
      '| objekat.akcija | opis | `owner` |',
      '| --- | --- | --- |',
      '| `customer.read` | x | yes |',
    ].join('\n');
    expect(() => parsePermissionMatrix(bad)).toThrow(MatrixError);
  });
});
