# QBigTehn SQL Server — poslovna logika za replikaciju u Servosync

> Izvor: read-only multi-agent ekstrakcija (7 agenata) iz `script.sql` (51 SP + 63 fn + 9 view), 2026-07-03. Ovo je „algoritamski sloj" koji fali u repo-u — Negovanovo znanje izvučeno iz koda. Ništa nije menjano.

Jedinstvena referenca za migraciju QBigTehn (SQL Server, `dbo`) na Servosync 2.0 (PostgreSQL + NestJS).

Presek celog sistema: dve paralelne sastavnice (PDM-nivo `KomponentePDMCrteza` po `IDCrtez`, dizajnerska; RN-nivo `tRNKomponente` po `IDRN`, izvrsna). Nabavni vs proizvodni deo se razdvaja iskljucivo preko `PDMCrtezi.Nabavka` (bit). Anti-ciklus u rekurzijama je string-putanja `'/id/id/'` + `CHARINDEX`. SQL Server maskira duboke/ciklicne podatke greskom `MAXRECURSION 100`; **PostgreSQL bez guarda VISI — to je crvena nit svih rizika.**

---

## DOMEN 1 — BOM / PDM sklopovi / where-used

### 1.1 Kljucni algoritmi

**Nizvodna eksplozija (proizvodni cvorovi) — `ftBOMKolicine(@ZaIDCrtez, @BrojKomadaZaIzradu=1)`** — centralni algoritam:
```
Edges = KomponentePDMCrteza  →  DISTINCT(Parent,Child,Qty)  →  SUM(Qty) GROUP BY (Parent,Child)
Bom   = Edges JOIN PDMCrtezi(parent).Nabavka=0 AND PDMCrtezi(child).Nabavka=0   -- obe strane proizvodne
FromRoot (rek CTE):
  anchor: IDCrtez=@root, QtyPath = (root.Nabavka=0 ? @BrojKomadaZaIzradu : 0), Path='/root/'
  rek:    child, QtyPath*QtyEdge, Path||child||'/'
          WHERE QtyPath>0 AND CHARINDEX('/'||child||'/', Path)=0
rezultat: SUM(QtyPath) AS BrojKomada GROUP BY IDCrtez; JeSklop='+' ako EXISTS grana u KomponentePDMCrteza
```
Kolicina po nivou = `qty_roditelja * PotrebnoKomada`, isti deo kroz vise grana se SUM-ira. Nabavne grane u potpunosti ispadaju.

**Nabavni delovi sa kolicinom — `ftBOMNabavniDeloviKolicine(@ZaIDCrtez)`** (dopuna prethodne):
```
anchor QtyPath = 1.0000 UVEK (kolicina PO JEDNOM sklopu), DECIMAL(18,4)
rek: siri se SAMO kroz Nabavka=0 roditelje (JOIN pPar.Nabavka=0) → nabavni artikl je uvek LIST
finalno: WHERE result.Nabavka=1, SUM(QtyPath) AS BrojKomadaPoSklopu
```

**MRP kalkulator — `ftMRP_PotrebeZaCrtez(@IDCrtez, @TipEksplozije, @Kolicina)`**: DVOSTRUKI guard `Nivo<20` I anti-ciklus; DECIMAL(19,6); `TipEksplozije 1=TopLevel(Nivo=1), 2=Full`. NEMA dedupe grana (za razliku od `ftBOMNabavniDeloviKolicine`).

**Where-used (uzvodno) — `ftWhereUsed(@ZaIDCrtez, @Rekurzivno)`**: `TrebaIDCrtez → ZaIDCrtez` penjanje. **NEMA anti-ciklus.**

**Status sklopova**: `ftStatusSklopova_Baza` (red po operaciji, `StatusOperacije 0/1/2`) → `spStatusSklopovaPoOperacijama` (status naloga + sledeca operacija, paginirano) + `spStrukturaProizvoda*` (dinamicki PIVOT).

**Most PDM→RN — `spGenerisiRNKomponenteZaCrtez`**: mapira direktna PDM deca na konkretne RN preko `(IDPredmet, BrojCrteza, MAX(Revizija), Varijanta)`, samo 1 nivo, idempotentno (`NOT EXISTS`).

