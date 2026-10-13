# Security review checklist

Pokreće se pre merge-a u `main`, u **ODVOJENOJ** Claude sesiji koja dobija samo `git diff`.
Svaka stavka: ✅ / ❌ (sa linijom u diff-u) / N/A.

## Tenant izolacija

- [ ] Svaka nova tabela sa `tenant_id NOT NULL` ima `ENABLE ROW LEVEL SECURITY` i politiku (pravilo 1).
- [ ] `tenant_id` se nigde ne čita iz body-ja, query stringa, headera ili URL-a — samo iz `withTenant()` (pravilo 2).
- [ ] Nema upita po `legal_entity_id` bez tenant konteksta (pravilo 30).
- [ ] ID iz URL-a se proverava tenant-scoped upitom (IDOR, pravilo 8).
- [ ] Connection string / DB uloge nisu menjane (pravilo 3).

## Ulaz i upiti

- [ ] Svaki input prolazi Zod šemu pre obrade (pravilo 8).
- [ ] Nema string konkatenacije u SQL-u; `sql.raw()` samo uz odobrenje u zadatku (pravilo 5).
- [ ] Nova ruta ima `requirePermission`, a permisija postoji u `docs/permissions.md` (pravilo 7).

## Podaci

- [ ] Mutacije pišu `audit()`; `audit_log` trigger netaknut (pravilo 6).
- [ ] Kritične akcije idu kroz `approval_requests` (pravilo 11).
- [ ] Export samo kroz `exportService` (pravilo 12).
- [ ] Novac: `numeric(18,2)` + `Money`, iznos uvek sa valutom (pravilo 18).
- [ ] Datumi bez vremena su `date`; trenuci `timestamptz` UTC (pravilo 26).
- [ ] Nova kolona ima `pii_class` u `pii_field_registry`; P1–P3 šifrovane (pravilo 20).
- [ ] Fizička lica: nema automatske odluke sa pravnim dejstvom (pravilo 19).

## Tajne i PII

- [ ] Nema tajni u kodu, logu, testu, commit-u (pravilo 9); gitleaks prošao.
- [ ] Nema PII u logu, Sentry-ju, URL-u, test podacima (pravilo 20).
- [ ] Ništa u `localStorage`/`sessionStorage`; ništa finansijsko u service worker kešu (pravilo 16).

## Javna površina

- [ ] Javne forme/endpointi: rate limit, Turnstile, honeypot, bez enumeracije (pravilo 27).
- [ ] Odgovori greške bez stack trace-a; sadrže `X-Request-Id` (pravila 23, 29).

## AI (ako diff dira `src/server/ai`)

- [ ] Izlaz je `ai_suggestion`, upis kroz iste servise kao ručna akcija (pravilo 22).
- [ ] Nepouzdan ulaz (email, komentar, import) nikad kao instrukcija; alati read-only.

## Tajne po kontejneru i roli (security review 2026-10-13, odeljak E.1)

- [ ] Za svaki servis u `docker-compose.yml`: koje tajne i koje DB role vidi? Nijedan proces koji
      obrađuje nepouzdan ulaz (Chromium, parser uvoza, inbound) ne deli kontejner ni env sa
      BYPASSRLS rolom, `vigor_migrate`-om, `PII_MASTER_KEYS` ili ključem za dešifrovanje backup-a.
- [ ] `vigor_migrate` samo u one-shot servisu `migrate`; ključ za dešifrovanje backup-a samo u
      `restore-test`; renderer samo `RENDER_DATABASE_URL` (`tests/unit/containers.test.ts`).
- [ ] Inventar SECURITY DEFINER funkcija i BYPASSRLS rola: vlasnik, `search_path` (sa `pg_temp`
      na kraju), šta vraća, da li čita objekte koje kontroliše manje privilegovana rola.
- [ ] Backup šifrovan (`age`, javni ključ u worker-u), bez podataka `auth.session` /
      `auth.verification`; off-site bez `--delete`; privatni ključ samo u vault-u.

## Ko sme da postane checker (odeljak E.2)

- [ ] Pozivnica, promena role, imenovanje vođe tima i API ključ šireg obima od `OWN` za
      privilegovane role (owner, admin, cfo, collection_manager i svaka rola sa 🅼 /
      `approval.*`) idu kroz `approval_requests` drugog administratora (bootstrap izuzetak: tačno
      jedan aktivan administrator).
- [ ] Nijedan put ne daje sebi ili drugome dozvolu checker-a bez četiri oka: izmena matrice,
      članstvo u timu (TEAM scope), scope korisnika, API ključ (scope ≤ kreator).
- [ ] MFA se ne može zaobići (`trustDevice`, sesija bez TOTP-a); checker je uvek osoba, nikad
      API ključ; podnosilac ≠ odlučilac i u bazi.

## Spoljni efekti, SSRF i poverenje u proxy (odeljak E.3)

- [ ] Akcija sa spoljnim efektom (mejl, webhook ka n8n-u) se ne ponavlja posle rollback-a: claim
      commit-ovan pre POST-a, POST van transakcije, `Idempotency-Key` stabilan kroz pokušaje,
      `FOR UPDATE SKIP LOCKED` / lease za više worker-a; prijemnik deduplikuje po ključu.
- [ ] Outbound URL koji unosi tenant: provera RAZREŠENOG IP-a (privatni, loopback, link-local,
      CGNAT, IPv4-mapped), bez redirect-a, jedinstven kod greške (nema skenera internih servisa).
- [ ] Klijentski IP samo iz pouzdanog kraja `X-Forwarded-For` (`TRUSTED_PROXY_HOPS`), jedan
      izvor za rate limit, Turnstile i Better Auth (`x-client-ip` koji postavlja proxy).

## Zaštićeni fajlovi (pravilo 13)

- [ ] Diff dira `src/server/auth/*`, `src/server/tenant/*`, `db/migrations/*`, RLS, `docker-compose.yml`, `CODEOWNERS` ili `CLAUDE.md`? → potpis vlasnika.

## Zavisnosti (pravilo 14)

- [ ] Svaki novi paket ima obrazloženje u commit poruci; ≥ 1000 nedeljnih preuzimanja; ažuriran u poslednjih 12 meseci; lockfile ažuran.
