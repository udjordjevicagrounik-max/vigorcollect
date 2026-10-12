import { getTranslations } from 'next-intl/server';

// One sentence per run (task 3.1): "Rule X v3 — condition Y met → action Z (done)". Built only
// from the stored explanation (codes and values the engine compared), never recomputed.

type Explanation = {
  workflow?: { key?: string; name?: string };
  version?: number;
  matched?: boolean | null;
  conditions?: { field: string; op: string; expected: unknown; actual: unknown; ok: boolean }[];
  actions?: { type: string; status: string }[];
};

const show = (v: unknown) =>
  Array.isArray(v) ? v.join(', ') : v === null || v === undefined ? '—' : String(v);

export async function RunExplanation({
  explanation,
  status,
}: {
  explanation: Record<string, unknown>;
  status: string;
}) {
  const t = await getTranslations('rules');
  const e = explanation as Explanation;
  const conditions = (e.conditions ?? [])
    .map(
      (c) =>
        `${t(`fields.${c.field as 'policy'}`)} ${t(`ops.${c.op as 'eq'}`)} ${show(c.expected)} (${show(c.actual)}) ${c.ok ? '✓' : '✗'}`,
    )
    .join('; ');
  const actions = (e.actions ?? [])
    .map(
      (a) =>
        `${t(`actions.${a.type as 'create_case'}`)} — ${t(`actionStatus.${a.status as 'succeeded'}`)}`,
    )
    .join('; ');
  return (
    <span className="block text-sm" data-run-status={status}>
      <span className="font-medium text-text">
        {t('runTitle', {
          name: e.workflow?.name ?? e.workflow?.key ?? '',
          version: e.version ?? 0,
        })}
      </span>
      <span className="block text-text-muted">
        {status === 'failed'
          ? t('runFailed')
          : e.matched
            ? t('runMatched', { conditions: conditions || t('noConditions'), actions })
            : t('runNotMatched', { conditions })}
      </span>
    </span>
  );
}
