# 17 — Cutover runbook: gašenje QBigTehn sync-a (lanac PDM→primopredaja→RN→TP)

> Status: **NACRT** (2026-07-10). Preduslov: P4a deployovan (nativni XML/PDF uvoz, bridge, derivacioni
> sync tRN→drawing_handovers). Otvorene odluke pre izvršenja označene ⚠️ — bez njih se ne kreće.
> Kontekst i analiza: [PLAN_primopredaja_tp_cutover.md](../design/PLAN_primopredaja_tp_cutover.md) §2.8–2.9.

## 0. Šta cutover znači

Posle cutover-a: projektanti i tehnolozi rade **isključivo u ServoSync-u** (modul Tehnologija);
QBigTehn/QMegaTeh se za lanac PDM→nacrt→primopredaja→RN→TP **ne koristi**; sync tog lanca se gasi.
**BigBit matični podaci** (komitenti, predmeti, artikli…) i dalje idu svojim trajnim sync-om — vasa-SQL
se NE gasi (odluka „QBigTehn privremen / BigBit trajan").

## 1. Preduslovi (proveriti PRE zakazivanja dana)

- [ ] P4a na produkciji ≥ nedelju dana: XML/PDF uvoz radi (bridge u pasivnom modu paralelno sa legacy
      skriptama — brojevi u `drawing_import_log` se poklapaju sa legacy `PDMXMLImportLog`).
      Instalacija i dnevna verifikacija: `tools/pdm-bridge/` — `smoke-check.ps1` / `install-task.ps1` / `uninstall-task.ps1` + README §„Puštanje u pogon (P4c)" (gotovi SQL upiti za obe strane).
- [ ] ⚠️ ODLUKA #3 revidirana (Negovan potpis): PDM izvor = nativni XML+PDF uvoz u 2.0, ne trajni SQL sync.
- [ ] ⚠️ `draft_id` kolona na `drawing_handovers` (zamena resolveDraftContext heuristike) — odluka Negovan.
- [ ] ⚠️ Semantika undo-a kad RN postoji (storno RN-a?) — odluka Miljan/Negovan.
- [ ] Obuka: projektanti (nacrt u 2.0 umesto QMegaTeh), Miljan (odobravanje u 2.0), tehnolozi (kucanje TP
      u 2.0 — tok „Otkucaj TP" već živ).
- [ ] ✅ Dopunska skripta za tabele bez syncer-a = **isporučeni §5.3 privremeni synceri** u sync modulu
      (`src/modules/sync/syncers/legacy-chain-item.syncer.ts` + 6 izvedenih: tPDM/tPLP/tPND,
      tSaglasanRN, PDM_PlaniranjeStavke, PrimopredajaPDFCrteza; registrovani POSLEDNJI, rade
      **isključivo uz `force:true`** — običan run je no-op).
- [ ] ✅ Verifikacioni report = **`backend/tools/cutover-verify/cutover-verify.mjs`** (COUNT/MAX(id) po
      tabeli, derivacija, MAX RN ordinal po predmetu, soft-FK orfani, PDF blobovi, statusna
      distribucija; exit 0 = paritet — vidi `tools/cutover-verify/README.md`).

## 2. Dan cutover-a (redosled je NEPREGOVARAN — ponovni sync posle nativnih upisa TIHO GAZI 2.0 redove)

1. **Freeze legacy** (van radnog vremena): obavestiti projektante/Miljana; revoke write za APL naloge na
   QBigTehn bazi (ili ukloniti ikone) — od tog trenutka NIKO ne unosi u QBigTehn/QMegaTeh za ovaj lanac.
2. Sačekati **poslednji ciklus 10-min skripti** (XML/PDF → BigBit server → baza) + ručno pokrenuti legacy
   uvoz za zaostale fajlove; proveriti da su folderi XML/PDF prazni ili preneseni.
3. **Finalni sync u 2.0** — force/full refresh (kursori u `bb_sync_state` resetovati za tabele lanca;
   pažnja: kursor za drawing_handovers je ranije pomeren fallback-om). §5.3 privremeni synceri (tabele
   bez generisanog mapiranja) su registrovani poslednji i uvoze **samo u ovom force run-u** (bez force
   su no-op); posle uvoza sami poravnavaju svoje sekvence.
4. **Verifikacioni report**: `node tools/cutover-verify/cutover-verify.mjs > report.md` (iz backend
   checkout-a; **exit 0 obavezan**) — mora biti 1:1; odstupanja se rešavaju PRE nastavka.
5. **setval poravnanje** svih sekvenci (`alignIdSequence` helper, 3-arg oblik) — sve tabele lanca.
6. **Gašenje sync-a lanca**: izbaciti qbigtehn-tabele iz sync mape (split trajni/privremeni deo);
   derivacioni tRN→drawing_handovers syncer se gasi; deploy backenda.
7. **Otključavanje**: skinuti guard mutacija sa legacy-deriviranih primopredaja (env flag / ownership);
   bridge prebaciti u **aktivni mod** (move u Importovano/Neuspelo); legacy 10-min skripte ugasiti.
8. **Smoke test lanca uživo — OBA toka lansiranja** (P4 spec §6.1, odluka #1):
   - **Tok A (primopredaja):** XML iz PDM-a → crtež u 2.0 → nacrt → submit → Miljan approve (+tehnolog) →
     „Otkucaj TP" → štampa → lansiraj → kucanje na kiosku → kartica TP.
   - **Tok B (blanko RN):** `POST /work-orders` („Unos radnog naloga", blanko) → CRUD operacija →
     approve → `POST /work-orders/:id/launch`; za RN vezan za primopredaju proveriti propagaciju:
     izvorna primopredaja prelazi na status 3 (LANSIRAN) + zaključana (`is_locked`).
9. 1.0 loc-most / integracije koje čitaju QBigTehn preusmeriti ako postoje (proveriti INTEGRACIJA doc).

## 3. Rollback plan

Do koraka 6 rollback je trivijalan: vratiti write legacy nalozima, nastaviti u QBigTehn (2.0 podaci od
freeze-a se odbacuju force sync-om). Posle koraka 7 rollback zahteva ručno prenošenje nativno unetih
podataka nazad — zato smoke test (korak 8) ide ISTOG dana, pre puštanja korisnika.

## 4. Posle cutover-a (prva nedelja)

- Dnevni pregled `drawing_import_log` (kritične greške) i bridge log-a.
- MRP/nabavka deo koji je čitao tRN iz legacy-ja — proveriti potrošače (PLAN §2.9).
- Ukloniti „Legacy" badge iz UI kad se potvrdi stabilnost.
