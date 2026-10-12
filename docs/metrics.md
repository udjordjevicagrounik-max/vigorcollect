# Metrike — definicije (Sprint 2)

Jedan izvor istine za svaku brojku na dashboard-u, u listi kupaca i u Customer 360. Tooltip na
ekranu (`dashboard.kpi.*.definition` u `messages/*.json`) je skraćena verzija ovog teksta; kad se
definicija menja, menjaju se oba u istom commit-u.

## Zajednička pravila

- **Iznosi** su `numeric(18,2)` sa valutom (pravilo 18); nijedan zbir ne prolazi kroz float.
- **Izveštajna valuta** = `tenant_settings.default_currency`. Iznos u drugoj valuti se preračunava
  funkcijom `fx_convert()` (migracija 014): poslednji referentni kurs na dan ili pre dana, prednost
  ima izvor iz jurisdikcionog profila tenanta; zaokruživanje na 2 decimale. **Bez kursa iznos se ne
  računa u zbir** i broji se kao „nedostaje kurs" (prikazuje se uz KPI) — nikad se ne pogađa.
- **Danas** = lokalni datum kompanije koja je izdala fakturu (`legal_entities.timezone` kompanije,
  pravilo 26), ne datum servera.
- **Otvorena faktura**: `amount_open > 0` i status nije `credited` / `cancelled`. `amount_open` se
  uvek izvodi iz alokacija uplata (migracija 012), nikad se ne upisuje ručno.
- **Dospela (overdue)**: otvorena faktura čiji je kraj dana dospeća prošao u zoni kompanije, tj.
  `due_date < danas`. Na sam dan dospeća faktura još nije dospela.
- **Dana kašnjenja** = `danas − due_date` (najmanje 0).
- **Scope**: svaka brojka je ograničena na kupce koje korisnik vidi (OWN / TEAM / ORGANIZATION,
  `scopeFilter()`); fakture, uplate, obećanja, aktivnosti i case-ovi prate svog kupca.

## Dashboard

| KPI                                        | Definicija                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dospelo ukupno** (`overdue_total`)       | Zbir otvorenih iznosa dospelih faktura, u izveštajnoj valuti.                                                                                                                                                                                                                                                               |
| **Otvoreno ukupno** (`open_total`)         | Zbir otvorenih iznosa svih otvorenih faktura (dospelih i nedospelih).                                                                                                                                                                                                                                                       |
| **DSO** (`dso`)                            | Otvoreno ukupno ÷ prosečan dnevni fakturisani iznos poslednjih N dana, gde je N = `tenant_settings.dso_window_days` (podrazumevano 90). Prosečan dnevni iznos = zbir `amount_total` faktura izdatih u poslednjih N dana (bez `cancelled`) ÷ N. Zaokruženo na 0,1 dan. Bez fakturisanja u prozoru DSO se ne prikazuje („—"). |
| **Obećanja danas** (`promises_today`)      | Broj i zbir obećanja u statusu `pending` čiji je datum obećanja danas (u zoni kompanije obećanja).                                                                                                                                                                                                                          |
| **Prekršena obećanja** (`promises_broken`) | Broj obećanja u statusu `broken` čiji je datum obećanja u poslednjih 30 dana. Obećanje postaje prekršeno dan posle datuma obećanja (D+`promise_grace_days`, podrazumevano D+1) ako do tada nije uplaćeno ≥ obećanog iznosa (dnevni posao, 2.4).                                                                             |
| **Otvoreni case-ovi** (`open_cases`)       | Broj case-ova naplate u statusu `open`.                                                                                                                                                                                                                                                                                     |
| **Aging raspodela**                        | Otvoreni iznosi po bucket-ima iz `aging_bucket_bounds` (code lista `aging_bucket`, po tenantu): Nije dospelo (0), 1–30, 31–60, 61–90, 91–180, preko 180 dana kašnjenja.                                                                                                                                                     |
| **Moj rad danas**                          | Obećanja koja dospevaju danas ili ranije a još su `pending`, sledeće akcije iz aktivnosti sa datumom danas ili ranije (samo poslednja aktivnost kupca), otvoreni case-ovi — za moje kupce (OWN) ili kupce mog tima (TEAM, samo ako grant dozvoljava TEAM ili širi).                                                         |

## Lista kupaca i Customer 360

| Kolona             | Definicija                                                 |
| ------------------ | ---------------------------------------------------------- |
| **Izloženost**     | Otvoreno ukupno za kupca (izveštajna valuta).              |
| **Dospelo**        | Dospelo ukupno za kupca.                                   |
| **Najstarije**     | Najveći broj dana kašnjenja među dospelim fakturama kupca. |
| **Status**         | `customers.status` (aktivan / neaktivan / blokiran).       |
| **Vlasnik**        | Korisnik odgovoran za kupca (`owner_user_id`).             |
| **Aging po kupcu** | Kao aging raspodela, samo za fakture kupca.                |

## Uvoz (2.2)

| Brojka                               | Definicija                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Ispravno / sa greškom**            | Redovi koji su prošli / nisu prošli Zod validaciju; red sa greškom se preskače.                                                                                    |
| **Novih / ažuriranih / bez promene** | Po (izvor, `external_id`): nova faktura; postojeća sa nižim saldom ili promenjenim datumom dospeća / referencama; postojeća bez razlike.                           |
| **Za odluku**                        | Reconciliation exception: promena iznosa, valute ili kupca, viši saldo nego ranije, bilo kakva promena plaćene fakture, ili rollback koji nije mogao da se izvrši. |
