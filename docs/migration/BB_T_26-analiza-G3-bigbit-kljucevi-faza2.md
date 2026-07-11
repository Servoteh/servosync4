# G3 — BigBit ključevi za Fazu 2 (direktan BigBit→PG UPSERT, 5 mastera)

> Deep-dive uz [BB_T_26_ANALIZA_I_PLAN.md](BB_T_26_ANALIZA_I_PLAN.md) §7.2/§7.3 i
> [F1 — pokrivenost polja](BB_T_26-analiza-F1-pokrivenost-polja.md). Obrađuje 5 Faza-2 tabela:
> `Komitenti`, `Predmeti`, `R_Artikli`, `Cenovnik`, `Magacini`. Cilj: tačne činjenice za UPSERT
> ključeve kad se čita **BigBit ORIGINAL** (drop folder / WinServer skripta → PG), a ne QBigTehn kopija.

## 0. Metod i epistemički status dokaza

- BigBit DDL (`_analiza/bigbit/BB_T_26_schema.sql`) je **mdb-tools izvoz koji NE sadrži PK/indekse/AutoNumber
  markere** (grep na `PRIMARY KEY|CREATE INDEX|ALTER TABLE|COUNTER` = 0 pogodaka; header mdb-tools na
  linijama 1–9). Zato se BigBit PK utvrđuje **trostrano**:
  1. u QBigTehn MSSQL kopiji (`_analiza/qbigtehn_sqlserver.sql`) ista kolona nosi `IDENTITY(1,1)` + `PRIMARY KEY`;
  2. druge BigBit tabele je referenciraju kao FK-kolonu;
  3. mdb-tools obrazac: na svih 5 tabela PK-kandidat je **jedina `Long Integer` kolona bez `NOT NULL`**
     (Access AutoNumber), dok obične `Long Integer` kolone nose `NOT NULL`.
- Tip svih 5 ključeva: Access **Long Integer = 32-bit signed int** → MSSQL `int` → 2.0 `Int`.
- Tvrdnje koje iz DDL-a nisu dokazive (očuvanje ID-a između BigBit i kopije za Komitenti/Predmeti/Magacini,
  jedinstvenost poslovnih ključeva Cenovnika) označene su ⚠️ i traže **živu proveru** pre implementacije.

## 1. Tabela po tabela

### 1.1 Komitenti → `customers`

| Činjenica | Vrednost | Dokaz |
|---|---|---|
| BigBit PK | `Sifra` (Long Integer, AutoNumber) | BB_T_26_schema.sql:2428 (jedina Long Integer bez NOT NULL); kopija: `[Sifra] [int] IDENTITY(1,1)` qbigtehn_sqlserver.sql:1782 + `PK_Komitenti` :1838–1841 |
| FK reference u BigBit-u | `Predmeti.IDKomitent` :865, `Depoziti.IDKomitent` :229, `MestaIsporuke.IDKomitent` :2502, `OK_Zag.IDKomitent` :2536 | BB_T_26_schema.sql |
| Svežina | `PoslednjaIzmena` (DateTime) :2461; sekundarno `PrviUnos` :2460, `DatumIVremeKom` :2469 | BB_T_26_schema.sql; isti watermark već koristi `customer.syncer.ts:39` (`WHERE [PoslednjaIzmena] > @cursor`) |
| Odnos prema 2.0 | `customers.id` = kopija `Sifra`; sync-map `Sifra→id` (sync-map.generated.ts:478–479, watermark `updatedAt` :475) | schema.prisma:165 |
| **UPSERT ključ (BigBit direkt)** | **`Sifra` → `customers.id`** | vidi sudar §2.2 |

⚠️ **Sudar/provera:** kopija `Sifra` je IDENTITY, ali **nema BB-most kolone** (jedina razlika kopije je
1 kolona manje: `KoristiPNBZadModel`, BB :2484 — F1 §1). Interna QBigTehn upotreba (`tRN.BBIDKomitent`
:1665 se JOIN-uje direktno na `Komitenti.Sifra`, npr. qbigtehn_sqlserver.sql:552) sugeriše da kopija
**čuva BigBit šifru 1:1** — ali to iz DDL-a nije dokaz (BBIDKomitent može poticati iz same kopije).
**Preduslov Faze 2: živa provera** `kopija.Sifra+PIB` vs `BigBit.Sifra+PIB` (spot-join). Ako je 1:1,
`Sifra→customers.id` je bezbedan; ako nije — Komitenti dobijaju isti problem kao R_Artikli (§1.3).

