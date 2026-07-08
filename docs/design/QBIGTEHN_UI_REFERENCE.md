# QBigTehn UI referenca — ekran-po-ekran za 2.0 build

> Izvor: **`Izvoz/Forme`** (SaveAsText dizajn iz žive QBigTehn aplikacije, Negovanov izvoz) — parsiran u
> `_extracted/QBigTehn_UI_parsed/`. Svrha: **vizuelna referenca za 2.0 ekrane** — koji ekrani postoje, koja
> dugmad/akcije, koji obrazac rasporeda. Dopunjuje [migration/08](../migration/08-qbigtehn-vba-domain-map.md)
> (logika modula) i `MODULE_SPEC_*` (implementacija). 236 formi ukupno; ovde **163 ključna ekrana** grupisano
> po 2.0 domenu (multi-agent analiza, 2026-07-08). Font-artefakti i čista slog-navigacija su filtrirani.

---

## Tehnologija / Tehnološki postupci (37 ekrana)

**UX tok (shop-floor kiosk):** radnik se loguje karticom (`IDKartice`/barkod) → na **BarKod unos** skenira
barkod `PredmetID:IdentBroj:Varijanta:Operacija:RJgrupaRC` (checkbox indikatori `SimbolRadnik/Postupak/Operacija`
pokazuju šta je pročitano) → unos komada preko touch tastature → start/stop evidentira vreme. Nastavak tuđeg
postupka preko izbor-dijaloga. **Autorizacija:** radnik sme samo operacije čiji je `RJgrupaRC` u `PristupMasinama`.
Pregledna strana: kartica postupka (master-detail), filter-teški paginirani izveštaji sa drill-through, kritični
postupci (severity boje), analiza aktivnosti po satu, i reconciliation ekrani.

