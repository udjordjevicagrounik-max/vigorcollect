import type { TenantContext } from '@/server/auth/with-tenant';
import { createWorkflow } from '@/server/workflows/service';

/**
 * Policy templates (6.4): ready collection policies as rule DRAFTS — applying one never
 * publishes anything (publishing stays maker-checker, rule 11). Offsets from the due date in the
 * company's zone (rule 26). A legal-effect template (pre-litigation notice) goes only to legal
 * entities (rule 19: is_natural_person = false).
 */

export const POLICY_TEMPLATES = ['friendly', 'standard', 'strict', 'agro_seasonal'] as const;
export type PolicyTemplate = (typeof POLICY_TEMPLATES)[number];

type Rule = { key: string; name: string; definition: Record<string, unknown> };

const when = (policy: string, extra: Record<string, unknown>[] = []) => [
  { field: 'policy', op: 'eq', value: policy },
  ...extra,
];
const company = { field: 'is_natural_person', op: 'eq', value: false };

export const TEMPLATE_RULES: Record<PolicyTemplate, Rule[]> = {
  friendly: [
    {
      key: 'tpl_friendly_before_due',
      name: 'Blaga: podsetnik 3 radna dana pre dospeća',
      definition: {
        trigger: { type: 'days_from_due', offset: -3, businessDays: true },
        conditions: when('friendly'),
        actions: [{ type: 'queue_email', template: 'reminder_before_due' }],
      },
    },
    {
      key: 'tpl_friendly_d7',
      name: 'Blaga: podsetnik (D+7)',
      definition: {
        trigger: { type: 'days_from_due', offset: 7 },
        conditions: when('friendly'),
        actions: [{ type: 'queue_email', template: 'reminder_overdue' }],
      },
    },
    {
      key: 'tpl_friendly_d21',
      name: 'Blaga: poziv (D+21)',
      definition: {
        trigger: { type: 'days_from_due', offset: 21 },
        conditions: when('friendly'),
        actions: [
          { type: 'create_case', priority: 'normal' },
          { type: 'create_task', kind: 'call', dueInDays: 0 },
        ],
      },
    },
    {
      key: 'tpl_friendly_d45',
      name: 'Blaga: eskalacija (D+45)',
      definition: {
        trigger: { type: 'days_from_due', offset: 45 },
        conditions: when('friendly'),
        actions: [{ type: 'escalate' }],
      },
    },
  ],
  standard: [
    {
      key: 'tpl_standard_before_due',
      name: 'Standard: podsetnik 7 radnih dana pre dospeća',
      definition: {
        trigger: { type: 'days_from_due', offset: -7, businessDays: true },
        conditions: when('standard'),
        actions: [{ type: 'queue_email', template: 'reminder_before_due' }],
      },
    },
    {
      key: 'tpl_standard_d1',
      name: 'Standard: podsetnik (D+1)',
      definition: {
        trigger: { type: 'days_from_due', offset: 1 },
        conditions: when('standard'),
        actions: [{ type: 'queue_email', template: 'reminder_overdue' }],
      },
    },
    {
      key: 'tpl_standard_d7',
      name: 'Standard: drugi podsetnik i case (D+7)',
      definition: {
        trigger: { type: 'days_from_due', offset: 7 },
        conditions: when('standard'),
        actions: [
          { type: 'queue_email', template: 'reminder_second' },
          { type: 'create_case', priority: 'normal' },
        ],
      },
    },
    {
      key: 'tpl_standard_d14',
      name: 'Standard: poziv (D+14)',
      definition: {
        trigger: { type: 'days_from_due', offset: 14 },
        conditions: when('standard'),
        actions: [{ type: 'create_task', kind: 'call', dueInDays: 0 }],
      },
    },
    {
      key: 'tpl_standard_d30',
      name: 'Standard: eskalacija (D+30)',
      definition: {
        trigger: { type: 'days_from_due', offset: 30 },
        conditions: when('standard'),
        actions: [{ type: 'create_case', priority: 'high' }, { type: 'escalate' }],
      },
    },
    {
      key: 'tpl_standard_d60',
      name: 'Standard: opomena pred utuženje — pravno lice (D+60)',
      definition: {
        trigger: { type: 'days_from_due', offset: 60 },
        conditions: when('standard', [company]),
        actions: [{ type: 'queue_email', template: 'pre_litigation_notice' }],
      },
    },
  ],
  strict: [
    {
      key: 'tpl_strict_before_due',
      name: 'Stroga: podsetnik 7 radnih dana pre dospeća',
      definition: {
        trigger: { type: 'days_from_due', offset: -7, businessDays: true },
        conditions: when('strict'),
        actions: [{ type: 'queue_email', template: 'reminder_before_due' }],
      },
    },
    {
      key: 'tpl_strict_d1',
      name: 'Stroga: podsetnik (D+1)',
      definition: {
        trigger: { type: 'days_from_due', offset: 1 },
        conditions: when('strict'),
        actions: [
          { type: 'queue_email', template: 'reminder_overdue' },
          { type: 'create_case', priority: 'normal' },
        ],
      },
    },
    {
      key: 'tpl_strict_d5',
      name: 'Stroga: drugi podsetnik i poziv (D+5)',
      definition: {
        trigger: { type: 'days_from_due', offset: 5 },
        conditions: when('strict'),
        actions: [
          { type: 'queue_email', template: 'reminder_second' },
          { type: 'create_task', kind: 'call', dueInDays: 0 },
        ],
      },
    },
    {
      key: 'tpl_strict_d15',
      name: 'Stroga: eskalacija (D+15)',
      definition: {
        trigger: { type: 'days_from_due', offset: 15 },
        conditions: when('strict'),
        actions: [{ type: 'create_case', priority: 'urgent' }, { type: 'escalate' }],
      },
    },
    {
      key: 'tpl_strict_d30',
      name: 'Stroga: opomena pred utuženje — pravno lice (D+30)',
      definition: {
        trigger: { type: 'days_from_due', offset: 30 },
        conditions: when('strict', [company]),
        actions: [{ type: 'queue_email', template: 'pre_litigation_notice' }],
      },
    },
  ],
  agro_seasonal: [
    {
      key: 'tpl_agro_before_due',
      name: 'Agro: podsetnik 14 dana pre dospeća',
      definition: {
        trigger: { type: 'days_from_due', offset: -14 },
        conditions: when('agro_seasonal'),
        actions: [{ type: 'queue_email', template: 'reminder_before_due' }],
      },
    },
    {
      key: 'tpl_agro_d15',
      name: 'Agro: podsetnik (D+15)',
      definition: {
        trigger: { type: 'days_from_due', offset: 15 },
        conditions: when('agro_seasonal'),
        actions: [{ type: 'queue_email', template: 'reminder_overdue' }],
      },
    },
    {
      key: 'tpl_agro_d45',
      name: 'Agro: poziv i case (D+45)',
      definition: {
        trigger: { type: 'days_from_due', offset: 45 },
        conditions: when('agro_seasonal'),
        actions: [
          { type: 'create_case', priority: 'normal' },
          { type: 'create_task', kind: 'call', dueInDays: 0 },
        ],
      },
    },
    {
      key: 'tpl_agro_d90',
      name: 'Agro: eskalacija posle sezone (D+90)',
      definition: {
        trigger: { type: 'days_from_due', offset: 90 },
        conditions: when('agro_seasonal'),
        actions: [{ type: 'escalate' }],
      },
    },
  ],
};

