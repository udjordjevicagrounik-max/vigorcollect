# 0007 — Povezivanje sandučeta: IMAP/SMTP forma, Microsoft 365 token kod nas

- **Status:** predloženo (migracija 026 čeka potpis)
- **Datum:** 2026-10-13
- **Donosilac:** Uroš
- **Povezano:** zadatak 5.3; pravila 9, 13, 20, 24; ADR 0003, ADR 0005; review S-09

## Kontekst

Tenant mora sam da poveže svoje sanduče (Admin → Integracije → Pošta), bez skripte i bez pristupa
n8n UI-ju. n8n čita i šalje poštu; Collect drži podatke i odluke. Dva puta: IMAP/SMTP (bilo koji
provajder, Gmail sa lozinkom za aplikaciju) i Microsoft 365 (OAuth2). Google Workspace OAuth —
kasnije (BACKLOG).

## Odluka

1. **Tajne samo kod nas, šifrovane.** Korisnik, lozinka, adresa pošiljaoca i Microsoft refresh
   token su u `mailbox_connections` zapečaćeni ključem integracija tenanta (HKDF iz master
   keyring-a, AAD = tabela|kolona|red — isto kao `integration_credentials`). Nikad u odgovoru API-ja,
   audit-u („password_set: true") ni logu. n8n dobija kopiju tek kad veza prođe proveru.
2. **„Proveri vezu" radi worker, ne n8n.** n8n IMAP čvor je samo trigger (ne može jednokratna
   prijava), a javni API nema test credential-a. Worker zato sam radi IMAP `LOGIN` i SMTP `EHLO`
   (+ `AUTH PLAIN` kad ima korisnika) kroz `node:tls` — bez novog paketa — **van transakcije**
   (S-09): claim → commit → proba → upis. Zaštita od SSRF-a: portovi iz fiksne liste (i CHECK u
   bazi), sve razrešene adrese moraju biti javne (privatne / loopback / link-local / CGNAT odbijene;
   `MAILBOX_ALLOW_PRIVATE_HOSTS=1` samo za dev relay). Lozinka nikad ne ide nešifrovanom vezom:
   IMAP 143 mora da ponudi STARTTLS, SMTP bez TLS-a ne sme `AUTH`.
3. **Posle uspeha servis radi ono što je radila `scripts/n8n-connect.ts`, po tenantu:** credential-i
   `collect-signing-<slug>`, `collect-imap-<slug>`, `collect-smtp-<slug>` (ili
   `collect-ms-<slug>`), oba workflow-a iz `docs/integrations/n8n/` sa imenom i webhook putanjom
   tenanta (`collect-mail-outbound-<slug>`), vezivanje po id-ju, aktivacija. Folder/labela iz forme
   ide u IMAP čvor. U bazi ostaju samo id-jevi (`n8n_refs`, P0).
4. **Microsoft 365: refresh token ostaje kod nas; access token guramo u n8n kroz API.**
   Authorization code + PKCE (S256), scope `Mail.Read Mail.Send offline_access`, `MS_TENANT`
   podrazumevano `common`. `state` je jednokratan, 10 minuta, vezan za **člana i sesiju** (heš
   session id-ja) — povratak u drugoj sesiji ili tuđi state = neuspeh. Worker osvežava access token
   10 minuta pre isteka i `PATCH`-uje n8n credential tipa `httpHeaderAuth` (`Authorization: Bearer
…`, dozvoljen samo domen `graph.microsoft.com`); n8n workflow-i za Graph
   (`mail-*-graph.json`) koriste HTTP Request čvorove.
   **Zašto ne n8n OAuth credential:** traži interaktivnu saglasnost u n8n UI-ju (n8n korisnik,
   n8n callback URL) — tenant to ne može sam iz Collect-a; refresh token bi živeo i u n8n-u (drugo
   mesto za opoziv i rotaciju). Ovako je opoziv na jednom mestu (Collect), a n8n drži samo
   kratkotrajni access token.
5. **Bez `MS_CLIENT_ID` / `MS_CLIENT_SECRET` dugme se ne prikazuje** i API vraća `unsupported`.
   Azure aplikaciju pravi Uroš: redirect URI `<BETTER_AUTH_URL>/api/integrations/microsoft/callback`,
   delegirane dozvole Mail.Read, Mail.Send, offline_access.

## Posledice

- Worker treba `N8N_BASE_URL`, `N8N_API_KEY`, `BETTER_AUTH_URL` (inbound URL) i `MS_*`; app treba
  `MS_*` (docker-compose.yml, zaštićen — pravilo 13).
- Mail.Read ne dozvoljava označavanje poruke kao pročitane: Graph inbound pamti poslednji
  `receivedDateTime` u statičkim podacima workflow-a.
- Jedna veza po tenantu (`mailbox_connections_one`), kao i jedna aktivna mailbox integracija.
- `scripts/n8n-connect.ts` ostaje za tenant #0 / ručni oporavak; novi tenanti idu kroz formu.
