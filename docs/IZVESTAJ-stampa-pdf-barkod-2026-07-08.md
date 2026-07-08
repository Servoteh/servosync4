# Izveštaj: Štampa RN, PDF izvoz i barkodovi (2026-07-08)

> Detaljan zapis šta je urađeno na temu **štampanja radnih naloga, PDF-a i barkodova** u ServoSync 2.0 —
> od analize legacy QBigTehn/1.0 stanja, preko donetih odluka, do implementacije i **produkcijskog deploya**.
> Prateći spec (živi izvor istine): [design/MODULE_SPEC_stampa.md](design/MODULE_SPEC_stampa.md).

## 0. TL;DR — šta je isporučeno i živo

- **RN dokument (PDF)** — dugme „Štampaj RN" na detalju radnog naloga → PDF sa zaglavljem, tabelom operacija,
  **RNZ barkodom** (nalog) i **`S` barkodom po operaciji** (Code 128).
- **PDM PDF crteža** — dugme „Otvori PDF" na detalju crteža → servira uskladišten PDF (do sada se nije mogao otvoriti).
- **Verzioni guard** — kiosk prijava rada upozorava kad radnik skenira **star odštampan nalog** (starija `variant`).
- **Zajednički barkod modul** — jedan izvor istine za format barkoda, deljen između kiosk-dekodera i generisanja za štampu.
- Sve **verifikovano i deploy-ovano na produkciju** (`servosync2.servoteh.com` + on-prem backend). Radi kraj-do-kraja.

---

## 1. Polazno stanje (pre ovog rada)

2.0 je imao **samo ulaznu stranu** barkoda: kiosk skener → `tech-processes/barcode.ts` parsira dva barkoda
(`RNZ:…` nalog + `S:…` operacija) radi prijave rada. **Izlazna strana nije postojala:**

- Nije se štampao radni nalog ni barkodovi (ni na papir ni PDF).
- Nije bilo nijedne PDF/print zavisnosti u projektu (`grep` kroz `backend/src`+`frontend/src` = 0 pogodaka za
  jsPDF/pdfkit/pdf-lib/puppeteer/bwip-js/jsbarcode…).
- PDM `/pdf` je vraćao **samo metapodatke** (ime/veličina/datum) — čak ni uskladišteni bajt se nije servirao.

**Ključni problem:** kiosk (Talas 3) skenira barkodove sa **odštampanog** naloga, ali ih niko nije štampao —
petlja je bila presečena na pola.

---

## 2. Analiza legacy izvora

### 2.1 QBigTehn (prethodni sistem)
- **38 Access izveštaja**; tehnologija = MS Access Reports + **ActiveBarcode ActiveX** kontrola, simbologija
  **Code 128**, human-readable Arial. PDF preko `DoCmd.OutputTo acFormatPDF`.
- Radni nalog (`rRN`, `rRN_STD`, `rRN_SaSlikama`, `rRN_BezBarKoda`, `rRNStavke`) nosi barkodove:
  - **nalog (zaglavlje):** `="RNZ:" & [IDPredmet] & ":" & [IdentBroj] & ":" & [Varijanta] & ":" & [PrnTimer]`
  - **operacija (po redu):** `="S:" & [Operacija] & ":" & [RJgrupaRC] & ":0:" & [PrnTimer]`
    ([Izvoz/Izvestaji/rRN.txt:43454](../../Izvoz/Izvestaji/rRN.txt)) — polje 4 je literal `0`, kontrola u
    **Detail sekciji** vezanoj za `tStavkeRN` → **svaka operacija svoj barkod**.
- **`PrnTimer`** (`F_Timer() = CLng(Timer)`, sekunde od ponoći) — vezni ključ nalog↔operacija; komparator
  `RazlikeIzmedju_tRN_tTehPostupak` poredi `tTehPostupak.PrnTimer <> tRN.PrnTimer`. U trenutnom QBigTehn-u je
  utiskivanje **zakomentarisano** → u praksi `0`.

