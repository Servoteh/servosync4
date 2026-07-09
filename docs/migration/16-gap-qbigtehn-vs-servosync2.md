# 16 — Gap analiza: QBigTehn → ServoSync 2.0 (šta nije preneto)

> **Cilj (Nenad, 2026-07-09):** 2.0 mora imati **sve što je QBigTehn imao — i bolje/preglednije/više**.
> Propust je nastao jer prvobitna uputstva nisu opisala sve funkcionalnosti; ovaj dokument popisuje
> jazove i postaje build-backlog. Metod: reverse-engineering QBigTehn VBA/SP izvoza + poređenje sa 2.0
> kodom (Explore agenti). Skop = QBigTehn **Tehnologija/proizvodnja** domen (BigBit retail/GL/carina van 2.0).

Status: **Draft, u izradi** — sekcije §1–§2 (brisanje + pregledi) kompletne; §3 (širi domeni: RN, TP-definicija,
PDM/BOM, primopredaje/lokacije/MRP, matični/UX) se dopunjuje iz širokih sondi.

## 0. Dva strukturna nalaza (bitni — nisu „samo ekran")

1. **2.0 nema NIKAKVO brisanje/ispravku/storno otkucanih operacija (`tech_processes`), ni audit/backup.**
   QBigTehn je imao tri mehanizma nad `tTehPostupak` + dva legacy hard-delete-a (§1).
2. **2.0 ne meri vreme rada po skenu.** QBigTehn kuca **START** (`DatumIVremeUnosa`) i **STOP**
   (`DatumIVremeZavrsetka`) → stvarno utrošeno vreme po operaciji, poređeno sa normiranim (Tpz/Tk). Na tome
   počiva pola legacy pregleda (Zbir vreme-vs-norma, LoseEvidentirani, KriticniPostupci, AA-po-satu). 2.0 ima
   samo izvedeni elapsed (`enteredAt→finishedAt`) i akumulira komade na jednom redu — bez start/stop evidencije.
   **Odluka potrebna:** da li 2.0 uvodi start/stop evidenciju rada (veći zahvat u model), ili se te analitike
   svesno menjaju/izostavljaju.

## 1. Brisanje / ispravke

| QBigTehn | Šta radi (dokaz) | 2.0 status | Napomena |
|---|---|---|---|
| **Storniranje kucanja** (`Form_BarKod_Ispravka`, query `StornirajTehPostupak`) | INSERT kontra-red `Komada×(−1)`, `Napomena="STORNIRAN POSTUPAK"`; guard: ≤ napravljeno | ❌ MISSING | reverzija bez brisanja |
| **`spObrisiTP`** (audited delete; `Form_PregledPoPostupcima_LoseEvidentirani`) | kopira red u `tTehPostupakBackup` (`DatumIspravke`, `NapomenaIspravke`), pa DELETE | ❌ MISSING | ni backup tabele nema |
| **Legacy hard-delete TP** (`ZaIDPostupkaDeletettTehPostupak`, `ObrisiPostupakZaIDPostupka`) | DELETE bez backupa | ❌ MISSING | 2 živa puta u legacy-ju |
| **Ispravka `Varijanta`** (`DugmeUpdateVarijanta`) | fix kolone na TP; guard IdentBroj==RN | ❌ MISSING | |
| **Bulk sanacija** (`spSanirajSveTP_NoPrnTimer`) | masovno prevezuje mis-linkovane TP na tačan RN + backup | ❌ MISSING | |
| Entry-time undo (`BBTSUndo` = acCmdUndo) | poništi nepotvrđen unos pri skenu | ⚠ PARTIAL | kiosk reset stanja |
| **RN cascade delete** (`spObrisiKompletanNalog`) | briše tRNKomponente/ND/Lansiran/Saglasan/PDM/PLP/PND/StavkeRN/tRN; **čuva** tTehPostupak | ❌ MISSING | guard: `Zakljucano` + „proizvodnja započeta" (`NalogPostojiUTehPostupku`) + potvrda. Spec `MODULE_SPEC_radni_nalozi §3` traži guard, endpoint nikad napravljen |
| RN delete + postupak (`spObrisiKompletanNalogSaPostupkom`) | kao gore + briše tTehPostupak | ❌ MISSING | u legacy-ju samo test-forma |
| Nacrt primopredaje delete (`spObrisiNacrtPrimopredaje`) | guard `Zakljucano` + „iskorišćen u tRN" | ✅ HAS | `DELETE /handover-drafts/:id` |
| Primopredaja odbaci/reject (`spPromeniStatusPrimopredaje` st.2) | status → ODBIJENO | ✅ HAS | `POST /handovers/:id/reject` |
| PDM planiranje nabavke delete (`spPDM_Planiranje_ObrisiPlan`) | + reset MRP statusa | ❌ MISSING | MRP je read-only u 2.0 |
| Komitent delete (`Form_Unos komitenata`) | native Access delete | ❌ MISSING | directory read-only |
| Operacija-šifarnik delete | guarded | ✅ HAS | `DELETE /structures/operations/:code` (409 ako referencirana) |
| machine-access delete | | ✅ HAS | `DELETE /structures/machine-access/:id` |
| Dokumenti/slike delete (fajl+red) | `Kill` fajl + delete red | ❌ MISSING | pdm samo serve |
| Lokacije/pozicije delete | legacy **nema** namenski | ~ PARITET | 2.0 = signed ledger (korekcija = kontra-zapis) |

