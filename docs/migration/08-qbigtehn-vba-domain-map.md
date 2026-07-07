# QBigTehn VBA -> ServoSync 2.0 domeni - mapa modula

> Izvor: read-only analiza izvučenog VBA izvora QBigTehn-a (`_analiza/izvoz/`) — moduli (`.bas`), forme i
> klase (`.cls`) MS Access front-enda nad MS SQL Server backend-om (Negovanov sistem). Dopunjuje
> [05-qbigtehn-sqlserver-logic.md](05-qbigtehn-sqlserver-logic.md) (SP/UDF tela) i
> [06-bigbit-preuzmi-iz-bb.md](06-bigbit-preuzmi-iz-bb.md) (Preuzmi iz BB, mapiranje kolona).
> **Svrha:** vodič Luki dok gradi 2.0 — koji legacy modul pokriva koji 2.0 domen, šta se **prenosi** (poslovno
> pravilo), šta se **prepisuje** (infra/UI plumbing), šta se **baca** (van scope-a). Ništa u kodu nije menjano.

Ovaj dokument mapira **proizvodni podskup** QBigTehn-a (scope potvrđen u [02](02-qbigtehn-scope-triage.md):
~44% legacy koda je realno jezgro). 2.0 imena tabela/modula su iz [ROADMAP §2.0](../ROADMAP.md) i
[schema-rename-map.md](../schema-rename-map.md).

## Kako čitati

- **Kolone tabela:** `VBA modul` · `šta radi` · `2.0 meta (tabela/modul)` · `napomene za prenos`.
- **Legenda izvora podataka:** `t*` = QBigTehn SQL tabele (proizvodnja, **postaju vlasništvo 2.0**);
  `EXT_*` = Access linkovi na BigBit (**read-only cache/overlay** — `bigbit-sync`); `R_*`/`tPozicije`/
  `tOperacije` = registri/šifarnici; `PDM*`/`Komponente*` = crteži i BOM.
- **Ključno arhitektonsko pravilo (kroz ceo dokument):** legacy je pun **string-konkatenacija SQL-a bez
  parametrizacije**, **ručnog autonumber-a (`DMax+1`)**, **globalnog mutabilnog stanja (singleton klase)** i
  **operacija bez transakcije**. Sve to su anti-paterni koje 2.0 zamenjuje (parametrizovan Prisma, sekvence,
  request-scoped kontekst, DB transakcija). Napomene ispod ističu **poslovno pravilo** koje mora da preživi
  prepisivanje, ne mehaniku koja se baca.
- Prava poslovna logika je često u **SQL SP/UDF** (`sp*`, `ft*`) — VBA samo mapira kontrole forme u parametre.
  Te procedure su u [05](05-qbigtehn-sqlserver-logic.md); ovde su označene kao „logika je u SP-u".

---

## 1. Tehnologija / TP — `tech_processes`

Barkod-praćenje izvršenja tehnoloških postupaka na mašinama: radnik se loguje karticom, sistem bira
nezavršenu operaciju, evidentira komade, zatvara postupak, razrađuje doradu/škart.

| VBA modul | Šta radi | 2.0 meta | Napomene za prenos |
|---|---|---|---|
| `BBTehn_Module.bas` | **Srce domena** — sva logika barkod-unosa, zatvaranja postupka, dorade/škarta, kaskadnog brisanja naloga | `tech_processes`, `work_orders`, `work_order_operations`, `operations`, `machine_access` | `OznaciDaJeZavrsenPostupak` = centralna transakcija (provera količina → `ZavrsenPostupak=1` + `Prioritet=255`); DORADA/ŠKART tok preko UDF `ftDodatiPostupkeZaDoraduIliSkart` → novi nalog + poruka `T_Planer`. Zatvaranje + prioritet + dorada u 2.0 obaviti kao **jednu DB transakciju** |
| `BBTehn_Class.cls` | Singleton `BBTehn` — kontekst sesije barkod-unosa (radnik, postupak, operacija) | request-scoped kontekst/DTO u barkod servisu | `IDLogovanogRadnika ≠ IDRadnik` (logovani sme zatvarati tuđi postupak uz `DodatnaOvlascenja`); sentinel `-1` → `null`/Optional |
| `Form_Kartica TehPostupka - Podforma.cls` | Prikaz stavki izvršenja + klijentsko sumiranje (komadi, vreme) | `tech_processes` (pregled) | Totali (`NapravljenoKomada`, `UtrosenoVreme`, `Sati/Minuti`) — u 2.0 **SUM na DB/API**, ne u UI; preneti kolone za time-tracking |
| `Form_Kartica TehPostupka.cls` | Zaglavlje kartice + filteri (nalog/radnik/RJgrupaRC) | `tech_processes` pregled | Tanak UI; filteri delegiraju na podformu |
| `Form_UnosOperacije.cls` | CRUD šifarnik operacija (`tOperacije`) | `operations` | `operations` mora imati `work_center` (RJgrupaRC) i **`uses_priority`** flag (`KoristiPrioritet`) |
| `Form_UnosRadnihCentara.cls` | CRUD radni centri (RJgrupaRC) | `work_centers` | RJgrupaRC je labav string ključ svuda — u 2.0 pravi **FK ka work_centers**, ne string |
| `Form_Masine.cls` | Šifarnik mašina | `machines` / `work_centers` | Mašina → RJgrupaRC (pristup i operacije idu preko RJgrupaRC) |
| `Form_PristupMasinama.cls` | Dodela pristupa mašinama (`tPristupMasini`) | `machine_access` | **Kritična autorizaciona tabela** — definiše koje operacije radnik sme (`SifraRadnika`+RJgrupaRC) |
| `Form_RadniciPoMasinama.cls` | Master-detail dodela radnika mašinama | `machine_access` + `workers` | Održavanje mapiranja radnik ↔ mašina/RJgrupaRC |
| `Form_frmIzborTehnologa.cls` | Dijalog izbor tehnologa pri primopredaji | `work_orders` handover | Logika u SP `spPromeniStatusPrimopredaje` — **obavezno pročitati** pri portu |
| `Form_frmKriticniPostupci.cls` | Pregled kritičnih postupaka sa bojom | `tech_processes.kriticnost` (severity) | Enum severity 1/2/3 (žuta/narandžasta/crvena); boje → dizajn sistem |
| `Form_frmSanacijatTehPostupak.cls` | Pregled postupaka za ispravku (drill-through) | `tech_processes` | Read-only + drill na `PregledPoPostupcima`; bez izračunavanja |
| `Form_tTehPostupakDokumentacija.cls` | Dokumentacija (PDF/skice) po operaciji | `drawings`/`documents` | Fajl-storage servis + metapodaci umesto UNC putanja; razmotriti soft-delete (legacy radi `Kill`) |
| `Form_PregledPostupakaSaDokumentacijom.cls` · `Form_PregledTehnoloskihPostupaka.cls` · `Form_tTehnPregled_Panel.cls` | Read-only pregledi/paneli sa dinamičkim RecordSource | `tech_processes` list/dashboard | Čist listing/nav sloj; standardni endpointi u 2.0 |

