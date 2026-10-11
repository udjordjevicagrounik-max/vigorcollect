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
- [ ] Resource-scoped permisije (otvoreno pitanje u NEXT.md).
- [ ] Maker-checker za izmene `role_permissions` (otvoreno pitanje u NEXT.md).

## Funkcije

_(prazno)_
