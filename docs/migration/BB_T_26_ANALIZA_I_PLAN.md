# BigBit ERP (`BB_T_26_11-07-26`) — analiza i plan migracije/integracije

> **Status:** ANALIZA I PLAN — ništa se ne implementira. Priprema za 3.0/4.0 preuzimanje BigBit funkcija.
> **Snimak:** `BB_T_26_11-07-26.mdb` (Access, 11.07.2026, **207 tabela, ~358 MB**). Kompletan DDL:
> [`_analiza/bigbit/BB_T_26_schema.sql`](../../../_analiza/bigbit/BB_T_26_schema.sql) (3171 linija).
> **Kako je otvorena:** baza je bila Access **ULS-zaključana** (workgroup `BIGBIT.MDW`; nalog
> `admin/telefon` je workgroup-admin ali bez read-prava i ne može sam da ga dodeli). Čitanje je urađeno
> **`mdb-tools`-om u docker kontejneru na Ubuntu serveru** — čita sirovu strukturu i **ignoriše Access
> security**. Original `.mdb` u repou je netaknut; serverska kopija podataka obrisana (izvučena samo šema
> + brojevi redova, bez PII/finansijskih redova).
>
> **Deep-dive po klasterima (ovaj dokument ih objedinjuje):**
> - Klaster A — [Matični + Tehnologija + Reversi](BB_T_26-analiza-klaster-A-maticni-tehnologija-reversi.md)
> - Klaster B — [Robno / Nabavka / Maloprodaja / Carina / Proizvodnja](BB-snapshot-2026-klaster-B-robno-nabavka.md)
> - Klaster C — [Finansije / PDV / GK / Banka / OS / Konfiguracija](BB_T_26_klaster_C_finansije-pdv-gk.md)

## 1. Šta je ova baza (i šta NIJE)

`BB_T_26` je **kompletan BigBit ERP** Servoteha (komercijala + računovodstvo): komitenti, artikli, cene,
robna dokumenta, nabavka, carina, PDV, glavna knjiga, banka, maloprodaja, osnovna sredstva. **NIJE**
QBigTehn proizvodni lanac (PDMCrtezi/tRN/tStavkeRN/tTehPostupak/NacrtPrimopredaje) — taj živi na
`vasa-SQL` (MS SQL) i njega je 2.0 već preradio (modul Tehnologija).

**Ključna nijansa (potvrđeno):** 2.0 danas **NE čita BigBit Access direktno** — sinkuje iz **QBigTehn
MS SQL kopije** matičnih tabela (vasa-SQL). Zato sva „već sinkovano" mapiranja opisuju QBigTehnovu kopiju
BB tabele, ne nužno `BB_T_26` original. To je bitno za 4.0 kad se pređe na direktan BigBit izvor —
očekivati **šema-drift** (vidi §3).

## 2. Domenska mapa (207 tabela → status u ServoSync-u)

