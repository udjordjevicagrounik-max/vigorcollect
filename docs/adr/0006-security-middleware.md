# 0006 — Security middleware: headeri, CSRF, Zod, rate limit, Turnstile, oblik greške

- **Status:** prihvaćeno (migracija 008 čeka potpis)
- **Datum:** 2026-10-12
- **Donosilac:** Uroš
- **Povezano:** zadatak 1.4; pravila 5, 7, 27, 29; ADR 0004

## Odluka

- **Headeri (`src/proxy.ts`, svaki odgovor):** CSP sa nonce-om po zahtevu + `'strict-dynamic'`
  (Next sam stavlja nonce na svoje skripte); bez `'unsafe-inline'` za skripte i `<style>`.
  Izuzetak: `style-src-attr 'unsafe-inline'` (style atributi: Next route announcer, Turnstile —
  ne izvršavaju kod). Jedina treća strana: `challenges.cloudflare.com` (skripta + iframe). HSTS samo
  u production-u; `X-Frame-Options: DENY` + `frame-ancestors 'none'`; `Referrer-Policy:
no-referrer` (linkovi pozivnice i reseta nose token u putanji); `Permissions-Policy` gasi
  kameru, mikrofon, lokaciju, plaćanje, USB.
- **CORS:** samo origin iz `BETTER_AUTH_URL`, sa kredencijalima; preflight sa drugog origin-a → 403.
- **CSRF:** Better Auth origin + Fetch-Metadata provera **eksplicitno uključena**
  (`disableOriginCheck/disableCSRFCheck: false`) — biblioteka ih podrazumevano gasi kad je
  `NODE_ENV=test`. Naše mutacije: `withTenant()` traži `Origin` = naš origin (ili
  `Sec-Fetch-Site: same-origin`); SameSite=Lax je drugi sloj.
- **Rate limit:** Better Auth za `/api/auth/*`; za ostale `/api/*` 120 zahteva / 60 s po IP-u u
  bazi (`api_rate_limit`, migracija 008, atomični `api_rate_limit_hit()`), deljeno među
  instancama. Ako baza ne odgovori: propušta + log (login ima svoje limite i zaključavanje).
- **Turnstile:** Better Auth `captcha` plugin (zvanični, zaglavlje `x-captcha-response`) na
  sign-in i reset; naš adapter na pozivnici. Bez ključeva van production-a → preskače se uz log;
  production bez ključeva → proces izlazi sa kodom 1. Provera pada zatvoreno (mreža, timeout).
- **Zod:** svaki body/params/query ide kroz šemu — golden statički test nad `src/app/api`.
- **Greške:** jedan oblik `{code, message_key, request_id}` (`src/lib/api-error.ts`); svaki kod
  ima poruku u `errors.*` (sr + en, unit test); nikad stack ni poruka baze.

## Razmotrene alternative

| Alternativa                                   | Zašto ne                                                             |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `'unsafe-inline'` za skripte                  | poništava CSP; nonce radi sa dinamičkim renderovanjem koje već imamo |
| rate limit u memoriji                         | ne deli se među instancama; restart ga briše                         |
| Better Auth `rateLimit` tabela i za naše rute | mešanje sa internim formatom biblioteke                              |
| sopstvena Turnstile provera za login          | pravilo 10: zvanični plugin postoji                                  |

## Posledice

- **Negativne / rizici:** `X-Forwarded-For` se veruje (iza Elestio/nginx proksija; bez proksija
  je lažljiv — BACKLOG); Turnstile zavisi od Cloudflare mreže (pada zatvoreno = login ne radi kad
  CF ne radi); e2e koristi Cloudflare-ove javne test ključeve i treba mrežu.
- **Ne menjati bez novog ADR-a:** nonce CSP bez `unsafe-inline` za skripte; CSRF provere uvek
  uključene; production ne startuje bez Turnstile ključeva.