### 1.2 Kriticna poslovna pravila
- Grana = `KomponentePDMCrteza(ZaIDCrtez→TrebaIDCrtez, PotrebnoKomada INT)`. **PotrebnoKomada je INT** — nema JM ni frakcionih kolicina na PDM-nivou.
- Nabavni vs proizvodni: ISKLJUCIVO `PDMCrtezi.Nabavka`. `=1` atomican (ne eksplodira), `=0` proizvodni (siri se).
- `ftBOMKolicine` vraca SAMO proizvodne cvorove (i roditelj i dete `Nabavka=0`). Nabavni delovi se dobijaju ODVOJENO. **UI mora spojiti dva pregleda.**
- Marker `JeSklop='+'` = ima bar jednu granu (ukljucujuci nabavnu decu) → cvor sa `'+'` u proizvodnom pregledu moze imati samo nevidljivu nabavnu decu.
- Izbor revizije = **string** `MAX(Revizija)` (leksikografski: `'10' < '9'`).
- `StatusOperacije`: 0=nije zapocet (napravljeno=0), 1=u toku (<planirano), 2=zavrsen (≥planirano). Napravljeno iz `tTehPostupak.Komada`, planirano iz `tRN.Komada`.
- **Dve razlicite definicije "zavrseno"**: `spStatusSklopovaPoOperacijama` (0/1/2, prag `ZnacajneOperacijeZaZavrsen`) vs `spStrukturaProizvodaPoRedosledu` (binarno 0/1, oslonjeno na "Zavrsna Kontrola").
- Boje stabla: Nivo0=Zuta, list=Bela, ima unuke=Ljubicasta, inace=Crvena.
- Poz numeracija (1.2.3): `Seq=ROW_NUMBER PARTITION BY roditelj ORDER BY NazivDela,BrojCrteza,IDRNPodkomponenta`, sort po `PozPadded` (zero-pad 3 mesta).

### 1.3 Mapiranje na Postgres/NestJS
- Sve rekurzivne TVF → **`WITH RECURSIVE` u SQL funkcijama** (`RETURNS TABLE ... LANGUAGE sql STABLE`). BOM eksplozija ostaje u SQL-u (performanse), ne u NestJS servisu.
- Anti-ciklus: umesto string-putanje koristiti `path INT[]` + `NOT (child = ANY(path))`, ILI PG14+ `CYCLE IDCrtez SET is_cycle USING path`. **OBAVEZNO dodati guard i tamo gde original nema** (`ftWhereUsed`, `spUpdateIDGlavniCrtezZaSklop`).
- Zadrzati `UNION ALL` (ne `UNION`) — kolicine se sabiraju; agregacija (`SUM GROUP BY`) ide u finalni SELECT van rekurzije.
- `MERGE` (`spDodajCrtezSaDubinom`) → `INSERT ... ON CONFLICT (IDNacrtPrim,IDCrtez) WHERE IskljuciPrimopredaju=false DO UPDATE` (parcijalni unique index kao conflict target). `OUTPUT $action` → `RETURNING` + `xmax=0`.
- Dinamicki PIVOT (`Op1..Op30`, po `RJgrupaRC`) → conditional aggregation ili `crosstab()`; **preporuka: vratiti long rezultat, pivot u NestJS/FE.** `sys.objects` brojac → `generate_series(1,30)`.
- Skalarne UDF u WHERE su spore → inline-ovati u PG.
- Indeksi: `KomponentePDMCrteza(ZaIDCrtez)`, `(TrebaIDCrtez)`, `PDMCrtezi(IDCrtez, Nabavka)`.

### 1.4 POTVRDITI sa Negovanom
- Da li `KomponentePDMCrteza` sme sadrzati cikluse? (`ftWhereUsed`, `spUpdateIDGlavniCrtezZaSklop` nemaju guard.)
- Da li je NAMERNO da proizvodni pregledi izostave nabavne delove (UI spaja dva pregleda)?
- `PotrebnoKomada INT` — treba li ikad decimalna kolicina (m, kg, m²)?
- Format/domen `Revizija` (leksikografski `MAX` je pogresan za `'9'`/`'10'`)?
- Koja je zvanicna definicija "zavrsenog naloga" za KPI (0/1/2 vs binarno)?
- Koje operacije nose `ZnacajneOperacijeZaZavrsen=1` / `PreskocivaOperacija=1`?

