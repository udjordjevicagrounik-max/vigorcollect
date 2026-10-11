# VigorCollect (radni naziv) - CLAUDE.md

Ovaj fajl čita Claude Code na početku svake sesije. Pravila u sekciji "NON-NEGOTIABLE" nemaju izuzetak.
Ako zadatak zahteva kršenje nekog pravila, STANI i pitaj Uroša — ne improvizuj.

## Projekat

- Multi-tenant B2B SaaS: Receivables Risk & Resolution Platform (Sinergista). "Vigor Collect" je radni naziv projekta; komercijalno ime nije odlučeno.
- Stack: PostgreSQL 16 (Elestio) · Next.js/React (PWA) · Node.js/TypeScript · Drizzle ORM (samo query builder, NE `drizzle-kit push`) · Better Auth · pg-boss + `domain_events` outbox.
- Okruženja: `staging` i `prod` su dve odvojene Elestio instance. Deploy na prod isključivo iz grane `main`.
- Ciljno tržište: SEE odmah, EU od V2 — arhitektura je EU-ready od sprinta 0 (pravilo 25); vreme na tri nivoa zone (pravilo 26).
- Jezik UI: sr-Latn (izvor) + en (default za nove tenante); jezik na tri nivoa: `users.locale`, `tenant_settings.default_locale`, `customers.language`. Jezik koda i komentara: engleski.

## NON-NEGOTIABLE — bezbednost i tenant izolacija

