# n8n

|                     |                                                                                                                                                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Provajder**       | n8n (self-hosted, Elestio servis „n8n"). n8n nosi IMAP/SMTP/OAuth (Google Workspace, Microsoft 365, generički IMAP/SMTP); mi nosimo API, webhook-ove i UI.                                                                                                            |
| **Autentifikacija** | n8n → nas: HMAC potpis tajnom integracije (`X-Signature`). n8n → naš API: API ključ (`Bearer ak_…`). Mi → n8n: isti HMAC potpis, n8n ga proverava pre bilo čega.                                                                                                      |
| **Env kod nas**     | ništa novo — tajne su po tenantu u bazi (šifrovano).                                                                                                                                                                                                                  |
| **Env u n8n-u**     | `COLLECT_INBOUND_URL` (adresa za prijem iz Administracija → Integracije), `COLLECT_SIGNING_SECRET` (tajna, prikazana jednom), `NODE_FUNCTION_ALLOW_BUILTIN=crypto` (provera potpisa u Code čvoru). Upisuju se u Elestio env panel n8n servisa, nikad u workflow JSON. |

## Postavljanje (jednom po tenantu)

1. Kod nas: Administracija → Integracije → „Nova integracija", vrsta **Pošta**, naziv,
   adresa n8n webhook-a (`https://<n8n>/webhook/collect-mail-outbound`), događaji po potrebi.
   Kopirajte **tajnu** i **adresu za prijem** — prikazuju se samo tada.
2. U n8n-u (Elestio env panel): `COLLECT_INBOUND_URL`, `COLLECT_SIGNING_SECRET`,
   `NODE_FUNCTION_ALLOW_BUILTIN=crypto`; restart n8n-a.
3. n8n → Workflows → Import from file: [`n8n/mail-inbound.json`](n8n/mail-inbound.json) i
   [`n8n/mail-outbound.json`](n8n/mail-outbound.json). U oba čvora za poštu izaberite svoj
   credential (IMAP / SMTP; za Gmail i Outlook zamenite čvor odgovarajućim „Gmail Trigger" /
   „Microsoft Outlook Trigger" i „Gmail" / „Microsoft Outlook" čvorom — mapiranje polja ispod).
4. Aktivirajte oba workflow-a. Kod nas: „Test ping" na integraciji → u n8n-u se vidi izvršenje.

## Endpointi i mapiranje

**Prijem pošte** (n8n → `POST {COLLECT_INBOUND_URL}`), `type: "mail.received"`:

```json
{
  "id": "<Message-ID>",
  "type": "mail.received",
  "occurredAt": "2026-10-13T10:00:00+02:00",
  "data": {
    "messageId": "<Message-ID>",
    "from": "kupac@example.com",
    "subject": "…",
    "text": "…",
    "html": "… (opciono)",
    "inReplyTo": "<…> (opciono)",
    "references": ["<…>"],
    "attachments": [{ "filename": "…", "contentType": "…", "size": 123 }]
  }
}
```

Uparivanje kod nas: pošiljalac → blind index email-a kontakta → kupac; `In-Reply-To` /
`References` → naša poslata poruka → case. Nepovezano → Administracija → Integracije →
„Nepovezane poruke". Bounce (mailer-daemon / postmaster koji upućuje na našu poruku) →
poslata poruka dobija status `bounced` + stavka „Zahteva pažnju". Prilozi: samo metapodaci.

**Status isporuke** (opciono, n8n → nas), `type: "mail.status"`:
`data: { "outboxId": "<uuid>", "status": "sent" | "failed" | "bounced", "messageId": "…", "reason": "kod" }`.

**Slanje pošte** (mi → n8n webhook `collect-mail-outbound`), `type: "mail.send"`:
`data: { "outboxId", "messageId", "to", "subject", "text", "html", "inReplyTo", "references" }`.
n8n odgovara `2xx` tek **posle** slanja, sa telom `{"status": "sent", "messageId": "…"}`
(stvarni Message-ID SMTP-a, da bi odgovori kupca našli case).

**Ostali događaji** (mi → n8n): `promise.broken`, `mail.queued`, `document.rendered`, … — telo
`{id, type, occurredAt, data: {eventId, aggregateType, aggregateId, payload}}`, samo id-jevi.

## Retry

- n8n → nas: HTTP Request čvor „Retry on fail" (5 pokušaja, 5 s). Ponovljen `id` je bezbedan
  (`200 duplicate`).
- Mi → n8n: 1 min, 5 min, 30 min, 2 h, 12 h, pa dead letter; pošta isto, pa status `failed`.
- **Idempotency-Key** (security review S-09): svaki POST ka n8n-u nosi header
  `Idempotency-Key` = id stavke kod nas (`mail_outbox.id` / `outbound_deliveries.id`), isti u
  svakom ponovnom pokušaju. Stavka se pre slanja „zauzme" na 10 min (commit pre POST-a); ako
  proces padne posle POST-a, ponovni pokušaj dolazi tek posle toga, sa istim ključem. Šablon
  `mail-outbound.json` pamti ključ 7 dana (čvorovi „Already sent?" / „Remember key", static data
  aktivnog workflow-a) i na ponovljen ključ odgovara sačuvanim Message-ID-om **bez ponovnog
  slanja**. Sopstveni workflow mora da radi isto.

## Test

- „Test ping" (Administracija → Integracije) — potpisan `integration.ping` ka n8n-u.
- Iz n8n-a: pošaljite sebi mail na nadgledano sanduče → kod nas Customer 360 → Komunikacija
  (ili „Nepovezane poruke").
- Golden testovi: `tests/golden/db/integrations.test.ts`, `tests/golden/db/mail-inbox.test.ts`.

## Troubleshooting

| Simptom                                          | Uzrok                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `401` na prijemu                                 | pogrešna tajna, sat n8n servera odstupa > 5 min, integracija isključena, ili telo menjano posle potpisa (potpis je nad **sirovim** telom). |
| `200 duplicate`                                  | isti `id` već primljen — očekivano kod retry-a.                                                                                            |
| Poruka u dead letter-u, razlog `invalid_payload` | `data` ne odgovara šemi (npr. nema `from`).                                                                                                |
| Pošta ostaje „na čekanju"                        | integracija nema `outboundUrl`, n8n workflow nije aktivan, ili n8n vraća ne-2xx.                                                           |
| Demo tenant ništa ne šalje                       | namerno (pravilo 24): status `sink`.                                                                                                       |