const LABELS: Record<PolicyTemplate, { 'sr-Latn': string; en: string }> = {
  friendly: { 'sr-Latn': 'Blaga', en: 'Friendly' },
  standard: { 'sr-Latn': 'Standardna', en: 'Standard' },
  strict: { 'sr-Latn': 'Stroga', en: 'Strict' },
  agro_seasonal: { 'sr-Latn': 'Agro-sezonska', en: 'Agro seasonal' },
};

/** Creates the template's rules as drafts (existing keys are skipped) and its policy code. */
export async function applyPolicyTemplate(
  ctx: TenantContext,
  template: PolicyTemplate,
): Promise<{ created: number; skipped: number }> {
  await ctx.requirePermission('settings.manage');
  await ctx.db.query(
    `INSERT INTO code_lists (tenant_id, list_key, code, sort_order, created_by, updated_by)
     VALUES (app_tenant_id(), 'collection_policy', $1, 10, $2, $2) ON CONFLICT (tenant_id, list_key, code) DO NOTHING`,
    [template, ctx.userId],
  );
  for (const [locale, text] of Object.entries(LABELS[template])) {
    await ctx.db.query(
      `INSERT INTO translations (tenant_id, entity_type, entity_key, field, locale, text, created_by, updated_by)
       VALUES (app_tenant_id(), 'code_list', $1, 'name', $2, $3, $4, $4) ON CONFLICT DO NOTHING`,
      [`collection_policy.${template}`, locale, text, ctx.userId],
    );
  }
  let created = 0;
  let skipped = 0;
  for (const r of TEMPLATE_RULES[template]) {
    const exists = await ctx.db.query('SELECT 1 FROM workflows WHERE key = $1', [r.key]);
    if (exists.rowCount) {
      skipped += 1;
      continue;
    }
    await createWorkflow(ctx, { key: r.key, name: r.name, definition: r.definition } as never);
    created += 1;
  }
  await ctx.audit({
    action: 'library.policy_template_applied',
    entityType: 'workflows',
    entityId: ctx.requestId,
    after: { template, created, skipped },
  });
  return { created, skipped };
}

// ---------------------------------------------------------------------------------------------
// The 10 questions of the onboarding package → a proposed template
// ---------------------------------------------------------------------------------------------

export const QUESTIONS = {
  payment_terms: ['15', '30', '60', '90'],
  reminder_before_due: ['yes', 'no'],
  first_reminder: ['d1', 'd7', 'd15'],
  tone: ['friendly', 'neutral', 'firm'],
  phone_followup: ['yes', 'no'],
  escalation: ['d15', 'd30', 'd60', 'd90'],
  legal_handover: ['d30', 'd60', 'd90', 'never'],
  seasonal: ['yes', 'no'],
  natural_persons: ['yes', 'no'],
  disputes_common: ['yes', 'no'],
} as const;
export type Answers = { [K in keyof typeof QUESTIONS]: (typeof QUESTIONS)[K][number] };

export function proposeTemplate(a: Answers): PolicyTemplate {
  if (a.seasonal === 'yes') return 'agro_seasonal';
  if (a.tone === 'firm' || a.legal_handover === 'd30' || a.escalation === 'd15') return 'strict';
  if (a.tone === 'friendly' || a.first_reminder === 'd15' || a.legal_handover === 'never')
    return 'friendly';
  return 'standard';
}
