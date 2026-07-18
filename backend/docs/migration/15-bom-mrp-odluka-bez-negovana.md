# BOM/MRP — dubinska analiza za odluku BEZ Negovana

> **Izvor:** read-only multi-agent ekstrakcija (5 agenata, 2026-07-08) koja ukršta **SQL tela procedura**
> (`_analiza/qbigtehn_sqlserver.sql`) sa **VBA pozivima** (`QBigTehn_APL/`, 466 fajlova) da utvrdi **koja je
> implementacija stvarno ožičena**. Cilj: zatvoriti ~40 „POTVRDITI sa Negovanom" tačaka iz
> [05](05-qbigtehn-sqlserver-logic.md) — tamo gde kod daje odgovor, odlučujemo sami; ostatak (mali) ide Negovanu.
> Ništa u kodu nije menjano.

**Zašto je ovo bilo moguće:** [05](05-qbigtehn-sqlserver-logic.md) je analizirao SAMO SQL dump, u kome nema
INSERT/write-path-ova (oni su u VBA klijentu). Zato je 05 ostavio pitanja tipa „ko puni MRP_Potrebe". Sada
kad imamo i VBA kod, ta pitanja su **rešiva iz koda** — vidi se koji ekran zove koju proceduru i ko piše šta.

---

## 0. Rezime odluka (šta 2.0 radi)

| # | Pitanje iz [05](05-qbigtehn-sqlserver-logic.md) | Razrešenje iz koda | Odluka za 2.0 | Treba Negovan? |
|---|---|---|---|---|
| 1 | Ko puni `MRP_Potrebe`/`MRP_PotrebeStavke`? | **VBA klijent** (`Form_PotrebniGotoviDeloviZaCrtez`), inline INSERT, nema SP | `MrpPotrebeService.generate()` u NestJS, jedna transakcija | ❌ ne |
| 2 | Grana A (Slobodno) vs B (sirovo Zalihe) — koja važi? | **Prividna razlika**: klijent PRE grane B upiše *slobodne* zalihe (stanje−rezervisano) u kolonu `Zalihe` → obe rade isto pravilo | **Jedna** formula: `rez=min(potrebno, max(stanje−rezervisano,0))`, ostatak nabavka; UVEK setuj `OdlukaAkcija` | ❌ ne |
| 3 | Bug otvorene transakcije u `spMRP_KreirajIRealizujPlan`? | **NE postoji** — `XACT_ABORT ON` + `TRY/CATCH ROLLBACK`; `RETURN` je mrtav kod | Provere PRE transakcije; ne portovati `RAISERROR+RETURN` idiom | ❌ ne |
| 4 | Kako se PDM crtež mapira na šifru artikla? | Preko **`KataloskiBroj`** (`PDMCrtezi.KataloskiBroj == EXT_R_Artikli.[Kataloski broj]`), NE preko naziva/crteža | `ArticleMappingService.resolveByCatalog()`, normalizovan ključ (trim+citext) | ❌ ne |
| 5 | Odakle lager (Zalihe)? | Iz **BigBit robnog** (`EXT_T_Robna dokumenta`, `Level=0`, `Vrsta<>'KODJ'`, `Datum<=danas`); QBigTehn samo kešira u `MRP_StanjeArtikala` | `StockSnapshot` servis; računati slobodno = stanje−rezervisano live/on-demand | ⚠️ potvrditi BB konvencije nivoa |
| 6 | Odakle rezervacije? | Iz BigBit robnog: `Level=250 AND Rezervisi=True AND Ulaz=No` po `Sifra artikla` | `stock_reserved` (iz robnog) ≠ `plan_reserved` (rezultat MRP podele) — razdvojiti | ❌ ne |
| 7 | Odakle `VremeIsporukeDana` (lead time)? | Iz BigBit `EXT_DobavljaciZaArtikal` (primarni dobavljač), po artiklu; global CFG fallback | `ArtikalDobavljac.lead_time`, `datum_nabavke` = generated | ❌ ne |
| 8 | Ciklusi u BOM-u — ima li zaštite? | **NEMA nigde na write-u**; anti-ciklus samo u `ftBOMKolicine`; 3 čitača bi visili | Dodati anti-ciklus na SVA 3 mesta + provera pri unosu grane | ⚠️ ciklus = tvrda greška? (preporuka DA) |
| 9 | `PotrebnoKomada` INT — treba li decimala/JM na PDM? | Ne — grana je striktno INT, nema JM na PDM nivou (JM tek na RN/artiklu) | PDM edge = Integer; Decimal/JM na RN/artikl nivou | ⚠️ buduća potreba m/kg? |
| 10 | Šifarnik magacina — ID→tip (sirovine/gotovo)? | `Magacini.VrstaMag` postoji, ali **mapiranje ID→tip NIJE u kodu**; „2=sirovine" je u MRTVOM view-u | `Skladiste.tip` enum; ne hardkodovati ID 2 | ✅ **DA** — koji ID je šta |
| 11 | Broj plana — parsing rizik? | **Realan bug**: `CHARINDEX('/')` puca ako `BrojCrteza` sadrži `/` → duplikat `BrojPlana` | Regex zadnji segment ILI brojač-tabela + `UNIQUE` | ❌ ne |
| 12 | Barkod format prijave rada? | **[05]/spec POGREŠNI** — nije jedan barkod nego DVA (RNZ + S), `PrnTimer` vezni ključ | Dekoder za 2 tipa; ispraviti [MODULE_SPEC_tehnologija](../design/MODULE_SPEC_tehnologija.md) | ❌ ne |
| 13 | Write-path prijave rada — gde je? | Snimanje **vezane Access forme** (`BarKod_Unos`→`tTehPostupak`), ne SQL; nije atomično | `prijaviRad`/`zatvoriOperaciju`, jedna transakcija | ❌ ne |
| 14 | Koja definicija „završen RN" važi? | Sve 3 žive u raznim izveštajima; **operativna istina** = najnovija (`ZavrsenoKomada>=Planirano` na značajnim op.) | Jedna kanonska = najnovija; `isCompleted` deljena svuda | ❌ ne |
| 15 | `NapravljenoKomada` uključuje doradu/škart? | **DA** (nijedna funkcija ne filtrira kvalitet); razlika 2 funkcije je `ZavrsenPostupak` filter | Razdvojiti 3 metrike po kvalitetu; za pokriće plana broj samo `DOBAR` | ⚠️ potvrda pravila |
| 16 | 23h auto-close — postoji u kodu? | **NE** — nema traga (samo AutoKeys/Autoexec); pravilo je iz uputstva | Nov `@nestjs/schedule` cron; nije migracija | ✅ **DA** — semantika (komada? KPI flag?) |
| 17 | `IDPredmet<>4521` hardkod — šta je 4521? | Namerno izuzet iz dorada/škart toka (uz sentinel 0); verovatno servisni/generički predmet | Flag `excludeFromReworkScrap`, ne magic ID | ✅ **DA** — šta je predmet 4521 |