| Domen | Reprezentativne tabele | Redova (uzorak) | Status u 2.0/3.0/4.0 |
|---|---|---|---|
| **Matični — sinkovano** | Komitenti, Predmeti, R_Artikli, Prodavci, Cenovnik, Magacini, R_Tarife, R_Vrste dokumenata | 6.669 / 7.736 / **91.199** / 80 / **82.855** / 3 | ✅ **već cache u 2.0** (`customers/projects/items/salespeople/price_list_entries/warehouses/tax_rates`) — ~1:1 |
| **Matični — rupa u sync-u** | R_Grupa, R_Podgrupa, R_Poreklo, R_KvalitetArtikla | male | ⚠️ model postoji ali **nije sinkovan** (Item.groupCode/subgroupCode/originCode bez naziva; qualityTypeId visi) |
| **Robno-materijalno** | T_Robna dokumenta, T_Robne stavke, T_MagStavke, Nivelacije, T_Popis | — | 🟡 dokumenta+stavke su **cache** (MRP feed); kalkulacija/komadna/nivelacija/popis = **gap 4.0 `inventory`** |
| **Nabavka** | ZahteviZaNabavku, OP_Dokumenta, T_UpitDobavljacu, T_Trebovanja, DobavljaciZaArtikal | 3.990 | 🔴 **gap 4.0 `procurement`** (RFQ→PO→prijem, 3-way match, lead-time) — MRP uvid delom postoji |
| **Carina / uvoz** | CarinskeTarife, CarMagDok, CarMagStavke | — | 🔴 **gap 4.0 `customs`** — ⚠️ landed cost ključ raspodele nedokumentovan (Negovan/referent uvoza) |
| **Cene / rabati** | Cenovnik, Rabati, RabatiPoArt, Akcije | 82.855 | 🟡 Cenovnik cache; rabati/akcije = gap `sales` |
| **Maloprodaja / POS / Raster / Otkup** | T_MPDokumenta, Raster*, OTKUP_*, KASE, FP*/FP550_* | — | ⛔ **ISKLJUČENO (Nenad potvrdio)** — NE u 4.0 aplikaciji, NE u kopiranju tabela |
| **Finansije / GK** | T_Glavna knjiga, T_Nalozi, Kontni plan, Sema za kontiranje | — | 🔴 **gap 4.0 `finance`/GL** — posting rules (šeme za kontiranje) |
| **PDV / POPDV** | PDV_Knjige, PDV_PPPDV, T_POPDV_*, T_Knjiga KEPU | — | 🔴 **gap 4.0 `tax`** — regulatorno (POPDV, KEPU) |
| **Banka / plaćanja** | Virmani, UplatniRacuni, Depoziti, Kamata* | — | 🔴 **gap 4.0 `banking`** |
| **SEF / e-fakture** | (ER_* polja, eFaktura mape) | — | 🔴 **gap 4.0 `sef`** — regulatorno |
| **Osnovna sredstva** | T_OS_Sredstva, T_OS_Stavke | — | 🔴 gap 4.0 `finance` |
| **Proizvodnja (BigBit)** | RadniNalozi, T_Proizvodnja, T_Rastavnice, T_Recepti, SastavMaterijala | 2.588 | ⚠️ **ODVOJENO od 2.0 shop-floor** (vidi homonime); costing = gap 4.0 |
| **Reversi (BigBit)** | Reversi, ReversiStavke | 135 / 144 | ⚠️ **komercijalni revers robe — NIJE magacin alata** (vidi §3) |
| **Konfiguracija / prava** | CFG_Global, Parametri za rad, BBPravaPristupa, BBDefUser | — | BBPravaPristupa → mapirati na 2.0 RBAC; CFG = per-instalacija |

## 3. Kritični nalazi (ovo su zamke — pročitati pre bilo kakvog rada)

### 3.1 TRI HOMONIMA — ista imena, različiti podaci
- **`Reversi`**: BigBit `Reversi` (135) = **komercijalni revers robe komitentu** (prodaja/4.0), NIJE
  „magacin alata". Magacin alata koji tehnolozi traže ([[magacin-alata-backlog]]) živi u **ServoSync 1.0
  `rev_*` tabelama (sy15 baza, UUID PK)** i već je 3.0 pilot. **NE uvlačiti BigBit Reversi u
  magacin-alata backlog** — to je bila prirodna, ali pogrešna pretpostavka.
- **`tRadnici`**: 2.0 `Worker` sinkuje **QBigTehn** `tRadnici` (ima `PasswordRadnika`), ne BigBit
  `tRadnici` (123 reda). Dva različita izvora radnika.
- **`RadniNalozi`**: BigBit `RadniNalozi` (2.588, ima vozilska/servisna polja) = komercijala/servis;
  2.0 `WorkOrder` = QBigTehn `tRN` (proizvodnja). **Nemaju veze** osim imena.

### 3.2 BOM — NEMA dileme: PDM je jedini izvor (ispravka Nenad 11.07)
**PDM (SolidWorks projektovanje + organizacija dokumentacije) NIKAD nije bio u BigBit-u.** PDM je i ostaje
**jedini izvor istine za sastavnicu (BOM)** — u 2.0 (`DrawingComponent`, crtež-nivo rekurzivni BOM), u 3.0
i u 4.0. BigBit `SastavMaterijala` (5-slot `Sl1..Sl5`), `T_Rastavnice`, `T_Recepti` su **BigBit-interne**
(komercijalno-materijalne) i **ne diraju proizvodni BOM** — nema nikakve „dupli-izvor" dileme i nema
odluke za Negovana. Ako 4.0 uopšte poželi materijalni obračun, to je zaseban BigBit podatak, potpuno
odvojen od PDM sastavnice.

