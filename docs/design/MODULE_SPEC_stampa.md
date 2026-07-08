# MODULE_SPEC — Štampa i PDF (RN dokument, barkodovi, nalepnice)

| | |
|---|---|
| **Modul** | Štampa — RN dokument sa barkodovima, nalepnice, PDF izvoz, kartice |
| **Verzija spec** | 0.1 (draft, 2026-07-08) — čeka potvrde §10 |
| **Faza** | 2.0 — dopuna pilot modula Tehnologija; par kiosku (Talas 3) |
| **Izvori** | QBigTehn `Izvoz/Izvestaji/*` + `QBigTehn_APL/`; ServoSync 1.0 `servoteh-plan-montaze` (nalepnice rešene) |
| **Vezano** | [MODULE_SPEC_tehnologija](MODULE_SPEC_tehnologija.md), [MODULE_SPEC_radni_nalozi](MODULE_SPEC_radni_nalozi.md), [MODULE_SPEC_pdm](MODULE_SPEC_pdm.md) |

## 1. Cilj i kontekst

2.0 danas **samo čita** barkod (kiosk skener → `tech-processes/barcode.ts`). **Izlazna strana ne postoji**: niko ne
štampa RN sa barkodovima, ne generiše PDF, ne štampa nalepnice. Kiosk (Talas 3) skenira `RNZ` (nalog) + `S`
(operacija) sa **odštampanog** naloga — bez štampe petlja je presečena. Ovaj modul zatvara izlaznu stranu.

**Podela posla:**
- **Nalepnice** su već **rešene u ServoSync 1.0** (jsbarcode CODE128 + `tspl2.js` direktno na TSC ML340P) — 2.0 ih
  **reuse-uje/portuje, ne gradi iz nule** (vidi §6). Formalna migracija 1.0→2.0 stack je tek 3.0.
- **RN dokument sa per-operacija `S:` barkodovima je jedini pravi net-new posao za 2.0** (1.0 ga nema — 1.0 nalepnica
  nosi samo `RNZ` nalog-barkod, ne i operacione).

## 2. Šta je QBigTehn štampao (inventar)

38 Access izveštaja, tehnologija: **MS Access Reports** + **ActiveBarcode ActiveX** (simbologija **Code 128**,
human-readable Arial). PDF = `DoCmd.OutputTo acFormatPDF`. **Nema** Crystal/QuickReport/ZPL/QR-a.

| Grupa | Izveštaji | 2.0 |
|---|---|---|
| Radni nalog | `rRN`, `rRN_STD`, `rRN_SaSlikama`, `rRN_BezBarKoda`, `rRNStavke`, `rRN_tPND/tPDM/tPLP/…` | §4 (net-new) |
| Nalepnice | `Nalepnice`, `Nalepnice_BarKod_3`, `Nalepnice_Kontrolor` | §6 (reuse 1.0) |
| Kartice | `barkod_IDkarticaRadnika`, `barkod_StartStop` | §3.4 |
| Pisarnica/izveštaji | `DnevnaKnjiga`, `DostavnaKnjiga`, `OmotZaPredmet`, pregledi | van 2.0 / kasnije |

## 3. Barkodovi — format i sva polja

Simbologija: **Code 128** (1:1 sa legacy). Render: **jsbarcode** (kao 1.0). Format helper = jedan izvor istine
(P0 modul) koji dele: kiosk-dekoder (`barcode.ts`), RN dokument i nalepnice.

### 3.1 Nalog-barkod (zaglavlje RN)
Legacy: `RNZ:IDPredmet:IdentBroj:Varijanta:PrnTimer` (`Izvoz/Izvestaji/rRN.txt:878`).

**2.0:** `RNZ:{projectId}:{identNumber}:{variant}:{revision}`
- polja iz `work_orders`: `projectId`, `identNumber`, `variant`, `revision`
- **polje 5 = `revision` umesto `PrnTimer`** (odluka §5).

### 3.2 Operacija-barkod (po operaciji na RN) — jedan po redu
Legacy `rRN`: `="S:" & [Operacija] & ":" & [RJgrupaRC] & ":0:" & [PrnTimer]` (`rRN.txt:43454`).
Kontrola je u **Detail sekciji** vezanoj za `tStavkeRN` → svaka operacija dobija **svoj** barkod. Svi dele isti
`PrnTimer` iz zaglavlja (`tRN.*`); `Operacija`/`RJgrupaRC` iz reda operacije.