### 1.2 Predmeti → `projects`

| Činjenica | Vrednost | Dokaz |
|---|---|---|
| BigBit PK | `IDPredmet` (Long Integer, AutoNumber) | BB_T_26_schema.sql:860; kopija: `IDENTITY(1,1)` qbigtehn_sqlserver.sql:1732 + `PK_Predmeti` :1770–1773 |
| FK reference | BigBit: `PredmetiFaze.IDPredmet` :2584; kopija: `NacrtPrimopredaje`/`tLokacijeDelova` FK :8143–8144/:8233–8234, `tRN.IDPredmet` :1662 | oba DDL-a |
| Svežina | **nema poslednja-izmena kolone.** `DatumIVreme` :893 (F1 §2 → `createdAt`), `DatumOtvaranja` :863, `DatumZakljucenja` :867 | BB_T_26_schema.sql; sync-map watermark `null` (sync-map.generated.ts:2135) → **full refresh** (7.736 redova — prihvatljivo) |
| Odnos prema 2.0 | `projects.id` = kopija `IDPredmet` (sync-map :2138–2139); `projects.customer_id` (schema.prisma:687) pokazuje na `customers.id` prostor | |
| **UPSERT ključ** | **`IDPredmet` → `projects.id`** | |

⚠️ **Sudar/provera:** ANALIZA_I_PLAN.md:92–93 tretira `IDPredmet` kao „zajednički ključ proizvodnje i
komercijale" (osovina) — tj. pretpostavlja isti ID prostor BigBit↔kopija↔2.0. Kao i za Komitente, nema
BB-most kolone, pa 1:1 očuvanje treba potvrditi živo (`BrojPredmeta` Text(20) NOT NULL :861 je dobar
uporedni atribut; kandidat za alternativni prirodni ključ, jedinstvenost neproverena). Ceo proizvodni
lanac 2.0 (`work_orders`→`projects`) visi o ovom prostoru — pogrešna pretpostavka = pogrešno vezani RN-ovi.

### 1.3 R_Artikli → `items` — **JEDINI DOKAZANO RAZDVOJEN ID PROSTOR**

| Činjenica | Vrednost | Dokaz |
|---|---|---|
| BigBit PK | `Sifra artikla` (Long Integer, AutoNumber) | BB_T_26_schema.sql:932; referencirana iz `Cenovnik.[Sifra artikla]` :194, `R_Artikli_BarKod.IDArtikal` :1004, `MPStavkeNivelacije` :551 |
| Kopija | `[Sifra artikla] int IDENTITY(1,1)` = **LOKALNI ključ** (qbigtehn_sqlserver.sql:6499, PK :6567–6570); BigBit šifra u dodatnoj koloni `[BBSifra artikla] int NOT NULL` :6566, `DEFAULT 0` :7575 | |
| Svežina | `DatumIVremeArt` :982 — **jedini datum na artiklu** (F1 §3), semantika = unos, ne izmena; flagovi `ZaBrisanje`/`Aktivan` :975–976 se menjaju **bez timestampa** → **full refresh + UPSERT obavezni** (ANALIZA_I_PLAN.md:190–193) | |
| Odnos prema 2.0 | `items.id` = kopija lokalna šifra (sync-map :2657–2658); **BigBit šifra samo u `items.external_item_id`** (sync-map `BBSifra artikla→externalItemId` :3126–3128; schema.prisma:835) | |
| **UPSERT ključ (BigBit direkt)** | **BigBit `Sifra artikla` → `items.external_item_id`** — **NE `items.id`!** | |

**Sudari (dokazani):**
1. `items.id` i BigBit `Sifra artikla` su **dve nezavisne IDENTITY sekvence od 1** → numerički se
   preklapaju skoro potpuno; upis BigBit šifre u `items.id` bi pregazio tuđe artikle.
2. `items.external_item_id` **nema unique indeks** (schema.prisma:835 — bez `@unique`) i ima
   `@default(0)`; `BBSifra artikla=0` označava artikal kreiran lokalno u QBigTehn kopiji (DF `DEFAULT 0`,
   qbigtehn_sqlserver.sql:7575). **Preduslovi:** provera duplikata + parcijalni unique indeks
   `WHERE external_item_id <> 0`, i UPSERT mora **izuzeti 0**.