---

## 2. Radni nalozi (RN) — `work_orders` + `work_order_operations`

`tRN` je **istovremeno tehnološki postupak i zaglavlje radnog naloga** (PK `IDRN`). Stavke su u 4 tabele:
`tStavkeRN` (operacije), `tPND` (nabavni delovi), `tPLP` (limovi/profili), `tPDM` (montažni delovi).

| VBA modul | Šta radi | 2.0 meta | Napomene za prenos |
|---|---|---|---|
| `RN_Modul.bas` | **Core RN** — accessori zaglavlja/stavki, prepis naloga, dorada/škart child nalog, varijante, arhiviranje dokumentacije | `work_orders`, `work_order_operations`, `mrp_*`/`drawing_components`, `drawings` | `KreirajNalogDoradeIliSkarta`: `IdentBroj` dobija sufiks `-D`n (dorada, kvalitet=1) ili `-S`n (škart, =2); kopira zaglavlje + sve 4 stavke. Prioritet `100` ako `KoristiPrioritet` else `255`. Bug: `PrepisiZaglavljePostupka` piše `TezinaObrDela` u `TezinaNeobrDela` |
| `RN_Class.cls` | Singleton `RNP` — aktivni RN kontekst, lazy-load iz `tRN` | request-scoped kontekst | Global mutable „current work order" = anti-patern → eksplicitni parametri; doc root iz `CFG_Global` |
| `Form_UnosRN.cls` | Glavna forma RN + **workflow saglasnost→lansiranje**, provera duplikata, zaključavanje, kopiranje | `work_orders` state machine + `work_order_operations` | **STATE MACHINE (port 1:1):** RN mora biti **saglasan pre lansiranja**; preduslovi: sačuvan + `BrStavki>0` + grupa (`Saglasnost`/`Admins`/`DefiniseSaglasan`). Duplikat: `IdentBroj` jedinstven osim za isti (IDPredmet,BrojCrteza,Varijanta,Revizija). Brisanje blokirano ako `Zakljucano` ili nalog već u proizvodnji |
| `Form_RNSaglasanStatus.cls` | Popup odobravanja (`tSaglasanRN`) | `work_order_approvals` / `approved_by/at` | Mora se uneti `SifraRadnikaIspravka` pre snimanja; toggle `Saglasan` resetuje operatera (re-potvrda) |
| `Form_RNLansiranStatus.cls` | Popup lansiranja | `launched_by/at` | Prostije od odobravanja (nema forsirane provere operatera) |
| `Form_KreirajNoveNalogeZaIDPredmet.cls` | **Bulk clone** svih naloga projekta u novi projekat sa koeficijentom količine | `work_orders` bulk-copy servis | Dvofazno: staging tabela sa `Kreirati` checkbox → SP `spKreirajSveStavkeRNZaNoviIDPredmet...` po nalogu. Koeficijent množi `Komada`. U 2.0 → **transakcioni clone endpoint** (ne temp-tabela/passthrough) |
| `Form_IzborNalogaZaPrepisivanje.cls` | Izbor izvornog RN za kopiranje postupka | `work_order` „copy operations from" | SP `spRN_PrepisiStavkeIzNaloga(NoviIDRN, IzIDRN)`; samo kad je cilj prazan (`RN_NemaStavke_ADO`) |
| `Form_UnosStavkiRN.cls` | Unos operacija (podforma) | `work_order_operations` | Ako radni centar ne koristi prioritet → `Prioritet=255`; lock nasleđuje iz roditelja |
| `RN_BiranjePredmeta.bas` | Navigacija RN → detalj forme (kartica, lokacija, MRP) | UI routing | Bez pravila; koristan kao **mapa povezanih 2.0 ekrana** RN-a |
| `Form_BarKod_Status.cls` | Touch-panel status operacije (kiosk, auto-close) | `tech_processes` (proizvodnja) | Most preko `IDPostupka`; note upis `UpisiNapomenu` na close |
| `StatusDok.bas` | Dekodiranje barkoda + generički status dokumenta | shared barkod util | `AGDesifrujBarKod` (separatori `:` → fallback) — reusable; `spSaveStatusDokumenta` je isporuka, ne RN |
| `RN_RadSaDatumima.bas` | Date/time interval helperi | generic date utils | Default granice: nema „od" → `1901-01-01`, nema „do" → `2099-12-31`; zameniti date-fns |
| `Planer.bas` | Inbox planera (broj neobrađenih poruka `T_Planer`) | planner/notifications | Config prozor `Planer_BrojDanaUnazad/Unapred`; SP `spBrojVidljivihPorukaPlanera` |
| `RN_TouchPanel.bas` · `RN_OpenFormModla.bas` · `PPS_Modul.bas` | Soft-keyboard geometrija, Access filter plumbing, paginacija | N/A (native input) / server-side pagination | UI plumbing — ne portovati; PPS samo signalizira da su pregledi paginirani (default page 20) |

---

## 3. PDM / Crteži / BOM — `drawings` + `drawing_components`

Uvoz SolidWorks PDM XML-a u proizvodnu bazu (crteži + BOM veze), revizioni upgrade, sastavnica/where-used,
i most ka MRP (nabavni delovi).