### 2.2 ServoSync 1.0 (`servoteh-plan-montaze`)
- Štampa **nalepnica je već rešena** (`jsbarcode` CODE128 + `tspl2.js` → **TSC ML340P** termalni štampač preko
  lokalnog proxy-ja na TCP 9100; `window.print()` A4 fallback). Modul „štampa nalepnica" + tokovi za police/alat.
- Zaključak: **nalepnice se ne grade u 2.0** — reuse-uje ih 1.0/kontrola-stream. Jaz za 2.0 je bio **RN dokument
  sa per-operacija `S` barkodom** (1.0 nalepnica nosi samo nalog-barkod).

---

## 3. Donete odluke (sa korisnikom)

| # | Odluka | Ishod |
|---|---|---|
| PDF pristup | Kako renderovati RN PDF | **pdfmake** (server-side, bez headless browsera) |
| Barkod (server) | jsbarcode je browser-side | **bwip-js** (pure JS, Code 128 → SVG); jsbarcode ostaje za nalepnice/klijent |
| Verzioni pečat | Šta hvata star otisak | **`variant`** (podiže se **u mestu** pri izmeni tehnologije/crteža), NE alfabetska `revision` |
| Ponašanje guarda | Blokada ili upozorenje | **UPOZORENJE** (rad prolazi na tekuću varijantu) |
| Polje 4 op-barkoda | `0` vs Toznaka | ostaje **`0`** (default); buduće poravnanje da nosi `variant` |
| Nalepnice | Gde žive | ostaju u 1.0/kontrola-stream; 2.0 daje kompatibilan barkod |
| TSPL2 proxy | Radi li štampa | **radi** (kao na 1.0) |
| Kartice radnika | ID / START-STOP | ID **odložene** (koriste se postojeće fizičke); START/STOP **van scope-a 2.0** |
| Proces grananja | Pregled koda | dok je 2.0 razvojna → **direktno na `main`** (bez pregleda); pregled tek od 3.0 produkcije |

---

## 4. Implementacija — po fazama

### P0 — Zajednički barkod modul + verzioni guard

**Fajlovi:** [barcode.ts](../src/modules/tech-processes/barcode.ts), [barcode.spec.ts](../src/modules/tech-processes/barcode.spec.ts),
[tech-processes.service.ts](../src/modules/tech-processes/tech-processes.service.ts) (`scan()`),
[dto/scan-tech-process.dto.ts](../src/modules/tech-processes/dto/scan-tech-process.dto.ts);
frontend [api/kiosk.ts](../../frontend/src/api/kiosk.ts), [kiosk-scanner.tsx](../../frontend/src/app/kiosk/_components/kiosk-scanner.tsx).

- **Format barkoda (jedan izvor istine):**
  - nalog: `RNZ:projectId:identNumber:variant:revision`
  - operacija: `S:operationNumber:workCenterCode:0:revision`
- **Dodati enkoderi** `formatOrderBarcode()` i `formatOperationBarcode()` — round-trip kompatibilni sa
  `parseBarcode()`. 2.0 puni **stvarni** `projectId`/`variant` (1.0 je stavljao 0).
- **Polje 5** preimenovano `printTimer → revision` u dekoderu (parsira se kao string; legacy je tu imao numerički
  PrnTimer, u praksi 0). Koristi se za „isti otisak" proveru (nalog i operacija dele istu vrednost).

### P1 — RN dokument (PDF) — glavni net-new posao

**Fajlovi (backend):** modul [documents/](../src/modules/documents/) —
[barcode.service.ts](../src/modules/documents/barcode.service.ts) (bwip-js Code 128 → SVG),
[pdf.service.ts](../src/modules/documents/pdf.service.ts) (pdfmake render);
[work-order-print.service.ts](../src/modules/work-orders/work-order-print.service.ts) (layout RN dokumenta);
endpoint u [work-orders.controller.ts](../src/modules/work-orders/work-orders.controller.ts).
**Frontend:** [api/client.ts](../../frontend/src/api/client.ts) `apiBlob`, [api/work-orders.ts](../../frontend/src/api/work-orders.ts)
`openWorkOrderRnPdf`, dugme u [app/work-orders/page.tsx](../../frontend/src/app/work-orders/page.tsx).

