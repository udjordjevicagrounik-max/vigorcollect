'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { SubmitButton } from '@/components/auth/field';
import { FormError, FormSuccess } from '@/components/auth/form-message';
import { useAction } from './use-action';

type Pending = {
  id: string;
  actionType: string;
  createdAt: string;
  requestedBy: { id: string; displayName: string };
  roleKey: string | null;
  permissionKey: string | null;
  grant: boolean | null;
  targetUser: { id: string; displayName: string } | null;
  caseRef: { caseId: string; customerId: string } | null;
  workflowRef: { workflowId: string; version: number } | null;
  canDecide: boolean;
  requestedByMe: boolean;
};

const ROLE_KEYS = [
  'owner',
  'admin',
  'cfo',
  'finance_manager',
  'collection_manager',
  'collector',
  'sales_manager',
  'sales_rep',
  'legal_manager',
  'auditor',
  'read_only',
] as const;
const isRoleKey = (k: string): k is (typeof ROLE_KEYS)[number] =>
  (ROLE_KEYS as readonly string[]).includes(k);

const GRANT = 'grant';
const REVOKE = 'revoke';

const button =
  'min-h-11 rounded-md border border-brand-purple px-3 text-sm font-medium text-brand-purple hover:bg-brand-purple-soft disabled:opacity-60';

export function ApprovalsAdmin({
  pending,
  canPropose,
  roles,
  permissions,
}: {
  pending: Pending[];
  canPropose: boolean;
  roles: string[];
  permissions: string[];
}) {
  const t = useTranslations('admin.approvals');
  const tRoles = useTranslations('roles');
  const { run, problem, notice, busy } = useAction();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const roleName = (k: string | null) => (k && isRoleKey(k) ? tRoles(k) : (k ?? ''));

  async function propose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(
      'POST',
      '/api/approvals',
      {
        roleKey: String(form.get('role') ?? ''),
        permissionKey: String(form.get('permission') ?? ''),
        grant: form.get('grant') === GRANT,
      },
      t('proposed'),
    );
  }

  const decide = (id: string, decision: 'approve' | 'reject') => {
    const note = notes[id]?.trim();
    void run(
      'POST',
      `/api/approvals/${id}/decision`,
      note ? { decision, note } : { decision },
      t('decided'),
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <FormError problem={problem} />
      <FormSuccess message={notice} />

      <section aria-labelledby="pending-title" className="flex flex-col gap-3">
        <h2 id="pending-title" className="font-semibold text-text">
          {t('pendingTitle')}
        </h2>
        {pending.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-6 text-center">
            <p className="font-semibold text-brand-green">{t('emptyTitle')}</p>
            <p className="mx-auto mt-2 max-w-prose text-text-muted">{t('emptyDescription')}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {pending.map((p) => (
              <li
                key={p.id}
                data-approval={p.id}
                className="rounded-lg border border-border bg-surface p-4"
              >
                <p className="font-medium text-text">
                  {p.workflowRef ? (
                    <a
                      href={`/admin/rules/${p.workflowRef.workflowId}`}
                      className="text-brand-purple underline"
                      data-approval-workflow
                    >
                      {t('workflowPublish', { version: p.workflowRef.version })}
                    </a>
                  ) : p.caseRef ? (
                    <a
                      href={`/customers/${p.caseRef.customerId}/cases/${p.caseRef.caseId}`}
                      className="text-brand-purple underline"
                      data-approval-case
                    >
                      {t('legalHandover')} · {t('openCase')}
                    </a>
                  ) : p.actionType === 'user_role.change' ? (
                    t('roleChange', {
                      user: p.targetUser?.displayName ?? '',
                      role: roleName(p.roleKey),
                    })
                  ) : (
                    t('grantChange', {
                      action: p.grant ? t('grantAdd') : t('grantRemove'),
                      permission: p.permissionKey ?? '',
                      role: roleName(p.roleKey),
                    })
                  )}
                </p>
                <p className="text-sm text-text-muted">
                  {t('requestedBy', { name: p.requestedBy.displayName })}
                </p>
                {p.canDecide ? (
                  <div className="mt-3 flex flex-col gap-2">
                    <label htmlFor={`note-${p.id}`} className="text-sm text-text">
                      {t('note')}
                    </label>
                    <textarea
                      id={`note-${p.id}`}
                      maxLength={500}
                      value={notes[p.id] ?? ''}
                      onChange={(e) => setNotes((n) => ({ ...n, [p.id]: e.target.value }))}
                      className="min-h-20 rounded-md border border-border bg-surface p-2 text-text"
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        className={button}
                        onClick={() => decide(p.id, 'approve')}
                      >
                        {t('approve')}
                      </button>
                      <button
                        type="button"
                        disabled={busy || !notes[p.id]?.trim()}
                        className={button}
                        onClick={() => decide(p.id, 'reject')}
                      >
                        {t('reject')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-text-muted">
                    {p.requestedByMe ? t('yours') : t('notYours')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canPropose ? (
        <section
          aria-labelledby="propose-title"
          className="rounded-lg border border-border bg-surface p-4"
        >
          <h2 id="propose-title" className="font-semibold text-text">
            {t('proposeTitle')}
          </h2>
          <form onSubmit={propose} className="mt-3 flex flex-col gap-3">
            <label htmlFor="propose-role" className="text-sm font-medium text-text">
              {t('role')}
            </label>
            <select
              id="propose-role"
              name="role"
              className="min-h-11 rounded-md border border-border bg-surface px-3 text-text"
            >
              {roles.map((r) => (
                <option key={r} value={r}>
                  {roleName(r)}
                </option>
              ))}
            </select>
            <label htmlFor="propose-permission" className="text-sm font-medium text-text">
              {t('permission')}
            </label>
            <select
              id="propose-permission"
              name="permission"
              className="min-h-11 rounded-md border border-border bg-surface px-3 text-text"
            >
              {permissions.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <fieldset className="flex flex-wrap gap-4">
              <label className="flex min-h-11 items-center gap-2 text-text">
                <input type="radio" name="grant" value={GRANT} defaultChecked /> {t('grant')}
              </label>
              <label className="flex min-h-11 items-center gap-2 text-text">
                <input type="radio" name="grant" value={REVOKE} /> {t('revoke')}
              </label>
            </fieldset>
            <SubmitButton label={t('propose')} pending={busy} />
          </form>
        </section>
      ) : null}
    </div>
  );
}
