import { scopeFilter } from '@/server/auth/scope';
import { NotFoundError, type TenantContext } from '@/server/auth/with-tenant';

/**
 * Customer reads for routes and pages — always through scopeFilter() (task 1.6). The repository
 * (repository.ts) writes and decrypts by id; callers reach it only for ids this service returned.
 * Natural persons have no plaintext name (ADR 0003): the list shows them without a name.
 */
export type CustomerSummary = {
  id: string;
  displayName: string | null;
  isNaturalPerson: boolean;
  status: string;
  ownerUserId: string | null;
  ownerTeamId: string | null;
};

type Row = {
  id: string;
  display_name: string | null;
  is_natural_person: boolean;
  status: string;
  owner_user_id: string | null;
  owner_team_id: string | null;
};

const toSummary = (r: Row): CustomerSummary => ({
  id: r.id,
  displayName: r.display_name,
  isNaturalPerson: r.is_natural_person,
  status: r.status,
  ownerUserId: r.owner_user_id,
  ownerTeamId: r.owner_team_id,
});

const COLUMNS = `c.id, c.display_name, c.is_natural_person, c.status, c.owner_user_id, c.owner_team_id`;

export async function listCustomers(ctx: TenantContext, limit = 100): Promise<CustomerSummary[]> {
  const { scope } = await ctx.requirePermission('customer.read');
  const filter = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 2);
  const { rows } = await ctx.db.query<Row>(
    `SELECT ${COLUMNS} FROM customers c WHERE ${filter.sql}
     ORDER BY c.display_name NULLS LAST, c.id LIMIT $1`,
    [limit, ...filter.params],
  );
  return rows.map(toSummary);
}

/** One customer if it exists in the tenant AND within the member's scope; otherwise 404. */
export async function getCustomer(ctx: TenantContext, id: string): Promise<CustomerSummary> {
  const { scope } = await ctx.requirePermission('customer.read');
  const filter = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 2);
  const { rows } = await ctx.db.query<Row>(
    `SELECT ${COLUMNS} FROM customers c WHERE c.id = $1 AND ${filter.sql}`,
    [id, ...filter.params],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return toSummary(row);
}
