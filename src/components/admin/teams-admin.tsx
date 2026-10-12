'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent } from 'react';
import { Field, SubmitButton } from '@/components/auth/field';
import { FormError, FormSuccess } from '@/components/auth/form-message';
import { useAction } from './use-action';

type Team = {
  id: string;
  key: string;
  name: string;
  status: string;
  leadUserId: string | null;
  members: { userId: string; displayName: string }[];
};

const button =
  'min-h-11 rounded-md border border-brand-purple px-3 text-sm font-medium text-brand-purple hover:bg-brand-purple-soft disabled:opacity-60';

export function TeamsAdmin({
  teams,
  free,
  canManage,
}: {
  teams: Team[];
  free: { id: string; displayName: string }[];
  canManage: boolean;
}) {
  const t = useTranslations('admin.teams');
  const { run, problem, notice, busy } = useAction();

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get('name') ?? '');
    if (await run('POST', '/api/teams', { name }, t('created'))) form.reset();
  }

  return (
    <div className="flex flex-col gap-6">
      <FormError problem={problem} />
      <FormSuccess message={notice} />
      {canManage ? (
        <section
          aria-labelledby="new-team"
          className="rounded-lg border border-border bg-surface p-4"
        >
          <h2 id="new-team" className="font-semibold text-text">
            {t('createTitle')}
          </h2>
          <form onSubmit={create} className="mt-3 flex flex-col gap-3 md:flex-row md:items-end">
            <Field id="team-name" name="name" label={t('name')} autoComplete="off" required />
            <SubmitButton label={t('create')} pending={busy} />
          </form>
        </section>
      ) : null}

      {teams.length === 0 ? (
        <section className="rounded-lg border border-border bg-surface p-6 text-center">
          <h2 className="font-semibold text-brand-green">{t('emptyTitle')}</h2>
          <p className="mx-auto mt-2 max-w-prose text-text-muted">{t('emptyDescription')}</p>
        </section>
      ) : null}

      <ul className="flex flex-col gap-3">
        {teams.map((team) => {
          const lead = team.members.find((m) => m.userId === team.leadUserId);
          return (
            <li
              key={team.id}
              data-team={team.key}
              className="rounded-lg border border-border bg-surface p-4"
            >
              <h2 className="font-semibold text-text">{team.name}</h2>
              <p className="text-sm text-text-muted">
                {t('lead')}: <span data-team-lead>{lead ? lead.displayName : t('noLead')}</span>
              </p>
              <h3 className="mt-3 text-sm font-semibold text-text">{t('members')}</h3>
              {team.members.length === 0 ? (
                <p className="text-sm text-text-muted">{t('emptyMembers')}</p>
              ) : (
                <ul className="mt-1 flex flex-col gap-2">
                  {team.members.map((m) => (
                    <li
                      key={m.userId}
                      className="flex flex-wrap items-center justify-between gap-2"
                    >
                      <span className="text-text">{m.displayName}</span>
                      {canManage ? (
                        <span className="flex flex-wrap gap-2">
                          {team.leadUserId === m.userId ? (
                            <button
                              type="button"
                              disabled={busy}
                              className={button}
                              onClick={() =>
                                void run(
                                  'PUT',
                                  `/api/teams/${team.id}/lead`,
                                  { userId: null },
                                  t('leadChanged'),
                                )
                              }
                            >
                              {t('removeLead')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={busy}
                              className={button}
                              onClick={() =>
                                void run(
                                  'PUT',
                                  `/api/teams/${team.id}/lead`,
                                  { userId: m.userId },
                                  t('leadChanged'),
                                )
                              }
                            >
                              {t('setLead')}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            className={button}
                            onClick={() =>
                              void run(
                                'POST',
                                `/api/teams/${team.id}/members/remove`,
                                { userId: m.userId },
                                t('removed'),
                              )
                            }
                          >
                            {t('remove')}
                          </button>
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {canManage ? (
                free.length ? (
                  <form
                    className="mt-3 flex flex-wrap gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const userId = String(new FormData(e.currentTarget).get('user') ?? '');
                      void run('POST', `/api/teams/${team.id}/members`, { userId }, t('added'));
                    }}
                  >
                    <label htmlFor={`add-${team.id}`} className="sr-only">
                      {t('addMember')}
                    </label>
                    <select
                      id={`add-${team.id}`}
                      name="user"
                      className="min-h-11 rounded-md border border-border bg-surface px-2 text-sm text-text"
                    >
                      {free.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.displayName}
                        </option>
                      ))}
                    </select>
                    <button type="submit" disabled={busy} className={button}>
                      {t('add')}
                    </button>
                  </form>
                ) : (
                  <p className="mt-3 text-sm text-text-muted">{t('noFreeMembers')}</p>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
