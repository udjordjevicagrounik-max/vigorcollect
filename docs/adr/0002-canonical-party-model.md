# 0002 — Kanonski model stranaka, tenant osnova i governance (Schema v1, 0.2a)

- **Status:** predloženo (migracija 001 čeka potpis — pravilo 13)
- **Datum:** 2026-10-11
- **Donosilac:** Uroš
- **Povezano:** zadatak 0.2a; pravila 1, 2, 3, 6, 17, 20, 25, 26, 30–34, 38; ADR 0001

## Kontekst

Isto pravno lice se pojavljuje u portfoliju više tenanta (pravilo 30), a finansijski podaci su
uvek tenantovi. Šema v1 mora da postavi identitet, tenant izolaciju i governance tako da kasnije
faze (customers, fakture, access_grants, settlement) budu aditivne (pravilo 15).

## Odluka

1. **`legal_entities` je globalni kanonski identitet** (bez `tenant_id`, bez finansijskih
   podataka), jedinstven po `(country_code, tax_id)`. Tenant vezu nose `tenant_companies` (sada) i
   `customers` (0.2b). Upis isključivo kroz platformski servis; app ga ne može upisati.
2. **Vidljivost `legal_entities` je izvedena iz veze**, ne globalna: `vigor_app` vidi red samo ako
   je povezan sa trenutnim tenantom. Bez tenant konteksta — ništa. Time globalni identitet ne
   postaje kanal za cross-tenant inteligenciju (pravila 32, 33).
3. **ENABLE + FORCE RLS na svakoj tabeli.** Vlasnik `vigor_migrate` je podložan RLS-u; tenant
   politike važe za sve role; platformske tabele imaju eksplicitnu `migrate_all` politiku.
4. **`app_tenant_id()` sa `missing_ok`** — upit bez `SET LOCAL app.tenant_id` vraća 0 redova,
   nikad grešku koja bi mogla da se „zaobiđe" fallback-om u kodu.
5. **Kompozitni FK `(tenant_id, id)`** između tenant tabela — baza sama odbija vezu na red drugog tenanta.
6. **Feature flagovi na dva nivoa = dve tabele**: `platform_feature_flags` (platformska, kill
   switch) i `feature_flags` (tenant, `tenant_id NOT NULL`). Trigger odbija tenant `enabled` dok je
   platformski isključen; settlement flag traži `legal_basis_confirmed_at` + jurisdikciju.
7. **Platformske akcije se audituju pod tenantom #0** (`tenants.is_platform_operator`, tačno
   jedan). `audit_log.tenant_id` i `domain_events.tenant_id` ostaju `NOT NULL`.
8. **`permissions` je platformski katalog**, uloge i dodele su tenantove.
9. **`jurisdiction_profiles` = `country_profiles`** iz pravila 17 — jedan entitet, jedno ime
   (`jurisdiction_profiles`, kako ga koriste pravila 25 i 30). Pravila koja pominju
   `country_profiles` čitati kao `jurisdiction_profiles`; CLAUDE.md menja samo Uroš.
10. **`pii_field_registry` pokriva svaku kolonu** (P0 eksplicitno), sa `conditional_on` /
    `conditional_pii_class` za identitet koji postaje lični podatak kad je lice fizičko.

## Razmotrene alternative

| Alternativa                                                 | Zašto ne                                                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `legal_entities` po tenantu (`tenant_id` u identitetu)      | duplira identitet; Network/matching kasnije traži spajanje redova = prepisivanje identiteta (pravilo 38 pada)   |
| `legal_entities` čitljiv svima (SELECT `true`)              | tenant bi mogao da izlista pravna lica iz tuđih portfolija — implicitna cross-tenant inteligencija (pravilo 33) |
| `feature_flags` sa nullable `tenant_id` za platformski nivo | krši „tenant tabela = `tenant_id NOT NULL`" i komplikuje RLS (`OR tenant_id IS NULL`)                           |
| `audit_log.tenant_id` nullable za platformske akcije        | platformski trag bi bio van RLS modela; tenant #0 daje isti model za sve                                        |
| ENABLE bez FORCE                                            | vlasnik tabela (migracije, seed, budući jobovi kao `vigor_migrate`) bi tiho zaobilazio RLS                      |

## Test prihvatljivosti (pravilo 38)

Zamislimo 500 tenanta i isto pravno lice u 100 portfolija: to je **jedan** red u `legal_entities`
i 100 tenant-owned veza (`customers`, 0.2b), dok su fakture, uplate i rizik isključivo pod RLS-om
svakog tenanta — ništa se ne spaja, identitet kupca se ne prepisuje, vlasništvo faktura ostaje
tenantovo. Tenant koji deli portfolio sa brokerom ili šalje potraživanja faktoru to radi kroz
`external_parties` + `access_grants` (0.2b) nad konkretnim resursima, nikad tenant-wide i nikad
slabljenjem RLS-a; matching (V2+) radi nad kanonskim identitetom bez otkrivanja drugog tenanta
(pravilo 37), a vidljivost `legal_entities` izvedena iz veze garantuje da ni sam identitet ne
odaje ko još radi sa tim licem. Sve tri faze se dodaju aditivno, bez spajanja baza i bez
klijentske arhitekture — **test prolazi**.

## Posledice

- **Pozitivne:** izolacija je u bazi (RLS + FORCE + kompozitni FK + grants), ne samo u kodu;
  golden testovi na `collect_test` dokazuju svaki sloj.
- **Negativne / rizici:** svaki job koji radi preko tenanta mora imati eksplicitnu rolu i politiku
  (vidi „Otvoreno"); `legal_entities` politika se proširuje u 0.2b (`customers`), što je izmena
  RLS politike → potpis.
- **Ne menjati bez novog ADR-a:** FORCE na svim tabelama, globalni `legal_entities` bez
  finansijskih podataka, vidljivost izvedena iz veze, tenant #0 za platformski audit.

## Otvoreno

1. **Login pre tenant konteksta (zadatak 1.3).** Pre prijave tenant nije poznat, a FORCE RLS
   sakriva `users`. **Pravac:** Better Auth tabele (user, session, account, verification) žive u
   zasebnoj šemi `auth` **bez tenant RLS-a** (globalni identitet osobe); `users.auth_user_id` je
   most ka članstvu. Posle prijave aplikacija bira tenant među članstvima i tek tada radi
   `SET LOCAL app.tenant_id` kroz `withTenant()`.
2. **Outbox dispatcher (zadatak 1.5).** Dispatcher čita `domain_events` svih tenanta, a FORCE RLS
   to (ispravno) blokira. **Pravac:** zasebna rola `vigor_worker` sa eksplicitnom politikom
   **samo na `domain_events`** (SELECT/UPDATE statusnih kolona), bez pristupa ostalim tabelama i
   **nikad `BYPASSRLS`**. Obrada svakog događaja ide u `withTenant(event.tenant_id)` kao `vigor_app`.
