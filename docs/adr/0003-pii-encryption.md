# 0003 — Šifrovanje PII: subject_keys, envelope, blind index po tenantu

- **Status:** prihvaćeno
- **Datum:** 2026-10-12
- **Donosilac:** Uroš
- **Povezano:** 0.2b; pravila 9, 20, 28, 33; ADR 0002; migracija `002_customers_subject_keys`

## Kontekst

Prema pravilu 20, kolone P1–P3 se šifruju kroz `subject_keys`. Treba odlučiti tri stvari: gde
se šifruje, kako se brisanje subjekta svodi na uništavanje ključa (crypto-shredding) i kako se
traži tačan email bez čuvanja čistog teksta. Pri tome ništa ne sme da poveže dva tenanta
(pravilo 33).

## Odluka

**Šifruje se u aplikaciji (`src/server/crypto`, samo `node:crypto`, bez novih paketa). Svaki
subjekt ima svoj ključ podataka, a taj ključ je šifrovan glavnim ključem iz okruženja.**

1. **Hijerarhija ključeva.** `PII_MASTER_KEYS` (KEK, 32 bajta, verzionisan) postoji samo u
   okruženju i vault-u. `subject_keys` čuva nasumični ključ podataka (DEK, 32 bajta) po subjektu
   (`customer` = fizičko lice, `customer_contact`), šifrovan KEK-om (AES-256-GCM). AAD sadrži
   tenant, subjekt, svrhu i verziju ključa. Baza nikad ne vidi čist tekst ni ključ, zato
   `pgcrypto` ovde ne koristimo (pravilo 9 važi za OAuth tokene).
2. **Envelope polja.** Format: `[0x01][iv 12][tag 16][ciphertext]`. AAD je
   `tenant | tabela.kolona | id reda | key_version`, pa šifrat prekopiran u drugi red, kolonu ili
   tenant ne može da se dešifruje (golden test).
3. **`key_version` stoji uz svako šifrovano polje:** `<polje>_enc` + `<polje>_key_version` (CHECK
   da su postavljeni zajedno). Golden test zahteva da svaka `*_enc` kolona ima svoj
   `*_key_version` i da je u registru `encrypted=true`.
4. **Blind index je HMAC-SHA256 sa ključem TENANTA, nikad globalnim.** Ključ je red u
   `subject_keys` (`subject_type='tenant'`, `purpose='blind_index'`, CHECK `subject_id =
tenant_id`). Isti email u dva tenanta daje dva različita indeksa (golden test). U HMAC ulazi i
   naziv polja (domain separation); email se normalizuje (NFC, trim, lowercase). Uz indeks se čuva
   `<polje>_bidx_key_version`. Pretraga je samo tačno poklapanje i nikad ne kreira ključ.
5. **Brisanje subjekta = crypto-shredding.** `subject_keys.status='destroyed'` i
   `wrapped_key=NULL` (CHECK). Posle toga su sva polja subjekta nečitljiva, uključujući kopije u
   backup-u baze. Implementacija je u erasure toku (kasniji zadatak); u 0.2b app ima nad
   `subject_keys` samo INSERT i SELECT.
6. **`users.email` i `users.display_name` se NE šifruju** (P1, `exception_reason = 'auth
identity'`). Better Auth (1.3) iste vrednosti drži u čistom tekstu u šemi `auth` za
   login, MFA i reset, pa bi šifrovana kopija u `users` samo dodala složenost, a zaštite ne bi
   bilo.
7. **Izuzeci su eksplicitni.** `pii_field_registry.exception_reason` je obavezan za svaku P1–P3
   kolonu koja nije `encrypted` (golden test). Kontejneri (`audit_log.before/after`,
   `domain_events.payload`) smeju da nose samo id-jeve, P0 vrednosti ili šifrat;
   `domain_events.last_error` sme da nosi samo kodove grešaka. Slobodne beleške
   (`approval_requests.decision_note`, `decisions.rationale`, `access_grants.revoke_reason`,
   0.2c) nemaju subjekta za ključ: P1 sa `exception_reason`, a UI traži razlog bez ličnih
   podataka.