3. **Dual-writer:** dok NestJS sync (vasa-SQL) i dalje puni `items`, Faza 2 skripta ne sme da
   **INSERT-uje** nove BigBit artikle sa sopstvenom dodelom `items.id` — QBigTehn IDENTITY će kasnije
   dodeliti isti broj drugom artiklu → PK sudar pri sledećem sync-u. Bezbedno do cutover-a: **UPDATE-only
   preko `external_item_id`**, novi artikli se evidentiraju (park-lista), ne insert-uju.
   Odluka #7 (`items.id` ostaje QBigTehn ili prelazi na BigBit ključ) je **otvorena — Negovan**
   (ANALIZA_I_PLAN.md:119); G3 je ne prejudicira.

### 1.4 Cenovnik → `price_list_entries`

| Činjenica | Vrednost | Dokaz |
|---|---|---|
| BigBit PK | `ID` (Long Integer, AutoNumber) | BB_T_26_schema.sql:193 (jedina bez NOT NULL; uporedi `SYNCH_Cenovnik.ID` **NOT NULL** :1269 — kopirana vrednost, ne counter); kopija: `IDENTITY(1,1)` qbigtehn_sqlserver.sql:6190 + PK :6201–6204 |
| Svežina | **NEMA nijedne datetime kolone** (BB_T_26_schema.sql:191–204) → full refresh + UPSERT obavezni; cena se menja NA POSTOJEĆEM redu (ANALIZA_I_PLAN.md:190–193, odluka #8 :120) | |
| Vezna kolona | BigBit `Cenovnik.[Sifra artikla]` :194 = **BigBit šifra artikla**. U kopiji ista kolona je **REMAPIRANA na lokalnu QBigTehn šifru** — dokaz: FK `Cenovnik_FK00 → R_Artikli([Sifra artikla])` sa CASCADE, qbigtehn_sqlserver.sql:8097–8100; F1 §5 to eksplicitno kaže | |
| Odnos prema 2.0 | `price_list_entries.id` = kopija `ID` (sync-map :335–336); `item_id` = **QBigTehn lokalni prostor** (sync-map `Sifra artikla→itemId` :342–343; FK na `items.id` schema.prisma:109,119). Kolone `warehouse_id` u Cenovniku **nema** — magacin se ne pojavljuje u cenovniku ni u BigBit-u ni u 2.0 (schema.prisma:107–123) | |
| **UPSERT ključ (BigBit direkt)** | **NE po `id`.** BigBit `Cenovnik.ID` i kopija-`ID` su nezavisne IDENTITY/AutoNumber sekvence **bez most kolone** → `price_list_entries.id` je neuporediv sa BigBit `ID`. Preporuka: **poslovni ključ `(item_id, document_type_code)`** gde je `item_id` dobijen remapom BigBit `Sifra artikla` → `items.external_item_id` → `items.id` | |

⚠️ **Preduslovi:** (a) jedinstvenost `([Sifra artikla],[Vrsta dokumenta])` u BigBit-u nije dokaziva iz
DDL-a (mdb izvoz nema indekse) — proveriti živo `COUNT(*) vs COUNT(DISTINCT ...)`; (b) 2.0 nema
`@@unique(itemId, documentTypeId)` (schema.prisma:107–123) — dodati pre business-key UPSERT-a;
(c) redovi čiji BigBit artikal nema pandan u `items.external_item_id` → skip + evidencija (batch-resolve,
ne abort). Alternativa poslovnom ključu: dodati `external_pricelist_id` most kolonu (ista šema-tehnika
kao `BBSifra artikla`), ali to je izmena cache šeme → ide uz odluku #7/#8.

### 1.5 Magacini → `warehouses`

| Činjenica | Vrednost | Dokaz |
|---|---|---|
| BigBit PK | `IDMagacin` (Long Integer, AutoNumber) | BB_T_26_schema.sql:529 (jedina bez NOT NULL; `IDFirma` :528 je NOT NULL); kopija: `IDENTITY(1,1)` qbigtehn_sqlserver.sql:6267 + `PK_Magacini` samo nad `IDMagacin` :6277–6280 |
| Multi-firma | `IDFirma` je dimenzija, **ne deo PK** (kopija PK je samo IDMagacin); drift: BB NOT NULL → kopija NULL (qbigtehn :6266; F1 §6) | |
| Svežina | **nema datetime kolona** (BB_T_26_schema.sql:526–539); 3 reda (ANALIZA_I_PLAN.md:33) → full refresh trivijalan; sync-map watermark `null` :1186 | |
| Odnos prema 2.0 | `warehouses.id` = kopija `IDMagacin` (schema.prisma:481). Potrošači `warehouse_id` prostora u 2.0: `document_types.default_warehouse_id` (schema.prisma:891, iz `IDMagacinZaVrstuDok` — F1 §8), `goods_documents.warehouse_id` :1071, `goods_document_items.warehouse_id` :1143, `goods_document_items_mirror.warehouse_id` :1001 — **svi u QBigTehn kopija-prostoru** | |
| **UPSERT ključ** | **`IDMagacin` → `warehouses.id`** (uz istu ⚠️ živu proveru očuvanja ID-a kao §1.1; sa 3 reda provera je trivijalna — uporediti nazive) | |

## 2. Zbirno

### 2.1 UPSERT ključevi Faze 2 (BigBit direkt)

| BigBit tabela | BigBit PK (int32) | Svežina u BigBit-u | UPSERT ključ u 2.0 | Strategija |
|---|---|---|---|---|
| Komitenti | `Sifra` | `PoslednjaIzmena` ✅ watermark | `customers.id` ⚠️ posle žive provere prostora | inkrementalno moguće |
| Predmeti | `IDPredmet` | samo `DatumIVreme` (unos) → nedovoljno | `projects.id` ⚠️ ista provera | full refresh (7,7k) |
| R_Artikli | `Sifra artikla` | samo `DatumIVremeArt` (unos); flagovi bez datuma | **`items.external_item_id`** (≠0, unique indeks fali) | full refresh + **UPDATE-only** do odluke #7 |
| Cenovnik | `ID` (neuporediv sa 2.0 `id`) | **nema datuma** | poslovni ključ `(item_id po remapu, document_type_code)` ⚠️ | full refresh + UPSERT (odluka #8) |
| Magacini | `IDMagacin` | **nema datuma** | `warehouses.id` | full refresh (3 reda) |

### 2.2 Gde nastaje sudar sa QBigTehn ID prostorom

1. **`items` — dokazan sudar:** kopija je preimenovala prostor (`Sifra artikla` = lokalni IDENTITY,
   qbigtehn:6499; BigBit šifra samo u `BBSifra artikla` :6566). Sve postojeće FK veze 2.0
   (`price_list_entries.item_id`, MRP, robne stavke, `work_order_item_components`) žive u
   **QBigTehn prostoru**. BigBit šifra sme da dodirne isključivo `items.external_item_id`.
2. **`price_list_entries.id` — sudar po konstrukciji:** dve nezavisne auto-sekvence bez most kolone;
   surogat `id` se ne sme koristiti kao UPSERT ključ iz BigBit-a.
3. **`customers`/`projects`/`warehouses` — uslovno bez sudara:** kopija koristi IDENTITY, ali bez
   BB-most kolona; radna pretpostavka QBigTehn koda (`tRN.BBIDKomitent = Komitenti.Sifra`,
   qbigtehn:552) i plana (`IDPredmet` osovina, ANALIZA_I_PLAN.md:92) je 1:1 očuvanje → **obavezna živa
   verifikacija pre prvog upisa** (spot-join po PIB/BrojPredmeta/Magacin nazivu).
4. **Dual-writer prelazni period:** dok NestJS sync modul i dalje piše iste tabele iz vasa-SQL,
   Faza 2 skripta i modul su **dva pisca nad istim redovima** (last-writer-wins). Po planu §7.3
   (ANALIZA_I_PLAN.md:174–177) masteri se izmeštaju iz NestJS modula — do tada Faza 2 ne sme
   INSERT-ovati nove ID-eve u tabele sa QBigTehn IDENTITY poreklom (naročito `items`, §1.3).

### 2.3 Preduslovi pre implementacije (redosled)

1. Živa verifikacija ID prostora Komitenti/Predmeti/Magacini (BigBit vs kopija, spot-join).
2. Provera duplikata pa parcijalni unique indeks na `items.external_item_id` (`WHERE external_item_id <> 0`).
3. Provera jedinstvenosti `([Sifra artikla],[Vrsta dokumenta])` u BigBit Cenovniku; ako drži —
   `@@unique` na `price_list_entries(item_id, document_type_code)`.
4. Odluke #7 (items ključ) i #8 (UPSERT za Cenovnik/R_Artikli flagove) — Negovan (ANALIZA_I_PLAN.md:119–120).
5. Redosled upisa u jednom run-u: Komitenti → Magacini → Predmeti → R_Artikli → Cenovnik
   (Cenovnik poslednji jer zavisi od remapa artikala); obrazac = pilot §7.5 (staging temp +
   `INSERT … ON CONFLICT DO UPDATE`, jedna transakcija, idempotentno).
