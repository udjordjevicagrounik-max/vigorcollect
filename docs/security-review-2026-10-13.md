# Security review — 2026-10-13

- **Opseg:** `git diff 03cc604..develop` (develop = `c1bd4c2`, 60 commit-a, 439 fajlova, +58 079).
  Napomena: `docs/security-review-input.md` opisuje stanje `fb2e325` (267 fajlova); migracije
  012–020, integracije, API ključevi, worker/PDF, šabloni, import i rizik su NOVI u odnosu na taj spisak.
- **Reviewer:** nezavisna sesija; pročitani `CLAUDE.md`, `docs/security-review-checklist.md`,
  `docs/security-review-input.md` i kod. `docs/NEXT.md` nije čitan; ADR-ovi pročitani tek posle
  nalaza (kolona „ADR" u tabeli nalaza).
- **Metod:** statičko čitanje koda i SQL-a; pokrenuti samo `npm audit` i `gitleaks` (read-only).
  Ništa nije izmenjeno ni commit-ovano; baza i deploy nisu dirani.
- **Severity:** P1 = cross-tenant ili secret leak · P2 = visok · P3 = srednji · P4 = nizak.

## Rezime

- **P1: nijedan potvrđen.** Nijedna ruta, stranica ni job ne čita podatke drugog tenanta; RLS je
  ENABLE + FORCE na svih tenant tabelama, `app_tenant_id()` pada zatvoreno, FK-ovi su kompozitni.
  Najbliže P1: **S-01** (`legal_entities` — podaci koje je uneo drugi tenant vidljivi na nivou
  baze; danas ih aplikacija ne prikazuje osim `registration_number` ka risk provajderima).
- Najveće slabosti: maker-checker van `approval_requests` (pozivnice, promene rola, scope,
  DB nivo), poverenje u `X-Forwarded-For`, i „blast radius" (Chromium bez sandbox-a pored
  BYPASSRLS ključeva, migrate kredencijali u app kontejneru, nešifrovan backup sa tokenima sesija).

## A. Checklist (`docs/security-review-checklist.md`) stavka po stavka

| Stavka | Status | Dokaz / nalaz |
|---|---|---|
| Nova tabela sa `tenant_id` ima ENABLE RLS + politiku (pr. 1) | PROLAZI | Sve tabele 000–020: ENABLE + FORCE + `tenant_isolation USING/WITH CHECK (tenant_id = app_tenant_id())`, npr. `012_receivables_up.sql:381-419`, `018_integrations_up.sql:218-253`. Ali kontrola u alatu ne radi: S-14 |
| `tenant_id` samo iz `withTenant()` (pr. 2) | PROLAZI | `with-tenant.ts:185-191, 217-222`; `session.ts:28`; nijedan body/query/header izvor. Izuzetak po dizajnu: inbound webhook postavlja tenant iz reda integracije pre provere potpisa (`inbound.ts:72`), S-36 |
| Nema upita po `legal_entity_id` bez tenant konteksta (pr. 30) | PADA | Upiti su u tenant tx (`repository.ts:173`), ali SECURITY DEFINER `find_or_create_legal_entity` + `app_read_linked` izlažu tuđe kanonske podatke: S-01 |
| ID iz URL-a kroz tenant-scoped upit (IDOR, pr. 8) | PROLAZI uz izuzetke | Svi `[id]` kroz `z.uuid()` + RLS + `scopeFilter`; unutar tenanta: S-22, S-40, S-47, S-49 |
| Connection string / DB uloge nisu menjane (pr. 3) | PADA | Diff uvodi role i menja okruženje app-a: `vigor_migrate` URL u app kontejneru (S-04), `vigor_backup` BYPASSRLS u worker-u (S-10) |
| Svaki input kroz Zod (pr. 8) | PROLAZI | Sve rute `z.object({id: z.uuid()})` + `.parse`; manjkavost: neispravan JSON → 500 (S-45) |
| Nema SQL konkatenacije; `sql.raw()` (pr. 5) | PROLAZI | `grep sql.raw` = 0; jedini interpolirani SQL su fiksni fragmenti i `scopeFilter` (`scope.ts:38` validira alias) |
| Ruta ima `requirePermission`, permisija u matrici (pr. 7) | PROLAZI | 54/54 ruta (+3 javne iz `docs/permissions.md`); fail-closed `with-tenant.ts:256-264`. Stranice nemaju fail-closed: S-44 |
| Mutacije pišu `audit()`; trigger netaknut (pr. 6) | PADA | Rute: fail-closed `with-tenant.ts:265-273`; `audit_log` trigger + REVOKE `001:326-331, 507` OK. Ali rule engine i import mutiraju bez audit-a po entitetu: S-26, S-50 |
| Kritične akcije kroz `approval_requests` (pr. 11) | PADA | S-06, S-18, S-19, S-20, S-21, S-23, S-25, S-41 |
| Export samo kroz `exportService` (pr. 12) | PROLAZI | Jedini download `exports/service.ts` → `export_log`; nema CSV exporta. Sitno: S-48 |
| Novac `numeric(18,2)` + valuta (pr. 18) | PROLAZI uz izuzetak | `012:53-57, 99-100, 187-188`, `020:24-26`; bez valute: S-56 |
| Datumi `date` / trenuci `timestamptz` (pr. 26) | PROLAZI | `012:254-291`; nisu nađena odstupanja |
| Nova kolona u `pii_field_registry`, P1–P3 šifrovane (pr. 20) | PADA | S-02, S-29 |
| Fizička lica bez automatske odluke (pr. 19) | PADA | Engine samo predlaže (`engine.ts:307, 402-427`), ali zaštita se zaobilazi: S-02 (import), S-24 (`has_legal_effect`) |
| Nema tajni u kodu/logu/testu/commit-u; gitleaks (pr. 9) | PROLAZI | `gitleaks --log-opts=03cc604..develop`: 0 nalaza u 53 commit-a; `.env.example` prazan; n8n JSON samo `$env.*`. Van repoa: S-08, S-11 |
| Nema PII u logu/Sentry/URL/testu (pr. 20) | PADA | `log.ts` samo skalari, `sendDefaultPii:false` OK; ali S-28, S-54 |
| Ništa u localStorage; ništa finansijsko u SW kešu (pr. 16) | PROLAZI | `grep localStorage|sessionStorage|serviceWorker|caches.` u `src/`, `public/` = 0 |
| Javne forme: rate limit, Turnstile, honeypot, bez enumeracije (pr. 27) | PADA | Enumeracija OK (isti odgovor + hash i za nepostojeći nalog); rate limit zaobilaziv (S-07), Turnstile test ključ na preview-u (S-08) |
| Greške bez stack-a, sa `X-Request-Id` (pr. 23, 29) | PROLAZI uz izuzetak | `api-error.ts`, `with-tenant.ts:158-174`; izuzetak S-45 |
| AI: izlaz kao `ai_suggestion`, nepouzdan ulaz | N/A | `src/server/ai/` sadrži samo README |
| Zaštićeni fajlovi (pr. 13) → potpis vlasnika | NE MOGU DA PROVERIM | Diff dira `CLAUDE.md`, `CODEOWNERS`, `db/migrations/000–020`, `src/server/auth/*`, `docker-compose.yml`; potpis nije vidljiv iz koda |
| Zavisnosti: obrazloženje, ≥1000/ned., ažurirano, lockfile (pr. 14) | PADA (P4) | `npm audit` 0 ranjivosti, lockfile samo registry.npmjs.org; `qrcode@1.5.4` bez release-a od 2024-08 (S-53); obrazloženja u commit porukama nisu proveravana |