1. **Svaka poslovna tabela ima `tenant_id NOT NULL`** i Row Level Security politiku. Nova tabela bez RLS politike se ne sme kreirati.
2. **`tenant_id` dolazi ISKLJUČIVO iz JWT-a** kroz `withTenant()` middleware koji radi `SET LOCAL app.tenant_id`. Nikad iz body-ja, query stringa, headera ili URL-a.
3. **Aplikacija se konektuje kao DB korisnik `vigor_app`** (bez `BYPASSRLS`, bez `SUPERUSER`). Migracije koristi `vigor_migrate`. Ne menjaj connection string.
4. **Migracije su ručni SQL fajlovi** u `db/migrations/NNN_opis.sql`, primenjuju se kroz `psql`. `drizzle-kit push` je ZABRANJEN — predložio bi brisanje živih tabela.
5. **Nema string konkatenacije u SQL-u.** Samo parametrizovani upiti / Drizzle builder. `sql.raw()` samo uz eksplicitno odobrenje u zadatku.
6. **Svaka mutacija poslovnih podataka piše u `audit_log`** kroz `audit(actor, action, entity, before, after)`. `audit_log` je INSERT-only (trigger blokira UPDATE/DELETE) — ne diraj trigger.
7. **Svaka ruta ima `requirePermission('objekat.akcija')`.** Bez permission provere ruta ne postoji. Matrica permisija je u `docs/permissions.md` — ne izmišljaj nove permisije, dodaj ih u matricu i pitaj.
8. **Svaki input se validira Zod šemom** pre obrade. ID-jevi iz URL-a se uvek proveravaju kroz tenant-scoped upit (zaštita od IDOR).
9. **Tajne (`.env`, OAuth tokeni, API ključevi) se nikad ne upisuju u kod, log, test ili commit.** OAuth tokeni u bazi su šifrovani (`pgcrypto`). Ako vidiš tajnu u diff-u — ukloni je i prijavi.
10. **Ne pisati sopstveni auth.** Koristi konfigurisani identity provider (Keycloak / Better Auth). MFA, sesija (8h), lockout posle 5 neuspešnih pokušaja — ne menjaj bez odobrenja.
11. **Kritične akcije zahtevaju maker-checker** (write-off, promena kreditnog limita, blokada kupca, risk override, predaja pravnoj službi). Implementiraj kroz `approval_requests`, nikad direktnim update-om.
12. **Export podataka ide kroz `exportService`** koji piše `export_log`. Nema ad-hoc CSV download endpointa.
13. **Zaštićeni fajlovi zahtevaju ljudski potpis.** `src/server/auth/*`, `src/server/tenant/*`, `db/migrations/*`, RLS politike, `docker-compose.yml`, `CODEOWNERS`, ovaj fajl — Claude predlaže izmenu i STAJE; Uroš pregleda i commit-uje.
14. **Nema novih zavisnosti bez obrazloženja** u commit poruci (zašto, alternativa, održavanje). Lockfile obavezan; paketi < 1000 nedeljnih preuzimanja ili bez update-a 12 meseci se ne dodaju.
15. **Šema evoluira samo po pravilima:** samo aditivne migracije do go-live-a (bez DROP/RENAME u živoj migraciji); expand → migrate → contract; svaka migracija ima `NNN_up.sql` i `NNN_down.sql`; JSONB nikad za iznose, datume dospeća ni statuse case-a.
16. **Svaki ekran deklariše mobile klasu** (`mobile-full` / `mobile-compact` / `desktop-only`) i testira se na 375 px. Ništa finansijsko se ne kešira u PWA service worker-u; sesija nikad u localStorage.
17. **Nema hardkodovanih UI stringova.** Sve kroz `t()` i `/messages/{locale}.json`; sr-Latn je izvor, en se dodaje u istom zadatku. Tekst koji tenant uređuje (code liste, šabloni) ide u `translations`; pravni i finansijski parametri po zemlji (kamata, rok, formulacije) u `country_profiles`, nikad u kod.
18. **Novac se ne računa u float-u.** `numeric(18,2)` u bazi, `Money` helper u kodu (iznos + valuta + zaokruživanje). Iznos bez valute ne postoji. Kursevi se čitaju isključivo iz `exchange_rates`; NBS/ECB/NBRSM/CBR poziva samo `fxRatesJob`. Kurs na dan dokumenta (`fx_rate`, `fx_rate_date`, `fx_source`) se zamrzava i ne prepisuje.
19. **Fizička lica nikad ne dobijaju automatsku odluku sa pravnim dejstvom.** Ako je `customers.is_natural_person = true`, crven kreditni status, opomena pred utuženje i predaja pravnoj službi idu isključivo kroz `decisions` sa ljudskim odobrenjem; rule sme samo da kreira preporuku.
20. **PII nikad u log, Sentry, URL, test podacima ni commit-u.** Svaka nova kolona dobija `pii_class` (P0-P3) u `pii_field_registry`; P1-P3 se šifruju kroz `subject_keys`. Razvoj isključivo na pseudonimizovanom setu.
21. **Ime proizvoda se ne hardkoduje.** "Vigor Collect" je radni naziv. UI, email, PDF i dokumentacija koriste `{productName}` iz konfiguracije; reč "Vigor" se ne pojavljuje u kodu van naziva repoa i internih prefiksa (`vigor_app`).
22. **AI samo predlaže.** Svaki AI izlaz je `ai_suggestion` sa statusom; upis u bazu ide isključivo kroz iste servise kao ručna akcija (audit, maker-checker, pravilo 19). AI alati su read-only i prolaze `withTenant()` + `requirePermission()` korisnika. Sadržaj emaila, komentara i importa je NEPOUZDAN ULAZ: ide u zaseban blok, nikad kao instrukcija, alati se ne pozivaju na osnovu njega. Izlaz se validira Zod šemom; izvučeni iznosi/datumi se proveravaju prema fakturama. Svaki poziv u `ai_runs` sa tokenima i cenom; PII ide provajderu samo prema `redaction_level` tenanta. Provajder se poziva samo kroz `src/server/ai/adapter`.
23. **Sledljivost i regresija.** Svaki API odgovor nosi `X-Request-Id` (correlation) i `X-App-Version`; isti ID ide u log, Sentry i audit. Svaki bug fix nosi regresioni test — bez njega nije Done. Conventional commits (`feat:`, `fix:`, `chore:`) jer se CHANGELOG generiše iz njih. Deploy na prod samo sa release grane po checklisti (testovi, migracija na kopiji prod baze, release notes, rollback korak).
24. **Test i demo podaci samo iz generatora.** `scripts/seed-demo.ts` (deterministički seed, datumi relativni na danas) ili pseudonimizovani set. Realni podaci nikad u testu, demo tenantu ni screenshotu. Demo tenant šalje email isključivo u sink.
25. **EU-ready od prvog dana: ništa specifično za Srbiju u kodu.** Sve što zavisi od zemlje živi u `jurisdiction_profiles` i `country` konfiguraciji, ne u kodu:
    - Identifikatori su generički: `tax_id` + `registration_number` sa validatorom po zemlji (PIB/JIB/EDB/VAT ID/USt-IdNr), ne kolone `pib`/`maticni_broj`.
    - Kamata, rok plaćanja, fiksna naknada, zastarelost, formulacije IOS-a/opomene — iz profila (EU šablon: Direktiva 2011/7 = referentna stopa ECB + 8 p.p., €40 naknada, 30/60 dana).
    - Kursevi: EUR je bazni par; NBS/NBRSM/CBR su samo izvori u profilu, ECB je podrazumevani.
    - Podrazumevani jezik novog tenanta je `en`; sr-Latn je izvor prevoda, ne default. Novi jezik = novi JSON, bez koda.
    - Datumi, brojevi, valute isključivo kroz Intl API po locale-u; adrese kao struktura (ulica, grad, poštanski broj, zemlja), ne slobodni tekst.
    - Bankovni podaci: IBAN + BIC obavezni formati; SEPA kompatibilno.
    - Rezidentnost: EU region za sve podatke; podobrađivači sa SCC/DPF; DPA i Privacy Center po GDPR-u (ZZPL je podskup).
    - E-fakture: model fakture prati EN 16931 polja (Peppol-ready); SEF je jedan od izvora u profilu RS, ne pretpostavka.
    - Dokumenti: šabloni po jurisdikciji, memorandum i pravni tekst iz konfiguracije; nikad srpski pravni tekst u kodu.
    - Ako zadatak zahteva nešto što važi samo za Srbiju — ide u RS profil ili feature flag, nikad u zajednički kod.
