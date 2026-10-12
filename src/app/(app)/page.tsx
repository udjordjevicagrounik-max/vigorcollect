import { getTranslations } from 'next-intl/server';
import { EmptyState } from '@/components/shell/empty-state';
import { Screen } from '@/components/shell/screen';

// Dashboard shell (1.5): data arrives with the invoice import (Sprint 2); until then the empty
// state explains the screen and points to the import (rule 29).
export default async function HomePage() {
  const t = await getTranslations('dashboard.empty');
  return (
    <Screen mobileClass="mobile-full">
      <EmptyState
        title={t('title')}
        description={t('description')}
        actionLabel={t('action')}
        actionHref="/import"
      />
    </Screen>
  );
}
