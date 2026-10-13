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

**Sprint 4 zatvoren (4.1 → 4.2 → 4.3, `feature/sprint-4` → `develop`).** Sledeće:

1. **AI sloj predloga** (pravilo 22): `ai_suggestion` sa statusom, `src/server/ai/adapter`,
   `ai_runs` (tokeni, cena), `redaction_level` po tenantu; ulazi su i primljena pošta (nepouzdan
   ulaz — zaseban blok, nikad instrukcija) i objašnjenja rizika; upis samo kroz iste servise kao
   ručna akcija (maker-checker, pravilo 19).
2. **Izveštaji:** naplata, DSO trend, aging po vremenu, efikasnost pravila, isporučivost pošte;
   izvoz samo kroz exportService.
3. Iz ranijih: security review Sprint 1–4, P1 GitHub (gore).

## Poslednja sesija — lanac Sprint 4 (2026-10-13)

Odluke Uroša: pošta preko n8n-a (Google Workspace, Microsoft 365, IMAP/SMTP) — n8n poziva naš API
i webhook-ove, UI je kod nas; SEF ostaje CSV iz ERP-a; CheckPoint probni ključ (env, Uroš
upisuje); APR i NBS javni podaci kao dodatni izvori; bez novih npm paketa.

### Urađeno

- **4.1 `c8263ec`** (+ predlog 018, `auth/with-tenant.ts`, `auth/audit.ts`): integracije, šifrovane
  tajne (prikaz jednom), `external_records`, `sync_runs`; inbound webhook (HMAC nad sirovim
  telom, ±5 min, exactly-once, 202 + worker, dead letter + „pokušaj ponovo"); outbound događaji
  (potpisan POST, backoff 1 min → 12 h, demo = sink); API ključevi (heš, scope = dozvole kreatora
  bez checker dozvola, rate limit, opoziv, actor `api_key`); Administracija → Integracije;
  `docs/integrations` + n8n šabloni.
- **4.2 `c3849b4`** (+ predlog 019): primljena pošta (šifrovano, nepouzdan ulaz), uparivanje
  (Message-ID → case, blind index → kupac, inače „Nepovezane poruke"), bounce → „Zahteva
  pažnju", slanje kroz n8n sa Message-ID provajdera, Customer 360 → Komunikacija (neaktivni
  linkovi, odgovor iz šablona ili slobodan tekst → aktivnost), pošta u hronologiji case-a.
- **4.3 `9644373`** (+ predlog 020, compose): signali (interni + provajderi po zemlji), ocena sa
  objašnjenjem, ponderi/pragovi u `tenant_settings`, provajderi checkpoint/apr/nbs (stub), predlog
  kreditnog statusa → `decision.approve` (fizičko) / `customer.risk_override` (pravno), Customer
  360 → Rizik, kolona Rizik, „Zahteva pažnju" za nov crveni, dnevni posao.

### Pretpostavke (najkonzervativnija opcija)

1. **Zamene CHECK-a (nadskup, isto ime)** po obrascu 017/ADR 0003: `audit_log.actor_type` +
   `api_key` (018); `mail_outbox` kind + `reply`, transport + `integration`, status + `bounced`,
   `sent_at` ublažen za `bounced` (019). Zadatak ih eksplicitno traži; bez izmene redova.
2. API ključ nije član: `ctx.userId` = id ključa; radnje koje traže osobu (aktivnost, zahtev za
   odobrenje) ga odbijaju preko FK. Ključ dobija samo dozvole koje kreator ima, nikad checker.
3. Webhook bez važećeg potpisa se **ne čuva** (inače bi zauzeo `external_event_id`);
   `signature_ok` je zato uvek `true` (CHECK), a odbijanja su u logu.
4. Jedna potpisna tajna po integraciji za oba smera; jedna aktivna mailbox integracija po tenantu.
5. Naslov primljene pošte je **šifrovan** (zadatak kaže `subject`), jer može sadržati lične podatke.
6. Prilozi: samo metapodaci (`mail_inbox.attachments`); `documents` ne prima druge vrste bez
   proširenja CHECK-a — BACKLOG.
7. Bounce: pošiljalac mailer-daemon/postmaster + citiran naš Message-ID; ili `mail.status` iz n8n-a.
8. Adresa pošiljaoca i primaoca vidi se samo uz `contact.read`; admin (bez PII kontakata) u
   „Nepovezanim porukama" vidi samo domen.
9. **CheckPoint / APR / NBS su stub-ovi** (`unsupported`): API reference nisu dostupne; endpointi
   nisu izmišljeni. Ocena radi na internim signalima; spoljni signal je „nema podatka".
10. Prava izvora (pravilo 35): sva tri `may_redistribute = false`; CheckPoint retencija 365 dana
    je pretpostavka do ugovora.
11. Provajderi se pitaju samo za pravna lica (potrošač se ne proverava u registrima).
12. Score: celobrojni poeni po pragovima, ponderisani prosek, zaokruživanje naviše od pola;
    `inactivity_days` važi samo dok postoji dospeo dug; nikad kontaktiran = > 60 dana.
13. `customers.credit_limit` je nov i prazan — signal izloženosti se ne računa dok se limit ne
    unese (BACKLOG: maker-checker `approval.credit_limit`).
14. Predlog kreditnog statusa: jedan otvoren po kupcu; `has_legal_effect` samo za crveni.
15. Domenske sekcije 18–23 nisu pronađene u repou ni na disku — rađeno po tekstu zadatka.

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