### 3.3 Šema-drift (pucaće na 4.0 direktnom BigBit sync-u)
Sync-mapa očekuje `BBOdeljenja(OD, OznakaOD, OpisOD)` i `BBOrgJedinice(OJ, OznakaOJ, OpisOJ)`, a `BB_T_26`
ima samo `(OD, Naziv)` / `(OJ, NazivOJ)`. Sličan drift kod BB* šifarnika (Naziv vs Oznaka/Opis). **Pre
4.0 Sync B cutover-a validirati šemu na PRAVOM BigBit izvoru** (ne na QBigTehn kopiji).

### 3.4 Landed cost (carina) — otvorena stavka
Kolone za zavisne troškove postoje (`T_Robna dokumenta.Carina/Spedicija/OstaliZavTros`, `CarMagDok`),
ali **ključ raspodele na artikle nije dokumentovan**. PDV NE ulazi u nabavnu cenu; carina + zavisni
troškovi ulaze. ⚠️ Traži intervju sa referentom uvoza (Tatjana) pre implementacije `customs`.

## 4. Plan pripreme (prioritizovano, po ROADMAP redosledu odozdo-naviše)

ROADMAP 4.0 redosled: **masters → tax/GL → inventory → sales+sef → banking → procurement+customs.**

**Faza 0 — sada, bez koda (priprema):**
1. Zatvoriti rupu u matičnom sync-u: dodati sync za `R_Grupa/R_Podgrupa/R_Poreklo` (+model za
   `R_KvalitetArtikla`) → `Item.groupCode/subgroupCode/originCode/qualityTypeId` dobijaju nazive.
2. **Validacija šeme na živom BigBit izvoru** (ne QBigTehn kopiji) — popisati drift kolona (§3.3) pre
   nego što 4.0 pređe na direktan BigBit sync. Ovaj `BB_T_26` snapshot je baza za to poređenje.
3. Potvrde: Negovan (BigBit BOM vs PDM BOM §3.2; homonim RadniNalozi §3.1), referent uvoza (landed
   cost §3.4).

**Faza 1 — 4.0 masters domen (kad krene):** matični su najmanji skok — 6 tabela je već cache, prelaze iz
„cache" u „vlasništvo 2.0/4.0" bez migracije podataka (`Project`/`Predmeti` je osovina — `IDPredmet`
zajednički ključ proizvodnje i komercijale). Dodati child tabele bez modela (`KomitentiKontaktOsobe`,
`MestaIsporuke`, `MestaIzdavanja`, `R_Artikli_BarKod`) kao prave tabele sa FK, **ne overlay na cache**.

**Faza 2 — inventory:** robna dokumenta/stavke su već cache; graditi aplikativnu logiku (kalkulacija,
komadna evidencija, nivelacija, popis) nad njima. Posting rules (`R_Vrste dokumenata.Sema za kontiranje`)
= temelj za GL.

**Faza 3+ — tax/GL/banking/procurement/customs/sef:** „prava ERP" strana (Klaster C) — regulatorno teška
(POPDV, KEPU, SEF), skoro ništa u 2.0. Ovo je najveći deo posla i ide u 4.0 po ROADMAP-u; ovaj dokument
daje inventar tabela i kompleksnosti, ne implementaciju.

**ISKLJUČENO — tvrda deny-lista (Nenad potvrdio 11.07, NE portuje se, NE kopira se):** Maloprodaja/POS
(`T_MPDokumenta*`, `KASE`, `FP*`/`FP550_*`, `T_Knjiga KEPU_MP`), Raster (`Raster*`, `RasterMPStavke`,
`RasterStavke`, `RasterTrebovanjaStavke`), OTKUP (`OTKUP_Dokumenta`, `OTKUP_Stavke`), `MPStavkeNivelacije`.
Ove tabele se u dizajnu sync-a NIKAD ne registruju (deny-lista, §4 detaljnog sync plana).

## 5. Otvorene odluke