| VBA modul | Šta radi | 2.0 meta | Napomene za prenos |
|---|---|---|---|
| `PDM_Common.bas` | **Srce PDM-a** — ceo pipeline uvoza jednog XML-a: parse → dedupe → validacija → upis crteža → zamena revizije → BOM veze → log/premeštanje; primopredaja u `tRN` | `drawings`, `drawing_components`, import staging, `work_orders`, `mrp_*` | Revizija prazna → `'A'`; **Nabavka flag:** `Attr_Oznaka Like '*[!0-9]*'` → kupljeni deo (auto u `R_Artikli`). Revizioni upgrade `ZameniIDCrtezaStareRevizijeUKomponentama` prevezuje BOM ivice star→nov. **Zamka:** literalni placeholderi `'UBACI REVIZIJU'`/`'UBACI IDSTATUS'` u SQL-u (nedovršen kod!); string-concat bez parametrizacije |
| `PDMXMLParser.bas` | Parsira PDM XML (`MSXML2.DOMDocument`) u staging `PDM_Document`, rekurzivno preko `ParentDocID` | drawing import staging | Atributi → kolone `Attr_<name>`; vodeći slog `ParentDocID=Null`, reference nose parent docID (tekst). U 2.0 robustan parser koji gradi (drawing,parent) parove |
| `XMLImport.bas` | Batch: skenira folder, **sortira XML hronološki**, za svaki zove uvoz; AutoExec headless | background job / cron/queue | **Redosled je bitan** — starija revizija pre novije da revizioni upgrade radi tačno; zadržati determinizam |
| `PDM_PDFCommon.bas` | PDF crteži kao blob u `PDM_PDFCrtezi` (ključ `BrojCrteza`+`Revizija`), preview/štampa | `drawing_files` (object storage) | PDF vezan po (broj,revizija), **ne** po `IDCrtez` → pri migraciji vezati na `drawings` preko (broj,revizija); služiti PDF preko HTTP endpointa |
| `PDM_Class.cls` | Singleton `PDMSklop` — selektovani crtež + lanac referenci | view/component state | Anti-patern global; lanac reference → rekurzivni BOM upit |
| `Form_PDMCrteziPregled.cls` | Browser crteža + akcije (detalj, gde-se-koristi, sastavnica, PDF, primopredaja) | `drawings` lista + ulaz u BOM | **Pravilo:** sastavnica dozvoljena samo za **najnoviju reviziju** (poredi sa `MAX(Revizija)`). **Zamka:** `MAX(Revizija)` je leksikografski — radi za A/B/C, ne za dvocifrene → u 2.0 `revision_order` kolona |
| `Form_PDMSklop.cls` | Navigator sklopa, režim Proizvodnja vs Nabavka (Gotov deo) | `drawings` (`is_purchased` flag) | Filter `IDStatusCrteza IN {0,1}` AND `Nabavka=režim`; reference lanac → rekurzivni prikaz |
| `Form_PotrebniGotoviDeloviZaCrtez.cls` | **Najkompleksnija** — potrebni nabavni delovi + **generisanje MRP potreba** iz sastavnice | `mrp_requirements` + `mrp_requirement_items`; BOM eksplozija | **MRP algoritam:** `TipEksplozije` 1=top-level, 2=puna; guard protiv duple otvorene potrebe (`Status IN (0,2)`); stavke iz TVF `ftMRP_PotrebeZaCrtez` → u 2.0 rekurzivni BOM CTE |
| `Form_PotrebneKomponenteZaCrtez.cls` | Drilldown svih komponenti + štampa sastavnice/PDF | `drawing_components` (BOM) | Ulaz u podsklop samo ako je stavka sklop (`JeSklop`); breadcrumb stack → pravi route/state stack |
| `Form_PDMTreeView.cls` · `Form_frmPDMTreeView_Sub.cls` | Rekurzivni BOM tree (MSComctl TreeView) | `drawing_components` BOM tree | Legacy radi **DAO rekurziju (N+1 upit po čvoru)** + **nema anti-ciklus zaštite** (moguć beskonačni rekurz) → u 2.0 rekurzivni CTE + guard. Duplirane komponente — konsolidovati u jednu |
| `Form_frmWhereUsed_Sub.cls` · `Form_GdeSeCrtezKoristi.cls` | Where-Used (obrnuti BOM) preko TVF `ftWhereUsed` | where-used upit nad `drawing_components` | Serverski TVF vraća `Nivo`; rekurzivno vs direktno preko checkbox-a; u 2.0 rekurzivni CTE child→parent |
| `Form_PDMXMLImportLog.cls` | Log importa + ručno pokretanje batch-a | `drawing_import_log` + admin akcija | **AUTORIZACIJA hardkodovana na usera `'Negovan'`** → zameniti pravom/rolom (admin/pdm-import) |
| `Form_PDMSklopReference.cls` + `PodSklop`/`PodPodSklop`/`PodPodPodSklop` (4) | Fiksni lanac reference-subformi (nivo 1–4) | `drawing_components` (jedan nivo) | **Legacy podržava samo 4 nivoa dubine** — u 2.0 obavezno rekurzivni prikaz proizvoljne dubine |
| `PDM_Test.bas` · `clsTreeViewEvents.cls` · `Form_Copy Of PDMTreeView.cls` · `Form_Pregled*` subforme · `Report_rPDM-jedan.cls` | Dev scaffold, UI event adapteri, duplikati, datasheet subforme, report | N/A / read-only prikazi | Ne portovati duplikate; `PDM_Test` koristan kao **spisak svih XML atributa** za kompletnu shemu importa |

---

## 4. Nacrti / Primopredaje — `handover_drafts` + `handover_draft_items` (novi entitet, 2.0 vlasništvo)

Nacrt primopredaje grupiše crteže iz PDM-a; primopredaja generiše radne naloge (RN). Status modeli su
**monotoni** (samo napred).

| VBA modul | Šta radi | 2.0 meta | Napomene za prenos |
|---|---|---|---|
| `NacrtPrimopredaje_Modul.bas` | **Jezgro** — životni ciklus nacrta, dodavanje crteža sa BOM dubinom, promena statusa, notifikacije | `handover_drafts`/`_items` → `drawings`, `work_orders`, notifications | `DodajCrtezUNacrt`: glavni nacrt = cela BOM struktura, inače parcijalno (sklop→cela BOM, deo→samo deo) preko SP `spDodajCrtezSaDubinom`. **Status monoton:** UPDATE samo ako `ISNULL(status,0) < novi` (crtež 0..2, nacrt 0..1). Kreiranje RN je u SP `spKreirajRNZaNacrtPrimopredaje` — **pročitati iz baze**. Zamka: SQL injection preko poruka/CurrentUser |
| `Form_NacrtPrimopredaje.cls` | Orkestracija kreiranja primopredaje (RN), enable/disable po statusu i pred-proveri duplikata | `handover_drafts` servis + `work_orders` | Permisija: grupa `KreirajPrimoPred`/`Admins`. **Dugme „Kreiraj RN" ONEMOGUĆENO dok svaki duplikat nije razrešen** (isključen ili odluka doneta) — port kao validaciju pre generisanja naloga |
| `Form_SpremiNacrtPrimopredaje.cls` | Dodavanje selektovanog PDM crteža u nacrt | „dodaj crtež u draft" servis | **Revizija:** samo najnovija ide u nacrt (blokira ako nije `MAX(Revizija)`). Broj otvorenih nacrta projektanta: 0→otvori novi, 1→auto-dodaj, >1→izbor. Ikone hardkodovane putanje (zamka) |
| `Form_Primopredaja.cls` | Detaljna forma RN u primopredaji, 6 kategorija stavki (tabovi), lansiranje | `work_orders` + `work_order_operations` + `mrp_*`/`drawing_components` | **MAPA 6 tipova stavki:** 0=operacije, 1=PND nabavni, 2=PDM montaža, 3=PLP limovi/profili, 4=Komponente, 5=NDKomponente. Lansiranje → SP `spPromeniStatusPrimopredaje(IDRN, 3)`. Puno globalnog stanja (RNP) |
| `Form_PregledPrimopredaje.cls` | Workflow odobravanja (odobri/odbaci/lansiraj) + batch PDF štampa | `work_orders` status/approval; `drawings` PDF | **STATUS ENUM (centralno):** `IDStatusPrimopredaje` 0=U obradi, 1=Odobren, 2=Odbijen, 3=Lansiran; prelazi preko `spPromeniStatusPrimopredaje`. Odobri → otvara `frmIzborTehnologa`. Permisija `OdobriPrimoPred`/`Admins` |
| `Form_PregledNacrtaPrimopredaje.cls` | Lista nacrta (kreirani vs predati) | read-only pregled `handover_drafts` | Glavni crtež sklopa nosi vezu ka zaglavlju (`IsGlavni` flag u stavkama) |
| `Form_PregledStavkiPrimopredajaRN.cls` · `Form_PrimopredajaUnosStavki*` (RN/PDM/PND/PLP/Komponente/NDKomponente) · `Form_NacrtPrimopredajeStavke.cls` · `Report_PregledPrimopredaja.cls` | Podforme stavki (pregled/unos po kategoriji) + report | `work_order_operations` / `mrp_*` / `drawing_components` | Uglavnom lock/boilerplate. **Bitno:** model stavki RN podeljen na 6 fizičkih tabela → u 2.0 razmotriti **jedinstvene work_order stavke sa tipom**. `PozicijaPDM` validacija: montažni deo mora biti definisan kao RN |

