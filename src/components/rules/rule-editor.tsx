'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { FormError, FormSuccess, type FormProblem } from '@/components/auth/form-message';
import { apiProblem } from '@/lib/api-problem';
import { postJSON, sendJSON } from '@/lib/post-json';

// Rule editor (task 3.1): a form — WHEN (trigger) / IF (all conditions) / THEN (actions in
// order) — never a visual builder. The server validates the definition again (Zod) and saves a
// DRAFT; publishing goes to another person for approval.

type Trigger =
  | { type: 'event'; event: string }
  | { type: 'days_from_due'; offset: number; businessDays?: boolean }
  | { type: 'no_activity'; days: number }
  | { type: 'specific_date'; date: string };
type Condition = { field: string; op: string; value: string | number | boolean | string[] };
type Action = Record<string, unknown> & { type: string };
export type EditorDefinition = { trigger: Trigger; conditions: Condition[]; actions: Action[] };

const TRIGGERS = ['days_from_due', 'event', 'no_activity', 'specific_date'] as const;
const EVENTS = [
  'invoice.overdue',
  'payment.received',
  'promise.broken',
  'case.stage_changed',
] as const;
const FIELDS = [
  'policy',
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
  'has_open_dispute',
] as const;
const BOOLEAN_FIELDS: readonly string[] = ['is_natural_person', 'has_open_dispute'];
const OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in'] as const;
const ACTIONS = [
  'create_case',
  'assign',
  'create_task',
  'send_notification',
  'queue_email',
  'change_stage',
  'escalate',
  'create_decision',
  'create_approval',
  'call_webhook',
] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const ASSIGN_TO = ['customer_owner', 'user', 'team'] as const;
const NOTIFY_TO = ['case_owner', 'customer_owner', 'team_lead'] as const;
const MESSAGES = ['rule_attention', 'rule_case_opened', 'rule_task_created'] as const;
const LEGAL = 'legal';
const BOOL = ['true', 'false'] as const;
const NORMAL = 'normal';
const field = 'min-h-11 rounded-md border border-border bg-surface px-3 text-text';
const label = 'flex flex-col gap-1 text-sm font-medium text-text';
const small =
  'min-h-11 rounded-md border border-brand-purple px-3 text-sm font-medium text-brand-purple hover:bg-brand-purple-soft disabled:opacity-60';

function defaultAction(type: string): Action {
  switch (type) {
    case 'create_case':
      return { type, priority: 'normal' };
    case 'assign':
      return { type, to: 'customer_owner' };
    case 'create_task':
      return { type, kind: 'call', dueInDays: 0 };
    case 'send_notification':
      return { type, to: 'case_owner', message: 'rule_attention' };
    case 'queue_email':
      return { type, template: 'reminder_overdue' };
    case 'change_stage':
      return { type, stage: 'contact' };
    case 'create_decision':
      return { type, decisionType: 'pre_litigation_notice' };
    case 'create_approval':
      return { type, approval: 'case.legal_handover' };
    case 'call_webhook':
      return { type, url: 'https://example.invalid/hook' };
    default:
      return { type };
  }
}

function defaultTrigger(type: string): Trigger {
  if (type === 'event') return { type: 'event', event: 'invoice.overdue' };
  if (type === 'no_activity') return { type: 'no_activity', days: 14 };
  if (type === 'specific_date')
    return { type: 'specific_date', date: new Date().toISOString().slice(0, 10) };
  return { type: 'days_from_due', offset: 1 };
}

const toInt = (v: string) => Number.parseInt(v || '0', 10) || 0;