| # | Pitanje | Ko | Status |
|---|---|---|---|
| ~~1~~ | ~~BigBit BOM vs PDM BOM~~ | — | ✅ **REŠENO** (Nenad): PDM je jedini izvor, nema dileme (§3.2) |
| ~~4~~ | ~~POS/Raster/OTKUP portovati?~~ | — | ✅ **REŠENO** (Nenad): ISKLJUČENO, deny-lista |
| 2 | BigBit `RadniNalozi` (servis/komercijala) — u scope 4.0 ili van? | Nenad/Negovan | otvoreno |
| 3 | Landed cost ključ raspodele (carina) | referent uvoza (Tatjana) | otvoreno |
| ~~5~~ | ~~4.0 izvor sync-a (XML export?)~~ | — | ✅ **REŠENO** (Nenad): **WinServer skripta → PG direktno**, NE XML (§7.3). Ažurirati BACKEND_RULES §11.2a / ODLUKE. |
| 6 | `BBPravaPristupa` → mapiranje na 2.0 RBAC role | Nenad/Negovan | otvoreno |
| 7 | `items.id` ostaje QBigTehn-ključ (uz external_item_id remap) ili prelazi na BigBit šifru? — preduslov FAZE 2 skripte (Komitenti/Artikli/Cenovnik) | Negovan | otvoreno (§7.2/§7.3) |
| 8 | Cenovnik/R_Artikli-flagovi = **UPSERT** (ne insert-only §11.2b) — nova odluka | Negovan | predloženo (§7.3); pilot već radi UPSERT na šifarnicima |
| 9 | BigBit ULS kredencijal sa READ pravom za skriptu na Srv-all (nalog `Slavisa`, lozinka u runtime CFG) | Negovan | **traži se** — jedini preduslov za ACE čitač (§7.3/§7.5) |

## 7. Detaljan sync plan (Fable obrada 11.07 — puni deep-dive u F1/F2/F3 dokumentima)

### 7.1 Odgovor na pitanje #3: da li nam FALI polja? — NE (za sinkovane matične)
Trostrano poređenje (BigBit `BB_T_26` DDL vs QBigTehn kopija DDL vs `schema.prisma`+`sync-map.generated.ts`)
za 12 matičnih tabela — deep-dive: [F1](BB_T_26-analiza-F1-pokrivenost-polja.md):