---

## 5. Lokacije / Strukture — `part_locations`, `workers`, `work_centers`

Premeštanje/trebovanje napravljenih delova po policama (ledger model) + matični podaci proizvodnih struktura
(radnici, vrste radnika, radne jedinice, pozicije/police).

| VBA modul | Šta radi | 2.0 meta | Napomene za prenos |
|---|---|---|---|
| `Form_LokacijaNapravljenihDelovaZag.cls` | **Glavni nosilac** — prenos i trebovanje delova po policama, unos lokacija iskontrolisanih delova | `part_locations` + novi `part_location_movements` | **Pravila prenosa/trebovanja:** `KolicinaZaPrenos` i `KolicinaZaTrebovanje` **međusobno isključive** (tačno jedna ≠0), obe ≥0, ≤ trenutne količine, izvor≠cilj. Izvršenje u SP `spIzvrsiPrenosIliCiscenjeDela...` → u 2.0 **transakcioni servis**. `ProveriDefinisneKolicine`: suma raspoređenih = broj iskontrolisanih (obavezna validacija) |
| `BBTehn_Module.bas` (`OtvoriFormuZaLokacijuDelova`) | Ulazna tačka dijaloga lokacije iz proizvodnje | `part_locations` use-case | **Mapiranje kvaliteta:** `IDVrstaKvaliteta` iz flagova (Dorada→1, Skart→2, inače→0) → enum `quality_type {0=OK,1=rework,2=scrap}`. Metapodaci = join `work_orders × customers × workers` |
| `Form_KarticaLokacijaDela.cls` | Kartica dela — istorija postavljanja/uklanjanja + totali | `part_locations` read model / agregacija | **Potvrda: `tLokacijeDelova` je LEDGER** (postavljanje i uklanjanje = odvojeni zapisi); stanje = `SUM(placed) - SUM(removed)` |
| `Form_LokacijaSvihNapravljenihDelovaPoRN.cls` | Grid svih delova po RN + validacija koordinata police | `part_locations` (X/Y/Z pozicije) | Police numerisane: `XPoz/YPoz/ZPoz` moraju biti numeričke; promena reda re-inicijalizuje parametre transfera |
| `Form_LokacijaNapravljenihDelova.cls` | Podforma čistog unosa (append-only) novih lokacija | `part_locations` insert | `DataEntry=True` + validacija iz zaglavlja (suma = broj iskontrolisanih) |
| `Form_PregledDelovaPoLokacijama.cls` | Globalni pregled/pretraga delova po lokacijama (TVF 12 param) | `part_locations` search endpoint | Server-side TVF `ftPregledDelovaPoLokacijama` → parametarski query u 2.0 |
| `Form_frmPozicije.cls` | CRUD pozicija/polica (`tPozicije`) | `part_locations` master / `locations` | **ZAMKA:** ručni PK `DMax('IDPozicije')+1` (race-condition) → identity/sekvenca. Pozicija ima unique indeks (poslovni ključ) |
| `Form_frmGrupe.cls` | CRUD objekata/grupa (`tObjekti`, hale/zone) | hijerarhija `locations` (parent) | Ista `DMax+1` zamka; `tObjekti` je lokalna Access lookup — **potvrditi sa Nešom** hijerarhiju lokacija |
| `Form_Unos _ Pregled radnika.cls` | Glavna maska radnika (matični podaci) | `workers` + FK `worker_types`, `work_units` | Default filter `Aktivan=True`; **lozinka plaintext** (`PasswordRadnika`) → hash; `LogAcc` → `workers.user_id`; `IDKartice` = barkod (login skenerom). Bug: error handler u `IzaberiSliku` skače na FindRecord — ne portovati |
| `Form_Radnici.cls` | Prostija forma radnika + osvežava pristup mašinama | `workers` + `machine_access` | `Form_Current` re-query `PristupMasinama` (veza radnik→dozvole); clipboard `IDKartice` (Admin) za programiranje kartica |
| `Form_UnosRadnihJedinica.cls` | CRUD radne jedinice | `work_units` / departments | `tRadnici.IDRadneJedinice` je **TEKST FK** na kod (5 char), ne numerički — paziti na tip ključa |
| `Form_VrsteRadnika.cls` | CRUD vrste radnika | `worker_types` / roles | `DodatnaOvlascenja` (Yes/No) → permission flag/rola. Bug: `DugmeNoviSlog` GoToControl na nepostojeću kontrolu — ignorisati |
| `Report_barkod_IDkarticaRadnika.cls` | Štampa barkod bedža radnika | `workers` (badge) | `IDKartice` → `worker.badge_code`; u 2.0 generisati Code128/39 + štampa bedža |

---

## 6. MRP / Nabavka (uvid) — `mrp_requirements`, `mrp_plans`, `purchase_requests`

Planiranje nabavke iz BOM-a: potrebe → plan → zahtev za nabavku → nalog magacinu. Zalihe su BigBit overlay
(read-only cache). Decision-engine (odluke 1/2/3) je deljen sa primopredajom.

