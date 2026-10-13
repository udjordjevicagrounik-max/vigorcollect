import type { TenantContext } from '@/server/auth/with-tenant';

/**
 * Admin → "Getting started" (5.4): the onboarding checklist, every step detected from data — no
 * manual ticking. Shown (and in the navigation) until all steps are done. The twelve steps are
 * derived from the MVP features (domain section 92 is not in the repository — assumption noted
 * in docs/NEXT.md); each links to the screen that completes it. Tenant-wide counts only (EXISTS),
 * behind settings.read — no row leaves.
 */

export const ONBOARDING_STEPS = [
  'organization',
  'companies',
  'calendar',
  'users',
  'teams',
  'customers',
  'invoices',
  'owners',
  'collection_settings',
  'templates',
  'rules',
  'mailbox',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

const HREF: Record<OnboardingStep, string> = {
  organization: '/admin/settings',
  companies: '/admin/settings',
  calendar: '/admin/settings',
  users: '/admin/users',
  teams: '/admin/teams',
  customers: '/import',
  invoices: '/import',
  owners: '/customers',
  collection_settings: '/admin/settings',
  templates: '/admin/templates',
  rules: '/admin/rules',
  mailbox: '/admin/integrations',
};

/** One EXISTS per step — fixed SQL, no input. */
const CHECK: Record<OnboardingStep, string> = {
  organization: `SELECT (EXISTS (SELECT 1 FROM audit_log WHERE action = 'tenant_settings.updated')) AS done`,
  companies: `SELECT (EXISTS (SELECT 1 FROM tenant_companies WHERE status = 'active')) AS done`,
  calendar: `SELECT (EXISTS (SELECT 1 FROM audit_log WHERE action = 'settings.calendar_changed')) AS done`,
  users: `SELECT ((SELECT count(*) FROM users WHERE status IN ('active', 'invited')) > 1
                 OR EXISTS (SELECT 1 FROM user_invitations)) AS done`,
  teams: `SELECT (EXISTS (SELECT 1 FROM teams WHERE status = 'active')) AS done`,
  customers: `SELECT (EXISTS (SELECT 1 FROM customers)) AS done`,
  invoices: `SELECT (EXISTS (SELECT 1 FROM invoices)) AS done`,
  owners: `SELECT (EXISTS (SELECT 1 FROM customers WHERE owner_user_id IS NOT NULL)) AS done`,
  collection_settings: `SELECT (EXISTS (SELECT 1 FROM audit_log
                                       WHERE action IN ('settings.aging_buckets_changed', 'settings.thresholds_changed',
                                                        'settings.code_list_changed'))) AS done`,
  templates: `SELECT (EXISTS (SELECT 1 FROM audit_log WHERE action = 'template.version_saved')) AS done`,
  rules: `SELECT (EXISTS (SELECT 1 FROM workflow_versions WHERE status = 'published' AND NOT provisioned)) AS done`,
  mailbox: `SELECT (EXISTS (SELECT 1 FROM mailbox_connections WHERE status = 'connected')
                OR EXISTS (SELECT 1 FROM integrations WHERE type = 'mailbox' AND status = 'active'
                           AND config ? 'outboundUrl')) AS done`,
};

export type OnboardingState = {
  steps: { key: OnboardingStep; done: boolean; href: string }[];
  done: number;
  total: number;
  complete: boolean;
};

export async function onboardingState(ctx: TenantContext): Promise<OnboardingState> {
  await ctx.requirePermission('settings.read');
  const steps = [];
  for (const key of ONBOARDING_STEPS) {
    const { rows } = await ctx.db.query<{ done: boolean }>(CHECK[key]);
    steps.push({ key, done: rows[0]?.done ?? false, href: HREF[key] });
  }
  const done = steps.filter((s) => s.done).length;
  return { steps, done, total: steps.length, complete: done === steps.length };
}
