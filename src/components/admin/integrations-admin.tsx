'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { FormError, FormSuccess, type FormProblem } from '@/components/auth/form-message';
import { apiProblem } from '@/lib/api-problem';
import { postJSON, sendJSON } from '@/lib/post-json';
import { useAction } from './use-action';

type Integration = {
  id: string;
  type: 'mailbox' | 'erp' | 'risk' | 'webhook';
  provider: string;
  name: string;
  status: 'active' | 'disabled';
  outboundUrl: string | null;
  events: string[];
  inboundUrl: string;
  pendingDeliveries: number;
  deadDeliveries: number;
  deadEvents: number;
};
type ApiKey = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  rateLimitPerMinute: number;
  lastUsedAt: string | null;
  revokedAt: string | null;
};
type SyncRun = {
  id: string;
  provider: string;
  kind: string;
  status: string;
  counts: Record<string, number>;
  errorCode: string | null;
  startedAt: string;
};
type DeadLetter = {
  kind: 'webhook' | 'delivery';
  id: string;
  integrationName: string;
  type: string;
  reason: string | null;
  attempts: number;
  at: string;
};

const TYPES = ['mailbox', 'erp', 'risk', 'webhook'] as const;
const button =
  'min-h-11 rounded-md border border-brand-purple px-3 text-sm font-medium text-brand-purple hover:bg-brand-purple-soft disabled:opacity-60';
const input = 'min-h-11 rounded-md border border-border bg-surface px-3 text-text';

/** A value shown ONCE (secret, token): copy it now, it is not stored in a readable form. */
function OnceBox({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div
      className="rounded-md border border-status-warning-fg bg-status-warning-bg p-3"
      data-shown-once
    >
      <p className="text-sm font-medium text-text">{label}</p>
      <code className="mt-1 block break-all font-mono text-sm text-text">{value}</code>
      <p className="mt-1 text-xs text-text-muted">{hint}</p>
    </div>
  );
}