**Guardovi za replicirati:** `Zakljucano` (lock), „proizvodnja započeta" (`ZavrsenPostupak` postoji), „nacrt iskorišćen u RN", storno ≤ napravljeno. **Audit:** `tTehPostupakBackup` (`DatumIspravke`, `NapomenaIspravke`).

## 2. Pregledi otkucanih operacija (evidencija u proizvodnji)

**2.0 već ima** (ekran *Tehnološki postupci*): Kartica TP + zbirovi (dobar/dorada/škart), Kritični (po roku isporuke), **Učinak radnika** (`worker-performance`), Gotovost RN (`rn-progress`); + Lokacije delova.

| QBigTehn pregled (backing SP/UDF) | Odgovara na | 2.0 status |
|---|---|---|
| `PregledPoPostupcima_Zbir` (`spZbirniPregledPoPostupcima`→`ftPregledPoPostupcima`) | po operaciji: planirano/napravljeno + utrošeno vs **normirano vreme** | ⚠ PARTIAL (zbir u kartici; nema vreme-vs-norma, ni slobodan izveštaj) |
| `PregledPoPostupcima_ZbirGrupno` | grand-total stvarno vs normirano + **razlika** | ❌ MISSING |
| `PregledPoPostupcima_LoseEvidentirani` (`ftPregledLosEvidentiranihPostupaka`) | start/stop u različitim danima **ILI** bez stopa | ❌ MISSING |
| `PregledPoPostupcima_SviZapocetiPostupci` (`ftPregledPoSvimZapocetimPostupcima`) | svi otkucani (otvoreni/zatvoreni) + trajanje | ⚠ PARTIAL (lista ima status; nema namenski „otvoreni") |
| **`frmKriticniPostupci`** (`ftPregledKriticnihPostupaka`) | 6 klasa grešaka: NEDOSTAJE/VIŠAK POSTUPAK, NEDOVRŠEN, NEGATIVNO VREME, PREDUGO >12h, PRELAZI U DRUGI DAN | ❌ MISSING (2.0 „Kritični" = **samo rok isporuke**) |
| `PregledOperacijaPoPrioritetima` (`ftPregledOperacijaPoPrioritetima`) | operacije po prioritetu + **inline izmena prioriteta** | ❌ MISSING (2.0 ne čita/sortira po prioritetu) |
| **PPS** (`spStrukturaProizvodaPoRedosledu`) | status-matrica Op1..Op30 (0/1/2, obojeno) — proizvodni dashboard po nalozima/operacijama | ❌ MISSING |
| `AA_PoSatu` (`ftStatistikaAktivnostiPivot`) | učinak po satu; Dobar/Loš/Neevidentiran unos | ❌ MISSING |
| `AA_LosUnosKomadaNula` | kucanja sa 0 komada | ❌ MISSING |
| `RNPregledPoRadniku` / `RNPregledPoRJ` | RN presek po radniku / radnom centru | ⚠ PARTIAL (agregat da, presek ne) |
| `Report_DnevnaKnjiga` (`spDnevnaKnjiga`) | dnevni log | ❌ MISSING |
| `PregledZavrsenihPredmeti` | završeni predmeti | ❌ MISSING |
| `BarKod_Status` (`spBarKodStatusForm`) | potvrda posle skena (potrebno/napravljeno) | ⚠ PARTIAL (kiosk OrderHeadline + feedback) |

Ovi pregledi bi živeli u novom tabu **„Evidencija u proizvodnji"** (trenutno ne postoji u meniju).

## 3. Širi domeni (dopunjuje se iz sondi 2026-07-09)

Sonde u toku po oblastima — rezultati se ovde spajaju u „HAS/PARTIAL/MISSING" tabele:
- **Radni nalozi (RN)** — pun lifecycle (unos/izmena/kopija/brisanje, saglasnost, lansiranje, veze, stavke, statusi, RN dokument).
- **Tehnologija — definicija TP** — kreiranje/izmena postupka, norme Tpz/Tk, operacije/RJ katalog, pristup mašinama, CNC, dokumentacija/skice.
- **PDM / Crteži / Sastavnica (BOM)** — crteži, komponente, gde-se-koristi, revizije, uvoz, PDF.
- **Primopredaje/Nacrti + Lokacije/magacin + MRP/Nabavka**.
- **Matični podaci (komitenti/predmeti/radnici/materijali) + cross-cutting UX** (pretraga, Excel izvoz, štampa/kartice, glavni meni, prava/MDW).

## 4. Preliminarni backlog (dopuniće se)

- **P2-A Ispravke kucanja:** storno (kontra-red) + audited delete (`spObrisiTP` ekvivalent) + `tech_process_backups` tabela + ispravka varijante; guardovi (lock, proizvodnja započeta).
- **P2-B Evidencija u proizvodnji (tab):** LoseEvidentirani, SviZapočeti/otvoreni, Zbir/ZbirGrupno (vreme vs norma), po prioritetu (+edit), dnevnik, završeni predmeti; „Kritični" proširiti na 6 klasa grešaka.
- **P2-C RN delete** (cascade + guardovi) — spec već traži.
- **P3 Start/stop evidencija rada** (ako se usvoji) — preduslov za verne vreme-analitike.
- **P3 PPS status-matrica**, **AA po satu**, RN presek po radniku/RC.

> Odluka o obimu (šta se vraća 1:1, šta se poboljšava, šta se svesno izostavlja) ide uz Negovana/Luku.
