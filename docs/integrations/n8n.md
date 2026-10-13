# n8n

|                     |                                                                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Provajder**       | n8n (self-hosted, Elestio servis „n8n"). n8n nosi IMAP/SMTP/OAuth (Google Workspace, Microsoft 365, generički IMAP/SMTP); mi nosimo API, webhook-ove i UI.                                                              |
| **Autentifikacija** | n8n → nas: HMAC potpis tajnom integracije (`X-Signature`). n8n → naš API: API ključ (`Bearer ak_…`). Mi → n8n: isti HMAC potpis, n8n ga proverava pre bilo čega.                                                        |
| **Env kod nas**     | ništa novo — tajne su po tenantu u bazi (šifrovano).                                                                                                                                                                    |
| **Env u n8n-u**     | **ništa.** Tajna je u n8n credential-u `collect-signing` (tip _Crypto_, polje HMAC secret); HMAC računa **Crypto** čvor, ne Code čvor. Adresa za prijem stoji u čvoru „Send to Collect” (nije tajna — štiti je potpis). |

## Postavljanje (jednom po tenantu)

**Automatski (tenant Sinergista na ovom serveru):** `scripts/n8n-connect.ts` — runbook
„n8n povezivanje”. Ručno, za drugi tenant / drugi n8n:

1. Kod nas: Administracija → Integracije → „Nova integracija”, vrsta **Pošta**, naziv,
   adresa n8n webhook-a (`https://<n8n>/webhook/collect-mail-outbound`), događaji po potrebi.
   Kopirajte **tajnu** i **adresu za prijem** — prikazuju se samo tada.
2. U n8n-u: Credentials → New → **Crypto**, naziv `collect-signing`, polje **HMAC secret** = tajna.
   Bez env promenljivih i bez restarta n8n-a.
3. n8n → Workflows → Import from file: [`n8n/mail-inbound.json`](n8n/mail-inbound.json) i
   [`n8n/mail-outbound.json`](n8n/mail-outbound.json). U čvoru „Send to Collect” upišite adresu
   za prijem; u čvorovima za poštu izaberite svoj credential (IMAP / SMTP; za Gmail i Outlook
   zamenite čvor odgovarajućim „Gmail Trigger” / „Microsoft Outlook Trigger” i „Gmail” /
   „Microsoft Outlook” čvorom — mapiranje polja ispod). Crypto čvorovi se vezuju za
   `collect-signing` po imenu.
4. Aktivirajte oba workflow-a. Kod nas: „Test ping” na integraciji → `sent` (outbound workflow
   na potpisan `integration.ping` odgovara 200 bez slanja pošte).

**Potpis u n8n-u:** Code čvor samo raspakuje zahtev / sklapa envelope (bez tajne, bez `crypto`
modula i bez `$env`); **Crypto** čvor (HMAC-SHA256, credential `collect-signing`) računa
`hex(HMAC(secret, "<t>.<raw body>"))`; IF čvor proverava svežinu (±5 min) i jednakost. Poređenje
u IF čvoru nije u konstantnom vremenu — prihvatljivo za proveru na strani n8n-a; kod nas je
provera `timingSafeEqual`.

## Endpointi i mapiranje

**Prijem pošte** (n8n → `POST <adresa za prijem>`), `type: "mail.received"`:

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