export function IntegrationsAdmin({
  integrations,
  apiKeys,
  syncRuns,
  deadLetters,
  canManage,
  events,
  grantableScopes,
  origin,
}: {
  integrations: Integration[];
  apiKeys: ApiKey[];
  syncRuns: SyncRun[];
  deadLetters: DeadLetter[];
  canManage: boolean;
  events: readonly string[];
  grantableScopes: string[];
  origin: string;
}) {
  const t = useTranslations('integrationsAdmin');
  const tErrors = useTranslations('errors');
  const { run, problem, notice, busy } = useAction();
  const [created, setCreated] = useState<{ secret: string; inboundUrl: string } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [formProblem, setFormProblem] = useState<FormProblem | null>(null);
  const [pending, setPending] = useState(false);

  async function createIntegration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFormProblem(null);
    const outboundUrl = String(form.get('outboundUrl') ?? '').trim();
    const res = await postJSON('/api/integrations', {
      type: String(form.get('type') ?? 'mailbox'),
      provider: 'n8n',
      name: String(form.get('name') ?? ''),
      ...(outboundUrl ? { outboundUrl } : {}),
      events: form.getAll('events').map(String),
    });
    setPending(false);
    const body = res.json as { secret?: string; inboundPath?: string } | null;
    if (res.status === 201 && body?.secret && body.inboundPath) {
      setCreated({ secret: body.secret, inboundUrl: `${origin}${body.inboundPath}` });
      return;
    }
    setFormProblem(apiProblem(res, tErrors));
  }

  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFormProblem(null);
    const res = await sendJSON('POST', '/api/api-keys', {
      name: String(form.get('keyName') ?? ''),
      scopes: form.getAll('scopes').map(String),
      rateLimitPerMinute: Number(form.get('rate') ?? 60),
    });
    setPending(false);
    const body = res.json as { token?: string } | null;
    if (res.status === 201 && body?.token) {
      setToken(body.token);
      return;
    }
    setFormProblem(apiProblem(res, tErrors));
  }

  return (
    <div className="flex flex-col gap-6" data-integrations>
      <FormError problem={problem ?? formProblem} />
      <FormSuccess message={notice} />

      <section aria-labelledby="int-title" className="flex flex-col gap-3">
        <h2 id="int-title" className="font-semibold text-text">
          {t('listTitle')}
        </h2>
        {integrations.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-6 text-center">
            <p className="font-semibold text-brand-green">{t('emptyTitle')}</p>
            <p className="mx-auto mt-2 max-w-prose text-text-muted">{t('emptyDescription')}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {integrations.map((i) => (
              <li
                key={i.id}
                data-integration={i.id}
                className="rounded-lg border border-border bg-surface p-4"
              >
                <p className="font-medium text-text">
                  {i.name}{' '}
                  <span className="text-xs text-text-muted">
                    · {t(`types.${i.type}`)} · {i.provider} · {t(`status.${i.status}`)}
                  </span>
                </p>
                <p className="mt-1 break-all text-xs text-text-muted">
                  {t('inbound')}: <code>{i.inboundUrl}</code>
                </p>
                <p className="break-all text-xs text-text-muted">
                  {t('outbound')}: {i.outboundUrl ?? t('none')}
                  {i.events.length ? ` · ${i.events.join(', ')}` : ''}
                </p>
                <p className="text-xs text-text-muted">
                  {t('queue', {
                    pending: i.pendingDeliveries,
                    dead: i.deadDeliveries + i.deadEvents,
                  })}
                </p>
                {canManage ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={button}
                      disabled={busy || !i.outboundUrl}
                      data-ping={i.id}
                      onClick={() =>
                        void run('POST', `/api/integrations/${i.id}/ping`, {}, t('pinged'))
                      }
                    >
                      {t('ping')}
                    </button>
                    <button
                      type="button"
                      className={button}
                      disabled={busy}
                      onClick={() =>
                        void run(
                          'PUT',
                          `/api/integrations/${i.id}`,
                          { status: i.status === 'active' ? 'disabled' : 'active' },
                          t('saved'),
                        )
                      }
                    >
                      {i.status === 'active' ? t('disable') : t('enable')}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canManage ? (
          created ? (
            <div className="flex flex-col gap-2" data-integration-created>
              <OnceBox label={t('secret')} value={created.secret} hint={t('secretHint')} />
              <OnceBox label={t('inbound')} value={created.inboundUrl} hint={t('inboundHint')} />
              <button type="button" className={button} onClick={() => window.location.reload()}>
                {t('done')}
              </button>
            </div>
          ) : (
            <form
              onSubmit={createIntegration}
              className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
              data-integration-form
            >
              <h3 className="font-semibold text-text">{t('createTitle')}</h3>
              <label htmlFor="int-type" className="text-sm font-medium text-text">
                {t('type')}
              </label>
              <select id="int-type" name="type" className={input}>
                {TYPES.map((x) => (
                  <option key={x} value={x}>
                    {t(`types.${x}`)}
                  </option>
                ))}
              </select>
              <label htmlFor="int-name" className="text-sm font-medium text-text">
                {t('name')}
              </label>
              <input id="int-name" name="name" required maxLength={120} className={input} />
              <label htmlFor="int-url" className="text-sm font-medium text-text">
                {t('outboundUrl')}
              </label>
              <input
                id="int-url"
                name="outboundUrl"
                type="url"
                placeholder={t('urlPlaceholder')}
                className={input}
              />
              <p className="text-xs text-text-muted">{t('outboundHint')}</p>
              <fieldset className="flex flex-col gap-1">
                <legend className="text-sm font-medium text-text">{t('events')}</legend>
                {events.map((e) => (
                  <label key={e} className="flex min-h-11 items-center gap-2 text-sm text-text">
                    <input type="checkbox" name="events" value={e} /> {e}
                  </label>
                ))}
              </fieldset>
              <button type="submit" className={button} disabled={pending}>
                {t('create')}
              </button>
            </form>
          )
        ) : null}
      </section>

      <section aria-labelledby="keys-title" className="flex flex-col gap-3" data-api-keys>
        <h2 id="keys-title" className="font-semibold text-text">
          {t('keysTitle')}
        </h2>
        <p className="text-sm text-text-muted">{t('keysDescription')}</p>
        {apiKeys.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface p-4 text-text-muted">
            {t('keysEmpty')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {apiKeys.map((k) => (
              <li
                key={k.id}
                data-api-key={k.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface p-3"
              >
                <span className="min-w-0 flex-1 text-sm">
                  <span className="font-medium text-text">{k.name}</span>{' '}
                  <code className="text-text-muted">{k.tokenPrefix}…</code>
                  <span className="block break-words text-xs text-text-muted">
                    {k.scopes.join(', ')} · {t('rate', { n: k.rateLimitPerMinute })} ·{' '}
                    {k.revokedAt
                      ? t('revoked')
                      : k.lastUsedAt
                        ? t('lastUsed', { at: k.lastUsedAt.slice(0, 16).replace('T', ' ') })
                        : t('neverUsed')}
                  </span>
                </span>
                {canManage && !k.revokedAt ? (
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void run('DELETE', `/api/api-keys/${k.id}`, {}, t('revokedNotice'))
                    }
                  >
                    {t('revoke')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canManage ? (
          token ? (
            <div className="flex flex-col gap-2" data-api-key-created>
              <OnceBox label={t('token')} value={token} hint={t('tokenHint')} />
              <button type="button" className={button} onClick={() => window.location.reload()}>
                {t('done')}
              </button>
            </div>
          ) : (
            <form
              onSubmit={createKey}
              className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
              data-api-key-form
            >
              <h3 className="font-semibold text-text">{t('keyCreateTitle')}</h3>
              <label htmlFor="key-name" className="text-sm font-medium text-text">
                {t('name')}
              </label>
              <input id="key-name" name="keyName" required maxLength={120} className={input} />
              <label htmlFor="key-rate" className="text-sm font-medium text-text">
                {t('rateLabel')}
              </label>
              <input
                id="key-rate"
                name="rate"
                type="number"
                min={1}
                max={6000}
                defaultValue={60}
                className={input}
              />
              <fieldset className="flex flex-col gap-1">
                <legend className="text-sm font-medium text-text">{t('scopes')}</legend>
                <p className="text-xs text-text-muted">{t('scopesHint')}</p>
                {grantableScopes.map((s) => (
                  <label key={s} className="flex min-h-11 items-center gap-2 text-sm text-text">
                    <input type="checkbox" name="scopes" value={s} /> {s}
                  </label>
                ))}
              </fieldset>
              <button type="submit" className={button} disabled={pending}>
                {t('keyCreate')}
              </button>
            </form>
          )
        ) : null}
      </section>

      <section aria-labelledby="dead-title" className="flex flex-col gap-2" data-dead-letters>
        <h2 id="dead-title" className="font-semibold text-text">
          {t('deadTitle')}
        </h2>
        {deadLetters.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface p-4 text-text-muted">
            {t('deadEmpty')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {deadLetters.map((d) => (
              <li
                key={`${d.kind}-${d.id}`}
                data-dead-letter={d.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface p-3"
              >
                <span className="min-w-0 flex-1 text-sm text-text">
                  {t(`direction.${d.kind}`)} · {d.integrationName} · {d.type}
                  <span className="block text-xs text-text-muted">
                    {d.reason ?? '—'} · {t('attempts', { n: d.attempts })} ·{' '}
                    {d.at.slice(0, 16).replace('T', ' ')}
                  </span>
                </span>
                {canManage ? (
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        'POST',
                        `/api/integrations/dead-letters/${d.id}/retry`,
                        { kind: d.kind },
                        t('retried'),
                      )
                    }
                  >
                    {t('retry')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="sync-title" className="flex flex-col gap-2" data-sync-log>
        <h2 id="sync-title" className="font-semibold text-text">
          {t('syncTitle')}
        </h2>
        {syncRuns.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface p-4 text-text-muted">
            {t('syncEmpty')}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-text-muted">
                  <th className="p-2">{t('when')}</th>
                  <th className="p-2">{t('source')}</th>
                  <th className="p-2">{t('result')}</th>
                </tr>
              </thead>
              <tbody>
                {syncRuns.map((r) => (
                  <tr key={r.id} className="border-t border-border" data-sync-run={r.status}>
                    <td className="p-2 text-text-muted">
                      {r.startedAt.slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="p-2 text-text">
                      {r.provider} · {r.kind}
                    </td>
                    <td className="p-2 text-text">
                      {t(`syncStatus.${r.status as 'succeeded'}`)}
                      {r.errorCode ? ` · ${r.errorCode}` : ''}
                      {Object.keys(r.counts).length
                        ? ` · ${Object.entries(r.counts)
                            .map(([k, v]) => `${k}: ${v}`)
                            .join(', ')}`
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
