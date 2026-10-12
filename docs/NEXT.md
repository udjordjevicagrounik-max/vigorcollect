# NEXT

## P1 — sutra PRVO (2026-10-13)

**Repo i `/srv/backups` žive u kontejneru `app-vibecoder-1`, ne na hostu** — ako se kontejner
rekreira (update Vibecoder-a, restart stack-a sa novim image-om), nestaje i kod (sa celom git
istorijom) i sve lokalne backup kopije. Redom:

1. **GitHub remote + push** (`main`, `develop`, tagovi) — privatni repo; ključ/token van chata.
2. **Backup kopija na host putanju:** bind mount host direktorijuma u kontejner (izmena
   `/opt/app/docker-compose.yml` servisa `vibecoder` — infrastruktura, Uroševa odluka) ILI cron na
   hostu sa `docker cp app-vibecoder-1:/srv/backups <host putanja>` posle 02:00 UTC.
3. Dok se to ne uradi: nikakvi novi podaci od vrednosti u dev bazi; demo seed se obnavlja.

## Aktivan zadatak

**Sprint 2 (2.1–2.4) završen na `feature/sprint-2`; sledeće: nalazi security review-a, pa
Sprint 3 — rule engine.**

1. **Security review** u ODVOJENOJ sesiji: ulaz `docs/security-review-input.md` + checklist;
   obuhvatiti i Sprint 2 (migracije 012–014, uvoz fajlova kao nepouzdan ulaz, XLSX čitač,
   `fx_convert` / `invoice_positions`, maker-checker za predaju pravnoj). Nalazi pre Sprinta 3.
2. **Sprint 3 — rule engine** na novoj `feature/*` grani od `develop`.