8. **Fizičko lice kao kupac:** `customers.display_name` je NULL, a ime je samo u
   `display_name_enc` (CHECK `customers_name_protection`).

## Rotacija

- **Glavni ključ (KEK):** dodati `N+1:<ključ>` u `PII_MASTER_KEYS`; novi ključevi podataka se
  odmah šifruju verzijom N+1. **Re-wrap job** (kasnije) ponovo šifruje `wrapped_key` svih
  `subject_keys` sa `master_key_version < N+1` (podaci se ne diraju; AAD ne sadrži verziju
  KEK-a). Stara verzija se uklanja iz okruženja tek kad job prijavi 0 preostalih redova.
- **Ključ podataka (DEK):** **re-encrypt job** (kasnije) upisuje verziju n+1 (`active`), staru
  označava kao `retired`, ponovo šifruje polja subjekta i ažurira `<polje>_key_version`. Čitanje
  uvek koristi verziju zapisanu uz polje, pa su obe verzije čitljive tokom prelaza.
- **Blind index ključ tenanta:** isto, uz ponovno računanje `<polje>_bidx`. Dok job traje,
  pretraga nalazi samo redove sa aktivnom verzijom; job zato radi u prozoru održavanja tenanta.

## Master ključ van backup-a (pravilo 28)

`PII_MASTER_KEYS` nikad nije u bazi, u `pg_dump`-u, u object storage-u, u logu ni u commit-u.
Čuva se šifrovano u vault-u, odvojeno od backup-a baze. Restore baze bez ključa daje nečitljiv
PII, i to je namerno. Restore test (1.6) zato mora da vrati i ključ iz vault-a. Gubitak ključa
znači trajni gubitak svih P1–P3 podataka, pa ključ ima najmanje dve nezavisne kopije u vault-u.
Generisanje i pravila rukovanja (provera samo `grep -c`, dev ključ potrošan, staging/prod van
Claude sesije): `docs/runbook.md` → „PII master ključ".

## Razmotrene alternative

