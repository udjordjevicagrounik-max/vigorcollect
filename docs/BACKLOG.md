# Backlog

Ideje i tehnički dug zapisani usred zadatka (protokol: ne predlaže se usred zadatka, zapisuje se ovde).

## Tehnički dug iz 0.1

- [ ] Vratiti `eslint-config-next` kad `braces` advisory (GHSA-vfj7-8cjw-p6xm) dobije ispravku — ADR 0001.
- [ ] Kontrast u hook-u kroz `axe` (CLAUDE.md „Design tokeni"): `@axe-core/playwright` u e2e za svaki ekran.
- [ ] PWA ikone (192/512, maskable) — manifest trenutno ima `icons: []`.
- [ ] Service worker: tek kad bude potreban offline shell; ništa finansijsko u kešu (pravilo 16).
- [ ] `/health` readiness: `SELECT 1` kao `vigor_app` + poslednja primenjena migracija (bez detalja greške).
- [ ] Prebacivanje jezika u UI (cookie `locale`) — posle 1.3, kad postoji `users.locale`.
- [ ] Mobilna navigacija: na 375 px nav je iznad sadržaja; kad grupa bude imala više stavki → meni/drawer.
- [ ] CI (GitHub Actions ili Elestio pipeline): isti koraci kao pre-commit + Playwright.
- [x] CODEOWNERS: vlasnik upisan (email format).

## Iz 0.2a

- [ ] Drizzle definicije (`src/db/schema`) za tabele iz 001 — read-only ogledalo SQL-a, pre prvog ekrana sa podacima.
- [ ] `seed-demo.ts` zaštita od pokretanja na staging/prod bazi (npr. odbij ako postoje ne-demo tenanti).
- [ ] `verify-tenant.sh` / `rls-drift-check.sh` (1.6): iskoristiti upite iz `tests/golden/db/rls.test.ts`.
- [ ] Maker-checker (1.4) za izmene `role_permissions` i `user_roles` admin rola kroz `approval_requests` (ADR 0002, odluka 2).
- [ ] `legal_entities.tax_id`: DROP NOT NULL za fizička lica bez PIB-a (+ parcijalni unique) — ADR 0002, odluka 3.

## Iz 0.2b

- [ ] Re-wrap job (rotacija `PII_MASTER_KEYS`) i re-encrypt job (rotacija ključa subjekta / blind index ključa tenanta) — ADR 0003.
- [ ] Erasure tok (GDPR čl. 17): crypto-shredding `subject_keys` + audit, sa maker-checker-om.
- [ ] `docker-compose.yml`: `PII_MASTER_KEYS` za app servis (zaštićen fajl — Uroš) pre prve rute sa kontaktima.
- [ ] `customers.tenant_company_id` („kompanija koja vodi kupca", pravilo 26) kad prvi job računa dospeće po zoni kompanije.
- [ ] Pretraga kontakata po telefonu (blind index za `phone`, E.164 normalizacija) — ako zatreba.

## Iz 0.2c

- [ ] Identitet potrošača osim imena: `personal_id_enc` (+ blind index po tenantu), `address_enc` — aditivno, sa prvim uvozom potrošača.
- [x] Popuniti `permissions` iz `docs/permissions.md` (migracija) — 0.3, migracija 004 + role u seed-u.
- [ ] Seed: code liste (`customer_segment`), prevodi naziva uloga, demo partner + grant (kad prvi ekran zatraži).
- [ ] Job koji označava istekle `approval_requests` (`expired`) i obaveštava o grantovima pred istek.

## Iz 0.3

- [ ] Prevodi naziva sistemskih rola (`translations`, `entity_type = 'role'`, sr-Latn + en) — sa ekranom admin-users (1.3/1.4).
- [ ] Seed uklanja grant koji je izbačen iz matrice (danas seed samo dodaje); u produkciji izmena rola ide kroz maker-checker (1.4).
- [ ] Wireframe → komponente: tokeni iz `tokens.css` u Tailwind temu već postoje; ekrani iz `docs/wireframes/` su referenca, ne kod.

- [ ] `down 004` kompletan tek kad `vigor_migrate` dobije politiku za `role_permissions` (danas RLS sakriva grantove → dodeljeni ključevi ostaju).

## Iz 1.1a

- [ ] Rate limit po email-u (prijava, reset, pozivnica) — odluka 2a: u MVP-u samo po IP-u.
- [ ] `qrcode` paket za TOTP QR (odobren, odluka 3b) — dolazi sa ekranima u 1.1b; obrazloženje u commit poruci.
- [ ] Email servis + sink za demo tenant (reset lozinke, pozivnice) — 1.1b; do tada `mailer` ne šalje ništa.
- [ ] `VALIDATE CONSTRAINT users_auth_user` — **pre prvog staging deploya** (Uroš, 2026-10-12); stavka je i u runbook „Release checklist".
- [ ] Admin tok za otključavanje i reset MFA (maker-checker, audit) umesto ručnog SQL-a iz runbook-a — 1.4.
- [ ] Brisanje isteklih `auth.session` / `auth.verification` redova (job, 1.3 outbox ili cron).
- [ ] `failedSignInCount` atomičan increment direktno na `auth.user` (lost update pri paralelnim promašajima), P3.

## Iz 1.1b

- [ ] SMTP transport: `nodemailer` nije u zavisnostima (nije instaliran, pravilo 14) — do odobrenja svi tenanti pišu samo u sink; `smtpEnabled` je svuda `false`. Demo tenant nikad ne dobija SMTP (adapter + trigger 006).
- [ ] Retencija `mail_outbox` 7 dana — retention job u 1.3 (worker rola; app nema DELETE).
- [ ] Pregled sink-a za demo tenant u aplikaciji (dešifrovano, samo `admin`/`owner`) — uz admin ekran korisnika (1.5).
- [ ] Ekran za slanje/ponovno slanje pozivnice (admin-users wireframe) — 1.5; API postoji od 1.2.
- [ ] Proširenje scope-a pozvanog korisnika (`OWN` → `TEAM`/`ORGANIZATION`) kroz `user.assign` (maker-checker, 1.4).
- [ ] Rate limit po IP-u za prihvatanje pozivnice (token je 256-bitni, pa nije hitno) — uz rate limit po email-u.

## Iz 1.1c

- [x] Cloudflare Turnstile (pravilo 27) na login, reset i pozivnici — urađeno u 1.4 (ADR 0006); ključevi u vault pre staging-a.
- [ ] Ekrani za reset lozinke (zahtev + nova lozinka); API i mail (sink) postoje od 1.1a/1.1b.
- [ ] Unos rezervnog koda na `/login/mfa` (Better Auth `/two-factor/verify-backup-code` postoji).
- [ ] `qrcode` (1.5.4) — poslednje izdanje 2024-08 (izuzetak od pravila 14 odobren u 3b). **Zameniti kad postoji održavana alternativa** (Uroš, 2026-10-12); do tada ručni unos ključa ostaje na ekranu.
- [ ] Posle prihvatanja pozivnice postojećim nalogom: povratak na pozivnicu posle prijave (`?next=`), umesto „otvorite link ponovo".

## Iz 1.2

- [ ] `requirePermission` ne razlikuje 🅼 (samo checker) od ✅ — `role_permissions` nema tu oznaku; maker-checker tok i oznaka u 1.4 (baza već tera podnosilac ≠ odobrilac).
- [ ] Sentry: `logEvent(level: 'error')` je JSON na stdout sa `requestId`; povezivanje sa Sentry-jem u 1.7 (ops).
- [ ] `withTenant` za server komponente (stranice čitaju podatke tenanta) — uz prve ekrane sa podacima (1.5); do tada stranice samo proveravaju sesiju (`requireTenantSession`).
- [ ] Postojeći audit redovi iz seed-a i 0.x testova nisu prošli redakciju (pišu samo id-jeve i P0) — bez akcije, napomena.

## Iz 1.1b — privremeni ključ za `mail_outbox`

- [ ] Ujediniti ključ `mail_outbox` sa `subject_keys` posle go-live (expand → contract); rotacija master ključa do tada mora pokriti i HKDF put (ADR 0003, „Privremeno").

## Iz 1.3

- [ ] Oporavak događaja zaglavljenih u `processing` (pg-boss posao izgubljen ručnim brisanjem) — periodični job koji ih vraća u `pending` posle N minuta.
- [ ] SMTP slanje u `mail-dispatch` kad se odobri `nodemailer` (dešifrovanje kroz keyring tenanta u worker-u).
- [ ] pg-boss tabele su van RLS konvencije (šema `pgboss`, bez tenant podataka) — pregledati pri nadogradnji pg-boss-a.
- [ ] Dnevni posao tenanta (`tenant-daily`) još nema poslovne korake — podsetnici i aging u Sprintu 2; poslovi po kompaniji (ključ tenant + kompanija + lokalni datum) kad prvi zatreba.

## Iz 1.4

- [ ] `X-Forwarded-For` se veruje za rate limit / Turnstile `remoteip` — ograničiti na poznati proksi (Elestio nginx) ili čitati samo poslednji hop.
- [ ] CSP `report-to` endpoint (prijava prekršaja u log) — uz Sentry (1.7).
- [ ] `style-src-attr 'unsafe-inline'` — ukloniti kad Next i Turnstile prestanu da koriste style atribute (hash-evi).
- [ ] Rate limit po email-u (već u „Iz 1.1a") i po tenantu za skupe rute (izvoz, uvoz).

## Iz 1.5

- [ ] Reaktivacija deaktiviranog korisnika (ekran + `user.update`, audit).
- [ ] Red zahteva za odobrenje (`approval.read`) za sve vrste — sada se odlučuje samo promena role, na ekranu Korisnici.
- [ ] Promena role pozvanog (još neprihvaćenog) korisnika = nova pozivnica; posebno dugme.
- [ ] Pregled sink-a za demo tenant (već u „Iz 1.1b").
- [ ] Feature flag-ovi (`isFlagEnabled`) čitati kroz `withTenantPage` — sada su svi isključeni (pravilo 31 drži Resolution skrivenim).
- [ ] `docker-compose.yml`: `app` i `worker` grade isti image dvaput — zajednički `image:` tag pri prvom deploy-u.

## Iz 1.5 → 1.6 (Uroš, 2026-10-12)

- [ ] **P2:** pre-commit hook pada ako je broj preskočenih testova veći od očekivanog (1 — e2e desktop varijanta toka pozivnice). Povod: fajl koji padne pri učitavanju Vitest prijavljuje kao „skipped".

## Iz 1.6

- [x] `team.read` / `team.manage` u matrici — migracija 011 (Uroš, zatvaranje Sprinta 1).
- [ ] Arhiviranje tima (ekran) i premeštanje članova između timova jednim korakom.
- [ ] Dodela vlasnika kupca (`customer.assign`: korisnik i/ili tim) — uz ekrane kupaca (Sprint 2).
- [ ] Više timova po osobi: `ALTER TYPE team_membership_kind ADD VALUE 'secondary'` (aditivno) + `scopeFilter` već čita sve članstvo.
- [ ] Dozvole role `owner` menjati samo kroz platformski proces (sada zabranjeno u toku odobrenja).

## Iz 1.7

- [x] `postgresql-client-16` + `rclone` u worker stage (Dockerfile, pinovano) — zatvaranje Sprinta 1; host cron ostaje fallback.
- [x] Off-site klijent `rclone` u worker image-u; ostaje: bucket + ključevi (blokada za staging).
- [ ] Sentry u browseru (client-side) i upload source map-a — sada samo server (app + worker).
- [ ] Šifrovanje backup-a pre off-site slanja (npr. `age`) — dump sadrži P1 kolone sa izuzetkom (`users.email`).
- [ ] Alarmi u bazi umesto u memoriji worker-a (dedupe preživljava restart).

## Iz 2.1

- [ ] NBS adapter u `fxRatesJob` (srednji kurs, baza RSD) — sada skelet koji samo loguje. ECB ne
      objavljuje RSD; dok adapter ne postoji, profil RS ostaje `fx_source = ECB`, a dev ima DEMO kurseve.
- [x] exceljs uklonjen u 2.2: numeričke XLSX ćelije pretvara u JS `number` (float) — iznosi ne smeju
      kroz float (pravilo 18). Zamena: `src/server/imports/xlsx.ts` (zlib + XML tekst, bez paketa).
- [ ] XLSX čitač: šifrovani fajlovi, ZIP64 i više listova se odbijaju; datum kao Excel serijski broj
      se prepoznaje samo u kolonama datuma. Proširiti ako klijent pošalje takav izvoz.
- [ ] Valute sa 0 ili 3 decimale (JPY, KWD): `numeric(18,2)` i `SCALE = 2` u `money.ts` važe za
      sve valute; uvesti minor units po ISO 4217 kad prvi takav klijent bude realan.

## Iz 2.2 – 2.4

- [ ] Retencija `import_runs.payload_enc` za napuštene uvoze (status `uploaded` / `validated` duže
      od N dana) — sada se payload briše tek na kraju, otkazivanju ili obradi.
- [ ] **`import.rollback` kao poseban ključ** u sledećoj migraciji kataloga permisija (+ matrica u
      `docs/permissions.md`, ruta `/api/imports/[id]/rollback`) — do tada ga pokriva `import.create`.
- [ ] Klasifikacija razloga korekcije (`adjustment_reason`) iz Customer 360 / reconciliation ekrana;
      otpis (`write_off`) samo kroz maker-checker (pravilo 11). Contract: ukloniti `payments.kind`.
- [ ] Rollback ne vraća kupce koje je uvoz napravio ni izmene metapodataka (dospeće, reference).
- [ ] Obećanja istog kupca se ocenjuju nezavisno (ista uplata može pokriti više obećanja);
      raspodela uplata po obećanjima kad se pojavi realan slučaj.
- [ ] Ručna uplata ide u izvor `file-import`; poseban izvor „ručni unos" kad stignu bankovni izvodi.
- [ ] `fx_convert()` zaokružuje half-away-from-zero (PostgreSQL `round`), `money.ts` half-even —
      uskladiti pre izveštaja sa pravnim dejstvom.
- [ ] Dashboard/360 računaju „danas" po kompaniji fakture; „Moj rad danas" po podrazumevanoj
      kompaniji — proveriti kad tenant ima kompanije u više zona.

## Iz 2.5 – 3.2

- [x] **Odluka: `mail_outbox.kind`** — prošireno u 017 (3.3), `queue_email` radi do sink-a.
- [x] **Odluka: PDF** — `puppeteer-core` + Debian `chromium` u worker-u (3.3); `export_log`
      ostaje bez `html`, preuzima se samo PDF.
- [x] **Volume za dokumente** u `docker-compose.yml` (3.3, `documents` → `/srv/documents`).
- [ ] Dozvole `workflow.*` i `template.*` u katalogu — sada `settings.read` / `settings.manage`.
- [ ] Praznici u radnim danima (D-7) po `jurisdiction_profiles` — sada samo vikend.
- [ ] Pravne formulacije šablona (opomena pred utuženje) po državi u country profilu (pravilo 17).
- [ ] Rule engine: uslov „politika" po kupcu — ekran za izbor politike kupca (`customers.policy_code`).
- [x] Odluke (decisions) koje predloži pravilo: „Podnesi na odobrenje" + Odobrenja (3.3).

## Iz 3.3

- [ ] **S3 storage adapter** za dokumente (staging/prod); volume `documents` nije u backup-u baze.
- [ ] **Chromium sandbox:** sada `--no-sandbox` unutar kontejnera bez capability-ja. Alternativa
      koja ga vraća bez root-a: poseban seccomp/AppArmor profil za worker (dozvoljava user
      namespaces) — odluka uz security review.
- [ ] PDF za šablone sa slikama/logotipom: renderer blokira svaku mrežu; logo kao data: URI kroz
      belu listu (sada tagovi bez atributa).
- [ ] SMTP (`nodemailer`) — collection mail je u sink-u; dispatcher već šalje `pending` redove.
- [ ] Odobrena odluka iz pravila (npr. opomena pred utuženje fizičkom licu) još ne pokreće slanje —
      sledeći korak posle odobrenja (Sprint 4: akcija „pošalji posle odobrenja").
- [ ] Prilog uz mail (PDF opomene) — `mail_outbox.kind` `document` postoji, slanje priloga ne.
- [ ] `listRuleProposals`: paginacija kad ih bude više od 20 po članu.

## Iz Sprinta 4 (4.1–4.3)

- [ ] Rotacija tajne integracije (nova tajna uz staru, prelazni period) — sada nova integracija.
- [ ] API ključevi: istek (`expires_at`) i ograničenje po IP-u; ključ ne može ništa što traži
      osobu u FK (aktivnost, zahtev za odobrenje) — namerno.
- [ ] Prilozi primljene pošte: sada samo metapodaci u `mail_inbox.attachments`; sadržaj u
      `documents` traži proširenje `documents.kind` i skladište (S3).
- [ ] Retencija `mail_inbox` i `webhook_events` (tela) — politika po tenantu.
- [ ] Više mailbox integracija po tenantu (sada jedna aktivna, unique indeks).
- [ ] CheckPoint adapter kad stigne API referenca; APR/NBS: ugovoreni servis ili uvoz otvorenih
      podataka (docs/integrations/apr.md, nbs.md).
- [ ] Kreditni limit kupca: unos / uvoz kroz maker-checker (`approval.credit_limit`); signal
      izloženosti se do tada ne računa.
- [ ] Ekran za podešavanje pondera i pragova rizika (sada kolone u `tenant_settings`).
- [ ] Domenske sekcije 18–23 (integracije, import, reconciliation, RiskProvider) nisu u repou —
      uneti dokument ili link da sledeće sesije mogu da ga čitaju.

## Roadmap

### Marketing sajt — paralelan tok uz Sprint 1

- Statičan sajt odvojen od aplikacije (sopstveni deploy), `{productName}` iz konfiguracije (pravilo 21), sr-Latn + en.
- Tok: sajt → „Zatraži demo" → lead u Pipedrive → Sinergista ručno kreira tenant (provisioning pod tenantom #0, audit) → pozivnica korisniku (`user.create`).
- Forme po pravilu 27: rate limit po IP-u i email-u, Cloudflare Turnstile, honeypot, bez upload-a fajlova, isti odgovor za postojeći/nepostojeći email.
- Forma ne dira bazu aplikacije: šalje samo u Pipedrive (+ email u sink na demo-u); bez PII u logu (pravilo 20).
- Otvoreno: hosting (Elestio static vs. CDN), analitika uz saglasnost (cookie banner), pravni tekstovi (privatnost, uslovi) iz `docs/legal/`.

### Self-service sign-up — V2 (posle 3–5 klijenata)

- Provisioning servis: tenant + podešavanja + kompanija + `owner` + sistemske role iz matrice — isti put kao seed, sa audit-om pod tenantom #0.
- Billing: plan i `usage_meters` (`src/server/billing`), naplata kroz minimax adapter; cenovnik ne oblikuje domenske tabele (pravilo 36).
- Email verifikacija pre aktivacije tenanta; forme po pravilu 27; anti-abuse (limit tenanta po domenu/IP-u).
- Preduslov: 1.3 login + pozivnice, 1.4 maker-checker, runbook za gašenje i brisanje tenanta (GDPR).

## Funkcije

_(prazno)_