26. **Više vremenskih zona — ništa se ne računa u serverskom vremenu.**
    - Baza čuva sve trenutke kao `timestamptz` u UTC; server radi u UTC (`TZ=UTC` u compose-u); `now()` u kodu je uvek UTC.
    - Datumi bez vremena (dospeće, datum fakture, datum obećanja, datum kursa) su `date` tip — nikad `timestamptz` na ponoć, jer se ponoć pomera sa zonom.
    - Tri nivoa zone, kao i jezik: `users.timezone` (prikaz i podsetnici korisniku), `tenant_settings.timezone` (poslovni dan tenanta, cutoff za aging, rokove i job-ove), `legal_entities.timezone` (kompanija u drugoj zemlji istog tenanta). Kupac nema zonu — komunikacija ide po zoni kompanije koja ga vodi.
    - "Dospelo" se računa u zoni kompanije: faktura je dospela kad prođe kraj dana (23:59:59) datuma dospeća u toj zoni, ne u UTC. Isto za rok obećanja, zastarelost i pre-due podsetnike (D-7 = 7 poslovnih dana u zoni kompanije).
    - Job-ovi (aging, risk snapshot, retention, FX) se zakazuju po zoni tenanta, ne u fiksni UTC sat: "svaki dan u 06:00 lokalno" se rešava u UTC posebno za svaki tenant; prelaz na letnje/zimsko vreme ne sme da udvostruči ni preskoči izvršenje (idempotency ključ = tenant + lokalni datum).
    - FX kurs se vezuje za lokalni datum izvora (NBS objavljuje po Beogradu, ECB po Frankfurtu); `valid_on` je `date`, ne trenutak.
    - Prikaz: svako vreme u UI ide kroz `formatDateTime(value, user.timezone, user.locale)`; sirov ISO string ili `toLocaleString()` bez zone su greška. Ako se zona korisnika razlikuje od zone kompanije, uz vreme se prikazuje skraćenica zone.
    - API prima i vraća ISO 8601 sa ofsetom (`2026-09-05T14:00:00+02:00`); datumi bez vremena kao `YYYY-MM-DD`. Import wizard pita za zonu izvora ako fajl sadrži vreme.
    - Audit, ai_runs i log uvek u UTC; correlation po UTC.
    - Testovi obavezno pokrivaju: prelaz DST, kupac u UTC+1 sa korisnikom u UTC+0, dospeće na 31. decembar, tenant sa dve kompanije u različitim zonama.