- **Endpoint:** `GET /api/v1/work-orders/:id/print?variant=std|bez-barkoda` → `application/pdf` (StreamableFile, inline).
- **Sadržaj RN-a** (legacy `rRN`, mapirano na 2.0 šemu):
  - Zaglavlje iz `work_orders` (+ komitent iz `Customer`, tehnolog iz `Worker`, batch-resolve zbog orphan FK):
    predmet, RN broj, varijanta, revizija, crtež, naziv dela, materijal, rok izrade, planirana količina, tehnolog.
    → **RNZ barkod**.
  - Tabela operacija iz `work_order_operations` (Was `tStavkeRN`): br. operacije, radni centar (+ naziv iz
    `operations` šifarnika), opis rada, Tpz (`setupTime`), Tk (`cycleTime`), alat/pribor. → **`S` barkod po redu**.
- **PdfService detalji (pdfmake 0.3, server-side):** Roboto font učitan iz pdfmake vfs-a u in-memory `virtualfs`
  (`writeFileSync(name, b64, 'base64')`), `setFonts({Roboto:{…}})`; **srpska slova (čćšžđ) rade** (Roboto Latin
  Extended-A). Eksterni URL resursi zabranjeni (`setUrlAccessPolicy(() => false)`). Barkod = `svg` node.
- **Format brojeva:** datum `dd.MM.yyyy.`, Tpz/Tk sa decimalnim zarezom.

### P3a — Serviranje uskladištenog PDM PDF-a crteža

**Fajlovi:** [pdm.service.ts](../src/modules/pdm/pdm.service.ts) `getPdfContent()`,
[pdm.controller.ts](../src/modules/pdm/pdm.controller.ts); frontend [api/pdm.ts](../../frontend/src/api/pdm.ts) `openDrawingPdf`,
[drawing-detail.tsx](../../frontend/src/app/pdm/_components/drawing-detail.tsx).

- **Endpoint:** `GET /api/v1/pdm/drawings/:id/pdf/content` (`?download=true` → attachment; inače inline) —
  streamuje `drawing_pdfs.pdf_binary` (bytea) po (drawing_number, revision). 404 ako crtež/sadržaj ne postoje.
- Frontend „Otvori PDF" dugme se prikazuje samo kad `pdf.hasBinary`.

---

## 5. Verzioni guard — detaljno (Vasina zaštita od zastarelog otiska)

**Poslovno pravilo (Negovan/Vasa):** kad se u međuvremenu promeni tehnologija/crtež, a radnik u pogonu ima
**star odštampan nalog**, sistem to hvata poređenjem verzije sa barkoda i tekuće verzije. Iz koda se ne vidi
(utiskivanje PrnTimer-a je bilo zakomentarisano) — pa je pravilo dokumentovano na osnovu razgovora + legacy
komparatora `RazlikeIzmedju_tRN_tTehPostupak`.

**Kako je izvedeno u 2.0:**
- Verzija koja se menja = **`work_orders.variant`** (broj), i podiže se **U MESTU** (isti RN red, `variant` 0→1).
  *(Alfabetska `revision` ostaje „A" — prva implementacija ju je koristila i bila bi uspavana; ispravljeno.)*
- `variant` je već u nalog-barkodu (polje 4) → **format barkoda nepromenjen**.
- `scan()` ([tech-processes.service.ts](../src/modules/tech-processes/tech-processes.service.ts)):
  - **ne pinuje** skeniranu varijantu (menja se u mestu) — traži tekući `tech_processes` red po
    (projectId, identNumber, workCenterCode, operationNumber), `orderBy variant desc`;
  - `staleWorkOrder = scannedVariant < tp.variant` → rad se evidentira na **tekuću** varijantu, uz upozorenje;
  - response: `staleWorkOrder`, `printedVariant`, `currentVariant`.
- Kiosk poruka (tone `info`, bez novog statusa u dizajn-sistemu): „Nalog je štampan u varijanti X, tekuća je Y —
  preuzmite novi odštampan nalog."
- **Napomena:** guard „opali" samo kada se `variant` stvarno podiže pri izmeni tehnologije/crteža (proces koji
  potvrđuje Vasa); u suprotnom je benigan (ne okida lažno).