### 1.5 Rizici replikacije
- INT lanac (`ftBOMKolicine`) — celobrojno zaokruzivanje kada izvor pređe u DECIMAL.
- `MAX(Revizija)` leksikografski — tihi pogresan izbor deteta.
- Duple grane: `ftBOMNabavniDeloviKolicine` sklapa (DISTINCT+SUM), `ftMRP_PotrebeZaCrtez` dvostruko broji.
- `spGenerisiRNKomponenteZaCrtez` mapira samo 1 nivo.

---

## DOMEN 2 — MRP / zalihe / nabavka / planiranje

### 2.1 Kljucni algoritmi

**Waterfall podela potrebne kolicine — DVE NEKONZISTENTNE implementacije:**

GRANA A (`spMRP_KreirajIRealizujPlan`, MRP-vodjena, koristi `Slobodno = max(Zalihe-Rezervisane,0)`):
```
Slobodno >= Potrebna → Rez=Potrebna,        Nab=0,               OdlukaAkcija=1
0 < Slobodno < Potr  → Rez=Slobodno,         Nab=Potrebna-Slobodno, OdlukaAkcija=3
Slobodno <= 0        → Rez=0,                Nab=Potrebna,        OdlukaAkcija=2
```
GRANA B (`spPDM_Planiranje_PopuniRezervisanoINabavku`, PDM/rucna, koristi **SIROVE** `Zalihe`, NE oduzima rezervisano):
```
IskljuciNabavku=1 ili Potrebno<=0 → Rez=0, Nab=0
Zalihe >= Potrebno → Rez=Potrebno, Nab=0
0 < Zalihe < Potr  → Rez=Zalihe,   Nab=Potrebno-Zalihe
Zalihe <= 0        → Rez=0,         Nab=Potrebno
```
Grana B ne dira `OdlukaAkcija`. `RucnaKolicina` se ne koristi ni u jednoj.

**Broj plana — `spPDM_KreirajPlanZaglavlje`**: `@RedniBroj = ISNULL(MAX(TRY_CAST(SUBSTRING(BrojPlana, CHARINDEX('/')+1, 10) AS INT)),0)+1` sa `WITH (UPDLOCK,HOLDLOCK)`; `BrojPlana = BrojCrteza + ISNULL('-'+Revizija,'') + '/' + redniBroj`.

**Sync lagera — `spMRP_SyncStanjeArtikala`**: `MERGE ... ON SifraArtikla` UPDATE/INSERT ali **NEMA `WHEN NOT MATCHED BY SOURCE DELETE`** → obrisani artikli ostaju stale.

**Punjenje stavki — `spPDM_PopuniStavkePlana`**: iz `ftBOMNabavniDeloviKolicine`, `PotrebnoUkupno = BrojKomadaPoSklopu * KolicinaZaIzradu`, **`Zalihe=0` fiksno**, `SifraArtikla=NULL`.

### 2.2 Kriticna poslovna pravila
- DVA nezavisna toka se sreću u `PDM_Planiranje`: A) MRP-vodjen (izvor `MRP_PotrebeStavke`), B) PDM/rucni (BOM eksplozija sveze). **Razlicite formule.**
- `OdlukaAkcija`: 1=pokriveno iz zaliha, 3=delimicno, 2=cela nabavka. Postavlja se SAMO u grani A.
- Status obradjenosti: `MRP_Potrebe.IDPlan NOT NULL` = obradjena.
- `StatusArtikla`: 2=crveno (Slobodno≤0), 1=zuto (Slobodno<Potrebna), 0=zeleno.
- Zalihe iz `RobneStavkeMirror` = `SUM(KolicinaUlaz - KolicinaIzlaz)` po `KataloskiBroj`. **Magacin 2 = sirovine/repro (hardkodovano).**
- `DatumNabavke = DatumPotrebe - ISNULL(VremeIsporukeDana,0)`.

### 2.3 Mapiranje na Postgres/NestJS
- Rekurzivni TVF → SQL funkcije `RETURNS TABLE` + `WITH RECURSIVE`.
- **Kriticno: broj plana.** `SUBSTRING+CHARINDEX` hvata pogresan segment ako `BrojCrteza` sadrzi `/`. Koristiti `substring(BrojPlana from '([0-9]+)$')::int`. `TRY_CAST` → bezbedan cast. `UPDLOCK/HOLDLOCK` → `pg_advisory_xact_lock(hashtext(...))` po `(IDPredmet,IDCrtezSklopa)`; **idealno dodati `UNIQUE(IDPredmet,IDCrtezSklopa,redniBroj)`**.
- `MERGE` sync → `INSERT ... ON CONFLICT (SifraArtikla) DO UPDATE`.
- `CROSS APPLY`→`JOIN LATERAL ... ON true`; `OUTER APPLY`→`LEFT JOIN LATERAL`.
- **VELIKI PROBLEM**: procedure sa VISE result-setova (`spMRP_Pregled`) → **odvojene NestJS servisne metode** (najcistije), ili `refcursor`.
- Ugnjezdene transakcije → jedna transakcija na nivou NestJS servisa + `SAVEPOINT`.
- **NE reprodukovati bug**: proveru duplog plana staviti PRE otvaranja transakcije.