27. **Javne forme i javni endpointi su napadna površina.** Website forme (Health Check, kontakt), login, reset lozinke i pozivnica imaju: rate limit po IP-u i po emailu, Cloudflare Turnstile (CAPTCHA), honeypot polje, bez upload-a fajlova na javnim formama. Odgovor na login/reset je isti za postojeći i nepostojeći nalog (bez enumeracije korisnika).
28. **Backup pokriva sve, ne samo bazu.** Noćni `pg_dump` + sync object storage-a (attachmenti, PDF-ovi) + export konfiguracije (`.env` šifrovan u vaultu, ne u backupu) na off-site lokaciju; ista retencija; restore test vraća i fajlove, ne samo tabele.
29. **Svaki ekran ima prazno stanje i tekst za prvi put.** Prazno stanje objašnjava šta je funkcija i koji je sledeći korak (dugme), na sr-Latn i en, kroz `t()`. „Nema podataka" bez sledećeg koraka ne prolazi review. Isto za greške: ljudski tekst + akcija + `X-Request-Id` za support.
30. **Kanonski model stranaka (Network-ready, bez Network-a).** Isto pravno lice se pojavljuje u portfoliju više tenanta — identitet je globalan, finansijski podaci su tenantovi. Nikad ne pretpostavljaj „jedan tenant = sva uključena pravna lica":
    - `legal_entities` = kanonski identitet pravnog lica na nivou platforme: `country_code`, `tax_id`, `registration_number`, normalizovan naziv, `verification_status`, spoljni identifikatori — **bez finansijskih podataka, bez tenant_id**. Isto pravno lice kod dva tenanta = jedan red.
    - `customers` je **TenantPartyRelationship**: `tenant_id` + `legal_entity_id` + `relationship_type` (customer / supplier / both) + tenantovi atributi (prikazno ime, `external_id`, segment, vlasnik, status, kreditni status, jezik). `tenant_companies` su tenantove sopstvene kompanije, takođe preko `legal_entity_id`. Ne praviti zasebne tabele ObservedEntity / ParticipatingEntity — to su stanja veze, ne entiteti.
    - Fakture, uplate, izloženost, case-ovi, obećanja, rizik, komunikacija i dokumenti ostaju **isključivo tenant-owned** (RLS). `legal_entity_id` nikad nije filter kojim se čitaju podaci više tenanta; upit oblika `WHERE legal_entity_id = X` bez tenant konteksta je greška koju golden test hvata.
    - Posmatrano pravno lice (pojavljuje se u uvozu tenanta) nije automatski učesnik mreže, nije „Vigor korisnik" i nema pravo ni na kakvu komunikaciju ili razmenu podataka preko tenanta.
    - Istorija događaja je strateška: `domain_events` čuva faktura kreirana / dospela / kasni, uplata, obećanje kreirano / ispunjeno / prekršeno, spor, eskalacija, rizik signal — bez event-sourcing arhitekture; najjednostavniji robustan model.
    - Settlement i kompenzacija: **u šemi v1 se ne kreiraju settlement tabele** (opportunities, cases, participants, allocations, agreements) ni `obligations` graf — uvode se tek kad postoji validiran zahtev (V2 faza 1, vidi pravilo 31). Šema v1 obezbeđuje samo preduslove: kanonski identitet, eksplicitnu valutu, pouzdan otvoren saldo, jasnu vezu faktura ↔ uplata, resource-scoped permisije, audit i mesto za buduće `access_grants`. Kad se uvede, engine je deterministički (pravilo 22 za AI), pravila kompenzacije žive u `jurisdiction_profiles.settlement_rules`, blokirani račun nije eligible, iznad praga je maker-checker.