---

## 6. Zavisnosti (uz izričito odobrenje — BACKEND_RULES §10)

Dodato u `backend/package.json`: **`pdfmake`**, **`bwip-js`**, dev **`@types/pdfmake`**.
- `pdfmake` (0.3.x) — server-side render bez headless browsera (lakše na on-prem Docker serveru).
- `bwip-js` — pure-JS Code 128 generator (bez native kompajla), SVG za pdfmake. jsbarcode NIJE korišćen na
  serveru (browser-side); ostaje za nalepnice/klijent (1.0/kontrola-stream).

---

## 7. Verifikacija

- **Testovi:** `barcode.spec.ts` (round-trip format↔parse, validacije) — **16/16 prošlo** (2 suite).
- **Typecheck:** backend `tsc --noEmit` čist; frontend `tsc --noEmit` čist.
- **Vizuelna proba PDF-a:** generisan RN PDF sa mock podacima i pregledan — zaglavlje, info-grid, tabela operacija
  sa Code 128 barkodom po operaciji, srpska slova (čćšžđ, Ø) korektna, footer sa brojem strane.
- **Kraj-do-kraja (produkcija):** front `servosync2.servoteh.com/login` → 200; API kroz Tunnel
  `/work-orders/:id/print` i `/pdm/drawings/:id/pdf/content` → 401 (rute postoje, auth); health → 200.
  **Korisnik potvrdio: štampa i PDF rade.** ✅

---

## 8. Deploy (produkcija)

- **`main`:** oba repoa (`servosync/backend`, `servosync/frontend`) sinhronizovani sa celim wave-3 radom
  (proces: dok je 2.0 razvojna → direktno na `main`, bez pregleda).
- **Backend (on-prem, 192.168.64.28):** Docker `servosync-backend` (compose u `/home/admluka/servosync`).
  Rebuild-ovan sa najnovijim main-om (image 21:36); potvrđeno u kontejneru da `dist` sadrži `variant`-guard
  (`scannedVariant`/`printedVariant`, nema `printedRevision`). **Nije bila potrebna migracija** (nema izmena šeme).
- **Frontend:** `npm run deploy` (`next build` → `wrangler pages deploy` na projekat `servosync2`) → živi
  `servosync2.servoteh.com`. Redosled ispoštovan (backend imao kod pre fronta).

---

## 9. Van scope-a / odloženo / buduće

- **Nalepnice (P2):** vozi paralelni kontrola-stream (frontend `tspl2.ts` + `label-print.ts`, TSPL2→TSC); 2.0 daje
  kompatibilan barkod.
- **Kartice (P3b):** ID kartice radnika — odložene (koriste se postojeće fizičke); START/STOP — van scope-a 2.0.
- **Kancelarijski izveštaji (P4):** niski prioritet, delom van 2.0 scope-a (trijaža ~30 kritičnih od 496 BigBit izveštaja — vidi ROADMAP §4.0).
- **Buduće poravnanje (nije blokada):** operacioni barkod polje 4 → `variant` (jača „isti otisak" provera; sad je `0`),
  kad se sleže paralelni kontrola/barkod rad.

---

## 10. Reference — commitovi

**backend** (`servosync/backend`, grana `feat/wave-3` → `main`):
- `c771969` feat(stampa): RN print (PDF) + revision-based reprint guard (P0+P1)
- `25efc6d` feat(pdm): serve stored drawing PDF content (P3a)
- `d3db4e3` docs(stampa): status faza + odluke
- `16027f6` fix(stampa): verzioni guard na `variant` (u mestu), ne `revision`

**frontend** (`servosync/frontend`):
- `7bc1224` feat(stampa): „Štampaj RN" dugme + apiBlob
- `205524d` feat(pdm): „Otvori PDF" dugme na detalju crteža
- `e6e8f04` fix(stampa): kiosk stale-otisak upozorenje na `variant`

*Poslednji update: 2026-07-08 — štampa RN + PDF crteža + verzioni guard živi na produkciji; potvrđeno da radi.*
