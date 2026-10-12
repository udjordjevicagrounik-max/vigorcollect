import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parsePermissionMatrix } from '@/server/permissions/matrix';
import { appPool, closePools } from './helpers';

// Golden (never delete or skip): the permissions catalog equals docs/permissions.md (rule 7).
// Adding a key to one side only — document or migration — fails here.

afterAll(closePools);

const matrixKeys = parsePermissionMatrix(
  readFileSync(join(process.cwd(), 'docs/permissions.md'), 'utf8'),
)
  .permissions.map((p) => p.key)
  .sort();

describe('golden/db: permissions catalog ↔ docs/permissions.md', () => {
  it('every matrix key exists in permissions and every catalog key is in the matrix', async () => {
    const { rows } = await appPool.query<{ key: string }>(
      'SELECT key FROM permissions ORDER BY key',
    );
    const dbKeys = rows.map((r) => r.key);
    expect(matrixKeys.filter((k) => !dbKeys.includes(k))).toEqual([]);
    expect(dbKeys.filter((k) => !matrixKeys.includes(k))).toEqual([]);
  });
});