## B. Fokus tačke iz zadatka (1–14)

| # | Tema | Status | Nalazi |
|---|---|---|---|
| 1 | Upit nad `tenant_id` tabelom bez `SET LOCAL` | PROLAZI | Rute `withTenant`, stranice `withTenantPage`, svi job-ovi `withTenantJob` (`clock.ts:44`, `outbox.ts:109`, `worker.ts:173`); svi GUC-ovi `set_config(...,true)`; skripte postavljaju tenant (`seed-demo.ts:212`, `import-demo.ts:27`). Rizik u alatu: S-14 |
| 2 | tenant/user/permisija iz ulaza | PROLAZI | Promena tenanta kroz `session.update.before` hook sa proverom članstva (`better-auth.ts:186-193`); DB ne vezuje `activeTenantId` (S-03) |
| 3 | IDOR | PROLAZI uz P3/P4 | S-22, S-40, S-47, S-49 |
| 4 | PII u logu/Sentry/fixture/greškama/URL | PADA | S-28, S-29, S-54, S-48 |
| 5 | Secret u kodu/testu/Dockerfile/compose/docs/n8n | PROLAZI (repo) / PADA (okruženje) | S-08, S-11, S-34, S-57, S-59 |
| 6 | BYPASSRLS / SECURITY DEFINER | PADA | S-01, S-05, S-10, S-13, S-33; `tenant_clock`/`platform_timezone`/`fx_rates_upsert`/`mail_outbox_delivery` same po sebi OK |
| 7 | Permissive politike (OR) | PADA | `auth_membership_read` PROLAZI (`005:218-223`, samo kad `app_tenant_id() IS NULL`); `app_read_linked` → S-01; `app_all USING(true)` na `auth.*` → S-03; S-35, S-36 |
| 8 | Maker-checker / rule engine | PADA | Engine samo predlaže (PROLAZI); zaobilaženja: S-06, S-18–S-26, S-41 |
| 9 | Auth | PADA | Enumeracija i CSRF PROLAZE; Bearer bez CSRF je bezbedan (cookie se ne čita kad postoji Bearer, CORS ne dozvoljava `authorization`); hash ključa SHA-256 256-bit PROLAZI; S-07, S-15, S-16, S-17, S-42, S-43 |
| 10 | Inbound webhook | PROLAZI uz P4 | HMAC preko sirovog tela, `timingSafeEqual`, ±300 s, potpis pre parsiranja i upisa, dedup `ON CONFLICT` na `(tenant, integration, external_id)`, telo šifrovano, Zod po handleru, nepoznat tip → dead letter (`signing.ts:31-50`, `inbound.ts:85-128`, `process.ts:92-103`). Sitno: S-36, S-38, S-39 |
| 11 | Worker / Chromium | PADA | S-09 (dupli mejlovi), S-10 (Chromium), S-37 |
| 12 | Šabloni | PROLAZI uz P3 | Bela lista promenljivih, tagovi bez atributa, escape, bez eval-a, kupac kroz scope, faktura pripada kupcu (`render.ts`, `templates/service.ts:163-176, 250`). S-24 |
| 13 | Zavisnosti | PROLAZI uz P2/P4 | `npm audit` 0; nema SheetJS (sopstveni parser) → S-12; S-53 |
| 14 | Dockerfile / compose | PADA | Runtime `USER node`, `npm ci --ignore-scripts`, app na `127.0.0.1`, worker bez porta OK; S-04, S-30, S-31, S-52 |