| VBA modul | Šta radi | 2.0 meta | Napomene za prenos |
|---|---|---|---|
| `MRP_Module.bas` | Sync lagera Access→SQL, popunjavanje šifri artikala i primarnog dobavljača, info BOM potreba | `mrp_requirements`/`_items` + `mrp_stock_snapshot` | Batch INSERT po **300 redova**; `spMRP_SyncStanjeArtikala` merge. **Pravilo:** primarni dobavljač (`ORDER BY Primarni DESC`) + **lead time** (`VremeIsporukeDana`) na stavku. Decimalni separator forsiran `,`→`.` |
| `PlaniranjeNabavke.bas` | Servisni sloj plana: kreira plan (SP), slobodne zalihe, zahtev za nabavku, nalog magacinu | `mrp_plans`/`_items` + `purchase_requests`/`_items` | **FORMULA SLOBODNIH ZALIHA (ponavlja se svuda):** `SlobodneZalihe = Zalihe(PlusMinusKolicina) - Rezervisano(RezervisanaKolicina)`, upis samo ako `≥0`. Broj zahteva `'0000/YYYY'` per-godina brojač → **atomska sekvenca** (race). Nema pravog rollbacka → sve u jednu transakciju |
| `Proizvodnja.bas` | Trebovanje sirovina (dok `TRPR`) + cena koštanja GP | granica MRP↔proizvodnja | Default magacin sirovina konfigurabilan po pogonu; `CenaKostanjaGotovogProizvoda` zavisi od magacina i Level-a (nivo BOM) |
| `Form_PlaniranjeNabavke.cls` | Glavna forma plana + **state machine** dugmadi + **proknjižavanje** (zahtev + nalog magacinu + statusi) | `mrp_plans` orkestracija | **STATE MACHINE (port 1:1):** predato→sve lock; sporne bez odluke→samo „Odluke"; sve pokriveno→Proknjiži. `PlanJeSpremanZaProknjizavanje` = nema stavke gde `Rezervisano+ZaNabavku < PotrebnoUkupno`. Proknjižavanje → `spMRP_Potrebe_PromeniStatus(4)` + lock. **Zamka: nema rollbacka** |
| `Form_MRP_Potreba.cls` | Zaglavlje MRP potrebe (skoro isti kod kao plan forma) | `mrp_requirements` header | Audit `DIVIzmena/Korisnik`; `Izvor` 1=auto/2=ručno. **Proknjiži ovde je STARIJA verzija (`BrojDokumenta='TEST'`) — NE portovati**; kanonska je u plan formi. Konsolidovati duplirani kod |
| `Form_PlanSporneStavke.cls` | **Decision engine** — rešavanje spornih stavki (Iskljuci/Nabavi ponovo/Nabavi razliku) | `mrp_plan_items.decision` | **ODLUKE:** `OdlukaAkcija` 1=ISKLJUČI (cilj 0), 2=NABAVI PONOVO (cela), 3=NABAVI RAZLIKU (`KolicinaZaNabavku - PrethodnoPlanirane`, min 0). Gate: svaka `NeedsDecision` stavka mora imati `IskljuciNabavku` ili `OdlukaAkcija≠0`, pa `spPDM_Planiranje_PopuniRezervisanoINabavku` |
| `Form_SpremiPlaniranjeNabavke.cls` · `Form_MRP_DetaljanPregledSaZalihama.cls` | Entrypointi „kreiraj plan iz sklopa" / „iz MRP potrebe" | `mrp` generisanje plana | Revizija = najnovija (blokira ako nije `MAX`); mora imati nabavne delove (`ftBOMNabavniDeloviKolicine`); guard protiv duple potrebe (ako `IDPlan≠0` ponudi postojeći) |
| `Form_ZahteviZaNabavku.cls` · `Form_UnosZahtevaZaNabavku.cls` · `Form_SpecifikacijaZahtevaZaNabavku.cls` | Zahtevi za nabavku: lista/filter, unos + kreiranje upita dobavljaču, stavke | `purchase_requests`/`_items` | `RokZaPonudu = DatumZahteva + URokuDana`. **Kopiranje artikla u stavku** (naziv/kat.broj/JM `Left(...)` skraćeno na Size ciljne kolone); `NotInList` dozvoljava **slobodan (ne-kataloški) unos** — podržati katalog-vezane I ad-hoc stavke. Broj zahteva duplirani algoritam (isti kao BB) → konsolidovati |
| `Form_BBMail_ZaNabavku.cls` | Slanje specifikacije nabavke mejlom (PDF + SMTP) | notifikacioni/email servis | Default primalac = `EmailSluzbeNabavka`; kredencijali iz `.env` (ne Access klase); server-side PDF + SMTP |
| `Form_frmMRP_Akcija.cls` | Modal izbor kad potreba već postoji (Regenerisi/Novi/Odustani) | UI confirm/enum | `TempVars!MRP_Akcija` 1/2/0 |
| `Form_PlaniranjeNabavkeStavke.cls` · `Form_MRP_PotrebaStavke.cls` · `Form_PlanSporneStavkePodforma.cls` · `Form_IzborSpecifikacije...` · `Form_Specifikacija*` · `Form_MRP_Pregled*` (SaZalihama/PoDobavljacima/Rezervisano/SamoNabavku) · `Form_MRP_Pregled.cls` | Inline edit stavki, decision glue, kopiranje stavki, dashboard tabovi, filtrirani pregledi | `mrp_*` inline/list views | Duplirane stavke-podforme (ista `SlobodneZalihe` formula) → **konsolidovati u jedan servis**. Pregledi = `SetProperlyRecordSource`+timer nad SQL view-om (logika u view-u), preneti kao filtrirani tabovi |
| `Form_OdlukePredProvera.cls` · `Form_OdlukePredProveraPodforma.cls` | **PAŽNJA: pripadaju domenu PRIMOPREDAJE**, ne nabavci | `handover_draft_items.decision` | Identičan decision-engine šablon (1=Iskljuci/2=Predaj ponovo/3=Dopuni) nad `NacrtPrimopredajeStavke`. **Preporuka: jedan generičan `decision resolver`** koji služi i nabavci i primopredaji |

---

## 7. Komitenti / Predmeti (pregled) — `customers`, `projects`

Matični podaci su **vlasništvo BigBit-a** (read-only overlay); 2.0 drži cache. Ovde živi i najbogatija cenovna/
rabatna logika (kandidat za budući `pricing` domen).