31. **Settlement modul je iza feature flag-ova i podrazumevano isključen.** Aktivira se po fazi, po tenantu, bez deploya; kod i tabele faze se dodaju migracijom tek kad faza ulazi u razvoj:
    - Flag-ovi u `feature_flags`: `settlement.bilateral` (faza 1) · `settlement.multilateral_manual` (faza 1) · `settlement.engine` (faza 2) · `settlement.room` (faza 3, eksterni učesnici) · `settlement.partner_desk` (faza 3, liquidity partner) · `settlement.network` (faza 4) · `settlement.marketplace` (faza 5).
    - Dva nivoa: **platformski** flag (Sinergista uključuje fazu globalno; kill switch) i **tenant** flag (Tenant Admin uključuje uz potvrdu pravnog osnova i odabranu jurisdikciju). Tenant flag ne može biti uključen ako je platformski isključen.
    - Preduslovi za uključivanje se proveravaju u kodu: `settlement.engine` traži uvezene obaveze (payables) i `settlement_rules` za sve jurisdikcije tenanta; `settlement.room` traži e-potpis integraciju, `access_grants` i DPA za eksterne učesnike; `settlement.partner_desk` traži `external_parties` zapis tipa FACTOR sa ugovorom; `settlement.network` traži `network_opt_in` + `legal_opinion_ref`.
    - Dok je flag isključen: navigaciona grupa Resolution je skrivena (ne onemogućena), rute vraćaju 404, rule-ovi ne mogu da predlože settlement akciju, `resolution_type` vrednosti kompenzacije ostaju u code listi označene kao `requires_flag`.
    - Uključivanje/isključivanje flag-a piše `audit_log` i `domain_event`; isključivanje ne briše podatke, samo sakriva UI i zaustavlja engine.
    - Redosled uključivanja uvek: tenant #0 (Sinergista) → demo tenant → Agrounik → ostali.
