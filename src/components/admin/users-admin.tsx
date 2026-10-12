'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Field, SubmitButton } from '@/components/auth/field';
import { FormError, FormSuccess, type FormProblem } from '@/components/auth/form-message';
import { apiProblem } from '@/lib/api-problem';
import { postJSON } from '@/lib/post-json';

type Member = {
  id: string;
  displayName: string;
  email: string;
  status: 'invited' | 'active' | 'disabled';
  roles: { key: string; scope: string }[];
  invitation: { id: string; roleKey: string; expired: boolean } | null;
  pendingRoleChange: { approvalId: string; roleKey: string; requestedByMe: boolean } | null;
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
type RoleKey = (typeof ROLE_KEYS)[number];
const isRoleKey = (k: string): k is RoleKey => (ROLE_KEYS as readonly string[]).includes(k);
type ScopeKey = 'OWN' | 'TEAM' | 'ORGANIZATION';
const isScope = (k: string): k is ScopeKey => ['OWN', 'TEAM', 'ORGANIZATION'].includes(k);

const STATUS_STYLE: Record<Member['status'], string> = {
  active: 'border-status-success-fg bg-status-success-bg text-status-success-fg',
  invited: 'border-status-info-fg bg-status-info-bg text-status-info-fg',
  disabled: 'border-status-warning-fg bg-status-warning-bg text-status-warning-fg',
};

const button =
  'min-h-11 rounded-md border border-brand-purple px-3 text-sm font-medium text-brand-purple hover:bg-brand-purple-soft disabled:opacity-60';

// Admin → Users. Server decides everything (permissions, four eyes); the UI only hides buttons
// the member cannot use and shows t(message_key) + request id on errors (rule 29).
export function UsersAdmin({
  members,
  roles,
  me,
  canCreate,
  canUpdate,
  canAssign,
}: {
  members: Member[];
  roles: string[];
  me: string;
  canCreate: boolean;
  canUpdate: boolean;
  canAssign: boolean;
}) {
  const t = useTranslations('admin.users');
  const tRoles = useTranslations('roles');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const roleName = (key: string) => (isRoleKey(key) ? tRoles(key) : key);
  const scopeName = (key: string) => (isScope(key) ? t(`scope.${key}`) : key);

  async function run(path: string, body: unknown, success: (status: number) => string) {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const res = await postJSON(path, body);
    setBusy(false);
    setConfirming(null);
    if (res.status >= 200 && res.status < 300) {
      setNotice(success(res.status));
      router.refresh();
      return true;
    }
    setProblem(apiProblem(res, tErrors));
    return false;
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const ok = await run(
      '/api/invitations',
      {
        email: String(form.get('email') ?? ''),
        displayName: String(form.get('name') ?? ''),
        roleKey: String(form.get('role') ?? ''),
      },
      () => t('invite.sent'),
    );
    if (ok) formElement.reset();
  }

  const others = members.filter((m) => m.id !== me);

  return (
    <div className="flex flex-col gap-6">
      <FormError problem={problem} />
      <FormSuccess message={notice} />

      {canCreate && roles.length > 0 ? (
        <section
          aria-labelledby="invite-title"
          className="rounded-lg border border-border bg-surface p-4"
        >
          <h2 id="invite-title" className="font-semibold text-text">
            {t('invite.title')}
          </h2>
          <form onSubmit={invite} className="mt-3 grid gap-3 md:grid-cols-4 md:items-end">
            <Field
              id="invite-email"
              name="email"
              type="email"
              label={t('invite.email')}
              autoComplete="off"
              required
            />
            <Field
              id="invite-name"
              name="name"
              label={t('invite.name')}
              autoComplete="off"
              required
            />
            <div className="flex flex-col gap-1">
              <label htmlFor="invite-role" className="text-sm font-medium text-text">
                {t('invite.role')}
              </label>
              <select
                id="invite-role"
                name="role"
                defaultValue={roles.includes('collector') ? 'collector' : roles[0]}
                className="min-h-11 rounded-md border border-border bg-surface px-3 text-text"
              >
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {roleName(r)}
                  </option>
                ))}
              </select>
            </div>
            <SubmitButton label={t('invite.submit')} pending={busy} />
          </form>
        </section>
      ) : null}

      {others.length === 0 ? (
        <section className="rounded-lg border border-border bg-surface p-6 text-center">
          <h2 className="font-semibold text-brand-green">{t('emptyTitle')}</h2>
          <p className="mx-auto mt-2 max-w-prose text-text-muted">{t('emptyDescription')}</p>
        </section>
      ) : null}

      <ul className="flex flex-col gap-3" aria-label={t('title')}>
        {members.map((m) => {
          const isMe = m.id === me;
          return (
            <li
              key={m.id}
              data-member={m.email}
              data-status={m.status}
              className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 md:flex-row md:items-center md:justify-between"
            >
              <div className="min-w-0">
                <p className="font-medium text-text">
                  {m.displayName}
                  {isMe ? <span className="text-text-muted"> ({t('you')})</span> : null}
                </p>
                <p className="break-all text-sm text-text-muted">{m.email}</p>
                <p className="mt-1 text-sm text-text">
                  {m.roles.length
                    ? m.roles
                        .map((r) =>
                          t('roleWithScope', { role: roleName(r.key), scope: scopeName(r.scope) }),
                        )
                        .join(', ')
                    : m.invitation
                      ? roleName(m.invitation.roleKey)
                      : t('noRole')}
                </p>
                <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${STATUS_STYLE[m.status]}`}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-block h-2 w-2 rounded-full bg-current"
                    />
                    {t(`status.${m.status}`)}
                  </span>
                  {m.invitation ? (
                    <span className="text-text-muted">
                      {m.invitation.expired ? t('invitationExpired') : t('invitationPending')}
                    </span>
                  ) : null}
                  {m.pendingRoleChange ? (
                    <span className="text-status-info-fg">
                      {t('pendingApproval', { role: roleName(m.pendingRoleChange.roleKey) })}
                    </span>
                  ) : null}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                {canCreate && m.status === 'invited' && m.invitation ? (
                  <button
                    type="button"
                    disabled={busy}
                    className={button}
                    onClick={() =>
                      void run(
                        '/api/invitations',
                        {
                          email: m.email,
                          displayName: m.displayName,
                          roleKey: m.invitation?.roleKey,
                        },
                        () => t('resent'),
                      )
                    }
                  >
                    {t('resend')}
                  </button>
                ) : null}

                {canAssign && m.pendingRoleChange && !m.pendingRoleChange.requestedByMe ? (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      className={button}
                      onClick={() =>
                        void run(
                          `/api/approvals/${m.pendingRoleChange?.approvalId}/decision`,
                          { decision: 'approve' },
                          () => t('approved'),
                        )
                      }
                    >
                      {t('approve')}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      className={button}
                      onClick={() =>
                        void run(
                          `/api/approvals/${m.pendingRoleChange?.approvalId}/decision`,
                          { decision: 'reject' },
                          () => t('rejected'),
                        )
                      }
                    >
                      {t('reject')}
                    </button>
                  </>
                ) : null}

                {canUpdate &&
                !isMe &&
                m.status === 'active' &&
                !m.pendingRoleChange &&
                roles.length > 0 ? (
                  <form
                    className="flex flex-wrap gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const roleKey = String(new FormData(e.currentTarget).get('role') ?? '');
                      void run(`/api/users/${m.id}/role`, { roleKey }, (status) =>
                        status === 202 ? t('approvalRequested') : t('roleChanged'),
                      );
                    }}
                  >
                    <label htmlFor={`role-${m.id}`} className="sr-only">
                      {t('changeRole')}
                    </label>
                    <select
                      id={`role-${m.id}`}
                      name="role"
                      defaultValue={m.roles[0]?.key ?? roles[0]}
                      className="min-h-11 rounded-md border border-border bg-surface px-2 text-sm text-text"
                    >
                      {roles.map((r) => (
                        <option key={r} value={r}>
                          {roleName(r)}
                        </option>
                      ))}
                    </select>
                    <button type="submit" disabled={busy} className={button}>
                      {t('applyRole')}
                    </button>
                  </form>
                ) : null}

                {canUpdate && !isMe && m.status !== 'disabled' ? (
                  confirming === m.id ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        className="min-h-11 rounded-md bg-status-danger-fg px-3 text-sm font-medium text-surface disabled:opacity-60"
                        onClick={() =>
                          void run(`/api/users/${m.id}/deactivate`, {}, () => t('deactivated'))
                        }
                      >
                        {t('confirmDeactivate')}
                      </button>
                      <button type="button" className={button} onClick={() => setConfirming(null)}>
                        {t('cancel')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      className={button}
                      onClick={() => setConfirming(m.id)}
                    >
                      {t('deactivate')}
                    </button>
                  )
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