| VBA modul | Šta radi | 2.0 meta | Napomene za prenos |
|---|---|---|---|
| `Cene.bas` | **Cene, rabati, nabavne cene** — cenovnik, VP/MP konverzije, MP obračun, rabatna hijerarhija, cena koštanja GP | `pricing`/`price_lists` + `customer_discounts` (novi domen) | **Ključni algoritmi:** `SracunajMPCenu = Round((NC+ZTD+ZTS)*(1+RUC%/100)*(1+PDV%/100))`; **MP\* prefiks = cena SA PDV**, inače bez; `F_FakturnaCena` — dva popusta **multiplikativno** (rabat pa kasa), ne aditivno. **RABAT HIJERARHIJA:** `RabatiPoArt` → `RabatiPodgrupa` → `Rabati(grupa)` → `Komitenti.RabatKomitenta`, pa cap na `MaxRabatProc` (99.99 max). Zamka: dupla Access/SQL implementacija → objediniti |
| `BiranjeArtikla.bas` | Izbor/pretraga artikla + CRUD nad `R_Artikli`, KNG zamene, barkod lookup, duplikacija po modelu | `items`/`materials` master | Puna šema `R_Artikli` u `DodajArtiklePoModelu` (referenca kolona); `fsSifraArtiklaZaKatBarNaz` fuzzy match — **kandidat za dedup**; `F_IDArtikalZaBarKod` (Barkod → fallback `R_Artikli_Barkod`) |
| `Komitenti.bas` | Helperi + **masovni upis rabata** (poreklo/podgrupa/grupa za sve komitente), crna lista | `customers` + `customer_discounts`/`_blacklist` | Masovni UPDATE rabata → bulk operacija. **Potvrditi** da li su rabatne operacije lokalne (2.0) ili idu u BigBit |
| `KomitentiCrnaListaModul.bas` | **Blokada fakturisanja** — crna lista + kreditni limit | `customers` (`credit_limit`, `blacklisted`) + validacioni servis | `NaCrnojListi` blokira ako `Vazi=True`; `PrekoracenLimit` samo ako `Limit>0 AND Saldo≥Limit AND Saldo>0` (saldo iz finansija/BigBit → overlay provera) |
| `ProdavciModule.bas` · `BiranjeKomitenta.bas` · `KomitentiUgovori.bas` | Prodavac↔komitent veza, autocomplete komitenta, template konta ugovora | `sales_reps` + FK `customers.sales_rep_id`; customer autocomplete | Pretraga po `Naziv` I `SkraceniNaziv` (spec za autocomplete). Template konta (ugovori) — nisko-prioritetno |
| `Form_Pisarnica_UnosPredmeta.cls` · `Form_Pisarnica_PregledPredmeta.cls` · `Form_T_Predmeti_Prilozi.cls` | Pisarnica/delovodnik — unos predmeta, numeracija, prilozi | `cases`/`projects` (registry) + `case_attachments` | Numeracija `1 + DCount(KLASIF, Godina)` — **ORGAN se namerno NE broji**. Bojenje po `VRSTA`. Zakonske evidencije: report `DnevnaKnjiga` (samo jedan dan!), `DostavnaKnjiga`. Bug: `SledeciBrojPriloga` koristi neinicijalizovan `pIDPredmet` |
| `Form_Predmeti.cls` · `Form_UnosPredmetaIspraviKomitenta.cls` | Stariji „Predmeti" (servisni predmet vezan za komitenta/dokumente) + promena komitenta | `projects` + veza `work_orders` | **ZAMKA: dve odvojene „predmet" šeme** (`Predmeti` vs pisarnički `T_Predmeti`) — **razjasniti sa Nešom/Negovanom** koji se prenosi u 2.0 `projects`. `IDVrstaPosla` obavezan (blokira snimanje) |
| `Form_Pregled komitenata.cls` | Read-only pregled + preuzimanje iz BigBita; **zabranjuje izmenu** | `customers` (read-only overlay) + import | **KRITIČNO ZA ARHITEKTURU:** `Form_BeforeUpdate` = „Ne možete menjati komitente — koristite BigBit" (`CancelEvent`) — **potvrđuje da su matični podaci komitenata vlasništvo BigBit-a** (poklapa se sa memorijom cache/overlay). Filteri = koje atribute UI treba |
| `Form_Grupe artikala.cls` · `Form_Unos komitenata.cls` | Šifarnik grupa; stariji CRUD komitenta | `item_groups`; `customers` edit (verovatno read-only) | Grupe/podgrupe su ključ rabatne hijerarhije; uređivanje komitenata u produkciji zabranjeno (BigBit master) |

---

## 8. bigbit-sync — most ka BigBit matičnim podacima (TRAJAN do 4.0)

Realizuje „Preuzmi iz BB" + generički ETL. Detaljno mapiranje kolona po tabeli je u
[06-bigbit-preuzmi-iz-bb.md](06-bigbit-preuzmi-iz-bb.md); ovde je uloga svakog modula.

| VBA modul | Šta radi | 2.0 meta | Napomene za prenos |
|---|---|---|---|
| `ImportIzBB_Module.bas` | **Srce „Preuzmi iz BB"** — 4 procedure (Komitenti/Prodavci/Predmeti/Artikli), INSERT-only anti-join | `bigbit-sync` UPSERT servis | **INSERT-only (`WHERE cilj.kljuc IS NULL`) → nikad update/delete** (bag: promene u BB se ne propagiraju). U 2.0 **UPSERT po prirodnom ključu**. 3 hard-kod transformacije (PIB `XX_&Sifra`, `[Sifra prodavca]=0`, `Password=Sifra`) — preispitati. Artikal: BB `Sifra artikla` → cilj `BBSifra artikla` |
| `BBSQLModule.bas` | **Motor upisa** Access(EXT_)→SQL, red-po-red preko ADO | Prisma UPSERT (bigbit-sync) | Presek kolona (`ADO_PostojiKolonaUTabeli`); tekst `Left(val,Size)`; apostrof→razmak (gubitak podatka); **nema transakcije** (delimičan uspeh); IDENTITY_INSERT dinamički |
| `modSyncMirrorTabele.bas` | Mirror lagerskih dokumenata/stavki po kataloškom broju + sesiji | `mrp_*`/stock snapshot | **Razlika vs §3 doc-a:** DELETE scoped po `SessionID` I `KataloskiBroj` (ne ceo skup); per-session staging → u 2.0 tabela sa scope ključem ili materijalizovan view. `Kolicina>0→Ulaz, <0→Izlaz=Abs` |
| `EXT_Import.bas` | Generički data-driven import (definicije u `EXT_Import_DEF`) | generic sync/ETL sloj | **Definicije importa su REDOVI u `EXT_Import_DEF` u Access bazi, NE u VBA** — `R_Tarife/R_Grupa/R_Podgrupa/Magacini` idu ovuda; **pročitati iz `.accdb`** za potpun spisak |
| `LinkovaneTabele.bas` | Upravljanje EXT_ Access/ODBC linkovima ka BigBit bazama | connection registry (config) | Registar u `Baze/Baze_Tipovi/BazeITabele` (**u bazi, ne u kodu**); multi-firma preko `SysFITFirma`. Potvrda: **kad QBigTehn nestane, izvor je BigBit `.MDB`** → ide u prilog export+UPSERT modelu |
| `Import_Module.bas` | Import cenovnika/artikala iz XLS/CSV (realna UPSERT logika) | `items` + price list import | Identitet artikla preko SP `fsSifraArtiklaZaKatBarNaz` (fuzzy 3 polja); auto-create Grupa/Podgrupa/Poreklo; `Cenovnik.CenaBezPDV=Cena/(1+PDVStopa)` |
| `BBImport_Class.cls` · `Form_BBImport.cls` | Import stavki iz XLS (profaktura/popis) preko privremenog linka | work document line import | Artikal **isključivo po `[Kataloski broj]`**; **obavezne kolone:** RBr, KatBroj, Naziv, Kolicina, VPCena, Jm (kontrakt fajla) |
| `BigBitXML.bas` · `BBJson.bas` | Ručni XML parser u staging; JSON serializer/parser | generic XML/JSON staging (bliže domenu 07) | Ručni parser lomljiv → standardni XML/DOM; JSON — niska prioritet za bigbit-sync |
| `ExportTXTCSVXML.bas` · `DC_ExportImportCSV.bas` | Izlazne integracije (CSV/TXT/XML/EDI); DataCollector barkod terminal | outbound export (07/e-faktura); `part_locations` prijem | **XML-escape mapa** vredna reuse (`&`→`&amp;` itd). Zamka: DC parsira datum/vreme iz **pozicija u imenu fajla** (fiksni offseti) → metapodaci uz fajl. Hardkodovani mailovi/putanje — ne prenositi |
| `BB2CMD.bas` · `BBMakeTableModule.bas` · `BBCMD_BigBit.bas` · `Form_BBExport.cls` | Schema/migraciono tooling, introspekcija sheme, UI export | migracioni alat | `BBTables_Fields` je **najbolji legacy izvor rekonstrukcije sheme** (kolone/tipovi) bez otvaranja `.accdb`. ExportXML bundlovi = „export ugovori" (customer+documents, article+groups) |