**Blokade za staging** (runbook „Release checklist"): Turnstile ključevi · Sentry DSN · off-site
bucket + ključevi · kanal za alarme · servisne role na Elestio pre 007/011 ·
`VALIDATE CONSTRAINT users_auth_user` · GitHub remote (CI, `/code-review`) · NBS adapter ako je
prvi klijent u RS profilu (ECB nema RSD).

## Poslednja sesija — lanac Sprint 2 (2026-10-12, režim lanca)

### Urađeno po bloku

- **2.1 finansijska šema — `04c2530`** (+ predlog 012): `invoices` (EN 16931 osnovna polja,
  `due_date date`, FX zamrznut triggerom), `payments` (`received` / `source_settlement`),
  `payment_allocations` (Σ ≤ uplata, Σ ≤ faktura, ista valuta i kupac), `amount_open` uvek izveden
  triggerom iz alokacija (ručni upis se prepisuje), `promises`, `activities` (beleška šifrovana),
  `collection_cases` + `case_invoices`, `aging_bucket_bounds`; podrazumevano u `tenant_settings`
  / code listama (`provision_receivables_defaults()`); `money.ts` (bigint, half-even),
  semgrep `no-float-amounts`, `fxRatesJob` (ECB; NBS skelet), DEMO kursevi u seed-u.
- **2.2 uvoz — `289e6ea`** (+ predlog 013): wizard (fajl → mapiranje → pregled → izveštaj),
  šablon mapiranja po tenant + izvor, Zod po redu, potvrda → worker (`import.confirmed`),
  idempotentno po (izvor, `external_id`), exception-i, rollback; demo CSV u `scripts/demo-import/`.
- **2.3 kupci / 360 / dashboard — `9f1f919`** (+ predlog 014): lista (pretraga, filteri,
  privatni sačuvani filteri), Customer 360 sa 6 tabova i aging-om, dashboard (6 KPI sa
  definicijama iz `docs/metrics.md`, aging, „moj rad danas" OWN/TEAM, drill-down).
- **2.4 case / obećanje / aktivnost — `763af29`**: ekran case-a sa hronologijom, obećanja
  (izmena / otkaz, dnevna evaluacija D+1), ručna uplata (eksplicitno → FIFO), aktivnosti,
  „Predaj pravnoj" → `approval_request` + `decisions` za fizička lica; Playwright 375 px ceo tok.
- **Testovi:** unit 138, DB 246, e2e 33 (+2 namerno preskočena); hook zelen na svakom commit-u.

### Pretpostavke (najkonzervativnija opcija)

1. **exceljs uklonjen** (dodat u `04c2530`, uklonjen u `289e6ea`): pretvara numeričke XLSX ćelije u JS `number` — iznos bi prošao kroz float (STOP uslov). Sopstveni čitač (`zlib` + XML tekst) čuva tačan decimalni tekst; nema novog paketa; `npm audit` 0 nalaza.
2. Niži saldo iz izvora = `source_settlement` uplata + alokacija razlike (nikad upis `amount_open`); viši saldo, promena iznosa / valute / kupca i svaka promena plaćene fakture = reconciliation exception. Dospeće, broj i reference prate izvor.
3. `payments` se ne brišu, osim nealocirane `source_settlement` uplate (trigger) — samo za rollback uvoza.
4. Rollback uvoza: briše fakture iz run-a koje niko nije dirao (bez tuđih alokacija, case-a i kasnijeg uvoza) i vraća settlement-e run-a ako posle njih nema alokacija; ostalo `rollback_blocked`. Kupci i metapodaci ostaju. Dozvola: `import.create` (nema `import.rollback`).
5. Kupac iz uvoza: `find_or_create` po (država, PIB), samo pravna lica; država bez kolone = država tenanta.
6. Uvezeni redovi šifrovani HKDF ključem po tenantu (kao `mail_outbox`), brišu se na kraju / otkazu (DB CHECK); greške redova samo kao (polje, kod).
7. Kolona „Valuta" / „Valuta plaćanja" = **datum dospeća** (srpsko knjigovodstvo), nikad valuta.
8. Upload kao base64 JSON (Zod gate ne dozvoljava multipart), do 5 MB / 20.000 redova; ekran uvoza je `mobile-compact` (zadatak), iako wireframe kaže `desktop-only`.
9. Dospelo = `due_date` < lokalni danas kompanije fakture (`invoice_positions`, `security_invoker`); na dan dospeća nije dospelo.
10. Izveštajna valuta = valuta tenanta; `fx_convert` uzima poslednji kurs ≤ dan, prednost izvoru iz profila; bez kursa iznos se ne sabira i prikazuje se „nedostaje kurs".
11. Profil RS ostaje `fx_source = ECB` dok NBS adapter ne postoji; dev ima DEMO kurseve EUR/RSD (ne predstavljaju se kao ECB/NBS).
12. DSO: prozor iz `tenant_settings.dso_window_days`, fakturisano bez `cancelled`, zaokruženo na 0,1 dan; bez fakturisanja „—".
13. „Prekršena obećanja" na dashboard-u = `broken` sa datumom u poslednjih 30 dana.
14. Obećanje se ocenjuje nezavisno: uplate kupca u istoj valuti sa `paid_on` ∈ [dan obećanja, datum + grace); `partial` takođe dobija događaj. Ručna uplata odmah ispunjava pokrivena obećanja.
15. Ručna uplata: imenovana faktura pa FIFO po dospeću, samo u valuti uplate; preplata ostaje nealocirana; datum u budućnosti se odbija; izvor `file-import` do bankovnih izvoda.
16. Predaja pravnoj: maker `approval.create` + `case.update`, checker `approval.legal_handover`, četiri oka; `decisions` red samo za fizička lica (pravilo 19); faza `legal` direktno nikad (servis + DB CHECK).
17. Scope svih potraživanja ide preko kupca; golden `scope-usage` proširen na fakture, uplate, obećanja, aktivnosti i case-ove; izuzetak je uvoz (tenant-wide, `import.create`).
18. Sačuvani filteri: RLS po tenantu, privatnost po korisniku u servisu (`user_id` = ja).
19. „Moj rad danas" računa „danas" po podrazumevanoj kompaniji tenanta.
20. E2E diže i worker (drugi `webServer`, port 3191): na 3101 već radi stari `next-server` (pokrenut pre ~25 h) — nisam ga dirao.

### Odluke Uroša za Sprint 2 (2026-10-12)

- Domenski default-i: aging 0 / 1–30 / 31–60 / 61–90 / 91–180 / 180+ kao code lista po tenantu;
  dospelo = kraj dana dospeća u zoni kompanije; FIFO po dospeću osim uz broj fakture; DSO po
  `docs/metrics.md`; obećanje prekršeno D+1 bez uplate ≥ iznosa.
- exceljs odobren (posle uklonjen — pretpostavka 1).

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