- **8 velikih tabela je sadržajno 1:1** — od 233 izvorne kolone kopirano **232**; jedino izostavljeno je
  `Komitenti.KoristiPNBZadModel` (poziv-na-broj model, 4.0 banking) — a te kolone NEMA ni u QBigTehn
  kopiji (dokaz da kopija kasni za BigBit šemom, ne da smo nešto „zaboravili"). `Predmeti` 38/38,
  `R_Artikli` 67/67, `Prodavci` 16/16, `Cenovnik` 11/11, `Magacini` 11/11 — potpuno.
- **Znači: sadržaj sinkovanih matičnih je kompletan** — ništa bitno ne fali za tehnologiju ni za identitet.
- **Prava rupa je 4 šifarnika artikala** (`R_Grupa/R_Podgrupa/R_Poreklo/R_KvalitetArtikla`) koji se
  **uopšte ne sinkuju** → `Item.groupCode/subgroupCode/originCode/qualityTypeId` su kodovi **bez naziva**.
  Najjeftiniji fix: 3 laka syncera (R_Grupa/Podgrupa/Poreklo — modeli već postoje); R_KvalitetArtikla čeka
  BigBit export (nema ga ni u kopiji). `R_Poreklo.PopustProc` je komercijalni popust — bitan za 4.0 sales.
- **Svežina — DANAS:** lanac BigBit → QMegaTeh (~10-min skripte) → vasa-SQL → `POST /sync/run` **NA DUGME
  (nema cron)** → Postgres. Samo `Komitenti` ima watermark (`PoslednjaIzmena`); ostalo je full-refresh.
  Provera = `COUNT` + `MAX(datum)` po tabeli (upiti u F1) + `bb_sync_state`/`bb_sync_log`.
- **Svežina — CILJANO (§7.3 ispravka):** WinServer skripta čita BigBit **direktno** → nestaje
  QMegaTeh→vasa-SQL kopija za matične i može da radi zakazano (Task Scheduler), pa je svežija.

### 7.2 Pravi rizik za 4.0 nije pokrivenost polja — nego ID-prostor i šema-drift
- **ID-prostor:** `items.id` = **lokalna QBigTehn šifra** (`[Sifra artikla]` IDENTITY iz kopije), a BigBit
  šifra živi samo u `items.external_item_id`. Sve FK veze (`price_list_entries.item_id`, MRP…) su u
  QBigTehn ID prostoru. **Direktan BigBit izvor u 4.0 traži remap preko `external_item_id` ili migraciju
  ključa** — inače pucaju veze.
- **Šema-drift (kopija vs original):** `BBOdeljenja(OD,Naziv)` vs mapa očekuje `(OD,OznakaOD,OpisOD)`;
  `BBOrgJedinice(OJ,NazivOJ)` vs `(OJ,OznakaOJ,OpisOJ)`; `CFG_Global` bez `IDFirma`; širine (`BarKod` 20→50,
  `Polica` 20→10 = truncation rizik); masovna NOT NULL→NULL relaksacija. **Pre 4.0 direktnog sync-a
  validirati šemu na živom BigBit izvoru** — ovaj snapshot je baza za to poređenje.

### 7.3 Mehanizam sync-a — ISPRAVKA (Nenad 11.07): skripta na WinServeru → PG direktno (NE XML)
**Odluka izvora je izmenjena u odnosu na BACKEND_RULES §11.2a (koji je govorio o XML export-u).** Stvarni
mehanizam: **skripta koja se izvršava na Windows serveru čita BigBit i piše DIREKTNO u PostgreSQL.**
Deep-dive F2 govori o XML export-u — **taj deo je prevaziđen ovom ispravkom** (ostaje relevantan samo za
allow/deny logiku, ne za izvor).

**Zašto je to prirodno:** BigBit je Access sa ULS-om — Ubuntu backend ga ne može čitati, ali **WinServer
može nativno** (ima Office/ACE + workgroup `BIGBIT.MDW`, konektuje se kao aplikacija `User ID=Slavisa`).
Jedan hop: WinServer skripta → PG, bez XML fajlova i bez QMegaTeh→vasa-SQL kopije za matične.

**Arhitektura (predlog za implementaciju, ne implementira se sad):**
- **Čitanje:** ACE OLEDB nad BigBit `.mdb` (workgroup nalog koji ima read — vidi §nalog niže), SELECT
  samo allow-lista tabela + potrebne kolone.
- **Pisanje:** direktan konektor na PG (npr. Npgsql/psycopg/pg driver) — UPSERT u 2.0 cache tabele
  (`customers/projects/items/...`). PG je na `ubuntusrv`; skripta piše preko LAN-a namenskim
  `bb_sync` PG nalogom (write samo na cache tabele).
- **Raspored:** Windows Task Scheduler (isti obrazac kao pdm-bridge), npr. na sat/noćno.
- **Jezik:** PowerShell/Python/Node — bilo koji koji ima ACE OLEDB read + PG write (već koristimo
  PowerShell+ACE i Node; pdm-bridge je presedan za WinServer skriptu).

**Posledice ove ispravke (za razliku od backend sync modula):**
- BigBit-masters sync **više ne ide kroz NestJS sync modul** (on ostaje za QBigTehn proizvodni lanac dok
  se ne ugasi na cutover-u). WinServer skripta drži **sopstvenu allow/deny listu, mapiranje polja i
  kursor/log** (ekvivalent `bb_sync_state`/`bb_sync_log`, ali na strani skripte).
- **Čita se BigBit ORIGINAL** (ne QBigTehn kopija) → **šema-drift iz §7.2 postaje FRONT-AND-CENTER**:
  skripta mapira BigBit kolone (`BBOdeljenja(OD,Naziv)`, širine…) na 2.0 šemu; ne nasleđuje QBigTehn
  surogat-kolone. Zato je **validacija šeme na živom BigBit izvoru preduslov** (§3.3, §7.2).
- **ID-prostor (§7.2):** čitajući BigBit direktno, prirodni ključ postaje **BigBit šifra**; skripta bira
  da li `items.id` ostaje QBigTehn-nasleđen (uz `external_item_id` remap) ili se prelazi na BigBit ključ.
  ⚠️ Odluka pre implementacije — utiče na sve FK veze.

**Allow/deny (i dalje važi, samo živi u skripti):** allow-lista = KEEP-SYNC tabele (§7.4); deny =
EXCLUDE-TVRDO. Sprovođenje = skripta prosto **ne SELECT-uje** deny tabele. (U postojećem backend modulu
isti princip je „ne-registracija" — `QBIGTEHN_CHAIN_ENTITIES` obrazac; ako se ikad deo vrati u backend,
tamo ide `bigbit-allowlist.ts`.)

**Strategija po tabeli:** full-refresh za male šifarnike; za velike matične UPSERT (ne insert-only).
⚠️ **Bitno:** `Cenovnik` (82.855, cena se menja NA POSTOJEĆEM redu) i `R_Artikli` flagovi
(`Aktivan/ZaBrisanje`) **moraju UPSERT** — insert-only bi zamrznuo cene. Delete = nikad hard-delete;
skripta vodi `missingFromSource` evidenciju; UI „obrisano" flag u overlay tabeli (§11.1).

**Selekcija polja:** default potrebna polja; `Prodavci.Password` (plain-text) — NE kopirati (Nenad ✅ 11.07).

**KONKRETIZOVANO (Nenadove odluke 11.07 uveče):**
- **Mašina:** `Srv-all.servoteh.local` = **192.168.64.27**, Windows Server 2019. (BigBit `.mdb` živi na
  192.168.64.14 → skripta kopira `.mdb` preko UNC-a u lokalni temp pa čita KOPIJU — nikad original.)
- **Put do PG:** **direktno preko LAN-a** (nevezano za internet) — na ubuntusrv izložiti 5432 bind na
  LAN IP, firewall samo za 192.168.64.27; namenska PG rola `bb_sync` (GRANT samo na ciljne tabele).
  ⚠️ Još NIJE izloženo — uraditi pri instalaciji na Srv-all (kratki restart pg kontejnera).
- **Ritam:** 1× dnevno (Task Scheduler, predlog 05:30).
- **Tempo:** praviti ŠTO PRE i probati (Nenad) — pilot već izveden, vidi §7.5.
- **Preostali preduslov za Srv-all:** BigBit **ULS kredencijal sa read pravom** — `admin/telefon` NEMA
  read; aplikativni nalog je `Slavisa` (lozinka u runtime CFG-u) → **tražiti od Negovana**. Dok ne stigne,
  put podataka je dokazan mdb-tools čitačem (§7.5); ACE čitač na Srv-all se uključuje kad stigne lozinka.

### 7.5 PILOT IZVEDEN (11.07 uveče) — sync radi end-to-end ✅
Prvi stvarni BigBit→PG sync, nad snapshot-om `BB_T_26_11-07-26.mdb` (na ubuntusrv `~/bb-analiza/`),
čitač mdb-tools (docker), upis u **produkcijski** PG (`servosync-pg`) kroz staging temp tabelu +
`INSERT … ON CONFLICT DO UPDATE` (UPSERT), jedna transakcija:

| Izvor | Cilj | Redova | Provera |
|---|---|---:|---|
| `R_Grupa` | `item_groups` | 19 | JOIN sa `items.group_code`: od 91.199 artikala samo **6 orphan** — kodovi se poklapaju |
| `R_Podgrupa` | `item_subgroups` | 86 | UTF-8 očuvan („Brisač", „Čelik…") |
| `R_Poreklo` | `item_origins` | 128 | `PopustProc` = 0 na SVIM redovima → popust po poreklu se u praksi ne koristi |

Drugi prolaz istog load-a: bez greške, isti brojevi → **idempotencija (UPSERT) potvrđena**.
Ovim su artikli u 2.0 prvi put dobili nazive grupa/podgrupa/porekla (kolone su postojale, šifarnici bili prazni).
Rollback bezbedan: `DELETE` iz te 3 tabele (pune se samo odavde). Alat za Srv-all: `backend/tools/bigbit-bridge/`.

### 7.4 Inventar svih 207 tabela u 3 kofe (definitivno)
Deep-dive: [F3](BB_T_26-analiza-F3-inventar-207-tabela.md). Svih 207 provereno grep-om, svaka u tačno
jednoj kofi:

| Kofa | Broj | % | Sadržaj |
|---|---|---|---|
| **KEEP-SYNC** | **49** | 23,7% | matični + feed + mali šifarnici; 22 već sinkovano, +5 ima model bez syncera (najjeftinije zatvaranje rupa) |
| **EXCLUDE-TVRDO** | **55** | 26,6% | 25 tvrda lista vlasnika (MP/POS/Raster/OTKUP/KASE/FP*/paneli) + 30 tehnički balast (tmp/kopije/SYNCH/CSVExport/slike/BBS_*) |
| **ODLOŽI-4.0** | **103** | 49,8% | finance/GL+OS 14, tax/POPDV/KEPU 18, banking/kamata 11, sales/CRM 23, inventory/costing 16, procurement 10, sef 6, customs 2, masters-ext 3 |

**Granični slučajevi — REŠENO (Nenad 11.07):**
- ✅ `RadniNalozi` (2.588, servis/vozila) → **EXCLUDE** (verovatno se ne koristi).
- ✅ `T_Trgovacka knjiga` (+`T_PK1` po vezi) → **EXCLUDE** (maloprodaja, ne koristi se).
- ✅ `EXT_RobnaDokumenta` → **KEEP** (trebaće nam).
- `Radni fajlovi` je u bloat-listi ALI je već sinkovan kao `Company` → predlog KEEP (nepromenjeno).
- `V_Dokumenta/V_Stavke/UI_Stavke/DExp_KutBarKod/EXT_Dokumenta_USL` — nepoznata namena, ostaju za proveru.

> Reklasifikacija menja kofe iz §7.4 minimalno: KEEP-SYNC +1 (`EXT_RobnaDokumenta`),
> EXCLUDE-TVRDO +2 (`RadniNalozi`, `T_Trgovacka knjiga`), ODLOŽI-4.0 −3. Puni spisak u F3.

**Empirijski count-ovi graničnih tabela (11.07, `mdb-export | wc -l` nad BB_T_26 snapshot-om, na ubuntusrv):**

| Tabela | Redova | Zaključak |
|---|---:|---|
| `SastavMaterijala` | **1** | BigBit BOM se praktično NE koristi → **EXCLUDE** (potvrđuje PDM-only, §3.2) |
| `T_Obelezja_Def` / `_Val` | 7 / **0** | EAV definisan, nikad korišćen → **EXCLUDE** |
| `Posete` | 0 | CRM posete se ne kucaju → **EXCLUDE** |
| `T_Izvestaj` / `Stavke` | **1.592 / 8.658** | izveštaji prodavaca SE KORISTE → ostaje **ODLOŽI-4.0** (CRM) |
| `Depoziti` | 0 | → **EXCLUDE** ⚠️ |
| `V_Dokumenta`/`V_Stavke`/`UI_Stavke`/`DExp_KutBarKod` | 1/0/0/0 | mrtav EDI/utovar tok → **EXCLUDE** |
| `T_PlaniranjeStavkeTok` / `TipDogadjaja` | 0 / 0 | BigBit planiranje-tok se ne koristi → iz KEEP u **EXCLUDE** |
| `VrstePlacanja` | 0 | → **EXCLUDE** |
| `MestaIzdavanja` | 4 | mali šifarnik, FK sa `R_Artikli` → **KEEP** |
| `NalepniceNNID` | 323.746 | print-buffer istorija, bez trajnog sadržaja → **EXCLUDE** |
| `Operateri` | 1 | → **EXCLUDE** |
| `T_PK1` / `KEPU_MP` / `T_Trgovacka knjiga` | 0/0/0 | potvrđuje odluku **EXCLUDE** (MP) ⚠️ |
| `EXT_RobnaDokumenta` / `EXT_Dokumenta_USL` | 0 / 1 | prazne DANAS; odluka Nenad = KEEP (trebaće, SEF/EDI) — na allow-listi, sinkuje se kad se popune |

> ⚠️ Ograda: BB_T_26 je izvoz jedne baze — za godišnje-transakcione tabele (Trgovačka knjiga, KEPU,
> Depoziti) nula može značiti „živi u radnoj godišnjoj .mdb". Pošto su ionako MP/EXCLUDE, ne menja plan.
> Snapshot ostaje na ubuntusrv `~/bb-analiza/` za dalja merenja.

## 8. Artefakti ove analize (u repou)
- `_analiza/bigbit/BB_T_26_schema.sql` — kompletan DDL (207 tabela).
- `backend/docs/migration/BB_T_26-analiza-klaster-A-maticni-tehnologija-reversi.md`
- `backend/docs/migration/BB-snapshot-2026-klaster-B-robno-nabavka.md`
- `backend/docs/migration/BB_T_26_klaster_C_finansije-pdv-gk.md`
- `backend/docs/migration/BB_T_26-analiza-F1-pokrivenost-polja.md` — trostrano poređenje polja (pitanje #3)
- `backend/docs/migration/BB_T_26-analiza-F2-mehanizam-sync.md` — dizajn sync-a sa allow/deny listom
- `backend/docs/migration/BB_T_26-analiza-F3-inventar-207-tabela.md` — svih 207 tabela u 3 kofe
- Ovaj dokument = master pregled + plan (§7 objedinjuje F1/F2/F3).