---

## 9. Common-infra — DB sloj, config, prava, validacije, utili

Najveći deo (~162 fajla) je **reusable plumbing** — u 2.0 se **prepisuje/zamenjuje, ne migrira 1:1**. Vrednost
je u shvatanju modela (config hijerarhija, prava pristupa, mapa upit-po-ekranu) i u nekoliko čistih algoritama.

| VBA modul | Šta radi | 2.0 meta | Napomene za prenos |
|---|---|---|---|
| `ADO_Module.bas` | **Centralni ADO sloj** — recordset, ExecSQL/SP, lookup, export/update tabela, format za SQL | Prisma data-access + DB helperi | **MASIVAN rizik SQL injection** (sve string-concat, `Replace(',"'"," ")` jedina sanitizacija); `ADO_SledeciAutoID = MAX+korak` (race!); globali za rezultat (nije thread-safe). Format datuma uvek `yyyy-MM-dd`; timeout 180s |
| `BBQueryTool.bas` | **Engine ODBC pass-through** — metadata-driven mapiranje forme/reporta na SP/UDF/SQL + parametri | REST/GraphQL endpointi + servisi | `BBQueryDef`/`BBQueryParDef` su **MAPA svaki ekran ↔ njegova SP/UDF/SQL + parametri** — **ključni izvor za rekonstrukciju upita po ekranima**. `ConvertAccSQLToODBC` prevodi Access SQL→T-SQL. Prefiks `BBCMD:` = `Eval()` |
| `LIB_CFGRW.bas` · `BBCFG_Class.cls` · `GlobalType.bas` · `Email_Class.cls` | Config read/write engine + singleton `BBCFG` (200+ podešavanja) + `TypeFirma` UDT + email config | `app_settings`/`company_settings` + `ConfigService` (per-tenant override + global default) | **Hijerarhija `ReadCFGParametar`:** `CFG_Lokal` → `CFG_Global` → `CFG_Apl_Parametri_DEF` (default); parametar mora biti u DEF tabeli. `DoEval=true` prolazi kroz `Eval()` (**opasno**). `TypeFirma` = kompletan set polja srpske firme (PIB, MaticniBroj, JBKJS, GLN...). **SMTP/lozinke plaintext u bazi → `.env`/secret**. `SysRazvojAPL` gejtovan na `'Negovan'` (hardkod ime) |
| `BBPravaPristupa.bas` | **Prava pristupa** na nivou forme/reporta/kontrole (visible/enabled/locked/filter po useru) | RBAC guards/decorators + permission tabela | Model `(ZaUsera, ZaFormu, ImeKontrole) → Visible/Enabled/Locked/Filter`; `[Form]` red = sama forma, `*` = sve kontrole. **Autorizacija je dvoslojna** (Access ULS + sopstveni sistem). Prava se lančaju (Filter forme AND Filter prava) |
| `BBFIT.bas` · `APL_CNN.bas` · `CNN_Creator.bas` | FIT rutiranje tabela na fizičke baze po firmi/tipu; bootstrap konekcija | multi-tenant/config; `DATABASE_URL` | Ceo koncept „različite tabele u različitim bazama po firmi" je legacy Access ograničenje → u 2.0 **jedna PostgreSQL baza** (tenant kolona). `BazeITabele` = mapa gde koja tabela živi pre migracije |
| `ADO_ComboRecordset.bas` · `ADO_DiconectedRecordset.bas` | Fabrika recordset-a za combo/list; disconnected RST | lookup/autocomplete endpointi; DTO | `SetCombo` mapiranja korisna za **semantiku polja** (artikal: Sifra artikla/Kataloski broj/Naziv/PLU/Barkod) |
| `KontrolniBrojevi.bas` · `LIB_JMBG.bas` · `LIB_PIB.bas` | Kontrolni brojevi (MOD 97-10, TR, kbroj22), JMBG (MOD 11), PIB/GLN | validator utili (`class-validator`) | Čisti algoritmi — **port 1:1**. `KBroj97` = ISO 7064 MOD 97-10; koristi se u payments/invoices, ne proizvodni core |
| `BBError.bas` · `BBDebug.bas` · `BBMsgBoxModule.bas` · `Dnevnik.bas` · `BBTimer.bas` | Prikaz greške, debug, custom dijalozi, **audit log**, merenje vremena | exception filter + Logger; confirm/toast; `audit_log`; interceptor | `Dnevnik(Korisnik, Opis, Forma, Akcija)` → `audit_log`; audit tiho guta greške (`On Error Resume Next`) — u 2.0 audit ne sme da baca ali mora logovati neuspeh. Naslovi MsgBox-a nekonzistentni (ostatak više brendova) |
| `LIB_NasaSlova.bas` · `LIB_SlovimaIznos.bas` · `LIB_OS.bas` | Transliteracija dijakritika; iznos slovima (srpski); amortizacija OS | transliteracija util; invoice util; **accounting/assets (van core)** | `ZameniNasaSlova` zahteva `Option Compare Binary`; `Slovima` — složena srpska gramatika padeža (testirati); OS amortizacija je računovodstvo, van 2.0 core |
| `ADO_Synch.bas` · `BBSys.bas` · `BBSetFormControls.bas` · `BBRunProgModule.bas` · `LIB_JsonParser.bas` · `BBMoveWindows.bas` · `BBHotKeys.bas` · `ClipboardModule.bas` · `LIB_ACS.bas` | Master/Kasa/Shuttle sync, Access DDL/maintenance, UI metadata hack, launcher, JScript JSON parser, Win32 helperi, hotkey/command palette, clipboard, NFC čitač | uglavnom N/A / native web ekvivalenti | `ADO_Synch` je **POS/kasa scenario** (privremen, van core-a) ali obrazac „UPDATE-pa-INSERT po PK" referentan za sync; `LIB_JsonParser` (JScript `eval`) — nebezbedan/64-bit → `JSON.parse`; ostalo desktop/Win32 — ne portovati |

---

## 10. Poslovna pravila vredna prenosa (top algoritmi i zamke)

Sažetak najvažnije logike iskupljene iz svih domena — **ovo mora da preživi prepisivanje**:

**Proizvodnja (TP/RN):**
- **Zatvaranje postupka** (`OznaciDaJeZavrsenPostupak`): provera količina → `ZavrsenPostupak=1` + `DatumZavrsetka` + **`Prioritet=255`** (operacija skinuta sa prioriteta); premašaj količine → briše red i vraća grešku. **Obaviti kao jednu transakciju.**
- **DORADA/ŠKART tok:** UDF `ftDodatiPostupkeZaDoraduIliSkart` vraća sve preostale operacije → zatvoreni redovi sa količinom dorade → **novi nalog** (`IdentBroj` sufiks `-D`n/`-S`n) → poruka `T_Planer` tehnologu. Enum kvaliteta **0=DOBAR, 1=DORADA, 2=SKART**.
- **Autorizacija operacije:** radnik vidi/radi samo operacije čiji `RJgrupaRC` ima u `tPristupMasini` (join). Barkod format `PredmetID:IdentBroj:Varijanta:Operacija:RJgrupaRC`.
- **RN state machine:** **saglasan → lansiran** (nikad obrnuto), sa grupno-based permisijama. `IdentBroj` jedinstven osim za isti (IDPredmet,BrojCrteza,Varijanta,Revizija).
- **Prioritet operacije:** `100` ako `tOperacije.KoristiPrioritet=True` else `255`.