export function RuleEditor({
  workflowId,
  initialName,
  initial,
  editable,
  hasDraft,
  stages,
  nextActions,
  users,
  teams,
}: {
  workflowId: string | null;
  initialName: string;
  initial: EditorDefinition;
  editable: boolean;
  hasDraft: boolean;
  stages: Record<string, string>;
  nextActions: Record<string, string>;
  users: { id: string; name: string }[];
  teams: { id: string; name: string }[];
}) {
  const t = useTranslations('rules');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [def, setDef] = useState<EditorDefinition>(initial);
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setTrigger = (trigger: Trigger) => setDef({ ...def, trigger });
  const setCondition = (i: number, c: Condition) =>
    setDef({ ...def, conditions: def.conditions.map((x, j) => (j === i ? c : x)) });
  const setAction = (i: number, a: Action) =>
    setDef({ ...def, actions: def.actions.map((x, j) => (j === i ? a : x)) });

  function conditionValue(c: Condition, raw: string): Condition['value'] {
    if (BOOLEAN_FIELDS.includes(c.field)) return raw === 'true';
    if (c.field === 'days_overdue') return toInt(raw);
    if (c.op === 'in')
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return raw.trim();
  }

  async function save(): Promise<string | null> {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const res = workflowId
      ? await sendJSON('PUT', `/api/workflows/${workflowId}`, { name, definition: def })
      : await postJSON('/api/workflows', { name, definition: def });
    setBusy(false);
    if (res.status >= 200 && res.status < 300) {
      setNotice(t('saved'));
      const id = workflowId ?? (res.json as { id: string }).id;
      if (!workflowId) router.push(`/admin/rules/${id}`);
      else router.refresh();
      return id;
    }
    setProblem(apiProblem(res, tErrors));
    return null;
  }

  async function submit() {
    const id = await save();
    if (!id) return;
    setBusy(true);
    const res = await postJSON(`/api/workflows/${id}/submit`, {});
    setBusy(false);
    if (res.status >= 200 && res.status < 300) {
      setNotice(t('submitted'));
      router.refresh();
    } else setProblem(apiProblem(res, tErrors));
  }

  const tr = def.trigger;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      data-rule-editor
    >
      <FormError problem={problem} />
      <FormSuccess message={notice} />
      <fieldset disabled={!editable || busy} className="flex flex-col gap-4">
        <label className={label}>
          {t('name')}
          <input
            className={field}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
          />
        </label>

        <section
          className="rounded-lg border border-border bg-surface p-4"
          aria-labelledby="rule-when"
        >
          <h2 id="rule-when" className="font-semibold text-brand-green">
            {t('when')}
          </h2>
          <div className="mt-2 grid gap-3 md:grid-cols-3">
            <label className={label}>
              {t('triggerType')}
              <select
                className={field}
                value={tr.type}
                onChange={(e) => setTrigger(defaultTrigger(e.target.value))}
                data-trigger-type
              >
                {TRIGGERS.map((x) => (
                  <option key={x} value={x}>
                    {t(`triggers.${x}`)}
                  </option>
                ))}
              </select>
            </label>
            {tr.type === 'event' ? (
              <label className={label}>
                {t('event')}
                <select
                  className={field}
                  value={tr.event}
                  onChange={(e) => setTrigger({ ...tr, event: e.target.value })}
                >
                  {EVENTS.map((x) => (
                    <option key={x} value={x}>
                      {t(`events.${x.replace('.', '_') as 'invoice_overdue'}`)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {tr.type === 'days_from_due' ? (
              <>
                <label className={label}>
                  {t('offset')}
                  <input
                    className={field}
                    type="number"
                    min={-60}
                    max={730}
                    value={tr.offset}
                    onChange={(e) => setTrigger({ ...tr, offset: toInt(e.target.value) })}
                    data-trigger-offset
                  />
                </label>
                <label className="flex min-h-11 items-center gap-2 self-end text-sm text-text">
                  <input
                    type="checkbox"
                    className="size-5"
                    checked={Boolean(tr.businessDays)}
                    onChange={(e) => setTrigger({ ...tr, businessDays: e.target.checked })}
                  />
                  {t('businessDays')}
                </label>
              </>
            ) : null}
            {tr.type === 'no_activity' ? (
              <label className={label}>
                {t('days')}
                <input
                  className={field}
                  type="number"
                  min={1}
                  max={365}
                  value={tr.days}
                  onChange={(e) => setTrigger({ ...tr, days: toInt(e.target.value) })}
                />
              </label>
            ) : null}
            {tr.type === 'specific_date' ? (
              <label className={label}>
                {t('date')}
                <input
                  className={field}
                  type="date"
                  value={tr.date}
                  onChange={(e) => setTrigger({ ...tr, date: e.target.value })}
                />
              </label>
            ) : null}
          </div>
          <p className="mt-2 text-xs text-text-muted">{t(`triggerHelp.${tr.type}`)}</p>
        </section>

        <section
          className="rounded-lg border border-border bg-surface p-4"
          aria-labelledby="rule-if"
        >
          <h2 id="rule-if" className="font-semibold text-brand-green">
            {t('if')}
          </h2>
          <p className="text-xs text-text-muted">{t('ifHelp')}</p>
          <ul className="mt-2 flex flex-col gap-2">
            {def.conditions.map((c, i) => (
              <li
                key={i}
                className="grid gap-2 md:grid-cols-[1fr_8rem_1fr_auto]"
                data-condition={c.field}
              >
                <select
                  className={field}
                  aria-label={t('field')}
                  value={c.field}
                  onChange={(e) =>
                    setCondition(i, {
                      field: e.target.value,
                      op: 'eq',
                      value: BOOLEAN_FIELDS.includes(e.target.value) ? false : '',
                    })
                  }
                >
                  {FIELDS.map((x) => (
                    <option key={x} value={x}>
                      {t(`fields.${x}`)}
                    </option>
                  ))}
                </select>
                <select
                  className={field}
                  aria-label={t('operator')}
                  value={c.op}
                  onChange={(e) =>
                    setCondition(i, {
                      ...c,
                      op: e.target.value,
                      value: e.target.value === 'in' ? [] : c.value,
                    })
                  }
                >
                  {OPS.map((x) => (
                    <option key={x} value={x}>
                      {t(`ops.${x}`)}
                    </option>
                  ))}
                </select>
                {BOOLEAN_FIELDS.includes(c.field) ? (
                  <select
                    className={field}
                    aria-label={t('value')}
                    value={String(c.value)}
                    onChange={(e) => setCondition(i, { ...c, value: e.target.value === 'true' })}
                  >
                    {BOOL.map((b) => (
                      <option key={b} value={b}>
                        {t(b === 'true' ? 'yes' : 'no')}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className={field}
                    aria-label={t('value')}
                    value={Array.isArray(c.value) ? c.value.join(', ') : String(c.value)}
                    onChange={(e) =>
                      setCondition(i, { ...c, value: conditionValue(c, e.target.value) })
                    }
                  />
                )}
                <button
                  type="button"
                  className={small}
                  onClick={() =>
                    setDef({ ...def, conditions: def.conditions.filter((_, j) => j !== i) })
                  }
                >
                  {t('remove')}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={`${small} mt-2`}
            onClick={() =>
              setDef({
                ...def,
                conditions: [...def.conditions, { field: 'policy', op: 'eq', value: 'standard' }],
              })
            }
          >
            {t('addCondition')}
          </button>
        </section>

        <section
          className="rounded-lg border border-border bg-surface p-4"
          aria-labelledby="rule-then"
        >
          <h2 id="rule-then" className="font-semibold text-brand-green">
            {t('then')}
          </h2>
          <ol className="mt-2 flex flex-col gap-2">
            {def.actions.map((a, i) => (
              <li
                key={i}
                className="grid gap-2 md:grid-cols-[14rem_1fr_auto]"
                data-action-type={a.type}
              >
                <select
                  className={field}
                  aria-label={t('actionType')}
                  value={a.type}
                  onChange={(e) => setAction(i, defaultAction(e.target.value))}
                >
                  {ACTIONS.map((x) => (
                    <option key={x} value={x}>
                      {t(`actions.${x}`)}
                    </option>
                  ))}
                </select>
                <div className="flex flex-wrap gap-2">
                  {a.type === 'create_case' ? (
                    <select
                      className={field}
                      aria-label={t('priority')}
                      value={String(a.priority ?? NORMAL)}
                      onChange={(e) => setAction(i, { ...a, priority: e.target.value })}
                    >
                      {PRIORITIES.map((x) => (
                        <option key={x} value={x}>
                          {t(`priorities.${x}`)}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {a.type === 'assign' ? (
                    <>
                      <select
                        className={field}
                        aria-label={t('assignTo')}
                        value={String(a.to)}
                        onChange={(e) => setAction(i, { type: 'assign', to: e.target.value })}
                      >
                        {ASSIGN_TO.map((x) => (
                          <option key={x} value={x}>
                            {t(`assign.${x}`)}
                          </option>
                        ))}
                      </select>
                      {a.to === 'user' ? (
                        <select
                          className={field}
                          aria-label={t('user')}
                          value={String(a.userId ?? '')}
                          onChange={(e) => setAction(i, { ...a, userId: e.target.value })}
                        >
                          <option value="">{t('choose')}</option>
                          {users.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      {a.to === 'team' ? (
                        <select
                          className={field}
                          aria-label={t('team')}
                          value={String(a.teamId ?? '')}
                          onChange={(e) => setAction(i, { ...a, teamId: e.target.value })}
                        >
                          <option value="">{t('choose')}</option>
                          {teams.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </>
                  ) : null}
                  {a.type === 'create_task' ? (
                    <>
                      <select
                        className={field}
                        aria-label={t('taskKind')}
                        value={String(a.kind)}
                        onChange={(e) => setAction(i, { ...a, kind: e.target.value })}
                      >
                        {Object.entries(nextActions).map(([code, text]) => (
                          <option key={code} value={code}>
                            {text}
                          </option>
                        ))}
                      </select>
                      <input
                        className={`${field} w-24`}
                        type="number"
                        min={0}
                        max={90}
                        aria-label={t('dueInDays')}
                        value={Number(a.dueInDays ?? 0)}
                        onChange={(e) => setAction(i, { ...a, dueInDays: toInt(e.target.value) })}
                      />
                    </>
                  ) : null}
                  {a.type === 'send_notification' ? (
                    <>
                      <select
                        className={field}
                        aria-label={t('notifyTo')}
                        value={String(a.to)}
                        onChange={(e) => setAction(i, { ...a, to: e.target.value })}
                      >
                        {NOTIFY_TO.map((x) => (
                          <option key={x} value={x}>
                            {t(`notify.${x}`)}
                          </option>
                        ))}
                      </select>
                      <select
                        className={field}
                        aria-label={t('message')}
                        value={String(a.message)}
                        onChange={(e) => setAction(i, { ...a, message: e.target.value })}
                      >
                        {MESSAGES.map((x) => (
                          <option key={x} value={x}>
                            {t(`messages.${x}`)}
                          </option>
                        ))}
                      </select>
                    </>
                  ) : null}
                  {a.type === 'queue_email' ? (
                    <input
                      className={field}
                      aria-label={t('template')}
                      value={String(a.template)}
                      onChange={(e) => setAction(i, { ...a, template: e.target.value.trim() })}
                    />
                  ) : null}
                  {a.type === 'change_stage' ? (
                    <select
                      className={field}
                      aria-label={t('stage')}
                      value={String(a.stage)}
                      onChange={(e) => setAction(i, { ...a, stage: e.target.value })}
                    >
                      {Object.entries(stages)
                        .filter(([code]) => code !== LEGAL)
                        .map(([code, text]) => (
                          <option key={code} value={code}>
                            {text}
                          </option>
                        ))}
                    </select>
                  ) : null}
                  {a.type === 'create_decision' ? (
                    <input
                      className={field}
                      aria-label={t('decisionType')}
                      value={String(a.decisionType)}
                      onChange={(e) => setAction(i, { ...a, decisionType: e.target.value.trim() })}
                    />
                  ) : null}
                  {a.type === 'call_webhook' ? (
                    <input
                      className={field}
                      type="url"
                      aria-label={t('url')}
                      value={String(a.url)}
                      onChange={(e) => setAction(i, { ...a, url: e.target.value })}
                    />
                  ) : null}
                  <span className="self-center text-xs text-text-muted">
                    {t(`actionHelp.${a.type as 'create_case'}`)}
                  </span>
                </div>
                <button
                  type="button"
                  className={small}
                  disabled={def.actions.length === 1}
                  onClick={() => setDef({ ...def, actions: def.actions.filter((_, j) => j !== i) })}
                >
                  {t('remove')}
                </button>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className={`${small} mt-2`}
            onClick={() =>
              setDef({ ...def, actions: [...def.actions, defaultAction('create_task')] })
            }
          >
            {t('addAction')}
          </button>
        </section>
      </fieldset>
      {editable ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={busy}
            className="min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep disabled:opacity-60"
            data-rule-save
          >
            {t('saveDraft')}
          </button>
          <button
            type="button"
            disabled={busy}
            className={small}
            onClick={() => void submit()}
            data-rule-submit
          >
            {hasDraft || !workflowId ? t('submit') : t('saveAndSubmit')}
          </button>
        </div>
      ) : null}
    </form>
  );
}