**2.0:** `S:{operationNumber}:{workCenterCode}:0:{revision}`
- polja iz `work_order_operations` (Was: `tStavkeRN`): `operationNumber`, `workCenterCode`
- polje 4 = literal **`0`** (verno `rRN`-u; skener `barcode.ts` ga čita kao `identMark` → "0"). *Alternativa
  `rRNStavke`: `RNS:…:Toznaka:…` — NE koristiti, marker `RNS` ionako pada na skenerskoj proveri.*
- polje 5 = `revision` (isti kao nalog → i „isti otisak" i „koja verzija").

### 3.3 Nalepnica (deo) — reuse 1.0
1.0 nalepnica nosi `RNZ` nalog-barkod (`formatBigTehnRnzBarcode`). 2.0 puni **stvarni** `projectId`/`revision`
(1.0 stavlja 0). Vidi §6.

### 3.4 Kartice
- ID kartica radnika: barkod = `cardId` (bound polje) — login na kiosku.
- START/STOP kartice: `START` / `STOP`.

## 4. RN dokument (`rRN`) — net-new, prioritet

Endpoint generiše RN za štampu (PDF). Izvor podataka = legacy RecordSource `rRN` (`rRN.txt:23-29`), mapirano na 2.0:

**Zaglavlje (iz `work_orders` + relacije):** `projectId`, `identNumber`, `variant`, `drawingNumber`, `partName`,
`material`, `productionDeadline`, `pieceCount` (planirano), `revision`, status; komitent (preko `Project`→`Customer`),
tehnolog (preko `worker`). → nosi **`RNZ` barkod** (§3.1).

**Detalj (iz `work_order_operations`, jedan red = jedna operacija):** `operationNumber`, `workCenterCode`
(+ naziv radnog centra iz `Operation` šifarnika), `workDescription` (OpisRada), `setupTime` (Tpz), `cycleTime` (Tk),
`Ukupno = Tpz + Tk×Komada`, alat/pribor *(proveriti kolonu u `work_order_operations`)*. → svaki red nosi **`S`
barkod** (§3.2).

**Varijante (kao legacy):**
- `rRN` (standard, sa barkodovima) — podrazumevano.
- `rRN_SaSlikama` — + skice iz `work_order_operation_images` (Was: `tStavkeRNSlike`).
- `rRN_BezBarKoda` — bez operacionih barkoda (napomena: legacy i dalje ima RNZ zaglavlje).
- `rRN_tPND/tPDM/tPLP/tKomponente` — po tipu dokumenta (kasnije).

Endpoint: `GET /api/v1/work-orders/:id/print?variant=std|sa-slikama|bez-barkoda`.

## 5. Verzioni guard — zastareo odštampan RN (UPOZORENJE)

**Poslovno pravilo (Negovan/Vasa; iz koda se ne vidi — utiskivanje je zakomentarisano):** kad se tehnologija/crtež
promene, a radnik ima **stari odštampan RN** u pogonu, sistem to hvata poređenjem verzije sa barkoda i tekuće verzije.
Legacy komparator: `RazlikeIzmedju_tRN_tTehPostupak` (`queries.sql:1358`, `tTehPostupak.PrnTimer <> tRN.PrnTimer`).
Legacy token `F_Timer()=CLng(Timer)` = sekunde od ponoći (slab: reset/sudari) i danas je uglavnom `0`.