32. **Globalni identitet nikad ne daje pristup finansijskim podacima drugog tenanta.** Prioritet je nepromenljiv: 1. tenant izolacija → 2. eksplicitna autorizacija → 3. saglasnost i svrha → 4. kontrolisano deljenje → 5. mrežna funkcija. Mrežne funkcije se grade **iznad** RLS-a, nikad slabljenjem RLS-a. Ako cross-tenant obrada ikad uđe: zaseban servis sa minimalnim privilegijama, pravnim osnovom, audit-om, granicom izvedenih podataka i testom koji sprečava izlaganje sirovih podataka.
33. **Nema implicitne cross-tenant inteligencije.** Zabranjeno bez posebne odluke, pravnog osnova, pragova agregacije i anonimizacije: „10 drugih Vigor klijenata radi sa ovim kupcem", „prosečno kašnjenje u Vigoru je 34 dana", „ova firma duguje €5M kroz mrežu". Sirovi podaci tenanta i buduća izvedena mrežna inteligencija su odvojeni slojevi: Tenant Raw Facts → odobrena obrada → agregacija → Network Derived Data → kontrolisana potrošnja. Izvedeni podaci su sledljivi, verzionisani, objašnjivi.
34. **Deljenje preko granica tenanta samo kroz `access_grants`.** Jedan model za sve spoljne strane: `external_parties` (tip: LAW_FIRM, BROKER, INSURER, FACTOR, BANK, COLLECTION_AGENCY, OTHER_APPROVED_PARTNER) + `access_grants` (owner tenant, primalac, svrha, obim resursa, permisije, važi od/do, opoziv, odobrio, status). Pristup je eksplicitan, vezan za svrhu, opoziv, vremenski ograničen i auditiran; primalac vidi samo odobreni obim (resource-scoped), nikad celog tenanta. „Strana postoji u Vigoru" nikad ne znači „strana sme da vidi podatke". Audit odgovara na: ko je podelio, kome, šta, zašto, kada, do kada, da li je opozvano, da li je izvezeno. U MVP-u se kreira samo `external_parties` + `access_grants` šema bez UI-ja; prva primena je lawyer/partner pristup u V2.
35. **Spoljni podaci se ne redistribuiraju bez prava.** Za svaki izvor (ERP, CRM, NBS, CheckPoint, banke, API) u `data_sources` se beleže prava: prikaz, skladištenje, retencija, izvedeni podaci, redistribucija, onward-sharing, brisanje po raskidu. Podatak provajdera se ne prikazuje trećoj strani (ni kroz `access_grants`) ako ugovor to ne dozvoljava.
36. **Vigor nikad ne drži novac klijenata i ne obavlja regulisanu delatnost slučajno.** Nema platnih računa, nema izvršenja transfera, nema otkupa potraživanja, nema uloge zajmodavca, osiguravača ili brokera. Buduća regulisana aktivnost traži zasebnu odluku, pravnu i regulatornu analizu, ADR i odobrenje osnivača; arhitektura se integriše sa regulisanim institucijama, ne postaje jedna od njih. Komercijalni model (pretplata, partner workspace, API, transakcione naknade) ostaje odvojen od domenskih tabela — cenovnik nikad ne oblikuje finansijske strukture.
37. **Blind matching, ako ikad dođe: match first, reveal later.** Razdvojiti identifikatore za uparivanje, eligibility, otkrivanje identiteta učesnika, otkrivanje podataka i transakcioni tok. Tenant sme da sazna „postoji mogućnost sa postojećim poslovnim partnerom" — ne koji tenant, koja faktura, kolika izloženost, do saglasnosti svih strana.
38. **Test prihvatljivosti arhitekture.** Pre svake migracije koja dira identitet, vlasništvo faktura/uplata, permisije ili događaje, Claude proverava misaoni eksperiment: 500 tenanta, isto pravno lice u 100 portfolija, neki dele portfolio sa brokerom, šalju potraživanja faktoru, učestvuju u matching-u — da li to ide **bez** spajanja baza, bez uklanjanja RLS-a, bez prepisivanja identiteta kupca ni vlasništva faktura, bez tenant-wide pristupa partnerima, bez klijentske arhitekture. Ako ne — migracija se ne radi, piše se ADR.

## Design tokeni — „Wimbledon" paleta (premium, ali finansijski miran UI)

Tokeni žive u `tailwind.config.ts` i `/src/styles/tokens.css`; boje se nikad ne pišu heksadecimalno u komponentama.

| Token | Vrednost | Upotreba |
|---|---|---|
| `brand-green` | `#006633` | Primarna: navigacija, primarno dugme, naslovi, aktivni tab |
| `brand-green-deep` | `#004D26` | Hover/pressed primarnog dugmeta, header sajta |
| `brand-purple` | `#4E2683` | Sekundarna: linkovi, selekcija, fokus ring, sekundarno dugme, grafikoni (serija 1) |
| `brand-purple-soft` | `#EEE8F5` | Pozadina selektovanog reda, info kartice |
| `brand-gold` | `#C9A227` | **Samo akcenat**: logo, tanka linija ispod naslova sekcije, ikona AI predloga, premium tier badge. Nikad tekst na beloj, nikad status |
| `surface` | `#FFFFFF` | Kartice, tabele |
| `background` | `#F7F8F5` | Pozadina strane (topla, blago zelena) |
| `text` | `#14261C` | Glavni tekst |
| `text-muted` | `#5F6B64` | Sekundarni tekst |
| `border` | `#E3E8E4` | Linije |
| `status-success` | `#1B7F4C` na `#E6F2EC` | Zdravo / plaćeno / ispunjeno — uvek badge sa ikonom i tekstom |
| `status-warning` | `#C2410C` na `#FDECE3` | Žut kreditni status, kašnjenje 31–60, rok blizu |
| `status-danger` | `#B42318` na `#FCE8E6` | Crven status, 90+, prekršeno obećanje, P1 |
| `status-info` | `#4E2683` na `#EEE8F5` | Obaveštenja, AI sažetak |