**PDM/BOM/MRP:**
- **Revizija:** prazna → `'A'`; **`Nabavka` flag** = `Oznaka Like '*[!0-9]*'`; **revizioni upgrade** prevezuje BOM ivice star→nov (redosled importa hronološki!).
- **Zamka `MAX(Revizija)` leksikografski** — radi za A/B/C, ne za dvocifrene → `revision_order` kolona.
- **BOM rekurzija bez anti-ciklus zaštite** (PG `WITH RECURSIVE` bez guarda **visi** — vidi [ROADMAP rizici](../ROADMAP.md)); fiksna dubina 4 nivoa u legacy prikazu → proizvoljna dubina.
- **MRP eksplozija:** `TipEksplozije` 1=top-level / 2=puna; **slobodne zalihe = zalihe − rezervisano (≥0)**; primarni dobavljač + lead time na stavku.
- **Decision engine (deljen MRP + primopredaja):** `OdlukaAkcija` 1=Iskljuci / 2=Ponovo (cela) / 3=Razlika (min 0) → **jedan generičan resolver** u 2.0.
- **Status monoton** (primopredaja/nacrt): UPDATE samo ako novi > trenutni.

**Cene/rabati:** `MP=Round((NC+ZTD+ZTS)*(1+RUC%)*(1+PDV%))`; MP\* prefiks = sa PDV; popusti **multiplikativno**; rabat hijerarhija **Artikal→Podgrupa→Grupa→Komitent** + cap `MaxRabatProc`.

**Lokacije:** `tLokacijeDelova` je **ledger** (stanje = postavljeno − uklonjeno); prenos/trebovanje isključivi; kvalitet iz flagova (Dorada→1, Skart→2).

**bigbit-sync:** **INSERT-only → UPSERT** po prirodnom ključu (rešava „nema update/delete" bagove); ključ artikla `Sifra artikla → BBSifra artikla`; `EXT_Import_DEF` definicije su u bazi, ne u kodu.

**Zamke koje se ponavljaju (izbeći u 2.0):**
- SQL injection (string-concat svuda) → **parametrizovan Prisma**.
- Ručni autonumber (`DMax+1`, `MAX+korak`) → **identity/sekvenca** (race-condition kod konkurentnih korisnika, posebno brojevi zahteva/dokumenata `'0000/YYYY'`).
- **Nema transakcije** (delimičan uspeh, nema rollbacka) → **DB transakcija** za sve višekoračne operacije.
- Global mutabilni singletoni (`BBTehn`, `RNP`, `PDMSklop`) → **request-scoped kontekst**.
- Hardkodovano ime `'Negovan'` za dev/admin gate → **role/permisije**.
- Plaintext lozinke (`Password`, SMTP, ULS) → **hash + `.env`/secret**.
- `Eval()` u config/POPDV/GK izrazima → bezbedan interpreter ili eksplicitna logika.

---

## 11. Van 2.0 scope-a (NE prenosi se)

Potvrđeno u [02-scope-triage](02-qbigtehn-scope-triage.md) i [ROADMAP](../ROADMAP.md): 2.0 je proizvodni core;
komercijala/knjigovodstvo ostaje u BigBit-u (dolazi u 4.0).

**Čisto van scope-a (baca se za 2.0):**
- **POS / ugostiteljstvo:** `KafeProdaja`, `KafeNaplata`, `KafeKreiranjeDokumenata`, `Kafe`, `Konobari`, `BBTouchScreenCMD`, `Form_IzborStolaPanel`, `ComPortPar` (fiskalizacija).
- **Knjigovodstvo/GK:** `GlavnaKnjiga`, `GKEval`, `APGK`, `GRK`, `GKS`, `SemaZaKontiranje`, `Kontiranje` (stub); bilansni interpreteri `ZR`, `ZRXML`.
- **PDV/POPDV/KEPU:** `PDV_Modul`, `POPDV_Module`, `NKEPU`, `TK_KEPU_MP` (istorijske PDV stope korisne samo ako 2.0 dobije fakturisanje).
- **Fakturisanje/komercijala:** `IF_Class`/`IF_Modul`, `UF_Class`/`UF_Modul`, `USLF_Class`/`USLF_Module`, `OP_Fakturisanje`, `ZbrniRacunModule`, `APVP`.
- **Finansije/platni promet:** `Kamate` (konformni obračun), `Virmani`, `FX_HALCOM` (bankarski izvodi), `Otvorene stavke`.
- **Maloprodaja/vrednovanje:** `BBProdaja` (MP deo), `Nivelacija`, `POPIS`, `PS`, `DodelaPLU`, `Nalepnice`, `Uskladjivanje prodaje`, `UVOZ` (uvozne kalkulacije), `LIB_OS` (osnovna sredstva).
- **POS replikacija (≠ bigbit-sync!):** `SHUTTLE`, `ODBC_Synch_Class`, `ODBC_Synch_MPDok_Class`, `ODBC_Synch_Module`/`NoviModul` — master/slave replikacija **kasa** (MSSQL), ne QBigTehn→ServoSync matični sync.
- **Klijent-specifično/mrtvo:** `BEOHOME`; migracioni skriptovi za druge klijente vendora (GR_/DX_/VULEMARKET_/JUGOLEK_/PSR_/ABB_...); `Copy Of *`, `_TEST*` scaffoldi.

**Tangencijalno (van 2.0 core, ali relevantno kasnije za 3.0/4.0 ili kao referenca):**
- `ZaliheModul` — koncept **rezervisanih/dostupnih zaliha** srodan MRP-u/`part_locations`; obračun je u SP `spSracunajZaliheArtikla`.
- `OP_Fakturisanje` — logika **RN → otprema → faktura** referentna za budući sales/billing sloj.
- `CM_Modul` — izvoz/packing list (palete/koleta) relevantan ako 2.0 dobije otpremu.
- `PDV_Modul` tabela stopa/tarifa i granice — korisno ako 2.0 fakturisanje ikad dobije PDV.

> **Pravilo za Luku:** ako modul dodiruje GK/PDV/fakturu/kasu/fiskal → **preskoči**. Ako dodiruje RN/TP/PDM/BOM/
> MRP/lokacije/komitente-predmete → **prenesi po ovom mapiranju**. Kad si u dilemi oko granice (robni sloj,
> receptura, klasifikacija artikala) — to su [02 §3 AMBIGUOUS](02-qbigtehn-scope-triage.md) tačke koje čekaju
> odluku Nešu/Negovana, ne implementirati unapred.