**Odluka 2.0 (Nenad, 2026-07-08):**
1. Vezati za **`work_orders.revision`**, NE za sekunde-timer (bez reseta/sudara; okidač = izmena tehnologije/crteža = bump revizije).
2. Ponašanje = **UPOZORENJE, ne blokada.** Prijava rada prolazi, ali vraća flag da je otisak stariji od tekuće revizije.
3. `scan()` promena ([tech-processes.service.ts:655](../../src/modules/tech-processes/tech-processes.service.ts)):
   - zadržati postojeću proveru nalog↔operacija (isti `revision` na oba barkoda = isti otisak);
   - **dodati**: učitati tekući `work_orders.revision` po (projectId, identNumber, variant) i ako je
     `scannedRevision < currentRevision` → u response `staleWorkOrder: true` + poruka
     („Stari nalog — tehnologija/crtež su izmenjeni; preporučuje se novi odštampan nalog").
   - front (kiosk) prikazuje upozorenje, radnik/šef potvrđuje i nastavlja.

## 6. Nalepnice — reuse iz ServoSync 1.0

1.0 (`servoteh-plan-montaze`) ima kompletno, produkcijsko rešenje — 2.0 portuje:
- **`src/lib/tspl2.js`** — TSPL2 program za **TSC ML340P (300 DPI)**; šabloni: TP-nalepnica (80,34×40,3mm),
  polica/kavez, rezni/ručni alat, mini pločica 30×15.
- **`src/ui/lokacije/labelsPrint.js`** — `dispatchOptionalNetworkLabelPrint` → POST JSON sa `tspl2` na
  `VITE_LABEL_PRINTER_PROXY_URL` → lokalni agent piše u **TCP 9100**; `window.print()` A4 kao fallback.
- **jsbarcode CODE128** render; format helper `formatBigTehnRnzBarcode`.

2.0 razlika: puniti **stvarni** `projectId`/`revision` (1.0 stavlja 0, što bi `barcode.ts` odbio jer traži `projectId > 0`).

## 7. Tehnologija za 2.0 (⚠ traži odobrenje — BACKEND_RULES §10)

- **Barkod:** `jsbarcode` (Code 128) — isto kao 1.0, portabilno u Next.js i Node.
- **Nalepnice:** port `tspl2.js` + TSPL2→proxy→9100 (bez nove teške zavisnosti).
- **RN dokument PDF:** predlog `pdfmake` (deklarativno, bez headless browsera — lakše na on-prem Docker serveru;
  tabela za operacije, embed barkod PNG/SVG i skice). Alternativa: Puppeteer (najveći fidelity za „sa slikama"),
  `@react-pdf`. **Bira se pre P1.**

## 8. Endpoints (backend)

| Ruta | Metod | Opis |
|---|---|---|
| `/work-orders/:id/print` | GET | RN dokument PDF (varijante), utiskuje/čita revision za barkod |
| `/work-orders/:id/labels` | GET | Nalepnice (TSPL2 + PDF/HTML), iz work_orders/operations |
| `/pdm/drawings/:id/pdf/content` | GET | Serviranje uskladištenog PDM bytea (trenutno samo metapodaci) |
| `/structures/workers/:id/card` | GET | ID kartica radnika (barkod = cardId) |

## 9. Fazni plan

- **P0 — zajednički barkod modul:** `formatRnzBarcode` + `formatOperationBarcode` (jedan izvor istine); 2.0 puni
  stvarni `projectId`/`revision`; uskladiti sa `barcode.ts` (polje 5 = revision).
- **P1 — RN dokument** (`GET /work-orders/:id/print`) + verzioni guard u `scan()` (§5). **Prioritet — kiosk to čeka.**
- **P2 — Nalepnice u 2.0** (port `tspl2.js` + jsbarcode) — ili ostaviti u 1.0 dok radi (§10.1).
- **P3 — Kartice + PDM PDF serve.**
- **P4 — Kancelarijski izveštaji/izvozi** (trijaža, delom van 2.0 scope-a).

## 10. Otvorene odluke i zavisnosti

1. **Gde žive nalepnice za 2.0** — ostaviti u 1.0 (radi) vs. portovati sad. Preporuka: ostaviti u 1.0, a u 2.0 samo
   obezbediti kompatibilan barkod; P0+P1 odmah.
2. **Zavisnosti** (`jsbarcode`, `pdfmake`/Puppeteer) — odobrenje (§10 BACKEND_RULES).
3. **`revision` bump** — potvrditi da izmena tehnologije/crteža uvek podiže `work_orders.revision` (okidač guarda §5).
4. **Polje 4 operacija-barkoda** — `0` (preporuka, verno rRN-u) vs. `Toznaka` — potvrda Negovana.
5. **TSPL2 proxy** — dostupnost agenta (`…PROXY_URL`→9100) sa 2.0 fronta (Cloudflare) ka pogonu, ili backend šalje TSPL2.
6. **PDF biblioteka** — izbor pre P1.
