# Matrica permisija

Izvor istine za `requirePermission('objekat.akcija')` (pravilo 7). Nova permisija se dodaje
ovde **i** traži se odobrenje — ne izmišlja se u kodu.

Legenda: ✅ dozvoljeno · ➖ nije dozvoljeno · 🅼 maker-checker (pravilo 11)

## Role

_Role se definišu u zadatku 1.3. Kolone ispod su mesta za njih._

| objekat.akcija                                  | opis | _rola 1_ | _rola 2_ | _rola 3_ |
| ----------------------------------------------- | ---- | -------- | -------- | -------- |
| _(prazno — prve permisije dolaze sa 0.2 / 1.x)_ |      |          |          |          |

## Javne rute (bez `requirePermission`)

Izuzeci od pravila 7. Svaki izuzetak mora biti ovde, sa razlogom.

| ruta                    | metoda | razlog                                               | zaštita                                |
| ----------------------- | ------ | ---------------------------------------------------- | -------------------------------------- |
| `/health`               | GET    | liveness probe za Docker/Elestio i post-deploy smoke | ne vraća podatke, samo `{status:"ok"}` |
| `/manifest.webmanifest` | GET    | PWA manifest                                         | samo `productName` i boje              |