| Alternativa                        | Zašto ne                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pgcrypto` u bazi                  | ključ bi išao kroz SQL (`pg_stat_statements`, log); RLS ne štiti od DBA; teže je odvojiti ključ od backup-a |
| Jedan ključ po tenantu za podatke  | crypto-shredding jedne osobe ne bi bio moguć bez ponovnog šifrovanja celog tenanta                          |
| Globalni HMAC ključ za blind index | isti email bi u dva tenanta dao isti indeks → implicitna cross-tenant veza (pravilo 33)                     |
| Verzija ključa samo unutar šifrata | rotacioni job ne bi mogao da nađe zastarele redove SQL upitom; tražena je kolona uz svako polje             |
| KMS (cloud) odmah                  | nema ga u Elestio okruženju; interfejs `MasterKeyring` dozvoljava kasniju zamenu bez promene šeme           |
| Šifrovati `users.email`            | Better Auth svakako drži čist email u šemi `auth` (odluka 6)                                                |

## Posledice

- **Pozitivne:** crypto-shredding po osobi; dump baze bez ključa ne otkriva P1–P3; nema
  cross-tenant korelacije preko indeksa; svaki izuzetak je dokumentovan i proveren testom.
- **Negativne / rizici:** nema LIKE ni fuzzy pretrage po šifrovanim poljima (samo tačan email);
  sortiranje po imenu fizičkog lica radi se u aplikaciji; gubitak `PII_MASTER_KEYS` je
  nepovratan; `docker-compose.yml` (zaštićen) mora da prosledi `PII_MASTER_KEYS` app-u pre
  prve rute koja čita kontakte (1.x).
- **Šta sledeća sesija NE sme da menja bez novog ADR-a:** format envelope-a i AAD, ključ blind
  indexa po tenantu, par `<polje>_enc` + `<polje>_key_version`, `exception_reason` za `users`.

## Test prihvatljivosti (pravilo 38)

Kad je isto pravno lice u 100 portfolija, svaki tenant ima svoj `customers` red, svoje kontakte
sa svojim ključevima i svoj blind index. Ništa se ne spaja preko tenanta, a broker ili faktor
kroz `access_grants` (0.2c) dobija dešifrovan podatak samo kroz servis koji poštuje grant i
`data_sources` prava. Prolazi bez spajanja baza i bez slabljenja RLS-a.

## Odlučeno posle 0.2b

- **Fizičko lice u `legal_entities`** — ADR 0002, odluka 4: preduzetnik ostaje u
  `legal_entities` uz `exception_reason`; potrošač nikad ne ulazi, a njegov identitet postoji
  samo šifrovano na `customers` (migracija 003).

## Privremeno: ključ za `mail_outbox` (Uroš, 2026-10-12, posle 1.1b)

`mail_outbox.recipient_enc` / `body_enc` koriste ključ **izveden** iz master ključa (HKDF-SHA256
po tenantu, `src/server/mail/crypto.ts`), ne ključ iz `subject_keys` — CHECK
`subject_keys_purpose_subject` ne dozvoljava `tenant` + `data`. Ovo je **privremeno**:

- posle go-live ujediniti sa `subject_keys` po obrascu expand → contract (nova kolona/ključ,
  dvojno čitanje, re-encrypt job, tek onda uklanjanje starog puta — nikad DROP pre toga);
- **rotacija master ključa mora pokriti oba puta**: re-wrap `subject_keys` **i** ponovno šifrovanje
  živih `mail_outbox` redova (ili sačekati 7 dana retencije pre povlačenja stare verzije).

## Zamena CHECK-a: `mail_outbox.kind` (Uroš, 2026-10-13, zadatak 3.3)

Migracija 017 menja CHECK `mail_outbox_kind_check` (DROP + ADD istog imena) da bi `mail_outbox`
primio poruke naplate: `reminder`, `dunning`, `statement`, `document` uz postojeće `invitation` i
`password_reset`. **Zamena CHECK-a je dozvoljena pod pravilom 15** jer:

- novi skup vrednosti je nadskup starog — nijedan postojeći red ne postaje neispravan, podaci se
  ne menjaju i ne brišu;
- nije DROP/RENAME kolone ni tabele; ime constraint-a ostaje isto (down vraća stari CHECK kao
  `NOT VALID`, jer redovi naplate pod FORCE RLS ne mogu da se obrišu iz migracije).

Poruke naplate koriste isti ključ izveden po tenantu (HKDF `mail_outbox`) kao i auth poruke;
telo je `{subject, text, html}` šifrovano, primalac šifrovan. Novi stubovi `customer_id`,
`template_id`, `source_run_id` su samo id-jevi (P0). Pravilo 24 važi i dalje: demo tenant šalje
samo u sink (trigger iz 006/007).

## Sprint 4 (2026-10-13): još zamena CHECK-a po istom obrascu

Po istom pravilu (nadskup / ublažavanje, isto ime constraint-a, bez izmene redova, down vraća
staro kao `NOT VALID`):

- **018** `audit_log_actor_type_check` + `api_key` (zadatak 4.1 traži actor `api_key` u audit-u).
- **019** `mail_outbox`: `kind` + `reply`, `transport` + `integration`, `status` + `bounced`;
  `mail_outbox_sent_at` ublažen (`sent ⇒ sent_at`, `sent_at` samo za `sent`/`bounced`), jer
  vraćena poruka je prethodno poslata. Status isporuke menja samo `mail_outbox_delivery()`
  (SECURITY DEFINER, samo dozvoljeni prelazi) — `vigor_app` i dalje nema UPDATE na `mail_outbox`.

Novi šifrovani podaci (isti HKDF obrazac po tenantu, AAD tabela|kolona|red): tajne integracija
(`integration_credentials.secret_enc`), tela webhook-ova (`webhook_events.body_enc`) i primljena
pošta (`mail_inbox.from_enc` / `subject_enc` / `body_enc`). Pošiljalac se uparuje preko blind
indexa tenanta (`customer_contacts.email` ključ) — drugi tenant se ne može upariti. Rotacija
master ključa mora pokriti i ove tabele (kao `mail_outbox`).
