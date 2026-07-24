# PLAN PARITETA 1.0 → 3.0 — funkcionalni gap-audit (2026-07-24)

> **Metod:** 35 Opus agenata (14 modulskih audita + 3 cross-cutting specijalista za štampu/PDF,
> mejlove/automatike i exporte/UX + 1 žetva postojećih docs planova), pa **adversarialna
> verifikacija svakog nalaza** u 3.0 kodu (drugi agent pokušava da obori nalaz sinonimima,
> drugim rutama, backend-om bez FE dugmeta). Perspektiva: senior developer + iskusan korisnik.
> **Van obima:** skeniranje kamerom / APK ljuska (paralelna radna linija) i 4.0/BigBit ERP
> gapovi (poseban program — docs/MASTER_PLAN_GRADNJE).
>
> **Rezultat:** 60 novih nalaza → **47 potvrđeno + 9 delimično** (1 oboren, 3 svesno-na-sy15),
> uz **51 već-popisanu otvorenu stavku** iz postojećih planova (Aneks B). Sirovi podaci:
> workflow `wf_66d06045-aeb` (journal.jsonl).

## 0. Glavni zaključak (TL;DR)

1. **Najveći sistemski gap nije nijedna pojedinačna funkcija, nego to što 3.0 NEMA nikakav
   scheduler/cron pogon** (`X-EMAIL-AUTOMATIKE-01`): nula `@Cron`/`@nestjs/schedule`/pg_cron
   poslova u backend-u. Sve 1.0 automatike (isteci ugovora/dokumenata, korektivne mere 07:30,
   sedmični sastanak petak 08h, podsetnici za sastanke, rokovi vozila, rođendani/digest,
   onboarding podsetnici) ili **tiho ne rade** ili žive na starom sistemu. Dobra vest:
   verifikacija je pokazala da 3.0 **već ima konfiguracije i outbox tabele** za većinu njih —
   fali samo pogon + enqueue poslovi. Jedan temelj otključava ~10 gapova.
2. **Dve bezbednosno-operativne rupe u nalozima:** admin reset lozinke ne upisuje u 3.0 auth
   (`PODESAVANJA-01`) i ne postoji self-service promena lozinke niti se `must_change_password`
   sprovodi (`PODESAVANJA-02`).
3. Štampa/PDF je **pretežno prenesena** (aneks: 27 artefakata OK), ali fali nekoliko
   svakodnevnih: direktna TSC termalna štampa nalepnica u magacinu, RN „sa slikama",
   OCR sa nalepnica, poster sistematizacije, sitna polja na payslip-u.
4. **Moj profil/GO ima najviše korisničkih finoća izgubljeno** (7 nalaza — akrual „preostalo do
   danas", razlog odbijanja, „za koga" picker, poruke u modalima).
5. Žetva docs-a potvrđuje ono što već znamo: **Reversi je najdalje od pariteta** (13% — plan
   R1–R5 ~5,2 MN postoji), a HITNE stavke Praćenja (O8 zamrznuti 1.0 ekran, F5b Plan
   proizvodnje) već imaju svoju radnu liniju (`wt/pracenje-f1`) — ovde se samo referenciraju.

## 1. Talas A — Pogon automatika (temelj; ~3–5 MN)

| # | Stavka | Nalazi |
|---|--------|--------|
| A1 | **Scheduler pogon** u NestJS backend-u. Odluka: `@nestjs/schedule` u procesu (nova zavisnost → traži odobrenje po BACKEND_RULES §10) ili pg_cron na glavnoj bazi + tanki HTTP okidači. Preporuka: pg_cron (već postoji znanje sa sy15, preživljava restart deploy-a, ne duplira se pri skaliranju). | X-EMAIL-AUTOMATIKE-01 |
| A2 | Na pogon nakačiti poslove za koje 3.0 **već ima config/outbox**: isteci ugovora/dokumenata/LK (lead-days config postoji), korektivne mere 07:30, rođendani/godišnjice/digest (flagovi postoje), onboarding dnevni podsetnik, rokovi vozila (RPC `maint_check_vehicle_deadlines` postoji — samo cron), podsetnici za sastanke (30 min + dnevni za akcije), sedmični sastanak petak 08h (+DST guard + prenos tema — logika u 1.0 sql-u kao referenca). | X-EMAIL-AUTOMATIKE-02..08 |
| A3 | **Dispatch odluka:** slanje mejlova iz 3.0 (sopstveni worker nad outbox tabelama) ili svesno zadržati sy15 dispatch workere do dekomisije (Blok B RADNI_PLAN-a). Ako ostaje sy15 — upisati u registar sy15-duga (Talas F). | X-EMAIL-AUTOMATIKE-09 |

## 2. Talas B — Kritične funkcionalne rupe (~2–3 MN)

| # | Stavka | Sev/Effort |
|---|--------|-----------|
| B1 | Admin reset lozinke → upis u **oba** auth sistema (3.0 `users.passwordHash` + GoTrue dok sy15 živi). | 🟠 S |
| B2 | Self-service promena lozinke + sprovođenje `must_change_password` na 3.0 loginu. | 🟡 M |
| B3 | Plaćeno odsustvo: vratiti katalog osnova + godišnji fond 5 dana (sada slobodan tekst). | 🟠 M |
| B4 | „Promocija akcione tačke u aktivnost" — dugme postoji, backend vraća **501**. Implementirati ili sakriti dugme. | 🟡 L |
| B5 | Provera pa sanacija 2 BLOCKER-a iz cutover audita Lokacija (mogu biti već sanirani): PL-01 pretraga → 500; PLK-01 definitions-audit → 500. | 🟠 S–M |
| B6 | Praznici: admin CRUD (sada samo read) — utiče na grid sati i GO obračun za 2027. | 🟡 M |

## 3. Talas C — Štampa / PDF / izvozi (~3–4 MN)

- **C1** 🟡 M — Batch TP nalepnice direktno na TSC termalni štampač (magacin svaki dan; sada samo pregledač+Ctrl+P). `LOKACIJE-02`
- **C2** 🟡 M — OCR broja predmeta/TP sa nalepnice (Tesseract iz slike — nije skener-kamera tema). `LOKACIJE-01`
- **C3** 🟡 L — RN „sa slikama" (skice operacija u PDF). `X-STAMPA-PDF-01`
- **C4** 🟡 S — 360° PDF: ugraditi radar grafikon. `X-STAMPA-PDF-02`
- **C5** 🟡 M — Poster sistematizacije (A0 + varijanta sa imenima + skok na „moja pozicija"). `KADROVSKA-01` (PARTIAL)
- **C6** ⚪ S×6 — sitni izvozi: organogram XLSX/PDF (`KADROVSKA-02`), payslip JMBG+tip rada (`ZARADE-01`), CSV akcija sastanka + štampa (`SASTANCI-01`), PB CSV kolona „Kašnjenje" (`PB-PROJEKTOVANJE-02`), CMMS CSV limit 200 redova + troškovi po stavci (`ODRZAVANJE-01/-02`), Gantt PDF legenda (`MONTAZA-03`).

## 4. Talas D — Moj profil / GO finoće (~2 MN)

`PROFIL-GO-02` razlog odbijanja u tabeli (S) · `PROFIL-GO-03` akrual „preostalo do danas" + avans marker (M) ·
`PROFIL-GO-05` „za koga" picker za nadoknadu/plaćeno (S) · `PROFIL-GO-04/-06/-07` poruke, potvrde i
validacije u modalima (S×3) · `RAZVOJ-360-01` scoping pickera na opseg rukovodioca (S — i bezbednosna higijena).

## 5. Talas E — Ergonomija i prečice (kontinuirano, quick-win fond ~2–3 MN)

Prioritet: **E1** 🟠 M `X-EXPORT-UX-01` dd.mm.gggg. tekst-unos datuma sa maskom (native date input je
najčešća dnevna frustracija za brze unose) · **E2** `X-EXPORT-UX-02` pretraga bez dijakritike +
multi-token (M) · **E3** `X-EXPORT-UX-05` jedinstven confirm dijalog (M, ui-kit) · zatim ⚪:
globalne prečice `/`, `n`, `r`, `?` · sticky h-scroll za grid sati · obojene pilule tipova premeštanja ·
klikabilne bar-liste CMMS izveštaja · SCADA stale-badge + tema bez reload-a · AI chat sitnice ·
stat kartice/kolone u Korisnicima · Sastanci quick-add FAB · Reversi master-detalj umesto modala (PARTIAL) ·
PB gantt dan-zoom · live totali u obračunu zarada (`ZARADE-02`, L — uz pažnju na PII) ·
Praćenje realtime umesto 30s poll (odluka SSE/WS, `PROIZVODNJA-PRACENJE-02`) ·
Montaža: otvaranje glavnog crteža iz plana (`MONTAZA-02`) · 3D modul — **odluka da li se uopšte prenosi** (`MONTAZA-01`).

## 6. Talas F — Registar sy15-duga (rešiti PRE gašenja starog sistema)

Ovo danas RADI, ali na sy15 — mora u 3.0 (ili svesno ugasiti) pre dekomisije (RADNI_PLAN Blok B):
dispatch workeri mejl-outboxa (hr/maint/pb/sastanci) · javni RSVP magic-link (3.0 ima samo
autentifikovan RSVP — odluka) · 360 rater stranica za spoljne ocenjivače (`ocena.html`) ·
WhatsApp kanal notifikacija (primaoci se čuvaju u 3.0, šalje sy15) · loc-sync/SCADA watchdog
automatike. + svih 14 edge funkcija popisati pri Bloku B (Aneks B, RADNI_PLAN reference).

## 7. Šta je NAMERNO van ovog plana

- **Skener/kamera + APK ljuska** — paralelna radna linija (kamera-skener engine, /mob/lokacije).
- **Reversi dubinski paritet** — postojeći plan R1–R5 (~5,2 MN; trenutni paritet 13%) važi; ovaj
  audit je dodao samo `REVERSI-01` (master-detalj UX) i potvrdio da je karta gapova iz
  CUTOVER_AUDIT_reversi i dalje tačna (Aneks B).
- **Praćenje O8/F5b HITNE stavke** — već u toku u `wt/pracenje-f1` liniji (F3/F5 planovi).
- **4.0 ERP (BigBit zamena)** — poseban program (MASTER_PLAN_GRADNJE, 158 gapova).

## 8. Predlog redosleda izvršenja

1. **Odmah (ova nedelja):** B1+B2 (lozinke — bezbednost), A1 odluka o scheduler-u (blokira A2), B5 provera blokera.
2. **Sledeće:** Talas A ceo (automatike su „tihi" gubitak — niko ne primeti dok ne zaboli), pa B3/B4/B6.
3. **Zatim:** Talas C (štampa — magacin i kadrovska je osete svaki dan), paralelno D (male stavke, veliki utisak).
4. **Kontinuirano:** E quick-win fond (1–2 stavke uz svaki drugi posao), F uz Blok B dekomisiju.

**Gruba ukupna procena novootkrivenog (bez Aneksa B):** ~12–17 MN. Izvršenje po ustaljenom modelu:
Fable planira talas → Opus agenti izvode → verify pre deploy-a.

---
## Aneks A — Detalji nalaza po modulima

Verdikt: CONFIRMED = adversarialno potvrđeno da fali · PARTIAL = postoji osiromašeno · REFUTED = oboreno (postoji) · OUT-OF-SCOPE = svesno još na starom sistemu (sy15) i radi.

### reversi

#### ⚪ REVERSI-01 — Kartica alata i kartica mašine otvaraju se kao modal, a ne kao pun master-detalj ekran (1.0 UX)
*NISKO · effort M · ergonomija · verdikt: PARTIAL*

- **1.0:** 1.0 (reversiToolDetail.js renderToolDetailPage / revMasineTab.js renderMachineDetailPage) otvara karticu alata i karticu mašine kao PUN EKRAN u telu modula, sa dugmetom „← Nazad na listu" i 4 taba (Osnovno · Baterije · Servis i popravke · Istorija), plus stat-kartice troška/isplativosti i ledger — dovoljno prostora za guste tabele. _(‎src/ui/reversi/reversiToolDetail.js:295 renderToolDetailPage(host,{toolId,onBack}) i src/ui/reversi/index.js:175 openToolDetail() / :183 openMachineDetail() renderuju u #revTabBody (pun ekran).)_
- **3.0:** 3.0 je funkcionalno kompletan (sva 4 taba + isplativost + ledger + heads CRUD) ALI je kartica realizovana kao MODAL Dialog, ne kao pun master-detalj ekran; za bogatu karticu sa 4 taba i više tabela modal je tešnji i ne može se deep-link-ovati. _(‎frontend/src/app/reversi/_components/tool-detail-dialog.tsx:4 import { Dialog }, :40 tabovi 'osnovno|baterije|servis|istorija', :265 <Dialog>; machine-card-dialog.tsx (Dialog + heads). Nema rute/master-detalj strane za pojedinačni alat/mašinu.)_
- **Uticaj:** Magacioner/tehnolog koji često pregleda istoriju i servise pojedinačnog alata radi u tešnjem modalu; bez URL-a kartice (nema deep-link/bookmark). Funkcija je cela prisutna — samo je forma prezentacije drugačija od 1.0.
- **Verifikator:** Kartica alata (tool-detail-dialog.tsx:265 <Dialog>, tabovi 'osnovno|baterije|servis|istorija') i kartica masine (machine-card-dialog.tsx:4 import Dialog, sa heads CRUD) su funkcionalno kompletne ali OTVORENE KAO MODAL. Ceo modul ima samo jednu rutu app/reversi/page.tsx (nema [id] pod-rute — potvrdjeno: reversi/ direktorijum sadrzi samo _components/), pa je gap tacan: fali pun master-detalj ekran i URL deep-link/bookmark. Funkcija postoji, samo je forma prezentacije osiromasena u odnosu na 1.0.

### Lokacije (magacin)

#### 🟡 LOKACIJE-01 — OCR citanje broja predmeta/TP sa nalepnice ne radi (Tesseract engine nije ubacen u 3.0)
*SREDNJE · effort M · funkcionalnost · verdikt: CONFIRMED*

- **1.0:** 1.0 ima funkcionalan OCR: kad barkod ne uspe (ostecen/necitljiv), radnik u skener modalu usmeri gornji-desni ugao radnog naloga, cropTopRightLabelRegion isece kadar, recognizeLabelCanvas pozove Tesseract.js worker (dependency tesseract.js ^5.1.1, lazy createWorker('eng')) i vrati tekst iz kog se parsira broj predmeta/TP i propusti kroz isti lookup kao skenirani barkod. _(‎src/services/labelOcr.js (getWorker -> import('tesseract.js'), recognizeLabelCanvas); package.json linija 50 tesseract.js ^5.1.1; poziva se iz src/ui/lokacije/scanModal.js.)_
- **3.0:** UI dugme 'OCR tekst' postoji u scan-overlay.tsx i cista logika (crop + parsePredmetTpFromLabelText) je portovana, ALI sam engine NIJE bundle-ovan. recognizeLabelText radi samo ako je window.Tesseract prisutan (self-host UMD), inace vraca {error:'engine_missing'} i korisnik vidi 'OCR tekst nije konfigurisan na ovoj instalaciji'. U praksi OCR ne radi. _(‎frontend/src/lib/label-ocr.ts: komentar 'Sam OCR engine (Tesseract) NIJE bundle-ovan u 2.0 ... Engine-provisioning je zabelezen kao BE/infra follow-up'; getEngine()/isOcrEngineAvailable() traze window.Tesseract; scan-overlay.tsx ocrScan() grana sa porukom engine_missing; grep tesseract frontend/package.json = nema dependency.)_
- **Uticaj:** Magacioner/radnik u pogonu koji skenira nalepnicu sa ostecenim/izbledelim barkodom: u 1.0 ga spasi OCR gornjeg ugla, u 3.0 mora rucno da otkuca nalog/TP. Fallback (rucni unos) postoji pa nije blokirajuce.
- **Verifikator:** frontend/src/lib/label-ocr.ts:7-10 dokumentuje da engine NIJE bundle-ovan; recognizeLabelText:153 vraca {error:'engine_missing'} ako nema window.Tesseract. Provereno: `grep -i tesseract frontend/package.json` = nema zavisnosti, i node_modules/tesseract.js ne postoji. Cist deo (crop+parse) je portovan, ali OCR u praksi ne radi bez self-host UMD-a.

#### 🟡 LOKACIJE-02 — Batch stampa TP nalepnica nema direktan put na TSC termalni stampac (samo pregledac + Ctrl+P)
*SREDNJE · effort M · stampa-pdf · verdikt: CONFIRMED*

- **1.0:** U 1.0 printTechProcessLabelsBatch za CEO red za stampu radi DVA puta paralelno: (a) browser preview sa CODE128, (b) buildTspLabelProgram -> dispatchOptionalNetworkLabelPrint salje raw TSPL2 direktno TSC-u (9100), zaobilazeci Chrome headers/footers dance. Isto vazi i za shelf batch. _(‎src/ui/lokacije/labelsPrint.js printTechProcessLabelsBatch (linije ~1262-1281: gradi tspl2 i zove dispatchOptionalNetworkLabelPrint); printShelfLabelsToBrowserWindow isto za tsc format.)_
- **3.0:** U 3.0 pojedinacna TP nalepnica (ManualTpLabel) i shelf 'tsc' format IDU na backend TSPL2 (usePrintLocLabel -> 9100), ali BATCH red za stampu (BatchTpLabels) zove SAMO printTechProcessLabelsBatch iz labels-print-window.ts koji otvara browser preview (CODE128 SVG) i staje na Ctrl+P. Nema opcije 'posalji ceo red direktno na TSC'. Infrastruktura postoji (usePrintLocLabel) ali batch je ne koristi. _(‎frontend/src/app/lokacije/_components/stampa-tab.tsx BatchTpLabels.runBatchPrint() -> printTechProcessLabelsBatch(specs) (browser-only); labels-print-window.ts printTechProcessLabelsBatch samo window.open + document.write, bez TSPL2/backend poziva; usePrintLocLabel se u batch delu ne poziva.)_
- **Uticaj:** Magacioner koji odjednom stampa 10-30 TP nalepnica na TSC termalni: u 1.0 idu direktno iz TSPL2, u 3.0 mora kroz Chrome print dijalog (svaki put iskljuci Headers/footers, margin None). Zaobilaznica postoji ali je sporija i podlozna gresci.
- **Verifikator:** stampa-tab.tsx BatchTpLabels.runBatchPrint() (red 543) zove printTechProcessLabelsBatch(specs) koji je u labels-print-window.ts:648-681 iskljucivo window.open+document.write (CODE128 SVG) sa Ctrl+P hintom — nema TSPL2/usePrintLocLabel poziva; komentar linija 646 potvrdjuje 'TSC put OSTAJE odvojen'. Nasuprot tome, shelf 'tsc' (linija 156-179) i ManualTpLabel (linija 359) idu na backend TSPL2 preko print.mutateAsync. Batch red za stampu nema direktan TSC put.

#### ⚪ LOKACIJE-03 — Tipovi premestanja vise nisu obojene pilule (izgubljena vizuelna klasifikacija)
*NISKO · effort S · ergonomija · verdikt: CONFIRMED*

- **1.0:** U 1.0 'Poslednja premestanja' na Pocetnoj i lista premestanja koriste obojene pilule po tipu pokreta (MOVEMENT_TYPE_PILL: initial/move/inv/return/remove -> razlicite boje iz status tokena), pa operater na prvi pogled razlikuje prvo zaduzenje, transfer, povrat, korekciju, uklanjanje. _(‎src/ui/lokacije/index.js MOVEMENT_TYPE_PILL mapa + movementTypePillClass() + loc-mov-pill--* CSS klase.)_
- **3.0:** 3.0 pocetna-tab.tsx i movements-tab.tsx renderuju movementLabel(type) kao OBICAN TEKST (kolona Tip / red poslednjih premestanja), bez ikakve boje ili badge-a po tipu. Semantika je tu (labela), ali vizuelna diferencijacija je izgubljena. _(‎frontend/src/app/lokacije/_components/pocetna-tab.tsx red 238 <span>{movementLabel(m.movementType)}</span> (plain); movements-tab.tsx kolona 'Tip' render: movementLabel(r.movementType) bez StatusBadge/boje.)_
- **Uticaj:** Magacioner koji skenira listu poslednjih pokreta: sporije skenira tip pokreta ocima jer su svi isti sivi tekst. Cisto kozmeticki/UX, ne blokira posao.
- **Verifikator:** common.tsx:49-51 movementLabel() vraca cist string (MOVEMENT_TYPE_LABEL lookup), bez boje/badge-a. pocetna-tab.tsx:238 renderuje <span ...>{movementLabel(m.movementType)}</span>, movements-tab.tsx:81 kolona 'Tip' render: movementLabel(r.movementType) — oba plain tekst. Nema MOVEMENT_TYPE_PILL/loc-mov-pill ekvivalenta (grep bez pogodaka). Zanimljivo: StatusBadge se koristi za TIP LOKACIJE (LocTypeBadge, common.tsx:43) ali NE za tip pokreta, pa je vizuelna klasifikacija premestanja stvarno izgubljena.

### Plan montaže + Izveštaji montera

#### ⚪ MONTAZA-01 — 3D model faze (🧩 3D) potpuno izostavljen
*NISKO · effort M · funkcionalnost · verdikt: CONFIRMED*

- **1.0:** Svaka faza u plan-tabeli ima dugme „🧩 3D" koje otvara modal (modelDialog.js): sidecar zapis phaseModels[phaseId] = { name, imageUrl (preview slika), fileUrl (.glb/.stp/.pdf), note }, sa live preview-om slike (onerror graceful), čuva se u localStorage; dugme dobija klasu has-model kad je 3D dodeljen. JSON export ga nosi kao _phaseModels. _(‎src/ui/planMontaze/modelDialog.js (ceo, 134 linije); planTable.js:387 dugme „🧩 3D" + getPhaseModel(row.id); exportModal.js:154 _phaseModels u JSON payload-u.)_
- **3.0:** Ne postoji nigde. Grep za 3d|model|phaseModel|imageUrl|fileUrl|🧩 kroz frontend/src/app/montaza + frontend/src/lib/plan-montaze + api/plan-montaze.ts ne vraća nijednu implementaciju — samo komentar u plan-tab.tsx:9 koji ga navodi kao „deferred (increment 5)". Nema dugmeta na PhaseRow/PhaseCard, nema kolone u schema.prisma, JSON export (export.ts) ne nosi _phaseModels. _(‎grep -rniE '3d|phaseModel|imageUrl|fileUrl|🧩' frontend/src/app/montaza frontend/src/lib/plan-montaze frontend/src/api/plan-montaze.ts → jedini hit je komentar plan-tab.tsx:9. MODULE_SPEC_planovi_pracenje_30.md:205 navodi „model faza" u listi paritet-modala, ali NEMA gap-table reda za njega (redovi 1–40) → tiho ispao iz obima.)_
- **Uticaj:** PM/inženjer/vođa montaže koji su u 1.0 kačili preview 3D sklopa uz fazu; funkcija je i u 1.0 bila placeholder (URL-sidecar u localStorage, bez pravog viewera), retko korišćena — otud niska ozbiljnost.
- **Verifikator:** Grep za phaseModel|imageUrl|fileUrl|3D|🧩 kroz frontend/src i backend/src/modules/plan-montaze ne vraća nijednu implementaciju — jedini trag je komentar plan-tab.tsx:8-9 koji ga eksplicitno navodi kao 'Deferred (increment 5)'. Nema polja u schema.prisma ni u plan-montaze DTO/servisu; DrawingChip mehanizam postoji ali je vezan samo za povezane crteže faza, ne za 3D model.

