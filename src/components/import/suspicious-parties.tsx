import { getTranslations } from 'next-intl/server';

type Party = {
  customerId: string;
  displayName: string;
  reason: 'personal_identifier' | 'no_business_identifier';
};

// Review S-02: customers created by earlier imports as companies that may be natural persons.
// Shown only when there are any; nothing changes until a person corrects the customer.
export async function SuspiciousParties({ parties }: { parties: Party[] }) {
  if (parties.length === 0) return null;
  const t = await getTranslations('importPage.suspicious');
  return (
    <section
      aria-labelledby="import-suspicious"
      className="mt-6 rounded-lg border border-border bg-surface p-4"
      data-suspicious-parties
    >
      <h2 id="import-suspicious" className="font-semibold text-text">
        {t('title', { n: parties.length })}
      </h2>
      <p className="mt-1 text-sm text-text-muted">{t('description')}</p>
      <ul className="mt-3 flex flex-col gap-2">
        {parties.map((p) => (
          <li key={p.customerId} className="text-sm" data-suspicious-party={p.reason}>
            <a href={`/customers/${p.customerId}`} className="text-brand-purple underline">
              {p.displayName}
            </a>{' '}
            <span className="text-text-muted">· {t(`reason.${p.reason}`)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
