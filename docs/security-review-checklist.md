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

## Zaštićeni fajlovi (pravilo 13)

- [ ] Diff dira `src/server/auth/*`, `src/server/tenant/*`, `db/migrations/*`, RLS, `docker-compose.yml`, `CODEOWNERS` ili `CLAUDE.md`? → potpis vlasnika.

## Zavisnosti (pravilo 14)

- [ ] Svaki novi paket ima obrazloženje u commit poruci; ≥ 1000 nedeljnih preuzimanja; ažuriran u poslednjih 12 meseci; lockfile ažuran.
