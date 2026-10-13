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

**Noćni lanac 2.5 → 3.1 → 3.2 završen na `feature/sprint-3`.** Sledeće: tvoje tri odluke (ispod),
pa nalazi security review-a (Sprint 2 + 3), pa Sprint 3 nastavak.

### Čeka tvoju odluku (STOP-ovi lanca, ništa nije zaobiđeno)

1. **PDF.** Image nema Chromium ni wkhtmltopdf. Dokumenti su HTML (šifrovani, pregled u
   aplikaciji). Predlog:
   - **(a) `puppeteer-core` + `chromium` (Debian paket) u worker image-u.** Verna kopija HTML-a
     i istog šablona, image je oko 300 MB veći, a Chromium se ažurira sa sistemom.
   - **(b) `pdfkit`.** Mali paket bez browsera, ali traži zaseban crtež dokumenta (šablon ≠ PDF),
     bez HTML tabela.
   - Preporuka: (a), samo u worker-u, render u poslu `document.render` (bez mreže, `--no-sandbox`
     nije potreban kao `node` korisnik).
2. **`mail_outbox.kind`** (CHECK: samo `invitation` / `password_reset`). Za `queue_email` treba
   DROP + ADD CHECK sa `collection`, bez gubitka podataka. Do tada `queue_email` beleži
   `mail_kind_pending_decision`.
3. **`export_log.format`** (csv / xlsx / pdf / json). Preuzimanje HTML dokumenta bi tražilo
   proširenje CHECK-a. Predlog: ne proširivati, nego sačekati PDF (odluka 1).

## Poslednja sesija — noćni lanac 2.5 → 3.1 → 3.2 (2026-10-12/13)

### Urađeno po bloku

- **2.5 `a4c4ee6`** (+ predlog 015):
  - `payments.payment_kind` (payment | adjustment) je generisan iz `kind`, bez backfill-a;
  - razlog korekcije je code lista `adjustment_reason` (podrazumevano `unknown`);
  - korekcija se ne računa u „Naplaćeno (30 dana)", stopu naplate ni DSO (`docs/metrics.md`);
  - `instrumentation-node.ts` (bez `process.exit` u Edge-u), pa build bez upozorenja;
  - stari server na 3101 je ugašen;
  - demo uvoz na dev: **40 faktura, 8 kupaca, dospelo 10.946.484,18 RSD** (otvoreno 13.651.719,58).
- **3.1 `f740953`** (+ predlog 016): rule engine (workflows, verzije, run-ovi sa objašnjenjem,
  idempotentnost), Standard politika D-7 … D+90, Administracija → Pravila, run-ovi u hronologiji case-a.
- **3.2 `4dc2420`, `9c9d44f`:** šabloni (bela lista, bez eval-a, verzije), dokumenti (opomena,
  IOS; šifrovano skladište), exportService (potpisan link + `export_log`), „Zahteva pažnju",
  Administracija → Šabloni, Customer 360 → Dokumenti.
- **Testovi:** unit 140, DB 259, e2e 34 (+3 namerno preskočena). `next build` bez upozorenja.

### Pretpostavke (najkonzervativnija opcija)

1. `payment_kind` je generisana kolona umesto promene `kind` — bez DROP/RENAME i bez backfill-a pod
   FORCE RLS; contract (uklanjanje `kind`) je u BACKLOG-u.
2. DSO vraća korekcije u brojilac (korekcija nije naplata). Otvoreno ukupno i aging ih ne vraćaju,
   jer taj dug više ne postoji.
3. „Naplaćeno (30 dana)" je u zoni tenanta. Stopa naplate = naplaćeno ÷ (naplaćeno + dospelo).
4. Dozvole: pravila i šabloni koriste `settings.read` / `settings.manage`; objavu odobrava druga
   osoba sa `settings.manage`. Ključevi `workflow.*` / `template.*` su u BACKLOG-u.
5. Engine nije osoba (`approval_requests.requested_by` je NOT NULL). Zato `create_approval` i
   `create_decision` prave **predlog** (`decisions` source `rule`, `proposed`) i obaveštenje;
   zahtev za predaju pravnoj podnosi čovek (pravila 11 i 19).
6. Pokušao sam CHECK „approved ⇒ approved_by" na `decisions`, ali je oborio postojeći golden test
   (pravilo 19 važi samo za fizička lica; pravilo sme da odluči za pravno lice). Uklonio sam ga, jer
   bi menjao poslovno pravilo.
7. D-7 se računa u radnim danima (pon–pet, zona kompanije), bez praznika (BACKLOG). D+N je u
   kalendarskim danima.
8. Run se pravi samo za objavljene verzije. Ključ dnevnog okidača je lokalni datum; za
   „bez aktivnosti" ključ je datum poslednje aktivnosti (jednom po periodu neaktivnosti).
9. Događaji koje izazove engine (`payload.source = workflow`) ne pokreću pravila (bez petlji).
10. Tekstovi šablona su u `template_texts` (šablon × jezik), ne u `translations`, čiji CHECK-ovi
    dozvoljavaju samo nazive rola i code lista. Proširenje bi tražilo DROP.
11. Pregled dokumenta je server-render tela posle ponovne provere bele liste tagova (CSP ne
    dozvoljava iframe/srcdoc).
12. Skladište dokumenata je `DOCUMENTS_DIR` na disku. U Docker-u nema volume-a, pa se dokumenti
    gube pri rekreiranju kontejnera; `docker-compose.yml` nisam dirao (zaštićen) — BACKLOG.
13. Za „velika dospela faktura" bez praga u `tenant_settings` važi 5 najvećih; nijedan iznos nije
    u kodu.
14. Opomena pred utuženje fizičkom licu: šablon nosi `has_legal_effect`, pa ga engine nikad ne
    šalje (`rule_19`), a za fizičko lice Standard pravi predlog odluke.
15. Na dev bazi je danas dnevni posao već prošao, pa Standard pravila prvi put rade sutra posle
    06:00 (Europe/Belgrade) — tada preview dobija case-ove i run-ove.

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