**Procena Chromium `--no-sandbox` (tačka 11):** ulaz je samo tekst (tagovi bez atributa,
escape), JS isključen, svi zahtevi abortovani (`pdf.ts:68-72`), `cap_drop: ALL` +
`no-new-privileges` (`docker-compose.yml:94-95`), korisnik `node`. Verovatnoća eksploatacije je
**niska** (traži memory bug u Blink/Skia/HarfBuzz dostupan kroz tekst, npr. ime kupca ili broj
fakture). Posledica je **katastrofalna**: renderer deli UID sa node procesom i vidi
`process.env`/`/proc/1/environ`, gde su `PII_MASTER_KEYS`, `BACKUP_DATABASE_URL` (BYPASSRLS +
`pg_read_all_data`), S3 i alert tokeni, uz otvoren egress i volume dokumenata svih tenanta.
`cap_drop` i `no-new-privileges` ne štite od toga, jer napadaču ne treba eskalacija. Ocena: P2,
dok se renderovanje ne izdvoji u kontejner bez tajni i mreže.

## C. Nalazi

Kolona „ADR" je popunjena posle nalaza: da li ADR svesno prihvata rizik (ne menja severity).

| ID | Stavka | Status | Sev | Fajl:linija | Šta tačno | Predlog ispravke | ADR |
|---|---|---|---|---|---|---|---|
| S-01 | 6, 7 / pr. 30, 33 | PADA | P2 | `db/migrations/002_customers_subject_keys_up.sql:162-207, 240-250`; `src/server/risk/service.ts:107` | `find_or_create_legal_entity` (DEFINER, `vigor_migrate`) vraća id POSTOJEĆEG reda za `(country, tax_id)`. Posle `INSERT customers`, `app_read_linked` tenantu A otkriva `legal_name`, `registration_number`, `timezone`, adresu i `created_at` koje je uneo tenant B. To je orakl „ovo lice je već na platformi", protivno komentaru na `:156-157`. `legal_entity_id` nije immutable, pa se jedan red može prevezivati za sondiranje. UI danas prikazuje samo tenantov `display_name` i `tax_id`. | Tenantu prikazivati samo atribute koje je sam uneo (na `customers`); kanonska polja puniti samo iz registra; zabraniti `UPDATE customers.legal_entity_id`. | ADR 0002 t.2 tvrdi suprotno („ne postaje kanal za cross-tenant inteligenciju") — ne objašnjava, krši |
| S-02 | 4, 8 / pr. 19, 20 | PADA | P2 | `src/server/imports/process.ts:104-111`; `src/server/customers/repository.ts:167-187` (`isNaturalPerson: false` `:184`) | Import nema polje „fizičko lice": svaki red ide u `find_or_create_legal_entity`. Preduzetnik ili potrošač sa JMBG-om u `customer_tax_id` postaje globalni `legal_entities` red sa imenom u čistom tekstu i `is_natural_person=false`, pa zaštita pravila 19 (`engine.ts:307`) ne radi. | Dodati kolonu `is_natural_person` u import → `createConsumer`; do tada odbijati redove čiji `tax_id` liči na lični broj. | — |
| S-03 | 6, 7 | PADA | P2 | `db/migrations/005_auth_up.sql:160-186, 103` | `app_all ... TO vigor_app USING (true)` na `auth.session/user/account/verification/twoFactor`. `session.token` je bearer u čistom tekstu, `account.password` heš, TOTP tajna štićena samo `BETTER_AUTH_SECRET`-om iz istog env-a. Bilo koji SQL bug u tenant ruti postaje preuzimanje naloga u svim tenantima. `session.activeTenantId` se može upisati bez DB provere članstva. | Heširati session token (ili DEFINER API ispred `auth.*`); trigger koji proverava `activeTenantId` prema `public.users`. | ADR 0004 t.1 svesno bira `app_all`; plaintext token i `activeTenantId` bez DB provere nisu adresirani |
| S-04 | 14 / pr. 3 | PADA | P2 | `docker-compose.yml:49`; `src/db/env.ts:7,13`; `src/db/client.ts:20-23` | App kontejner dobija `MIGRATE_DATABASE_URL` (vlasnik šeme), jer ga env šema traži, iako ga nijedan kod u `src/` ne koristi. RCE ili curenje env-a znači `DISABLE ROW LEVEL SECURITY` i `DISABLE TRIGGER` na `audit_log`. | Razdvojiti env šemu; ukloniti `MIGRATE_DATABASE_URL` iz servisa `app`. | — |
| S-05 | 6 | PADA | P2 | `db/migrations/007_worker_up.sql:131, 136-156` | `job_health()` je DEFINER (vlasnik `vigor_migrate`) i čita `pgboss.job`, čiji je vlasnik `vigor_worker` (ima i CREATE na šemi). Kompromitovan worker zameni tabelu view-om sa svojom funkcijom, koja se izvršava kao `vigor_migrate` pri sledećem `/health`. To je eskalacija worker → vlasnik šeme. | `job_health` kao SECURITY INVOKER nad view-om koji worker grantuje app-u, ili vlasnik DEFINER funkcije koji ništa drugo ne poseduje. | ADR 0005 opisuje `job_health`, ne i ovaj rizik |
| S-06 | 8 / pr. 11 | PADA | P2 | `src/server/auth/invitations.ts:72-75, 88`; upis role `:357-362` | `mayInvite`: admin poziva bilo koju rolu osim owner-a (`admin`, `cfo`), bez `approval_requests`. Promena postojećeg člana u admin traži 4 oka (`users/service.ts:237-271`), ali pozivnica tu proveru zaobilazi: admin pozove sopstveni drugi email i odobrava sam sebi (`user.assign`, `role.manage`, `decision.approve`, `approval.*`). | Pozivnica za owner/admin i za role sa 🅼/`approval.*` permisijama → `approval_requests`. | ADR 0004 dopuna („admin sve osim owner-a") ne razmatra maker-checker |
| S-07 | 9 / pr. 27 | PADA | P2 | `src/server/security/turnstile.ts:46-50`; `src/proxy.ts:58-59`; `docs/ops/nginx-preview.conf:99`; `src/server/auth/better-auth.ts:163-175` | `clientIp` uzima PRVI unos `X-Forwarded-For`, a nginx `$proxy_add_x_forwarded_for` DODAJE na vrednost klijenta. Rotiranjem lažnog unosa svaki zahtev dobija nov 120/min bucket (`/api/*`, accept pozivnice, inbound) i lažni `remoteip` ka Turnstile-u. Better Auth (bez `ipAddress` podešavanja) sa više XFF unosa vraća null → svi dele jedan login bucket (DoS logina). | nginx `proxy_set_header X-Forwarded-For $remote_addr` / `X-Real-IP`; app čita samo to; Better Auth `advanced.ipAddress.ipAddressHeaders`. | ADR 0006 navodi „bez proksija je lažljiv"; ne pokriva da je lažljiv i IZA ovog nginx-a |
| S-08 | 5, 9 / pr. 27 | PADA | P2 | lokalni `/srv/vigor-collect/.env` (`TURNSTILE_SECRET=1x00…`); `src/server/security/turnstile.ts:24-38` | Javni preview radi sa Cloudflare test ključem koji uvek propušta, uz `NODE_ENV=production`; startup guard odbija samo PRAZNE ključeve. CAPTCHA je realno isključena na login, reset i pozivnici. Nije u repou. | U produkciji odbiti start za ključeve `^[123]x0000`; postaviti prave ključeve na preview. | ADR 0006 („production ne startuje bez Turnstile ključeva") — guard to ne hvata |
| S-09 | 11 | PADA | P2 | `src/server/mail/dispatch-integration.ts:43-47, 51-67, 68-100`; `src/server/jobs/worker.ts:173-176` | POST ka n8n (stvarno slanje) ide UNUTAR `withTenantJob` tx, a status `sent` se commit-uje tek na kraju. Izuzetak u bilo kom redu (dešifrovanje, `JSON.parse`) vraća ceo tx, pa se već poslate opomene šalju ponovo svakog minuta, beskonačno ako je red „otrovan". SELECT nema `FOR UPDATE SKIP LOCKED` (dve instance = dupli mejlovi); n8n šablon ne deduplikuje po `id`. | Status `sending` u zasebnom kratkom tx pre POST-a, try/catch po redu, `SKIP LOCKED`, dedup po `outboxId` u n8n. | — |
| S-10 | 6, 11, 14 | PADA | P2 | `src/server/documents/pdf.ts:49-64`; `docker-compose.yml:79-132` | Chromium `--no-sandbox` u istom kontejneru i sa istim UID-om kao worker koji drži `BACKUP_DATABASE_URL` (BYPASSRLS + `pg_read_all_data`), `PII_MASTER_KEYS`, S3 ključeve; `launch()` prosleđuje ceo `process.env`. Vidi procenu u odeljku B. | Renderovanje u zaseban kontejner bez tajni, bez DB mreže, `read_only` + tmpfs; backup u zaseban servis; minimum `env: {}`. | ADR 0005 dopuna stavlja backup u worker; Chromium kolokacija nije razmotrena |
| S-11 | 5 / pr. 28 | PADA | P2 | `scripts/backup.sh:45, 48, 97-108` | `pg_dump -Fc` nešifrovan lokalno i off-site. Sadrži `auth.session.token` (žive sesije 8 h), `auth.verification` i finansijske podatke svih tenanta u čistom tekstu (ne-PII kolone). | Šifrovati pre upisa (age/gpg javnim ključem iz vault-a ili rclone `crypt`); `--exclude-table-data` za `auth.session/verification/rateLimit`. | ADR 0003 drži master ključ van backup-a; tokeni sesija nisu adresirani |
| S-12 | 13 | PADA | P2 | `src/server/imports/xlsx.ts:113-119, 140-151` (i regex `:95, :132`) | `columnIndex()` nema gornju granicu: `r="ZZZZZZ1"` → `while (cells.length < col) cells.push('')` alocira stotine miliona stringova. Jedan upload (`import.create`) obara app proces (OOM). Lenji regex nad do 64 MB XML-a je kvadratni. | Odbiti kolonu > 200 (mapping je 0..199) i ograničiti broj ćelija; skenirati `indexOf`-om; smanjiti `MAX_ENTRY_BYTES`. | — |
| S-13 | 6, 7 | PADA | P3 | `db/migrations/007_worker_up.sql:101-104`; `010_ops_up.sql:104-121` | `tenant_clock_read ... TO vigor_migrate USING (current_setting('app.tenant_clock', true) = 'on')`. GUC može postaviti bilo ko; svaka buduća `vigor_migrate` DEFINER funkcija koju app zove (već postoje u 002, 012, 019) bi uz `SET app.tenant_clock='on'` videla sve tenante. Danas ne curi. | Posebna NOLOGIN rola-vlasnik za `tenant_clock`/`platform_timezone` i politika `TO` ta rola, bez GUC kapije. | ADR 0005 opisuje GUC dizajn, ne i rizik |
| S-14 | 1 | PADA | P3 | `scripts/verify-tenant.sh:14-20`; `scripts/rls-drift-check.sh:16`; `db/init/01-roles.sh:29-32` | Obe skripte su stubovi sa `exit 0`, a pokreću se u hook-u i DoD-u. Default privileges daju `vigor_app` CRUD na svaku novu tabelu, pa bi tabela bez RLS bila čitljiva preko tenanta i ništa to ne bi uhvatilo (golden `rls-coverage.test.ts` pokriva samo kad se testovi pokrenu). | Implementirati živu proveru (`relrowsecurity AND relforcerowsecurity` za svaku tabelu sa `tenant_id`). | — |
| S-15 | 9 / pr. 10 | PADA | P3 | `src/server/auth/better-auth.ts:256-263`; `src/server/auth/session.ts:25` | `twoFactor()` bez `trustDeviceMaxAge`; klijent može poslati `trustDevice: true` na `/two-factor/verify-totp` i preskakati TOTP 30 dana (klizno). `getAuthContext` to ne razlikuje. | U before hook-u forsirati `trustDevice=false` na `/two-factor/verify-*`. | ADR 0004 traži MFA; trust device nije pomenut |
| S-16 | 9 | PADA | P3 | `src/server/auth/with-tenant.ts:94-104`; `src/server/integrations/api-keys.ts:183-186` | Ključ uvek dobija `scope: 'ORGANIZATION'`; provera „bez eskalacije" poredi samo nazive permisija, ne scope kreatora. Kreator sa OWN/TEAM pravi ključ koji vidi ceo tenant. | Čuvati scope po permisiji na ključu (≤ scope kreatora) i vraćati ga u `checkApiKeyPermission`. | — |
| S-17 | 9 | PADA | P3 | `src/server/integrations/api-keys.ts:85-87, 214-227`; `src/server/users/service.ts:124-170`; `db/migrations/018_integrations_up.sql:188-206, 259` | Ključ nadživi kreatora (deaktivacija ga ne opoziva), nema `expires_at`. U bazi app sme UPDATE svih kolona `api_keys`: `revoked_at` se može vratiti na NULL, `scopes` proširiti posle kreiranja. Isto važi za `integration_credentials.secret_enc` i `revoked_at`. | Opoziv ključeva pri deaktivaciji, `expires_at`, column grant `UPDATE (last_used_at, revoked_at, revoked_by)` + trigger „opoziv je konačan". | — |
| S-18 | 8 / pr. 11 | PADA | P3 | `src/server/users/service.ts:232-235` | Promena u ne-admin rolu se primenjuje odmah, a `cfo`, `finance_manager` i `legal_manager` nose `approval.*` i `decision.approve`. Admin tako sam pravi checkera. | 4 oka i za role sa 🅼/`approval.*` permisijama. | — |
| S-19 | 8 | PADA | P3 | `src/server/approvals/service.ts:147, 265-270` | Izmena matrice (odobrena) može dati `approval.write_off` collector/sales_rep roli ili `decision.approve` admin-u; jedina zaštita je `roleKey === 'owner'` + golden test nad seed-om. | Odbiti grant `RULE_11_APPROVALS` zabranjenim rolama u `proposeGrantChange` + DB trigger na `role_permissions`. | — |
| S-20 | 8 | PADA | P3 | `src/server/teams/service.ts:109, 175` | `team.manage` (TEAM scope) može sebe da izbaci iz tima i doda u drugi, čime širi vidljivost kupaca bez `user.assign` maker-checker-a. | Zabraniti promenu sopstvenog članstva ili je proveriti kroz approval. | — |
| S-21 | 8 | PADA | P3 | `src/server/workflows/service.ts:239-300, 346` | `decidePublish` poredi samo `requested_by`: A piše pravilo, B ga podnese, A ga odobri i objavi. | Odbiti i kad je odlučilac autor/urednik draft verzije. | — |
| S-22 | 3, 8 | PADA | P3 | `src/server/collections/service.ts:422-432`; `src/server/decisions/service.ts:240-252`; `src/server/approvals/service.ts:88-103` | Checker (legal handover, odluka o kreditnom statusu) nije ograničen `scopeFilter`-om: TEAM/OWN checker odlučuje o kupcima van svog obima; lista pending zahteva prikazuje id-jeve kupaca celog tenanta. | Učitati kupca kroz `scopeFilter` checkera pre odluke; filtrirati listu. | — |
| S-23 | 8 / pr. 11 | PADA | P3 | `002_customers_subject_keys_up.sql:79-82, 259`; `020_risk_up.sql:23-26`; `003_sharing_governance_up.sql:392`; `012_receivables_up.sql:163`; `016_workflows_up.sql:50, 65-66, 85` | Maker-checker nije sproveden u bazi (app kod ga danas poštuje): (a) `UPDATE customers SET credit_limit/credit_status/status` prolazi bez approval-a; (b) `approval_requests_guard` je samo BEFORE UPDATE, pa INSERT sa `status='approved'` prolazi; (c) CHECK-ovi traže samo da `*_approval_id` postoji, ne da je odobren, odgovarajućeg tipa i za taj entitet; (d) `workflow_versions` INSERT sa `provisioned=true` preskače odobrenje. | Column REVOKE + DEFINER funkcije za kritične kolone; INSERT guard (`status='pending'`); trigger koji validira referencirani zahtev. | — |
| S-24 | 8, 12 / pr. 19 | PADA | P3 | `db/migrations/016_workflows_up.sql:246, 262-263` | Nova verzija šablona (npr. `pre_litigation_notice`) može se INSERT-ovati sa `has_legal_effect=false`; guard važi samo za UPDATE. Engine se oslanja na taj flag za pravilo 19. | Na INSERT nasleđivati `true` iz prethodnih verzija istog ključa ili tražiti approval. | — |
| S-25 | 8 | PADA | P3 | `db/migrations/015_payment_kinds_up.sql:17-23, 59`; `013_imports_up.sql:123`; `012_receivables_up.sql:426` | `source_settlement` uplata sa `adjustment_reason_code='write_off'` smanjuje `amount_open` bez approval-a (dovoljan bilo koji `import_run_id` tenanta); `payment_allocations` se mogu DELETE-ovati i za primljene uplate. | Trigger: settlement samo za potvrđen import run; zabraniti DELETE alokacija `kind='received'`. | — |
| S-26 | 8 / pr. 6 | PADA | P3 | `src/server/workflows/engine.ts:262-353, 381-427` | Akcije pravila `create_decision` (sa `has_legal_effect`), `create_approval`, `create_task`, `send_notification`, `queue_email` i `escalate` upisuju bez `audit()`. | `rc.audit({action:'decision.proposed', …})` i ekvivalenti. | — |
| S-27 | 10 (outbound) | PADA | P3 | `src/server/integrations/outbound.ts:369-391` | SSRF filter blokira samo literalne IP-jeve i nekoliko imena, bez DNS rezolucije: prolaze `[::ffff:a9fe:a9fe]`, `[::]`, `localhost.`, `100.64/10` i DNS koji pokazuje na privatni IP. „Test ping" vraća `http_N`/`network`/`timeout` → skener internih servisa (https-only, `redirect:'error'` ograničavaju). | Provera razrešenog IP-a pri konekciji (custom `lookup`/undici dispatcher) + jedinstven kod greške u ping-u. | — |
| S-28 | 4 / pr. 20 | PADA | P3 | `src/server/observability/scrub.ts:44-45, 96-104`; `src/server/observability/sentry.ts:87` | IBAN regex hvata samo kompaktan uppercase oblik (`RS35 2600 …` sa razmacima prolazi); telefoni se ne maskiraju; `request.url`, `query_string` i `transaction` nose reset token (`/reset-password/<token>`) i download token (`?token=`) u Sentry. | Regex sa `[\s-]?` i `i` flagom + telefon; izbaciti `query_string`; maskirati token segmente. | — |
| S-29 | 4 / pr. 20 | PADA | P3 | `db/migrations/019_mail_inbox_up.sql:123, 151, 175-179`; `020_risk_up.sql:85-89`; `018_integrations_up.sql:130, 259` | Nazivi priloga iz nepouzdanog mejla su P0 i u čistom tekstu; `risk_scores`/`risk_signals` su P0 i za fizička lica (profilisanje, GDPR čl. 22); `mail_inbox.body_enc` i `webhook_events.body_enc` (P3) su šifrovani tenant ključem, ne `subject_keys`, bez retencije i bez mogućnosti brisanja po osobi. | Prilozi P2 šifrovano; risk `conditional_on is_natural_person` → P1/P2; retencija + `subject_keys` za tela. | ADR 0003 nije proveravan za ovo odstupanje |
| S-30 | 14 | PADA | P3 | `docker-compose.yml:29-75` | Servis `app` nema `cap_drop: [ALL]`, `security_opt: no-new-privileges` ni `read_only`; nijedan servis nema `read_only` + tmpfs. | Isto hardening kao worker + `read_only: true`, `tmpfs: /tmp`. | — |
| S-31 | 14 | PADA | P3 | `docker-compose.yml:22`; `.env` `DB_BIND_HOST=172.17.0.1` | Postgres (superuser login) objavljen na docker bridge gateway-u: dostupan svim kontejnerima na hostu (drugi projekti, vibecoder). Spolja nije izložen. | Bind na `127.0.0.1` ili bez objavljenog porta (compose mreža). | — |
| S-32 | 5 / pr. 28 | PADA | P3 | `scripts/backup.sh:102, 107` | `rclone sync` / `aws s3 sync --delete` preslikava brisanja: ransomware ili brisanje lokalnog direktorijuma briše i off-site kopije. | `copy` bez `--delete` + odvojeno čišćenje, ili versioning/object lock. | — |
| S-33 | 6 | PADA | P4 | `007:109`, `010:107`, `012:438`, `019:62` | DEFINER funkcije `SET search_path = public, pg_catalog`: `pg_temp` se implicitno pretražuje prvi za tabele, a `vigor_app` ima TEMPORARY (`01-roles.sh:23`). Danas utiče samo na sopstveni rezultat. | `SET search_path = pg_catalog, public, pg_temp` + kvalifikovana imena. | — |
| S-34 | 5 | PADA | P4 | `db/init/01-roles.sh:11, 13, 17`; `scripts/create-service-roles.sh:33-36` | Lozinke rola kao `psql -v` argument (vidljive u `ps`) i u čistom `CREATE/ALTER ROLE … PASSWORD` (u logu uz `log_statement=ddl`). | Stdin/fajl + SCRAM heš ili `SET log_statement='none'`. | — |
| S-35 | 7 | PADA | P4 | `db/migrations/008_api_rate_limit_up.sql:171` | `app_all ON api_rate_limit USING (true)`: svaki tenant čita ključeve (IP + putanja, P1) svih ostalih. | Pristup samo kroz funkciju; REVOKE SELECT. | — |
| S-36 | 2, 7, 10 | PADA | P4 | `db/migrations/018_integrations_up.sql:222-223`; `src/server/integrations/inbound.ts:61-72` | Pre-auth `inbound_lookup` vraća ceo red integracije (config, outbound URL) i za disabled/bilo koji tip; tenant se postavlja iz tog reda pre provere potpisa. Ključ je neprediktivan uuid. | DEFINER funkcija koja vraća samo `tenant_id` za `type='webhook' AND status='active'`. | — |
| S-37 | 11 | PADA | P4 | `db/migrations/007_worker_up.sql:66, 88, 91-92` | Worker posle 017/019 čita nove kolone `mail_outbox` (`customer_id`, `case_id`, `message_id` P1…) svih tenanta; retencija briše i `pending`/neposlate mejlove starije od 7 dana. | Column-level SELECT; retencija samo za završne statuse. | ADR 0005 („worker ne može da pročita nijedan red tenanta") — više nije tačno |
| S-38 | 10 | PADA | P4 | `src/app/api/integrations/[id]/inbound/route.ts:20`; `src/server/integrations/inbound.ts:28, 50, 73-78`; `src/server/integrations/process.ts:75-93` | Telo se čita celo pre provere 1 MB; proba se samo prvi aktivni signing ključ (rotacija nedeterministička); envelope `id` ≤200 a Message-ID do 998 (tiho gubljenje mejla); događaj integracije koja je u međuvremenu isključena se ipak obrađuje, a tip integracije se ne proverava prema tipu događaja. | Provera `content-length`/stream sa limitom; svi aktivni ključevi; uskladiti limite; proveriti status i tip u `process.ts`. | — |
| S-39 | 10 / pr. 22 | PADA | P4 | `src/server/mail/inbox.ts:188, 228-238, 299-312, 340-341`; `019_mail_inbox_up.sql:130` | Pošiljalac „mailer-daemon@…" koji citira naš Message-ID označava mejl kao bounced; `References` vezuje nepoznatog pošiljaoca za kupca, pa odgovor člana ide njemu; dedup po Message-ID koji kontroliše pošiljalac; `mail.status` ne proverava `integration_id`; nema SPF/DKIM presude. | Vezivanje samo za poznate kontakte ili uz potvrdu; dedup sa `integration_id` + hash; bounce samo iz kanala provajdera. | — |
| S-40 | 3 | PADA | P4 | `src/server/documents/service.ts:98` | `caseId` pri generisanju dokumenta se ne proverava prema kupcu ni prema scope-u; kompozitni FK garantuje samo isti tenant. | Proveriti `caseId` kroz `scopedCase` za istog kupca. | — |
| S-41 | 8 | PADA | P4 | `src/server/collections/service.ts:179-182, 195-201` | Case u fazi `legal` može ručno da se vrati u `contact` ili zatvori bez approval-a; engine to zabranjuje (`engine.ts:363`), ručni put ne. | Odbiti promenu faze iz `legal` ili je proveriti kroz `approval_requests`. | — |
| S-42 | 9 | PADA | P4 | `src/server/integrations/api-keys.ts:31-40` | `NEVER_FOR_KEYS` ne sadrži `settings.manage` (checker za `workflow.publish`); spasava samo FK `decided_by → users` (ishod 500). | Dodati `settings.manage`; `decideApproval` odbija `actorType === 'api_key'`. | — |
| S-43 | 9 | PADA | P4 | `src/server/auth/better-auth.ts:234-243` | Brojač neuspešnih prijava: čitanje i upis odvojeno, pa paralelni pokušaji prelaze 5. | Atomski `UPDATE … SET n = n + 1 RETURNING`. | ADR 0004 svesno prihvata („best effort"); rate limit kao kompenzacija je oslabljen zbog S-07 |
| S-44 | 1 / pr. 7 | PADA | P4 | `src/server/auth/with-tenant.ts:312-337` | `withTenantPage` ne pada zatvoreno bez `requirePermission` (za razliku od `run()`) i ne resetuje `app.api_key_hash`/`app.inbound_integration_id`. Sve pregledane stranice danas proveravaju. | Ista fail-closed provera kao u `run()`; reset sva četiri GUC-a. | — |
| S-45 | pr. 23, 29 | PADA | P4 | `src/server/auth/with-tenant.ts:214, 232, 281-298` | Neispravan JSON (`SyntaxError`) → 500 + Sentry umesto 400; greške pre `run()` nemaju standardan oblik odgovora. | Mapirati `SyntaxError` → 400; try/catch oko koraka pre `run()`. | — |
| S-46 | 4 | PADA | P4 | `src/app/api/documents/[id]/download/route.ts:11` | GET piše `export_log` i `audit_log` bez Origin provere; jednokratni token je u query stringu (nginx access log, Sentry — S-28). | Token u POST telu ili headeru; ukloniti query iz access loga. | ADR 0006 pominje token u putanji samo za pozivnicu/reset |
| S-47 | 3 | PADA | P4 | `src/server/decisions/service.ts:106-118` | Čitanje `decisions` pre `requirePermission`: 403 vs 404 otkriva postojanje i tip odluke (unutar tenanta). | Prvo permisija, zatim jedan scoped upit. | — |
| S-48 | 4, 6 / pr. 12 | PADA | P4 | `src/server/exports/service.ts:68-70`; `src/server/integrations/service.ts:137, 176` | `export_log.actor_type` je uvek `'user'`, i za API ključ; outbound URL (može nositi token) upisuje se u `audit_log`. | `ctx.actorType`; u audit upisivati samo host ili heš URL-a. | — |
| S-49 | 3 | PADA | P4 | `src/server/attention/service.ts:208-213` | Lista zadataka spaja `customers` bez `scopeFilter`-a: prikazuje imena kupaca van obima korisnika. | Dodati `scopeFilter` ili ukloniti ime. | — |
| S-50 | pr. 6 | PADA | P4 | `src/server/imports/process.ts:117-235, 348-390` | Import i rollback se audituju jednim zbirnim zapisom; fakture, settlement uplate i kupci nemaju audit po entitetu. | Audit po entitetu ili batch sa listom id-jeva. | — |
| S-51 | — | PADA | P4 | `src/server/risk/service.ts:136-145, 282, 371-373` | Pozivi provajdera (do 2×8 s po kupcu, 2000 kupaca) unutar otvorene DB tx; danas su provajderi stubovi. | Fetch van tx, upis u kratkoj tenant tx. | — |
| S-52 | 14 | PADA | P4 | `Dockerfile:2`; `db/Dockerfile:3`; `.dockerignore` | Image-i pinovani tagom, ne digest-om; `.e2e-data/`, `*.tsbuildinfo` i `docs/` nisu isključeni iz build konteksta. | `@sha256:` digest; dopuniti `.dockerignore`. | — |
| S-53 | 13 / pr. 14 | PADA | P4 | `package.json` (`qrcode` 1.5.4) | Poslednji release 2024-08-05 (>12 meseci), vuče stari `yargs@15`; `npm audit` čist. Commit beleži izuzetak. | Potvrditi izuzetak pismeno ili QR iz održavane biblioteke. | — |
| S-54 | 4 / pr. 24 | PADA | P4 | `tests/unit/observability.test.ts:13-55`; `tests/unit/alerts.test.ts:13` | Test podaci liče na stvarne: `petar.petrovic@firma.rs`, PIB `101234567`, IBAN validnog formata. | `.example` domeni i ID-jevi sa neispravnom kontrolnom cifrom. | — |
| S-55 | — | PADA | P4 | `scripts/migrate.sh:72`; `scripts/demo-import/import-demo.ts:45-47` | `cmd_down` (DROP tabela faktura, uplata…) i demo import nemaju zaštitu od produkcione baze. | Odbiti rad kad okruženje nije dev/staging (eksplicitan marker). | — |
| S-56 | pr. 18 | PADA | P4 | `db/migrations/016_workflows_up.sql:325` | `tenant_settings.attention_large_overdue numeric(18,2)` bez valute. | Dodati kolonu valute. | — |
| S-57 | 5 | PADA | P4 | `docs/ops/nginx-preview.conf:45`; `docs/runbook.md:314` | Hostname preview-a je u repou; uz S-08 to je javno nalaziv login bez CAPTCHA. | Rešiti S-08 ili preview iza basic auth / IP allowlist-e. | — |
| S-58 | 9 | PADA | P4 | `src/server/security/rate-limit.ts:31-37` | Rate limiter pada otvoreno kad baza nije dostupna (namerno, po komentaru). | Prihvatljivo; dokumentovati ili lokalni in-memory fallback. | — |
| S-59 | 5 | PADA | P4 | `scripts/backup.sh:54, 58` | Guard tajni gleda samo fajlove u HEAD, a `git bundle --all` nosi celu istoriju. | `gitleaks git` pre bundle-a. | — |

## D. Broj po severity

| Severity | Broj |
|---|---|
| P1 | 0 |
| P2 | 12 (S-01 … S-12) |
| P3 | 20 (S-13 … S-32) |
| P4 | 27 (S-33 … S-59) |
| **Ukupno** | **59** |

Napomena: S-08 i S-11 su stanje okruženja/operacija, ne koda u diff-u. S-23 je odbrana u
dubini: aplikacioni kod danas poštuje maker-checker, ali baza ga ne sprovodi.

## E. Tri najveća rizika koje checklist NE pokriva

1. **Blast radius okruženja i privilegovanih kredencijala.** Checklist proverava kod, ne gde
   žive tajne i koja rola radi u kom procesu. Najozbiljniji lanci u ovom review-u su upravo tu:
   Chromium bez sandbox-a pored BYPASSRLS i master ključeva (S-10), vlasnik šeme u web app-u
   (S-04), eskalacija worker → `vigor_migrate` kroz `job_health` (S-05), nešifrovan backup sa
   živim tokenima (S-11), Postgres dostupan svim kontejnerima na hostu (S-31). Predlog: dodati
   sekciju „Okruženje i role" (koji kontejner vidi koju tajnu, DEFINER/BYPASSRLS inventar,
   šifrovanje backup-a).
2. **Ko sme da postane checker (governance nad maker-checker-om).** Checklist pita samo da li
   kritične akcije idu kroz `approval_requests`, ne i da li se checker može napraviti bez četiri
   oka. Pozivnica admin/cfo (S-06), promena u rolu sa `approval.*` (S-18), izmena matrice (S-19),
   samostalno menjanje tima (S-20), MFA trust device (S-15) i scope API ključa (S-16) su putevi
   eskalacije unutar tenanta koje nijedna stavka ne hvata.
3. **Spoljni efekti i poverenje u infrastrukturu: idempotentnost, SSRF, proxy.** Nema stavke za
   „akcija sa spoljnim efektom (mejl, webhook) se ne ponavlja posle rollback-a" (S-09: opomene
   kupcima N puta), za outbound SSRF (S-27), ni za poverenje u `X-Forwarded-For` iza nginx-a
   (S-07), od kog zavise rate limit, lockout kompenzacija i Turnstile. Predlog: sekcija
   „Worker i integracije" (exactly-once efekti, `SKIP LOCKED`, SSRF provera razrešenog IP-a,
   izvor klijentskog IP-a).

## F. Šta nije provereno

- Stvarno stanje baza na Elestio staging/prod (`pg_policies`, grantovi, atributi rola,
  `log_statement`); čitan je samo SQL.
- `.env` na staging/prod (Turnstile ključevi); proveren samo lokalni preview `.env`.
- Broj hop-ova produkcionog proksija i body limit za inbound rutu (utiče na S-07, S-38).
- Broj replika worker-a u produkciji (utiče na S-09).
- Versioning i object lock off-site bucket-a (S-32).
- Potpisi vlasnika za zaštićene fajlove (pravilo 13) i obrazloženja zavisnosti u commit porukama.
- Da li Better Auth `reset-password` odgovara jednako brzo za nepostojeći nalog (upis u `mail_outbox`).
- ADR 0003 nije proveravan za S-29.
