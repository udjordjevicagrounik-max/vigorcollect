import { getTranslations } from 'next-intl/server';
import { EmptyState } from '@/components/shell/empty-state';
import { Screen } from '@/components/shell/screen';

// "No access" for a page the member lacks the permission for — an explanation and a way back,
// never an error page (rule 29). The server never rendered the data.
export async function ForbiddenState() {
  const t = await getTranslations('admin.forbidden');
  return (
    <Screen mobileClass="mobile-full">
      <EmptyState
        title={t('title')}
        description={t('description')}
        actionLabel={t('action')}
        actionHref="/"
      />
    </Screen>
  );
}