| Ekran (forma) | Svrha | Glavne akcije | Layout obrazac |
|---|---|---|---|
| **BarKod_Unos** ⭐ | srce domena — logovanje karticom, skeniranje barkoda, evidencija komada | Preuzmi BarKod iz clipboard-a · Zatvaram nalog drugog radnika | jednorekordni **kiosk/touch**, scan-driven auto-fill; „zatvori tuđi nalog" gejtovano permisijom; zatvaranje = 1 transakcija |
| **KeyboardSaPostupkom** | touch numerička tastatura + kontekst postupka | Key_0–9 · ENTER · **EVAL (kalkulator)** · +−×÷ · BS/DEL/CLEAR | on-screen numpad (27 dugmadi) + read-only panel postupka; **EVAL → bezbedno izračunavanje, ne Eval()** |
| **BarKod_Ispravka** | storniranje unetog postupka | Uradi storniranje | read-only zaglavlje + `StornirajKomada`; korekcija kao transakcija |
| **BarKod_Status** | kiosk status operacije | (auto-close) | touch-panel prikaz jedne operacije + vreme trajanja |
| **Kartica TehPostupka** (+Podforma) | kartica postupka: zaglavlje + stavke izvršenja | Print · navigacija | **master-detail**; totali (sati/vreme) — **SUM na DB/API, ne u UI** |
| **IzborPostupakaZaDaljiRadZag** | izbor nezavršenog TP („Svi nezatvoreni TP") | Izaberi postupak | modalni izbor-dijalog + grid; paginacija umesto slog-nav |
| **IzborRadnikaZaDaljiRadZag** | primopredaja postupka drugom radniku | Izaberi radnika | dijalog + lista radnika |
| **PristupMasinama** | 🔴 autorizaciona tabela (koje operacije radnik sme) | — | `tPristupMasini × tOperacije` = **`machine_access`**; barkod tok proverava ovaj join |
| **RadniciPoMasinama** | administracija radnik ↔ pristup mašinama | — | master-detail (radnik gore, dozvole dole, re-query na promenu) |
| **UnosOperacije** | šifarnik operacija (CRUD) | Nova operacija | flag checkbox-i `KoristiPrioritet` (prioritet 100/255), `PreskocivaOperacija`, `ZnacajneOperacijeZaZavrsen`; FK na `work_centers` |
| **UnosRadnihCentara** | šifarnik radnih centara (RJgrupaRC) | Nov centar | `RJgrupaRC` string ključ → **pravi FK ka `work_centers`** |
| **Masine** | šifarnik mašina | Nova mašina | mašina → RJgrupaRC |
| **PregledPoPredmetima** ⭐ | centralni navigacioni hub postupaka po projektu | Primeni uslove · Kartica TP · Lokacije delova · Detaljno radni nalog · Prioriteti operacija | **najbogatiji filter panel** (9 combo + status checkbox) + paginacija; raskrsnica ka svim povezanim ekranima |
| **PregledPoPostupcima** | filter-teški izveštaj postupaka | Primeni uslove · Kartica postupka · Radni nalog detaljno · Print zbirno | filter panel → grid; **server-side paginacija** + drill-through |
| **PPS** | pregled proizvodne strukture po nalozima (rekurzivno/BOM) | Primeni uslove · Detaljno RN · Kartica TP · Excel · PDF | paginiran (offset/pageSize~20) + export; `Rekurzivno` flag |
| **PPS_PregledPoOperacijama** | matrica progresa Op1–Op27 po delu | — | široka **pivot matrica** (overflow-x scroll kontejner) |
| **frmKriticniPostupci** | kritični postupci (severity) | — | lista **bojena po severity 1/2/3** (žuta/narandžasta/crvena); boje iz dizajn sistema |
| **AnalizaAktivnosti** / **AA_PoSatu** | pivot aktivnosti radnika po satu | Naredni dan · STD Juče/Danas | red=radnik, kolone=satni intervali; day-stepper; agregacija na serveru |
| **PregledOperacijaPoPrioritetima** | definisanje prioriteta operacija | — | editabilna lista prioriteta (inline edit) |
| **tTehPostupakDokumentacija** | dokumentacija/skice/CNC po operaciji | Nova napomena · Obriši link | attach/upload preko file-storage servisa (ne UNC); soft-delete umesto `Kill` |
| **RazlikeIzmedju_tRN_tTehPostupak** / **LoseEvidentirani** / **frmSanacija** | reconciliation/data-quality | Preporučena akcija · korektivne akcije | diff/audit ekrani (TP vs RN, „po unosu vs po kucanju") sa one-click ispravkama |

Pomoćni/pregled ekrani (grupisano): `IzborPostupakaZaDaljiRad`/`IzborRadnikaZaDaljiRad` (grid podforme izbora),
`PPS_PregledPoNalozima`, `PregledPoPostupcima_Zbir(Grupno)/SviZapoceti`, `tTehnPregled_Panel` (kiosk dashboard),
`PregledTehnoloskihPostupaka`, `PregledPostupakaSaDokumentacijom`, `AARadnika`, `AA_LosUnosKomadaNula`.
**`IzborStolaPanel`** (touch grid 1–200) = POS artefakt, **van 2.0 scope-a** (samo referenca touch-grid patterna).

---

## Radni nalozi (RN) (19 ekrana)

**UX:** ceo domen je oko **JEDNOG centralnog master-detail ekrana `UnosRN`**. `tRN` = istovremeno tehnološki
postupak i zaglavlje naloga (PK `IDRN`); stavke u **6 tipova** (0=operacije, 1=PND nabavni, 2=PDM montažni,
3=PLP limovi/profili, 4=Komponente, 5=NDKomponente), svaki tip svoja podforma. **STATE MACHINE:** nalog mora
biti SAGLASAN pre LANSIRANJA (nikad obrnuto). Ubrzanja: copy/clone postupka, bulk-clone projekta. Odvojen
izveštajni modul (filter panel → grid-ovi sa uporedbom utrošeno/normirano vreme).

| Ekran | Svrha | Glavne akcije | Layout obrazac |
|---|---|---|---|
| **UnosRN** ⭐ | centralni hub — zaglavlje RN + 6 tipova stavki | Novi dokument · **Prepiše stavke/delove/limove** · Prepiši isti postupak · **Definiši saglasnost** · **Lansiraj** · Zaključavanje | **master-detail** (glavni ekran); gusto zaglavlje + detalj po 6 tipova (**tabovi/sekcije u 2.0**); workflow traka gated (saglasan pre lansiran, grupa `Saglasnost/Admins`); lock/brisanje gated |
| **UnosStavkiRN** | podforma operacija (tip 0) | Nova stavka · Skica · Prebaci u clipboard | **editable grid** + live suma `Ukupno = Tpz + Tk×Komada`; prioritet 255 ako centar ne koristi prioritet |
| **UnosStavkiPND/PDM/PLP/Komponente/NDKomponente** | podforme ostalih 5 tipova stavki | Nova stavka | grid po tipu → u 2.0 **tab/sekcija** po tipu; PLP nosi ukupnu težinu po redu |
| **RNSaglasanStatus** ⭐ | popup odobravanja (korak 1 state machine) | — | **modalni popup**; 🔴 obavezan `SifraRadnikaIspravka`; toggle saglasnosti **resetuje operatera** (re-potvrda); beleži potpis |
| **RNLansiranStatus** ⭐ | popup lansiranja (korak 2) | — | modalni popup (prostiji); `IDStatusPrimopredaje→3`; tek posle saglasnosti; beleži `launched_by/at` |
| **IzborNalogaZaPrepisivanje** | dijalog kopiranja postupka iz drugog naloga | Prepiši stavke · Odustani | mali modalni pick; `spRN_PrepisiStavkeIzNaloga`; **samo kad je cilj prazan** |
| **KreirajNoveNalogeZaIDPredmet** | wizard bulk-clone naloga projekta (koeficijent) | Pripremi podatke · Kreiraj sve naloge | **dvofazni wizard** sa staging grid-om (`Kreirati` checkbox po redu); koeficijent množi količine; 2.0 → transakcioni clone endpoint |
| **StavkeRNSlike** | popup skica/slika po stavci | Nova skica · Obriši link | galerija priloga po stavci sa upload/remove/preview |
| **RNPregledZag** | filter panel izveštaja naloga | Primeni uslove · Detaljno RN · Kartica TP · Excel export | **filter bar** (opsezi datuma, default 1901/2099) iznad 3 ugnjezdena grida |
| **RNPregled / PoRJ / PoRadniku / Postupci / Stavke** | read-only izveštaji sa uporedbom utrošeno/normirano | — | izveštajne tabele sa **agregacijama** i group-by (RJ/radnik); isticanje razlike od norme |

Pomoćni ekrani: `PregledStavkiRN` (read-only operacije po RJ), `IzborNalogaZaPrepisivanjeZaIDPredmet`/`PG_IzborNalogaZaPrepisivanje` (varijante pick-dijaloga).

---

## PDM / Crteži / BOM (12 ekrana)

**UX:** ulazna tačka je **PDMCrteziPregled** (browser svih crteža sa filter barom) → drill na detalj/sastavnicu/
where-used/PDF. BOM je rekurzivan (sklop → podsklopovi → delovi). Uvoz iz SolidWorks XML-a (log + batch).

| Ekran | Svrha | Glavne akcije | Layout obrazac |
|---|---|---|---|
| **PDMCrteziPregled** ⭐ | centralni browser crteža sa filter barom | Detaljno crtež · Otvori novi nacrt primopredaje · Sastavnica delova/gotove robe · Gde se koristi · Štampaj/Otvori PDF | **master-detail** (filter panel + grid + akcije po redu); sastavnica **samo za najnoviju reviziju** (`MAX(Revizija)` — 🔴 leksikografski bug → `revision_order` kolona) |
| **PDMSklop** | detaljna kartica sklopa; režim Proizvodnja/Nabavka | navigacija | single-record navigator; toggle `CheckNabavka` filtrira (proizvodnja vs kupljen gotov deo) |
| **PDMTreeView** | rekurzivno BOM stablo sklopa | — | tree control; 🔴 legacy DAO N+1 **bez anti-ciklus** → **rekurzivni CTE + cycle guard**, lazy-expand, konsolidacija duplih |
| **GdeSeCrtezKoristi** (+podforma) | where-used (obrnuti BOM) | Prikaži stablo · Štampaj spisak | master + grid roditelja; checkbox `Rekurzivno`; CTE dete→roditelj |
| **PotrebneKomponenteZaCrtez** (+grid) | sastavnica delova (drilldown BOM) | Štampaj sastavnicu · Prikaži stablo · **Sastavnica za podsklop** · Back | master + grid; drill u podsklop samo ako `JeSklop`; **route/state stack** umesto globalnog singletona |
| **PotrebniGotoviDeloviZaCrtez** ⭐ | **most PDM→MRP** — iz sastavnice generiše potrebe | **Poruči robu za RN** · Prikaži stablo · Sastavnica gotove robe | master + grid nabavnih delova **sa zaliha-overlay**; `TipEksplozije` 1/2; guard duple potrebe |
| **PregledGotovihDelovaZaCrtez** | grid nabavnih delova + zalihe | — | kolone potrebno/rezervisano/slobodno/poručeno → ulaz u MRP odluku |
| **PDMSklopReference** (+PodSklop×4) | reference podsklopa | — | 🔴 legacy **fiksno 4 nivoa** → **rekurzivni prikaz proizvoljne dubine** |
| **PDMXMLImportLog** | log SolidWorks XML uvoza + batch trigger | **Preuzmi XML fajlove** | admin: filter + log grid (uspešno/kritično); uvoz **hronološki sortiran** (revizioni upgrade); 🔴 autorizacija hardkod na `'Negovan'` → **rola pdm-import** |

## Nacrti / Primopredaje (16 ekrana)

**UX:** nacrt grupiše PDM crteže (`handover_drafts`, 2.0 vlasništvo) → decision-engine reši sporne stavke →
**„Kreiraj primopredaju"** generiše RN → workflow odobravanja (Odobri→izbor tehnologa→Lansiraj). Status enum
`IDStatusPrimopredaje` 0=U obradi/1=Odobren/2=Odbijen/3=Lansiran (monoton, samo napred, preko `spPromeniStatusPrimopredaje`).

| Ekran | Svrha | Glavne akcije | Layout obrazac |
|---|---|---|---|
| **NacrtPrimopredaje** (+stavke) | zaglavlje nacrta + crteži | Novi nacrt · **Kreiraj primopredaju (RN)** · Definiši sporne stavke · Zaključavanje | master-detail; 🔴 „Kreiraj" **onemogućeno dok svi duplikati/sporne nisu rešeni**; grupa `KreirajPrimoPred/Admins` |
| **SpremiNacrtPrimopredaje** | dodaj crtež u nacrt (iz PDM-a) | Dodaj u nacrt · Prikaži nacrt | mali modal; samo `MAX(Revizija)`; sklop→cela BOM, deo→samo deo; 0→novi/1→auto/>1→izbor |
| **OdlukePredProvera** (+podforma) | **decision-engine** spornih stavki | Primeni odluke · Primeni na sve | 🔴 `OdlukaAkcija` 1=Isključi/2=Predaj ponovo/3=Dopuni (razlika, min 0) — **isti šablon kao MRP → jedan generičan resolver** |
| **Primopredaja** ⭐ | detaljna forma RN u primopredaji, 6 tipova stavki | Novi dokument · **Lansiraj RN** · Kopiraj postupke · Štampa PND/PDM/PLP · Zaključaj | master + **TABOVI stavki** (0=operacije…5=NDKomponente); crtež/komitent = BigBit overlay (read-only); `Lansiraj → status 3` |
| **PrimopredajaUnosStavki{RN,PND,PDM,PLP,Komponente,NDKomponente}** | 6 tab-podformi stavki | Nova stavka · Skica | editabilni grid po tipu; PLP nosi `UkupnaTezina`; PDM montažni **mora biti definisan kao RN**; ND po kataloškom broju |
| **PregledPrimopredaje** ⭐ | workflow odobravanja + batch PDF | **Odobri** · **Odbaci** · Dokument primopredaje · Štampaj sve PDF | filtrirana lista + akcije; „Odobri" → **frmIzborTehnologa**; grupa `OdobriPrimoPred/Admins` |
| **frmIzborTehnologa** | izbor tehnologa pri odobravanju | Potvrdi · Odustani | confirm-modal sa **obaveznim izborom tehnologa** pre prelaska u „Odobren" |
| **PregledNacrtaPrimopredaje** | lista nacrta (kreirani vs predati) | drill: crtež/nacrt/komponente | read-only filtrirana lista; `IsGlavni` flag |
| **PregledStavkiPrimopredajaRN** | read-only operacije RN sa barkodom | Skica | grid grupisan po grupi radnih centara; barkod po operaciji |

---

## Lokacije delova / Proizvodne strukture (10 ekrana)

**UX:** premeštanje/trebovanje napravljenih delova po policama (**ledger**) + šifarnici pozicija/radnika/RJ.
Detaljno u [MODULE_SPEC_lokacije](MODULE_SPEC_lokacije.md) (uklj. §8 odnos sa 1.0 loc modulom).

| Ekran | Svrha | Glavne akcije | Layout obrazac |
|---|---|---|---|
| **LokacijaNapravljenihDelovaZag** ⭐ | glavni nosilac — prenos/trebovanje po policama | **Premesti deo sa police** · **Istrebuj deo** · Kartica dela · Nalepnice · Nova lokacija | master-detail; 🔴 `KolicinaZaPrenos`/`KolicinaZaTrebovanje` **međusobno isključive**; dugmad enable/disable po popunjenosti; transakcioni servis + ledger |
| **LokacijaSvihNapravljenihDelovaPoRN** | grid delova po RN sa validacijom koordinata | — | continuous grid + footer total; koordinate `XPoz/YPoz/ZPoz` numeričke; `IDVrstaKvaliteta` (OK/dorada/škart) |
| **LokacijaNapravljenihDelova** | append-only unos nove lokacije | — | `DataEntry=True`; ledger (svaki unos = zapis, ne update); validacija iz zaglavlja |
| **KarticaLokacijaDela** | istorija postavljanja/uklanjanja + totali | Print | read-only kartica; 🔴 **ledger** `PreostaloKol = SUM(postavljeno) − SUM(uklonjeno)`; filteri datum/polica |
| **PregledDelovaPoLokacijama** | globalna pretraga delova po lokacijama (12 param) | Primeni uslove · Detaljno RN · Kartica TP · Lokacije | filter panel → grid; server-side parametarska pretraga (TVF); kontekst-akcije po redu |
| **frmPozicije** / **frmGrupe** | šifarnik pozicija/polica i objekata (hale/zone) | Novi · Sačuvaj · Undo | single-record CRUD; 🔴 `DMax+1` race → sekvenca; `frmGrupe` hijerarhija — otvoreno |
| **Radnici** | matični podaci radnika (bedž/kartica/login) | Novi radnik · Prebaci IDKartice u clipboard | forma radnika (default `Aktivan=True`); 🔴 plaintext lozinka → hash; `IDKartice` = barkod login; re-query pristupa mašinama |
| **UnosRadnihJedinica** / **VrsteRadnika** | šifarnici RJ i vrsta radnika | Nova RJ / vrsta | CRUD; `IDRadneJedinice` = **TEKST FK** (5 char); `DodatnaOvlascenja` → permission flag |

## Komitenti / Predmeti / Artikli (12 ekrana)

**UX:** matični podaci — **read-only overlay nad BigBit-om** (`Pregled komitenata` eksplicitno blokira izmenu:
„Ne možete menjati komitente — koristite BigBit"). Predmeti + pisarnica (delovodnik sa zakonskim knjigama).
Artikli/zalihe (lager lista, stanje po magacinu). Rabatna hijerarhija Artikal→Podgrupa→Grupa→Komitent.

| Ekran | Svrha | Glavne akcije | Layout obrazac |
|---|---|---|---|
| **Pregled komitenata** | read-only lista/pretraga komitenata | Detaljan prikaz · Print | 🔴 `BeforeUpdate` **blokira izmenu** → **read-only overlay + „Preuzmi iz BB"**, ne CRUD; filteri rabat/region/PIB |
| **Unos komitenata** | kartica komitenta (matični) | navigacija · CRUD | single-record; `DobarTR*/DobarPIB` = izvedene MOD validacije (servisne, ne polja); u 2.0 read-only |
| **Predmeti** | servisni/prodajni predmet (komitent/dokumenti) | Novi · Promeni komitenta · Poveži sa ponudom | kartica sa NAŠI vs VAŠI kontakti + dokumenti; 🔴 **DRUGA „predmet" šema** (≠ pisarnički `T_Predmeti`) — razjasniti šta ide u `projects` |
| **Pisarnica_PregledPredmeta** | delovodnik — pregled + zakonske knjige | Primeni uslove · **Dnevna knjiga** · Dostavna knjiga · Zaključaj | filter panel + grid; bojenje po `VRSTA`; **Dnevna knjiga = samo jedan dan** |
| **Pisarnica_UnosPredmeta** (+prilozi) | unos predmeta u delovodnik + prilozi | Novi · Snimi · Zaključaj | master-detail + subforma priloga; numeracija `1 + DCount(KLASIF u godini)` (**ORGAN se ne broji**) |
| **Grupe artikala** / **Magacini** | šifarnici grupa i magacina | Nova/Novi | minimalni CRUD; grupe = ključ rabatne hijerarhije |
| **Lager lista** ⭐ | filtriran pregled zaliha sa sumama | Primeni uslove · Prikaži sve · Printuj · Popisna lista sa policama | filter panel + grid + **footer sume**; `Slobodno = Kolicina − RezKol` |
| **B_ZaliheArtPoMag** (+podforma) | stanje jednog artikla po magacinima | CT Zalihe · Pripremi podatke | master-detail; `EXT_R_Artikli` = BigBit overlay; temp-tabela → agregacioni upit u 2.0 |

---

## MRP / Nabavka (20 ekrana)

**UX:** potreba → plan → zahtev za nabavku → realizacija. Centralni ekran **PlaniranjeNabavke** (state machine).
Decision-engine za sporne stavke (deljen sa primopredajom). Zalihe = BigBit overlay. Detaljno u
[MODULE_SPEC_mrp](MODULE_SPEC_mrp.md).

| Ekran | Svrha | Glavne akcije | Layout obrazac |
|---|---|---|---|
| **MRP_Pregled** | dashboard/filter plana potreba | **Ažuriraj lager** | filter bar (datum + crtež + „obrađeni") + akcija osveži lager (BigBit overlay) |
| **MRP_PregledSaZalihama** (+3 sestrinske) | read-only pregledi potreba sa zalihama | — | grid nad view-om; 🔴 `Slobodno = Lager − Rezervisano`; **4 varijante = 1 grid sa preset filterima/tabovima** (SaZalihama/PoDobavljačima/Rezervisano/SamoNabavku) |
| **MRP_DetaljanPregledSaZalihama** | detaljan pregled + „Kreiraj plan" | **Kreiraj plan** | red-po-red; ulaz u plan; guard duple potrebe (`IDPlan≠0` → postojeći); `ColorKey/StatusArtikla` → semantičke boje |
| **MRP_Potreba** (+stavke) | zaglavlje MRP potrebe | Definiši rezervisane/trebovane · Definiši sporne · Proknjiži | master-detail; ⚠️ **„Proknjiži" ovde je MRTVA verzija** (`BrojDokumenta='TEST'`) — NE portovati; konsolidovati sa plan formom |
| **PlaniranjeNabavke** ⭐ | glavna forma plana (state machine) | Novo planiranje · **Definiši rezervisane i trebovane** · **Definiši sporne** · **Proknjiži** · Zaključaj | master-detail + 🔴 **STATE MACHINE**: predato→lock; sporne bez odluke→samo „Odluke"; sve pokriveno→Proknjiži (`spMRP_Potrebe_PromeniStatus 4` + lock); **nema rollbacka → 1 transakcija** |
| **PlaniranjeNabavkeStavke** | podforma stavki plana | — | inline grid; `Rezervisano + ZaNabavku ≥ PotrebnoUkupno`; `IskljuciNabavku`; označiti nepokrivene |
| **SpremiPlaniranjeNabavke** | kreiraj plan iz sklopa (dijalog) | Kreiraj dokument | modal; revizija = MAX; mora imati nabavne delove; guard duple potrebe |
| **PlanSporneStavke** (+podforma) ⭐ | **decision engine** spornih stavki | **Primeni odluke** · **Primeni na sve** | 🔴 `OdlukaAkcija` 1=Isključi/2=Nabavi ponovo/3=Nabavi razliku (min 0) — **isti generičan resolver kao primopredaja**; gate za proknjižavanje |
| **ZahteviZaNabavku** | lista zahteva dobavljačima (RFQ) | Primeni uslove · Detaljno zahtev · **Realizacija zahteva** · Detaljno upit | master lista + filter; `URokuDana = DatumZahteva → RokZaPonudu` (bojiti kašnjenje) |
| **UnosZahtevaZaNabavku** (+stavke) | unos specifikacije + kreiranje upita | **Potvrdi (obavesti nabavku)** · Kreiraj upit · Upiši dobavljača u sve · Prepiši prethodnu | master-detail + toolbar; „Potvrdi" → mail (BBMail); `RokZaPonudu = DatumZahteva + URokuDana` |
| **SpecifikacijaZahtevaZaNabavku** | stavke specifikacije | Nova stavka | grid sa **combo pretragom artikla**; `NotInList` → **slobodan (ne-kataloški) unos** uz katalog-vezan |
| **SpecifikacijaNabavkeIUpiti** (+3 tab-podforme) | realizacija zahteva (životni ciklus) | — | detalj sa **3 taba**: specifikacija / trebovanja (rok/isporučeno) / upiti dobavljačima (poslato) |
| **Trebovanje - Podforma** | bogata podforma stavki trebovanja | Nova stavka · Upiši datum isporuke · VP Kartica artikla | napredni grid (53 kontrole): kolone trebovano/zalihe/isporučeno, cena, `Vrednost = TrebKol×Cena`, footer suma; toggle vidljivosti cene |
| **BBMail_ZaNabavku** | slanje maila nabavci (PDF/XLS prilog) | Send mail · Create attachments | email kompozicija; 🔴 kredencijali iz **`.env`**, server-side PDF + SMTP (ne Access klijent) |

---

## Common / Meni / Config (37 ekrana)

Uglavnom **infrastruktura koja se u 2.0 ZAMENJUJE modernim ekvivalentom**, ne portuje 1:1. Grupisano po ulozi:

| Grupa | Ekrani | 2.0 ekvivalent |
|---|---|---|
| **Glavni meni** | `Prva maska` (Caption „Tehnologije izrade" — hub proizvodnog jezgra), `Prva maskaMagacin`, `Prva maskaPregledi`, **`QPrvaMaska`** (nova ribbon verzija, 20.07.2025) | **AppShell + sidebar** (DESIGN_SYSTEM §4); veliki dugmad-launcher → navigacija po modulima/rolama |
| **Config** | `CFGReadWrite`, `CFG_Global/Lokal/Sys`, `CFG_SviParametri_DEF`, `CFG_DozvoljeneVrednosti`, `CFG_KatParPrip`, `BBCFG` (POPDV/porezi) | **ConfigService** (per-tenant override + global default); hijerarhija `Lokal→Global→DEF`; **bez `Eval()`** |
| **Prava pristupa** | `BBPravaPristupa` (Visible/Locked/Enabled matrica po user×forma×kontrola) | **RBAC guardovi + permisije** ([RBAC_RLS_PREDLOG](RBAC_RLS_PREDLOG.md)) |
| **Import/Export** | `BBImport` (XLS→dokument), `BBExport`/`BBTools` (univerzalni export XLS/XML+mail), **`ER_Export`** (SEF — vidi [MODULE_SPEC_sef](MODULE_SPEC_sef.md)) | export servis + [SEF modul](MODULE_SPEC_sef.md); import kroz DTO validaciju |
| **Bootstrap/firma** | `Izbor radnog fajla`, `Firme`, `IzaberiFirmu`, `RadniFajlDetaljno` | 🔴 multi-firma/FIT je **legacy Access ograničenje** → 2.0 **jedna PG baza** (tenant kolona), bez izbora baze na startu |
| **DB admin** | `Baze`, `BazeITabele`, `CNN`/`CNN_List`, `Alati` (backup/repair/compact), `BBBackup`, `Intro` (splash) | N/A — Postgres/DevOps; ne portovati |
| **Query engine** | `BBQueryDef` (mapa ekran→SP/UDF/SQL), `BB_UsersQuery` (ad-hoc runner) | **`BBQueryDef` = ključna mapa** upit-po-ekranu za rekonstrukciju (ne portovati kao alat, koristiti kao izvor) |
| **Utils** | `Digitron` (kalkulator), `Recnik` (SR-EN prevod), `frmUSysRibbons`, `BBInfo`/`BBExtra` (dijagnostika), `BBT_BrojDokumenataPoGodinama` | native/dizajn-sistem komponente; prevodi → i18n |

---

## UI obrasci za 2.0 dizajn sistem

Patterni koji se ponavljaju kroz sve domene (kandidati za deljene kit komponente):
1. **Master-detail** — zaglavlje + embedded grid/podforma (RN, TP kartica, plan, primopredaja, lokacije, komitenti).
2. **Touch/kiosk barkod** — velika dugmad, on-screen numpad, scan-driven auto-fill (BarKod unos, KeyboardSaPostupkom, kiosk paneli).
3. **Filter panel + paginirani grid + akcije po redu** — „Primeni uslove" (Shift+F9) → server-side grid sa drill-through (svi „Pregled*" izveštaji, PDM browser, lager, MRP, pisarnica).
4. **Workflow popup + gating** — saglasnost→lansiranje, odobri→izbor tehnologa; dugmad uslovno dostupna po statusu/permisiji.
5. **Decision-podforma** (1=Isključi/2=Ponovo/3=Razlika) — **jedan generičan resolver** za MRP + primopredaju.
6. **Tab-forme stavki po tipu** — RN/primopredaja (6 tipova), realizacija zahteva (3 taba).
7. **Bojena lista po severity/statusu** — kritični postupci, MRP `ColorKey`, pisarnica `VRSTA` → semantičke boje/badge (ne hardkod).
8. **Footer agregati** — lager/MRP/trebovanje sume; **SUM na DB/API**, ne u UI.
9. **Pivot/matrica** — PPS operacije Op1–27, analiza aktivnosti po satu (overflow-x scroll kontejner).
10. **Master-lista šifarnika** (single-record CRUD u legacy) → **list + editor** u 2.0.

## Napomene (Access specifičnosti — NE prenose se)

- **Font-kontrole kao artefakti** (`MS Sans Serif`, `Arial CE`, `Calibri` kao „dugmad"/"polja") — SaveAsText šum, filtrirano.
- **`DetachedLabel` Tag, `PrtDevMode`/`PrtMip` blobovi** — Access štampa/label metapodaci, ignorisati.
- **Slog-navigacija** (Prvi/Prethodni/Sledeći/Poslednji) → **paginacija/prev-next u kontekstu liste**.
- **Reklamni paneli** (`ReklamniPanel*`) — marketing, ignorisati.
- **Global singletoni** (`BBTehn`, `RNP`, `PDMSklop`) → request-scoped kontekst.
- **Temp/staging tabele** (`tmp_*`, `Q_tmp_*`) → agregacioni upiti/transakcije, ne privremene tabele.
- **`Eval()` u config/kalkulatoru** → bezbedno izračunavanje.
- **Hardkodovano ime `'Negovan'`** za admin gate → rola/permisija.
- **Plaintext lozinke** (`Password`, SMTP) → hash/`.env`.
- **`Kill` fajla** pri brisanju dokumentacije → soft-delete/audit.

---

*Izvor: `Izvoz/Forme` SaveAsText (Negovanov izvoz), multi-agent UI analiza 2026-07-08. 163 ekrana / 8 domena.
Za logiku vidi [migration/08](../migration/08-qbigtehn-vba-domain-map.md); za implementaciju `MODULE_SPEC_*`.*
