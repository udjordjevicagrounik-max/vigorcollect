import { z } from 'zod';
import { PermissionDeniedError, type Scope } from '@/server/auth/permissions';
import { scopeFilter } from '@/server/auth/scope';
import type { TenantContext } from '@/server/auth/with-tenant';
import { getMasterKeyring, type MasterKeyring } from '@/server/crypto/keyring';
import { findContactIdsByEmail } from '@/server/customers/repository';
import { likeContains, likePrefix } from '@/server/db-like';

/**
 * Global search (5.1, Ctrl/Cmd+K): customers (name, tax id, external id), invoices (number),
 * open cases (by their customer), contacts (exact e-mail through the blind index — the address
 * itself is encrypted and never compared in clear). Everything goes through the CUSTOMER's
 * scopeFilter, so a member finds only what Customer 360 would show them; RLS keeps tenants apart.
 * At most 20 results. The query never reaches a log (it may be a name or an e-mail, P1).
 */

export const SEARCH_LIMIT = 20;
export const searchQuery = z.object({ q: z.string().trim().min(2).max(100) });

export type SearchHit = {
  kind: 'customer' | 'invoice' | 'case' | 'contact';
  id: string;
  customerId: string;
  /** Customer display name; null = natural person (the UI shows its generic label). */
  customerName: string | null;
  /** Invoice number / tax id / case stage code — P0 only. */
  detail: string | null;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function globalSearch(
  ctx: TenantContext,
  input: z.input<typeof searchQuery>,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<SearchHit[]> {
  const { q } = searchQuery.parse(input);
  const { scope } = await ctx.requirePermission('customer.read');
  // Invoices and cases only with their own read permission, each with ITS scope.
  const grant = async (key: string): Promise<Scope | null> => {
    try {
      return (await ctx.requirePermission(key)).scope;
    } catch (error) {
      if (error instanceof PermissionDeniedError) return null;
      throw error;
    }
  };
  const me = { userId: ctx.userId, scope };
  const hits: SearchHit[] = [];
  const room = () => SEARCH_LIMIT - hits.length;

  // Contacts: an e-mail is matched exactly through the blind index (never ILIKE on ciphertext).
  if (EMAIL.test(q)) {
    const ids = await findContactIdsByEmail(ctx.db, keyring, q);
    if (ids.length) {
      const f = scopeFilter('customers', me, 'c', 3);
      const { rows } = await ctx.db.query<{ id: string; cid: string; name: string | null }>(
        `SELECT cc.id, c.id AS cid, c.display_name AS name
         FROM customer_contacts cc JOIN customers c ON c.id = cc.customer_id
         WHERE cc.id = ANY($1::uuid[]) AND ${f.sql}
         ORDER BY c.display_name NULLS LAST, cc.id LIMIT $2`,
        [ids, room(), ...f.params],
      );
      for (const r of rows)
        hits.push({
          kind: 'contact',
          id: r.id,
          customerId: r.cid,
          customerName: r.name,
          detail: null,
        });
    }
  }

  const contains = likeContains(q);
  if (room() > 0) {
    const f = scopeFilter('customers', me, 'c', 4);
    const { rows } = await ctx.db.query<{ id: string; name: string | null; tax_id: string | null }>(
      `SELECT c.id, c.display_name AS name, le.tax_id
       FROM customers c LEFT JOIN legal_entities_public le ON le.id = c.legal_entity_id
       WHERE (c.display_name ILIKE $1 OR le.tax_id ILIKE $1 OR c.external_id ILIKE $1)
         AND ${f.sql}
       ORDER BY (lower(c.display_name) = lower($3)) DESC, c.display_name NULLS LAST, c.id
       LIMIT $2`,
      [contains, room(), q, ...f.params],
    );
    for (const r of rows)
      hits.push({
        kind: 'customer',
        id: r.id,
        customerId: r.id,
        customerName: r.name,
        detail: r.tax_id,
      });
  }

  const invoiceScope = room() > 0 ? await grant('invoice.read') : null;
  if (invoiceScope) {
    const f = scopeFilter('customers', { userId: ctx.userId, scope: invoiceScope }, 'c', 3);
    const { rows } = await ctx.db.query<{
      id: string;
      cid: string;
      name: string | null;
      number: string;
    }>(
      `SELECT i.id, c.id AS cid, c.display_name AS name, i.number
       FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE lower(i.number) LIKE lower($1) AND ${f.sql}
       ORDER BY i.number, i.id LIMIT $2`,
      [likePrefix(q), room(), ...f.params],
    );
    for (const r of rows)
      hits.push({
        kind: 'invoice',
        id: r.id,
        customerId: r.cid,
        customerName: r.name,
        detail: r.number,
      });
  }

  const caseScope = room() > 0 ? await grant('case.read') : null;
  if (caseScope) {
    const f = scopeFilter('customers', { userId: ctx.userId, scope: caseScope }, 'c', 3);
    const { rows } = await ctx.db.query<{
      id: string;
      cid: string;
      name: string | null;
      stage: string;
    }>(
      `SELECT k.id, c.id AS cid, c.display_name AS name, k.stage_code AS stage
       FROM collection_cases k JOIN customers c ON c.id = k.customer_id
       WHERE k.status = 'open' AND c.display_name ILIKE $1 AND ${f.sql}
       ORDER BY c.display_name, k.opened_at DESC LIMIT $2`,
      [contains, room(), ...f.params],
    );
    for (const r of rows)
      hits.push({
        kind: 'case',
        id: r.id,
        customerId: r.cid,
        customerName: r.name,
        detail: r.stage,
      });
  }
  return hits.slice(0, SEARCH_LIMIT);
}
