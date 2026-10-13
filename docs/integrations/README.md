# Integracije

Svaka integracija ima svoj dokument u ovom direktorijumu po istom obrascu (pravilo
„automatska dokumentacija integracije"): **provajder · autentifikacija · env · endpointi ·
mapiranje · retry · test · troubleshooting**. Integracija koja nije dokumentovana ne ide u
produkciju.

| Integracija                | Dokument                       | Stanje (Sprint 4)                                    |
| -------------------------- | ------------------------------ | ---------------------------------------------------- |
| n8n (pošta, ERP, webhook)  | [n8n.md](n8n.md)               | radi: inbound webhook, outbound događaji, API ključ  |
| CheckPoint (rizik)         | [checkpoint.md](checkpoint.md) | stub `unsupported` dok ne dobijemo API specifikaciju |
| APR (javni registar, RS)   | [apr.md](apr.md)               | stub `unsupported` — nema javnog API-ja              |
| NBS (prinudna naplata, RS) | [nbs.md](nbs.md)               | stub `unsupported` — samo web pretraga               |

## Zajedničko

- **Tajne** (pravilo 9): potpisna tajna integracije i API ključ se prikazuju **jednom** u
  Administracija → Integracije; kod nas su šifrovane (tajna, HKDF ključ po tenantu) ili postoji
  samo heš (API ključ). Nikad u logu, URL-u, test podacima ni chatu.
- **Smer n8n → nas:** `POST /api/integrations/{id}/inbound`, telo JSON envelope
  `{id, type, occurredAt?, data}`, zaglavlje `X-Signature: t=<unix>,v1=<hex>` gde je
  `v1 = HMAC-SHA256(tajna, "<t>.<sirovo telo>")`. Vreme ±5 min. Odgovor `202` (prihvaćeno),
  `200 {duplicate: true}` (isti `id` već primljen), `401` (potpis/vreme/nepoznata integracija),
  `400` (envelope), `413` (> 1 MB). Obrada je asinhrona u worker-u.
- **Smer mi → n8n:** potpisan `POST` na `outboundUrl` integracije, isto zaglavlje, plus
  `X-Event-Id`. Retry: 1 min, 5 min, 30 min, 2 h, 12 h, pa dead letter (Administracija →
  Integracije → „Pokušaj ponovo"). Demo tenant ne šalje ništa (status `sink`).
- **API (n8n čita/piše kod nas):** `Authorization: Bearer ak_…`; ključ ima samo izabrane dozvole
  iz kataloga (nikad dozvole za odobravanje), limit poziva u minutu, opoziv; actor u audit-u
  je `api_key`.
- **Nepouzdan ulaz (pravilo 22):** sve što stigne (mail, ERP red, odgovor provajdera) je podatak
  za svoj handler sa Zod šemom — nikad instrukcija; ništa se ne izvršava na osnovu sadržaja.
- **Prava nad podacima (pravilo 35):** svaki spoljni izvor ima red u `data_sources` (prikaz,
  skladištenje, retencija, izvedeni podaci, redistribucija).