### 2.4 POTVRDITI sa Negovanom
- **KRITICNO**: Ko puni `MRP_Potrebe`/`MRP_PotrebeStavke`? U dumpu NEMA nijednog INSERT-a — radi li to aplikacija?
- Koja je merodavna formula podele — grana A (Slobodno) ili grana B (sirovo Zalihe)?
- Bug u `spMRP_KreirajIRealizujPlan` (~lin 10634): `RAISERROR+RETURN` nakon `BEGIN TRAN` ostavlja otvorenu transakciju.
- Ko i kada puni `Zalihe`/`SifraArtikla` u `PDM_PlaniranjeStavke` (grana B fiksira `Zalihe=0`)?
- Sifarnik magacina (koji ID = gotova roba / poluproizvod / sirovina)?
- Treba li MERGE brisati stale artikle?

### 2.5 Rizici replikacije
- Bug otvorene transakcije (grana A) — NE preneti.
- Split formule A/B daju razlicite rezultate za isti artikl.
- `Zalihe=0` fiksno u grani B — sve u nabavku dok se ne popuni.
- Stale lager (MERGE bez delete).
- Parsiranje `BrojPlana` sa `/` u `BrojCrteza`.

---

## DOMEN 3 — RN kreiranje / numeracija / kolicine

### 3.1 Kljucni algoritmi

**Numeracija RN — `fsSledeciBrojRadnogNaloga(@BrojPredmeta, @KoristiMax)`**:
```
@KoristiMax = ISNULL(@KoristiMax, fsReadCFGParametar('KoristiMaxBrojRN', 0))
Ordinal = TRY_CAST(deo posle poslednjeg '/') za tRN WHERE IdentBroj LIKE @pred+'/%'
@KoristiMax=1 → Next = MAX(Ordinal)+1     (rupe, ali bez duplikata)
@KoristiMax=0 → Next = COUNT(*)+1         (DUPLIKAT ako su nalozi brisani!)
RETURN @BrojPredmeta + '/' + Next
```
**Bez locka → race condition.**

**Masovno kreiranje — `spKreirajRNZaNacrtPrimopredaje`**: `StartOrd` iz `fsSledeciBrojRadnogNaloga(BrojPredmeta, 1)` (PRISILNO MAX); `IdentBroj = BrojPredmeta/(StartOrd+RowNumber)`; INSERT `tRN` (Komada=KolicinaZaIzradu, StatusRN=0, IDStatusPrimopredaje=0, SifraRadnika=0, JM='Kg'); pa `tRNKomponente` (MERGE) i `tRNNDKomponente` (nabavne → `R_Artikli`).

**Kolicina za izradu — `spPreracunajKolicinaZaIzradu`**: za SKLOP `GreatestQty = MAX(BOM nanize, BOM navise)` (FULL JOIN, `MAXRECURSION 32767`), `NewQty = COALESCE(NULLIF(GreatestQty,0), RowCnt) * @BrojKomada`; konsolidacija po crtezu (keeper=MIN IDNacrtStavka).

### 3.2 Kriticna poslovna pravila
- `IdentBroj = BrojPredmeta/redniBroj`. MAX+1 (rupe) vs COUNT+1 (duplikati) preko CFG `KoristiMaxBrojRN` (default 0).
- Prva `Varijanta` za novu trojku = **0**.
- RN samo za AKTIVNE (`IskljuciPrimopredaju=0`) i PROIZVODNE (`Nabavka=0`) crteze sa pozitivnom kolicinom, inace `THROW 51022`. Nabavne → `tRNNDKomponente`.
- **DVA statusa**: bit `tRN.StatusRN` (nedokumentovan) i tinyint `IDStatusPrimopredaje` (0=U OBRADI,1=SAGLASAN,2=ODBIJENO,3=LANSIRAN).
- Kloniranje: zadrzava `/ordinal`, menja prefiks, skalira `Komada*@Koeficijent` (tPND/tPDM/tPLP i tRN.Komada; norme se NE skaliraju).
- Brisanje = rucno kaskadno (nema FK CASCADE), fiksan redosled.
- RN zavrsen kada `SUM(napravljeno na ZnacajneOperacijeZaZavrsen=1) >= Komada`.

