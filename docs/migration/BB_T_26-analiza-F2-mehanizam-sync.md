## F2. Mehanizam sync-a sa exclude-listom (dizajn — ništa se ne implementira)

> ⛔ **ISPRAVKA IZVORA (Nenad 11.07) — PROČITATI PRE OSTATKA:** ovaj dokument je pisan pod pretpostavkom
> **XML export-a** (BACKEND_RULES §11.2a). To je **PREVAZIĐENO.** Stvarni mehanizam:
> **skripta na Windows serveru čita BigBit direktno (ACE OLEDB) i piše u PostgreSQL** — bez XML fajlova,
> bez QMegaTeh→vasa-SQL kopije za matične. Autoritativan opis: **§7.3 u
> [BB_T_26_ANALIZA_I_PLAN.md](BB_T_26_ANALIZA_I_PLAN.md).** Sve niže o „XML export"/„vendor izbacuje fajl"
> je **nevalidno kao izvor** — ostaje korisno SAMO za: (a) allow/deny listu, (b) strategiju po tabeli
> (full-refresh/upsert), (c) delete/overlay pravila. Te delove čitati; deo o izvoru ignorisati.

Odgovor na pitanje: **kako bi radio BigBit→ServoSync sync tako da tabele koje ne trebaju budu
tvrdo isključene**. Dizajn se naslanja na postojeći `src/modules/sync/` modul (62 mapirane tabele u
`sync-map.generated.ts` + 7 ručnih/izvedenih syncera) i na već donete odluke u
[BACKEND_RULES §11.2](../BACKEND_RULES.md) / [ODLUKE.md](../ODLUKE.md) (2026-07-08).

---

### F2.1 Izvor — opcije i preporuka za 4.0

Ograničenje koje eliminiše „najjednostavniju" opciju: BigBit je **Access `.mdb` sa ULS zaključavanjem**
(workgroup `BIGBIT.MDW`; nalog `admin/telefon` je workgroup-admin ali bez read-prava) — **direktno
ODBC/Access čitanje iz aplikacije NIJE opcija**. Legacy je to zaobilazio Access-frontendom kao
posrednikom (`EXT_*` linkovane tabele, connect string `;DATABASE=...\BB_T_25.MDB`, definicije u
config tabelama `BazeIFirme`/`BazeITabele` — vidi [06-bigbit-preuzmi-iz-bb.md §4](06-bigbit-preuzmi-iz-bb.md)).

| Opcija | Šta je | Za | Protiv |
|---|---|---|---|
| **(a) QBigTehn MS SQL kopija (vasa-SQL)** — današnje stanje | 2.0 čita BigBit matične podatke iz QBigTehnove kopije (`Komitenti`, `R_Artikli`, `Cenovnik`… na `192.168.64.25:5765`) | Već radi; `mssql.client.ts` + watermark `PoslednjaIzmena`; inkrementalno | Kopija živi samo dok živi QBigTehn (gasi se na cutover-u); kopija ≠ original (šema-drift §F2.6); zavisi od legacy 10-min skripti |
| **(b) BigBit export XML/CSV + import (UPSERT/INSERT)** | BigBit (vendor) izbacuje export fajl; `bigbit-sync` ga parsira i uvozi | ✅ **ODLUČENO 2026-07-08** (BACKEND_RULES §11.2a); potvrđeno (Negovan/Vasa 8.7): **format = XML, CEO katalog artikala**; nema živog pristupa ULS bazi; export = eksplicitni ugovor (kontrakt polja) | Nema server-side delte — svaki export je pun snapshot; zavisi od vendora za sadržaj exporta; treba dogovoriti pokrivenost SVIH allow-tabela, ne samo artikala |
| **(c) BigBit → SQL Server upsizing** | Vendor migrira BigBit Access na SQL Server (npr. na vasa-SQL), 2.0 nastavlja `mssql` konektorom | Postojeći konektor i `GenericSyncer` rade bez izmene; inkrementalno moguće | Najveći zahvat za vendora; BACKEND_RULES istorija (v0.4) ga je preferirala, ali je **v0.5 odluka pala na export** — vraćanje na (c) bila bi NOVA odluka |

