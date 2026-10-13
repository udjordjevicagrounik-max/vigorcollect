import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { isAnySettlementFlagEnabled } from '@/lib/feature-flags';

type NavGroupKey = 'work' | 'resolution' | 'intelligence' | 'admin';
type NavItemKey =
  | 'home'
  | 'customers'
  | 'invoices'
  | 'import'
  | 'users'
  | 'teams'
  | 'rules'
  | 'templates'
  | 'integrations'
  | 'approvals'
  | 'tenantSettings'
  | 'systemStatus';
/** `anyOf` empty = every member; otherwise the item exists only with one of those permissions. */
type NavItem = { key: NavItemKey; href: string; anyOf: readonly string[] };
type NavGroup = { key: NavGroupKey; items: NavItem[] };

// Navigation follows PERMISSIONS, never role names (task 1.5). Groups render their heading even
// when empty, except Resolution, which is hidden (not disabled) while settlement flags are off.
const NAV_GROUPS: NavGroup[] = [
  {
    key: 'work',
    items: [
      { key: 'home', href: '/', anyOf: [] },
      { key: 'customers', href: '/customers', anyOf: ['customer.read'] },
      { key: 'invoices', href: '/invoices', anyOf: ['invoice.read'] },
      { key: 'import', href: '/import', anyOf: ['import.read', 'import.create'] },
    ],
  },
  { key: 'resolution', items: [] },
  { key: 'intelligence', items: [] },
  {
    key: 'admin',
    items: [
      { key: 'users', href: '/admin/users', anyOf: ['user.read'] },
      { key: 'teams', href: '/admin/teams', anyOf: ['team.read'] },
      { key: 'rules', href: '/admin/rules', anyOf: ['settings.read'] },
      { key: 'templates', href: '/admin/templates', anyOf: ['settings.read'] },
      { key: 'integrations', href: '/admin/integrations', anyOf: ['integration.read'] },
      {
        key: 'approvals',
        href: '/admin/approvals',
        anyOf: [
          'approval.read',
          'role.manage',
          'user.assign',
          'approval.create',
          'approval.legal_handover',
        ],
      },
      { key: 'tenantSettings', href: '/admin/settings', anyOf: ['settings.read'] },
      { key: 'systemStatus', href: '/admin/status', anyOf: ['settings.read'] },
    ],
  },
];

export async function AppNav({ permissions }: { permissions: readonly string[] }) {
  const t = await getTranslations('nav');
  // Rule 31: Resolution is hidden (not disabled) while every settlement flag is off.
  const showResolution = await isAnySettlementFlagEnabled();
  const allowed = new Set(permissions);
  const groups = NAV_GROUPS.filter((group) => group.key !== 'resolution' || showResolution).map(
    (group) => ({
      ...group,
      items: group.items.filter(
        (item) => item.anyOf.length === 0 || item.anyOf.some((key) => allowed.has(key)),
      ),
    }),
  );

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
                  data-nav-item={item.key}
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
