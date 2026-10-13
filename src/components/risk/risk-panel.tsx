import { getFormatter, getTranslations } from 'next-intl/server';
import type { RiskView } from '@/server/risk/service';
import { RiskBadge } from './risk-badge';
import { RiskRefresh } from './risk-refresh';

const WHEN = { dateStyle: 'medium', timeStyle: 'short' } as const;

// Customer 360 → Risk (task 4.3): never an unexplained number — the score with each signal's
// value, points, weight and share; providers and their state; the proposal waiting for a person.
export async function RiskPanel({
  customerId,
  risk,
  canRefresh,
}: {
  customerId: string;
  risk: RiskView;
  canRefresh: boolean;
}) {
  const t = await getTranslations('risk');
  const format = await getFormatter();
  const l = risk.latest;
  return (
    <div className="flex flex-col gap-4" data-risk-panel>
      <div className="rounded-lg border border-border bg-surface p-4">
        {l ? (
          <>
            <p className="flex flex-wrap items-center gap-2 text-text">
              <span className="text-2xl font-semibold" data-risk-score>
                {l.score}
              </span>
              <span className="text-text-muted">{t('outOf')}</span>
              <RiskBadge band={l.band as 'green'} />
            </p>
            <p className="mt-1 text-xs text-text-muted">
              {t('computed', {
                at: format.dateTime(new Date(l.computedAt), WHEN),
                model: l.explanation.model,
              })}{' '}
              · {t('thresholds', l.explanation.thresholds)}
            </p>
          </>
        ) : (
          <p className="text-text-muted">{t('empty')}</p>
        )}
        <p className="mt-2 text-sm text-text">
          {t('creditStatus', { status: t(`status.${risk.creditStatus as 'unrated'}`) })}
          {risk.pendingProposal
            ? ` · ${t('proposal', { type: t(`proposalType.${risk.pendingProposal as 'credit_status_red'}`) })}`
            : ''}
        </p>
        <p className="mt-1 text-xs text-text-muted">{t('proposalHint')}</p>
        {canRefresh ? (
          <div className="mt-3">
            <RiskRefresh customerId={customerId} />
          </div>
        ) : null}
      </div>

      {l ? (
        <section aria-labelledby="risk-why" className="rounded-lg border border-border bg-surface">
          <h2 id="risk-why" className="p-4 pb-0 font-semibold text-text">
            {t('why')}
          </h2>
          <div className="overflow-x-auto p-4">
            <table className="w-full text-left text-sm" data-risk-explanation>
              <thead className="text-text-muted">
                <tr>
                  <th className="p-2">{t('signal')}</th>
                  <th className="p-2 text-right">{t('value')}</th>
                  <th className="p-2 text-right">{t('points')}</th>
                  <th className="p-2 text-right">{t('weight')}</th>
                  <th className="p-2 text-right">{t('share')}</th>
                </tr>
              </thead>
              <tbody>
                {l.explanation.contributions.map((c) => (
                  <tr key={c.signal} className="border-t border-border" data-risk-signal={c.signal}>
                    <td className="p-2 text-text">
                      {t(`signals.${c.signal}`)}
                      <span className="block text-xs text-text-muted">
                        {t('source', { source: c.source })}
                        {c.reason ? ` · ${t(`reasons.${c.reason as 'not_available'}`)}` : ''}
                      </span>
                    </td>
                    <td className="p-2 text-right">{c.value ?? '—'}</td>
                    <td className="p-2 text-right">{c.points ?? '—'}</td>
                    <td className="p-2 text-right">{c.weight}</td>
                    <td className="p-2 text-right">
                      {c.share === null
                        ? '—'
                        : format.number(c.share / 100, { maximumFractionDigits: 1 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section
        aria-labelledby="risk-providers"
        className="rounded-lg border border-border bg-surface p-4"
      >
        <h2 id="risk-providers" className="font-semibold text-text">
          {t('providers')}
        </h2>
        {risk.providers.length === 0 ? (
          <p className="mt-2 text-sm text-text-muted">{t('providersEmpty')}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {risk.providers.map((p) => (
              <li key={p.provider} data-risk-provider={p.provider}>
                <span className="font-medium text-text">{p.provider}</span> ·{' '}
                {t(`providerStatus.${p.status as 'unsupported'}`)}
                {p.errorCode ? ` (${p.errorCode})` : ''} · {format.dateTime(new Date(p.at), WHEN)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
