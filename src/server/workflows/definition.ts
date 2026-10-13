import { z } from 'zod';
import { toMinor } from '@/server/fx/money';

/**
 * Workflow definition (task 3.1): WHEN (trigger) / IF (conditions, all must hold) / THEN
 * (actions, in order). Configuration, validated by this schema on every save and before every
 * run — a stored definition that no longer parses is a failed run, never a guess.
 * Amounts are decimal strings compared as integer cents (rule 18); days are integers.
 */

const code = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);
const decimal = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/);

export const EVENT_TRIGGERS = [
  'invoice.overdue',
  'payment.received',
  'promise.broken',
  'case.stage_changed',
] as const;

export const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), event: z.enum(EVENT_TRIGGERS) }),
  // Daily (tenant-local, company zone): invoices whose due date + offset is today.
  z.object({
    type: z.literal('days_from_due'),
    offset: z.int().min(-60).max(730),
    businessDays: z.boolean().optional(),
  }),
  // Daily: customers with open overdue invoices and no activity for `days` days.
  z.object({ type: z.literal('no_activity'), days: z.int().min(1).max(365) }),
  // Daily, once: customers with open invoices on that local date.
  z.object({ type: z.literal('specific_date'), date: z.iso.date() }),
]);

export const CONDITION_FIELDS = [
  'amount',
  'days_overdue',
  'segment',
  'credit_status',
  'country',
  'currency',
  'team',
  'owner',
  'case_stage',
  'is_natural_person',
  'policy',
  // 5.1: the invoice of the run (or, for a customer run, the customer) has an open dispute.
  'has_open_dispute',
] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

export const OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in'] as const;

const conditionValue = z.union([
  z.string().max(100),
  z.boolean(),
  z.int(),
  z.array(z.string().max(100)).max(50),
]);

export const conditionSchema = z
  .object({ field: z.enum(CONDITION_FIELDS), op: z.enum(OPERATORS), value: conditionValue })
  .superRefine((c, ctx) => {
    const ordered = ['gt', 'gte', 'lt', 'lte'].includes(c.op);
    if (
      c.field === 'amount' &&
      !(typeof c.value === 'string' && decimal.safeParse(c.value).success)
    ) {
      ctx.addIssue({ code: 'custom', message: 'amount_must_be_decimal' });
    }
    if (c.field === 'days_overdue' && typeof c.value !== 'number') {
      ctx.addIssue({ code: 'custom', message: 'days_must_be_integer' });
    }
    if (
      (c.field === 'is_natural_person' || c.field === 'has_open_dispute') &&
      (typeof c.value !== 'boolean' || !['eq', 'ne'].includes(c.op))
    ) {
      ctx.addIssue({ code: 'custom', message: 'boolean_eq_only' });
    }
    if (ordered && !['amount', 'days_overdue'].includes(c.field)) {
      ctx.addIssue({ code: 'custom', message: 'ordered_ops_for_numbers_only' });
    }
    if ((c.op === 'in') !== Array.isArray(c.value))
      ctx.addIssue({ code: 'custom', message: 'in_needs_list' });
  });
export type Condition = z.infer<typeof conditionSchema>;

export const actionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create_case'),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  }),
  z.object({
    type: z.literal('assign'),
    to: z.enum(['customer_owner', 'user', 'team']),
    userId: z.uuid().optional(),
    teamId: z.uuid().optional(),
  }),
  z.object({ type: z.literal('create_task'), kind: code, dueInDays: z.int().min(0).max(90) }),
  z.object({
    type: z.literal('send_notification'),
    to: z.enum(['case_owner', 'customer_owner', 'team_lead']),
    message: z.enum(['rule_attention', 'rule_case_opened', 'rule_task_created']),
  }),
  z.object({ type: z.literal('queue_email'), template: code }),
  z.object({ type: z.literal('change_stage'), stage: code }),
  z.object({ type: z.literal('escalate') }),
  z.object({ type: z.literal('create_decision'), decisionType: code }),
  z.object({ type: z.literal('create_approval'), approval: z.literal('case.legal_handover') }),
  z.object({ type: z.literal('call_webhook'), url: z.url().max(500) }),
]);
export type Action = z.infer<typeof actionSchema>;
export const ACTION_TYPES = actionSchema.options.map((o) => o.shape.type.value);

export const definitionSchema = z
  .object({
    trigger: triggerSchema,
    conditions: z.array(conditionSchema).max(20),
    actions: z.array(actionSchema).min(1).max(10),
  })
  .superRefine((d, ctx) => {
    // The legal stage is reached only through an approved handover (rule 11).
    if (d.actions.some((a) => a.type === 'change_stage' && a.stage === 'legal')) {
      ctx.addIssue({ code: 'custom', path: ['actions'], message: 'legal_stage_needs_approval' });
    }
  });
export type Definition = z.infer<typeof definitionSchema>;

/** What the engine knows about the entity of a run (codes and decimal strings only). */
export type Facts = {
  amount: string | null; // reporting currency
  days_overdue: number | null;
  segment: string | null;
  credit_status: string | null;
  country: string | null;
  currency: string | null;
  team: string | null;
  owner: string | null;
  case_stage: string | null;
  is_natural_person: boolean;
  policy: string | null;
  has_open_dispute: boolean;
};

export type ConditionResult = {
  field: ConditionField;
  op: string;
  expected: unknown;
  actual: unknown;
  ok: boolean;
};

function compare(
  field: ConditionField,
  actual: string | number | boolean | null,
  op: string,
  expected: unknown,
): boolean {
  if (actual === null) return op === 'ne' ? expected !== null : false;
  if (op === 'in') return Array.isArray(expected) && expected.map(String).includes(String(actual));
  if (op === 'eq') return String(actual) === String(expected);
  if (op === 'ne') return String(actual) !== String(expected);
  // Ordered comparison: integer cents for amounts, integers for days — never a float.
  const a =
    field === 'amount' ? toMinor(String(actual)) : BigInt(Number.parseInt(String(actual), 10));
  const b =
    field === 'amount' ? toMinor(String(expected)) : BigInt(Number.parseInt(String(expected), 10));
  if (op === 'gt') return a > b;
  if (op === 'gte') return a >= b;
  if (op === 'lt') return a < b;
  return a <= b;
}

/** Deterministic: every condition is evaluated in order and explained; all must hold. */
export function evaluateConditions(
  conditions: Condition[],
  facts: Facts,
): { ok: boolean; results: ConditionResult[] } {
  const results = conditions.map((c) => {
    const actual = facts[c.field];
    return {
      field: c.field,
      op: c.op,
      expected: c.value,
      actual,
      ok: compare(c.field, actual, c.op, c.value),
    };
  });
  return { ok: results.every((r) => r.ok), results };
}
