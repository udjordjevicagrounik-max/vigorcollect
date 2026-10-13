'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { FormError } from '@/components/auth/form-message';
import type { FormProblem } from '@/components/auth/form-message';
import { apiProblem } from '@/lib/api-problem';
import { postJSON } from '@/lib/post-json';

// Bulk bar (5.1) for the customer and invoice lists. The row checkboxes belong to the form
// `bulk-<entity>` (HTML form attribute), so the server-rendered list needs no client state.
// Flow: action + parameter → preview (count in scope + first 10) → confirm → the run is queued
// for the worker → its report page. The server checks permission and scope again (and per item).

type Option = { id: string; label: string };
type Preview = {
  count: number;
  skipped: number;
  limit: number;
  sample: { id: string; label: string | null }[];
};
type Action =
  'assign_owner' | 'assign_team' | 'change_policy' | 'send_reminder' | 'open_case' | 'export';

const field = 'min-h-11 rounded-md border border-border bg-surface px-3 text-text';
const primary =
  'min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep disabled:opacity-60';
const secondary =
  'min-h-11 rounded-md border border-border bg-surface px-3 text-sm font-medium text-brand-purple disabled:opacity-60';

export function BulkBar({
  entity,
  actions,
  users,
  teams,
  policies,
  templates,
}: {
  entity: 'customers' | 'invoices';
  actions: Action[];
  users: Option[];
  teams: Option[];
  policies: Option[];
  templates: Option[];
}) {
  const t = useTranslations('bulk');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const formId = `bulk-${entity}`;
  const [action, setAction] = useState<Action | ''>('');
  const [param, setParam] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [busy, setBusy] = useState(false);

  if (actions.length === 0) return null;

  const choices: Partial<Record<Action, { key: string; options: Option[] }>> = {
    assign_owner: { key: 'userId', options: users },
    assign_team: { key: 'teamId', options: teams },
    change_policy: { key: 'policyCode', options: policies },
    send_reminder: { key: 'templateKey', options: templates },
  };
  const choice = action ? choices[action] : undefined;

  function selected(): string[] {
    const form = document.getElementById(formId);
    return form instanceof HTMLFormElement ? new FormData(form).getAll('ids').map(String) : [];
  }

  function request() {
    if (!action) return null;
    const params = action === 'export' ? { format: 'csv' } : choice ? { [choice.key]: param } : {};
    return { entity, ids: selected(), bulk: { action, params } };
  }

  function toggleAll(on: boolean) {
    document
      .querySelectorAll<HTMLInputElement>(`input[name="ids"][form="${formId}"]`)
      .forEach((box) => {
        box.checked = on;
      });
  }

  async function doPreview() {
    const body = request();
    if (!body) return;
    if (body.ids.length === 0) {
      setProblem({ message: t('noneSelected') });
      return;
    }
    setBusy(true);
    setProblem(null);
    const res = await postJSON('/api/bulk/preview', body);
    setBusy(false);
    if (res.status === 200) setPreview(res.json as Preview);
    else setProblem(apiProblem(res, tErrors));
  }

  async function confirm() {
    const body = request();
    if (!body) return;
    setBusy(true);
    setProblem(null);
    const res = await postJSON('/api/bulk', body);
    setBusy(false);
    if (res.status === 202) router.push(`/bulk/${(res.json as { id: string }).id}`);
    else setProblem(apiProblem(res, tErrors));
  }

  return (
    <section
      aria-label={t('label')}
      className="mt-4 flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
      data-bulk-bar={entity}
    >
      <form id={formId} onSubmit={(e) => e.preventDefault()} />
      <div className="flex flex-wrap items-end gap-2">
        <button type="button" className={secondary} onClick={() => toggleAll(true)}>
          {t('selectAll')}
        </button>
        <button type="button" className={secondary} onClick={() => toggleAll(false)}>
          {t('selectNone')}
        </button>
        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          {t('action')}
          <select
            className={field}
            value={action}
            data-bulk-action
            onChange={(e) => {
              setAction(e.target.value as Action | '');
              setParam('');
              setPreview(null);
            }}
          >
            <option value="">{t('choose')}</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {t(`actions.${a}`)}
              </option>
            ))}
          </select>
        </label>
        {choice ? (
          <label className="flex flex-col gap-1 text-sm font-medium text-text">
            {t(`params.${action as 'assign_owner'}`)}
            <select
              className={field}
              value={param}
              data-bulk-param
              onChange={(e) => {
                setParam(e.target.value);
                setPreview(null);
              }}
            >
              <option value="">{t('choose')}</option>
              {choice.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          className={primary}
          disabled={busy || !action || (Boolean(choice) && !param)}
          onClick={() => void doPreview()}
          data-bulk-preview
        >
          {t('preview')}
        </button>
      </div>
      <FormError problem={problem} />
      {preview ? (
        <div className="rounded-md border border-border p-3 text-sm" data-bulk-preview-result>
          <p className="font-medium text-text">
            {t('previewCount', { n: preview.count, limit: preview.limit })}
          </p>
          {preview.skipped ? (
            <p className="text-text-muted">{t('previewSkipped', { n: preview.skipped })}</p>
          ) : null}
          <ul className="mt-2 list-disc pl-5 text-text-muted">
            {preview.sample.map((s) => (
              <li key={s.id}>{s.label ?? t('naturalPerson')}</li>
            ))}
          </ul>
          {preview.count > preview.sample.length ? (
            <p className="text-text-muted">
              {t('previewMore', { n: preview.count - preview.sample.length })}
            </p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className={primary}
              disabled={busy || preview.count === 0 || preview.count > preview.limit}
              onClick={() => void confirm()}
              data-bulk-confirm
            >
              {t('confirm', { n: preview.count })}
            </button>
            <button type="button" className={secondary} onClick={() => setPreview(null)}>
              {t('cancel')}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
