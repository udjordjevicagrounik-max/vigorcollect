import { getTranslations } from 'next-intl/server';
import { EmptyState } from '@/components/shell/empty-state';
import { Screen } from '@/components/shell/screen';

// TODO(1.x): replace the action with the data-source import flow once it exists.
export default async function HomePage() {
  const t = await getTranslations('empty.home');
  return (
    <Screen mobileClass="mobile-full">
      <EmptyState
        title={t('title')}
        description={t('description')}
        actionLabel={t('action')}
        actionHref="/health"
      />
    </Screen>
  );
}