### 3.3 Mapiranje na Postgres/NestJS
- BOM CTE → `WITH RECURSIVE`, anti-ciklus `path INT[]`.
- **Numeraciju NE raditi legacy string-logikom** — tabela brojaca sa `SELECT ... FOR UPDATE` ili advisory lock po predmetu; eliminisati race. `split_part(IdentBroj,'/',-1)`.
- Skalarni agregat UDF → SQL `STABLE`; PAZI: PG `SELECT INTO` sa vise redova baca gresku (dodati `LIMIT 1`/agregat).
- `@@IDENTITY` → `INSERT ... RETURNING`. `@@ROWCOUNT` → `GET DIAGNOSTICS`.
- `DATEDIFF(MINUTE,a,b)` → `EXTRACT(EPOCH FROM (b-a))/60` — **PAZI: DATEDIFF broji prelaze granica, ne trajanje**.

### 3.4 POTVRDITI sa Negovanom
- Semantika bita `StatusRN` — sta znaci, odnos prema `IDStatusPrimopredaje`?
- `fsBrojNapravljenihKomadaZaRN`: `GROUP BY Operacija`+`SELECT @Result=SUM` vraca SAMO poslednju grupu kad je `@ZaOperacija NULL` — bug?
- Postoji li `UNIQUE(IDPredmet, IdentBroj, Varijanta)`?
- Podrazumevani rezim numeracije — MAX+1?
- Ima li trigera na `tRN` (`@@IDENTITY` osetljiv)?
- `tTehPostupak` nema FK na tRN — orphan prijave namerne?

### 3.5 Rizici replikacije
- Race u numeraciji.
- COUNT+1 duplikati posle brisanja.
- Ugnjezdene IMENOVANE transakcije = zapravo jedna fizicka; rollback varljiv; nema TRY/CATCH.
- `@@IDENTITY` nepouzdan uz trigere.
- `LEFT JOIN tLansiranRN` umnozava redove.

---

## DOMEN 4 — Tehnoloski postupak / operacije / evidencija rada / barkod

### 4.1 Kljucni algoritmi
Dva temeljna TVF-a — spoj preko petorke `(IDPredmet, IdentBroj, Operacija, Varijanta, RJgrupaRC)`:
```
ftDetaljnoStavkeRN()              → norma: UkupnoVreme = Tpz + Tk*Komada     (POTREBNO)
ftNapravljenoKomadaPoTehPostupku()→ SUM(Komada) AS NapravljenBrojKomada,     (NAPRAVLJENO)
                                    NE filtrira ZavrsenPostupak ni Kvalitet (broji i DORADA/SKART)
Razlika = Komada - ISNULL(NapravljenBrojKomada, 0)
```
Dorada/skart: `ftZavrseniPostupciPreDoradeIliSkarta` (SUM WHERE Operacija<@Op, + hardkodovano `IDPredmet<>4521`) + `ftDodatiPostupkeZaDoraduIliSkart` (skelet novih postupaka WHERE Operacija>@Op).
**"Zavrsen RN" — TRI generacije logike** (sve preko `ZnacajneOperacijeZaZavrsen=1`): staro (Razlika=0 za sve znacajne), novo (`PreskocivaOperacija=0` I `Razlika>0` ne postoji), najnovije (`ZavrsenoKomada>=KomadaPlanirano`).

### 4.2 Kriticna poslovna pravila
- Kvalitet `IDVrstaKvaliteta`: 0=DOBAR, 1=DORADA, 2=SKART.
- **Dve definicije "napravljeno"**: `ftNapravljeno...` (sve, +dorada/skart) vs `fsBrojNapravljenihKomadaZaRN` (samo `ZavrsenPostupak=1`).
- **Dve definicije "utroseno vreme"**: stvarno `DATEDIFF` vs normativno `Napravljeno*Tk`.
- Prioritet `255` = iskljuceno. Backup obavezan pri brisanju (`tTehPostupakBackup`).
- Sentinel datumi `1900-01-01`/`2999-12-31`.
- **Sam INSERT prijave rada NIJE u dumpu** — verovatno klijentska barkod aplikacija.

