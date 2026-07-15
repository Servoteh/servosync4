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
barkod** (§3.2) i **praznu „Kontrola" kolonu** (poslednja, desno od barkoda) — jedan potpisni prostor po operaciji za
potpis kontrolora (parity sa legacy `rRN` „Kontrola" kolonom).

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

**Odluka 2.0 (Nenad, 2026-07-08) — ISPRAVLJENO posle domenske potvrde:**
Verzija koja se menja pri izmeni tehnologije/crteža je **`variant`** (broj), i podiže se **U MESTU**
(isti RN red, `variant` 0→1). *(Ne alfabetska `revision` — ona ostaje „A"; ranija pretpostavka bila pogrešna.)*
`variant` je već u nalog-barkodu (polje 4), pa **format barkoda ostaje nepromenjen**.
1. Guard poredi **`variant`** (skenirani sa otiska vs. tekući na RN-u).
2. Ponašanje = **UPOZORENJE, ne blokada.** Rad se evidentira na **tekuću** varijantu, uz flag.
3. `scan()` (`tech-processes.service.ts`):
   - lookup `tech_processes` NE pinuje skeniranu varijantu (menja se u mestu): traži po
     (projectId, identNumber, workCenterCode, operationNumber), `orderBy variant desc` → tekući red;
   - `staleWorkOrder = scannedVariant < tp.variant` → response `staleWorkOrder` + `printedVariant`/`currentVariant`;
   - „isti otisak" provera ostaje na `revision` (polje 5, ista u oba barkoda);
   - front (kiosk) prikazuje upozorenje („Nalog štampan u varijanti X, tekuća je Y…"), rad prolazi.

**Napomena (buduće poravnanje):** operacioni barkod polje 4 je trenutno literal `0`; po Vasi bi trebalo da nosi
`variant` (radi jače „isti otisak" provere i para sa nalog poljem 4). Odloženo da se ne dira frontend/kontrola
barkod-tipovi usred paralelnog rada — nije nužno za guard (guard koristi nalog varijantu).

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

| Ruta | Metod | Status | Opis |
|---|---|---|---|
| `/work-orders/:id/print` | GET | ✅ | RN dokument PDF (`?variant=std\|bez-barkoda`); RNZ + S po operaciji, revision |
| `/pdm/drawings/:id/pdf/content` | GET | ✅ | Stream uskladištenog PDM bytea (`?download=true` → attachment) |
| nalepnice | — | kontrola stream | frontend `tspl2.ts`/`label-print.ts` → TSC (ne backend endpoint) |
| ID/START-STOP kartice | — | ⏸️ | odloženo / van scope-a (§9 P3b) |

## 9. Fazni plan — status (2026-07-08)

- **P0 — zajednički barkod modul** ✅ IMPLEMENTIRANO: `barcode.ts` polje 5 → `revision` (string) +
  `formatOrderBarcode`/`formatOperationBarcode`; 2.0 puni stvarni `projectId`/`revision`. Testovi + tsc čisti.
- **P1 — RN dokument** ✅ IMPLEMENTIRANO: `documents` modul (`BarcodeService` bwip-js + `PdfService` pdfmake),
  `WorkOrderPrintService`, `GET /api/v1/work-orders/:id/print`, verzioni guard u `scan()` (§5), „Štampaj RN" dugme.
- **P2 — Nalepnice** ↔ vozi paralelni **kontrola stream** (frontend `tspl2.ts` + `label-print.ts`, TSPL2→TSC);
  2.0 barkod je kompatibilan (isti `revision` format). Ne duplira se ovde.
- **P3a — PDM PDF serve** ✅ IMPLEMENTIRANO: `GET /api/v1/pdm/drawings/:id/pdf/content` + „Otvori PDF" dugme.
- **P3b — Kartice** ⏸️ ODLOŽENO (Nenad, 2026-07-08): ID kartice = koriste se postojeće fizičke (ne pravimo dok ne
  zatreba); START/STOP kartice = **van scope-a 2.0**.
- **P4 — Kancelarijski izveštaji/izvozi** — nije počelo; niski prioritet, delom van 2.0 scope-a.

## 10. Odluke — rešene i otvorene

**Rešeno (2026-07-08, Nenad/Vasa):**
- ✅ **Zavisnosti:** `pdfmake` (RN PDF, bez headless browsera) + `bwip-js` (Code 128 SVG, server-native; jsbarcode
  je browser-side → ostaje samo za nalepnice/klijent) + `@types/pdfmake`.
- ✅ **Verzioni guard = `variant`, U MESTU, UPOZORENJE** (ne blokada) — implementirano u `scan()` (§5).
  *(Ispravka: verzija je `variant` broj koji se podiže u mestu, NE alfabetska `revision`.)*
- ✅ **Nalepnice ostaju u 1.0 / kontrola stream**; 2.0 obezbeđuje kompatibilan barkod.
- ✅ **TSPL2 proxy radi** — štampa nalepnica bez problema na 1.0 (potvrda Nenad); nema dodatnog posla.
- ✅ **Polje 4 operacija-barkoda = `0`** (default); po Vasi vrednost dolazi iz varijante — buduće poravnanje da
  polje 4 nosi `variant` (§5 napomena). Ne blokira guard.
- ⏸️ **Kartice** — ID odložene, START/STOP van scope-a (§9 P3b).

**Otvoreno:** nema blokirajućih odluka za štampu; ostaje samo buduće poravnanje operacionog barkoda (polje 4 →
`variant`) kad se sleže paralelni kontrola/barkod rad.
