# Performanse (Sprint 6.5)

Cilj: ekrani koje naplatar otvara ceo dan odgovaraju za **< 1 s** (vreme servera) na
**1.000 kupaca / 20.000 faktura**. Merenje je skripta, ne utisak — ponavlja se pre svakog release-a.

```bash
source scripts/lib/env.sh && npx tsx scripts/perf.ts seed      # jednom, ≈ 1 min (collect_test)
source scripts/lib/env.sh && npx tsx scripts/perf.ts measure   # medijana 3 merenja, exit 1 ako > 1 s
```

Samo na bazi čije se ime završava na `_test`. Podaci su generisani (pravilo 24): `PERF-` PIB-ovi,
„Perf Kupac" nazivi, 10 % faktura u EUR, četvrtina delimično plaćena, dospeća od −60 do +370
dana; uvoz kroz pravi put (`applyImport`). Perf tenant je `suspended` (dnevni posao ga ne dira),
a njegovi događaji su zatvoreni (ne pune red workera koji dele e2e i golden testovi).

## Rezultat 13. 10. 2026 (dev server, collect_test)

| ekran                                | pre 6.5  | posle 6.5 |
| ------------------------------------ | -------- | --------- |
| Početna (dashboard, hladan keš)      | 1.541 ms | 794 ms    |
| └ KPI + aging                        | ~850 ms  | 547 ms    |
| └ Potrebna pažnja                    | 449 ms   | 233 ms    |
| Lista kupaca (200)                   | 609 ms   | 604 ms    |
| Lista faktura (500)                  | 172 ms   | 166 ms    |
| Pretraga                             | 6 ms     | 6 ms      |
| Customer 360                         | 6 ms     | 5 ms      |
| Izveštaji (6 sistemskih, najsporiji) | 296 ms   | 292 ms    |

Topao keš dashboarda (5 min po korisniku) vraća izračunate widgete bez upita; pažnja i zadaci se
uvek čitaju sveže.

## Šta je promenjeno

- **Dashboard KPI** (`getDashboard`): zbirovi, aging i top 5 iz **jednog** prolaza kroz
  `invoice_positions` (ranije tri). Skup deo je `fx_convert` po redu, ne nedostajući indeks.
- **Potrebna pažnja** (migracija 031): dospele pozicije se čitaju jednom (CTE) za „bez aktivnosti"
  i „veliki dug". Usput ispravljen **bug**: aktivnosti su se spajale pre grupisanja, pa je dug kupca
  bio pomnožen brojem njegovih aktivnosti (regresioni golden test u `collections.test.ts`).
- **Worker**: domain-event red u paketima od 5 sa pojedinačnim ishodom posla i „burst" dok ima
  posla (ranije jedan događaj na 2 s — e2e uvoz je čekao minutima iza zaostalih događaja).

Novi indeksi nisu bili potrebni: planovi koriste postojeće (`invoices_open_due`,
`activities_customer`, …).

## Kad merenje padne

1. `measure` ispiše koji ekran je `SLOW`.
2. `EXPLAIN (ANALYZE, BUFFERS)` upita tog servisa kao `vigor_app` u kontekstu perf tenanta
   (`set_config('app.tenant_id', '0f0f0000-0000-4000-8000-00000000f0f0', true)`).
3. Indeks ili promena view-a = nova migracija (pravilo 15, zaštićena); `measure` ponovo.
