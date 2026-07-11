## G1 — Zašto lokalni ID: rekonstrukcija porekla surogat ključa u QBigTehn kopiji

> **Pitanje:** zašto je QBigTehn uveo LOKALNI surogat (`[Sifra artikla] IDENTITY`) umesto da koristi
> BigBit šifru kao ključ — i šta to znači za Fazu 2 (direktan BigBit→PG sync za `Komitenti`, `Predmeti`,
> `R_Artikli`, `Cenovnik`, `Magacini`)?
>
> **Izvori dokaza:** `_analiza/qbigtehn_sqlserver.sql` (MSSQL DDL QBigTehn kopije),
> `_analiza/bigbit/BB_T_26_schema.sql` (mdb-tools izvoz BigBit Access originala),
> [06-bigbit-preuzmi-iz-bb.md](06-bigbit-preuzmi-iz-bb.md) (VBA import logika),
> `backend/prisma/schema.prisma` + `backend/src/modules/sync/sync-map.generated.ts` (2.0 target).
> Nadovezuje se na [F1 §Drift](BB_T_26-analiza-F1-pokrivenost-polja.md) (ŠTA je drift) — ovde je ZAŠTO.

### Kratak odgovor

Lokalni IDENTITY **nije uveden za svih 5 tabela — uveden je samo tamo gde QBigTehn sam kreira redove**
(`R_Artikli`) ili gde BigBit uopšte nema stabilan numerički ključ za preuzimanje (`Cenovnik`, `Magacini`
ne idu kroz „Preuzmi iz BB"). Tamo gde je QBigTehn čist konzument (`Komitenti`, `Predmeti`), BigBit ključ
se prenosi 1:1 i IDENTITY služi samo da nastavi numeraciju — ID prostori se poklapaju. `R_Artikli` je
jedina tabela sa pravim **dual key** obrascem (`Sifra artikla` lokalno + `BBSifra artikla` BigBit), i to
zato što proizvodni core (RN, TP, PDM/BOM) kreira sopstvene artikle (mašinske delove, poluproizvode) koji
u BigBit-u ne postoje — deljenje ID prostora sa BigBit-om bi garantovalo kolizije.

### 1. Pregled: 5 tabela × 3 pitanja (sa DDL dokazima)

| Tabela | BigBit PK (tip) | QBigTehn PK / IDENTITY | BB* most-kolona (dual key)? | ID prostor |
|---|---|---|---|---|
| **R_Artikli** | `[Sifra artikla]` Long Integer, numerički (BB_T_26_schema.sql:932) | `[Sifra artikla] int IDENTITY(1,1)`, PK (qbigtehn_sqlserver.sql:6499, 6567–6570) | **DA**: `[BBSifra artikla] int NOT NULL` (6566), `DEFAULT ((0))` (7575) | **RAZDVOJEN** — pravi dual key |
| **Komitenti** | `[Sifra]` Long Integer (BB_T_26_schema.sql:2428) | `[Sifra] int IDENTITY(1,1)`, PK (1782, 1838–1841) | NE | **POKLAPA SE** — import prenosi `Sifra` 1:1 ([06 §2.3](06-bigbit-preuzmi-iz-bb.md)) |
| **Predmeti** | `[IDPredmet]` Long Integer (BB_T_26_schema.sql:860) | `[IDPredmet] int IDENTITY(1,1)`, PK (1732, 1770–1773) | NE | **POKLAPA SE** — import sa IDENTITY_INSERT ([06 §2.4](06-bigbit-preuzmi-iz-bb.md)) |
| **Cenovnik** | `[ID]` Long Integer (BB_T_26_schema.sql:193); pravi identitet reda je `(Sifra artikla, Vrsta dokumenta, Tarifa)` | `[ID] int IDENTITY(1,1)`, PK (6190, 6201–6204) | NE — ali `[Sifra artikla] int NOT NULL` (6191) sa FK na **lokalni** `R_Artikli.[Sifra artikla]` (8097–8098) | **RAZDVOJEN posredno** — redovi vise o lokalnom ID artikla |
| **Magacini** | `[IDMagacin]` Long Integer, uz `[IDFirma] NOT NULL` (BB_T_26_schema.sql:528–529 — BigBit je multi-firma) | `[IDMagacin] int IDENTITY(1,1)`, PK (6267, 6277–6280); `IDFirma` degradiran u NULL-abilan atribut (6266) | NE | **NEPOZNATO** — nije u „Preuzmi iz BB" ([06 §Tabele koje NISU u dugmetu](06-bigbit-preuzmi-iz-bb.md)); mala tabela, verovatno ručno unet sadržaj |

Napomena o BigBit tipovima: mdb-tools izvoz ne beleži PK, indekse ni AutoNumber — u celom
`BB_T_26_schema.sql` nema nijednog `PRIMARY KEY`/`CREATE INDEX`/`Counter` (grep bez pogotka). Indikacija
da su navedene kolone Access **AutoNumber (Counter)**: u sve 5 tabela ID kolona je jedina „Long Integer"
**bez** `NOT NULL` (R_Artikli:932, Komitenti:2428, Predmeti:860, Cenovnik:193, Magacini:529), dok su sve
FK „Long Integer" kolone dosledno `NOT NULL`. To je heuristika izvoza, ne tvrd dokaz — ali je obrazac
100% dosledan kroz svih 207 tabela. **Bitno: nijedan od 5 BigBit ključeva nije tekst-šifra** (za razliku
od šifarnika `R_Grupa`/`R_Tarife`/`R_Vrste dokumenata` gde je BigBit PK tekst — v. F1 §Drift red 2–3).

### 2. Ključna asimetrija: gde se BigBit ključ ČUVA, a gde NE

Legacy VBA „Preuzmi iz BB" ([06 §2](06-bigbit-preuzmi-iz-bb.md)) tretira tabele različito:

- **Komitenti (§2.3) i Predmeti (§2.4):** BigBit ključ (`Sifra`, `IDPredmet`) se prenosi **kao vrednost**,
  uprkos tome što je ciljna kolona IDENTITY (za Predmete doc eksplicitno beleži IDENTITY_INSERT). IDENTITY
  ovde samo nastavlja numeraciju za eventualne lokalne redove — praktično ga QBigTehn ne koristi kao
  generator, već kao „usvojeni" BigBit ključ.
- **R_Artikli (§2.5):** eksplicitno **„bez IDENTITY_INSERT; cilj auto-generiše"** — BigBit
  `[Sifra artikla]` se upisuje u `[BBSifra artikla]`, a anti-join za detekciju novih redova ide na
  `EXT_R_Artikli.[Sifra artikla] = R_Artikli.[BBSifra artikla]`. Lokalni PK dobija novu, nezavisnu vrednost.

Da su ID prostori Komitenata zaista deljeni potvrđuje i to što proizvodna tabela `tRN` denormalizuje
`[BBIDKomitent] int NOT NULL` (qbigtehn_sqlserver.sql:1665) i procedure ga direktno porede sa parametrom
komitenta (npr. 5508: `[tRN].[BBIDKomitent] = @ZaKomitenta`) — `BB` prefiks je tu **konvencija porekla**
(„polje došlo iz BigBit sveta"), ne znak zasebnog ID prostora. Kod artikala isti prefiks
(`BBSifra artikla`) označava STVARNO drugi ID prostor — ista konvencija imenovanja, dva različita značenja.

### 3. Hipoteze ZAŠTO — sa dokazima

#### H1 (primarna, potvrđena DDL-om): QBigTehn lokalno kreira artikle → deljenje ID prostora bi kolidiralo

- `DEFAULT ((0)) FOR [BBSifra artikla]` (qbigtehn_sqlserver.sql:7575): predviđen je legalan način da red
  artikla postoji **bez** BigBit šifre (`BBSifra = 0` = „nije iz BigBit-a"). Da je tabela čista kopija,
  default bi bio besmislen — svaki red bi imao pravu BB šifru. Kolona je uz to `NOT NULL`, dakle 0 je
  namerna sentinel vrednost, ne „nepoznato".
- Proizvodne tabele FK-uju na **lokalni** ključ: `FK_tRNNDKomponente_R_Artikli` →
  `R_Artikli([Sifra artikla])` (8336–8337) i `Cenovnik_FK00` → isto (8097–8098). Proizvodni core je
  vlasnik tog ID prostora.
- 2.0 nasleđe istog stanja: `Item.externalItemId @default(0)` (schema.prisma:835) — i u Postgres kopiji
  postoje artikli sa `external_item_id = 0`, tj. artikli koje BigBit nikad nije video.
- Domenski smisao: BigBit vodi komercijalne artikle (roba, tarife, cene), a tehnolozi u QBigTehn-u prave
  artikle za mašinske delove/poluproizvode iz crteža pre nego što (i ako ikad) uđu u BigBit. Kada bi
  QBigTehn upisivao lokalne artikle u BigBit-ov ID prostor, prvi sledeći BigBit AutoNumber sa istom
  vrednošću pravi koliziju — surogat + most-kolona je standardno rešenje.
- Kontrast koji hipotezu čini dovoljnom: Komitente i Predmete QBigTehn **ne kreira** (čist konzument) —
  i upravo tamo BigBit ključ jeste zadržan. Lokalni ID postoji tačno tamo gde postoji lokalno pisanje.

#### H2 (istorijat/retrofit, jaka indikacija): `BBSifra artikla` je NAKNADNO dodata kolona

- U scripted DDL-u SQL Server-a redosled kolona = redosled kreiranja. `[BBSifra artikla]` je
  **poslednja od 68 kolona** (qbigtehn_sqlserver.sql:6566, iza `Debljina`), iako sadržajno pripada uz PK;
  njen default je dodat zasebnim `ALTER TABLE` (7575). U BigBit originalu kolona ne postoji
  (BB_T_26_schema.sql:930–999, 67 kolona).
- Tumačenje: `R_Artikli` u QBigTehn-u je prvo živeo kao samostalan lokalni šifarnik (IDENTITY od
  početka), a most ka BigBit-u je doguran kasnije, kada je uveden import „Preuzmi iz BB". Lokalni ID
  dakle nije bio „odluka protiv" BigBit šifre — postojao je pre nego što je uvoz uopšte napravljen, a
  retrofit ključa u tada već referenciranu tabelu (FK-ovi iz Cenovnika i RN tabela) bio bi preskup.

#### H3 (Access AutoNumber navika, potvrđena obrascem): surogat-po-defaultu je kućni stil oba sistema

- QBigTehn kopija ima **54 tabele sa `IDENTITY(1,1)`** (grep count nad qbigtehn_sqlserver.sql) — surogat
  int ključ je podrazumevani obrazac, uključujući i tabele gde BigBit uopšte nema numerički ključ:
  `R_Tarife` (6624) i `R_Vrste dokumenata` (6647) dobile su `ID IDENTITY` iako je BigBit PK tekst-šifra
  (F1 §Drift red 2–3).
- BigBit (Access) koristi isti stil: prva kolona `ID`/`ID<Nesto>` AutoNumber u praktično svakoj tabeli
  (v. obrazac bez `NOT NULL` iz §1). QBigTehn je nastao kao Access frontend uz SQL Server
  (v. [01-qbigtehn-architecture-analysis.md](01-qbigtehn-architecture-analysis.md)); `IDENTITY(1,1)` je
  direktan prevod AutoNumber navike pri upsizing-u. Ovo objašnjava FORMU rešenja (zašto baš IDENTITY),
  dok H1 objašnjava POTREBU (zašto poseban prostor).

#### H4 (merge više izvora / godišnje BigBit baze, NEPOTVRĐENA — ne osloniti se)

- Indikacije da BigBit svet ima više fizičkih baza kroz vreme: legacy linkovi čitaju lager iz
  `BB_T_25.MDB` dok je analizirani snapshot `BB_T_26` ([06 §3–4](06-bigbit-preuzmi-iz-bb.md)) — godišnja
  smena baza je realna. BigBit interno ima i sopstvene sync tabele `SYNCH_Cenovnik` / `SYNCH_R_Poreklo`
  (BB_T_26_schema.sql:1267, 1281) i radnu `R_Artikli_TMP` (2618), što sugeriše da ni BigBit-u ID higijena
  artikala nije trivijalna.
- ALI: nema dokaza da se `Sifra artikla` menja između godišnjih baza, niti da je QBigTehn ikada spajao
  dva BigBit izvora u isti šifarnik. Ako matični podaci žive u jednoj kontinuiranoj bazi a godišnje se
  smenjuju samo dokumenta/lager, ova hipoteza otpada kao motiv. Tretirati kao moguće pojačanje H1, ne kao
  samostalan razlog. **Provera za Fazu 2 (Negovan):** da li je `BB_T_26.R_Artikli.[Sifra artikla]`
  stabilna kroz godine, tj. da li BB_T_27 nasleđuje iste vrednosti.

#### Odbačeno: „offline rad / lokalna numeracija zbog prekida veze"

Nema DDL traga (nema replication/rowguid/tombstone kolona u 5 tabela), a import je jednosmeran pull na
dugme — lokalni ID kod artikala postoji zbog lokalnog VLASNIŠTVA (H1), ne zbog offline režima.

### 4. Gde živi znanje o mapiranju: SAMO u VBA frontendu

U celom SQL dumpu (~37k linija, tabele + procedure + view-ovi) `[BBSifra artikla]` se pominje **tačno
dva puta — oba u DDL-u** (definicija 6566 i default 7575). Nijedna procedura, view ni trigger ne koristi
most-kolonu: kompletna logika remapiranja (anti-join, `[Sifra artikla] AS [BBSifra artikla]`) živi u
Access VBA (`DodajNoveArtikleIzBigBita`, [06 §2.5](06-bigbit-preuzmi-iz-bb.md)). Posledica: gašenjem
Access frontenda znanje o mostu nestaje iz runtime-a — Faza 2 ga mora reimplementirati u sync servisu,
nema ničeg za „preuzeti" na SQL strani.

### 5. Posledice po Fazu 2 (drop-folder BigBit→PG)

1. **`items.id` OSTAJE u QBigTehn ID prostoru** — to je odluka nasleđena kroz ceo lanac: 2.0 sync mapira
   `R_Artikli.[Sifra artikla]` (lokalni) → `items.id` (sync-map.generated.ts:2647–2652), a BigBit šifru u
   `items.external_item_id` (3126–3131; schema.prisma:835). Direktan BigBit fajl nosi **BigBit** šifru →
   syncer artikala mora raditi **remap preko `external_item_id`**, nikako upis BigBit šifre u `items.id`.
2. **`external_item_id` nije pouzdan ključ bez ograde:** `@default(0)` znači da lokalno kreirani artikli
   dele vrednost 0 — anti-join/upsert ključ mora biti `external_item_id > 0`, i vredi dodati parcijalni
   unique indeks (`WHERE external_item_id > 0`) pre nego što Faza 2 krene da upsert-uje po njemu (ni
   QBigTehn nema ni indeks ni unique na `[BBSifra artikla]` — u DDL-u ne postoji nijedan nonclustered
   indeks na 5 tabela).
3. **`Cenovnik` zahteva dvostepeni remap:** BigBit red nosi `(Sifra artikla_BB, Vrsta dokumenta, Tarifa)`;
   pre upisa u `price_list_entries` (itemId → lokalni, schema.prisma:108–109) BigBit šifru treba
   prevesti kroz `items.external_item_id`. BigBit `Cenovnik.ID` NE koristiti (AutoNumber originala,
   nema ga u lancu ključeva); prirodni ključ za upsert = `(item_id, document_type_code, tax_rate_code)` —
   u skladu sa F2 odlukom da je Cenovnik UPSERT izuzetak (F2 red 173).
4. **`Komitenti` i `Predmeti` su jednostavni:** ID prostori se poklapaju (§2), BigBit `Sifra`/`IDPredmet`
   = `customers.id`/`projects.id` — upsert direktno po PK. Jedina ograda: ako QBigTehn ikad lokalno doda
   komitenta/predmet iznad BigBit max ID-a, BigBit AutoNumber vremenom stiže do te vrednosti — proveriti
   `MAX(id)` obe strane pre prvog Faza-2 uvoza.
5. **`Magacini` traži odluku:** nije u „Preuzmi iz BB", pa poklapanje `warehouses.id` sa BigBit
   `IDMagacin` niko nikad nije garantovao; uz to BigBit ima multi-firma dimenziju (`IDFirma NOT NULL`,
   BB_T_26_schema.sql:528) koju kopija ne koristi kao deo ključa. Pre sync-a: ručno uporediti sadržaj
   (tabela je mala) i odlučiti — mapiranje po `IDMagacin` uz filter `IDFirma`, ili po nazivu `Magacin`.
6. **Opšte pravilo iz G1:** BigBit numerički ključ sme direktno u 2.0 PK **samo** tamo gde je legacy već
   delio ID prostor (Komitenti, Predmeti). Svuda gde je QBigTehn imao lokalni identitet (R_Artikli) ili
   gde mapiranje nikad nije postojalo (Magacini, Cenovnik.ID), Faza 2 mora ići preko most-kolone ili
   prirodnog ključa — ponavljanje legacy greške „upiši tuđ ID u svoj IDENTITY" bi pokidalo sve postojeće
   FK-ove proizvodnog core-a (§3 H1).

### Zaključak

Lokalni `[Sifra artikla] IDENTITY` nije hir nego posledica vlasništva: QBigTehn je proizvodni sistem koji
sam rađa artikle, pa mu je trebao sopstveni, koliziono bezbedan ID prostor (H1), realizovan kućnim
Access/IDENTITY stilom (H3), na tabeli koja je postojala pre BigBit mosta pa je `BBSifra artikla`
retrofitovana kao poslednja kolona (H2). Za ostale 4 tabele lokalni IDENTITY je ili kozmetika preko
usvojenog BigBit ključa (Komitenti, Predmeti) ili tehnički surogat bez ikakvog mapiranja (Cenovnik.ID,
Magacini). Faza 2 zato nema jedan obrazac ključa nego tri: direktan PK (Komitenti, Predmeti), remap preko
`external_item_id` (R_Artikli, posredno Cenovnik) i tabelu koja prvo traži ručno poravnanje (Magacini).