#### 🟡 MONTAZA-02 — „Glavni crtež sklopa" se ne prikazuje ni otvara u planu — samo edit-polje u meta dijalogu
*SREDNJE · effort S · ergonomija · verdikt: CONFIRMED*

- **1.0:** Ispod WP tabova stoji stalna traka „Glavni crtež sklopa" (projectBar.js _wpAssemblyStripHtml): ako je broj postavljen prikazuje se klikabilan chip 📄 SC-XXX koji odmah otvara PDF crteža (openDrawingPdf), + dugme IZMENI; ako nije, placeholder + ＋ POVEŽI (samo edit). Chip je vidljiv SVIM rolama uključujući read-only montera (samo bez dugmeta za izmenu). To je glavni sklopni crtež celog radnog naloga. _(‎src/ui/planMontaze/projectBar.js:104-126 (_wpAssemblyStripHtml) + :356-364 (wpAssemblyOpenBtn → openDrawingPdf(no)); wpAssemblyDrawingDialog.js za izmenu.)_
- **3.0:** assemblyDrawingNo postoji samo kao obično <input> tekst-polje unutar WP meta dijaloga (meta-modals.tsx:484, edit-only). NEMA vidljivog chipa u Plan/Gantt pogledu, NEMA dugmeta za otvaranje PDF-a glavnog crteža, NEMA exists-check-a ni signed URL-a. Read-only monter/viewer ne može ni da vidi ni da otvori glavni sklopni crtež naloga. _(‎grep -rniE 'assemblyDrawing|glavni crtež' frontend/src/app/montaza → jedini hitovi su u meta-modals.tsx (input polje) i plan-tab.tsx:606 (prosleđivanje u upsert). Nigde fetchDrawingSignedUrl/DrawingChip za assemblyDrawingNo. Spec MODULE_SPEC:257 (red 8) je PLANIRAO „glavni crtež sklopa (PDF exists-check + signed URL) ... modal UI → R3" — otvorljivi deo nije isporučen, samo skladištenje/izmena.)_
- **Uticaj:** Monter/vođa montaže i menadžment na terenu koji u 1.0 jednim klikom otvore glavni sklopni crtež RN-a; u 3.0 ga ne vide iz plana i moraju ga tražiti van modula (ili preko pojedinačnih „povezanih crteža" faza, ako je isti broj tamo dodat).
- **Verifikator:** assemblyDrawingNo postoji samo kao plain <input> u meta-modals.tsx:484 i prosleđuje se u upsert (plan-tab.tsx:606); grep kroz frontend/src/app/montaza ne nalazi nijedan chip/otvaranje PDF-a za assemblyDrawingNo. Ironično, infrastruktura postoji (DrawingChip + fetchDrawingSignedUrl u phase-card.tsx:23) ali je ožičena isključivo za 'povezane crteže' faza (phase-card.tsx:273, plan-tab.tsx:1285) — glavni sklopni crtež se ne prikazuje ni otvara iz plana, read-only monter ga ne vidi.

#### ⚪ MONTAZA-03 — PDF Gantta gubi mašinska/elektro razliku i legendu tipa
*NISKO · effort S · stampa-pdf · verdikt: CONFIRMED*

- **1.0:** exportModal.exportGanttAsPDF crta elektro trake sa SVG šrafurom (PDF_ELEC_HATCH) preko boje lokacije i u headeru crta vektorsku legendu „Masinska (solid) / Elektro (šrafirano)" (_drawTypeLegend), da se u štampi razlikuje tip faze. _(‎src/ui/planMontaze/exportModal.js:46-50 (PDF_ELEC_HATCH_SVG), :321-327 (hatch na elektro ćelije u klonu), :396-472 (_drawTypeLegend header legenda).)_
- **3.0:** gantt-pdf.ts crta trake isključivo doc.setFillColor(lokacijska_boja) bez ikakve elektro/mašinska razlike i bez legende tipa — u PDF-u su elektro i mašinske faze vizuelno identične. (Na ekranu gantt-chart.tsx elektro ima suptilan inset beli shadow, ali se u PDF ne prenosi.) _(‎frontend/src/lib/plan-montaze/gantt-pdf.ts:133-142 — jedini fill je lokacijska boja; nema grananja po phaseType ni crtanja legende. Ceo fajl (163 linije) nema reč 'elec'/'hatch'/'legend'.)_
- **Uticaj:** PM/kooperant koji čita odštampan gantogram — ne razlikuje elektro od mašinskih faza kao u 1.0 štampi; boja lokacije ostaje, pa je gubitak informacije parcijalan.
- **Verifikator:** gantt-pdf.ts:138 puni trake isključivo hexToRgb(locationColor(p.location)) bez ikakvog grananja po phaseType; ceo fajl (163 linije) nema 'elec'/'hatch'/'legend', a grep kroz lib/plan-montaze za te termine ne vraća hit. phaseType postoji u modelu (export.ts:73 razlikuje Elektro/Mašinska) ali PDF gantt ga ne koristi ni za šrafuru ni za legendu.

### Projektovanje / Projektni biro (PB) — pb_tasks (plan/gantt/kanban/analiza), izveštaji rada, opterećenje, saveti (eng-tips), podešavanja/notifikacije, nacrti

#### 🟡 PB-PROJEKTOVANJE-01 — Notifikacije PB (rok/preopterećenje/blokirano/kašnjenje/bez inženjera) — 3.0 ima samo ekran za podešavanje, ali NEMA sopstveni motor koji ih generiše i šalje
*SREDNJE · effort L · automatika · verdikt: CONFIRMED*

- **1.0:** 1.0 ima kompletan lanac automatike: pg_cron posao 'pb-enqueue-notifications' (svaki dan u 07:00) zove RPC public.pb_enqueue_notifications() koji skenira pb_tasks i po pravilima iz pb_notification_config (deadline_warning_days, overload_threshold_pct, notify_on_blocked/overload/deadline_warning/deadline_overdue/no_engineer, tihi sati, digest) upisuje poruke u pb_notification_log; zatim Edge funkcija supabase/functions/pb-notify-dispatch/index.ts (service_role, Resend API, RESEND_FROM 'Projektni biro <obavestenja@servoteh.com>') dequeue-uje i šalje mejlove primaocima (email_recipients). Admin sve to podešava u tabu Podešavanja. _(‎sql/migrations/add_pb_notifications.sql (funkcije pb_enqueue_notifications, pb_dispatch_dequeue/mark_sent/mark_failed + cron.schedule 'pb-enqueue-notifications' '0 7 * * *' na liniji 447); supabase/functions/pb-notify-dispatch/index.ts (224 linije, Resend send); src/ui/pb/podesavanjaTab.js (ceo config UI); src/services/pb.js getPbNotifConfig/updatePbNotifConfig)_
- **3.0:** 3.0 ima PUN paritet KONFIGURACIONOG ekrana (podesavanja-tab.tsx: svi notify toggle-ovi, quiet hours, digest, deadline_warning_days, overload_threshold_pct, email primaoci) i backend PATCH/GET za pb_notification_config. ALI motor koji GENERIŠE i ŠALJE poruke NE postoji u 3.0 — backend PB service to eksplicitno prepušta legacy sloju ('dispatch OSTAJE 1.0 pozadina — §0.1'). Nema NestJS @Cron/scheduler-a niti enqueue/dispatch logike za PB. Radi DANAS jedino zato što legacy Supabase pg_cron + Edge funkcija i dalje rade nad istom (sy15/glavnom) bazom; kad se 1.0/Supabase ugasi (F5 gašenje), dnevni mejlovi tiho prestaju a admin u 3.0 i dalje vidi 'uključeno' i menja primaoce misleći da radi. _(‎grep '@Cron|scheduler|pb.*dispatch|pb_notif|deadline_warning|notify_on' po backend/src — jedini pogoci su config DTO/controller/service (bez motora); backend/src/modules/projektni-biro/projektni-biro.service.ts komentari na linijama 294 i 691 doslovno: 'dispatch OSTAJE 1.0 pozadina (§0.1)'; nijedan syncer/worker/cron u backend/src ne pominje pb_notification_log ni pb_enqueue_notifications; pretraga 'RESEND|obavestenja@servoteh|pb-notify' po backend/src bez rezultata za PB)_
- **Uticaj:** Rukovodilac PB / admin projektnog biroa i inženjeri: dnevna upozorenja pred rok, kašnjenja, preopterećenost, blokirani i zadaci bez inženjera. Danas rade preko legacy infrastrukture; postaju skriveni blocker za gašenje 1.0 — u trenutku isključenja Supabase Edge/pg_cron mejlovi prestaju bez ikakvog signala, a ekran za podešavanja ostaje 'živ' i vara korisnika.
- **Verifikator:** Motor za PB notifikacije stvarno ne postoji u 3.0: grep '@Cron|scheduler|ScheduleModule' po backend/src = 0 pogodaka, a jedini fajlovi koji pominju pb_notification/pb_enqueue su config service/spec (projektni-biro.service.ts) i legacy authz-snapshot SQL — nijedan worker/cron. Service eksplicitno dokumentuje deferral: projektni-biro.service.ts:294 i :691 'dispatch OSTAJE 1.0 pozadina (§0.1)'. 3.0 ima samo GET/PATCH pb_notification_config; generisanje/slanje (pg_cron + Edge pb-notify-dispatch) ostaje na legacy Supabase. Intencionalno je (§0.1) i danas radi preko 1.0, ali motor u 3.0 zaista nedostaje i tiho će pasti pri F5 gašenju.

#### ⚪ PB-PROJEKTOVANJE-02 — CSV izvoz plana izostavlja kolonu 'Kašnjenje (d)'
*NISKO · effort S · export · verdikt: CONFIRMED*

- **1.0:** Izvoz trenutnog (filtriranog+sortiranog) prikaza plana u CSV nudi 17 kolona, uključujući 'Trajanje (rd)' i 'Kašnjenje (d)' (delayRealEnd) pored svih polja zadatka. _(‎src/ui/pb/planTab.js:1086-1122 exportCurrentViewToCsv — headers sadrže '...Trajanje (rd)','Norma (h/dan)','Završenost %','Kašnjenje (d)','Problem'; delay = delayRealEnd(t) na liniji 1099/1116)_
- **3.0:** 3.0 ima CSV izvoz (dugme 'CSV', Download ikona) sa 16 kolona — sadrži Trajanje (rd) i Završenost %, ali NE i 'Kašnjenje (d)'. Kolona kašnjenja je izbačena; header ide 'Norma (h/dan)','Završenost %','Problem'. _(‎frontend/src/app/pb/_components/plan-tab.tsx:285-334 exportCsv — header niz nema 'Kašnjenje'; poslednje tri kolone su 'Norma (h/dan)','Završenost %','Problem'. Poređeno 1:1 sa 1.0 listom kolona.)_
- **Uticaj:** Rukovodilac/planer koji izvozi plan u Excel radi analize kašnjenja mora ručno da računa kašnjenje; gubi se kolona koja je u 1.0 bila deo istog izveza.
- **Verifikator:** plan-tab.tsx:286-303 exportCsv header ima 16 kolona i završava se sa 'Trajanje (rd)','Norma (h/dan)','Završenost %','Problem' — nema kolone 'Kašnjenje (d)'. Grep 'Kašnjenje|delay|delayRealEnd' po frontend/src/app/pb daje samo podesavanja-tab.tsx (label 'Kašnjenje roka' u notif configu), nijedan delay-računat izlaz u CSV; funkcija računa samo workDaysBetween za trajanje. Kolona kašnjenja iz 1.0 (delayRealEnd) je izostavljena.

#### ⚪ PB-PROJEKTOVANJE-03 — Gantt: uži vremenski horizont i nema fine 'dan' zumove kao u 1.0
*NISKO · effort M · ergonomija · verdikt: CONFIRMED*

- **1.0:** Gantt tab ima 4 nivoa zuma: 'day' (2 meseca, 28px/dan, zaglavlje po danima — najpreciznije za drag datuma), 'week' (4 meseca), 'month' (12 meseci) i 'quarter' (24 meseca — pregled cele godine i više). Drag pomeranje traka radi pouzdano na 'day' zumu. _(‎src/ui/pb/ganttTab.js:11-15 ZOOM_CONFIG {day:{months:2,dayWDesktop:28}, week:{months:4}, month:{months:12}, quarter:{months:24}}; komentar linija 175 'Drag radi pouzdano samo na day zumu')_
- **3.0:** 3.0 Gantt ima drag plan-traka (PB_EDIT, pomera oba datuma) i 3 prozora: 'Mesec' (1), 'Kvartal' (3), '6 meseci' (6). Maksimalni horizont je 6 meseci (naspram 24 u 1.0 quarter), a nema zasebnog fino-zumiranog 'dan' prikaza sa širim ćelijama. Drag i osnovni rad postoje, ali dugoročno planiranje projekta preko godine i precizno vizuelno pozicioniranje su osiromašeni. _(‎frontend/src/app/pb/_components/gantt-tab.tsx:22-24 WINDOWS [{key:'1',label:'Mesec'},{key:'3',label:'Kvartal'},{key:'6',label:'6 meseci'}]; DRAG_THRESHOLD_PX i dragRef postoje (drag radi), ali nema months>6 ni day-cell zoom-a)_
- **Uticaj:** Inženjer/planer PB pri planiranju višemesečnih/godišnjih projekata: ne može da vidi ceo tok projekta u jednom Gantt pregledu (max 6 meseci) niti da fino zumira na dan radi preciznog drag-a.
- **Verifikator:** gantt-tab.tsx:21-24 WINDOWS = [{key:'1',Mesec,months:1},{key:'3',Kvartal,months:3},{key:'6',6 meseci,months:6}] — maksimalni horizont 6 meseci, bez months>6 (naspram 1.0 quarter=24) i bez zasebnog fino-zumiranog 'day' prikaza sa širim ćelijama (28px/dan). Drag postoji (dragRef/DRAG_THRESHOLD_PX u istom fajlu), ali dugoročni pregled i day-zoom su osiromašeni u odnosu na 1.0 ZOOM_CONFIG (day/week/month/quarter).

### Proizvodnja / Praćenje proizvodnje / Plan proizvodnje / Pogon

#### 🟡 PROIZVODNJA-PRACENJE-01 — Promocija akcione tačke u operativnu aktivnost vraća 501 (dugme radi, backend ne)
*SREDNJE · effort L · funkcionalnost · verdikt: CONFIRMED*

- **1.0:** U Tab2 „Operativni plan" dugme „Iz akcione tačke" (promoteAkcionaTackaModal.js) otvara modal, bira akcionu tačku iz sastanka/akcionog plana + odeljenje, i kreira operativnu aktivnost vezanu za tu tačku (promote_akciona_tacka RPC). Koordinator time ubacuje zaključke sa sastanka direktno u plan proizvodnje bez ručnog prekucavanja. _(‎src/ui/pracenjeProizvodnje/promoteAkcionaTackaModal.js (ceo tok: izbor akcije + odeljenja → showToast('Akciona tačka promovisana')); tab2OperativniPlan.js:55 dugme #promoteAkcijaBtn; tab2OperativniPlan.js:95-97 wire openPromoteAkcionaTackaModal.)_
- **3.0:** FE je 1:1 prenet (promote-modal.tsx + usePromoteAkcionaTacka + akcione-tacke lookup rade), ali backend endpoint POST /aktivnosti/promote svesno vraća NotImplementedException (501). Korisnik vidi dugme, otvori modal, izabere tačku i dobije grešku. Zaobilaznica: ručno „+ Nova aktivnost". _(‎Proverio backend/src/modules/pracenje/pracenje.service.ts:497-505 (promoteAkcionaTacka → throw new NotImplementedException) i pracenje.controller.ts:185-189; FE postoji: frontend/src/app/pracenje-proizvodnje/_components/promote-modal.tsx + usePromoteAkcionaTacka u api/pracenje.ts:566. Razlog: akcioni-plan/Sastanci još žive u sy15 sa uuid ključevima.)_
- **Uticaj:** Koordinatori/PM koji vode operativni plan sa sastanaka: gube brzu vezu sastanak→plan, moraju ručno da unose aktivnost. Retko-srednje često; postoji zaobilaznica.
- **Verifikator:** pracenje.service.ts:502-507 promoteAkcionaTacka baca NotImplementedException (501); ruta postoji ali ne radi — pracenje.controller.ts:186-190 @Post('aktivnosti/promote'). Jedini sy15 ostatak je LOOKUP (pracenje-akcije-sy15.service.ts:30 akcioneTacke, feed za picker), NE sama promocija — nema alternativne implementacije nigde. Funkcija je radila u 1.0, u 3.0 dugme daje grešku (regresija, ne 'i dalje radi na starom'), pa nije OUT-OF-SCOPE nego stvarni gap.

#### ⚪ PROIZVODNJA-PRACENJE-02 — Praćenje više nije uživo (supabase realtime) — svedeno na polling na 30 s
*NISKO · effort M · ergonomija · verdikt: CONFIRMED*

- **1.0:** RN prikaz i operativni plan su se osvežavali UŽIVO preko supabase realtime pretplate (startRealtime): čim neko prijavi operaciju, izmeni aktivnost ili status, ostali korisnici to vide odmah. Bitno kad više ljudi u pogonu/koordinaciji gleda isti nalog istovremeno. _(‎src/ui/pracenjeProizvodnje/podsklopoviTree.js:236 i tabelaPracenjaTab.js:653 pozivaju startRealtime() posle loadPracenje; state realtime pretplata na production tabele.)_
- **3.0:** 3.0 ne koristi realtime kanal — svi upiti se osvežavaju TanStack Query refetchInterval-om od 30 s. Izmena drugog korisnika se vidi tek posle do 30 s. Dokumentovano u kodu kao „paritet", ali je funkcionalno degradacija u odnosu na instant 1.0. _(‎frontend/src/api/pracenje.ts:13 komentar „Realtime = polling na 30 s (paritet 1.0)", :344 POLL_MS = 30_000, refetchInterval na usePortfolio/useRn/useOperativniPlan. Nema WebSocket/EventSource/supabase.channel u frontend/src/app/pracenje-proizvodnje ni api/pracenje.ts.)_
- **Uticaj:** PM/koordinatori i pogon koji istovremeno gledaju isti RN: do 30 s zaostatka za tuđim izmenama. Nema gubitka podataka, samo latencija.
- **Verifikator:** Nema realtime kanala: grep za realtime/supabase.channel/WebSocket/EventSource/startRealtime u frontend/src/app/pracenje-proizvodnje = 0 pogodaka, a api/pracenje.ts:13 eksplicitno kaže 'Realtime = polling na 30 s (paritet 1.0)' uz POLL_MS=30_000 (:344) i refetchInterval na 4 hooka (:351,:359,:385,:394). Instant osvežavanje iz 1.0 svedeno na polling — degradacija potvrđena.

### Sastanci + AI

#### ⚪ SASTANCI-01 — Akcije jednog sastanka (detalj) — nema CSV export, nema Štampaj, ni filter Prikaži završeno
*NISKO · effort S · export · verdikt: CONFIRMED*

- **1.0:** 1.0 detalj-tab akcija (sastanakDetalj/akcijeTab.js) u toolbaru ima tri kontrole: dugme CSV (exportCsv → CSV sa BOM, ime akcije_<datum>.csv), dugme Štampaj (printAkcije → otvara print-prozor sa akcionim planom grupisan po RN-u i window.print()) i toggle Prikaži završeno čije se stanje pamti u localStorage (podrazumevano sakriva završene zadatke da lista tokom sastanka ne bude zatrpana). _(‎src/ui/sastanci/sastanakDetalj/akcijeTab.js: linije 239-240 (#aiPrint Štampaj, #aiCsv CSV), 303-304 (wiring exportCsv/printAkcije), 654-692 (exportCsv/printAkcije impl.), komentar l.10 (Prikaži završeno, Export CSV, Štampaj — view podešavanja se pamte u localStorage).)_
- **3.0:** 3.0 komponenta DetaljAkcije ima samo: + Nova akcija, + Zadatak po grupi, Započni/Završi/Izmeni/Obriši po redu. Nema CSV, nema Štampaj, nema filter završenih (svi zadaci uključujući zavrsen se uvek prikazuju). Zaobilaznica postoji: globalni tab Akcioni plan IMA i CSV i Štampaj, a zapisnik PDF ionako sadrži ceo akcioni plan po RN-u. _(‎Pročitao ceo frontend/src/app/sastanci/_components/detalj-akcije.tsx (156 lin.) — u toolbaru samo Button + Nova akcija. Grep csv|CSV|Štampaj|print|zavrseno|export nad detalj-akcije.tsx = 0 pogodaka. Potvrđeno da globalni akcioni-plan-tab.tsx importuje printAkcije iz @/lib/sastanci-print i exportAkcijeCsv iz @/lib/sastanci-csv (l.32-33, dugmad l.238-242) — funkcije postoje ali nisu izložene u per-sastanak prikazu.)_
- **Uticaj:** Vođa sastanka/zapisničar koji tokom sastanka želi da izveze ili odštampa akcioni plan baš tog sastanka mora da ode na globalni tab Akcioni plan i tamo ručno filtrira; takođe u per-sastanak listi ne može da sakrije završene zadatke.
- **Verifikator:** Pročitao ceo detalj-akcije.tsx (156 lin.) — toolbar ima samo '+ Nova akcija' i po-grupi '+ Zadatak'; nema CSV, Štampaj ni filter završenih (grep csv|štampa|print|zavrsen|export nad detalj-akcije.tsx = 0). Funkcije POSTOJE ali samo u globalnom akcioni-plan-tab.tsx (l.32-33 import printAkcije/exportAkcijeCsv, l.144-145 poziv), ne u per-sastanak prikazu — dakle gap u detalju je stvaran (zaobilaznica preko globalnog taba/zapisnik PDF potvrđena).

#### ⚪ SASTANCI-02 — Nema globalnog brzog unosa teme (quick-add FAB) dostupnog sa svake stranice
*NISKO · effort M · ergonomija · verdikt: CONFIRMED*

- **1.0:** 1.0 ima plutajuće dugme/modal za brzi unos PM teme (quickAddTemaButton.js — openQuickAddTemaModal): mini-forma sa naslovom, projekat/RN pickerom, izborom ciljnog sastanka i checkboxovima Hitno i Za razmatranje (admin). Ideja je brzo hvatanje teme za razmatranje sa bilo kog ekrana, bez navigacije na PM teme tab. _(‎src/ui/sastanci/quickAddTemaButton.js: l.13 fabMounted (globalni FAB), l.21 openQuickAddTemaModal, l.33 sast-modal--fabtema, l.51 projekatId select, l.53-54 checkbox Hitno / Za razmatranje, l.57 sastanakId select.)_
- **3.0:** 3.0 ima tema-modal.tsx (ekvivalentna forma za temu), ali se otvara samo iz PM teme taba; ne postoji globalni plutajući quick-add dugme dostupno iz drugih tabova/ekrana. Unos teme uvek zahteva navigaciju na PM teme tab pa otvaranje modala. _(‎grep QuickAdd|Brza tema|Brzi unos teme|quickAddTema|openQuickAdd nad celim frontend/src = jedini pogodak je tema-modal.tsx (obična tema forma). grep fab|floating|position: fixed...tema nad src/ = 0 pogodaka. Potvrđeno da je tema-modal.tsx invociran iz pm-teme-tab.tsx, ne kao globalni FAB.)_
- **Uticaj:** Korisnik (menadžment/PM) koji se seti teme dok radi u drugom tabu modula mora prvo da ode na PM teme tab da bi je uneo — gubi se brzina hvatanja ideja koju je 1.0 FAB davao. Zaobilaznica postoji (PM teme tab).
- **Verifikator:** TemaModal se invocira jedino iz pm-teme-tab.tsx (l.136); nema globalnog plutajućeg quick-add dugmeta (grep fab|floating|position:fixed|QuickAdd u sastanci = jedini fixed je command-palette.tsx overlay). Command palette (Ctrl+K) je samo PRETRAGA sastanaka/akcija (l.9-11, searchSastanci), ne unos teme — pa ne nadomešta 1.0 FAB. Unos teme uvek traži navigaciju na PM teme tab.

### AI asistent

#### ⚪ AI-CHAT-01 — Desktop welcome ekran nema klikabilni predlog pitanja (suggestion chip)
*NISKO · effort S · ergonomija · verdikt: CONFIRMED*

- **1.0:** Na praznom ekranu (nova nit) 1.0 desktop prikazuje ispod pozdrava klikabilan predlog u obliku 'čipa': dugme '.aich-suggest' sa data-suggest='Daj mi status godišnjeg odmora sa danima koje sam koristio u ovoj godini.' — klik odmah popuni polje i pošalje pitanje (msgsEl click handler → ta.value=... ; void send()). Time neiskusan korisnik jednim klikom dobija najkorišćeniju funkciju (go_pregled alat) bez kucanja. _(‎src/ui/aiAsistent/index.js renderMsgs() (linije 306-308): '.aich-suggest-wrap' + '.aich-suggest' data-suggest; click handler na msgsEl (linije 426-429): e.target.closest('[data-suggest]') → ta.value = ... ; void send().)_
- **3.0:** 3.0 welcome blok je samo statičan tekst ('Ja sam ServoSync AI asistent. Pitaj me o godišnjem, satima...') bez ijednog klikabilnog predloga. Korisnik mora sam da formuliše pitanje. _(‎frontend/src/app/ai/_components/ai-chat.tsx linije 242-249 (welcome grana) — nema dugmadi, samo <p> tekst. Grep 'suggest|data-suggest|predlog' po frontend/src/app/ai/ = 0 pogodaka. Backend nema veze (čist FE UX).)_
- **Uticaj:** Svi zaposleni (posebno oni koji retko koriste AI) — na prvom otvaranju gube 'jedan klik' prečicu za najčešće pitanje (status godišnjeg). Posao se i dalje završi kucanjem.
- **Verifikator:** Welcome grana u frontend/src/app/ai/_components/ai-chat.tsx (linije 242-249) je samo <p> tekst; nema nijednog dugmeta/čipa. Grep 'suggest|predlog|data-suggest' po frontend/src daje 31 fajl ali NIJEDAN pod app/ai/ (svi u zahtevi/kadrovska/lokacije/sastanci). Klikabilni predlog stvarno fali.

#### ⚪ AI-CHAT-02 — Podnaslov (subtitle) osiromašen — ne prikazuje aktivni engine ni 'vide svi' napomenu deljene niti
*NISKO · effort S · ergonomija · verdikt: CONFIRMED*

- **1.0:** 1.0 podnaslov je informativan i menja se: lična nit → '<Engine> · interno · istorija se čuva' (npr. 'Claude · interno · istorija se čuva'); deljena projektna nit → '9400/7 · deljena nit — vide svi'. Korisnik u svakom trenutku vidi koji model priča i (u projektnoj niti) jasno upozorenje da poruke vide SVI prijavljeni. _(‎src/ui/aiAsistent/index.js updateSub() (linije 253-258): ref → '${ref} · deljena nit — vide svi'; inače '${label} · interno · istorija se čuva' gde label = aktivni AI_ENGINES.label. Mobilni myAi.js updateSub() (194-199) prikazuje '${label} · interno'.)_
- **3.0:** 3.0 podnaslov je fiksan: lična nit prikazuje samo 'interno' (ne ime engine-a), a deljena nit '${projectRef} · deljena nit' (bez '— vide svi' upozorenja). Ostaje samo dinamični '· još X poruka danas' kad je remaining<=10. _(‎frontend/src/app/ai/_components/ai-chat.tsx linije 214-217: {projectRef ? `${projectRef} · deljena nit` : 'interno'} + remaining. Nema referencue na `engine`/ENGINE_LABEL u subtitle-u; grep 'istorija se čuva'/'vide svi' po frontend/ = 0 pogodaka.)_
- **Uticaj:** Svi korisnici — slabija svest o tome koji model odgovara; u projektnoj (deljenoj) niti izostaje eksplicitno 'vide svi' upozorenje pa korisnik može nesvesno napisati nešto što nije za sve. Zaobilaznica: engine se vidi na prekidaču iznad.
- **Verifikator:** Subtitle (ai-chat.tsx 214-217) je fiksno {projectRef ? `${projectRef} · deljena nit` : 'interno'} + remaining — bez imena engine-a i bez '— vide svi'; grep 'vide svi'/'istorija se čuva' = 0 pogodaka. Engine se vidi samo na prekidaču (linije 224-237, ENGINE_LABEL), što je sama primedba priznala kao zaobilaznicu, dok upozorenje 'vide svi' potpuno izostaje.

### ZARADE / OBRAČUN

#### ⚪ ZARADE-01 — JMBG i „Tip rada" ne izlaze na payslip PDF-u (obračun zarade)
*NISKO · effort S · stampa-pdf · verdikt: CONFIRMED*

- **1.0:** 1.0 _buildPayslipBody (salaryPayrollTab.js:888-957) u meta blok obračuna štampa JMBG reda (`showJmbg ? emp.personalId`) i „Tip rada" (`emp.workType`) — čitane iz kadrovskaState.employees. Payslip time izgleda kao zvaničniji dokument (JMBG identifikuje zaposlenog). _(‎src/ui/kadrovska/salaryPayrollTab.js linije 906-956: `const showJmbg = !!(emp?.personalId)`, `${showJmbg ? ...JMBG...}` i `${emp?.workType ? ...Tip rada...}` u .meta gridu.)_
- **3.0:** 3.0 payslip.ts prima opcioni `jmbg` param ali ga pozivalac (obracun-view.tsx pdfOne/pdfAll) NE prosleđuje — poziva `generatePayslipPdf({ row: m, employeeName })` bez jmbg, a v_salary_payroll_month red ne nosi personal_id (PII). Meta blok payslip.ts (linije 84-90) ima samo Zaposleni/JMBG(uslovno)/Radno mesto/Odeljenje/Tip ugovora — bez „Tip rada". Rezultat: JMBG i Tip rada nikad ne izlaze. _(‎Pročitao frontend/src/lib/hr-pdf/payslip.ts (meta blok l.84-106, param jmbg l.17-19) i obracun-view.tsx pdfOne l.490-495 / pdfAll l.497-512 (nema jmbg u PayslipRow). Grep `personalId|personal_id|jmbg|workType|Tip rada` u zarade komponentama — jmbg param definisan ali nepopunjen; workType nigde u payslipu.)_
- **Uticaj:** Administrator (Nenad/Nevena) pri predaji štampanog obračuna zaposlenom; obračun je informativnog karaktera pa JMBG nije nužan, ali 1.0 verzija je delovala zvaničnije.
- **Verifikator:** Potvrđeno: payslip.ts ima opcioni `jmbg?` param (l.18) i uslovni JMBG red u meta bloku (l.86), ALI pozivaoci ga NIKAD ne prosleđuju — pdfOne (obracun-view.tsx:492) i pdfAll (l.504) zovu `generatePayslipPdf({ row, employeeName })` bez jmbg, pa `input.jmbg || ''` (l.252/263) uvek daje prazno i JMBG red se ne iscrtava. „Tip rada" (work_type) je potpuno odsutan iz payslip.ts — meta blok (l.84-90) ima samo Zaposleni/JMBG/Radno mesto/Odeljenje/Tip ugovora(salary_type); grep `workType|work_type|Tip rada` u payslip.ts nema pogodaka (postoji u dossier.tsx:165, grid, employee-form, ali ne u obračunu zarade). Rezultat na štampi: ni JMBG ni Tip rada ne izlaze. Napomena: JMBG ima poluspremljenu infrastrukturu (param + render), samo nije povezan — trivijalno bi se popunio preko fetchEmployeePii uz canPii guard kao u saldo-tab.tsx:147; work_type nema ni skele.

#### 🟡 ZARADE-02 — Grid mesečnog obračuna ne prikazuje K3.3 totale uživo za draft redove (traži klik „Obračunaj iz grida")
*SREDNJE · effort L · ergonomija · verdikt: CONFIRMED*

- **1.0:** 1.0 na svakom učitavanju perioda poziva refreshPayrollComputationContext (salaryPayrollTab.js:224-228) i computeDisplayTotals radi PUN K3.3 obračun na FE (mirror engine payrollCalc.js) — grid i payslip ODMAH posle „Pripremi mesec" pokazuju tačan ukupni RSD/EUR/II deo sa prekovremenim, praznikom, bolovanjem 65/100% i proporcijom za neplaćeno, bez dodatnog koraka. _(‎src/services/salaryPayroll.js computeDisplayTotals + refreshPayrollComputationContext; salaryPayrollTab.js:456-459 `preview.payrollK33 ? preview.totalRsd : r.totalRsd` u rowHtml i _buildPayslipBody l.894-898.)_
- **3.0:** 3.0 svesno NE duplira K3.3 engine na FE (calc.ts komentar l.1-4: „Autoritativni K3.3 obračun je BE; FE NE duplira engine"). displayTotals (obracun-view.tsx:84-102) za ne-dirty red vraća `payslipTotals(row)`, koji koristi K3.3 (ukupna_zarada) SAMO ako je `ukupna_zarada>0` (payslip.ts:32-40) — inače prost trigger total (fiksna+prevoz+dnevnice). Za sveže init-ovan draft red bez pokrenutog „Obračunaj iz grida" grid i payslip pokazuju POJEDNOSTAVLJEN total dok se dugme ne klikne. _(‎Pročitao obracun-view.tsx displayTotals l.83-102 + payslipTotals u payslip.ts l.31-40 (useK33 zahteva ukupna_zarada>0); calc.ts l.1-4 i computeLiveTotals l.160-177 (prost total, bez razlaganja sati). Uporedio sa 1.0 computeDisplayTotals tokom. Recompute dugme postoji u obe verzije, ali 1.0 ima i live preview pre klika.)_
- **Uticaj:** Administrator koji obračunava zarade: mora eksplicitno kliknuti „↻ Obračunaj iz grida" da bi video tačan K3.3 total; pre toga prikazani iznosi su niži/pogrešni (bez prekovremenih/praznika/bolovanja). Rizik od greške ako se preskoči korak. Namerna arhitektonska odluka (BE autoritativan), pa je ovo pre svesni kompromis nego bag.
- **Verifikator:** Potvrđeno kao svesni arhitektonski kompromis (nije skriveno drugde): calc.ts eksplicitno ne duplira K3.3 engine na FE, a displayTotals (obracun-view.tsx:84-102) za ne-dirty red vraća payslipTotals(row), koji useK33 uslovljava sa `compensation_model && ukupna_zarada>0` (payslip.ts:33). Za sveže init-ovan draft red (ukupna_zarada=0 pre recompute) i grid i chips prikazuju POJEDNOSTAVLJEN total (fiksna+prevoz+dnevnice, bez razlaganja prekovremeni/praznik/bolovanje). Tačan K3.3 total se dobija tek klikom „↻ Obračunaj iz grida" (dugme l.553 → usePayrollRecompute, motor u BE). Live K3.3 preview pre klika koji 1.0 ima (computeDisplayTotals) genuino NE postoji u 3.0 — nije prebačen na FE niti ga BE vraća bez persist recompute-a. Realan funkcionalni jaz, iako je namerna odluka (BE autoritativan).

### Moj profil + Godišnji odmori (GO)

#### 🟠 PROFIL-GO-01 — Plaćeno odsustvo — izgubljen strukturisan katalog osnova + godišnji fond od 5 dana (samo slobodan tekst)
*VISOKO · effort M · funkcionalnost · verdikt: CONFIRMED*

- **1.0:** Modal 'Zahtev za plaćeno odsustvo' ima <select> sa katalogom od 9 zakonskih osnova (sklapanje braka, porođaj/rođenje deteta, teža bolest uže porodice, elementarna nepogoda, selidba isto/drugo mesto, polaganje ispita — u okviru fonda od najviše 5 radnih dana; smrt uže porodice, davanje krvi, drugo — van fonda), svaki sa propisanim maxDays u labeli, grupisano u optgroup 'fond' vs 'van fonda', uz jasnu napomenu da osnovi iz fonda dele najviše 5 radnih dana u kalendarskoj godini (čl. 35). _(‎src/services/paidLeaveRequests.js:19-47 (PAID_LEAVE_CATALOG, PAID_LEAVE_FOND_ANNUAL_CAP, PAID_LEAVE_FOND_CODES); src/ui/mojProfil/index.js:1638-1657 (optgroup + maxDays render, cap objašnjenje))_
- **3.0:** Osiromašeno: modal ima obično slobodno tekstualno polje 'Osnov' (<Input maxLength=40>) bez ikakvog kataloga, grupisanja fond/van-fonda, maxDays limita ni objašnjenja godišnjeg fonda od 5 dana. Zaposleni tipka proizvoljan tekst; BE upisuje leave_type kao slobodan string. Katalog POSTOJI u 3.0 ali samo na HR strani (odsustva/shared.ts), profil ga ne koristi — a HR odobravanje mapira po kodovima (PAID_LEAVE_LABEL), pa slobodan tekst ne dobija labelu i ne ulazi u praćenje fond-kvote. _(‎Tražio 'PAID_LEAVE_CATALOG|leave_type|osnov' kroz frontend/backend: frontend/src/app/profil/_components/makeup-paidleave-section.tsx:277-278 (free-text Input 'Osnov'); katalog postoji u frontend/src/app/kadrovska/_components/odsustva/shared.ts:80-93 ali nije uvezen u profil; BE moj-profil.service.ts:850-856 upisuje leaveType kao tekst; spec koristi kod 'brak' (moj-profil.mutations.spec.ts:220) → potvrda da BE očekuje kodove.)_
- **Uticaj:** Svaki zaposleni koji traži plaćeno odsustvo + HR (Kadrovska) pri odobravanju: neusklađen unos (slobodan tekst umesto koda) razbija labeliranje i praćenje zakonskog fonda od 5 radnih dana; gubi se pravna preciznost osnova (čl. 35 ZoR).
- **Verifikator:** makeup-paidleave-section.tsx:277-279 PaidLeaveModal koristi slobodan <Input maxLength=40> za 'Osnov', bez kataloga/optgroup/maxDays/fond-cap; katalog PAID_LEAVE_CATALOG postoji samo u kadrovska/_components/odsustva/shared.ts:80-91 i grep potvrđuje da nije uvezen u /profil; BE moj-profil.service.ts:854 upisuje leaveType kao slobodan string.

#### 🟡 PROFIL-GO-02 — Tabela GO zahteva ne prikazuje razlog odbijanja / odgovor HR-a
*SREDNJE · effort S · funkcionalnost · verdikt: CONFIRMED*

- **1.0:** Kolona 'Odgovor HR-a': za odbijene zahteve prikazuje rejectionNote (💬 skraćen tekst sa full-title tooltipom), a inače ime osobe koja je pregledala (reviewedBy). Zaposleni jasno vidi ZAŠTO je zahtev odbijen. _(‎src/ui/mojProfil/index.js:1307-1311 (rejectionNote render), 1324 (th 'Odgovor HR-a'))_
- **3.0:** Tabela 'Moji zahtevi' ima samo kolone Od / Do / Dana / Status / Napomena / akcije. Nema kolone za razlog odbijanja ni pregledaoca — iako BE vraća rejection_note (SELECT * iz vacation_requests). Odbijeni zaposleni ne vidi obrazloženje u aplikaciji. _(‎frontend/src/app/profil/_components/vacation-section.tsx:87-95 (definicija kolona — bez rejection_note/reviewed_by); BE vraća pun red: backend/src/modules/moj-profil/moj-profil.service.ts:151-152)_
- **Uticaj:** Zaposleni čiji je GO odbijen: mora da traži HR usmeno/mejlom da sazna razlog, iako je podatak već u bazi.
- **Verifikator:** vacation-section.tsx:88-95 kolone su samo Od/Do/Dana/Status/Napomena/akcije; kolona 'Napomena' renderuje r.note (sopstvena napomena, ne odgovor HR-a), a grep za rejection_note/reviewed_by/rejectionNote u frontend/src/app/profil ne vraća nijedan pogodak — razlog odbijanja se ne prikazuje iako BE vraća pun red (SELECT *).

#### 🟡 PROFIL-GO-03 — GO saldo/zahtev — nema akrualnog 'preostalo do danas' ni avans (CEO/CFO) upozorenja i markera
*SREDNJE · effort M · automatika · verdikt: CONFIRMED*

- **1.0:** Saldo kartica koristi daysRemainingAccrued ('preostalo do danas' = preneto + zarađeno do danas − iskorišćeno − planirano) i prikazuje planirano zasebno. U modalu, ako je (iskorišćeno/committed + traženo) > zarađeno do danas, prikazuje '🛫 Avans — odobravaju CEO/CFO' i automatski dodaje marker '[AVANS — preko zarađenog, odobravaju CEO/CFO]' u napomenu da approveri to vide. _(‎src/ui/mojProfil/index.js:1221-1247 (daysRemainingAccrued, planirano), 2806-2822 (avans upozorenje), 2887-2898 i 2923-2926 (izračun avansa + marker u napomeni))_
- **3.0:** Saldo i modal koriste days_remaining (puno godišnje pravo, ne pro-rata do danas). Modal nema avans upozorenje ni [AVANS] marker; FE tip GoVacationBalance nema polja days_remaining_accrued/days_committed/accrual_model. BE submit blokira samo po days_remaining, bez avans logike. _(‎frontend/src/app/profil/_components/vacation-section.tsx:56,75-77 (days_remaining), 247-269 (submit bez avans grane); frontend/src/api/moj-profil.ts (samo days_earned, nema accrued/committed/accrual); backend moj-profil.service.ts:702-714 (submit provera samo days_remaining))_
- **Uticaj:** Zaposleni na akrualnom modelu vidi veći 'preostalo' nego što je stvarno zaradio do danas; uprava (CEO/CFO) gubi automatsku oznaku da je zahtev avansni — ručno ocenjivanje.
- **Verifikator:** vacation-section.tsx:56,77 saldo koristi days_remaining; VacationBalance tip u moj-profil.ts:70 ima samo days_remaining/year (nema days_remaining_accrued/days_committed/accrual_model); VacationModal (247-269) nema avans granu ni [AVANS] marker; grep za accrual/avans u /profil = 0 pogodaka; BE submit (service.ts:702-714) blokira samo po days_remaining.

#### ⚪ PROFIL-GO-04 — GO modal — nema soft napomena Pravilnika, kalendarskih dana, inline balans-upozorenja, potvrde ni uputstva za neplaćeno
*NISKO · effort S · ergonomija · verdikt: CONFIRMED*

- **1.0:** Modal uživo računa i prikazuje radne vs kalendarske dane; upozorava kad traženo > preostalo (crveni blok); napomene iz Pravilnika (čl. 5: >10 radnih dana u navratu traži odobrenje direktora; čl. 6: podnošenje bar 7 dana unapred); askConfirm pre slanja; a blokada preko salda uz uputstvo 'za neplaćeno obratite se upravi — odobrava Nenad ili Nevena Jaraković'. _(‎src/ui/mojProfil/index.js:2763-2782 (rule notes), 2789-2805 (radni/kal + balWarn), 2901-2907 (blokada + uprava), 2928-2936 (askConfirm))_
- **3.0:** Modal prikazuje samo 'Radnih dana: N · Preostalo GO: N'. Nema kalendarskih dana, nema napomena Pravilnika (čl.5/čl.6), nema inline balans-bloka pre slanja, nema potvrde pre slanja, ni uputstva za neplaćeno odsustvo (Nenad/Nevena). Blokada preko salda stiže tek kao serverska greška posle submita. _(‎frontend/src/app/profil/_components/vacation-section.tsx:238,304-307 (samo radni dani + preostalo), 247-269 (save bez confirm/rule-note); BE poruka backend/src/modules/moj-profil/moj-profil.service.ts:712-714 (bez uputstva za upravu))_
- **Uticaj:** Zaposleni koji podnosi GO: manje vođenja i preventivnih upozorenja; greške (preko salda, >10 dana, prekasno) se hvataju tek posle slanja umesto pre.
- **Verifikator:** VacationModal u vacation-section.tsx:304-307 prikazuje samo 'Radnih dana: N · Preostalo GO: N'; nema kalendarskih dana, napomena Pravilnika (čl.5/čl.6), inline balans-bloka, potvrde pre slanja (save() na 247-269 nema confirm) ni uputstva za neplaćeno; blokada salda stiže tek serverski (service.ts:712-714).

#### 🟡 PROFIL-GO-05 — Nadoknada sati i Plaćeno odsustvo — nema 'za koga' pickera (rukovodilac ne može podneti u ime člana tima)
*SREDNJE · effort S · funkcionalnost · verdikt: CONFIRMED*

- **1.0:** Modali za nadoknadu sati i plaćeno odsustvo imaju empPicker (kad korisnik sme za druge — canSubmitVacationRequestForOthers): rukovodilac bira člana tima i podnosi zahtev u njegovo ime, isto kao za GO. _(‎src/ui/mojProfil/index.js:1405-1413 (makeup empPicker), 1628-1636 (paid-leave empPicker))_
- **3.0:** Samo GO modal ima 'Za koga' picker. Makeup i paid-leave modali u profil-u nemaju picker — uvek se podnosi samo za sebe, iako BE ruta prima employeeId (submitMakeup/submitPaidLeave ga koriste). _(‎frontend/src/app/profil/_components/makeup-paidleave-section.tsx:90-107 i 242-256 (nema forEmp/pickera); BE podržava: backend/src/modules/moj-profil/moj-profil.service.ts:795-796 (makeup empId=dto.employeeId), 844-845 (paid-leave))_
- **Uticaj:** Rukovodilac/šef koji za odsutnog radnika unosi nadoknadu ili plaćeno odsustvo: mora zaobilazno preko HR/Kadrovske, iako je backend spreman za to.
- **Verifikator:** Samo VacationModal ima 'Za koga' picker (vacation-section.tsx:286-295 preko useTeam); MakeupModal (makeup-paidleave-section.tsx:90-102) i PaidLeaveModal (247-255) ne šalju employeeId niti imaju picker, iako BE prima employeeId (service.ts:795-796 makeup, 844-845 paid-leave) i API tipovi podržavaju employeeId (moj-profil.ts:523,536).

#### ⚪ PROFIL-GO-06 — Otkaži/obriši/izmena ODOBRENOG GO — generičke potvrde bez konteksta (saldo se oslobađa / vraća na ponovno odobravanje)
*NISKO · effort S · ergonomija · verdikt: CONFIRMED*

- **1.0:** 1.0 razlikuje akcije nad odobrenim zahtevom: otkazivanje/brisanje odobrenog daje poruku 'Dani se oslobađaju iz salda' / 'Akcija je trajna'; izmena odobrenog termina prikazuje istaknutu napomenu da se zahtev vraća na ponovno odobravanje. _(‎src/ui/mojProfil/index.js:567-569 (cancel confirm po statusu), 593-595 (delete confirm po statusu), 2982+2990 (willRevert napomena u edit modalu))_
- **3.0:** 3.0 koristi generički window.confirm ('Otkazati zahtev?', 'Trajno obrisati zahtev?') bez razlike da li je odobren i bez pomena oslobađanja salda; edit modal nema upozorenje da izmena odobrenog vraća zahtev na ponovno odobravanje (forceReapproval se šalje kao false, bez UI naznake). _(‎frontend/src/app/profil/_components/vacation-section.tsx:117 (cancel confirm), 125 (delete confirm), 220-283 (edit modal bez willRevert napomene))_
- **Uticaj:** Zaposleni: manje jasnoće o posledicama akcije nad već odobrenim odmorom (da se saldo vraća / da izmena poništava odobrenje).
- **Verifikator:** vacation-section.tsx:117 confirm('Otkazati zahtev?') i :125 confirm('Trajno obrisati zahtev?') su generički, bez razlike po statusu ni pomena oslobađanja salda; edit modal (220-283) nema willRevert napomenu, a reviseM se zove bez forceReapproval flag-a iz UI-a (submit na 254).

#### ⚪ PROFIL-GO-07 — Nadoknada — 'dan odmora (rad vikendom, +1 GO)' bez client validacije i bez oznake u tabeli
*NISKO · effort S · ergonomija · verdikt: CONFIRMED*

- **1.0:** Za tip 'dan_odmora' 1.0 validira da je datum rada subota ili nedelja i da je >=8h (uz jasne poruke: 'Datum rada mora biti subota ili nedelja', 'Za +1 dan odmora potrebno je najmanje 8h'); u tabeli prikazuje badge '🏖 Dan odmora (rad vikendom DD.MM)' umesto plana nadoknade i posebnu status-labelu '(+1 dan GO)'. _(‎src/ui/mojProfil/index.js:1513-1524 (weekend/8h validacija), 1354-1366 (badge + posebna status labela))_
- **3.0:** 3.0 ima opciju 'dan_odmora' i šalje je, ali FE nema vikend/8h validaciju (oslanja se samo na server); tabela nadoknada prikazuje samo absence_date i sate bez razlikovanja da li je red 'dan odmora (rad vikendom)' — gubi se vizuelna oznaka i weekend datum. _(‎frontend/src/app/profil/_components/makeup-paidleave-section.tsx:90-107 (save bez vikend/8h provere), 53-69 (tabela bez dan_odmora badge/weekend_work_date))_
- **Uticaj:** Zaposleni koji traži +1 GO za rad vikendom: greške (nije vikend / <8h) hvata tek server; u listi ne razaznaje koji red je 'dan odmora'.
- **Verifikator:** MakeupModal save() (makeup-paidleave-section.tsx:90-107) šalje compensationType='dan_odmora' bez ikakve vikend/8h client validacije (oslanja se na server); tabela nadoknada (53-69) renderuje samo absence_date i absence_hours bez 'Dan odmora'/weekend_work_date badge-a, iako MakeupRequest tip (moj-profil.ts:99) nosi compensation_type/weekend_work_date.

### RAZVOJ ZAPOSLENIH — 360 kampanje, samoocene, kompetence, sistematizacija (Kadrovska → Razvoj + Moj profil + Podešavanja → Kompetencije/Organizacija)

#### 🟡 RAZVOJ-360-01 — Pickeri zaposlenih u Razvoju nisu ograničeni na opseg rukovodioca (canManageDevPlanFor)
*SREDNJE · effort S · ergonomija · verdikt: CONFIRMED*

- **1.0:** U 1.0 su svi izbornici zaposlenih u razvoju/360/razgovorima ograničeni na PODREĐENE prijavljenog rukovodioca: openCampaignModal filtrira kandidate `.filter(e => e.isActive !== false && canManageDevPlanFor(e))`, planRazvojaTab.scopedEmployeeOptions isto, talksSection._scopedEmployeeOptions isto (uz izbacivanje sebe). Srednji rukovodilac (LPM/PM) u picker-u vidi samo svoj tim, pa ne može greškom da otvori kampanju/plan/razgovor za nekog van opsega. _(‎src/ui/kadrovska/assessmentCampaign.js:16-18 (canManageDevPlanFor(e)); src/ui/kadrovska/planRazvojaTab.js:72-83 (scopedEmployeeOptions → canManageDevPlanFor); src/ui/kadrovska/talksSection.js:169-179 (_scopedEmployeeOptions → canManageDevPlanFor).)_
- **3.0:** U 3.0 svi razvoj pickeri koriste ceo imenik bez scope filtera: useNameMap()/EmployeeSelect čitaju `useDirectory()` (pun spisak, služi i za rezoluciju imena) i filtriraju samo po `active`/`excludeId`. CampaignModal: `active = list.filter(e => e.active)`; PlanModal, TalkModal, MeasureModal, mentor izbor — svi EmployeeSelect bez ograničenja na podređene. Srednji rukovodilac vidi SVE zaposlene; oslonac je isključivo BE RLS, koji odbije upis van opsega tek posle pokušaja (zbunjujuće „Snimanje nije uspelo. Proverite dozvolu.“ umesto da osoba nije ni ponuđena). _(‎frontend/src/app/kadrovska/_components/razvoj/shared.tsx:65-89 (useNameMap → useDirectory, bez scope), :132-160 (EmployeeSelect filtrira samo active/excludeId); assessments.tsx:158 (`active = list.filter(e => e.active)`); dev-plans.tsx:254-256 i talks.tsx:247-249 (EmployeeSelect bez scope). Grep za canManageDevPlanFor u frontend/src/app/kadrovska = nema pogodaka.)_
- **Uticaj:** Srednji rukovodioci (LPM/PM/vođa smene) sa ograničenim opsegom: u kampanji/planu/razgovoru vide ceo spisak firme, mogu izabrati osobu van svog tima i dobiti tek naknadnu grešku od RLS-a; gubi se 1.0 vodilja „vidiš samo svoje ljude“. Admin/COO ne osećaju (ionako vide sve).
- **Verifikator:** Grep za canManageDevPlanFor/scopedEmployeeOptions u frontend/src = 0 pogodaka; shared.tsx:65-160 useNameMap→useDirectory(pun spisak) i EmployeeSelect filtriraju samo active/excludeId (bez scope-a), assessments.tsx:158 CampaignModal koristi list.filter(e=>e.active), a dev-plans.tsx:255,279 i talks.tsx:248,552 zovu EmployeeSelect bez ograničenja. BE /directory (kadrovska.service.ts:1316-1332) vraća SVE (v_employees_safe, ORDER BY full_name), a razvoj-tab.tsx:12 komentar potvrđuje da row-scope presuđuje tek sy15 RLS na upisu — dakle scope-vodilja podređenih iz 1.0 zaista fali.

### Cross-cutting: Štampa / PDF / Nalepnice (svi moduli)

#### 🟡 X-STAMPA-PDF-01 — RN dokument „sa slikama" (rRN_SaSlikama) — skice operacija se ne ugrađuju u PDF
*SREDNJE · effort L · stampa-pdf · verdikt: CONFIRMED*

- **1.0:** 1.0/QBigTehn RN štampa ima varijantu sa embedovanim skicama operacija (rRN_SaSlikama → slike iz tStavkeRNSlike). MODULE_SPEC_stampa §4 eksplicitno navodi varijantu 'rRN_SaSlikama — + skice iz work_order_operation_images'. _(‎MODULE_SPEC_stampa.md §4 (varijante rRN/rRN_SaSlikama/rRN_BezBarKoda); QBigTehn rRN inventar §2. 1.0 skica-embed obrazac isti kao montazaIzvestajPdf.js (addImage fotki).)_
- **3.0:** Backend WorkOrderPrintService podržava SAMO 'std' i 'bez-barkoda'; nema varijante koja povlači i ugrađuje operacione skice. Radnik u pogonu ne dobija RN sa skicom uz operaciju (mora zasebno da otvara PDM crtež). _(‎grep 'sa-slikama|saSlikama|withImages|slika' u backend/src/modules/work-orders → 0 pogodaka; work-order-print.service.ts:13 `export type RnPrintVariant = "std" | "bez-barkoda"`; endpoint /work-orders/:id/print?variant=std|bez-barkoda (MODULE_SPEC_stampa §8 tabela). PDM crtež se serve-uje odvojeno (/pdm/drawings/:id/pdf/content), ali se NE ugrađuje u RN.)_
- **Uticaj:** Tehnolog/poslovođa/radnik u proizvodnji: kada operacija ima skicu, radnik na papirnom RN-u je ne vidi; mora dodatno da otvara PDM crtež na ekranu. Zaobilaznica postoji (odvojen PDM PDF), zato SREDNJE.
- **Verifikator:** work-order-print.service.ts:13 tip je samo std | bez-barkoda; buildRnPdf include (35-37) povlaci samo operations bez images, a jedina slika u dokumentu je logo (172). Model WorkOrderOperationImage (Was tStavkeRNSlike) POSTOJI u schema.prisma:1702 i operations.images relacija (1687), ali se nigde ne ugradjuje u RN PDF.

#### 🟡 X-STAMPA-PDF-02 — 360° procena kompetencija — PDF ne ugrađuje radar grafikon
*SREDNJE · effort S · stampa-pdf · verdikt: CONFIRMED*

- **1.0:** 1.0 assessmentPdf.js prima opcioni radarPngDataUrl i ugrađuje sliku radara (spider chart) u PDF procene, pored tabela self/peer/leader/target. _(‎src/lib/assessmentPdf.js zaglavlje: 'radarPngDataUrl // opciono: PNG data URL radara'; src/lib/competenceRadar.js (Chart.js radar) render → PNG.)_
- **3.0:** 3.0 exportAssessmentPdf renderuje samo tabele po grupama i kompetencijama — radar se prikazuje na ekranu (Radar SVG komponenta) ali se NE prosleđuje ni ne rasterizuje u PDF. Vizuelni sažetak 360 procene nedostaje u odštampanom/sačuvanom dokumentu. _(‎hr-pdf/assessment.ts: grep 'radar|addImage|toDataURL|radarPng' → 0 pogodaka; AssessmentPdfInput (index.ts) nema polje za radar sliku; poziv u razvoj/assessments.tsx:403 `exportAssessmentPdf({ employeeName, positionName, period, groups, competences })` — bez radara, iako je Radar SVG prikazan u modalu (assessments.tsx:454).)_
- **Uticaj:** Kadrovska/menadžment pri deljenju rezultata 360 procene zaposlenom: PDF gubi ključni vizuelni prikaz (radar), ostaju samo brojčane tabele. Podaci su prisutni, pa SREDNJE.
- **Verifikator:** hr-pdf/assessment.ts nema radar/addImage/toDataURL, a AssessmentPdfInput (25-32) nema polje za radar sliku; poziv u assessments.tsx:403 exportAssessmentPdf salje samo groups/competences bez radara, dok se Radar SVG (39, 454) prikazuje samo u modalu i ne rasterizuje u PDF.

#### ⚪ X-STAMPA-PDF-03 — Reversi — nema štampe pregleda zaduženja/razduženja (window.print panela)
*NISKO · effort S · ergonomija · verdikt: REFUTED*

- **1.0:** 1.0 reversi zaduzenjaPanel ima dugme „Štampaj" (revZadPrint → window.print) koje štampa tekući pregled zaduženja/razduženja radnika/alata iz browsera (rev-print-area + @media print). _(‎src/ui/reversi/zaduzenjaPanel.js:407 `host.querySelector('#revZadPrint')?.addEventListener('click', () => window.print())`; :217 `.rev-print-area rev-zaduzenja-panel`.)_
- **3.0:** U 3.0 reversi postoji per-dokument „Potpisnica PDF" (server-backed), ali nema browser-štampe agregatnog pregleda zaduženja radnika/alata (lista svih zaduženja koju magacioner odštampa kao pregled). _(‎grep 'window.print|@media print|revZadPrint' u frontend/src/app/reversi → samo rezni-alat-tab, dokumenti-tab, bulk-print-labels-dialog; nijedan nije pregled zaduženja/razduženja. signature-pdf-actions.tsx pokriva samo potpisnicu jednog dokumenta.)_
- **Uticaj:** Magacioner/vođa alatnice: nema brzog „odštampaj ovaj pregled zaduženja"; zaobilaznica = per-dokument potpisnica ili Ctrl+P cele stranice. NISKO.
- **Verifikator:** dokumenti-tab.tsx:249 je Panel Zaduzenja (paritet 1.0 zaduzenjaPanel) sa KPI/pretragom/tabelom, a linija 468-470 ima dugme Stampa prikaza onClick window.print() (RB-26) — direktan ekvivalent 1.0 revZadPrint. Agregatni pregled zaduzenja se stampa iz browsera; dokaz gapa je prevideo da je dokumenti-tab sam pregled zaduzenja.

### Kadrovska

#### 🟡 KADROVSKA-01 — Poster sistematizacije (A0 štampa + varijanta sa imenima + skok na „Moja pozicija") nije prenet
*SREDNJE · effort M · stampa-pdf · verdikt: PARTIAL*

- **1.0:** U „Moj profil" → kartica „O mojoj poziciji" postoji blok dugmadi koji vodi na 3 statička, ručno dizajnirana prikaza cele organizacione šeme (/sistematizacija2026/organizacija_v54.html velika za ekran; v55 kompaktna auto-balansirana za štampu na 1× A0 landscape poster; v56 sa imenima/monogramima nosilaca funkcija). Dodatno, dugme „📍 Moja pozicija u sistematizaciji ↗" vodi deep-link (#pos-<positionId>) koji skače na tačan čvor zaposlenog unutar cele šeme. Koristi se za štampu zidnog postera i za vizuelnu orijentaciju zaposlenog u celoj organizaciji. _(‎src/ui/mojProfil/index.js:2282-2327 — konstante SISTEMATIZACIJA_URL/V2/NAMES + buttonsHtml sa 4 linka (velika / kompaktna A0 / sa imenima / moja pozicija-anchor); statički HTML fajlovi u public/sistematizacija2026/.)_
- **3.0:** 3.0 ima kompletan tekstualni „🏢 Organogram" izveštaj (Izveštaji tab, ugnježdena stabla dept→sub→pozicija→zaposleni) i „Opis pozicije (PDF)" po pojedinačnoj poziciji (team-section + profil/documents-section), ALI nedostaje dizajnirani štampani poster (A0), varijanta sa imenima nosilaca i deep-link skok na sopstvenu poziciju u celoj šemi. Statički fajlovi ne postoje u repou. _(‎find frontend -iname '*sistematiz*' -o -iname 'organizacija_v*' → 0 pogodaka; grep -rniE 'sistematiz|organizacija_v|A0|poster|Šema za štampu' frontend/src/app/profil → 0 pogodaka; misc-sections.tsx (kartica „Opis pozicije") i izvestaji-tab.tsx (OrgReport, red 346-394) nemaju ni poster-linkove ni anchor na poziciju.)_
- **Uticaj:** Menadžment/HR koji hoće da odštampa i okači zidni poster sistematizacije; svaki zaposleni koji želi da vizuelno vidi gde se nalazi u celoj organizaciji (postoji zaobilaznica: tekstualni Organogram izveštaj + PDF sopstvene pozicije, ali bez posterskog prikaza i skoka na svoju poziciju).
- **Verifikator:** Pretraga (find/grep 'sistematiz|organizacija_v|poster|A0|#pos-' po celom repou) daje 0 pogodaka za dizajnirani A0 poster, varijantu sa imenima i deep-link skok na sopstvenu poziciju — statički fajlovi ne postoje. Postoje SAMO delimični ekvivalenti: tekstualni 'Organogram' (izvestaji-tab.tsx OrgReport, 346-394, prikazuje dep→sub→pozicija→zaposleni imenom) i individualni 'Opis pozicije (PDF)' (documents-section.tsx:173 → generateJobPositionPdf, lib/hr-pdf/job-position.ts). PositionSection (misc-sections.tsx:210) pokazuje samo tekst opisa pozicije, bez skoka u celu šemu. Dakle poster/imena/deep-link stvarno fale, ali potreba je delom pokrivena tekstualnim organogramom + PDF-om pojedinačne pozicije.

#### ⚪ KADROVSKA-02 — Organogram izveštaj nema izvoz/štampu (jedini od 11 izveštaja bez XLSX/PDF)
*NISKO · effort S · export · verdikt: CONFIRMED*

- **1.0:** U 1.0 organogram se konzumira kroz poster sistematizacije (KADROVSKA-01) koji je štampiv; sam „Organogram" pod-izveštaj u Izveštajima je prikaz, a štampa cele šeme išla je kroz posterske varijante. _(‎src/ui/kadrovska/reports/orgChartReport.js registrovan u reportsTab.js:41 (🏢 Organogram); štampa/izvoz šeme kroz mojProfil poster linkove (index.js:2322-2324).)_
- **3.0:** U 3.0 Izveštaji tabu, 10 od 11 izveštaja ima „⬇ Izvezi XLSX" (bolovanja i CSV dodatno), ali OrgReport komponenta renderuje samo ugnježdeno stablo bez ijednog dugmeta za izvoz ili štampu — ne može se izneti ni odštampati organizaciona šema. _(‎frontend/src/app/kadrovska/_components/izvestaji-tab.tsx: funkcija OrgReport (red 346-394) nema Button/exportXlsx/print — za razliku od SickReport, VacationReport, OvertimeReport, FieldReport, ChildrenReport, ViewReport koji svi imaju izvoz.)_
- **Uticaj:** HR/menadžment koji želi da izveze ili odštampa organizacionu šemu direktno iz Izveštaja — nema dugmeta; mora ručno ili preko drugog toka. Kombinuje se sa KADROVSKA-01 (nedostatak postera).
- **Verifikator:** OrgReport (izvestaji-tab.tsx:347-394) renderuje samo ugnježdeno stablo — nema Button, exportXlsx ni print poziv, za razliku od svih ostalih izveštaja (VacationReport:414, SickReport, OvertimeReport itd. koji imaju '⬇ Izvezi XLSX' preko exportXlsx helper-a red 37-43). Grep za export/print/xlsx unutar OrgReport bloka: 0 pogodaka. Organizaciona šema se ne može izvesti ni odštampati iz Izveštaja.

### Energetika / SCADA

#### 🟡 ENERGETIKA-01 — FNE Sigenergy: nedostaje 'flow.stale' badge za zastareo realtime (energyFlow) blok
*SREDNJE · effort S · funkcionalnost · verdikt: CONFIRMED*

- **1.0:** public/scada-hmi/solar-sigen.js u 1.0 racuna flowStale = s.flow[CUR].stale i flowAgeMin = ageMs/60000, pa: (1) prikazuje badge 'ZASTARELO X min' / 'REALTIME NEDOSTUPAN' pored sistema, i (2) dodaje warning red 'Realtime (PV/baterija/mreza/SOC) zastareo ~X min — vrednosti nisu aktuelne (dnevni kWh brojaci jesu). Uzrok: cloud greska/rate-limit (HTTP 502) na energyFlow.' Ovim menadzment zna da PV/baterija/mreza/SOC nisu aktuelne kad Sigen cloud vrati 502/rate-limit, dok dnevni kWh brojaci i dalje idu. _(‎src/ui/... zapravo public/scada-hmi/solar-sigen.js linije ~126-131 (flowStale/flowAgeMin) + ~152 (badge) + ~244-246 (warning red 'p3'))_
- **3.0:** 3.0 frontend/public/scada-hmi/solar-sigen.js je starija kopija — tih 10 linija NE postoji, pa ekran Sigenergy prikazuje poslednje poznate PV/baterija/mreza/SOC vrednosti kao da su aktuelne, bez ikakvog upozorenja kad cloud energyFlow zamrzne. Payload iz scada_snapshots i dalje nosi flow[CUR].stale (bridge ga pise), ali ga 3.0 ekran ne cita. _(‎diff --strip-trailing-cr ../servoteh-plan-montaze/public/scada-hmi/solar-sigen.js frontend/public/scada-hmi/solar-sigen.js -> 10 realnih linija samo u 1.0 (oznaka '<'); svi ostali HMI fajlovi 0 realnih razlika. Grep 'flowStale|energyFlow|flow.stale' u frontend/public/scada-hmi/ i frontend/src/ -> nema pogodaka.)_
- **Uticaj:** Menadzment/admin koji nadzire FNE Sigenergy (desktop /energetika i touch /m/energetika citaju isti payload) — kad Sigen cloud padne u 502/rate-limit, korisnik donosi odluke na osnovu zamrznutih vrednosti misleci da su trenutne; nema signala da je realtime deo zastareo.
- **Verifikator:** diff --strip-trailing-cr potvrdio: 10 linija (flowStale/flowAgeMin ~126-131, badge 'ZASTARELO/REALTIME NEDOSTUPAN' ~152, warning red 'p3' ~244-246) postoje SAMO u 1.0 (frontend/public/scada-hmi/solar-sigen.js starija je kopija, Jul 15 vs Jul 18). Grep 'flowStale|flow.stale|energyFlow|ZASTARELO' po frontend/src i frontend/src/app/energetika — nijedan pogodak; badge zastarelog realtime-a stvarno fali.

#### ⚪ ENERGETIKA-02 — Promena teme ponovo ucitava HMI iframe umesto zive sinhronizacije
*NISKO · effort S · ergonomija · verdikt: CONFIRMED*

- **1.0:** src/ui/energetika-scada/index.js drzi MutationObserver na data-theme i UZIVO salje postMessage {type:'scada-theme', theme} svim iframe.es-frame ekranima; shim primeni temu bez reload-a (ekran ostaje na istom stanju, bez treptaja). _(‎src/ui/energetika-scada/index.js linije ~124-131 (_state.themeObserver -> f.contentWindow.postMessage 'scada-theme'); scada-bridge-shim.js linije ~33-36 slusa 'scada-theme'.)_
- **3.0:** 3.0 hmi-host.tsx koristi key={`${screen}:${theme}`} pa svaka promena teme PONOVO UCITA iframe (novi ?theme=). Shim jos slusa 'scada-theme', ali host (page.tsx/hmi-host.tsx) ga vise ne salje — tema se primenjuje kroz reload. Rezultat: kratak treptaj + gubitak in-screen stanja (npr. zoom/scroll na trend grafiku HMI ekrana) pri svakom prebacivanju teme. _(‎frontend/src/app/energetika/_components/hmi-host.tsx (key sa temom, komentar 'reload na promenu'); grep 'scada-theme' u frontend/src/ -> samo u public/scada-hmi/scada-bridge-shim.js (listener), nigde se ne salje iz host-a.)_
- **Uticaj:** Admin/menadzment koji na otvorenom HMI ekranu prebaci svetlo/tamno (ili OS predje u dark) — ekran trepne i resetuje in-screen interakciju; kozmeticka regresija, bez gubitka funkcije.
- **Verifikator:** hmi-host.tsx:17 koristi key=`${screen}:${theme}` uz komentar 'promena teme ponovo učita ekran'; iframe se remount-uje sa novim ?theme=. Shim i dalje sluša 'scada-theme' (scada-bridge-shim.js:39), ali host ga NE šalje — grep 'scada-theme' po frontend/src nema pošiljaoca; jedini postMessage iz energetika/page.tsx:309 je 'scada-confirm-result', ne tema. Živa theme-sync bez reload-a (1.0 index.js themeObserver) nedostaje.

### Održavanje (CMMS) — mašine, vozila, vozači, delovi, radni nalozi, izveštaji, notifikacije

#### 🟡 ODRZAVANJE-01 — Izveštaji: CSV i klijentska analitika ograničeni na poslednjih 200 redova
*SREDNJE · effort M · export · verdikt: CONFIRMED*

- **1.0:** renderMaintReportsPanel povlači do 2000 incidenata, 1000 naloga, 5000 stavki delova/rada i računa bar-liste, tabelu i dva CSV izvoza (Export CSV kvarova + Troškovi CSV) nad CELIM skupom u izabranom periodu (30/90/365/sve). _(‎src/ui/odrzavanjeMasina/maintReportsPanel.js:161-173 (fetchMaintIncidents({limit:2000}), fetchMaintWorkOrderPartsAll({limit:5000})) i CSV eksport nad svim redovima linije 282-311.)_
- **3.0:** Headline KPI brojevi su tačni (BE agregacija), ali bar-liste, tabela 'Poslednji kvarovi' i OBA CSV-a računaju se samo nad poslednjih 200 redova (ANALYTICS_PAGE = BE pageSize cap). Za veće periode CSV je nepotpun; UI to i priznaje porukom. _(‎frontend/src/app/odrzavanje/_components/izvestaji-tab.tsx:37-38 (ANALYTICS_PAGE=200, komentar 'BE pageSize cap=200'), :94-95 (useIncidents/useWorkOrders pageSize:200), :124 truncated flag i banner :205-207; exportIncidentsCsv/exportCostsCsv rade nad capiranim incRows/woRows.)_
- **Uticaj:** Šef održavanja / menadžment koji izvozi kvarove ili troškove za 12 meseci dobija nepotpun CSV (samo poslednjih 200 zapisa) — pogrešne sume pri eksternoj analizi u Excel-u.
- **Verifikator:** izvestaji-tab.tsx:37-38 ANALYTICS_PAGE=200, :94-95 useIncidents/useWorkOrders pageSize:200, :124 truncated flag, :205-207 banner priznaje ogranicenje; exportIncidentsCsv (:126-140) i exportCostsCsv (:141-159) rade nad capiranim incRows/woRows. Headline KPI su tacni (BE agregacija preko useReportIncidents/WorkOrders), ali klijentska analitika/CSV su nad max 200 redova — realno gap za velike periode.

#### ⚪ ODRZAVANJE-02 — Izveštaji: 'Troškovi CSV' osiromašen — po radnom nalogu umesto po stavci dela
*NISKO · effort M · export · verdikt: CONFIRMED*

- **1.0:** Troškovi CSV izvozi jedan red PO STAVCI ugrađenog dela: kolone wo_number, title, asset_id, asset_type, part_name, quantity, unit_cost, cost — pun uvid u trošak svakog pojedinačnog dela po nalogu. _(‎src/ui/odrzavanjeMasina/maintReportsPanel.js:297-311 (headers ['wo_number','title','asset_id','asset_type','part_name','quantity','unit_cost','cost'], red po p iz partsInPeriod).)_
- **3.0:** Troškovi CSV izvozi jedan red PO RADNOM NALOGU (cost_total, labor_minutes) — bez razrade po pojedinačnom delu. Granularnost 'koji deo je koliko koštao' je izgubljena; kod sam dokumentuje ovo odstupanje. _(‎frontend/src/app/odrzavanje/_components/izvestaji-tab.tsx:141-159 (exportCostsCsv, komentar '1.0 izvozi po STAVCI dela; 2.0 nema all-parts endpoint pa je granularnost RADNI NALOG', headers cost_total/labor_minutes).)_
- **Uticaj:** Nabavka/kontroling ne može iz CSV-a da vidi utrošak po konkretnom rezervnom delu (samo zbir po nalogu) — teža analiza koji delovi generišu trošak.
- **Verifikator:** izvestaji-tab.tsx:141-159 exportCostsCsv izvozi red po RADNOM NALOGU (cost_total/labor_minutes), sa kod-komentarom da 2.0 nema all-parts endpoint. Potvrdjeno pretragom BE: controller ima samo 3 report rute (reports/incidents, reports/work-orders, reports/attention — :482-495) i parts endpointe po pojedinacnom WO/vozilu (work-orders/:id/parts), ali NEMA agregatnog all-parts-in-period endpointa; grep partsInPeriod/all-parts/reportParts = 0. Granularnost po stavci dela je izgubljena.

#### ⚪ ODRZAVANJE-03 — Izveštaji: bar-liste i tabela nisu klikabilne ka kartonu mašine
*NISKO · effort S · ergonomija · verdikt: CONFIRMED*

- **1.0:** U izveštajima svaka mašina u bar-listama ('Top mašine po kvarovima', 'Top downtime') i u tabeli incidenata je dugme (data-mnt-nav) koje otvara karton te mašine (onNavigateToPath). _(‎src/ui/odrzavanjeMasina/maintReportsPanel.js:132 (mnt-linkish data-mnt-nav), :145 (link u tabeli), :312-317 (klik handler ka onNavigateToPath).)_
- **3.0:** Bar-liste i tabela 'Poslednji kvarovi' renderuju naziv/šifru mašine kao običan tekst — bez linka ka kartonu. Korisnik mora ručno da pretraži mašinu u listi. _(‎frontend/src/app/odrzavanje/_components/izvestaji-tab.tsx:268-290 (BarList — plain <span>), :221-229 (red tabele — plain text, bez onClick/href ka /odrzavanje/masine).)_
- **Uticaj:** Održavanje pri analizi izveštaja gubi brzu navigaciju 'klik na problematičnu mašinu → njen karton'; mali ali svakodnevni friction.
- **Verifikator:** izvestaji-tab.tsx BarList (:268-290) renderuje naziv masine kao plain <span> (:279) bez onClick/href; tabela 'Poslednji kvarovi' (:221-229) renderuje naziv/sifru kao obican tekst bez linka ka kartonu. Nema navigacionog handlera ka /odrzavanje/masine — potvrdjen gubitak klik-navigacije iz 1.0 (data-mnt-nav).

#### ⚪ ODRZAVANJE-04 — Nema FE dugmeta za ručno pokretanje provere rokova vozila (deadline-check)
*NISKO · effort S · automatika · verdikt: CONFIRMED*

- **1.0:** runMaintVehicleDeadlineCheck(lookaheadDays) poziva RPC maint_check_vehicle_deadlines koji enqueue-uje notifikacije za istekle/blize rokove (registracija, osiguranje, servis); u 1.0 pokretano cron-om, a RPC je dostupan i iz aplikacije. _(‎src/services/maintenance.js:2557-2568 (runMaintVehicleDeadlineCheck → rpc/maint_check_vehicle_deadlines) i migracija supabase/migrations/20260522270000__maint_deadline_check_cron.sql.)_
- **3.0:** BE endpoint postoji (POST vehicles/deadline-check → maint_check_vehicle_deadlines) ali se NIGDE ne poziva iz frontenda — nema dugmeta 'Proveri rokove'. Automatsko dnevno enqueue-ovanje trenutno visi na sy15 cron-u (07:00), ne na nativnom 3.0 cron-u. _(‎backend/.../odrzavanje.controller.ts:779-785 (@Post vehicles/deadline-check) + service:3367-3376; grep 'deadline-check|DeadlineCheck' po frontend/src/app/odrzavanje daje 0 poziva; nema @Cron u backend/src/modules/odrzavanje.)_
- **Uticaj:** Administrator održavanja ne može ručno da 'osveži' rokove iz aplikacije; oslonac je na sy15 most (koji se gasi u F5), pa je funkcija latentno ranjiva.
- **Verifikator:** BE endpoint postoji (controller.ts:779-785 @Post vehicles/deadline-check → service:3367-3380 maint_check_vehicle_deadlines), a postoji cak i FE hook useVehicleDeadlineCheck (frontend/src/api/odrzavanje.ts:1345-1346) — ali grep po celom frontend/src pokazuje da se hook NIGDE ne poziva iz komponente: nema dugmeta 'Proveri rokove'. Nema @Cron u backend/src (grep 0 pogodaka). Napomena: dnevna automatika je po design specu (MODULE_SPEC_odrzavanje_30.md:44) nativni pg_cron job 15 'maint-deadline-check-daily' u glavnoj bazi, ne nuzno sy15 most — ali rucno FE dugme zaista fali.

### Podešavanja + Korisnici

#### 🟠 PODESAVANJA-01 — Admin reset lozinke ne upisuje novu lozinku u 2.0 auth (users.passwordHash) — direktan 3.0 login sa novom lozinkom ne radi
*VISOKO · effort S · funkcionalnost · verdikt: CONFIRMED*

- **1.0:** Podešavanja → Korisnici → dugme ključ (Resetuj lozinku): resetUserPasswordViaEdge poziva Edge admin-invite-user (action reset_password) koji preko service role generiše novu privremenu lozinku, upisuje je u GoTrue (jedini auth 1.0), šalje mejl i vraća je adminu u prompt-u. 1.0 ima samo jedan auth sistem (GoTrue) pa je reset time potpun. _(‎src/services/users.js resetUserPasswordViaEdge() + src/ui/podesavanja/usersTab.js _resetUserPassword() (linije 519-546, prikaz privremene lozinke kroz window.prompt).)_
- **3.0:** 3.0 ima DVA nezavisna auth puta: (a) SSO iz 1.0 ljuske preko GoTrue tokena i (b) direktan login email+lozinka koji validira protiv 2.0 users.passwordHash (bcrypt.compare). Admin reset (PodesavanjaUsersService.resetPassword) menja SAMO GoTrue lozinku (A) i postavlja must_change_password flag u 2.0 (C) i sy15 (B) — ali NIKAD ne upisuje nov passwordHash u 2.0 users. Posledica: novom privremenom lozinkom korisnik NE može da se prijavi direktnim 3.0 login-om; radi samo ako ulazi kroz SSO (GoTrue je resetovan). Admin dobija utisak da je reset uspeo za sve puteve prijave. _(‎backend/src/modules/podesavanja/podesavanja-users.service.ts resetPassword() (linije 151-187): poziva authAdmin.resetPassword(authUserId) za GoTrue, pa write2_0(row.email, {mustChangePassword:true, ...}) — write2_0 (linije 515-590) u update grani NE prosleđuje passwordHash (postavlja ga samo u create grani kao random hash za nov nalog). auth.service.ts validate() (linije 115-138) proverava bcrypt.compare(password, user.passwordHash). Grep 'passwordHash' u resetPassword putanji = nema upisa. Poklapa se sa poznatim rizikom iz memory (mob-10: '3.0 admin-reset piše samo u GoTrue').)_
- **Uticaj:** Admin (Nenad/Nevena) resetuje lozinku radniku koji koristi direktan 3.0 login (npr. menadžment pilot na /zavrsni-racun bez 1.0 ljuske) — radnik ne može da uđe iako mu je lozinka 'resetovana'; zaobilaznica je jedino SSO kroz 1.0. Tiha nekonzistentnost bezbednosne akcije.
- **Verifikator:** podesavanja-users.service.ts resetPassword() (l.151-187) generiše newPassword i prosleđuje ga SAMO authAdmin.resetPassword() (GoTrue, l.164), a write2_0 poziv (l.168-175) šalje samo mustChangePassword; update grana write2_0 (l.546-554) NE prosleđuje passwordHash (bcrypt hash se postavlja jedino u create grani l.533/539). Direktan login validira bcrypt.compare(password, user.passwordHash) (auth.service.ts:122) — nova privremena lozinka postoji samo u GoTrue, direktan 3.0 login je ne prihvata.

#### 🟡 PODESAVANJA-02 — Nema self-service promene lozinke u 3.0 + must_change_password se ne primenjuje na direktan 3.0 login
*SREDNJE · effort M · funkcionalnost · verdikt: CONFIRMED*

- **1.0:** 1.0: posle admin reseta must_change_password=true; pri sledećoj prijavi korisnik je prinuđen da promeni lozinku, a clearMustChangePassword (SECURITY DEFINER RPC clear_my_must_change_password) skida flag. Promena lozinke ide kroz GoTrue. Flag se čita iz svakog aktivnog user_roles reda i primenjuje. _(‎src/services/userRoles.js clearMustChangePassword() (linije 143-145) + loadAndApplyUserRole() setMustChangePassword(matches.some(r => r.must_change_password === true)) (linija 132).)_
- **3.0:** 3.0 auth modul NIGDE ne referencira must_change_password: validate()/login() ne proveravaju flag, ne postoji endpoint za promenu sopstvene lozinke, niti FE stranica za to (postoji samo /login). Admin može da postavi must_change (D3 endpoint), ali za direktan 3.0 login flag je mrtvo slovo — korisnik nema način da promeni lozinku kroz 3.0, niti ga sistem na to primorava. Ceo password-lifecycle na 2.0 strani (reset+prinudna promena+samostalna promena) funkcioniše samo kroz 1.0/GoTrue. _(‎grep 'mustChangePassword|must_change' backend/src/modules/auth/ = 0 pogodaka. backend/src/modules/auth/auth.controller.ts endpointi: login/sso/refresh/logout/me/me/permissions — nema change-password. grep 'change.*password' frontend/src = samo podesavanja (admin postavlja drugom), nema self-service komponente; find frontend/src/app -iname '*password*' = prazno (samo /login folder).)_
- **Uticaj:** Korisnik koji koristi direktan 3.0 login ne može sam da promeni lozinku niti je sistem primorava posle admin reseta; oslonac je isključivo 1.0 ljuska. Bije prvenstveno naloge bez SSO puta.
- **Verifikator:** auth.controller.ts izlaže samo login/sso/refresh/logout/me/me/permissions — nema change-password endpointa; grep 'mustChangePassword|must_change|change-password' po celom repou daje pogotke isključivo u podesavanja modulu (admin postavlja drugom), ne u auth/. Glob frontend/src/app/**/*password* = prazno (nema self-service stranice; samo /login). must_change se ne proverava u auth login toku — mrtvo slovo za direktan 3.0 login. Napomena: admin MOŽE ručno štiklirati 'Mora promeniti lozinku' u edit modalu (korisnici-tab.tsx:313), ali to bez enforce-a i self-service forme ništa ne primenjuje.

#### 🟡 PODESAVANJA-03 — Praznici (kadr_holidays) — samo READ u 3.0; nema admin CRUD-a (dodaj/izmeni/obriši državni praznik)
*SREDNJE · effort M · funkcionalnost · verdikt: CONFIRMED*

- **1.0:** Puna admin CRUD služba za državne praznike: loadAllHolidaysFromDb, saveHolidayToDb, updateHolidayInDb, deleteHolidayFromDb nad kadr_holidays (datum, naziv, is_workday, napomena). Praznici ulaze u obračun mesečnog fonda/grida (holidayDateSet, computeMonthlyFond). _(‎src/services/holidays.js linije 108-135 (Admin CRUD sekcija) — sve četiri operacije POST/PATCH/DELETE na kadr_holidays.)_
- **3.0:** 3.0 izlaže SAMO čitanje praznika: GET /admin/holidays (podesavanja) i GET /kadrovska/holidays. Nema nijednog POST/PUT/DELETE endpointa za praznike ni u podesavanja ni u kadrovska kontroleru. Za novu godinu praznike mora neko ručno da unese direktno u bazu — nema UI ni API-ja. (Napomena: u 1.0 je uređivanje praznika bilo u Kadrovska/calendarTab, ne u Podešavanja, ali funkcija sistemski nedostaje.) _(‎grep 'holiday|Holiday' backend/src/modules/kadrovska/kadrovska.controller.ts = samo @Get('holidays'). backend/src/modules/podesavanja/podesavanja.controller.ts linija 210-213 = samo @Get('holidays'). Nema @Post/@Put/@Delete holidays nigde u backend/src/modules.)_
- **Uticaj:** HR/admin ne može da doda praznike za novu godinu ni da ispravi grešku bez direktnog pristupa bazi; utiče na tačnost mesečnog fonda sati i grida (Kadrovska, obračun).
- **Verifikator:** podesavanja.controller.ts:210 = samo @Get('holidays'); kadrovska.controller.ts:240 = samo @Get('holidays'). Grep 'holiday|Holiday|praznik' po svim *.controller.ts u backend/src/modules ne daje nijedan @Post/@Put/@Patch/@Delete za praznike — samo READ. Admin CRUD nad kadr_holidays (dodaj/izmeni/obriši praznik) ne postoji ni kao API ni kao UI.

#### ⚪ PODESAVANJA-04 — Nema dodele/kolone 'Projekat' po korisniku u UI Korisnika
*NISKO · effort S · funkcionalnost · verdikt: CONFIRMED*

- **1.0:** Users tabela ima kolonu 'Projekat' (project_id → naziv/šifra ili 'Sve'), a edit i invite modal imaju select 'Projekat (opciono)' sa opcijom 'Sve / globalno' + lista projekata. Omogućava vezivanje naloga za projekat. _(‎src/ui/podesavanja/usersTab.js: _tableHtml kolona Projekat (linije 259-261, 285), _openUserModal projOptions + #umProject (linije 360-367, 387).)_
- **3.0:** korisnici-tab.tsx nema kolonu Projekat u tabeli niti polje za projekat u UserModal-u (invite/edit). Backend DTO i sy15 insert/update podržavaju projectId (podesavanja-users.service insertSy15Role prima dto.projectId, api UserRbacFields ima projectId), ali FE ga ne izlaže — funkcija je nedostupna korisniku. _(‎frontend/src/app/podesavanja/_components/korisnici-tab.tsx: kolone tabele (linije 100-107) = Ime/Email/Uloga/Tim/Status/Akcije bez Projekat; UserModal (linije 198-362) nema projekat polje (samo email/ime/tim/uloga/lozinka/scope/override). projectId postoji u frontend/src/api/podesavanja.ts UserRbacFields (linija 272) ali se ne koristi u modalu.)_
- **Uticaj:** Admin ne može iz 3.0 da veže nalog za konkretan projekat (per-projekat scoping); retko korišćeno, backend spreman.
- **Verifikator:** korisnici-tab.tsx zaglavlje tabele (l.101-106) = Ime/Email/Uloga/Tim/Status/Akcije — nema kolone Projekat; UserModal (l.198-362) nema polje za projekat (email/ime/tim/uloga/lozinka/scope/kadr override). Backend jeste spreman: insertSy15Role prima dto.projectId (podesavanja-users.service.ts:601) i updateSy15Role podržava project_id (l.632-633), ali FE ga ne izlaže — funkcija nedostupna korisniku iz 3.0 UI-a.

#### ⚪ PODESAVANJA-05 — Stat kartice po roli prikazuju samo prve 4 role; fale kolona 'Dodato' (created) i avatar inicijali u tabeli
*NISKO · effort S · ergonomija · verdikt: CONFIRMED*

- **1.0:** 1.0 dinamički prikazuje karticu za SVAKU rolu koja ima bar jednog korisnika (ne fiksni izbor), a users tabela ima kolonu 'Dodato' (datum kreiranja) i avatar sa inicijalima + bojom po email-u. _(‎src/ui/podesavanja/usersTab.js _statsHtml roleCards mapira sve role iz ROLE_LABELS koje imaju korisnike (linije 156-166); _tableHtml kolona 'Dodato' (u.createdAt, linije 258, 287) + kadr-avatar inicijali (_initials/_avatarColor, linije 235-244, 273-278).)_
- **3.0:** korisnici-tab.tsx stats.byRole.slice(0,4) prikazuje samo top-4 role (ostale role sa korisnicima se ne vide kao kartica); tabela nema kolonu 'Dodato' ni avatar — samo tekst imena. Manji gubitak preglednosti za admina sa mnogo rola. _(‎frontend/src/app/podesavanja/_components/korisnici-tab.tsx: stats.byRole.slice(0, 4) (linija 63); zaglavlje tabele bez 'Dodato'/avatara (linije 100-107, ćelija imena 112-115 = samo full_name + lozinka pill).)_
- **Uticaj:** Admin sa širokom listom rola ne vidi karticu za rolu van top-4 i nema 'kad je dodat' u tabeli; kozmetički, ne blokira posao.
- **Verifikator:** korisnici-tab.tsx: stats.byRole.slice(0, 4) (l.63) prikazuje samo top-4 role kao kartice; zaglavlje tabele (l.101-106) nema kolonu 'Dodato', a ćelija imena (l.112-115) je samo full_name + 'lozinka' pill bez avatara/inicijala. Kozmetički gubitak preglednosti tačno kako je opisan.

### CROSS-CUTTING: Exporti + Prečice + Deep-linkovi + Tabelarna ergonomija

#### 🟠 X-EXPORT-UX-01 — Nema dd.mm.gggg. tekst-unosa datuma sa auto-tačka maskom (native <input type="date"> svuda)
*VISOKO · effort M · ergonomija · verdikt: CONFIRMED*

- **1.0:** 1.0 je namerno IZBACIO native <input type="date"> (na Windows-u prikazuje mm/dd po OS locale-u — izvor grešaka) i zamenio ga jedinstvenim tekstualnim poljem dd.mm.gggg. Globalni helper lib/dmyDateInput.js (212 linija): delegiran 'input' listener na document-u primenjuje auto-tačka masku nad SVAKIM .input-dmy poljem (kucanje '15052026' → '15.05.2026.'), čuva poziciju kursora, inputmode=numeric; plus OPCIONI native picker (klik na kalendar-zonu uz desnu ivicu ili Alt+↓ otvara skriveni <input type=date> proxy). installDmyAutoSlash()+installDmyDatePicker() se zovu jednom iz bootstrap-a, pa svaki modal/forma dobija ponašanje besplatno. date.js parseDmyToIso/isoToDmyInput su izvor formata. _(‎src/lib/dmyDateInput.js (applyDmyMask, formatDmyDigits, openDmyPicker, installDmyAutoSlash, installDmyDatePicker); klasa DMY_INPUT_CLASS='input-dmy', placeholder 'dd.mm.gggg.')_
- **3.0:** 3.0 koristi native <input type="date"> na 152 mesta kroz sve module (kadrovska, blagajna, izvodi, glavna-knjiga, fakturisanje, kamata, handovers, robno...). Nema globalne dd.mm.gggg. tekst-maske ni auto-tačke. Jedini izuzetak je montaza/izvestaj-wizard koji ručno parsira dd.mm.gggg. preko plan-montaze/date.ts, ali to je lokalno, ne postoji deljena kit komponenta ni globalna maska. _(‎grep 'type="date"' u frontend/src/app = 152 pogotka; grep 'gggg|dmyMask|auto.?dot|installDmy' po app/ components/ lib/ = 0 pogodaka (osim komentara u hr-pdf-u); ui-kit/ nema date-input komponentu (ls components/ui-kit → nema date/dmy fajla); parseDmyToIso postoji samo u lib/plan-montaze/date.ts i koristi ga samo izvestaj-wizard)_
- **Uticaj:** Svi koji svakodnevno unose datume kroz ERP forme (kadrovska, računovodstvo — izvodi/GK/kamata/blagajna, nabavka, primopredaje). Native date picker na Windows-u traži mm/dd redosled i miša za kalendar; DESIGN_SYSTEM propisuje dd.MM.yyyy. i 'tastatura je deo definicije gotovog' — brzo kucanje datuma (koje 1.0 daje) je regresija za brzinu unosa i izvor pogrešno unetih datuma (mesec/dan zamena).
- **Verifikator:** grep type="date" = 152 pogotka u 81 fajlu (kadrovska/blagajna/izvodi/GK/handovers/robno...); grep dmyMask|installDmy|input-dmy|gggg|auto-dot = 0 (samo komentar u lib/hr-pdf/hr-documents.ts). ui-kit/ nema date komponentu (button/combo-box/data-table/form-field/search-box/select ali bez date/dmy). parseDmyToIso samo u lib/plan-montaze/date.ts (izvestaj-wizard). Nema deljene maske ni kit komponente.

#### 🟡 X-EXPORT-UX-02 — Tabelarna pretraga bez folding-a dijakritike i bez multi-token podudaranja
*SREDNJE · effort M · ergonomija · verdikt: CONFIRMED*

- **1.0:** 1.0 lib/textSearch.js daje matchesSearch(haystack, needle): normalizuje OBE strane (lowercase, đ→dj, ligature dž/lj/nj → ASCII, NFD + skidanje kombinujućih znakova → č→c/ć→c/š→s/ž→z), pa deli upit na whitespace tokene i traži da SVAKI token bude sadržan bilo gde bilo kojim redosledom. Tako 'djordje' nalazi 'Đorđe', 'sef milov' nalazi 'Šef Milovanović'. Koristi se kao filter u tabelama više modula. _(‎src/lib/textSearch.js (normalizeSearchText, matchesSearch); mapiranje đ/Đ→dj, U+01C4–U+01CC ligature, COMBINING_MARKS_RE)_
- **3.0:** 3.0 klijentski filteri tabela koriste sirov String(v).toLowerCase().includes(term) BEZ skidanja dijakritike i BEZ multi-token logike. Postoji lib/fuzzy.ts sa normalize() (skida šđčćž) ALI se koristi ISKLJUČIVO u command-palette (pretraga modula), ne u filterima podataka. Nijedna lista/tabela ne uvozi fuzzy/normalize za filtriranje redova. _(‎grep 'toLowerCase().includes' u reversi/lokacije/magacin/masine/otpisano/rezni-alat tab-ovima = plain substring (npr. magacin-tab.tsx:228, lokacije-tab.tsx:59-61, stampa-tab.tsx:125); grep 'from .*fuzzy|normalizeSearch|matchesSearch' u app/ = 0 (fuzzy.ts se importuje samo u components/ui-kit/command-palette.tsx); SearchBox (ui-kit) je čist <input> bez normalizacije)_
- **Uticaj:** Svaki korisnik koji pretražuje tabele po imenima/nazivima sa našim slovima (kadrovska po prezimenima, reversi/lokacije po nazivima, komitenti). Ko ukuca 'milovanovic' ili 'sef' bez kvačica ne dobija rezultat — mora tačno da pogodi dijakritiku, što je u 1.0 radilo. Takođe nemogućnost 'ime prezime' upita u bilo kom redosledu.
- **Verifikator:** Dijakritik-folding normalize() postoji ali IZOLOVANO: lib/rs-postanski.ts:154 (poredjenje gradova) i kadrovska/emp-quick-entry.tsx (CSV header aliasi) — ne za filtriranje redova. fuzzyScore iz lib/fuzzy.ts uvozi SAMO components/ui-kit/command-palette.tsx:20. 63 tabel-filtera u 47 fajlova koriste sirov toLowerCase().includes bez folding-a i bez multi-token logike. Nema deljenog matchesSearch.

#### ⚪ X-EXPORT-UX-03 — Nema globalnih prečica '/' (fokus pretrage), 'n' (Novi), 'r' (Osveži), '?' (pregled prečica)
*NISKO · effort S · precice-ux · verdikt: CONFIRMED*

- **1.0:** 1.0 lib/keyboardShortcuts.js (196 linija, installKeyboardShortcuts() globalno): '/' fokusira primarnu pretragu u tekućem panelu (GitHub stil, hvata i van inputa), 'n' klikće vidljivo '+ Novi' dugme u toolbar-u, 'r' klikće 'Osveži/↻', '?' otvara overlay sa listom svih prečica; sve se gase kad je fokus u input/textarea/select (osim '/'). _(‎src/lib/keyboardShortcuts.js (onKeyDown: key '/', 'n', 'r', '?'; findVisibleSearch/findVisibleNewButton/findVisibleReload; openHelp overlay 'Tastaturni prečice'))_
- **3.0:** 3.0 shell ima Ctrl+K (komandna paleta), Ctrl+B (sidebar toggle), Ctrl+S (snimi u formama), Esc (zatvori). NEMA jednoslovne prečice '/', 'n', 'r' niti overlay '?' sa spiskom prečica. Taster '?' je u 3.0 preuzet za info-vodič (help-mode.tsx), ne za listu prečica. _(‎grep "key === '/'|key === 'n'|focusSearch|shortcut" (bez ctrlKey/metaKey) po app/components/lib = samo help-mode.tsx:203 (key==='?' → info vodič); command-palette.tsx registruje samo Ctrl/Cmd+K; nema listenera za '/','n','r')_
- **Uticaj:** Power-useri (kadrovska, planeri, magacioneri) koji su u 1.0 navikli da '/' skoči u pretragu i 'n' otvori novi unos bez miša. Postoji zaobilaznica (miš / Ctrl+K za navigaciju), pa je nizak prioritet, ali je gubitak brzine u svakodnevnom radu.
- **Verifikator:** Globalni keydown listeneri su samo: Ctrl+B (app-shell.tsx:1100), Ctrl/Cmd+K (command-palette.tsx), '?' (help-mode.tsx → info vodič). grep key === '/'|'n'|'r'|focusSearch|findVisibleSearch|installKeyboardShortcuts = 0 pogodaka. Nema jednoslovnih prečica ni '?' overlay-a sa spiskom prečica.

#### ⚪ X-EXPORT-UX-04 — Nema 'sticky' horizontalnog skrol-bara za široke tabele (npr. mesečni grid sati)
*NISKO · effort S · ergonomija · verdikt: CONFIRMED*

- **1.0:** 1.0 lib/stickyHscroll.js: za tabele šire od viewport-a ubacuje proxy skrol-traku position:sticky;bottom:0 zalepljenu za dno VIDLJIVOG viewport-a (a ne za dno dugačkog sadržaja), sinhronizuje scrollLeft sa pravim wrap-om, auto-sakriva kad nema overflow-a, sakriva se na mobilnom. Rešava da kod dugih tabela horizontalni bar ne bude off-screen dok ne skroluješ skroz dole. Koristi se u kadrovska (workHours/absences), pb/planTab, planMontaze/planTable. _(‎src/lib/stickyHscroll.js (attachStickyHscroll, sticky-hscroll-proxy/spacer); pozivi u ui/kadrovska/workHoursTab.js, absencesTab.js, contractsTab.js, ui/pb/planTab.js, ui/planMontaze/planTable.js)_
- **3.0:** 3.0 DataTable i grid koriste samo obično overflow-x:auto na wrap-u (bar je na dnu SADRŽAJA). Nema sticky proxy skrol-trake. Kod veoma širokih tabela (kadrovska mesečni grid ~31 dnevna kolona + 4 reda po radniku) horizontalni bar je van ekrana dok se ne skroluje na dno. _(‎grep 'sticky.*scroll|hscroll|scrollLeft|position: sticky.*bottom' po frontend/src/app/kadrovska i components = 0 pogodaka; DataTable (components/ui-kit/data-table.tsx) ima samo 'overflow-x-auto' wrapper)_
- **Uticaj:** Korisnici kadrovska mesečnog grida i planova (široke tabele) — moraju da skroluju na dno da bi našli horizontalnu traku, ili koriste Shift+točkić. Postoji zaobilaznica; kozmetička polировка iz 1.0.
- **Verifikator:** grep sticky-scroll/hscroll/scrollLeft proxy = samo 2 fajla; kadrovska grid-table.tsx koristi sticky top-0/left-0/bottom-0 za lepljivo zaglavlje/kolone/podnožje (delimično ublažava), ali NEMA sticky proxy horizontalnu traku zalepljenu za dno viewport-a; reversi-labels.ts je štampa. Feature iz 1.0 (attachStickyHscroll proxy bar) ne postoji.

#### 🟡 X-EXPORT-UX-05 — Nema jedinstvenog brendisanog confirm dijaloga — miks native window.confirm i ad-hoc dijaloga
*SREDNJE · effort M · ergonomija · verdikt: CONFIRMED*

- **1.0:** 1.0 lib/confirm.js (121 linija) daje jedinstven, brendiran, a11y confirm modal (fokus-trap, Esc/Enter, opasne akcije istaknute) koji zamenjuje native window.confirm svuda — konzistentan izgled i ponašanje, radi i u Capacitor ljusci. _(‎src/lib/confirm.js (showConfirm/asyncConfirm obrazac, brendiran modal umesto window.confirm))_
- **3.0:** 3.0 je nekonzistentan: ~180 poziva confirm()/window.confirm (native, nestilizovan, van dizajn-sistema) u glavna-knjiga, izvodi, kadrovska grid/work-hours/teren/notifikacije, ai-chat, handovers itd., DOK deo modula (kadrovska/odmori, handovers/common) koristi vlastiti brendirani await confirm({...}) dijalog. Nema jedne deljene kit komponente pa se obrasci razilaze. _(‎grep 'window.confirm|[^a-z]confirm(' u app/*.tsx = 182 pogotka; native window.confirm potvrđen na glavna-knjiga/[id]/page.tsx:115/126/138, kadrovska grid-tab.tsx:269/365/397, work-hours-tab.tsx:127/134, ai-chat.tsx:175; brendirani await confirm({...}) samo u kadrovska/odmori/* i handovers/common.tsx (dokaz da deljeni obrazac nije usvojen svuda))_
- **Uticaj:** Svi korisnici na destruktivnim akcijama (brisanje, slanje obračuna, storniranje) — native browser confirm iskače van dizajna, na engleskom OK/Cancel, ne poštuje temu/tastaturne konvencije, a u mobilnoj/Capacitor ljusci ume da se ponaša drugačije. Nekonzistentno iskustvo modul-do-modula.
- **Verifikator:** grep window.confirm|confirm( u app/ = 118 pogodaka u 71 fajlu (native, npr. glavna-knjiga/[id]/page.tsx, ai-chat.tsx, izvodi/[id]/page.tsx). Istovremeno postoji NAJMANJE 5 nezavisnih ad-hoc ConfirmDialog implementacija (kadrovska/dosije/shared.tsx:180, handovers/common.tsx:50, structures/common.tsx:92, zahtevi/nagrade-tab.tsx:344, zahtevi/action-bars.tsx:842). Nema jedne deljene ui-kit confirm komponente — obrasci se razilaze.

### CROSS-CUTTING: Email notifikacije + Automatike (cron/edge) preko svih modula

#### 🔴 X-EMAIL-AUTOMATIKE-01 — 3.0 nema NIKAKAV scheduler/cron pogon (koren svih automatika)
*KRITICNO · effort L · automatika · verdikt: CONFIRMED*

- **1.0:** 1.0 ima celu klasu vremenskih automatika kroz pg_cron (Supabase) + edge funkcije: dnevni/nedeljni/5-min poslovi koji sami INSERT-uju u notifikacione outbox tabele (kadr/sast/maint/pb/loc) i dispatch workeri koji ih šalju. Ukupno ~15 zakazanih poslova (cron.schedule) + 6 notify-dispatch edge fn. _(‎sql/migrations/*.sql (add_kadr_*, add_sastanci_reminder_jobs, sast_weekly_auto, add_maint_*deadline*, add_scada_v3_alarm_push) sadrže cron.schedule(...) pozive; supabase/functions/{hr,maint,pb,sastanci}-notify-dispatch + loc-sync-monitor-dispatch su batch workeri.)_
- **3.0:** NEMA ničega. package.json bez @nestjs/schedule; grep @Cron|@Interval|@Timeout|SchedulerRegistry|ScheduleModule|setInterval po backend/src = 0 pogodaka. MailService (common/mail) i NotificationsService (in-app app_notifications) su čisto sinhroni — šalju samo kad korisnik pozove endpoint. Nijedan vremenski okidač ne postoji u aplikaciji. _(‎grep -rlE '@Cron|@Interval|@Timeout|SchedulerRegistry|ScheduleModule|CronJob|setInterval' backend/src → prazno; grep 'schedule|node-cron|@nestjs/schedule' backend/package.json → prazno; pročitan notifications.service.ts (samo CRUD nad app_notifications) i mail.service.ts (fetch→Resend, bez ikakvog raspoređivanja).)_
- **Uticaj:** Svi timovi koji zavise od automatskih podsetnika (HR, Projektni biro, Održavanje, Sastanci). Dok god ovo ne postoji, 3.0 ne može da preuzme nijednu vremensku automatiku sa sy15 — most se ne može ugasiti (F5). Root-cause za sve gapove ispod.
- **Verifikator:** Nema nijednog vremenskog pogona u 3.0: grep @Cron|@Interval|@Timeout|SchedulerRegistry|ScheduleModule|CronJob|setInterval po backend/src = 0; nema @nestjs/schedule/node-cron/bull ni u jednom package.json; nema ni GitHub-Actions 'schedule/cron:' u .github/workflows. notifications.service.ts je čist in-app CRUD nad app_notifications, mail.service.ts sinhroni fetch→Resend bez reda/raspoređivanja.

#### 🟠 X-EMAIL-AUTOMATIKE-02 — Podsetnik na istek ugovora/dokumenata (kadr, cron enqueue) — nije u 3.0
*VISOKO · effort M · automatika · verdikt: PARTIAL*

- **1.0:** pg_cron dnevno proverava ugovore i lekarske/dokumente pred istek i INSERT-uje redove u kadr_notification_log (tip contract_expiring/medical_expiring) 30/na-dan; posebno qbt_operator_cards_daily (04:30) za strane radnike (dokumenti, grane H) i službene bankarske kartice (grana I) — jer 'Intesa ne obaveštava'. _(‎sql/migrations/add_kadr_contract_expiry_oversight.sql, add_kadr_contract_expiry_admin_and_dueday.sql, add_kadr_notifications.sql (notification_type 'contract_expiring'/'medical_expiring'), sql/manual/stranci_kartice_podsetnici_2026-07-02.sql (cron.schedule('qbt_operator_cards_daily','30 4 * * *')).)_
- **3.0:** 3.0 kadrovska ČUVA ugovore (contract.create/update, polje expiresOn) ali NEMA nikakav posao koji skenira istek i pravi obaveštenje. Enqueue cron ne postoji u aplikaciji; u sy15 je pg_cron još fizički prisutan ali sy15-scheduler okida SAMO dispatch fn — nije potvrđeno da enqueue poslovi rade → verovatno tiho mrtvi posle cutover-a. _(‎grep -riE 'istek|expir|contract_expir|medical_expir|birthday' backend/src/modules/kadrovska → samo CRUD polja expiresOn (kadrovska-mutations.service.ts:1214/1233), nula enqueue/skener logike; grep @Cron po backend/src prazno; PLAN_F5_GASENJE_MOSTA.md:121 'sy15-scheduler okida SAMO notifikacione (dispatch) fn'.)_
- **Uticaj:** HR/administracija: propušteni istek ugovora, lekarskih pregleda, boravišnih dokumenata stranaca i bankarskih kartica = pravni/operativni rizik. Zaobilaznica: ručno praćenje u Excelu.
- **Verifikator:** Enqueue/skener istekâ ne postoji u 3.0 (nema @Cron), ali konfiguracija i outbox JESU tu: kadrovska-mutations.service.ts:2715 updateNotificationConfig čuva contractLeadDays/medicalLeadDays/lkLeadDays/passportLeadDays/driverLicenseLeadDays, a :2768 notificationRetry radi retry nad kadr_notification_log ('dispatch cron ga preuzme'). Fali samo dnevni posao koji skenira istek i puni outbox — on je na sy15.

#### 🟡 X-EMAIL-AUTOMATIKE-03 — Podsetnik na korektivne mere (07:30 dnevno) — nije u 3.0
*SREDNJE · effort M · automatika · verdikt: PARTIAL*

- **1.0:** pg_cron 'kadr_corrective_reminders_daily' u 07:30 pravi obaveštenja o dospelim korektivnim merama (iz razgovora sa zaposlenima). _(‎sql/migrations/2026-07-03_employee_talks_corrective.sql + cron.schedule('kadr_corrective_reminders_daily','30 7 * * *', ...).)_
- **3.0:** Nema odgovarajuće automatike u 3.0. Enqueue cron postojao je na cloud pg_cron (sada read-only, sql/manual/20260710...crons.sql potvrđuje cloud je READ-ONLY) → tiho mrtvo osim ako je premešteno u sy15 (nepotvrđeno). _(‎grep -riE 'corrective|korektiv|razgovor|talk' backend/src → 0; grep @Cron backend/src → 0.)_
- **Uticaj:** HR/rukovodioci koji prate korektivne mere iz razgovora sa zaposlenima — rokovi se propuštaju. Zaobilaznica: ručna provera.
- **Verifikator:** Korektivne mere kao entitet POSTOJE u 3.0 (dto: CreateCorrectivePlanDto/UpdateCorrectivePlanDto, 1.0 saveCorrectivePlan port), ali dnevni podsetnik u 07:30 (kadr_corrective_reminders_daily) ne postoji — nema nijednog @Cron/schedulera. Reviewerov grep 'corrective|korektiv' promašio je jer je gledao samo backend/src bez dto sloja.

#### ⚪ X-EMAIL-AUTOMATIKE-04 — Podsetnici pri onboardingu novih radnika (dnevno) — nije u 3.0
*NISKO · effort M · automatika · verdikt: PARTIAL*

- **1.0:** pg_cron 'kadr_onboarding_reminders_daily' (07:00) generiše zadatke/obaveštenja za korake onboardinga novozaposlenih. _(‎sql/migrations/add_kadr_onboarding_reminders.sql + cron.schedule('kadr_onboarding_reminders_daily','0 7 * * *', ...).)_
- **3.0:** Nema u 3.0. _(‎grep -riE 'onboard|onboarding' backend/src → 0; grep @Cron backend/src → 0.)_
- **Uticaj:** HR: koraci uvođenja novog radnika bez automatskog podsetnika. Zaobilaznica: ručna lista.
- **Verifikator:** Onboarding JESTE u 3.0 (dto: OnboardingStartDto/OnboardingTaskDto/OnboardingRunStatusDto, kind onboarding/offboarding), pa reviewerova tvrdnja 'grep onboard = 0' ne stoji. Fali samo dnevni podsetnik-posao (kadr_onboarding_reminders_daily) jer 3.0 nema scheduler.

#### 🟡 X-EMAIL-AUTOMATIKE-05 — Alarmi/nedeljni digest prisustva + nedeljni HR rizik-rezime — nije u 3.0
*SREDNJE · effort M · automatika · verdikt: PARTIAL*

- **1.0:** Više pg_cron poslova: 'kadr_attendance_alerts_utc4/utc5' (dnevno, DST-dupli) za anomalije prisustva; 'kadr_attendance_digest_utc4/utc5' (ponedeljak) sedmični digest; 'kadr_weekly_risk_summary' (nedeljni HR rizik-rezime, npr. istekli dokumenti/rođendani/godišnjice). _(‎sql/migrations/add_kadr_attendance_selfservice.sql, add_kadr_weekly_risk_summary.sql, add_kadr_birthday_oversight_and_digest.sql — cron.schedule('kadr_attendance_alerts_utc4','0 4 * * *')/utc5, digest '30 4/5 * * 1'.)_
- **3.0:** Nema nijednog sedmičnog/dnevnog HR digesta ni alarma prisustva u 3.0. (3.0 ima kapiju/prisustvo podatke ali bez zakazanog sažetka/alarma.) _(‎grep -riE 'digest|weekly_risk|attendance_alert|rizik|sazetak|rodjend|birthday|anniversar|godisnjic' backend/src → 0 relevantnih; grep @Cron backend/src → 0.)_
- **Uticaj:** HR menadžment: nema automatskog nedeljnog pregleda rizika ni alarma na anomalije prisustva; rođendani/godišnjice se ne javljaju. Zaobilaznica: ručni izveštaji.
- **Verifikator:** Konfiguracija za rođendane/godišnjice/digest POSTOJI u 3.0 (dto flagovi birthdayOversightEnabled/birthdayDigestEnabled/workAnniversaryEnabled + config upis :2727-2747), ali sami zakazani poslovi (attendance_alerts, weekly_risk_summary, birthday_digest) ne postoje — nema @Cron/schedulera. Generator sažetaka/alarma fali.

#### 🟠 X-EMAIL-AUTOMATIKE-06 — Sastanci: automatski podsetnici (30 min pre + dnevno za akcije) — nije u 3.0
*VISOKO · effort M · automatika · verdikt: CONFIRMED*

- **1.0:** pg_cron 'sast_meeting_reminders_30min' (svakih par min, šalje podsetnik 30 min pre sastanka) i 'sast_action_reminders_daily' (dnevno, podsetnik na dospele akcione tačke) upisuju u sast_notification_outbox; dispatch šalje mejl. _(‎sql/migrations/add_sastanci_reminder_jobs.sql (cron.unschedule/schedule 'sast_meeting_reminders_30min','sast_action_reminders_daily'), add_sastanci_notification_outbox.sql.)_
- **3.0:** 3.0 sastanci modul ČITA preferencije (onMeetingReminder/onActionReminder u prefs) i status, ali NEMA posao koji te podsetnike generiše. Enqueue je pg_cron u glavnoj bazi/sy15 — u aplikaciji ne postoji. _(‎grep -nE 'reminder|podsetnik|30min|action_reminder' backend/src/modules/sastanci/sastanci.service.ts → samo čita prefs kolone (on_action_reminder/on_meeting_reminder, linija ~721); nema enqueue logike; grep @Cron backend/src → 0.)_
- **Uticaj:** Svi učesnici sastanaka: nema 'za 30 min imate sastanak' ni podsetnika na zaostale akcije. Preferencije postoje u UI ali su prazno obećanje ako niko ne generiše. Zaobilaznica: ručno praćenje.
- **Verifikator:** sastanci.service.ts samo ČITA prefs kolone on_meeting_reminder/on_action_reminder; nema koda koji generiše podsetnik 30min-pre ni dnevni action-reminder, i nema nijednog @Cron/setInterval u backend/src. Enqueue posao je isključivo pg_cron na sy15.

#### 🟠 X-EMAIL-AUTOMATIKE-07 — Sastanci: automatsko kreiranje sedmičnog sastanka (petak 08h, DST-guard) — nije u 3.0
*VISOKO · effort M · automatika · verdikt: CONFIRMED*

- **1.0:** pg_cron 'sast_weekly_auto_create_a/b' (petkom 06:00 i 07:00 UTC, sa lokalnim guardom da radi samo na tačno 08h Beograd leti/zimi) automatski kreira sledeći sedmični sastanak i briše skip-flag; podržava 'odloži nedelju'. _(‎sql/migrations/sast_weekly_auto.sql (cron.schedule('sast_weekly_auto_create_a','0 6 * * 5'), _b '0 7 * * 5', DST guard komentari 'kreiraj samo kad je LOKALNO 08h petkom').)_
- **3.0:** 3.0 sastanci ima 'next-weekly' READ i sast_weekly_status RPC, ali NEMA automatsko kreiranje. Cron je bio na cloud-u (isključen/read-only per sql/manual/20260710...crons.sql, jobid 22/23) → potencijalno tiho mrtvo; u sy15 postoji ali sy15-scheduler okida samo dispatch fn. _(‎grep -nE 'weekly|nedeljni|petak|auto.?create|sast_weekly' backend/src/modules/sastanci/sastanci.service.ts → samo weeklyStatus/next-weekly READ (RPC sast_weekly_status), bez kreiranja; PLAN_SASTANCI_PRIMEDBE ne pominje reimplementaciju automatike.)_
- **Uticaj:** Organizator sedmičnog kolegijuma: sastanak se više ne kreira sam petkom — mora ručno svake nedelje, i lako se zaboravi. Zaobilaznica: ručno kreiranje.
- **Verifikator:** U 3.0 postoje samo READ/ručne rute: controller.ts:104 GET next-weekly, :124 GET weekly (weeklyStatus RPC), :494-508 POST weekly/pomeri|odlozi|vrati. Nema auto-create posla (sast_weekly_auto_create) niti bilo kakvog schedulera — sedmični sastanak se sam ne kreira petkom.

#### 🟠 X-EMAIL-AUTOMATIKE-08 — Održavanje: automatska provera rokova (vozila/IT/objekti) — samo ručni endpoint u 3.0
*VISOKO · effort M · automatika · verdikt: PARTIAL*

- **1.0:** pg_cron ('maint-deadline-check-daily' i varijante za vozila/IT/objekte) dnevno skenira rokove (registracije, servisi, pregledi) i enqueue-uje u maint_notification_log; maint-notify-dispatch šalje. _(‎sql/migrations/add_maint_deadline_check_cron.sql, add_maint_it_facility_deadline_cron.sql, add_maint_vehicle_deadline_check.sql (cron.unschedule('maint-deadline-check-daily')); supabase/functions/maint-notify-dispatch/index.ts.)_
- **3.0:** 3.0 održavanje IMA UI za notifikaciona pravila (maintNotificationRule CRUD), pregled maint_notification_log i retry, ČAK i vehicleDeadlineCheck — ali to je RUČNI endpoint (POST) koji zove sy15 RPC; nema zakazanog dnevnog skena. Bez pogona rokovi se ne proveravaju sami. _(‎odrzavanje.service.ts:3367 vehicleDeadlineCheck(...) = ručni endpoint ($queryRaw enqueued/skipped); komentar linija 1733 'notif outbox INSERT je DENY-ALL (enqueue = trigeri/cron)'; grep @Cron backend/src → 0 → nijedan automatski dnevni sken.)_
- **Uticaj:** Održavanje/vozni park: registracije i servisni rokovi se ne javljaju automatski — samo ako neko ručno klikne proveru. Zaobilaznica: ručno pokretanje provere.
- **Verifikator:** Tačno kako je prijavljeno: odrzavanje.service.ts:3367 vehicleDeadlineCheck je RUČNI endpoint koji zove RPC maint_check_vehicle_deadlines(lookaheadDays); komentar :1733 'Notif outbox INSERT je DENY-ALL (enqueue = trigeri/cron)'. Motor postoji, ali zakazani dnevni sken ne — nema @Cron u 3.0.

#### 🟠 X-EMAIL-AUTOMATIKE-09 — Dispatch workeri outboxa (hr/maint/pb/sastanci) žive na sy15, ne u 3.0
*VISOKO · effort L · email-notifikacije · verdikt: OUT-OF-SCOPE*

- **1.0:** 6 edge funkcija su batch dispatch workeri koji dequeue-uju notifikacione outbox tabele i šalju preko Resend/WhatsApp uz backoff, dead-letter, priloge iz Storage-a: hr-notify-dispatch, maint-notify-dispatch, pb-notify-dispatch (Projektni biro), sastanci-notify-dispatch, loc-sync-monitor-dispatch, push-dispatch. _(‎supabase/functions/{hr,maint,pb,sastanci}-notify-dispatch/index.ts (RPC *_dispatch_dequeue/mark_sent/mark_failed, Resend, WhatsApp Meta Cloud API, fetchAttachment iz Storage), loc-sync-monitor-dispatch, push-dispatch.)_
- **3.0:** NEMA ekvivalent u 3.0. 3.0 MailService šalje jedan-po-jedan sinhrono bez outbox reda, bez retry/backoff/dead-letter, bez WhatsApp kanala. Sastanci pozivnice/otkazi se u 3.0 upisuju u outbox kroz DB trigere (sastanci_send_invites), ali IH ŠALJE sy15 edge worker — tj. živi ali na starom sistemu (dug). _(‎grep -rlE 'MailService|dispatch|dequeue|outbox|backoff|whatsapp' backend/src → MailService (sinhroni fetch, bez reda) i samo READ maint_notification_log/retry u odrzavanje.service.ts; nema *_dispatch_dequeue niti WhatsApp koda; PLAN_F5_GASENJE_MOSTA.md:121 potvrđuje da sy15-scheduler i dalje okida ove fn (radi na starom sistemu).)_
- **Uticaj:** Svi moduli sa mejl-notifikacijama zavise od sy15 edge/scheduler-a koji treba ugasiti (F5). Dug: dupla infrastruktura; bez outbox/retry u 3.0 nema garancije isporuke i nema WhatsApp kanala koji je 1.0 imao. Radi ali na starom sistemu.
- **Verifikator:** Nema dispatch worker-a u 3.0 (common/workers/ ima samo resolve-actor-worker i technologist-criteria helpere; nema *_dispatch_dequeue/backoff/WhatsApp koda). Svesno ostavljeno na sy15 — kadrovska-mutations.service.ts:2712 'NOTIFIKACIJE dispatch/push OSTAJE 1.0 pozadina (paritet-only)'; radi na starom sistemu, ali je dug (bez outbox retry/WhatsApp u 3.0 app).

#### 🟡 X-EMAIL-AUTOMATIKE-10 — Javni RSVP magic-link (potvrda dolaska iz mejla, bez logina) — samo na sy15/1.0
*SREDNJE · effort M · funkcionalnost · verdikt: OUT-OF-SCOPE*

- **1.0:** sastanci-rsvp edge fn obrađuje magic-link iz pozivnice: pozvani klikne link u mejlu (rsvp_token) i potvrdi/odbije dolazak BEZ prijave u aplikaciju. _(‎supabase/functions/sastanci-rsvp/index.ts; rsvp_token generisan u outbox/učesnicima.)_
- **3.0:** 3.0 ima RSVP SAMO kroz autentifikovan endpoint POST /sastanci/:id/rsvp (JWT obavezan, PermissionsGuard). Magic-link tok (nelogovan primalac) nije reimplementiran — token se namerno nikad ne vraća FE-u, pa javne potvrde iz mejla i dalje idu na sy15. _(‎sastanci.controller.ts:588 @Post(':id/rsvp') pod @UseGuards(JwtAuthGuard,PermissionsGuard); sastanci.service.ts:86 komentar 'rsvpToken se NIKAD ne vraća'; grep -rniE 'rsvp_token|magic.?link|potvrdi.*dolazak' backend/src frontend/src → nema javne no-JWT rute.)_
- **Uticaj:** Eksterni/nelogovani učesnici sastanaka ne mogu da potvrde dolazak iz mejla u 3.0 — funkcioniše samo dok sy15 edge živi. Radi na starom sistemu.
- **Verifikator:** 3.0 ima samo autentifikovan RSVP: sastanci.controller.ts:588 @Post(':id/rsvp') → setMyRsvp(req.user.email,...); rsvpToken se namerno NIKAD ne vraća (service.ts:82). Javni magic-link (nelogovani primalac) svesno nije prenet i i dalje ga obrađuje sy15 edge (sastanci-rsvp) — radi na starom sistemu.

#### 🟡 X-EMAIL-AUTOMATIKE-11 — 360° procena: pozivnica se šalje iz 3.0, ali rater-stranica (ocena.html) je 1.0
*SREDNJE · effort M · funkcionalnost · verdikt: PARTIAL*

- **1.0:** assessment-invite edge fn šalje mejl pozivnice za 360° procenu + rezime kreatoru; link vodi na javnu stranicu ocena.html?token=<token> gde ocenjivač popunjava procenu bez logina; upisuje invited_at. _(‎supabase/functions/assessment-invite/index.ts (link 'https://servosync.servoteh.com/ocena.html?token='); dvorežimska (jedan ciklus / cela procena).)_
- **3.0:** 3.0 kadrovska JE reimplementirala SLANJE pozivnice nativno (MailService, endpoint), ALI magic-link i dalje pokazuje na 1.0 statičnu stranicu ocena.html (env ASSESSMENT_PUBLIC_BASE default https://servosync.servoteh.com). Sama rater-forma za unos ocena nije preneta u 3.0 → ocenjivač ocenjuje u staroj aplikaciji. _(‎kadrovska-mutations.service.ts:2026 base default 'https://servosync.servoteh.com', :2187 link `${base}/ocena.html?token=`; find frontend -iname 'ocena*' → nema (jedini pogodak zahtevi/detalj); tj. 3.0 nema rutu za popunjavanje 360 procene.)_
- **Uticaj:** Ocenjivači u 360° ciklusu popunjavaju na staroj aplikaciji koja se gasi; kad ocena.html padne, procene ne rade iako 3.0 šalje pozivnice. Radi delimično na starom sistemu.
- **Verifikator:** 3.0 je reimplementirala slanje pozivnice (kadrovska-mutations:2012 assessmentInvite) + interni upis ocena (:1991 assessmentSaveScores, RLS asc_write) + rukovodilačku matricu (frontend .../razvoj/assessments.tsx). ALI javna rater-forma ocena.html nije preneta: link :2187 `${base}/ocena.html?token=` sa default :2027 https://servosync.servoteh.com (1.0); u frontend/ nema ocena.html — ocenjivač preko tokena i dalje popunjava na 1.0.

#### ⚪ X-EMAIL-AUTOMATIKE-12 — Kadr mejl sa prilogom (dokument iz Storage-a) + WhatsApp kanal — osiromašeno u 3.0
*NISKO · effort M · email-notifikacije · verdikt: PARTIAL*

- **1.0:** hr-notify-dispatch podržava prilog: povlači fajl iz Storage bucket-a (employee-docs) i šalje kao base64 Resend attachment; podržava i WhatsApp (Meta Cloud API, sr template) i email kanal, sa normalizacijom telefona. _(‎supabase/functions/hr-notify-dispatch/index.ts: fetchAttachment() (payload.attachment_path/bucket/filename), sendWhatsApp() sa normalizeWaPhone(), kanali whatsapp|email|sms.)_
- **3.0:** 3.0 MailService PODRŽAVA priloge (attachments: Buffer→base64), ali NEMA WhatsApp/SMS kanal i nema outbox-driven attachment iz Storage-a za kadr obaveštenja (jer nema ni kadr enqueue automatiku). Kanal-diverzitet 1.0 (WhatsApp) je izgubljen. _(‎mail.service.ts podržava attachments ali samo email; grep -riE 'whatsapp|sms|Meta Cloud|graph.facebook' backend/src → 0; nema kadr-notif dispatch logike u aplikaciji.)_
- **Uticaj:** HR: gubi se WhatsApp kanal za obaveštenja radnicima (1.0 ga je imao kao alternativu email-u). Zaobilaznica: samo email.
- **Verifikator:** WhatsApp kanal NIJE potpuno izgubljen: 3.0 čuva whatsappRecipients u kadrNotificationConfig (updateNotificationConfig:2733) + ima phone.ts/notifikacije UI; sy15 dispatch te primaoce koristi. Nedostaje samo NATIVNI WhatsApp send u 3.0 (grep graph.facebook|sendWhatsApp|Meta Cloud po backend/src = 0). MailService podržava priloge ali samo email kanal.

#### ⚪ X-EMAIL-AUTOMATIKE-13 — Loc-sync health monitor + SCADA watchdog (5-min automatika) — samo na sy15
*NISKO · effort M · automatika · verdikt: OUT-OF-SCOPE*

- **1.0:** pg_cron 'loc_sync_health_check_hourly' + 'loc_sync_monitor_dispatch_every_5_min' (edge loc-sync-monitor-dispatch) prate zdravlje loc-sync worker-a (heartbeat, dead-letter digest, worker-down alarm); 'scada_watchdog_every_5_min' šalje SCADA alarm push. _(‎sql/migrations/add_loc_sync_health_monitor.sql, add_loc_sync_monitor_dispatch_pulse.sql (cron */5), supabase/functions/loc-sync-monitor-dispatch/index.ts; add_scada_v3_alarm_push.sql (cron.schedule('scada_watchdog_every_5_min','*/5 * * * *')).)_
- **3.0:** Nema u 3.0. Loc-sync monitoring je deo loc_* sistema koji se planski gasi (F5); SCADA watchdog nije prenet. Žive na sy15 dok most stoji. _(‎grep -riE 'health.?monitor|heartbeat|watchdog|scada.*alarm|worker.?down' backend/src → 0; PLAN_F5_GASENJE_MOSTA.md tretira loc-sync-monitor-dispatch kao deo B3/F5 seobe.)_
- **Uticaj:** Infra/operateri: nema automatskog alarma kad sync worker/SCADA relej padne u 3.0. Za loc već planirano (F5); SCADA watchdog nije planiran. Radi na starom sistemu.
- **Verifikator:** Nema loc-sync health monitora ni SCADA watchdog posla u 3.0 (jedini 'heartbeat' pogodak je energetika.service.ts READ prikaz online/last_seen SCADA sajtova, ne cron alarm). Loc-sync monitoring je deo loc_* sistema koji se planski gasi u F5; watchdog žive na sy15 dok most stoji.

## Aneks B — Već popisano u postojećim planovima (žetva docs, 51 stavki)

- CUTOVER_AUDIT_lokacije_2026-07-17.md → PL-01: GET /part-locations?q=<širok> vraća 500 (bind-param overflow u list()); svaki čest karakter u pretrazi obara endpoint (VISOKO, BLOCKER)
- CUTOVER_AUDIT_lokacije_2026-07-17.md → PLK-01: GET /locations/definitions-audit 500 (loc_locations_audit/audit_log drift; migracija add_loc_locations_audit.sql ne postoji u repou; servis bez try/catch, FE bez retry:false) (VISOKO, BLOCKER)
- CUTOVER_AUDIT_lokacije_2026-07-17.md → L-22: Pregled predmeta picker traži UKUCAN numerički ID umesto search-liste otvorenih predmeta (U TOKU, ⭐ prvi) (SREDNJE)
- CUTOVER_AUDIT_lokacije_2026-07-17.md → L-23: hero samo „Predmet #id" + HARDKODOVAN badge „U TOKU" (prikazuje ga i za zatvoren predmet) (SREDNJE)
- CUTOVER_AUDIT_lokacije_2026-07-17.md → L-27: Štampa/Export PDF/CSV celog filtriranog spiska (18 kolona) ne postoji — samo per-red TP nalepnica (SREDNJE, GAP)
- CUTOVER_AUDIT_lokacije_2026-07-17.md → L-14: Pregled po lokacijama — na ekranu fale kolone Ukupno/Status/Akcije (podaci su u CSV-u) (SREDNJE)
- CUTOVER_AUDIT_lokacije_2026-07-17.md → L-16: Pregled po lokacijama — red nema akcije (klik→istorija, ⚙ RN/TP op-modal, TP nalepnica) (SREDNJE, GAP)
- CUTOVER_AUDIT_lokacije_2026-07-17.md → L-06/L-07: baneri „keš zastareo" i „sync worker zdravlje" gejtovani za admina — magacioner/cnc ne vide upozorenje (SREDNJE)
- CUTOVER_AUDIT_lokacije_2026-07-17.md → L-33: forma KAVEZ + bulk osiromašena vs 1.0 (SREDNJE)
- CUTOVER_AUDIT_lokacije_2026-07-17.md → L-20/L-21: Sync tab — ingest worker panel i outbound events prikazani kao sirov JSON <pre> umesto kartica/tabele (NISKO)
- CUTOVER_AUDIT_lokacije_2026-07-17.md → PL-02: atribucija izvršioca u ledger upisima = radnik sa RN, ne prijavljeni korisnik (nema User↔Worker veze; TODO(auth)) (NISKO)
- CUTOVER_AUDIT_lokacije_2026-07-17.md → PLK-02: POST /locations/sync/run-now bez DTO brane/confirm/lock — slučajan POST okida ingest posao (NISKO)
- CUTOVER_AUDIT_reversi_2026-07-17.md → RC-17/RC-32: POVRAĆAJ REZNOG ALATA ne postoji sa FE strane (nema dugmeta/dijaloga/hooka; BE ruta cutting-return mrtva) — izdavanje jednosmerno (KRITIČNO)
- CUTOVER_AUDIT_reversi_2026-07-17.md → RC-06/RC-09: TIHE LAŽI — kolona „Na stanju" sabira SVE lokacije (prikazuje ukupno seedovano, ne raspoloživo u magacinu); semafor niske zalihe ne okida kad je magacin prazan (KRITIČNO)
- CUTOVER_AUDIT_reversi_2026-07-17.md → PR-01: PATCH /cutting-tools/:id na nepostojeći UUID vraća 500 umesto 404 (Prisma P2025 bez mapiranja) (SREDNJE)
- CUTOVER_AUDIT_reversi_2026-07-17.md → PR-02: GET /documents/:id/signature-pdf 422 — objekat fali u sy15 bucketu reversal-pdf (upload lanac potpisnice sumnjiv) (SREDNJE)
- CUTOVER_AUDIT_reversi_2026-07-17.md → RB-04: kartica alata bez trenutnog zaduženja/lokacije i pola polja (VISOKO)
- CUTOVER_AUDIT_reversi_2026-07-17.md → RA-30/31/33: magacin (zbirno) bez trake filtera („Sve lokacije" postoji na BE, nije priključeno na FE) (VISOKO)
- CUTOVER_AUDIT_reversi_2026-07-17.md → RA-39/40: izveštaj potrošnje ne postoji (VISOKO)
- CUTOVER_AUDIT_reversi_2026-07-17.md → RA-43: workbench bez „Urgentno" (VISOKO)
- CUTOVER_AUDIT_reversi_2026-07-17.md → RA-22/35: bulk štampa nalepnica ne postoji (VISOKO)
- CUTOVER_AUDIT_reversi_2026-07-17.md → RC-01…: ceo tab „Rezni alat" sa 4 pod-taba ne postoji kao takav (VISOKO)
- CUTOVER_AUDIT_reversi_2026-07-17.md → RC-43/50/51/53–55: bulk import sa sesijama i stornom ne postoji (VISOKO)
- CUTOVER_AUDIT_reversi_2026-07-17.md → RB-46/RB-11: modali „Nova jedinica" i „Izmena artikla" ne postoje (VISOKO)
- CUTOVER_AUDIT_reversi_2026-07-17.md → ukupni paritet 23/173 desktop funkcija (13%); put do GO = Drop R0 pa R1–R5 (~5,2 MN); katalog reznog prazan (0 redova — čeka domensku validaciju vlasnika)
- CUTOVER_AUDIT_odrzavanje_2026-07-17.md / CUTOVER_FOLLOWUP_odrzavanje_2026-07-20.md → Live-RLS matrica (#45/#46): row-scope proven-by-construction ali NIJE dokazan živim testom (operator machine-scope, chief-bez-role, magacioner) — čeka odluku o test-profilima na produ (nije blokada)
- CUTOVER_FOLLOWUP_odrzavanje_2026-07-20.md → Živi smoke #48: deo-na-WO → skida zalihu atomski jedini je kod-verifikovan a ne živ-dokazan (magacin prazan); odluka 20.07 PRESKAČEMO, izvesti tek na zahtev
- CUTOVER_AUDIT_sastanci_ai_2026-07-17.md → Mobilni paritet /m/sastanci (2.0 samo read+status) — fale kreiranje/uređivanje akcija i tačaka, priprema po osobi, STT, slike, arhiva, pretraga/kalendar; mobilni ostaje 1.0 do dopune
- CUTOVER_AUDIT_sastanci_ai_2026-07-17.md → S-P1 AI sitnice: dnevni limit hardkodovan 50 (1.0 env), izgubljena distinkcija alat_neuspesan vs alat_nedostupan, /m/ai ne nastavlja poslednju nit <6h (NISKO)
- CUTOVER_AUDIT_sastanci_ai_2026-07-17.md → S-P1: sastanci_notification_log — razmotriti REVOKE INSERT za čvršću ogradu (RLS snl_insert dozvoljava authenticated+edit rolu) (NISKO)
- RADNI_PLAN_3.0.md → Blok B(1): Loc-most repoint — kod sletio 18.07, živa sekvenca čeka prozor; blokira gašenje QBigTehn; čeka 4 odluke (auth feed cron, backfill A vs start-od-sada B, granularnost signala, potvrda čitača)
- RADNI_PLAN_3.0.md → Blok B(3): Konsolidacija dve PG baze — Reversi+auth još čitaju sy15 preko 2. Prisma datasource-a
- RADNI_PLAN_3.0.md → Blok B(4): Gašenje PostgREST + GoTrue (sy15-*) + potpuna dekomisija 1.0 Vite fronta (SSO kapija + /m/*)
- RADNI_PLAN_3.0.md → Blok C2: Native core WRITE probe (net-zero) za TP/kiosk/MRP — off-hours na živoj bazi
- RADNI_PLAN_3.0.md → Blok C3: part-locations izvršilac fix — ledger upisuje RN-radnika umesto magacionera (part-locations.service.ts:331/342/409; resolveActorWorkerId postoji)
- RADNI_PLAN_3.0.md → Blok C4: RBAC definesApproval/Launch gate (work-orders.service.ts:1038/1080/1095) — čeka Nenadovu poslovnu odluku ko sme da odobri/lansira (nije bag, blokira prod ako pogrešno)
- RADNI_PLAN_3.0.md → Blok E (loose ends): GoTrue SITE_URL (reset lozinke) · servosync2 front pao · Lokacije BigTehn search · Štampa ulazna tačka iz Praćenja
- PLAN_PRACENJE_PROIZVODNJE_2026-07.md → F3 dopune tabele (docx zahtevi 1–12): stablo + % gotovosti po poziciji/podsklopu/sklopu, boja reda po tipu, freeze levih kolona pri horizontalnom skrolu, ručni unos količina, auto-status „Kompletirano"→maš/površ DA+100%, datum završetka operacije, brisanje kolone „usko grlo", rok izrade→dokument primopredaje, filteri maš/površ/pozicija, PDF na klik
- PLAN_PRACENJE_PROIZVODNJE_2026-07.md → F5 gašenje mosta: repoint Plan proizvodnje + Lokacija na glavnu bazu pa gašenje loc-tp-feed, pg_cron ingest-a i bigtehn_* keša u sy15
- RECEPT_M12_REDIRECT_PRACENJE_1.0.md / PLAN_F5 §3.2 → O8 (HITNO): 1.0 ekran Praćenja (desktop + /m/pracenje) NIJE cutover-ovan — čita sy15 podatke u koje 3.0 od 19.07 više ne piše (prikazuje zamrznuto, unosi u tabele koje niko ne čita); traži iframe-redirect po obrascu Tehnologije
- PLAN_F5_GASENJE_MOSTA.md → F5b (HITNO): Plan proizvodnje native repoint — PP i 1.0 Lokacije rade nad podacima ZAMRZNUTIM 14–15.07 (svako kucanje od tada ne postoji u planu mašina); M11 presuđeno: ide pravo na native, ne aktivirati feed
- PLAN_F5_GASENJE_MOSTA.md → F5b-1 GAP: 3.0 predmet_aktivacije NEMA kolonu je_projektovanje_montaza (F1 uvoz preneo samo aktivan/prioritete) → dodati kolonu + proširiti import + re-run, da flag bude spreman za B3/Plan montaže
- PLAN_F5_GASENJE_MOSTA.md → F5c: Lokacije — native ingest (čita tech_processes, upisuje loc_location_movements sa holdback 2min + storno skip) + repoint bigtehn čitanja + penzionisanje syncHealth pragova (inače trajni lažni baneri)
- PLAN_F5_GASENJE_MOSTA.md → F5d: fizičko gašenje — ukloniti LocTpFeedService/rute, unschedule loc_bigtehn_ingest_5min, DROP fn/state, RENAME+2ned soak pa DROP 3 feed keša + view lanac; prilagoditi monitor-sy15.sh; posle O8 soak-a DROP sy15 pracenje_* objekata (uz pg_dump)
- OTVORENA_PITANJA_TALASI_B-F_2026-07-12.md → C1: tim_lider edit Plana montaže je FANTOMSKI u 1.0 (front pušta, RLS ne — izmene žive samo u localStorage) → 2.0 dati PRAVI edit (montaza.edit + proširiti has_edit_role za tim_lider)
- OTVORENA_PITANJA_TALASI_B-F_2026-07-12.md → C3: pogon ne može otvoriti PDF crteža (can_read_production_drawings) — v1 strogi paritet; follow-up odluka za cnc_operater (crteži su IP)
- OTVORENA_PITANJA_TALASI_B-F_2026-07-12.md → D3: must_change_password — dodati boolean + force-change ekran u 2.0 auth
- OTVORENA_PITANJA_TALASI_B-F_2026-07-12.md → F1: CMMS notif dispatch je MRTAV na produ (RPC-ovi ne postoje, nema schedulera, ~30 queued od aprila) — seliti samo paritet (log+retry+rules); oživljavanje = post-seoba zadatak
- OTVORENA_PITANJA_TALASI_B-F_2026-07-12.md → B7/E6: orphan trigeri sast_trg_akcija_new/changed (mejl za akcije nikad zakačen) = backlog; scada_notify_prefs UI NE u v1 (backlog)
- PLAN_dorade_2026-07-10.md → D8-v2 BACKLOG: email izveštaji škarta (odmah po totalnom škartu na proizvodnja@+uprava@ sa Σ sati po komadu; nedeljni izveštaj ukupan škart+troškovi) — čeka SMTP/mail infrastrukturu i odluku
- PDF_GAP_2026-07-13.md → 6.199 odobrenih crteža bez PDF-a u drawing_pdfs (~2.300 aktuelnih: aktivan RN / u nacrtu / u primopredaji); pdm-bridge ne može unazad — traži ciljni re-export iz PDM Vault-a; odloženo (Nenad 13.07)