Pravila:
- 80–90% ekrana je neutralno (surface, background, text); zelena i ljubičasta nose strukturu i akciju; zlatna se pojavljuje na najviše 1–2 mesta po ekranu.
- Zlatna nikad kao boja teksta na svetloj pozadini (kontrast 2,4:1 — pada WCAG); dozvoljena kao linija ≥ 3 px, ikona ili pozadina badge-a sa tamnim tekstom.
- Status boje samo za severity, uvek uz tekst i ikonu; warning je narandžasta (`#C2410C`), ne zlatna — da se ne meša sa brend akcentom.
- Kontrast: zelena i ljubičasta na beloj ≥ 7:1; sav tekst ≥ 4,5:1; proveravati u hook-u (`axe`).
- Tipografija: Inter za aplikaciju (400/500/600); na marketing sajtu naslovi mogu u serifu (npr. Fraunces) radi premium tona — u aplikaciji ne.
- Dark mode nije u MVP-u; tokeni su semantički da bi kasnije bio moguć bez prepravke komponenti.
- Grafikoni: serija 1 ljubičasta, serija 2 zelena, serija 3 siva; nikad crvena/narandžasta za neutralne podatke.

## Definition of Done (svaki zadatak)

- [ ] Funkcionalan UI (ne samo API) sa deklarisanom mobile klasom
- [ ] `domain_events` zapis za svaku mutaciju koja nešto pokreće (rule, notifikacija, email)
- [ ] `requirePermission` na svakoj ruti
- [ ] RLS politika na svakoj novoj tabeli
- [ ] `audit()` na svakoj mutaciji
- [ ] Zod validacija inputa
- [ ] Svi novi stringovi u /messages (sr + en); lint `no-literal-strings` prolazi
- [ ] Prazno stanje + stanje greške sa sledećim korakom (pravilo 29)
- [ ] Error handling (bez `500` sa stack trace-om ka klijentu)
- [ ] Automatski test — minimum: happy path + tenant izolacija
- [ ] `./scripts/verify-tenant.sh` prolazi
- [ ] Ako je ponašanje konfigurabilno — ide u Settings/code list, ne u kod

## Solo sesijski protokol (Uroš radi sam)

- Na startu sesije pročitaj `docs/NEXT.md` (šta je bilo, šta je sledeće, otvorena pitanja) i radi SAMO zadatak koji je tamo označen kao aktivan.
- Prvo plan (tabele, rute, ekrani, testovi) u 10 redova → čekaj "ok". Ako zadatak ne staje u jedan blok od 3 h, predloži podelu PRE početka.
- Testove piši u istoj sesiji kao kod; ne ostavljaj "testovi kasnije".
- Na kraju sesije: commit, ažuriraj `docs/NEXT.md` (urađeno / nije / sledeći korak / rizik), i ako je doneta odluka — `docs/adr/NNNN-naziv.md`.
- Ne predlaži nove funkcije usred zadatka; zapiši ih u `docs/BACKLOG.md`.
- Ako nešto nije jasno, pitaj jedno pitanje — ne pravi pretpostavku o poslovnom pravilu.

## Radni proces

