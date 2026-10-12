# 0005 — Worker: outbox, pg-boss i zakazani job-ovi

- **Status:** predloženo (migracija 007 čeka potpis)
- **Datum:** 2026-10-12
- **Donosilac:** Uroš
- **Povezano:** zadatak 1.3; ADR 0002 „Otvoreno" 2; pravila 2, 3, 26, 94, 95

## Kontekst

`domain_events` i `mail_outbox` su tenant tabele pod FORCE RLS. Dispatcher mora da vidi događaje
svih tenanta, a nikad podatke tenanta. Zakazani job-ovi („06:00") moraju da poštuju zonu tenanta.
`vigor_migrate` je `NOCREATEROLE`, pa migracija ne može da napravi rolu.

## Odluka

Zaseban **worker proces** (isti image, `node worker.mjs`, `PROCESS_ROLE=worker`) sa dve veze:
`vigor_worker` za outbox/pg-boss i `vigor_app` za svaki posao tenanta kroz `withTenantJob()`.

- **Rola `vigor_worker`** (NOSUPERUSER NOBYPASSRLS NOINHERIT) pravi se van migracija
  (`scripts/create-service-roles.sh`, superuser, lozinka iz `WORKER_DB_PASSWORD`); migracija 007
  odbija rad ako rola ne postoji ili ima opasne atribute.
- **Politike samo na `domain_events` i `mail_outbox`**: čitanje svega, menjanje samo statusnih
  kolona (GRANT po koloni), brisanje samo onoga što retencija sme (politika, ne kod). Trigger
  `domain_events_status_guard`: pending → processing → processed | failed | pending; processed je
  konačan.
- **Obrada:** dispatcher u jednoj transakciji prebacuje pending → processing i pravi pg-boss posao
  sa `id = event id` (idempotentnost); handler radi kao `vigor_app` sa `SET LOCAL app.tenant_id =
event.tenant_id`; 3 ponavljanja sa backoff-om; posle poslednjeg `failed` + `last_error` (kod
  greške, nikad vrednosti) — ostaje vidljiv (pravilo 95).
- **pg-boss** u svojoj šemi `pgboss` (pravi je migracija; tabele pravi pg-boss kao `vigor_worker`).
  Sadržaj: id-jevi poslova i `{eventId, tenantId}` — bez ličnih podataka; aplikacija nema pristup.
- **Sat tenanta (pravilo 26):** `tenant_clock()` (SECURITY DEFINER, vlasnik `vigor_migrate`) vraća
  samo `(tenant_id, timezone)`; vlasniku se čitanje otvara samo unutar funkcije (GUC
  `app.tenant_clock`), svuda drugde ostaje pod FORCE RLS. Dnevni posao: 06:00 po zoni tenanta,
  ključ = tenant + **lokalni** datum. Kompanije tenanta u drugim zonama ne menjaju dan tenanta.
- **/health (pravilo 94):** `job_health()` vraća samo zbirove (pending, failed, starost
  najstarijeg pending, poslednji uspešan retention).
- **Proces:** Next `instrumentation.ts` pokreće worker kad je `PROCESS_ROLE=worker` (Next pakuje
  kod sa aliasima — bez novog bundler paketa); HTTP tog procesa odgovara samo na `/health`.

## Razmotrene alternative

| Alternativa                                         | Zašto ne                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `BYPASSRLS` za worker                               | zabranjeno pravilom 3                                                                          |
| pg-boss tabele u migraciji (`getConstructionPlans`) | pg-boss sam pravi particije u radu → mora biti vlasnik; vezivanje za interni format biblioteke |
| politika za worker na `tenant_settings`             | eksplicitno zabranjeno („samo domain_events i mail_outbox")                                    |
| esbuild bundle za worker                            | esbuild nije odobren kao direktna zavisnost (pravilo 14)                                       |
| sink → `sent`                                       | CHECK `mail_outbox_sink_status` (006); izmena traži DROP CONSTRAINT — sink je već isporuka     |

## Posledice

- **Pozitivne:** worker ne može da pročita nijedan red tenanta; sve što briše odlučuje baza.
- **Negativne / rizici:** dodatni ručni korak po klasteru (rola); pg-boss tabele su van RLS
  konvencije (bez tenant podataka); `GRANT SELECT ON pgboss.job TO vigor_migrate` radi worker pri
  startu (do prvog starta `/health` prijavljuje `null`).
- **Ne menjati bez novog ADR-a:** worker bez politika van ove dve tabele; tenant samo iz reda
  događaja / `tenant_clock()`; processed je konačan.

## Test prihvatljivosti (pravilo 38)

`tests/golden/db/worker.test.ts`: worker dobija 42501 na `customers`, `users`, `tenant_settings`,
`audit_log`, `subject_keys`, `auth.user`; handler vidi samo tenant događaja; drugi prolaz istog
događaja se preskače; 4 neuspeha → `failed` sa kodom; retencija ne briše mlade redove (politika);
jedan dnevni posao po lokalnom datumu i kad su kompanije u Njujorku i Tokiju.

## Dopuna — zatvaranje Sprinta 1 (2026-10-12)

- Worker ima svoj Dockerfile stage (`worker`): app image + `postgresql-client-16` + `rclone`,
  pinovano; backup i restore test rade iz worker-a, host cron je fallback.
- Backup i restore test **nikad kao superuser**: `vigor_backup` (`pg_read_all_data` + BYPASSRLS,
  bez pisanja) i `vigor_restore` (CREATEDB + BYPASSRLS za sopstvenu privremenu bazu, bez prava na
  podatke glavne baze); obe smeju samo da dodaju SVOJ red u `ops_runs`. Pošto BYPASSRLS preskače
  i `WITH CHECK` politike, to ograničenje drži trigger `ops_runs_kind_by_role` (migracija 011).
