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
- [ ] Popuniti `permissions` iz `docs/permissions.md` (migracija) — preduslov za grantove i `requirePermission`.
- [ ] Seed: code liste (`customer_segment`), prevodi naziva uloga, demo partner + grant (kad prvi ekran zatraži).
- [ ] Job koji označava istekle `approval_requests` (`expired`) i obaveštava o grantovima pred istek.

## Funkcije

_(prazno)_
