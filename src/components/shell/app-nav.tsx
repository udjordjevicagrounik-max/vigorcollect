import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { isAnySettlementFlagEnabled } from '@/lib/feature-flags';

type NavGroupKey = 'work' | 'resolution' | 'intelligence' | 'admin';
type NavItem = { key: 'home'; href: string };
type NavGroup = { key: NavGroupKey; items: NavItem[] };

// Items are added per task; groups without items render only their heading.
const NAV_GROUPS: NavGroup[] = [
  { key: 'work', items: [{ key: 'home', href: '/' }] },
  { key: 'resolution', items: [] },
  { key: 'intelligence', items: [] },
  { key: 'admin', items: [] },
];

export async function AppNav() {
  const t = await getTranslations('nav');
  // Rule 31: Resolution is hidden (not disabled) while every settlement flag is off.
  const showResolution = await isAnySettlementFlagEnabled();
  const groups = NAV_GROUPS.filter((group) => group.key !== 'resolution' || showResolution);

  return (
    <nav aria-label={t('label')} className="flex flex-col gap-4">
      {groups.map((group) => (
        <div key={group.key} data-nav-group={group.key}>
          <p className="px-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t(`groups.${group.key}`)}
          </p>
          <ul className="mt-1">
            {group.items.map((item) => (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className="flex min-h-11 items-center rounded-md px-3 text-text hover:bg-brand-purple-soft"
                >
                  {t(`items.${item.key}`)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
