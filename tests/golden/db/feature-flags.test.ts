import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SETTLEMENT_FLAGS } from '@/lib/feature-flags';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, sqlState } from './helpers';

// Golden (never delete or skip): two-level settlement flags (rule 31).

beforeAll(ensureFixtures);
afterAll(closePools);

describe('golden/db: feature flags', () => {
  it('all settlement.* platform flags exist and are off', async () => {
    const { rows } = await inTenant(appPool, FX.tenantA, (c) =>
      c.query<{ key: string; enabled: boolean }>(
        "SELECT key, enabled FROM platform_feature_flags WHERE key LIKE 'settlement.%' ORDER BY key",
      ),
    );
    expect(rows.map((r) => r.key)).toEqual([...SETTLEMENT_FLAGS].sort());
    expect(rows.every((r) => !r.enabled)).toBe(true);
  });

  it('a tenant cannot switch a flag on while the platform flag is off', async () => {
    const state = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(
        c.query(
          `INSERT INTO feature_flags (tenant_id, flag_key, enabled, enabled_by, enabled_at,
                                      legal_basis_confirmed_at, jurisdiction_country_code)
           VALUES ($1, 'settlement.bilateral', true, $2, now(), now(), 'XX')`,
          [FX.tenantA, FX.userA],
        ),
      ),
    );
    expect(state).toBe('23514');
  });

  it('a tenant may store a flag that is off (control)', async () => {
    const state = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(
        c.query(
          "INSERT INTO feature_flags (tenant_id, flag_key, enabled) VALUES ($1, 'settlement.bilateral', false)",
          [FX.tenantA],
        ),
      ),
    );
    expect(state).toBe('OK');
  });

  it('enabling a settlement flag without legal basis is rejected by the CHECK', async () => {
    const state = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(
        c.query(
          `INSERT INTO feature_flags (tenant_id, flag_key, enabled, enabled_by, enabled_at)
           VALUES ($1, 'settlement.bilateral', true, $2, now())`,
          [FX.tenantA, FX.userA],
        ),
      ),
    );
    expect(state).toBe('23514');
  });
});
