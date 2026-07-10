# Plan: primopredaje → kucanje TP → lansiranje, štampa crteža, zbir po operaciji, cutover bez sync-a

> Nastalo iz multi-agentne analize 2026-07-10 (12 agenata, verifikovano čitanjem koda + živim upitom na
> legacy MSSQL). Izvori zahteva: Nenad + Miljan (šef tehnologije, opis rada) + `Xml.docx` (projektanti).
> Status: **PLAN — čeka redosled realizacije.** Otvorene odluke označene sa ⚠️.

## 0. Ciljno stanje (Nenadova odluka)

**Jednokratni finalni sync iz QBigTehn SQL-a, posle toga sync-a NEMA** — primopredaje, TP, RN i kucanje
žive nativno u 2.0. BigBit matični podaci (komitenti, **predmeti**, artikli…) ostaju na svom trajnom
sync-u (odluka „QBigTehn privremen / BigBit trajan") — vasa-SQL se ne gasi dok BigBit sync zavisi od njega.

## 1. Kako danas radi legacy (verifikovano)

- **PDM izvoz** (`Xml.docx`): pri odobravanju u PDM-u XML se generiše na `\\PDM2025PROD\D:\PDMExport\XML\`,
  PDF na `\\pdm-pdf\VASADATA\`. Skripte na **10 min** prebacuju na BigBit server; druga skripta na 10 min
  uvozi u bazu (Access parser: `XMLImport.bas` → `PDMXMLParser.bas` → `PDM_Common.bas` →
  `PDMCrtezi`/`KomponentePDMCrteza`/`PDMXMLImportLog`). XML atributi nose i **RN (broj predmeta, npr
  „9400/2")** i `Naziv_projekta` → osnov za auto-mapiranje predmeta u 2.0.
- **Projektni biro radi u QMegaTeh** (zasebna Access aplikacija nad istom bazom): Pregled crteža →
  kreiranje nacrta primopredaje (sklop ⇒ auto-ubacivanje svih delova + preračun količina).
- **Miljan odobrava** primopredaju i **bira tehnologa**; brojevi RN se kreiraju automatski redom
  (`9400/2/1`, `9400/2/2`…). Tehnolog u tabu „Odobrene" otvara „Dokument primopredaje" (zaglavlje već
  popunjeno iz PDM-a), kuca TP (Stavke/PND/PDM/PLP), štampa, pa **„Lansiraj Radni nalog"** →
  `spPromeniStatusPrimopredaje(IDRN,3)` → stavka nestaje iz pregleda (filter na status).
- Druga situacija: bez PDM veze → „Unos radnog naloga" (blanko), sve ručno. Treća: ponovljeni crteži →
  kopiranje TP („Prepiše stavke, delove, limove" / „Prepiši isti postupak").
- Legacy štampa svih crteža: `ShellExecute 'print'` na **default** štampač — bez izbora štampača.
  2.0 tu može samo bolje.

## 2. Odgovori na pitanja / nalazi

### 2.1 „Sve primopredaje" prazan tab — NIJE bug
`drawing_handovers` ima **0 redova** i to je ispravno: (a) 2.0 `POST /handover-drafts/:id/submit` još
niko nije koristio; (b) legacy tabela `PrimopredajaCrteza` je **prazna i danas na živom MSSQL-u**
(proveren COUNT 2026-07-10) — u legacy-ju primopredaja živi kao **atributi tRN reda**
(`IDPrimopredaje`, `IDStatusPrimopredaje`, `SifraRadnikaPrimopredaje`); 3.368 RN-ova nosi te podatke.
Bonus nalazi: `work_orders.drawing_handover_id` posle sync-a semantički sadrži **ID nacrta** (draft), ne
ID primopredaje; `handover_draft_statuses` lookup je prazan (nema seed). → Rešenje u §3 P4 (backfill).

### 2.2 Ručni unos RN (kooperacija) — VEĆ POSTOJI ✅
`/work-orders` ima dijalog „Novi RN" (zaglavlje) + **pun CRUD operacija TP-a**: broj operacije (auto
MAX+10), radna jedinica iz šifarnika `operations` (šifra+naziv, npr 4.1), opis rada, vreme pripreme (Tpz),
vreme po komadu (Tk), alat/pribor, prioritet; plus approve/launch/lock/copy-from/rework/bulk-clone i
štampa rRN PDF-a. Šema pokriva 1:1 legacy `tStavkeRN` (`work_order_operations`). Nedostaju: **skica**
(model `work_order_operation_images` postoji, endpoint/UI ne), **PND/PDM/PLP** CRUD + UI (backend ih samo
copy-from kopira), „Prepiši isti postupak" (klon kao sledeća varijanta).

### 2.3 Kucanje TP iz primopredaje + „nestajanje" — GLAVNI JAZ
U 2.0 RN nastaje tek pri **launch-u** primopredaje (sa praznim TP-om); nema taba „Odobrene", launch ne
vodi na kucanje, RN-level launch ne propagira status nazad u `drawing_handovers` (back-link
`drawingHandoverId` postoji). → Redizajn u §3 P1.

### 2.4 Zbir komada po operaciji (Kartica TP)
Ekran: `/tech-processes` tab „Postupci" → `TechProcessCardDetail`; hrani ga `GET /v1/tech-processes/card`.
Red = jedno kucanje (legacy semantika: sken kreira red sa `Komada=0`, količina se upisuje pri zatvaranju —
`OznaciDaJeZavrsenPostupak`). Legacy zbir: `Sum(Komada) GROUP BY (…, Operacija, RJgrupaRC)`
(upiti `tTehPostupak_NapravljenoKomada`, `RNPregledPostupci`; `Preostalo = tRN.Komada − Σ`).
Dizajn: aditivno polje `data.operations[]` u istom `/card` odgovoru — ključ `(operationNumber,
workCenterCode)`, `{ entryCount, pieces: {total, good, rework, scrap}, isFinished, elapsedMinutes }`
(storno negativi se netuju); UI grupni header iznad svake grupe („OP 30 · CNC Glodanje … · Σ 4 kom · 7
kucanja"). Usput: header „24 operacija" broji REDOVE — prepraviti na distinct (OP,RC) + `entryCount`.
⚠️ Odluka: „preostalo do plana" od totala ili samo od dobrih komada (legacy: od totala).

### 2.5 Štampa svih crteža iz primopredaje — univerzalno rešenje
Frontend nema PDF biblioteku ni `window.print`; 1.0 label-proxy je TSPL2→9100 (neupotrebljiv za PDF).
**Preporuka (P3):** server-side spajanje PDF-ova (`pdf-lib`, ⚠️ nova zavisnost) grupisano **po formatu
papira** (MediaBox: A4/A3 naspram A2/A1/A0) → `GET …/print-bundle` (meta) + `GET …/print-bundle/pdf?format=`
(jedan spojen PDF po grupi) → frontend modal „Štampaj sve crteže" (lista + checkbox, crveno = nema PDF-a)
→ skriveni iframe + `contentWindow.print()` → **sistemski print dijalog** — korisnik bira BILO KOJI
štampač (A4 gomila → HP laser, veliki formati → EPSON SC-T2100 ploter). Univerzalno za svaku firmu,
nula konfiguracije. Faza 2 (opciono): Windows print-agent (obrazac servoteh-bridge, SumatraPDF
`-print-to`) za štampu jednim klikom bez dijaloga + garantovanu razmeru 1:1. CUPS/IPP iz Dockera: odbačeno.

### 2.6 Tehnolog: dodela pri odobravanju + pretraga
Legacy: Miljan pri odobravanju bira tehnologa (polje „Tehnolog" na Primopredaji). 2.0 `approve` nema
tehnologa; filter „Za tehnologa" na „Sve primopredaje" postoji u UI ali ga ništa ne puni. →
P1: `approve(id, {technologistId})` (⚠️ novo polje `technologist_id` na `drawing_handovers` — legacy je
čuvao na tRN.Tehnolog?, proveriti mapiranje pri implementaciji), pretraga po tehnologu na Nacrti tabu
(proširiti `q` ili poseban filter) + validan filter na „Sve primopredaje" i tabu „Odobrene".

### 2.7 „Undo" odobrene primopredaje
Slučaj: odobreno, pa se crtež menjao. → P1: akcija „Vrati na čekanje" (status 1→0) dozvoljena dok RN nije
lansiran; ako je RN kreiran sa otkucanim TP-om ⚠️ odluka (Miljan/Negovan): storno RN-a + čuvanje TP-a kao
draft, ili blokada undo-a dok se RN ručno ne obriše. Audit obavezan (ko/kada/razlog).

### 2.8 XML ugovor — POTVRĐEN na stvarnom fajlu ✅
Primer: [_analiza/pdm-xml-primeri/1126982_B.xml](../../../_analiza/pdm-xml-primeri/1126982_B.xml)
(kopiran sa `s:\Projekti\RAZNO\00\`, 146 KB, sklop sa 4+ nivoa BOM-a). Činjenice za parser:

- **Encoding: UTF-8 BEZ XML deklaracije i BEZ BOM-a** (provereno bajtovima: `C5 A1`=š) — parser mora
  eksplicitno dekodirati UTF-8, ne oslanjati se na auto-detekciju.
- Struktura: `<xml><transactions><transaction date="{unix epoch}" type="wf_export_document_attributes"
  vaultname="Servoteh">` → `<document id pdmweid idattribute="Number">` → `<configuration name quantity>` →
  26× `<attribute name value/>` + `<references>` sa ugnježdenim `<document>` (rekurzija; isti deo se
  ponavlja pod više roditelja sa različitim `Reference Count` → dedup po (Oznaka, Revision, ParentDocID)
  kao legacy).
- Imena atributa **sa razmacima**: `Approved by`, `Document Number`, `Reference Count` — legacy mapiranje
  `Replace(' ','_')` → `Attr_*` potvrđeno.
- `id` (broj crteža) ume biti **nenumerički**: `K00693`, `EGE2` — string, ne broj.
- `State`: mešano `ODOBRENO`/`Odobreno` → poređenje **case-insensitive** (+ `Izmena bez revizije`).
- `Revision` ume biti prazan → default `"A"` (legacy pravilo).
- Datumi u **haotičnim formatima** u istom fajlu: `10.07.2026`, `24-Nov-23`, `7.6.2024.`, `7/15/2025` →
  čuvati sirov string + best-effort parse, nikad hard-fail na datum.
- Vrednosti sa ugrađenim newline (`ZiliS="S&#xA;"`) → obavezan trim; `Weight` ume prazan/`0.00` →
  legacy: nevalidan broj → `-1`.
- ⚠️ `MakeOrBuy` postoji ali je **nepouzdan** (DIN podloška ima „Proizvodnja"); legacy flag Nabavka =
  Oznaka sadrži slovo — zadržati legacy pravilo, `MakeOrBuy` informativno (potvrda Negovan).
- ⚠️ `RN` atribut u primeru je `0001` (ne `9400/2` kao u QMegaTeh pregledu) — auto-mapiranje predmeta
  preko `RN`/`Naziv_projekta` nije uniformno; tretirati kao referencu uz ručnu potvrdu u nacrtu.

### 2.9 Kritični rizici cutover-a (iz analize sync mape — 62 tabele)
1. **Ponovni sync posle nativnih upisa TIHO PREGAZI 2.0 redove** (upsert po legacy id; autoincrement
   nastavlja od istog MAX-a). Redosled je nepregovaran: freeze legacy → poslednji ciklus 10-min skripti →
   finalni **force/full** sync (kursor za `drawing_handovers` je već pomeren fallback-om!) → verifikacija →
   setval → izbacivanje iz mape + deploy → tek onda prvi nativni upis.
2. RN numeracija je bezbedna: `identNumber = projectNumber/MAX+1` uz advisory lock — nastavlja legacy niz
   ako je finalni uvoz kompletan. Numeracija nacrta namerno menja format.
3. ~9 tabela lanca **nema syncer** (`drawing_statuses` je NOT NULL FK bez seed-a!, `handover_draft_statuses`,
   `drawing_plan_items`, tPDM/tPLP/tPND stavke, `work_order_approvals`…) — finalni uvoz mora dobiti
   jednokratnu dopunu + verifikacioni report (COUNT/MAX(id)/RN ordinali/FK orfani/broj PDF blobova).
4. **PDM intake nema nativnu zamenu** — bez P4 gašenje sync-a seče dotok crteža i PDF-ova.
5. ⚠️ ODLUKA #3 („PDM = trajan direktan SQL na međusloj") mora se formalno revidirati na „nativni XML+PDF
   intake u 2.0" — potpis Negovan.
6. User↔Worker most postoji (`users.worker_id` + JWT `workerId`) ali ga servisi ne konzumiraju (upisuju
   0/null) — provući pre P1 da potpisi budu tačni od starta.
7. **Variant bump ne postoji nigde** (oba numeraciona servisa hardkoduju `variant=0`) — kiosk
   staleWorkOrder guard je mrtav za nativne naloge; rešiti zajedno sa „Prepiši isti postupak" (⚠️ odluka:
   klon-varijanta kao novi red kao legacy vs bump u mestu).

## 3. Paketi rada (predloženi redosled)

- **P0 — preduslovi (malo):** seed `handover_draft_statuses` + `drawing_statuses` (+ placeholder redovi);
  JWT `workerId` u upise work-orders/handovers/tech-processes; hint u prazan tab „Sve primopredaje";
  launch success ekran „Otvori RN / Štampaj" (workOrder.id se već vraća, UI ga baca).
- **P1 — tok tehnologa (srce zahteva):** tab „Odobrene" na `/handovers` (lista `statusId=1`, backend već
  podržava) = radna lista iz koje stavka nestaje na lansiranju; dodela tehnologa pri approve + pretraga po
  tehnologu (2.6); akcija „Otkucaj TP" na saglasnoj primopredaji → kreira RN (`handoverStatusId=1`, ne 3) sa
  back-linkom i otvara POSTOJEĆI TP editor; „Lansiraj" u jednoj transakciji podiže RN i primopredaju na 3
  (izmene: `work-orders.launch` propagira preko `drawingHandoverId`; `handovers.launch` radi nad postojećim
  RN-om + guard za dupli RN); „Vrati na čekanje" (2.7).
- **P2 — kartica TP zbir po operaciji** (2.4): backend `operations[]` + UI grupni headeri + fix header brojeva.
- **P3 — štampa svih crteža** (2.5): print-bundle endpointi + modal + iframe print. ⚠️ `pdf-lib` odobrenje.
- **P4 — nativni PDM intake + cutover:** `POST /pdm/import` po MODULE_SPEC_pdm §5.5 + PDF intake
  (`\\pdm-pdf\VASADATA\` → `drawing_pdfs`) + watcher/bridge za XML folder (obrazac servoteh-bridge; preuzima
  ulogu 10-min skripti); backfill `drawing_handovers` iz tRN atributa + ⚠️ nova kolona `draft_id`
  (zamena `resolveDraftContext` heuristike — odluka Negovan); split sync mape (bigbit-trajni /
  qbigtehn-privremeni); dopunska skripta za tabele bez syncer-a; runbook `docs/migration/17-cutover-runbook.md`
  po redosledu iz 2.9; revizija ODLUKE #3. XML ugovor potvrđen (§2.8) — **više nije blokiran**.
- **P5 — dopune TP editora:** „Prepiši isti postupak" (klon-varijanta + rešenje variant bump-a), skice
  operacija, PND/PDM/PLP CRUD + UI (posle potvrde spec pitanja sa Nešom/Negovanom).

## 4. Šta treba od ljudi

| Ko | Šta |
|---|---|
| Nenad | ~~primer XML-a~~ ✅ stigao 10.07, kopiran u `_analiza/pdm-xml-primeri/1126982_B.xml` |
| Negovan | ⚠️ revizija ODLUKE #3; `draft_id` kolona; semantika undo-a; variant bump vs klon; plan-vs-dobri za „preostalo"; MakeOrBuy vs Oznaka-slovo pravilo za Nabavka flag |
| Miljan | potvrda toka P1 (tab Odobrene, dodela tehnologa, undo pravila) |
