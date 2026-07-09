# 16 — Gap analiza: QBigTehn → ServoSync 2.0 (šta nije preneto)

> **Cilj (Nenad, 2026-07-09):** 2.0 mora imati **sve što je QBigTehn imao — i bolje/preglednije/više**.
> Propust je nastao jer prvobitna uputstva nisu opisala sve funkcionalnosti; ovaj dokument popisuje
> jazove i postaje build-backlog. Metod: reverse-engineering QBigTehn VBA/SP izvoza + poređenje sa 2.0
> kodom (Explore agenti). Skop = QBigTehn **Tehnologija/proizvodnja** domen (BigBit retail/GL/carina van 2.0).

Status: **Kompletan draft (2026-07-09)** — §1–§2 (brisanje + pregledi kucanja) i §3 (širi domeni: RN, TP-definicija,
PDM/BOM, primopredaje/lokacije/MRP, matični/UX) popunjeni iz 8 Explore sondi; §4 = master backlog sa prioritetima.
Čeka skop-odluke (§4 Tier D).

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

## 3. Širi domeni — nalazi sondi (2026-07-09)

Kondenzovano, samo akcijski jazovi. Puni izveštaji po domenu u sesijskom transkriptu.

### 3.1 Radni nalozi (RN) — `work-orders`
**MISSING:** izmena zaglavlja RN (nema PATCH — RN nepromenljiv posle kreiranja); **CRUD stavki** za svih 6 listi (operacije `tStavkeRN`, PND, PDM, PLP, `tRNKomponente`, `tRNNDKomponente`) — front prikazuje operacije read-only, ostale ni ne prikazuje; brisanje RN (cascade + guard `Zakljucano`/„proizvodnja započeta"); „kreiraj isti nalog, sledeća varijanta"; varijanta-sekvenciranje (uvek 0); provera duplog `IdentBroj`; skice/dokumentacija po operaciji; print `rRN_SaSlikama` + po tipu stavke (`rRN_tPND/tPDM/tPLP/…`) + `OmotZaPredmet`; RN agregatni pregled (normirano vs utrošeno, težine, razlika); value-list combo predlozi (naziv/materijal/dim); zapisi „ko odobrio/lansirao" (audit); prečice sa RN na karticu postupka/lokacije/komitenta.
**PARTIAL:** approve/launch/lock rade (state-machine) ali **bez RBAC-a i bez audita ko** (`TODO(auth)`); bulk-clone radi ali bez batch datum/rok/tehnolog/komitent override i bez reprefiksa PDM montažnih pozicija; dorada/škart drži izvornu varijantu umesto +1; pretraga bez filtera materijal/dim/varijanta/revizija/kvalitet.
**HAS:** kreiranje zaglavlja, kopiranje stavki iz naloga, bulk-clone, dorada/škart child (-D/-S), numeracija (advisory-lock MAX+1), lock/unlock, RN PDF (std/bez-barkoda).

### 3.2 Tehnologija — definicija TP + šifarnici — `tech-processes`/`structures`
🔴 **NAJVEĆI JAZ:** **TP se ne može ručno praviti** — nema unosa/izmene/brisanja reda operacije (`tStavkeRN`/`WorkOrderOperation`); operacije nastaju samo kopiranjem. Sa tim nedostaje: unos normi **Tpz/Tk**, dodela RC po operaciji, unos/izmena prioriteta (+`PregledOperacijaPoPrioritetima` inline edit), `OpisRada`/`AlatPribor`/`TezinaTO`, **skice po operaciji** (`tStavkeRNSlike` — model postoji, koda nema), upload dokumentacije (`POST /tech-processes/:id/documents` nije napravljen), TP backup/sanacija (`tTehPostupakBackup` je `@@ignore`), CNC programi (planirano u ODLUKE, nema modela).
**HAS:** katalozi — operacije (sva 4 flaga), radne jedinice, tipovi radnika (+`additionalPrivileges`), radnici (CRUD+deactivate), pristup mašinama (+batch matrica). *(Napomena: structures piše u sync-cache tabele — tenzija sa BACKEND_RULES §4, nerešeno.)*

### 3.3 PDM / Crteži / Sastavnica — `pdm`
**MISSING:** ceo **import/write** (SolidWorks XML parser, staging, upsert, validacija, revizija-swap, PDF upload) — **namerno odloženo** za budući PDM-sync; nabavni/parts BOM split (`/bom/parts`,`/bom/purchased` specirani, nenapravljeni), top-level-only, „količina za izradu" skaliranje, breadcrumb drill-down; „samo najnovija revizija" gate pre sastavnice; PDF **štampa** (direktno + batch „štampaj sve"); print `Sastavnica`/`SpisakGdeSeDeoKoristi`; cross-module `GET /drawings/:id/context` + sidebar (nacrt/primopredaja/RN iz crteža).
**PARTIAL:** katalog pretraga (fali ~7 filtera: datumi, approvedBy, projectName, dim, RN, has-PDF; kolone „+"/broj komponenti/has-PDF).
**HAS (≥ legacy):** BOM eksplozija (rekurzivni CTE + anti-ciklus + roll-up), gde-se-koristi (direktno+rekurzivno), revizije, PDF serve+meta, import-log read, statusi.

### 3.4 Primopredaje / Nacrti — `handovers`
**MISSING:** duplikat pre-check + **decision dialog** (`OdlukePredProvera`) + gate za lansiranje; BOM auto-populate stavki nacrta; item CRUD nacrta; **dodela tehnologa pri odobravanju** (endpoint postoji, nije uvezan); grupni status-propagacija po `IDPrimopredaje`; audit ko-odobrio/lansirao; **notifikacije/planer inbox** (`T_Planer` — modeli postoje, UI/endpoint ne); rok-izrade dialog + PDM status update na submit; 6 stavke-tabova; štampa (PDF crtež, svi-na-štampač, RN reporti); bojenje redova.
**PARTIAL:** happy-path radi (nacrt→submit→approve/reject→launch→RN); reject traži razlog (stroже od legacy); tabovi: samo „Na čekanju" + „Sve" (nema Odobrene/Odbijene/Lansirane); guard V1 no-op.
**HAS:** lifecycle statusi 0-3, kreiranje/brisanje nacrta (guard lock), launch pravi `work_orders`+`work_order_launches`.

### 3.5 Lokacije delova — `part-locations` (najkompletniji domen)
**MISSING:** `ProveriDefinisneKolicine` (zbir raspoređenih = br. iskontrolisanih); **X/Y/Z koordinate polica** + validacija; nalepnice print iz lokacija; objekti/hale/zone hijerarhija (`tObjekti`, `frmGrupe`); inline kreiranje pozicije uz formu; write-back sync ka QBigTehn (namerno odloženo); `part_location_movements` tipizovan ledger (§11).
**PARTIAL:** kartica keyed po RN (ne predmet+crtež), manje filtera; pozicije bez X/Y/Z; „lokacija tek posle završne kontrole" dokumentovano ali **nije enforce-ovano**; izvršilac = fallback radnik RN-a (TODO magacioner).
**HAS:** ledger core (unos/prenos/trebovanje/kartica/pregled), kvalitet-segregacija, transakcije+advisory lock.

### 3.6 MRP / Nabavka — `mrp` (skoro sve MISSING — read-only po §11.3)
**MISSING (ceo write/planning stack):** BOM→MRP potrebe eksplozija; kreiranje plana (`MrpPlan`/`MrpPlanItem` tabele ne postoje); create/edit/delete/status potrebe; rezervacije-write; **decision engine sporne stavke** (Isključi/Nabavi ponovo/Nabavi razliku); plan state-machine + proknjiženje + lock; **zahtevi za nabavku** (`PurchaseRequest` — nema); realizacija/upit/tabela statusa; mail nabavci; per-dobavljač/rezervisano/samo-nabavka dashboardi.
**PARTIAL/HAS:** read-only uvid — potrebe, stavke, zalihe (`inStock/reserved/freeStock`), dobavljači/lead-time (bez logike).

### 3.7 Matični podaci + cross-cutting UX
**Namerno read-only (BigBit je izvor — NIJE pravi jaz, potvrditi):** komitenti/predmeti write; materijali/artikli — ali **nema ni šifarnik-ekran** (modeli `Item`/`ItemGroup` bez UI/API).
**MISSING (pravo):** **Excel/CSV izvoz lista** (`DugmeExportUExcel` — bio sveprisutan; 2.0 nema NIGDE); **print/report sloj** (komitent report, `OmotZaPredmet`, **radnička ID-kartica/bedž barkod**, generičke nalepnice, sastavnica); **home/dashboard** (2.0 pada na `/syncs`); **planer/notifikacije inbox** (modeli da, UI ne); **multi-record stepper** (Prvi/Prethodni/Sledeći/Poslednji); pisarnica predmeta (ORGAN/KLASIF/omot/prilozi); mašine-master ekran; company/godina/OJ kontekst; CFG admin, DB alati/backup; **user/rola admin ekran**; skica/potpis file-upload (sad tekst-path).
**PARTIAL:** RBAC katalog projektovan ali **guard V1 no-op** (svi ADMIN), nema enforce/RLS; record-lock samo primopredaje; tastatura mandat po ekranu.
**HAS:** login (JWT + kiosk kartica), sync (recast „Preuzmi iz BB"), komitenti/predmeti read+master-detail+paginacija, radnici/strukture CRUD.

## 4. Master backlog (prioriteti)

**Tier A — proizvodni core (prava rupa, mora):**
1. **TP authoring** — CRUD reda operacije (`work_order_operations`): endpoint(i) + kiosk-neutralan editor; norme Tpz/Tk, RC, prioritet, opis/alat; „Ukupno = Tpz + Tk×Komada". *(bez ovoga TP se ne pravi u aplikaciji)*
2. **RN — izmena zaglavlja** (PATCH) + **CRUD stavki** (6 listi) + **brisanje RN** (cascade + guard lock/proizvodnja) + provera duplog IdentBroj + varijanta-sekvenciranje.
3. **Ispravke kucanja** — storno (kontra-red), audited delete (`spObrisiTP`→`tech_process_backups` tabela), sanacija, ispravka varijante; guardovi.
4. **Kontrolor rola/ovlašćenja** (već zakazano) — kartica-tip vs RBAC pomiriti.

**Tier B — evidencija & tok (treba):**
5. **„Evidencija u proizvodnji" tab** — LoseEvidentirani, SviZapočeti/otvoreni, Zbir/ZbirGrupno (vreme vs norma), po prioritetu (+inline edit), dnevnik, završeni predmeti, PPS status-matrica, AA-po-satu, RN presek po radniku/RC; „Kritični" proširiti na 6 klasa grešaka.
6. **Primopredaje** — dodela tehnologa pri approve, duplikat pre-check + decision, grupni status + audit, notifikacije/planer inbox, rok/PDM-status na submit.
7. **PDM** — parts/nabavni BOM split + top-level + količina-za-izradu; najnovija-revizija gate; context sidebar; PDF/sastavnica štampa.
8. **Lokacije** — ProveriDefinisneKolicine, X/Y/Z, enforce „posle završne kontrole", nalepnice.

**Tier C — cross-cutting UX (navika korisnika):**
9. **Excel/CSV izvoz** svih lista (generički).
10. **Print/report sloj** — radnička ID-kartica/bedž, komitent, omot predmeta, sastavnica, generičke nalepnice; RN sa slikama.
11. **Home/dashboard** + **planer/notifikacije inbox** + record-stepper.
12. **Skica/dokumentacija/CNC upload** (po operaciji/TP).
13. **RBAC enforce** (ugasiti V1 no-op) + generalni record-lock + user/rola admin ekran.

**Tier D — obim/odluka (potvrditi pre gradnje):**
14. **MRP write stack** (planiranje, rezervacije, odluke, proknjiženje, zahtevi za nabavku, mail) — trenutno svesno read-only (§11.3). Gradimo? Koliko (NALMA/BigBit deo je van skopa)?
15. **Start/stop evidencija rada** (dvo-sken) — preduslov za verne vreme-analitike (Tier B tačka 5). Uvodimo u model?
16. **Master-data write** (komitenti/predmeti/materijali) — BigBit je izvor; ostaje read-only ili 2.0 preuzima uređivanje? + materijali/artikli šifarnik-ekran.
17. **Company/godina/OJ kontekst**, CFG admin, DB alati — koliko od ovoga uopšte treba u 2.0.

> Skop-odluke (Tier D + start/stop + master-data vlasništvo) traže potvrdu Nenad/Negovan/Luka pre gradnje.