**Preporuka za 4.0: ostati na (b) — XML export + import**, u skladu sa donetom odlukom, uz dve dopune:

1. **Proširiti ugovor exporta sa „ceo katalog artikala" na celu allow-listu** (§F2.3). Potvrđeni dogovor
   pokriva `R_Artikli`; za `Komitenti`, `Predmeti`, `Cenovnik`, šifarnike itd. treba isti XML kanal
   (jedan fajl po tabeli ili jedan multi-table fajl — svejedno, bitan je pun snapshot po tabeli).
   Legacy presedan za parser postoji: `PDMXMLParser.bas` (schema-aware) i `BigBitXML.bas`
   (generički staging `xml_Imported`) — vidi [06 §5](06-bigbit-preuzmi-iz-bb.md).
2. **Model „tri sync-a" ostaje:** A = QBigTehn (privremen, briše se na cutover-u — `QBIGTEHN_CHAIN_ENTITIES`),
   B = BigBit (ovaj dizajn; traje dok 4.0 ne preuzme domen po domen), C = PDM (direktan SQL na Servoteh
   međusloj, §11.3 — **trajan**, BOM izvor istine). `mssql.client.ts` NE umire sa QBigTehn-om — ostaje za Sync C.

Prelazno stanje do cutover-a: (a) ostaje kakvo jeste. Ovaj dizajn opisuje Sync B posle cutover-a.

---

### F2.2 Selekcija tabela — ALLOW-lista kao mehanizam, deny-lista kao tvrdi guard

**Princip: sinkuje se SAMO ono što je eksplicitno na allow-listi.** Sve ostalo je implicitno
isključeno — od 207 tabela `BB_T_26` snapshota, u trajni sync ulazi red veličine **~35**, u jednokratnu
migraciju po domenu još ~50, a **ostatak (~120) se ne kopira nikad** (uklj. tvrdu exclude-listu ispod).

Kako se to sprovodi u postojećem modulu — **isključenje = ne-registracija, ne runtime flag**:

