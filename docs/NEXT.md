# NEXT

## P1 — zatvoreno (2026-10-13)

**Repo i `/srv/backups` žive u kontejneru `app-vibecoder-1`, ne na hostu** — Elestio watchtower
(nedeljom 01:00 UTC) može da ga rekreira; ponedeljkom runbook „Provera ponedeljkom".

1. ~~**GitHub remote + push**~~ — urađeno 2026-10-13: `origin` =
   `udjordjevicagrounik-max/vigorcollect`, deploy key (runbook „GitHub"); `main` i `develop` push-ovani.
2. ~~**Backup kopija na host putanju**~~ — urađeno 2026-10-13 (Uroš): host cron 03:30,
   `docker cp collect-worker-1:/srv/backups/. /opt/app/backups/`, retencija 30 dana na hostu.
   `/opt/app/backups` očišćen i prekopiran — samo šifrovani fajlovi (`*.age` + `manifest.json`),
   provereno `find` 2026-10-13.
3. ~~**Off-site**~~ — odluka Uroša 2026-10-13: **BorgBase** (Elestio `/opt/borg/backup.sh` arhivira
   ceo `/opt/app`, dakle i `/opt/app/backups`; `repokey-blake2`, prune 7 dana) prihvaćen za
   **dnevne šifrovane kopije**. **Mesečne** idu u B2 / Hetzner Storage Box pre prvog plaćenog
   tenanta (BACKLOG). Borg lozinka je u čistom tekstu u Elestio skriptama i pojavila se u izlazu
   sesije 5.0 — ne rotiramo sami: **tiket Elestio podršci, P3**.

**Blokada za staging: samo Turnstile ključevi (S-08).**

## Aktivan zadatak

**Sprint 6 gotov; čeka: staging instanca, Agrounik podaci, naplatari, ime proizvoda.**

1. **Staging instanca** (Elestio #2) po `docs/staging.md`: servisne role → migracije (do 031) →
   app/worker/renderer → smoke. Blokade: Turnstile ključevi (S-08), vault vrednosti za staging.
2. **Agrounik podaci:** Platforma → Tenanti → Novi tenant (trial 14 dana, mejl samo u sink dok
   ugovor nije potpisan) → „Novi link za paket podataka" (72 h) → fajlovi stižu kao „staged" →
   Uvoz → „Pokreni uvoz". Za demo/staging: `scripts/pseudonymize.ts` nad ERP izvozom.
3. **Naplatari:** pozivnice iz tenanta (owner → Korisnici), obuka → tracker „Obuka".
4. **Ime proizvoda:** `PRODUCT_NAME` (pravilo 21) — svuda iz konfiguracije, bez izmene koda.
5. **Release 0.1:** grana `release/0.1` od `develop`; posle staging-a `scripts/release.sh check 0.1.0`
   → merge u `main` → `scripts/release.sh tag 0.1.0` (runbook „Git tok").

## Poslednja sesija — Sprint 6 (6.1–6.5, 2026-10-13)

Grana `feature/sprint-6` → `develop`. Sekcije CLAUDE.md 15, 17, 20, 24, 27, 29, 30–34 poštovane;
nema novih npm paketa (grafikoni su sopstveni SVG).

- **6.1** `3f87b07` — custom polja (027): definicije po entitetu (ključ nepromenljiv, arhiviranje
  umesto brisanja, max 30), tipizirane vrednosti (ne jsonb), P1+ šifrovano i nefiltrabilno, red u
  `pii_field_registry` automatski; forme, kolone liste po korisniku, filteri, uvoz (i kreiranje
  polja iz kolone), uslovi pravila `custom_field.<key>`, export, API GET/PATCH.
- **6.2** `18c14a9` — report builder (028): bela lista dataset-ova, nikad slobodan SQL, scope,
  agregacija u bazi, 10.000 redova (preko → export), relativni datumi, 9 vizuala, drill-down;
  6 sistemskih izveštaja kao definicije; više valuta bez FX → greška.
- **6.3** `c9b985c` — dashboardi (029): sistemski „Pregled naplate" (neobrisiv, kopira se u
  lični), widgeti iz izveštaja + pažnja + zadaci, keš 5 min (pažnja/zadaci uvek sveži), drag na
  desktopu / ↑↓ na mobilnom, Početna = default dashboard, objava timu.
- **6.4** `782a8d0` — platforma (030): Platforma → Tenanti (samo tenant #0 + `platform.manage`,
  bez poslovnih podataka), životni ciklus sandbox → trial → active/suspended, sink do
  `contract_signed_at`, read-only posle isteka, brisanje samo isteklog demo sandbox-a (platformski
  posao, audit pod #0); javni signup → sandbox sa demo podacima; paket podataka
  `/onboarding/<token>` (staged fajlovi, 10 pitanja → predlog politike); tracker sa SLA 72 h;
  Biblioteke (4 politike kao nacrti, generički šablon uvoza, config pack bez tajni).
- **6.5** — `docs/staging.md`, `docs/performance.md`, `scripts/release.sh`, `CHANGELOG.md`,
  `scripts/pseudonymize.ts`, `scripts/perf.ts`; 1.000 kupaca / 20.000 faktura: svih 17 ekrana
  < 1 s (dashboard 1.541 → 794 ms). Migracija 031 (view pažnje, vidi ispod).

### Bugovi nađeni usput (svaki ima regresioni test koji pada na starom kodu)

- **Pažnja „bez aktivnosti" množila dug brojem aktivnosti** (view iz 016) → 031.
- **Backfill 029 dao je sistemski dashboard samo prvom tenantu** (provera bez `tenant_id` pre
  uključivanja RLS-a) → ispravljeno u 029 (još nije primenjena na dev).
- **Sink trigger iz 030 je izgubio prečicu iz 007** → worker ne bi mogao da označi mejl poslat.
- **Worker je obrađivao jedan događaj na 2 s** → paketi od 5, ishod po poslu, burst.

### Pretpostavke (najkonzervativnija opcija)

- `platform.manage` je u matrici kod owner-a (golden „owner ima sve"), ali važi samo u tenantu
  #0 (`is_platform_operator`) — i u kodu (`requirePlatform`) i u meniju.
- Opomena pred utuženje u šablonima politika ide samo pravnim licima (pravilo 19).
- ERP-specifični šabloni uvoza nisu izmišljani (BACKLOG); generički šablon prepoznaje sam uvoz.
- Pipedrive lead: događaj i potpisani endpoint postoje; n8n workflow i flag ostaju za staging.
- Platformske stranice (tenant #0) su pokrivene golden testovima servisa; e2e pokriva da klijentski
  tenant ne vidi Platformu (e2e korisnik nije operator).

## Poslednja sesija — Sprint 5 (5.1–5.4, 2026-10-13)

Grana `feature/sprint-5` → `develop`. Domen sekcije 12, 35, 38, 39, 51, 52, 57, 62 i 92 **nisu u
repou** — rađeno iz teksta zadatka; pretpostavke ispod.

- **5.1** `5caf95e` — sporovi (status mašina, napomena šifrovana, sporna faktura ostaje u aging-u
  označena, pravila preskaču podsetnik — `has_open_dispute`), ponašanje pri plaćanju
  (unwilling/unable/disputed), „sporno" na dashboard-u / 360 / listi; globalna pretraga
  (Ctrl/Cmd+K, POST telo — upit nikad u URL-u, scope, max 20, semgrep `no-unescaped-like`); bulk
  akcije (preview → potvrda → worker kao pokretač → izveštaj; limit `bulk_max_items`; audit po
  stavci + run; šabloni sa pravnim dejstvom odbijeni); lista faktura. Migracija 024.
- **5.2** `58362bd` — exportService CSV + sopstveni XLSX (zip kroz `node:zlib`, iznos = decimalni
  string), `export_log`, async preko 5.000 redova (`export_files`, 7 dana); 6 izveštaja
  (`docs/metrics.md`) + sačuvani izveštaji; Admin → Podešavanja (aging granice, šifarnici bez
  brisanja, pragovi, ponderi rizika, radni dani/praznici); digest „Moj dan" 07:00 po zoni člana +
  nedeljni menadžerski, preference. Migracija 025.
- **5.3** `9082fd6` — forma IMAP/SMTP (tajne zapečaćene), „Proveri vezu" (worker: IMAP LOGIN +
  SMTP EHLO/AUTH, SSRF zaštita) → n8n po tenantu; Microsoft 365 (PKCE, state vezan za sesiju,
  refresh token kod nas, access token PATCH u n8n — ADR 0007); Google „uskoro". Migracija 026.
- **5.4** — „Početak rada" (12 koraka, auto detekcija, u meniju dok nije 100%), i18n pokrivenost
  runtime ključeva (test), prazna stanja na novim ekranima, Playwright 375 px: spor → bulk
  podsetnik → CSV → izveštaj → aging → digest u sink-u. „Pošalji mi pregled sada" (Nalog →
  Obaveštenja).

### Pretpostavke i odstupanja (pročitati pre pilota)

- **Sekcija 62 (MVP granica) i 92 (onboarding)** nisu u repou: 12 koraka checklist-e izvedeno iz
  postojećih funkcija (`src/server/onboarding/service.ts`); MVP stavke iz zadatka sprinta postoje.
- **„Proveri vezu" nije kroz n8n test workflow:** n8n IMAP čvor je samo trigger, javni API nema
  test credential-a → probu radi worker (`node:tls`), n8n dobija credential-e tek posle uspeha.
- **Microsoft 365:** izabrano „mi obnavljamo token i guramo ga" (n8n podržava PATCH credential-a);
  Graph workflow-i umesto Outlook čvorova. Netestirano uživo dok ne postoji Azure aplikacija.
- **Digest tekst** je iz `messages` (mail.digest.*), ne iz tenant šablona (BACKLOG).
- **Pretraga i bulk preview pišu audit** (withTenant traži audit za svaki uspešan POST): pretraga
  beleži ko je tražio i broj pogodaka, nikad upit.

### Čeka Uroša (Sprint 5 — urađeno 2026-10-13, ostaje za staging)

- Azure aplikacija (runbook „Povezivanje sandučeta kroz formu") → `MS_CLIENT_ID`,
  `MS_CLIENT_SECRET` u `.env` van sesije.
- Dev: `MAILBOX_ALLOW_PRIVATE_HOSTS=1` u `.env` ako forma treba lokalni relay (172.17.0.1).
- Rotirati `N8N_API_KEY` (prošao kroz chat u ranijoj sesiji); Elestio tiket za borg lozinku.

## Poslednja sesija — 5.0 ispravke iz security review-a (2026-10-13)

Izveštaj: `docs/security-review-2026-10-13.md` (59 nalaza, 0 P1, 12 P2). Odluke Uroša u zadatku
5.0; bez novih npm paketa; apt `age` u worker stage-u odobren.

### Urađeno (P2 → commit → regresioni test koji pada na starom kodu)

- **S-12** `d2dc7bb` — XLSX: najviše 200 kolona, linearan skener (`tests/unit/imports.test.ts`).
- **S-07** `7aa21d4` — `TRUSTED_PROXY_HOPS`, IP = `XFF[len − hops]`, proxy prepisuje
  `x-client-ip`, Better Auth čita samo njega (`tests/unit/security.test.ts`, `auth-config`).
- **S-05** `bc1b13a` — `job_health()` INVOKER omotač oko funkcije koju poseduje worker
  (`worker.test.ts`: view umesto `pgboss.job` radi kao `vigor_worker`).
- **S-09** `17e8b79` — claim commit-ovan pre POST-a (lease 10 min, `mail_outbox_claim`),
  `Idempotency-Key`, transakcija po stavci; n8n šablon deduplikuje 7 dana (`dispatch-once.test.ts`).
- **S-04 / S-10 / S-11** `f2a97e3` — servisi `renderer` (jedina tajna `RENDER_DATABASE_URL`,
  read-only FS), `migrate` i `restore-test` (profil `ops`); backup šifrovan `age`-om bez podataka
  `auth.session`/`auth.verification` (`containers.test.ts`, `renderer.test.ts`, `backup.test.ts`).
- **S-06** `7b504f4` — drugi administrator za pozivnice/role owner/admin/cfo/collection_manager,
  vođu tima i API ključ `ORGANIZATION`; bootstrap = tačno jedan aktivan admin (`four-eyes.test.ts`).
- **S-01** `7a78beb` — `legal_entities_public` + column grant; ADR 0002 ispravka.
- **S-02** `fabc652` — klasifikacija stranke u uvozu (`party_id_rules`, kolona „Fizičko lice"),
  `review_required`, lista „Kupci za proveru" (`import-parties.test.ts`).
- **S-03** `092f7bf` — `auth.*` nevidljiv u tenant transakciji, trigger za `activeTenantId`;
  ADR 0004 dopuna (`auth-isolation.test.ts`).
- Checklist + 3 oblasti, BACKLOG (P3/P4), `docs/security-review-input.md` iz skripte `c600ebe`.
- Zaštićeno (Uroš, jedna `!` komanda): migracije 021–022, `docker-compose.yml`,
  `src/server/auth/{better-auth,invitations,with-tenant}.ts`.

### Pretpostavke (najkonzervativnija opcija)

1. **S-07:** formula iz zadatka `len−1−hops` bi sa hops=1 uzela vrednost koju šalje klijent
   (nginx dodaje adresu klijenta NA KRAJ); primenjeno `XFF[len − hops]` (0-based) — test sa lažnim
   XFF-om to dokazuje.
2. **S-03:** Better Auth 1.7.7 ne podržava heš tokena sesije (traži sesiju po čistom tokenu);
   umesto heša `auth.*` je nevidljiv u svakoj tenant transakciji + trigger; `vigor_auth` → BACKLOG.
3. **S-06:** privilegovane role tačno owner/admin/cfo/collection_manager (kao u zadatku);
   finance_manager / legal_manager (nose `approval.*`) ostaju direktne → BACKLOG S-18 ostatak.
   API ključ: obim `OWN` (ne vidi podatke pod scope-om) ili `ORGANIZATION`; postojeći ključevi
   ostaju `ORGANIZATION` (bez prekida integracija) — pregledati posle deploya.
4. **S-02:** zemlja bez pravila i red bez kolone „Fizičko lice" → `review_required` (ne uvozi
   se); „ne" u koloni + broj bez pravila = pravno lice (fajl to tvrdi). Potrošač se ponovo
   nalazi samo po šifri kupca iz ERP-a; bez nje → pregled. JMBG se nigde ne čuva.
5. **S-10:** worker čeka renderer najviše 60 s, pa događaj ide na retry; e2e ne diže renderer
   (PDF ostaje HTML pregled, kao ranije bez Chromium-a na hostu).
6. **S-11:** restore test više nije posao worker-a (ključ nikad u worker-u) — host cron.
7. **S-04:** `scripts/migrate.sh` čita `MIGRATE_DATABASE_URL` samo iz okruženja (više ne iz
   `.env`); bez njega poziva servis `migrate` sa `--build`.
8. Dev: `age` instaliran u dev kontejner (`setup-tools.sh`); `RENDERER_DB_PASSWORD` generisan u
   lokalnom `.env` (nije ispisan) i rola napravljena u dev klasteru.

### Incident u sesiji (dev baza, ispravljeno)

Provera „test pada na starom kodu" za S-04 je privremeno vratila stari `scripts/migrate.sh`, koji
čita `MIGRATE_DATABASE_URL` iz `.env`; test ga zove i bez argumenata (= `up`), pa je u 16:50 UTC
na **dev** bazu `collect` primenio tadašnje 021 i delimičnu 022 (S-05, S-09). Otkriveno pri
proveri image-a; dev baza vraćena na 020 (`down 022`, `down 021`, `VALIDATE CONSTRAINT`), app
`/health` 200, podaci nisu dirani (`render_jobs` prazna). Test sada radi nad kopijom skripte u
praznom privremenom direktorijumu (bez `.env`, lažni `psql`) — ne može da dođe do baze.

## Trajne odluke iz Sprinta 0–1

### Odluke Uroša za lanac 1.6 → 1.7 (2026-10-12)

- BACKLOG P2: hook pada ako je broj preskočenih testova veći od očekivanog (1).
- Release checklist: `scripts/create-worker-role.sh` kao superuser PRE migracije 007 — blokirajuće.
- `@sentry/nextjs` odobren kao jedini novi paket u 1.7.

### Odluke Uroša za lanac 1.3 → 1.5 (2026-10-12)

- `mail_outbox` ključ izveden iz master ključa — u ADR 0003 kao privremen; ujediniti sa
  `subject_keys` posle go-live (expand → contract); rotacija mora pokriti oba puta.
- `qrcode`: BACKLOG — zameniti kad postoji održavana alternativa.

### Odluke Uroša za lanac (2026-10-12)

- Sink (a): `mail_outbox` sa `recipient_enc` / `body_enc` kroz keyring; retencija 7 dana u 1.3.
- `tenants.is_demo`: demo = true, Sinergista = false; demo nikad SMTP (adapter + trigger + test).
- `verification.storeIdentifier: 'hashed'` — nalaz u ADR 0004.
- Pozivnica: `user_roles` iz `role_key`; owner poziva sve role, admin sve osim owner-a.

### Odluke Uroša posle 1.1a (2026-10-12)

- **Ispravka 005 (urađena):** `auth_membership_read` na `users` i `tenants` važi samo dok tenant
  nije izabran (`app_tenant_id() IS NULL`) — politike su permissive (OR), pa bi inače sesija u
  tenantu A videla i sopstveni red u tenantu B. Golden test sa oba GUC-a; mutacija ga obara.
- **Secure kolačić (1.1b):** `secureCookies = true` uvek, osim kad je `NODE_ENV !== 'production'`
  **i** `BETTER_AUTH_URL` počinje sa `http://localhost` ili `http://127.0.0.1`. Nikad env flag
  koji ga isključuje u prod-u. Uz unit test za sve kombinacije.
- **NOT VALID FK:** `VALIDATE CONSTRAINT users_auth_user` pre prvog staging deploya — BACKLOG i
  runbook „Release checklist".
- **`SEED_ADMIN_PASSWORD`:** Uroš upisuje ručno u `.env`, nikad kroz chat.

### Odluka Uroša posle 0.2b (2026-10-12; ADR 0002, odluka 4)

**Fizička lica:** preduzetnik (javni registar) ostaje u `legal_entities` uz `exception_reason`.
Potrošač nikad ne ulazi u `legal_entities` i nema `find_or_create`; `customers.legal_entity_id`
postaje nullable uz CHECK (NULL samo za `is_natural_person = true`), a identitet potrošača
postoji samo šifrovano na `customers`. Ulazi u migraciju 003, aditivno.

### Odluke Uroša posle 0.2a (2026-10-12; ADR 0002)

1. **Resource-scoped permisije:** kolona `scope` na `user_roles` (`OWN` / `TEAM` / `ORGANIZATION`),
   bez nove tabele. Pristup pojedinačnom resursu postoji samo kroz `access_grants`, i to samo za
   spoljne strane.
2. **Maker-checker:** izmene `role_permissions` i `user_roles` za admin role idu kroz
   maker-checker. Implementacija u 1.4 kroz `approval_requests`; u 0.2b samo `audit()`.
3. **`legal_entities.tax_id NOT NULL` ostaje**; fizička lica bez PIB-a → BACKLOG.

## Rizik

### Security (iz 5.0)

- **Prvi deploy posle 5.0 traži ručne korake** (Aktivan zadatak 1) — bez `vigor_renderer` migracija
  021 staje, bez `BACKUP_AGE_RECIPIENT` backup ne radi (alarm), bez identity-ja restore test pada.
- **Gubitak age privatnog ključa = backup-i nečitljivi** — čuvati kao `PII_MASTER_KEYS`.
- Renderer i dalje `--no-sandbox` (namerno), ali bez ijedne tajne i bez pristupa ičemu osim
  `render_jobs`.

### Preview (dev) — od 2026-10-12

- **Preview link se NE deli** dok `.env` nema prave Turnstile ključeve: aplikacija je javno
  dostupna na https://vigorcollect-u57586.vm.elestio.app, a Cloudflare-ovi test ključevi uvek
  propuštaju (CAPTCHA ne štiti); podaci su demo, prijava i dalje traži lozinku + TOTP. Prave
  ključeve Uroš upisuje van chata, pa `docker compose up -d app`.
- Nginx konfiguracija preview-a nije u git-u — kopija `docs/ops/nginx-preview.conf`, vraćanje u
  runbook „Preview (dev)".

### Za Sprint 2

- **Sopstveni XLSX čitač** (umesto paketa): nepoznati izvozi (ZIP64, šifrovani, više listova) se
  odbijaju jasnom greškom; pokriti u security review-u kao parser nepouzdanog ulaza.
- **Uvoz zavisi od worker-a**: bez njega potvrđen uvoz ostaje „u obradi" (izveštaj to prikazuje).
- **Bez kursa nema zbira**: tenant sa fakturama u stranoj valuti vidi „nedostaje kurs" dok
  `fxRatesJob` ne upiše kurs (RSD tek sa NBS adapterom).
- **Migracije 012–014 su aditivne** (nove tabele, kolone sa default-om); `down` briše sve
  finansijske podatke — samo dev/test (pravilo 15).

### Za Sprint 1

- **Worker traži ručni korak po klasteru** (rola) pre 007 — bez toga migracija stoji.
- **Turnstile zavisi od Cloudflare mreže**: kad CF ne radi, prijava ne radi (pada zatvoreno).
- **e2e traži mrežu** (Turnstile test ključevi) i `collect_test` sa 007/008.
- **Nema SMTP-a**: sve u sink do odobrenja `nodemailer`.
- **`qrcode` bez izdanja od 2024-08** — izuzetak od pravila 14 (BACKLOG).
- **Better Auth nadogradnja = moguća migracija** (`getMigrations()` uporediti sa 005).
- **Matrica permisija je pretpostavka o poslovnim ulogama** (0.3); izmena = `docs/permissions.md` + nova migracija.

### Trajni

- **`PII_MASTER_KEYS` gubitak = trajni gubitak svih P1–P3 podataka.** Dev ključ je potrošan
  (samo `.env`); staging/prod ključevi se generišu van Claude sesije i čuvaju u vault-u, nikad u
  backup-u (ADR 0003, runbook).
- **Dev kontejner postavlja `PIP_TARGET=/opt/app/data/.python-deps` i `PYTHONPATH` na isto.**
  Svaka `pip install` bez očišćenog okruženja piše u `/opt/app/data/` (`setup-tools.sh` instalira
  semgrep kroz pipx sa očišćenim okruženjem).
- **Pre-commit zahteva bazu** (`test:db`): bez `docker compose up -d db` commit ne prolazi.
- **`test:db` primenjuje i necommit-ovane migracije na `collect_test`.** Ako se predlog menja
  posle primene, checksum pada → reset test baze (`down` pa `up`, runbook).
- **Docker daemon ≠ ovaj kontejner.** Bind mount-ovi iz `/srv/vigor-collect` ne rade; portovi:
  `DB_BIND_HOST=172.17.0.1`, `POSTGRES_PORT=15432`.
- Login (1.3) i outbox dispatcher (1.5) ne mogu da rade dok se ne urade pravci iz ADR 0002 „Otvoreno".
- Statički golden test je regex nad SQL-om; živa provera je `tests/golden/db/rls.test.ts`.
- `npm audit` u hook-u zavisi od mreže — offline commit neće proći.

## Istorija

- **Lanac Sprint 4 (4.1–4.3)** (2026-10-13): `c8263ec`, `c3849b4`, `9644373`; `7bc32de` migracije
  018–020 (Uroš); merge `6d3c6bb`. 15 pretpostavki: `git show c1bd4c2:docs/NEXT.md`.

- **3.3 zatvaranje Sprinta 3** (2026-10-13): `8240d00`, `420f9cd`; `eed9198` migracija 017 +
  compose/Dockerfile (Uroš); merge `c5f1970`. 10 pretpostavki: `git show 420f9cd:docs/NEXT.md`.

- **Noćni lanac 2.5 → 3.1 → 3.2** (2026-10-12/13): `a4c4ee6`, `f740953`, `4dc2420`, `9c9d44f`;
  `82e9148` migracije 015–016 (Uroš); merge `59a77e6`. Demo uvoz: 40 faktura, 8 kupaca, dospelo
  10.946.484,18 RSD. 15 pretpostavki: `git show 0bdcfce:docs/NEXT.md`.

- **Lanac Sprint 2 (2.1–2.4)** (2026-10-12): `04c2530`, `289e6ea`, `9f1f919`, `763af29`;
  `8d0624f` migracije 012–014 (Uroš); merge `710bd2d`. 20 pretpostavki:
  `git show 62af19e:docs/NEXT.md`.

- **Lanac 1.6 → 1.7 i zatvaranje Sprinta 1** (2026-10-12): `3aca0ba`, 1.7, migracije 009–011,
  `develop`. Pretpostavke i odluke: `git show e06390b:docs/NEXT.md`.

- **Lanac 1.3 → 1.4 → 1.5** (2026-10-12): `6ea8b99`, `c207067`, `a18b6c5`; `cc26a28` migracije
  007 + 008, `src/server/auth/*`, compose (Uroš). 16 pretpostavki: `git show a18b6c5:docs/NEXT.md`.

- **Lanac 1.1b → 1.1c → 1.2** (2026-10-12): `273f1ad`, `431ec69`, `e41fa02`; `0633c3b` migracija
  006 + `src/server/auth/*` (Uroš). 15 pretpostavki: `git show e41fa02:docs/NEXT.md`.

- **1.1a autentifikacija** (2026-10-12): `a08c05f` testovi, ruta, seed, docs; `ded50d5` ispravka
  politike + odluke; `9ab892e` migracija 005 + `src/server/auth/*` (Uroš). 15 pretpostavki:
  `git show ded50d5:docs/NEXT.md`.

- **0.3 permisije i wireframe-i** (2026-10-12, noćni režim): `e861e22` matrica + role,
  `33a07a0` wireframe-i, `9f667af` migracija 004 (Uroš). 13 pretpostavki:
  `git show 33a07a0:docs/NEXT.md`. Sprint 0 zatvoren.
- **0.2c deljenje i governance** (2026-10-12, noćni režim): `b808e7c` kod, testovi, docs;
  `ab4972c` migracija 003 (Uroš). 15 pretpostavki: `git show b808e7c:docs/NEXT.md` (sve
  prihvaćene; `request_id` ostaje `uuid`).

- **0.2b stranke i šifrovanje** (2026-10-12): `7fd5b9e` kod, testovi, docs; `4fafbe7` migracija
  002 (Uroš). 12 pretpostavki: `git show 7fd5b9e:docs/NEXT.md`. Dev ključ procureo u chat i
  zamenjen istog dana. Na `collect`: migracije 000–002; demo tenant 2 kupca, 2 kontakta, 3 ključa
  (2 subjekta + blind index tenanta), 0 email-ova u čistom tekstu; admin `scope = ORGANIZATION`.

- **0.2a Schema v1** (2026-10-11/12): `4bf31ef` testovi, seed, docs; `82b5905` migracija 001 (Uroš).
  18 pretpostavki iz noćnog režima: `git show 4bf31ef:docs/NEXT.md`.
  Na `collect`: `schema_migrations` = 000, 001; seed: 2 legal entities, po 1 tenant/user po
  kontekstu, audit tenant #0 = 3 reda (1 user.created + 2 tenant.provisioned), demo = 1.
- **0.1 Bootstrap** (2026-10-11): `bcde887` skelet, `335a261` zaštićeni fajlovi (Uroš). Detalji u ADR 0001.
