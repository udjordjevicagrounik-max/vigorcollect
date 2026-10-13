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
- **Uplata vs. korekcija** (migracija 015): `payments.payment_kind` = `payment` (novac primljen od
  kupca) ili `adjustment` (dug smanjen bez novca: knjižno odobrenje, otpis, ispravka u izvoru,
  nepoznat razlog — code lista `adjustment_reason`). Kad izvor u uvozu javi niži saldo, nastaje
  korekcija sa razlogom `unknown`. **Korekcija nikad nije naplata**: ne ulazi u „Naplaćeno",
  stopu naplate ni DSO; smanjuje otvoreni iznos fakture (dug više ne postoji).
- **Scope**: svaka brojka je ograničena na kupce koje korisnik vidi (OWN / TEAM / ORGANIZATION,
  `scopeFilter()`); fakture, uplate, obećanja, aktivnosti i case-ovi prate svog kupca.

## Dashboard

| KPI                                        | Definicija                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dospelo ukupno** (`overdue_total`)       | Zbir otvorenih iznosa dospelih faktura, u izveštajnoj valuti.                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Otvoreno ukupno** (`open_total`)         | Zbir otvorenih iznosa svih otvorenih faktura (dospelih i nedospelih).                                                                                                                                                                                                                                                                                                                                                                                                      |
| **DSO** (`dso`)                            | (Otvoreno ukupno + iznosi zatvoreni korekcijama na tim fakturama) ÷ prosečan dnevni fakturisani iznos poslednjih N dana, gde je N = `tenant_settings.dso_window_days` (podrazumevano 90). Korekcije se vraćaju u brojilac jer nisu naplata; fakture `credited` / `cancelled` ne ulaze. Prosečan dnevni iznos = zbir `amount_total` faktura izdatih u poslednjih N dana (bez `cancelled`) ÷ N. Zaokruženo na 0,1 dan. Bez fakturisanja u prozoru DSO se ne prikazuje („—"). |
| **Obećanja danas** (`promises_today`)      | Broj i zbir obećanja u statusu `pending` čiji je datum obećanja danas (u zoni kompanije obećanja).                                                                                                                                                                                                                                                                                                                                                                         |
| **Prekršena obećanja** (`promises_broken`) | Broj obećanja u statusu `broken` čiji je datum obećanja u poslednjih 30 dana. Obećanje postaje prekršeno dan posle datuma obećanja (D+`promise_grace_days`, podrazumevano D+1) ako do tada nije uplaćeno ≥ obećanog iznosa (dnevni posao, 2.4).                                                                                                                                                                                                                            |
| **Otvoreni case-ovi** (`open_cases`)       | Broj case-ova naplate u statusu `open`.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Aging raspodela**                        | Otvoreni iznosi po bucket-ima iz `aging_bucket_bounds` (code lista `aging_bucket`, po tenantu): Nije dospelo (0), 1–30, 31–60, 61–90, 91–180, preko 180 dana kašnjenja.                                                                                                                                                                                                                                                                                                    |
| **Moj rad danas**                          | Obećanja koja dospevaju danas ili ranije a još su `pending`, sledeće akcije iz aktivnosti sa datumom danas ili ranije (samo poslednja aktivnost kupca), otvoreni case-ovi — za moje kupce (OWN) ili kupce mog tima (TEAM, samo ako grant dozvoljava TEAM ili širi).                                                                                                                                                                                                        |

## Zahteva pažnju (3.2)

Jedan spisak (dashboard), svaka stavka sa sledećim korakom. Stavke o kupcima su u view-u
`attention_customer_items` i ograničene scope-om; ostale važe za prijavljenog člana.

| Stavka                     | Definicija                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Prekršeno obećanje**     | Obećanje `broken`, ocenjeno u poslednjih 30 dana, posle kog kupac nije dao novo obećanje (pending / fulfilled).                        |
| **Nema aktivnosti**        | Kupac sa dospelim dugom bez ijedne aktivnosti poslednjih N dana; N = `tenant_settings.attention_no_activity_days` (podrazumevano 14).  |
| **Velika dospela faktura** | Dospela faktura sa otvorenim iznosom ≥ `tenant_settings.attention_large_overdue`; kad prag nije podešen — 5 najvećih dospelih faktura. |
| **Case bez vlasnika**      | Otvoren case bez `owner_user_id`.                                                                                                      |
| **Odobrenje čeka vas**     | Zahtev na čekanju čiju vrstu smete da odlučite, a niste ga podneli (četiri oka).                                                       |
| **Zadatak za danas**       | Vaš otvoren zadatak (iz pravila) sa rokom danas ili ranije (zona tenanta).                                                             |
| **Obaveštenje**            | Nepročitano obaveštenje iz pravila.                                                                                                    |
| **Pravilo nije uspelo**    | Run pravila u statusu `failed` u poslednjih 7 dana (uz `settings.read`).                                                               |
| **Uvoz traži odluku**      | Uvoz sa otvorenim reconciliation exception-ima (uz `import.read`).                                                                     |

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

## Izveštaji (5.2)

Šest osnovnih izveštaja (`src/server/reports/service.ts`), ekran Izveštaji i izvoz (CSV / XLSX)
koriste isti rezultat. Sve u izveštajnoj valuti, ograničeno scope-om korisnika (pravila gore).
Filtri: period od–do (podrazumevano poslednjih 90 dana, zona tenanta), „samo moji kupci", tim.

| Izveštaj                           | Dimenzija             | Mere                                                                                        |
| ---------------------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| **Aging po kupcu**                 | kupac (vlasnik)       | otvoreno po aging razredu, otvoreno ukupno, dospelo, sporno; kupci bez otvorenih faktura ne |
| **Aging po naplataru / timu**      | vlasnik kupca ili tim | otvoreno po aging razredu, otvoreno ukupno, broj kupaca sa otvorenim fakturama              |
| **Naplaćeno po periodu**           | dan / nedelja / mesec | zbir uplata (`payment_kind = payment`, korekcije nikad), preračunat na dan uplate; broj     |
| **Obećanja (ispunjena/prekršena)** | status                | broj, obećani iznos, plaćeni iznos — obećanja čiji je datum u periodu, bez `cancelled`      |
| **Case-ovi po fazi**               | faza (`case_stage`)   | broj otvorenih case-ova, otvoren iznos njihovih faktura, prosečna starost (dana)            |
| **Sporovi**                        | razlog × status       | broj sporova otvorenih u periodu, otvoren iznos spornih faktura, prosečno dana otvoreno     |

**Izvoz** (pravilo 12): do 5.000 redova odmah, iznad — posao u worker-u (`export_files`, šifrovano,
važi 7 dana), najviše 100.000 redova. Svako preuzimanje upisuje `export_log` (ko, šta, filteri,
broj redova, sha256). Iznosi u CSV-u i XLSX-u su decimalni string iz baze (bez float-a).

## Digest (5.2)

- **Moj dan** (dnevno, 07:00 po zoni korisnika): stavke pažnje (bez zadataka), obećanja `pending`
  sa datumom danas ili ranije, zadaci za danas, nova pošta kupaca (`mail_inbox.status = new`) —
  sve u scope-u korisnika. Bez ijedne stavke mail se ne šalje.
- **Nedeljni menadžerski pregled** (ponedeljak 07:00, samo uz `report.read`): dospelo sada,
  naplaćeno poslednjih 30 dana, prekršena obećanja (30 dana), top 5 kupaca po dospelom.