### 4.3 Mapiranje na Postgres/NestJS
- Inline TVF → 1:1 `RETURNS TABLE ... LANGUAGE sql STABLE`.
- **VREME**: `DATEDIFF` broji PRELAZE granica → `EXTRACT(EPOCH FROM (b-a))`. **Rezultati ce se RAZLIKOVATI**; preporuka preci na pravo trajanje (uz saglasnost).
- Case/accent (SQL Server CI, PG CS) → `ILIKE`/`COLLATE`/`citext` za srpska slova.
- **Write-path prijave rada mora se implementirati u Servosync** (`spPrijaviRad`/`spZatvoriOperaciju`) — nije u legacy dumpu.

### 4.4 POTVRDITI sa Negovanom
- Treba li `NapravljenBrojKomada` da ukljucuje dorada/skart?
- Koja od 3 logike "zavrsen RN" je merodavna?
- "UtrosenoVreme" — stvarno ili normativno?
- Hardkodovan `IDPredmet<>4521` — sta je?
- Gde je write-path prijave rada sada?
- DATEDIFF semantika (boundary vs trajanje) — cuvati ili menjati?

### 4.5 Rizici replikacije
- DATEDIFF semantika menja SVE izvestaje o vremenu.
- Dve definicije "napravljeno"/"utroseno" — nekonzistentni brojevi.
- Join-ovi bez punog kljuca → tihi duplikati.

---

## DOMEN 5 — Primopredaja / nacrti / status flow / gate / duplikati

### 5.1 Kljucni algoritmi
**Status flow — `spPromeniStatusPrimopredaje(@IDRN, @NoviStatus, ...)`**: `UPDLOCK,HOLDLOCK`; status 0/1/2 → GRUPNO cela primopredaja, status 3 → SAMO taj RN; status=1 INSERT `tSaglasanRN`, status=3 INSERT `tLansiranRN`.
**Gate — `spGateZaRN`**: `fsBrojNeresenihStavkiNacrta>0` → THROW 51102; nema aktivne proizvodne stavke → THROW 51103.
**DVE provere duplikata (obe pisu `PredProveraDuplikat` → gaze se):** `spFlagPredProveraDuplikat` (STRUKTURNA, dete sa ≥2 roditelja) vs `spPredproveraDuplikata` (ISTORIJSKA/cross-dokument: drugi otvoreni nacrti + aktivni RN).

### 5.2 Kriticna poslovna pravila
- `IDStatusPrimopredaje`: 0=U OBRADI,1=SAGLASAN,2=ODBIJENO,3=LANSIRAN. **DDL default=3**, ali `spKreirajRN` postavlja 0.
- `OdlukaAkcija`: 1=Iskljuci (postavlja `IskljuciPrimopredaju=1`), 2=Predaj ponovo, 3=Dopuna. Samo 1 efektivno uklanja.
- Numeracija nacrta: `D-BrojPredmeta/n` (TipNacrta=0) ili `G-BrojPredmeta/n` (TipNacrta=1). **Ordinal deljen izmedju oba prefiksa.**
- Brisanje nacrta zabranjeno ako je iskoriscen u tRN.

### 5.3 Mapiranje na Postgres/NestJS
- Rekurzivni CTE → `WITH RECURSIVE` + `CYCLE`/array path. `MAXRECURSION 32767` nema ekvivalent — anti-ciklus obavezan.
- `MERGE` → `INSERT ON CONFLICT (IDRN,IDRNPodkomponenta) DO UPDATE`.
- `UPDLOCK/HOLDLOCK` → `SELECT ... FOR UPDATE`. **Numeracija u `spKreirajRN` NEMA lock → dodati.**
- `SUSER_NAME()` → `current_user`.

### 5.4 POTVRDITI sa Negovanom
- Kompletni kodovi `IDStatusNacrtaPrimopredaje` (poznato samo 0)?
- Da li D i G namerno DELE brojac?
- DDL default `IDStatusPrimopredaje=3` — zeljeno?
- **MOGUCI BUG**: `spPopuniRNKomponenteZaNacrtPrimopredaje` INSERT-uje NULL `IDRNPodkomponenta` u NOT NULL kolonu → pad.
- Odnos i redosled dve provere duplikata (gaze se)?
- Dve putanje lansiranja (`spLansirajPrimopredajuZaIDRN` bez audita vs `spPromeniStatusPrimopredaje(3)`) — kanonska?
- Matrica dozvoljenih prelaza statusa?

