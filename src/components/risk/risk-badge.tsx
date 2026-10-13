import { getTranslations } from 'next-intl/server';

const STYLE: Record<'green' | 'yellow' | 'red', string> = {
  green: 'border-status-success-fg bg-status-success-bg text-status-success-fg',
  yellow: 'border-status-warning-fg bg-status-warning-bg text-status-warning-fg',
  red: 'border-status-danger-fg bg-status-danger-bg text-status-danger-fg',
};

// Risk band (task 4.3): the color never stands alone — the word is always there (a11y).
export async function RiskBadge({ band }: { band: 'green' | 'yellow' | 'red' | null }) {
  const t = await getTranslations('risk');
  if (!band) return <span className="text-xs text-text-muted">{t('notScored')}</span>;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 text-xs font-medium ${STYLE[band]}`}
      data-risk-band={band}
    >
      {t(`band.${band}`)}
    </span>
  );
}
