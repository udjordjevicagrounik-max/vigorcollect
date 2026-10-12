import { getTranslations } from 'next-intl/server';
import { EmptyState } from '@/components/shell/empty-state';
import { Screen } from '@/components/shell/screen';

export const dynamic = 'force-dynamic';

// Placeholder until the import flow (Sprint 2) — explains what comes and offers a way on.
export default async function ImportPage() {
  const t = await getTranslations('importPage.empty');
  return (
    <Screen mobileClass="mobile-compact">
      <EmptyState
        title={t('title')}
        description={t('description')}
        actionLabel={t('action')}
        actionHref="/"
      />
    </Screen>
  );
}
