import { scopeFilter } from '@/server/auth/scope';
import type { TenantContext } from '@/server/auth/with-tenant';
import { classifyParty, type PartyRules } from './party';

/**
 * Review S-02, existing data: customers that earlier imports created as COMPANIES although
 * their identifier — by the rules of their country — is a personal one, or matches no business
 * identifier. Nothing is changed automatically: the list is shown to a person (Import screen),
 * who corrects the customer. Countries without rules are not judged. The identifier itself is
 * read only to classify it and never leaves this function.
 */

export type SuspiciousParty = {
  customerId: string;
  displayName: string;
  reason: 'personal_identifier' | 'no_business_identifier';
};

export async function listSuspiciousParties(ctx: TenantContext): Promise<SuspiciousParty[]> {
  const { scope } = await ctx.requirePermission('customer.read');
  const filter = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 1);
  const { rows } = await ctx.db.query<{
    id: string;
    display_name: string | null;
    tax_id: string;
    rules: PartyRules;
  }>(
    `SELECT c.id, c.display_name, le.tax_id, jp.party_id_rules AS rules
     FROM customers c
     JOIN legal_entities_public le ON le.id = c.legal_entity_id
     JOIN jurisdiction_profiles jp ON jp.country_code = le.country_code
     WHERE NOT c.is_natural_person AND jp.party_id_rules <> '{}'::jsonb AND ${filter.sql}
     ORDER BY lower(c.display_name), c.id
     LIMIT 500`,
    filter.params,
  );
  return rows.flatMap((r): SuspiciousParty[] => {
    const kind = classifyParty(r.rules, r.tax_id, null);
    if (kind === 'company') return [];
    return [
      {
        customerId: r.id,
        displayName: r.display_name ?? '',
        reason: kind === 'consumer' ? 'personal_identifier' : 'no_business_identifier',
      },
    ];
  });
}