- Pre koda: kratko napiši plan (koje tabele, rute, ekrani) i sačekaj "ok".
- Implementacija ide **UI-first**: prvo klikabilan ekran sa mock podacima, pa logika.
- Jedan zadatak = jedan commit sa opisnom porukom. Nema "wip" commit-a na `main`.
- Posle svake izmene hook pokreće: `npm run lint`, `npm audit --audit-level=high`, `semgrep`, `gitleaks`, `./scripts/verify-tenant.sh`, `./scripts/rls-drift-check.sh`. Ako padne — ne commit-uj, popravi.
- Golden test set (`tests/golden/*`) se nikad ne briše ni ne skip-uje.
- Pre merge-a u `main`: pokreni `docs/security-review-checklist.md` u ODVOJENOJ Claude sesiji koja dobija samo `git diff`.
- Deploy: `docker compose up -d app` (ne `restart` — restart diže stari image).

## Release proces

- Grane: `main` = prod, `develop` = staging, `feature/*`, `hotfix/*` (u `main`, pa backport u `develop`).
- Release voz svake 2 nedelje: ponedeljak cut `release/x.y` → staging → E2E (Playwright, demo tenant) → sreda release notes → četvrtak deploy prod. Nikad petak. Hotfix van ritma samo za P1/P2.
- Migracije samo expand → contract: app se može vratiti na prethodni tag bez vraćanja baze.
- Svaka nova funkcija iza feature flag-a: tenant #0 (Sinergista) → demo → Agrounik → ostali.
- Posle deploya: smoke (`/health`, login, upit po tenantu, FX job, email sync) — automatski.

## Support i bug proces

- Tiket iz helpdeska (FreeScout/Zammad) sa `X-Request-Id` → log/Sentry trag → severity P1–P4 → grana → fix + regresioni test → release ili hotfix.
- P1 (nedostupnost, leak): odgovor 1 h, rešenje 4 h. P2: 4 h / 1 dan. P3: 1 dan / 1 nedelja. P4: 3 dana / backlog.
- Dugme „Prijavi problem" u aplikaciji šalje kontekst (tenant, ekran, verzija, correlation_id, PostHog link) — ne diraj format payload-a bez odobrenja.

## Zabranjeno bez eksplicitnog odobrenja

- Brisanje ili preimenovanje kolona/tabela
- Menjanje RLS politika, DB korisnika ili connection stringa
- Dodavanje npm paketa sa < 1000 nedeljnih preuzimanja ili bez održavanja u poslednjih 12 meseci
- Isključivanje testova ili lint pravila da bi build prošao
- Rad direktno na prod bazi

## Struktura

```
/src/app            Next.js ekrani
/src/server         API rute, servisi
/src/server/auth    withTenant, requirePermission, audit
/src/db/schema      Drizzle šeme (read-only reference; istina je u SQL migracijama)
/db/migrations      NNN_opis.sql
/scripts            verify-tenant.sh, rls-drift-check.sh, backup.sh, seed-demo.ts
/src/server/billing usage_meters, invoice_runs, minimax adapter (tenant #0 = Sinergista)
/tests/e2e          Playwright, 6 tokova, radi na demo tenantu
/tests/golden       30 fiksnih testova (tenant, permisije, audit, IDOR)
/messages           sr-Latn.json (izvor), en.json
/src/server/fx      Money helper, fxRatesJob (NBS, ECB, NBRSM, CBR, BAM peg)
/src/server/ai      adapter (anthropic, openai), prompts/ (verzionisani), tools/ (read-only), redaction
/src/server/settlement  V2 — ne postoji u MVP-u (pravilo 30); pri uvođenju: graf model, deterministički engine, rules iz jurisdiction_profiles
/src/server/sharing     external_parties, access_grants, resource-scoped autorizacija (šema od S0, UI u V2)
/docs               NEXT.md (aktivan zadatak + beleška za sledeću sesiju), BACKLOG.md, permissions.md, security-review-checklist.md, schema-v1.md, adr/, legal/, runbook.md
```