**Zaključak:** od ~40 „POTVRDITI" tačaka, **13 je razrešeno iz koda** (odlučujemo sami), **~4-5 ostaje** za
Negovana (magacin tip, ciklus-politika, 23h semantika, predmet 4521, BB nivo-konvencije). Vidi §5.

---

## 1. MRP — podela rezervisano/nabavka (najvažnije)

### 1.1 Razrešenje „grana A vs B"
[05 §2.1](05-qbigtehn-sqlserver-logic.md) je opisao dve **nekonzistentne** formule. Ukrštanje sa VBA pokazuje
da je **razlika prividna**:

- **Grana A** (`spMRP_KreirajIRealizujPlan`) — zove se **samo** iz `Form_MRP_DetaljanPregledSaZalihama`
  (dugme „Kreiraj Plan"). Formula: `Slobodno = max(MRP_StanjeArtikala.Zalihe − Rezervisane, 0)`, postavlja
  `OdlukaAkcija` (1/2/3), i upiše `Slobodno` u kolonu `Zalihe`.
- **Grana B** (`spPDM_Planiranje_PopuniRezervisanoINabavku`) — zove se iz PDM/crtež toka i sa dugmeta
  „Definiši potrebne količine". U SP-u čita **`s.Zalihe`** (naizgled sirovo). **ALI** VBA `UpdatePlaniranjeStavke_SifraArtikla_Zalihe`
  (`PlaniranjeNabavke.bas:171-175`) **pre** poziva SP-a upiše u kolonu `Zalihe` **neto** vrednost
  `SlobodneZalihe = Zalihe(BB_StanjeKolicinaNaDan) − Rezervisano(BB_RezervisaneKolicine)`.

→ **Obe grane efektivno računaju pokrivenost naspram (stanje − rezervisano), floor 0.** Isto poslovno
pravilo. Prave razlike: (a) izvor lagera (A: keš `MRP_StanjeArtikala`; B: BB_* view-ovi), (b) A postavlja
`OdlukaAkcija`, B ne. **Ne gaze se** — svaki plan pravi tačno jedan tok.

### 1.2 Odluka za 2.0
**Jedna kanonska formula, jedan servis:**
```
slobodno   = max(stanje − rezervisano, 0)
rezervisano = min(potrebno, slobodno)
zaNabavku  = potrebno − rezervisano
OdlukaAkcija = 1 (puno iz zaliha) | 3 (delimično) | 2 (sve u nabavku)   -- UVEK izvesti
```
- Dva **ulaza** (MRP-vođen i crtež-vođen) ostaju, ali oba idu na **istu** kalkulaciju.
- Ukloniti klijentsko pred-netovanje zaliha — netovanje radi server (jedan izvor istine za „slobodno").
- `OdlukaAkcija` se uvek postavlja (grana B je legacy propuštala).
- `StatusArtikla` semafor (0/1/2 zeleno/žuto/crveno) = isto „slobodno vs potrebno", računa se jednom
  i renderuje u FE. **Ne mešati** sa legacy `ColorKey` (to je grupno bojenje po `IDPotreba`, DENSE_RANK).

### 1.3 Punjenje `MRP_Potrebe` (write-path van dumpa)
`Form_PotrebniGotoviDeloviZaCrtez` radi: `INSERT MRP_Potrebe` (zaglavlje) → `INSERT MRP_PotrebeStavke
SELECT ... FROM ftMRP_PotrebeZaCrtez(...)` → obogaćivanje `SifraArtikla` → ažuriranje lagera. Klijentski
dupli-guard (`Status IN (0,2)`) + DB `UNIQUE UX_MRP_Potrebe_BOM (IDPredmet, IDCrtezRoot, TipEksplozije)`.

**2.0:** `MrpPotrebeService.generate(idCrtez, tipEksplozije, kolicina)` u JEDNOJ transakciji: (1) upsert
zaglavlja `ON CONFLICT (IDPredmet, IDCrtezRoot, TipEksplozije)`, (2) INSERT stavki iz PG funkcije
`ftMRP_PotrebeZaCrtez` (`WITH RECURSIVE`, `RETURNS TABLE`), (3) auto-link artikala, (4) snapshot lagera.
⚠️ **Bug za NE-portovati:** legacy `NOT EXISTS` dedupe je **zakomentarisan** ali se korisniku ispisuje
„Preskočeno (duplikati): N" — ponovno generisanje **duplira stavke**. U 2.0 pravi `ON CONFLICT`/dedupe.

### 1.4 „Bug otvorene transakcije" — NE postoji
[05 §2.4](05-qbigtehn-sqlserver-logic.md) je sumnjao na otvorenu transakciju posle `RAISERROR+RETURN`.
Telo ima `SET XACT_ABORT ON` + `BEGIN TRY … BEGIN CATCH IF @@TRANCOUNT>0 ROLLBACK; THROW`. `RAISERROR`
sev.16 u `TRY` skače u `CATCH` koji uradi ROLLBACK → `RETURN` je **nedostižan mrtav kod**, transakcija se
korektno poništi. **Nije runtime defekt.** (Realni problem: skupi dupli-check i `spMRP_SyncStanjeArtikala`
se izvršavaju nepotrebno UNUTAR transakcije → u 2.0 provere PRE `BEGIN`.)

---

## 2. BOM / PDM sastavnica

### 2.1 Koja funkcija hrani koji prikaz (hijerarhija, ne haos)
- `ftBOMKolicine` = **engine** (`WITH RECURSIVE`), nije direktno vezan za formu; poziva se **interno** iz
  `ftPregledPotrebnihKomponentiZaCrtezIKolicinu` (full-BOM) i iz `spDodajCrtezSaDubinom` (nacrt primopredaje).
- `ftPregledPotrebnihKomponentiZaCrtezIKolicinu` = view-sloj nad engine-om; `@TopLevelOnly=1` → direktna
  deca (1 nivo), `=0` → pun BOM. Dodaje `BrojCrteza/Naziv/JeSklop/PostojiPDF`.
- Glavni ekran `Form_PotrebniGotoviDeloviZaCrtez` puni **tri panela**: (1) nabavni/gotovi katalog delovi
  (`ftBOMNabavniDelovi` → spoj sa robnom evidencijom), (2) proizvodni top-level podsklopovi (`WHERE JeSklop='+'`),
  (3) puna PDM struktura (stablo, sve grane).
- `ftBOMNabavniDeloviKolicine` — **samo** u planiranju nabavke (`Form_SpremiPlaniranjeNabavke`).
- `ftStrukturaProizvodaZaIzvestaj` — **NIJE PDM nivo**, radi nad `tRN/tRNKomponente` (izvršna RN sastavnica);
  ide preko SP-a (pivot). **Držati kao zaseban RN-domen, ne mešati sa PDM BOM-om.**

**2.0:** zadržati hijerarhiju SQL funkcija; jedan endpoint vrati **tri sekcije** `{ proizvodniPodsklopovi,
nabavniDelovi, stablo }`, FE ih prikaže kao panele/tabove. `ftBOMNabavniDelovi` + `...Kolicine` konsolidovati
u jednu funkciju sa parametrom.

### 2.2 Nabavno vs proizvodno — namerno razdvojeno
Proizvodne funkcije po definiciji vraćaju samo čvorove gde su **i roditelj i dete `Nabavka=0`** (JOIN
`ISNULL(Nabavka,0)=0` obe strane). Nabavni delovi se dobijaju **odvojeno**. Spajanje radi UI (tri panela).
→ **2.0:** razdvajanje isključivo na `PDMCrtezi.Nabavka` (bit→boolean); ne „lepiti" u jednu listu (različit
ključ: crtež vs kataloški broj, i različite kolone — stanje/rezervacija samo za nabavne).

### 2.3 Ciklusi — NEMA zaštite (kritično)
Jedini write-path grane (`DodajSlogKomponentePDMCrteza`, iz PDM XML importa) proverava samo da par
`(ZaIDCrtez, TrebaIDCrtez)` ne postoji — **ne** proverava da li je dete predak roditelja. Izvor je
SolidWorks PDM (`ParentDocID`), pa se sistem oslanja da CAD daje acikličan graf. Anti-ciklus postoji **samo**
u `ftBOMKolicine`. Ovi bi **visili/pucali** na ciklusu: `spUpdateIDGlavniCrtezZaSklop` (CTE bez guarda, realno
se poziva), VBA `LoadChildren`/`LoadParents` (stack overflow), `ftWhereUsed`.

**2.0 (obavezno):** (a) pri upisu grane — proveriti da `TrebaIDCrtez` nije predak `ZaIDCrtez`, vratiti
domensku grešku; (b) svi rekurzivni čitači `path INT[] + NOT (child = ANY(path))` ili PG14 `CYCLE`; (c)
razmotriti `UNIQUE(ZaIDCrtez, TrebaIDCrtez)`. **Za Negovana:** ciklus = tvrda greška unosa (preporuka) ili
samo prekid eksplozije?

### 2.4 Revizija = string `MAX` (rizik pri ≥10)
`Revizija` je `nvarchar(3)`, `UNIQUE(BrojCrteza,Revizija)`, vrednost iz PDM importa (SolidWorks
`Attr_Revision`). Izbor „najnovije" = leksikografski `MAX(Revizija)` + `<>` poređenje. `'10' < '9'` je
**realan rizik ako se koriste numeričke revizije ≥10**; nema normalizacije/zero-pad/cast.

**2.0:** ne oslanjati se na string `MAX`; uvesti `RevizijaSeq` (int) ili natural-sort; `MAX` po toj koloni.
⚠️ zavisi od domena revizije (slovne A/B/C? jednocifrene? numeričke ≥10?) — **potvrditi format** (medium conf.).

### 2.5 `PotrebnoKomada` INT — bez JM na PDM nivou
Grana `KomponentePDMCrteza` ima 4 kolone, `PotrebnoKomada INT NOT NULL`, **nema JM**. Ni `PDMCrtezi` nema JM
(ima `Kolicina INT`, `Tezina float`, `Nabavka bit`). JM/decimala tek nizvodno (`tRN.JM` default 'Kg', artikli).
→ **2.0:** PDM edge = Integer; Decimal/JM na RN i artikl nivou (backend pravilo „količine Decimal"). Buduća
potreba za m/kg/m² na sastavnici = promena šeme (nova odluka, ne pretpostavljati).

---

## 3. PDM plan nabavke — životni ciklus

**Status-mašina (iz VBA toka):**
```
Form_SpremiPlaniranjeNabavke (dijalog nad izabranim crtežom)
  guard: najnovija revizija + ftBOMNabavniDeloviKolicine vraća >0 redova
  → spPDM_KreirajPlanSaStavkama  (interno: spPDM_KreirajPlanZaglavlje → spPDM_PopuniStavkePlana)
  → UpdatePlaniranjeStavke_SifraArtikla_Zalihe   (auto-link artikala + slobodne zalihe)
  → otvori Form_PlaniranjeNabavke (IDPlan)
Form_PlaniranjeNabavke
  „Definiši potrebne količine"  → spPDM_Planiranje_PopuniRezervisanoINabavku  (podela, idempotentno)
  „Odluke/pred-provera"         → PlanSporneStavke (stavke već ranije planirane)  → ponovo podela
  „Proknjiži"                   → KreirajZahtevZaNabavkuIzPlana + NALMA nalog magacinu + status=Završeno
```
`spPDM_KreirajPlanZaglavlje/PopuniStavkePlana` **nisu mrtav kod** (idu preko orkestratora). Podela
(`spPDM_Planiranje…`) je **idempotentan recompute** — poziva se sa 2 mesta.

**2.0:** jedan `Plan` agregat sa status-mašinom `DRAFT → (auto-link) → RECALC → (odluke) → RECALC →
PROKNJIŽENO`. Kreiranje zaglavlja+stavki u jednoj transakciji; podela kao `POST /plans/:id/recompute`;
sporne stavke = resurs `plan-decisions`.

**Auto-link artikala (write-path van dumpa):** `SifraArtikla`/`Zalihe`/`KataloskiBrojStavke`/`NazivArtiklaStavke`
puni **VBA klijent**, nijedan SP. Lanac: `IDCrtezNabavke → PDMCrtezi.KataloskiBroj → EXT_R_Artikli.[Kataloski
broj] → [Sifra Artikla]`. `Zalihe` = slobodne (stanje−rezervisano), samo ako ≥0 (inače 0). Ručni override po
stavci (kombo u subformi). **Knjiženje blokirano** ako ijedna stavka `Rezervisano>0` nema `SifraArtikla`
(THROW). → **2.0:** `PlanService.autolinkArticles()`; `Zalihe` NE materijalizovati kao 0-default koju puni
klijent — računati slobodno u query-ju/view-u (izbegava stale); guard kao tipizovan exception.

**Broj plana — realan parsing bug:** `BrojPlana = BrojCrteza + ISNULL('-'+Revizija,'') + '/' + redniBroj`
(npr. `PRT-1234-B/3`). Brojač je PO `(IDPredmet, IDCrtezSklopa)` pod `UPDLOCK/HOLDLOCK`. `redniBroj =
MAX(TRY_CAST(SUBSTRING(BrojPlana, CHARINDEX('/')+1, 10) AS INT))+1` — `CHARINDEX` hvata **prvi** `/`. Ako
`BrojCrteza` sadrži `/` (npr. `AB/12`), `TRY_CAST` daje NULL → `MAX(NULL)` → redniBroj uvek 1 → **duplikat
`BrojPlana`**. `UPDLOCK` štiti od trke, ne od ovog. → **2.0:** regex zadnji segment `([0-9]+)$::int` ILI
brojač-tabela `plan_counter FOR UPDATE`; **`UNIQUE(id_predmet, id_crtez_sklopa, redni_broj)`**; čuvati broj
plana i kao strukturisana polja, prikazni string derivirati.

---

## 4. Zalihe/lager — izvor i sinhronizacija

### 4.1 Živa putanja (bitna ispravka [05])
[05 §2.2](05-qbigtehn-sqlserver-logic.md) je rekao „Zalihe iz `RobneStavkeMirror` po `KataloskiBroj`". To je
**mrtva grana**. **Živi izvor:**
```
Zalihe      = BB_StanjeKolicinaNaDan.PlusMinusKolicina
              = Σ(±Kolicina) FROM EXT_T_Robna dokumenta ⋈ EXT_T_Robne stavke
                WHERE Datum<=danas AND Vrsta<>'KODJ' AND Level=0   (SVI magacini, po Sifra artikla)
Rezervisane = BB_RezervisaneKolicine.RezervisanaKolicina
              = Σ(Kolicina) WHERE Ulaz=No AND Rezervisi=True AND Level=250   (po Sifra artikla)
```
Ključ je **`SifraArtikla`** (interna BB šifra), NE `KataloskiBroj`. Lager **stiže iz BigBit-a**
(eksterni robno-materijalni Access `BB_T_25.MDB`); QBigTehn ga samo kešira u `MRP_StanjeArtikala` kroz
`TMP → spMRP_SyncStanjeArtikala (MERGE)`. MERGE **nema** `WHEN NOT MATCHED BY SOURCE DELETE`, a TMP sadrži
samo šifre iz tekućih `MRP_PotrebeStavke` → **stale lager** (stari artikli zadržavaju staru vrednost).

**`RobneStavkeMirror` je napušten/slomljen kod:** puni ga samo `SyncMirrorZaKatBroj` koji se **nigde ne
poziva** i piše po koloni `SessionID` koja **ne postoji** u deployovanoj tabeli (pukao bi „Invalid column
name"). Ceo `RobneStavkeMirror` + `viewZaliheUkupno/Sirovina/Kombinovani` — **ne migrirati**.

**2.0:** `StockSnapshot` servis čita direktno iz robnog (Level=0, exclude 'KODJ', Datum<=danas), keyed po
artiklu; `INSERT … ON CONFLICT (sifra_artikla) DO UPDATE` **pun** refresh (ne parcijalan → nema stale). Pošto
je BigBit sync privremen ([[qbigtehn-sync-privremen-bigbit-trajan]]), do cutover-a stanje kroz overlay BB
matičnih; posle cutover-a robno prelazi u ServoSync. ⚠️ **Za Negovana:** BB magic-nivoi (`Level=0` stanje,
`Level=250` rezervacija, `Vrsta='KODJ'` izuzeto) su BigBit konvencije — potvrditi/dokumentovati.

### 4.2 Magacin
`Magacini` šifarnik postoji (`VrstaMag nvarchar(5)`), ali **ID→tip (gotova roba/poluproizvod/sirovina) NIJE
u kodu**. Jedina tvrdnja „`IDMagacin=2` = Sirovine (Repro)" je u **mrtvom** `viewZaliheSirovina`. Živa MRP
putanja **ne filtrira magacin** (zbir svih). → **2.0:** `Skladiste.tip` enum (`GOTOVA_ROBA|POLUPROIZVOD|
SIROVINA`); ne hardkodovati ID 2; razdvajanje po magacinu = **nova funkcionalnost**. ✅ **Za Negovana:** koji
ID je koji tip (mapiranje `VrstaMag`).

### 4.3 Lead time / datum nabavke
`VremeIsporukeDana` po stavci iz BigBit `EXT_DobavljaciZaArtikal` (**primarni dobavljač**, `ORDER BY Primarni
DESC`), global CFG fallback. `DatumNabavke` = **computed** `dateadd(day, -VremeIsporukeDana, DatumPotrebe)`.
→ **2.0:** lead time na relaciji `ArtikalDobavljac` (flag primarni); `datum_nabavke` generated/izvedeno;
snapshot vrednosti na stavci u trenutku planiranja (istorijski).

---

## 5. Tehnološki postupak — write-path i „završeno" (ispravke speca)

### 5.1 ⚠️ ISPRAVKA: barkod format (u [MODULE_SPEC_tehnologija §3.1](../design/MODULE_SPEC_tehnologija.md) je POGREŠAN)
Nije **jedan** barkod `PredmetID:IdentBroj:Varijanta:Operacija:RJgrupaRC`. To je **stari test-kod** (mrtav).
Stvarno su **DVA** barkoda, svaki 5 polja (4 separatora `:`):
```
Nalog:     RNZ : IDPredmet : IdentBroj : Varijanta : PrnTimer
Operacija: S   : Operacija  : RJgrupaRC : Toznaka   : PrnTimer
```
`PrnTimer` je **vezni ključ** — operacioni barkod mora imati isti `PrnTimer` kao nalog. Validacija:
`BrojSeparatora=4 AND (Left(bc,3)='RNZ' OR Left(bc,1)='S')`. → **Ažurirati spec.**

### 5.2 Write-path prijave rada (van dumpa)
Nije SQL nego **snimanje vezane Access forme** (`BarKod_Unos`→`tTehPostupak`, `DoCmd.RunCommand
acCmdSaveRecord`). Zato dump nema INSERT. Tok: (1) start red `Komada=0, ZavrsenPostupak=0` (default
`DatumIVremeUnosa=Now()`), (2) `IDRN` se puni **post-hoc** UPDATE-om (lookup iz `tRN` po trojci — zato nema
FK), (3) na zatvaranju `OznaciDaJeZavrsenPostupak`: 3× UpdateColumn (`Komada`, `DatumIVremeZavrsetka=Now()`,
`ZavrsenPostupak=1`, + `IDVrstaKvaliteta` 1/2), `tStavkeRN.Prioritet=255`, i (ako premaši) **DELETE** upravo
ubačenog reda. Dorada/škart: `DefinisiOperacije…` DAO bulk `AddNew` skeleton redova + `INSERT T_Planer`
(poruka tehnologu). **Ništa od ovoga nije u jednoj transakciji** — pad ostavlja parcijalno stanje.

→ **2.0:** `prijaviRad` (INSERT start: `komada=0`, `workOrderId` razrešen odmah kroz JOIN, ne post-hoc) i
`zatvoriOperaciju` (UPDATE) — **svaki u jednoj transakciji**; dorada/škart + poruka u istoj transakciji;
DB check da `komada` ne prekorači planirano. Model start/stop = `DatumIVremeUnosa`/`DatumIVremeZavrsetka`.

### 5.3 „Završen RN" — tri definicije, jedna operativna istina
Sve tri žive u **različitim** izveštajima:
- **najnovije** `ZavrsenoKomada>=KomadaPlanirano` (samo `ZnacajneOperacijeZaZavrsen=1`) → `spStatusSklopovaPoOperacijama`;
- **novo** `Značajne=1 AND PreskocivaOperacija=0` → `spRNPregledUStatusuProizvodnje`, `ftStatusSklopova_Baza`;
- **staro** `Razlika = Komada − Napravljeno = 0` → detaljni izveštaji.

**Operativna istina** (šta okine `tRN.StatusRN=1` u write-path-u `PotrebnaPromenaStatusaRNUZavrsen`) =
**najnovije** (napravljeno≥planirano na značajnoj operaciji). → **2.0:** usvojiti **jednu** kanonsku =
najnovija; materijalizovati `isCompleted` (polje/view); write-path i svi izveštaji dele istu funkciju.

### 5.4 `NapravljenoKomada` i dorada/škart
Obe funkcije **uključuju** doradu/škart (nijedna ne filtrira `IDVrstaKvaliteta`; dorada/škart redovi imaju
`Komada>0`). Razlika: `ftNapravljenoKomadaPoTehPostupku` (sve, i započete) vs `fsBrojNapravljenihKomadaZaRN`
(`HAVING ZavrsenPostupak=1`). `fs` ima **bug** (`GROUP BY … + SELECT @Result=SUM` vraća samo poslednju grupu
za `@ZaOperacija NULL`). → **2.0:** razdvojiti **tri metrike po kvalitetu** (`DOBAR/DORADA/ŠKART`); za
pokriće plana brojati **samo `DOBAR`** (kvalitet=0); ne replicirati `fs` bug (koristiti `SUM … WHERE`).

### 5.5 23h auto-close i predmet 4521
- **23h auto-close:** **nema traga u kodu** (samo `AutoKeys`/`Autoexec`; nijedan Form_Timer/SQL Agent job).
  Pravilo je isključivo iz [uputstva](11-bb-tehnologija-uputstvo.md). → **2.0:** tretirati kao **nov zahtev**
  (`@nestjs/schedule` cron u 23:00). ✅ **Za Negovana:** da li se `komada` tada postavlja (0/planirano/ostaje)
  i da li auto-zatvoreni ulaze u KPI (verovatno flag „auto-closed" da ne kvari metrike).
- **`IDPredmet<>4521`:** jedina pojava u celom SQL-u, nijednom u VBA — namerno izuzet iz dorada/škart toka
  (uz sentinel 0) u `ftZavrseniPostupciPreDoradeIliSkarta` (autor Negovan, 28-06-2024). Verovatno servisni/
  generički/„bez crteža" predmet. → **2.0:** flag `excludeFromReworkScrap`, ne magic ID. ✅ **Za Negovana:**
  `SELECT * FROM predmeti WHERE id=4521` na živoj bazi — migrirati semantiku, ne broj.

---

## 6. Šta OSTAJE za Negovana (skraćeno — 5 tačaka)

Posle ove analize, od ~40 „POTVRDITI" ostaje **samo ono što kod ne može da kaže** (poslovna/podatkovna
semantika, ne logika):

1. **Magacin ID→tip** — koji `IDMagacin`/`VrstaMag` je gotova roba / poluproizvod / sirovina.
2. **Ciklus-politika** — da li ciklus u sastavnici tretirati kao **tvrdu grešku unosa** (preporuka) ili samo
   prekinuti eksploziju. (Kod danas nema zaštitu — 2.0 je uvodi, treba samo potvrda ponašanja.)
3. **23h auto-close semantika** — vrednost `komada` pri auto-zatvaranju + da li ide u KPI (flag).
4. **Predmet 4521** — šta je (i da li je 0 takođe sentinel) → migrirati u `excludeFromReworkScrap`.
5. **BB robne konvencije + revizija domen** — `Level 0/250`, `Vrsta='KODJ'` potvrditi; format `Revizija`
   (slovna/numerička ≥10) radi ispravnog „najnovije".

Sve ostalo (formule podele, mapiranje artikla, ciklus-guard mesta, broj-plana fix, barkod format, write-path,
definicija „završeno", stale lager, mrtvi podsistemi) — **odlučeno iz koda, ne čeka Negovana.**

---

## 7. Mrtav kod / bugove NE migrirati (spisak)

| Stavka | Dokaz | Akcija |
|---|---|---|
| `RobneStavkeMirror` + `viewZalihe*` | `SyncMirrorZaKatBroj` se ne poziva, piše nepostojeći `SessionID` | ne migrirati |
| `spMRP_KreirajIRealizujPlan` INSERT zaglavlja | zakomentarisan, zamenjen `spPDM_KreirajPlanZaglavlje` | mrtav |
| `NOT EXISTS` dedupe u `MRP_PotrebeStavke` INSERT | zakomentarisan, ali poruka „preskočeno duplikati" ostala | implementirati pravi dedupe |
| `PrimeniOdlukePlaniranje` (batch) | dugme koristi `_RowByRow` verziju | batch verovatno mrtva |
| `ftWhereUsedUnified` | komentar ga pominje, kod zove `ftWhereUsed` | proveriti/obrisati |
| `OZNAČI KAO REALIZOVANO` (`ZaNabavku=0`) | zakomentarisan → posle knjiženja `ZaNabavku` ostaje >0 | u 2.0 poništiti potrebu |
| Stari jednobarkodni test (`FTestF`, `DesifrujBarKod_TEST`) | mrtav test-kod | ignorisati |
| Veliki zakomentarisani blokovi u `Form_BarKod_Unos` | refaktorisano 04-07-2024 | ne migrirati |
| `RAISERROR+RETURN` mrtav `RETURN` | nedostižan posle CATCH | ne portovati idiom |

⚠️ **Proveriti pre migracije (medium conf.):** VBA zove `spPDM_KreirajPlanSaStavkama` sa parametrom
`@Korisnik`, a `.sql` skripta tog SP-a **nema** taj parametar → deployovana procedura je verovatno novija od
dumpa. Potvrditi stvarni potpis na živoj bazi.