### 5.5 Rizici replikacije
- Dve provere duplikata se gaze.
- Race u numeraciji RN.
- NULL u NOT NULL koloni.
- "Lepljiva" odluka: `IskljuciPrimopredaju` se ne vraca na 0.

---

## DOMEN 6 — Lokacije / vreme / config / planer / QA-pregledi

### 6.1 Kljucni algoritmi
**Premestanje delova — `spIzvrsiPrenosIliCiscenjeDelaSaLokacije`** (signed-delta, nema "stanje"): PRENOS = 2 INSERT-a (-@Kol / +@Kol) **NIJE atomicno**; TREBOVANJE = 1 INSERT (-@Kol); stanje = `SUM(Kolicina) GROUP BY pozicija HAVING SUM<>0`; **NEMA transakcije ni provere kolicine (dozvoljava negativno)**.
**Obracun vremena iz sekundi**: dani=Sek/86400, sati=Sek/3600 (TRUNCATE), ali `fsOstatakBrojaSatiIzDatihSekundi` deli sa 3600.00 → int dodela ZAOKRUZUJE (nekonzistentno).
**Satni pivot** (`ftStatistikaAktivnostiPivot`): rekurzivni CTE `Satnice` sat-po-sat, **BEZ MAXRECURSION → puca za period > ~4 dana**.

### 6.2 Kriticna poslovna pravila
- Stanje po lokaciji = `SUM(tLokacijeDelova.Kolicina)` (signed-delta).
- CFG preko `fsReadCFGParametar` — **ne filtrira po `IDFirma`** iako je PK `(IDFirma, Parametar)`.
- **"Procitano" je GLOBALNO** — jedan bit `CheckUradjeno` po poruci.
- **Prag "PRE DUGO" nije jedinstven**: 16h vs 12h.

### 6.3 Mapiranje na Postgres/NestJS
- **Satnice → `generate_series(..., interval '1 hour')`** — resava i bug pucanja.
- PIVOT → conditional aggregation.
- Integer deljenje `fsOstatakBrojaSatiIzDatihSekundi` — uskladiti semantiku zaokruzivanja.
- `READ UNCOMMITTED` → `READ COMMITTED`. `sys.sysprocesses` → `pg_stat_activity`.
- CFG: **dodati `IDFirma` u upit** `fsReadCFGParametar`.
- **Transakciona tacka**: prenos = dva INSERT-a u JEDNU transakciju + validacija kolicine.

### 6.4 POTVRDITI sa Negovanom
- `fsReadCFGParametar` bez `IDFirma` — single-tenant ili dodati filter?
- Prag "PRE DUGO" — 12h ili 16h?
- `spIzvrsiPrenos...` bez transakcije/provere — dozvoljeno negativno stanje?
- Globalno "procitano" — treba li per-user?
- Duplirane TVF/SP — konsolidovati?

### 6.5 Rizici replikacije
- Neatomican prenos (nekonzistentno stanje).
- Negativno stanje na polici.
- Satnice pucaju za periode > 4 dana.
- Globalno "procitano" gubi se po korisniku.
- CFG bez IDFirma.

---

## GLOBALNI PRIORITETI ZA MIGRACIJU
1. **Anti-ciklus svuda** (PG nema MAXRECURSION) — narocito `ftWhereUsed`, `spUpdateIDGlavniCrtezZaSklop`; `Satnice` → `generate_series`.
2. **Numeracija sa pravim lockom** (tabela brojaca / advisory lock / sekvenca) — legacy ima race na vise mesta.
3. **Uskladiti duple definicije** ("zavrsen", "napravljeno", "utroseno vreme", prag "PRE DUGO", split A vs B) pre migracije.
4. **DATEDIFF semantika** (boundary-count vs trajanje) — menja sve izvestaje o vremenu.
5. **Multi-result-set procedure** (`spMRP_Pregled`) → odvojene NestJS metode.
6. **Write-path prijave rada** (`tTehPostupak` INSERT) i punjenje `MRP_Potrebe` nisu u dumpu — implementirati/pronaci.
7. **NE reprodukovati bug** otvorene transakcije (`spMRP_KreirajIRealizujPlan`).