- `sync-map.generated.ts` generiše `scratchpad/gen-map.js` iz `docs/schema-rename-map.md` + Prisma DMMF.
  Tabela koja **nije u mapi** → za nju se ne konstruiše `GenericSyncer` u petlji u konstruktoru
  `SyncService`-a (`for (const mapping of SYNC_MAP) … this.register(...)`) → nije u
  `availableEntities` → `POST /sync/run` za nju baca `NotFoundException("Unknown entities: …")`.
  Dakle exclude tabela **ne postoji za sync** ni na jednom sloju — nema šeme, nema mapiranja, nema
  endpointa. Isti princip već važi za `QBIGTEHN_CHAIN_ENTITIES` (komentar u `table-ownership.ts`:
  *„Deliberately NOT a runtime skip flag: dead code gets deleted, it does not linger behind a switch"*).
- **Novi artefakt (dizajn):** `src/modules/sync/bigbit-allowlist.ts` uz postojeći `table-ownership.ts`,
  po istom obrascu (`Set<string>` + helper):

  ```ts
  /** BigBit source tables the permanent Sync B is allowed to import. */
  export const BIGBIT_SYNC_ALLOWED_SOURCES = new Set<string>([ /* §F2.3 */ ]);

  /** HARD exclude (Nenad 11.07): MP/POS/Raster/OTKUP + tehnički bloat. Nikad se ne mapira. */
  export const BIGBIT_HARD_EXCLUDED_SOURCES = new Set<string>([ /* §F2.3, kategorija 3 */ ]);
  ```
- **Generator mape dobija guard:** `gen-map.js` (1) **odbija da emituje** mapping za source tabelu koja
  nije u `BIGBIT_SYNC_ALLOWED_SOURCES` (greška, ne warning — sprečava da neko „usput" doda tabelu u
  `schema-rename-map.md` i time je tiho uvuče u sync); (2) **pukne ceo run** ako se u
  `schema-rename-map.md` nađe tabela iz `BIGBIT_HARD_EXCLUDED_SOURCES`.
- **Test kao druga brava** (obrazac `sync.service.spec.ts`): asertacija da nijedan
  `SYNC_MAP[i].source` nije u deny setu i da su svi u allow setu — hvata i ručno editovanje
  generisanog fajla (koje je ionako zabranjeno zaglavljem „Ne editovati rucno").
- **Homonimi se ključaju po (izvor, tabela), ne samo po imenu tabele.** Današnja mapa je nad QBigTehn
  kopijom; BigBit ima tabele ISTOG imena a drugog sadržaja (`tRadnici` 123 reda, `Pozicije` 65,
  `RadniNalozi` 2.588, `Nalepnice`, `Radni fajlovi`, `_Rev`) — te BigBit varijante **ne ulaze** u
  allow-listu jer 2.0 te entitete već ima iz QBigTehn lanca ili ih poseduje nativno.

Na cutover-u (runbook korak 6) iz mape ispada 35 entiteta QBigTehn lanca; ostaje **trajni BigBit set
(~27 entiteta danas: customers, projects, items, salespeople, price_list_entries, warehouses,
tax_rates, code_types, document_types, MRP_*, robna dokumenta cache, registry/CFG…)** — taj set se
prevezuje sa vasa-SQL na XML import i postaje polazna tačka allow-liste.

---

### F2.3 Skica allow/deny liste (po kategorijama)

**Kategorija 1 — TRAJNI SYNC (matični; dok BigBit živi kao izvor istine):**

| BigBit tabela | Redova (BB_T_26) | 2.0 target | Napomena |
|---|---|---|---|
| `Komitenti` | 6.669 | `customers` (postoji) | danas sync iz QBigTehn kopije, svih 57 kolona |
| `KomitentiKontaktOsobe` | — | nov model (1:N kontakti) | gap iz klaster-A analize |
| `MestaIsporuke` | — | nov model | fakturisanje po mestu isporuke (4.0 `sales` priprema) |
| `Predmeti` (+ `PredmetiFaze`, `PredmetiFazeDef`, `PredmetiVrstaPosla`) | 7.736 | `projects` (postoji) + novi šifarnici faza | |
| `Prodavci` | 80 | `salespeople` (postoji) | |
| `R_Artikli` | 91.199 | `items` (postoji) | ključ `Sifra artikla` → `BBSifra artikla` obrazac iz legacy-ja |
| `R_Artikli_BarKod`, `R_Artikli_Ino` | — | novi child modeli | barkodovi / ino nazivi artikala |
| `R_Grupa`, `R_Podgrupa`, `R_Poreklo` | male (stotine) | `item_groups`/`item_subgroups`/`item_origins` (modeli postoje, PRAZNI) | zatvara poznatu rupu (Item.groupCode bez naziva) |
| `R_KvalitetArtikla` | mala | nov model | `Item.qualityTypeId` ga čeka |
| `R_Tarife` | 3 | `tax_rates` (postoji) | |
| `Cenovnik` (+ `CEN_DozvoljeniCenovnici`) | 82.855 | `price_list_entries` (postoji) | ⚠️ insert-only problem — vidi §F2.4 |
| `Magacini` | mala | `warehouses` (postoji) | |
| `Vrste sifara` | mala | `code_types` (postoji) | |
| `R_Vrste dokumenata` | mala | `document_types` (postoji) | |
| `Kursna lista` | — | nov model | valute/kursevi (Predmeti.DevValuta/Kurs već u 2.0) |
| `UplatniRacuni` (+ `INOUplatniRacuni`) | — | `payment_accounts` (postoji) / nov | |
| `DobavljaciZaArtikal` | — | nov model | MRP/procurement uvid (dobavljač+lead-time po artiklu) |
| `Rabati`, `RabatiPoArt`, `Akcije`, `AkcijeArtikli` | — | novi modeli | ulaze tek kad krene 4.0 `sales`; do tada NE |
| `CarinskeTarife` | — | nov šifarnik | tek uz 4.0 `customs` |
| `Kontni plan` | — | nov šifarnik | tek uz 4.0 `finance`/GL |

**Kategorija 2 — JEDNOKRATNA MIGRACIJA pri preuzimanju domena (lift-and-shift, NE trajni sync):**
transakciona/istorijska dokumenta se uvoze jednom kad 4.0 modul oživi, potom je ServoSync vlasnik.
Reprezentativno: `T_Robna dokumenta`/`T_Robne stavke` (danas već cache za MRP), `T_MagDok`/`T_MagStavke`,
`T_Popis zaglavlja`/`T_Popis stavke`, `Stavke nivelacije` (`inventory`); `ZahteviZaNabavku` (3.990),
`SpecifikacijaZahtevaNabavke`, `ZahteviZaPonude`, `T_UpitDobavljacu`(+` Stavke`), `OP_Dokumenta`/`OP_Stavke`,
`T_Trebovanja`(+` stavke`, `PratecaDok`, `_ERNabavka`), `AvUplateTrebovanja` (`procurement`);
`T_Glavna knjiga`, `T_Nalozi`, `Vrsta naloga`, `Sema za kontiranje`+`Stavke seme za kontiranje`,
`KontniPlan_STD`, `InoKontniPlan`, `T_OS_Sredstva`/`T_OS_Stavke` (`finance`); `PDV_Knjige`, `PDV_Kolone`,
`PDV_PPPDV`, `T_PDV_IF`/`T_PDV_UF`, `T_POPDV_*`, `T_Knjiga KEPU`, `PDV_SemeKontaZaKnjizenje`,
`POPDV_SemeKontaZaKnjizenje` (`tax`); `Virmani`, `Depoziti`, `Kamata*`, `OK_*`, `KamatneStope` (`banking`);
`ER_*`, `T_ER_DokumentaNabavke`, `T_ER_StatusDokumenata` (`sef`); `CarMagDok`/`CarMagStavke` (`customs`);
`T_Profakture`(+` stavke`), `T_Usluge*`, `T_AVR_Roba`/`T_AVR_Usluge`, `RadniNalozi` (2.588 — servis/komercijala,
homonim!), **`Reversi`/`ReversiStavke` (135/144 — komercijalni revers robe = `sales`; NIJE magacin alata —
ispravka #1)**, `Posete`, `T_Trgovacka knjiga` (`sales`). BigBit-interna proizvodnja (`T_Proizvodnja`(+` stavke`,
`Normativi`), `T_Rastavnice`, `T_Recepti`, `SastavMaterijala`, `StvarniUtrosakSirovina`) — samo ako 4.0
poželi materijalni obračun/costing; **ne diraju PDM BOM (ispravka #2)**.

**Kategorija 3 — DENY (tvrda exclude-lista, `BIGBIT_HARD_EXCLUDED_SOURCES`; nikad se ne kopira):**

1. **MP/POS/Raster/OTKUP — ispravka #3 (22 tabele):**
   `T_MPDokumenta`, `T_MPStavke`, `T_MPDokumenta_Placanja`, `T_MPStavke_Obrisane`, `MPStavkeNivelacije`,
   `T_Knjiga KEPU_MP`, `OTKUP_Dokumenta`, `OTKUP_Stavke`, `KASE`, `FP_Artikli`, `FP_ZahtevZaStampu`,
   `FP550_CMD`, `FP550_IzvrseneKomande`, `FP550_Status`, `RasterDefKolona`, `RasterDefVrsta`,
   `RasterDefZag`, `RasterDefStavkeKolona`, `RasterDefStavkeVrsta`, `RasterMPStavke`, `RasterStavke`,
   `RasterTrebovanjaStavke`.
2. **POS-satelit:** `BrojStolaTuraKartica` (stolovi/ture — ugostiteljski POS), `Operateri` (kase),
   `ArtikliNaziviPanela`, `ArtikliPanelDef` (POS paneli). (`VrstePlacanja` i `MestaIzdavanja` —
   proveriti: ako ih koristi i veleprodaja/finansije, presele se u kategoriju 1/2.)
3. **Tehnički bloat / temp / kopije (~29):** `T_tmp`, `TMP_ZaLink`, `tmp_T_KontroleNaFormi`,
   `R_Artikli_TMP`, `KOPIJA Robna dokumenta`, `KOPIJA Robne stavke`, `Semafor`, `T_PK1`, `BBS_Indexi`,
   `BBS_SveTabele`, `tImportLog`, `ODBC_Synch`, `SYNCH_Cenovnik`, `SYNCH_R_Poreklo`, `CSVExport_Grupa`,
   `CSVExport_Poreklo`, `CSVExport_Podgrupa`, `EXT_Dokumenta_USL`, `EXT_RobnaDokumenta`, `ZaSHUTTLE_Info`,
   `ZaSHUTTLE_Status`, `DExp_KutBarKod`, `APVP_CTKolone`, `APOP_CTKolone`, `UI_Stavke`, `V_Stavke`,
   `V_Dokumenta`, `T_Izvestaj`, `T_IzvestajStavke`.
4. **BigBit homonimi QBigTehn/2.0 entiteta:** `tRadnici` (123 — 2.0 `Worker` je iz QBigTehn izvora),
   `Pozicije` (65 — nije 2.0 `positions`), `Nalepnice`/`NalepniceNNID`, `Radni fajlovi`, `_Rev`.
5. **Per-instalacija config:** `CFG_Global`, `Parametri za rad`, `BBDefUser`, `BBOdeljenja`,
   `BBOrgJedinice` — 2.0/4.0 imaju sopstvenu konfiguraciju; `BBPravaPristupa` se čita JEDNOM kao ulaz
   za RBAC mapiranje, ne sinkuje se kao podatak.
6. **UI slike/binarno (default deny, revizija ako UI artikala zatreba):** `Slicice`, `GrupeSlike`,
   `PodgrupeSlike`, `ArtikliSlike`; partner-specifično: `Addinol`.

---

### F2.4 Strategija po tabeli — snapshot/inkrement, insert-only/upsert, delete

**Realnost izvora (b):** XML export nema server-side `WHERE [PoslednjaIzmena] > @cursor` — svaki export
je **pun snapshot fajl**. Time se današnja podela `GenericSyncer`-a (watermark → incremental upsert;
bez watermarka → `deleteMany` + chunked `createMany` pod `session_replication_role='replica'`)
preslaguje ovako:

| Strategija | Za koje tabele | Mehanika | Kursor u `bb_sync_state` |
|---|---|---|---|
| **full-refresh iz snapshota** | mali šifarnici: `R_Grupa`, `R_Podgrupa`, `R_Poreklo`, `R_KvalitetArtikla`, `R_Tarife` (3), `Magacini`, `Vrste sifara`, `R_Vrste dokumenata`, `Kursna lista` | postojeći full-refresh put `GenericSyncer`-a (wipe + `createMany` u chunk-ovima ≤5000, transakcija 20 min timeout); bezbedno jer je čist cache — nijedna nije u `OWNED_PRODUCTION_TABLES` | `{"strategy":"full_refresh","exportedAt":…,"fileHash":"sha256:…"}` |
| **snapshot-diff + INSERT-only** (✅ ODLUČENO §11.2b „kao legacy") | veliki matični: `Komitenti`, `Predmeti`, `R_Artikli`, `Prodavci` | anti-join u kodu: uvezi samo redove čiji prirodni ključ (`Sifra`, `IDPredmet`, `BBSifra artikla`, `Sifra prodavca`) ne postoji u targetu; postojeći redovi se NE diraju. Svesna posledica (zapisana u odluci): promena adrese/PIB-a se NE propagira | isto (fileHash sprečava dupli uvoz istog fajla) |
| **snapshot-diff + UPSERT (BigBit-wins)** | kandidat-izuzeci: `Cenovnik` (82.855 — **cene se menjaju na postojećim redovima**; insert-only ih zamrzava), `R_Artikli` flagovi `Aktivan`/`ZaBrisanje` | per-red `upsert` po prirodnom ključu (obrazac `customer.syncer.ts`); bezbedno jer je cache read-only (§11.1 — aplikacija ne piše po cache tabelama, nema lokalnih izmena koje bi se pregazile) | isto |

⚠️ **Insert-only vs upsert je NOVA odluka po tabeli:** §11.2b je odlučen za matični tok (Komitenti/
Prodavci/Predmeti/R_Artikli, kao legacy „Preuzmi iz BB"); odluka eksplicitno kaže *„ako se kasnije
pokaže potreba za update-om, to je nova odluka"*. Predlog za Negovana: **insert-only zadržati za
Komitenti/Predmeti/Prodavci, a za `Cenovnik` (i flagove `R_Artikli`) tražiti upsert** — u suprotnom
2.0 MRP/kalkulacije rade sa zamrznutim cenama. Tri legacy transformacije (PIB `XX_<Sifra>`,
`[Sifra prodavca]=0`, `Password=Sifra`) — odluka Luka/implementacija da li se prenose ili peglaju.

**Delete-propagacija (otvorena odluka §11) — predlog rešenja za matične:**

1. **Nikad hard-delete u 2.0 cache-u.** Obrisan red u BigBit-u ostaje u ServoSync-u (to je već svesna
   posledica §11.2b) — istorijski RN/predmeti i dalje referenciraju tog komitenta/artikal.
2. Pošto je export **pun snapshot**, diff prirodno daje i suprotan smer: ključevi prisutni u 2.0 a
   odsutni u snapshotu = kandidati za „obrisan/ugašen u izvoru". Predlog: taj skup se **samo
   evidentira** — brojka + lista ključeva u `bb_sync_log.metadata` (npr.
   `{"customers":{"missingFromSource":17,"keys":[…]}}`), bez ikakve izmene podataka.
3. Ako UI zatreba vidljivost („ne nudi ugašene komitente u padajućoj listi"): flag ide u **overlay
   tabelu** (npr. `customer_overlay.source_missing_since`), NE u cache tabelu — pravilo §11.1
   (aplikativna polja se ne dodaju u sync-ovane tabele) ostaje netaknuto. Za male šifarnike na
   full-refresh strategiji delete se propagira prirodno (snapshot = istina).
4. Formalna odluka za Negovana: da li `missingFromSource` sme da znači „sakrij u UI" — do tada samo log.

**Redosled entiteta zbog FK** ostaje kao u legacy lancu (`Vrste sifara` → `Prodavci` → `Komitenti` →
`Predmeti` → `R_Artikli`; šifarnici artikala pre `R_Artikli`) — `SyncService` već poštuje redosled
registracije (Map insertion order), a nerazrešivi FK se **NULL-uje umesto da obori red** (obrazac
`customer.syncer.ts`: pre-fetch skupova `salespersonIds`/`codeTypeCodes` pa provera pre upisa).

---

### F2.5 Selekcija polja — sva polja ili samo potrebna?

**Preporuka: na allow-tabelama default = SVA polja izvora, uz eksplicitni per-kolona exclude za polja
isključenih domena.** Obrazloženje:

- Postojeća praksa je već „iscrpno mapiranje": `customer.syncer.ts` mapira **svih 57 kolona**
  `Komitenti`; `GenericSyncer` SELECT-uje tačno mapirane kolone. Trošak diska/parsiranja je trivijalan.
- Cache je **buduća zamena BigBit-a**: 4.0 rebuild domena kreće od ovih podataka. Naknadno dodavanje
  ispuštene kolone = izmena šeme + migracija + ponovni full import + (kod insert-only!) rupa u istoriji
  za redove uvezene pre dodavanja — skuplje od „nosi sve odmah".
- **Per-kolona exclude ipak postoji**, vezan za deny-domene iz kategorije 3: na `R_Artikli` npr.
  `IDRaster` (Raster), `PLU` (POS), `MPKaloProc`/`MP cena` (maloprodaja — proveriti da li VP tok igde
  koristi MP cenu pre izbacivanja); slično na drugim tabelama gde F1 identifikuje MP/POS/Raster kolone.
  Svaki exclude se dokumentuje u `docs/schema-rename-map.md` redom „NE PRENOSI SE — razlog" (generator
  time zna da kolonu ne emituje u mapu), pa je odluka vidljiva i reverzibilna.
- Vezano za F1: F1 daje po-tabelu inventar polja i drift; ovde je samo PRAVILO (default-include +
  dokumentovan exclude). XML ugovor sa vendorom tražiti sa **punim skupom kolona** allow-tabela —
  jeftinije je ignorisati kolonu u importu nego naknadno tražiti dopunu exporta.

---

### F2.6 Šema-drift (F1) — kako ga sync hvata

Poznati, već dokazani primer (ovaj dokument §3.3): mapa očekuje `BBOdeljenja(OD, OznakaOD, OpisOD)` /
`BBOrgJedinice(OJ, OznakaOJ, OpisOJ)` — po QBigTehn kopiji — a `BB_T_26` original ima `(OD, Naziv)` /
`(OJ, NazivOJ)`. Na direktnom BigBit izvoru takva mapa puca.

**Šta postojeći modul već radi (i šta je dobro):**

- **Skip-ne-abort po redu:** loš red se preskače (`rowsSkipped++`, do 20 poruka u `errors`), sync
  entiteta nastavlja — `customer.syncer.ts` i incremental grana `GenericSyncer`-a.
- **Skip-ne-abort po entitetu:** `SyncService.run` ima per-entity try/catch — pad jedne tabele upiše
  `bb_sync_state.lastErrorMessage` i `perEntity[entity]={error}`, ostale tabele se normalno sinkuju;
  ukupan status postaje `partial` (`failures < requested.length`), ne `failed`.
- Ali drift kolona danas obara **ceo entitet tek u runtime-u** (SELECT nepostojeće kolone / kolona koje
  nema u XML-u) — kasno i sa mutnom porukom.

**Dopuna dizajna — pre-flight „validate-contract" korak po entitetu, pre uvoza:**

1. Izvuci skup stvarnih kolona izvora: za XML — atributi/tagovi prvog record-a (ili XSD ako ga vendor
   da); za MSSQL (prelazni period / Sync C) — `INFORMATION_SCHEMA.COLUMNS`.
2. Uporedi sa `SYNC_MAP[entity].columns[].src`:
   - nedostaje **nullable** kolona → `warning` u log, uvoz ide dalje sa `NULL` za to polje;
   - nedostaje **NOT NULL / PK / watermark** kolona → entitet se markira `failed` PRE ikakvog upisa
     (cache ostaje konzistentan sa prethodnim snapshotom), ostali entiteti nastavljaju;
   - **višak** kolona u izvoru → `info` (kandidat za dopunu mape — hrani F1 inventar).
3. Ceo drift-izveštaj u `bb_sync_log.metadata.driftReport` po entitetu — vidljiv kroz postojeći
   `GET /sync/log/:id`, bez novog API-ja.
4. **Jednokratni tooling pre cutover-a:** skripta koja mapu validira nad PRVIM pravim BigBit exportom
   (paralela postojećem `tools/cutover-verify/`) — drift tipa BBOdeljenja se tako hvata za stolom,
   a ne u prvoj noćnoj sinhronizaciji.

Prag za alarm ostaje postojeći obrazac: `rowsSkipped > 0` → entitet se broji u `failures` → status
`partial` — plus (kad notifikacije ožive po MODULE_SPEC §6.6) email na `failed`/`partial`.
