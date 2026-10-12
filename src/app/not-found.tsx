import { getTranslations } from 'next-intl/server';
import { EmptyState } from '@/components/shell/empty-state';
import { Screen } from '@/components/shell/screen';

export default async function NotFound() {
  const t = await getTranslations('notFound');
  return (
    <main id="main">
      <Screen mobileClass="mobile-full">
        <EmptyState
          title={t('title')}
          description={t('description')}
          actionLabel={t('action')}
          actionHref="/"
        />
      </Screen>
    </main>
  );
}
