# ServoSync — preostale faze (stanje 2026-07-13)

> Šta je urađeno zaključno sa danas i **šta konkretno ostaje** do 4.0. Autoritativni
> plan verzija ostaje [ROADMAP.md](ROADMAP.md); ovaj dokument je „operativni TODO" —
> radne linije koje su u toku, sa jasnim gate-ovima. Detalji BigBit sync-a:
> [migration/BB_T_26_ANALIZA_I_PLAN.md](migration/BB_T_26_ANALIZA_I_PLAN.md).

## 1. ServoSync 2.0 — modul „Tehnologija" (praktično završen)

Proizvodni core je **živ na produkciji** i spojen u 1.5 na `servosync.servoteh.com/tehnologija`.
Kraj-do-kraja rade: Radni nalozi, Tehnološki postupci (+ kartica po operaciji), PDM/Crteži
(rekurzivni BOM), Nacrti + Primopredaje (ceo tok odobravanja P0–P5), Lokacije delova, Proizvodne
strukture, MRP/Nabavka (uvid), Komitenti/Predmeti (pregled), barkod (RN dokument + kiosk).

**Živo od poslednjeg roadmap checkpointa (danas i prethodnih dana):**
- **Tehnolog tok (P0–P5):** dodela tehnologa pri **odobravanju** primopredaje (ne pri lansiranju),
  „Otkucaj TP" iz primopredaje, undo/vraćanje odobrenih, pretraga po tehnologu, notifikacije dorade.
- **Automatski uvoz PDM XML-a — ŽIV:** `pdm-bridge` na ubuntu serveru (systemd timer 5 min, CIFS mount
  ka PDM/BigBit share-ovima) čita XML i šalje u `POST /pdm/import`; PDF crtež se ne briše.
- **RBAC enforced na produkciji** (`AUTHZ_ENFORCE=true`); 5 kontrolora, SoD pravila.
- **Batch print** crteža sa izborom štampača (ploter/A4), zbir po operaciji, RN barkod verzioni guard.
- **Probe na produkciji + dorade 12–13.07 (ODLUKE #33–#36):**
  - `/nacrti` (gate `primopredaje.write`) i `/handovers` (gate `primopredaje.approve`) razdvojeni;
    tehnolog+menadzment dobili `primopredaje.approve` (menadzment privremeno).
  - **Paket A** (#34): tehnolozi vezani na radnike (`users.worker_id`), HITNO flag (`is_urgent` +
    badge/RN-štampa), kolone Radnik/Tehnolog u Realizaciji, „PDF crteža" u detalju, tab „Na pisanju"
    + `writing-stats`.
  - **Paket B** (#35): poreklo dorada/škart RN-a (`parent_work_order_id`, filter `?reworkOnly`),
    `locations[]` u listi RN + kolona Lokacija na `/completed-orders`, **NOVI modul `cnc-programs`**
    (tabela `cnc_programs`, lista pozicija + ček „CAM urađen", nav „CAM programiranje").
  - **Proba r1:** AUTO-BOM (sklop izlistava pozicije iz sastavnice), `designerId` opcion + projektant
    ComboBox, `GET /handovers/engineers`, labela „Predao (projektant)".
  - **Proba r2** (#36): `approve-batch`/`reject-batch` (grupno po nacrtu; lansiranje pojedinačno),
    kiosk „Moji otvoreni" (`GET /tech-processes/worker/open`, zatvaranje bez skeniranja), CAM filter
    549→271, dimenzija materijala u RN štampi, kvalitet badge.
  - **E2E tok na produ + fix `b064a96`** (id-floor: native primopredaje od 10000+); **login parnost
    1.0→2.0** (27 update + 31 insert, backup `users_pwhash_backup_20260713`) + 17 biro naloga;
    sidebar stavke Kucanje/Kontrola (pogon) uklonjene (ulaz `/kiosk` / 1.0 HUB). PDF gap:
    [design/PDF_GAP_2026-07-13.md](design/PDF_GAP_2026-07-13.md).

**Preostalo za 2.0 = uglavnom kozmetika, ne izgradnja:** UI dorade, sitni bugfix, poravnavanje
naziva sa QBigTehn-om. „Imamo aplikaciju 2.0" je ispunjeno — mada je 12–13.07 ipak isporučen i
jedan mali novi modul (`cnc-programs`/CAM programiranje), pa „kozmetika" važi od ovog checkpointa.

---

## 2. BigBit → 2.0 sync (nova radna linija, otvorena 11–12.07)

Trajni matični sync iz BigBit ERP-a (Access `.mdb`) u 2.0 PostgreSQL. **Odluka izvora (Nenad 11.07):
skripta na ubuntu serveru čita `mdb-tools`-om i piše direktno u PG** — NE XML export, NE preko NestJS
sync modula (menja stariju §11.2a odluku). Alat: [`tools/bigbit-bridge/`](../tools/bigbit-bridge/).
Mehanizam: BigBit noćni izvoz → SMB drop share `\\192.168.64.28\bigbit-incoming` (nalog `bbdrop`) →
`mdb-export` (ignoriše ULS, bez lozinke) → staging + `INSERT … ON CONFLICT DO UPDATE` (UPSERT, nikad
delete) preko lokalnog `docker exec servosync-pg psql`.

### Faza 1 — šifarnici artikala ✅ ŽIVO
`R_Grupa/R_Podgrupa/R_Poreklo` → `item_groups/item_subgroups/item_origins` (19/86/128). Artikli su
prvi put dobili nazive grupa/podgrupa/porekla. Idempotentno, dnevni ritam (timer 05:30 — ostaje uključiti).

### Faza 2 — matične tabele (pripremljeno, GATED do cutover-a)
ID-prostor rešen (Fable analiza §7.6, opcija A): `items.id` ostaje QBigTehn ključ, BigBit se veže
preko `items.external_item_id`.

| Tabela | Cilj | Stanje |
|---|---|---|
| **Magacini** | `warehouses` | ✅ **ŽIVO** (3, cilj bio prazan — nije MSSQL-sync tabela) |
| **Komitenti** | `customers` | 📝 napisano, dry-run čisto — **ISKLJUČENO do cutover-a** |
| **Predmeti** | `projects` | 📝 napisano, dry-run čisto — **ISKLJUČENO do cutover-a** |
| **R_Artikli** | `items` | 📝 napisano (UPDATE-only preko `external_item_id`) — **ISKLJUČENO do cutover-a** |
| **Cenovnik** | `price_list_entries` | ⏳ **TODO**: napisati `sql/`; treba `@@unique` poslovni ključ + remap artikla |

> ⚠️ **Zašto gated (Nenad 12.07):** ove tabele drži **živi MSSQL (QBigTehn) sync**. BigBit se ne sme
> prepisivati preko njega dok se ne uradi cutover („jedan pisac po tabeli"). U `tables.manifest` stoje
> zakomentarisane. Dry-run pokazuje da bi BigBit „ažurirao" skoro sve redove jer nosi polja koja MSSQL
> sync ostavlja prazna (`code_type_code`, `salesperson_id`) — bogatiji podatak koji stiže na cutover-u.

**Pre aktivacije Faze 2 (na cutover-u):**
1. Napisati `Cenovnik → price_list_entries` (+ migracija: `@@unique(item_id, document_type_code,
   tax_rate_code)` i parcijalni `uq_items_external_item_id WHERE external_item_id <> 0`).
2. **Field-level diff za `items`** — dry-run pokazuje 90.984 „update" bez FK razloga (verovatno
   reprezentacija: trailing space / NULL-vs-0), da gard hvata samo prave izmene, ne pun rewrite.
3. **Spot-provera 1:1 ID-a:** Komitenti (PIB), Predmeti (BrojPredmeta), Magacini (naziv).
4. Uključiti timer (`install-timer.sh`, 05:30) i BigBit noćni copy task na drop share.

### Faza 3 — ostatak KEEP-SYNC (~49 tabela, kad zatreba)
Dodavanje tabele = red u `tables.manifest` + `sql/<t>.sql`. Ide po potrebi modula koji je čita, ne
paušalno. EXCLUDE-TVRDO (55) se nikad ne kopira; ODLOŽI-4.0 (103) čeka 4.0 domene. Inventar:
[migration/BB_T_26-analiza-F3-inventar-207-tabela.md](migration/BB_T_26-analiza-F3-inventar-207-tabela.md).

---

## 3. Cutover — gašenje QBigTehn MSSQL sync-a (kritičan prelaz)

Kad proizvodnja pređe potpuno na 2.0 kao izvor istine:
1. **Aktivirati BigBit master sync** (Faza 2: customers/projects/items/Cenovnik) — BigBit postaje jedini
   pisac matičnih; `items` prelazi iz UPDATE-only u pun INSERT, park-lista novih artikala se prazni.
2. **1.0 Lokacije most** (`loc_*`) repointovati sa QBigTehn cache-a na 2.0 `tech_processes`, outbound
   `sp_ApplyLocationEvent` ugasiti/preusmeriti — vidi [ROADMAP „Sync tokom tranzicije"](ROADMAP.md).
   **Ne gasiti QBigTehn dok ovaj most nije prebačen.**
3. Ugasiti Sync A (QBigTehn MSSQL, `vasa-SQL:5765`); proizvodne tabele su već ServoSync vlasništvo.

---

## 4. Dalje — 3.0 i 4.0 (nepromenjen plan, vidi ROADMAP)

- **3.0** — prebacivanje ServoSync 1.0 (Supabase moduli) na stack 2.0 i spajanje u jednu aplikaciju.
  Najveći deo: 293 RLS + 238 SECURITY DEFINER → NestJS guardovi. Podaci već na on-prem PG (međukorak).
- **4.0** — apsorpcija BigBit ERP-a (GK/PDV/SEF/fakture/nabavka/carina). Bez roka, trigerima. Matične
  tabele iz Faze 2 tada prelaze iz cache → vlasništvo. Pun materijal spreman ([migration/09–14](migration/README.md)).

---

*Poslednji update: 2026-07-13 — probe na produkciji + paketi dorada A/B isporučeni (ODLUKE
#33–#36, uklj. novi mali modul `cnc-programs`), login parnost 1.0→2.0; BigBit sync linija
nepromenjena (Faza 1 živa, Faza 2 gated do cutover-a); 2.0 „Tehnologija" praktično završen.*

---

## 🔶 OTVORENO NA DAN 01.08.2026

Pitanja koja **blokiraju** deo funkcionalnosti, a odgovor NIJE tehnički — traži knjigovođu
odn. vlasnika. Ne rešavati ih pretpostavkom; dok odgovor ne stigne, kod ih vidljivo odbija.

### O-PDV-8 — nema konta izlaznog PDV-a po stopi od 8 %

**Nalaz (02.08.2026, peti krug provere štampe faktura).** Ručno knjiženje izlaznog računa
(`sales/fakturisanje.service.ts`, `buildSalesLedgerLines`) je svaku stopu koja nije 20 %
knjižilo na konto **`4702` — „PDV 20 % na prodate robe na domaćem tržištu"**, jer je pravilo
bilo „ako je šifra `2` → 4710, INAČE → 4702".

> ⚠️ **ISPRAVKA OPISA (02.08.2026, šesti krug — v. N1 niže).** Prva verzija ovog nalaza je
> tvrdila da je „šifra 4 = posebna stopa 8 % (POLJO)". To je **netačno**: po stvarnim
> redovima `R_Tarife` šifra **„4" je NIZA 10 %**, a POLJO 8 % je šifra **„5"**. Sama brana
> je i dalje ispravna i radi po PROCENTU (ne po šifri), pa je ispravka mapiranja nije
> pomerila — ali se na nju sada stiže **samo šifrom „5"**, koju na produkciji ne nosi
> nijedan artikal (izmereno: 0 od 92.575). Pitanja ispod su prepravljena na tačne šifre.

**Zašto to nije bezopasno.** Nalog bi balansirao (isti iznos stoji i na dugovnoj strani), pa
se greška ne vidi u GK. Ali POPDV polje **3.2** osnovicu IZVODI iz konta `4702` deljenjem sa
0,2 (`popdv_account_map`, `column_def = 'P/0.2'`), a KIF isto tako (`pdv/vat-ledger.service.ts`,
`deriveBase`) — pa bi osnovica prometa oporezovanog po 8 % ušla u poreski obrazac **umanjena
za 60 %**.

**Zašto nije popravljeno.** Konto izlaznog PDV-a od 8 % **u kontnom planu ne postoji**.
Provereno u `prisma/migrations/20260723155000_seed_chart_of_accounts/migration.sql` i u
`prisma/seed/vat-account-map.sql`: postoji jedino `4750 — PDV po osnovu SOPSTVENE POTROŠNJE
8 %`, što je drugi promet (sopstvena potrošnja, ne izdata faktura). Konto se ne izmišlja.

**Šta kod radi u međuvremenu.** Knjiženje računa sa stavkom po stopi od 8 % se **odbija sa
422** i porukom koja imenuje stopu i upućuje na ovaj dokument — isti obrazac kao kod avansnog
računa (`AdvanceInvoiceService.vatAccountFor`, nalaz Batch C R5). Tiho knjiženje na tuđe
konto je zamenjeno vidljivim zaustavljanjem.

**Šta treba odlučiti (knjigovođa).**
1. Da li Servoteh uopšte ima izlazni promet po posebnoj stopi od 8 % (PDV nadoknada
   poljoprivrednicima, `R_Tarife` šifra **„5"**, grupa POLJO)? U šifarniku tarifa postoji,
   ali je **nijedan artikal na produkciji ne nosi** (0 od 92.575, izmereno 02.08.2026).
2. Ako ima — koji konto: nova analitika pod `471` (kao `4710` za 10 %), ili poseban konto?
   Uz konto ide i red u `popdv_account_map` (`column_def = 'P/0.08'`) i u `vat_account_map`
   (`direction = 'output'`, `rate = 8`), inače POPDV i KIF taj promet ne vide.
3. Ako nema — potvrditi, pa se šifra „5" izbacuje iz šifarnika izlaznih stavki i brana
   postaje suvišna.

**Gde se menja kad odgovor stigne:** `VAT_OUT_ACCOUNT_BY_PERCENT` u
`backend/src/modules/sales/fakturisanje.service.ts` (jedan red) + seed konta + oba mapiranja.

### N1-a — `tax_rates` je PRAZNA na produkciji, pa je hardkodovana mapa jedini izvor stope

**Izmereno 02.08.2026** (`servosync-pg`, baza `servosync`):

```
SELECT count(*) FROM tax_rates;   →  0
SELECT count(*) FROM items;       →  92.575
```

Registar poreskih tarifa (`TaxRate` / `tax_rates`, 1:1 preslikan BigBit `R_Tarife` sa
`valid_from`/`valid_to`) **nema nijedan red**. Zato oba datumski svesna resolvera —
`robno/calculation.service.ts:taxRateOf` i `lookups/item-lookup.service.ts` — UVEK padaju na
rezervnu mapu `gl/posting/vat-rates.ts`, a `PostingEngine.aggregateDocAmounts`,
`sales/vat-totals.ts` i `pdv/advance-vat.service.ts` je čitaju direktno. Mapa nije „fallback",
nego **jedina stopa koju sistem zna**.

**Posledica.** Datumsko važenje stopa NE RADI: mapa je jedan red po šifri, bez datuma. Istekle
tarife (`15` = 5 % i `18` = 18 %, obe važile do 30.09.2012) zato nisu ni unete — dokument sa
takvom šifrom danas dobija „nepoznata šifra" umesto tihe pogrešne stope. Isto važi za svaku
buduću promenu stope: menja se kod, ne podatak.

**Šta treba uraditi (nije hitno dok se stope ne menjaju, ali je preduslov za PDV istoriju):**

1. Seed `tax_rates` iz zlatnog izvora
   `_legacy/BigbitRaznoNenad/_extracted/rule_tables/BB_T_26/R_Tarife.csv` — **svih 8 redova
   sa `valid_from`/`valid_to`**, kolone 1:1 (`base_rate`, `railway_rate`, `city_rate`,
   `war_rate`, `special_rate`, `vat_group`).
2. Efektivna stopa se računa kao **ZBIR pet kolona**, ne kao `base_rate` — tako je definiše
   sam BigBit (`_extracted/queries_full/OnLine_BigBit_APL/R_Tarife_ZbirnaStopa.sql`).
   Resolver koji uzme samo `base_rate` daće za tarifu 4 nulu umesto 10 %.
3. Tek kad registar ima redove, `vat-rates.ts` sme da postane ono što mu ime kaže — rezerva.

**Zašto nije urađeno u ovoj izmeni:** seed je migracija koja dira produkcijske podatke i
otvara pitanje ko je vlasnik registra (BigBit sync vs ručni CRUD, plan D1). Ispravka mapiranja
(N1) je bila hitna i samostalna; seed traži odluku.

> ✅ **ZAMKA „SEED I MAPE MORAJU ZAJEDNO" JE ZATVORENA (02.08.2026, sedmi krug).**
> Pre ove izmene bi seed odmah napravio kvar: birač stope na avansima
> (`frontend/.../fakturisanje/avansi/advance-dialogs.tsx`) puni opcije IZ `tax_rates`, pa bi
> ponudio šifre **„5" i „6"** — a `advance-invoice.service.ts` ih je odbijao sa 422, jer je
> držao SVOJ prepis mape. Isto i gejt stavki (`update-invoice.dto.ts`). Od ove izmene su
> **spisak dozvoljenih šifara i procenti IZVEDENI** iz `VAT_RATE_BY_CODE`
> (`KNOWN_VAT_CODES`, `VAT_PERCENT_BY_CODE` u `gl/posting/vat-rates.ts`), pa seed i kod ne
> mogu da se raziđu — svaka šifra koju registar ponudi, a mapa zna, prolazi svuda.
> **Ostaje jedna namerna nesimetrija:** šifra „5" (POLJO 8 %) se PRIMA na unosu, ali se avans
> po njoj ne može NAPLATITI — `vatAccountFor` nema konto za 8 % i baca 422. To je nalaz
> **O-PDV-8** iznad (čeka knjigovođu), a ne propust ove izmene.
>
> ⚠️ Uz seed i dalje ide korak 2 iz spiska gore (ZBIR pet kolona): 02.08. je nađen i treći
> čitalac koji je uzimao samo `base_rate` — štampa otpremnice/kalkulacije
> (`robno/print/stock-document-pdf.service.ts:loadTaxRates`). Ispravljen je istim krugom
> (nalaz S5), ali je to podsetnik da svaki NOV čitalac registra mora da sabere pet kolona.

### N1-d — sa praznim `tax_rates` CENOVNIK NE MOŽE DA POSTOJI (tvrd FK), a sync to ćuti

**Nalaz (02.08.2026, sedmi krug).** `price_list_entries.tax_rate_code` ima **tvrd FK** na
`tax_rates(code)`:

```
-- prisma/migrations/20260104120000_baseline/migration.sql:1526
ALTER TABLE "price_list_entries" ADD CONSTRAINT "fk_price_list_entries_tax_rates"
  FOREIGN KEY ("tax_rate_code") REFERENCES "tax_rates"("code") ON DELETE NO ACTION ON UPDATE NO ACTION;
```

Pošto `tax_rates` ima **0 redova** (v. N1-a), **nijedan red cenovnika ne može da se upiše** —
svaki `INSERT` obara FK. Sync to ne prijavljuje kao grešku nego kao preskočen red: FK
pre-filter `SOURCE_FK_FILTERS.price_list_entries` (`sync/table-ownership.ts:348-356`) namerno
odbacuje red čija tarifa nema par, da full refresh (koji ide pod
`session_replication_role='replica'`, gde FK trigeri NE RADE) ne bi ostavio siročad. Sa
praznim registrom taj filter odbacuje **sve redove, uvek**.

**Posledica koja se vidi na ekranu:** `PricingService.resolveBasePrice` prvo traži cenu u
`price_list_entries`, pa tek onda pada na `Item.wholesalePrice`. Dok je registar prazan, grana
cenovnika je **mrtva po konstrukciji** — svaka cena dolazi iz `Item.wholesalePrice`, a
`priceSource` nikad ne kaže „iz cenovnika". To nije kvar cenovnog motora nego posledica
praznog registra tarifa.

**Šta ovo znači za redosled poslova:** seed `tax_rates` (N1-a) nije samo „preduslov za PDV
istoriju" — on je i **preduslov da cenovnik uopšte proradi**. Dok se ne uradi, nema smisla
tražiti zašto sync cenovnika „ne prenosi ništa": prenosi tačno onoliko koliko FK dozvoljava.

### N1-b — jedan artikal ima pogrešnu poresku tarifu U BIGBITU (ispraviti u izvoru)

**Izmereno 02.08.2026** (`items.goods_tax_rate_code`):

| šifra | značenje (`R_Tarife`) | broj artikala |
|---|---|---|
| `3` | VISA 20 % | **92.574** |
| `4` | NIZA 10 % | **1** |

Taj jedan je:

```
id = 12852 · external_item_id = 35041 · katbroj DPTR10-04612
naziv „Bel computers dptr10-04612" · aktivan
```

**Računarski deo** — kategorija koja po Zakonu o PDV ide po **opštoj stopi 20 %**, a ne po
sniženoj. Skoro sigurno pogrešno unet u BigBitu, ne stvarni promet po sniženoj stopi.

**Gde se ispravlja:** u **BigBitu**, polje `R_Artikli.[Tarifa robe]` → `3`. Kolona dolazi
kroz `.mdb` kanal (`backend/scripts/bigbit-mdb-export.sh:141` → `items.goodsTaxRateCode`,
v. `migration/BIGBIT_ARTIKLI.md:59`), pa se ispravka sama prelije u 4.0 sledećim uvozom —
**ne dirati na našoj strani**, jer bi je sledeći sync vratio.

> Isti kanal drži i ranije zapisano: **37 artikala trajno ne prima izmene** zbog duplih
> katalonskih brojeva (`00001` drži 23 artikla) — takođe se čisti u BigBitu.

**Zašto je bitno i pored jednog reda:** dok je mapa tvrdila da je „4" = 8 %, taj artikal je u
`PostingEngine.aggregateDocAmounts` padao u POLJO kofu (`W`), a **nijedna šema kontiranja ne
referiše `W`** (v. S1 niže) — njegov izlazni PDV bi **nestao iz glavne knjige**. Posle
ispravke mape pada u `Q` (10 %), koje šema 33 knjiži.

### N1-c — tarifa „6" (bezcarinska zona) sama sebi protivreči u `R_Tarife`

**Pitanje za knjigovođu.** Red iz `R_Tarife.csv` (uveden 15.07.2021, još važi):

```
6, Osnovna 20, ostale kolone 0, Opis „Bezcarinska zona", PDVGrupa VANPDV
```

Zbir kolona daje **20 %**, a `PDVGrupa` kaže **VANPDV** (van sistema PDV-a, dakle 0 %). Dve
tvrdnje u istom redu se isključuju. Mapa je preuzela **20 %**, jer je to ono što vraća sam
BigBit (`PDVStopaZaTarifu` → `R_Tarife_ZbirnaStopa`, zbir pet kolona) — biti veran izvoru je
bezbednije od pogađanja.

**Koliko je hitno:** malo — **nijedan artikal na produkciji ne nosi šifru „6"** (0 od 92.575,
izmereno 02.08.2026), pa se do odgovora ništa ne knjiži po njoj.

**Šta treba potvrditi:** je li promet u bezcarinskoj zoni kod Servoteha oporeziv po 20 % (pa
je `PDVGrupa` u BigBitu pogrešno upisana), ili je oslobođen (pa stopa treba da bude 0 i tarifa
da se tretira kao izvozna, uz osnov oslobođenja na računu i u UBL-u). **Gde se menja:**
`VAT_RATE_BY_CODE` u `backend/src/modules/gl/posting/vat-rates.ts`, jedan red.

### S1 — robna putanja glavne knjige nije dodirnuta (šeme 33/36 nisu proverene sa knjigovođom)

**Nalaz (02.08.2026).** Sve što je u ovom krugu popravljeno na izlaznom računu — PDV po stopi
umesto po stavci, kupčev dug do pare, brana za stopu bez konta, brana „zaglavlje = stavke" —
važi **samo za uslužnu/ručnu putanju** (`postManualLedger`). Robna putanja ide sasvim drugim
kodom i **nije menjana**.

`sales/fakturisanje.service.ts` (grana `isAutoStock`): za `IFR`/`IFGP`/`IZVRO`/`IZVGP` sa
`stockDocumentId` **`postManualLedger` se uopšte ne poziva**. Umesto toga se preuzima nalog
robnog dokumenta, a **ako naloga nema — `journalEntryId = null` i faktura se proknjiži bez
ijednog reda u glavnoj knjizi**.

Kad nalog postoji, iznosi dolaze iz `PostingEngine.aggregateDocAmounts`:

- `Σ količina × cena × stopa` — **bez zaokruženja na paru** (za razliku od
  `documentVatTotals`, koji zaokružuje po grupi stope),
- iz **robnog dokumenta**, a ne iz stavki fakture — dva izvora za isti novac.

Uz to, u samim šemama:

| šema | dokument | kupac se zadužuje | šta ispada |
|---|---|---|---|
| 33 | IFR | `O + P + Q` | — |
| 36 | IFGP | `O + P` | **`Q` (10 %) ispada iz duga** |
| — | — | — | **`W` (8 %) ne referiše nijedna šema** |

**Posledica.** Za IFGP sa stavkom po stopi od 10 % kupac u glavnoj knjizi duguje **manje nego
što faktura glasi**, a promet po 8 % ne ulazi u GK ni po jednoj šemi. Isti razred greške koji
je N2 zatvorio na ručnoj putanji — samo što ovde brana ne postoji.

**Zašto nije popravljeno.** Šeme kontiranja su **podaci** (`Sema za kontiranje` /
`Stavke seme za kontiranje`, formule `DefDug`/`DefPot`), prepisani iz BigBita. Izmena formule
šeme menja knjiženje svakog robnog dokumenta unazad i **traži potvrdu knjigovođe** — ne
pretpostavku programera. Konto za 8 % uz to ionako ne postoji (v. O-PDV-8).

**Šta treba odlučiti (knjigovođa).**
1. Sme li se faktura uopšte proknjižiti kad robni dokument nema nalog (danas: sme, i ostaje
   bez ijednog GK reda), ili to mora da bude 422?
2. Da li šema 36 (IFGP) namerno izostavlja `Q`, ili je to greška prepisa iz BigBita?
3. Treba li robna putanja da zaokružuje PDV po grupi stope (kao izlazni račun), ili se
   zadržava legacy `Σ količina × cena × stopa`?

### S9 — brojač 2026. mora da se SEED-uje pre puštanja u rad (BigBit je već potrošio blok)

**Nalaz (02.08.2026, peti krug provere).** `DocumentNumberSequenceService.next` kad reda
sekvence nema **kreće od 1** (`numbering.service.ts`, „nema reda → `lastNumber = 1`"), a
`INSERT INTO document_number_sequences` ne postoji nigde — ni u migracijama ni u seed-ovima.
Za 2026. to nije tačno polazište: `docs/PLAN_UNOS_DOKUMENATA.md:1282,1289-1291` beleži da je
**živi BigBit brojač profaktura za 2026. na 264**, i da je blok `254/26–261/26` već potrošen.

**Posledica ako se ne uradi.** Prvi predračun iz 4.0 dobija `PROF-1/26` dok BigBit iste
godine izdaje `0265-26` — dva sistema izdaju brojeve iz istog poslovnog niza, a kupac koji
plati po BigBit predračunu iz ranije 2026. i otkuca `254/26` gađa naš dokument. Zbog paralelnog
rada do cutovera (april 2027) to nije teorijski slučaj.

**Šta konkretno treba uraditi PRE puštanja u rad** (ne izvršavati sad — traži potvrđene
brojeve od knjigovodstva na dan prelaska):

1. Očitati žive BigBit brojače po nizu za 2026: izlazne fakture (`NNN/YY`, §2.1 u
   `migration/BIGBIT_IZLAZNE_FAKTURE_I_AVANSI.md`), profakture/ponude, avansne račune.
2. Upisati po jedan red u `document_number_sequences` za (`company_id`, `year = 2026`):
   `@FAKTURA`, `PROF`, `PON`, `AVR`, `REV` — `last_number` = poslednji potrošen broj.
3. Za profakture to je **najmanje 264** (plan traži i evidentiranje potrošenog bloka
   `254/26–261/26`, i **seed iz niskog bloka uz ručnu potvrdu**, nikad sirovi `MAX`).
4. **Odlučiti dele li PON i PROF jedan brojač** (v. tačka ispod) — to se rešava OVDE, ne pre.
5. Tek posle toga pustiti izdavanje dokumenata iz 4.0.

**Vezano pitanje koje seed otvara (nalaz S8).** BigBit `PON` i `PROF` **dele niz** `NNNN-YY`
(`migration/BIGBIT_IZLAZNE_FAKTURE_I_AVANSI.md:113`: `0938-24`, `0954-25`, `0407-25`), a
`docs/PLAN_UNOS_DOKUMENATA.md:1281` ih grupiše zajedno sa `OTP` u grupu `OFFER`. Naša numeracija
ih danas drži razdvojeno (`PROF-`/`PON-`, dva brojača). Dok oba kreću od nule to je bezopasno —
prefiksi ih razdvajaju kao stringove. **Čim se oba seed-uju sa 264**, razdvojeni brojači izdaju
`PROF-265/26` i `PON-265/26`, a u BigBit knjizi je 265 jedan jedini slot. Ako se pređe na
zajednički brojač, `sequenceKeyFor` više ne sme da se izvodi isključivo iz prefiksa, pa
ekvivalencija „bez prefiksa ⇔ u nizu faktura" (danas jedina strukturna brana od spajanja sa
fakturom) mora da se zadrži kao **zaseban** invariant i test. `OTP` uz to još nije ni u registru.

**Brana koja nedostaje:** nema provere „broj koji izdajem već postoji u `ledger_entries`".
Dok se seed ne uradi, jedina zaštita je ručna.

### R2 — AVANSNI RAČUN SVESNO OBARA EN 16931 **BR-CO-17** ZA 0,01 (nije kvar)

**Izmereno 02.08.2026 (šesti krug).** Porez avansnog računa se po zakonu dobija **PRERAČUNATOM
STOPOM** iz naplaćenog bruta (20/120 = 16,6667 %), a ne množenjem osnovice. Kod to radi u
`pdv/vat-bridge.util.ts` (`grossToNet`): osnovica se deli, a porez je **razlika**, da zbir uvek
zatvori. Za deo bruto iznosa tada **ne postoji osnovica za koju važe obe jednačine**:

```
AVR bruto 132,03 uz 20 %
  osnovica = round2(132,03 / 1,2) = 110,03      porez = 132,03 − 110,03 = 22,00
  round2(110,03 × 20 %)           = 22,01       ← BR-CO-17 traži baš ovo
  a 110,02 → 132,02   i   110,03 → 132,04       ← bruto 132,03 nije u slici funkcije
```

**Učestalost** (brute force, svi bruto iznosi 1,00–100.000,00): **16,67 %** avansa po stopi od
20 %, **9,09 %** po stopi od 10 %.

**Šta je izabrano.** Prednost ima **unutrašnja doslednost**: zaglavlje, papir i e-faktura nose
**isti** porez (onaj koji je proknjižen), a bruto ostaje **tačan** — to je stvarno naplaćen
novac. Zato `cac:TaxSubtotal` preuzima objavljen porez dokumenta (`sales/vat-totals.ts`,
`documentVatTotal`), pa **BR-CO-14** (`TaxTotal = Σ TaxSubtotal`) i **BR-CO-15**
(`TaxInclusive = TaxExclusive + TaxTotal`) važe, a **BR-CO-17** ostaje prekršen za 0,01 kod
tih ~1/6 avansa. Alternativa (poštovati BR-CO-17) bi značila e-fakturu koja tvrdi bruto
132,04 za uplatu od 132,03 i papir koji se ne sabira — dakle biramo **koji jedan prekršaj
ostaje**, ne da li ga uopšte ima.

**Šta treba proveriti (knjigovođa + SEF demo).** Da li SEF-ov Schematron BR-CO-17 na avansnom
računu (`InvoiceTypeCode 386`) primenjuje kao **grešku** ili kao **upozorenje**. U repou nema
XSD/Schematron datoteka, pa se to ne može izmeriti kod nas — proveriti na SEF demo okruženju
pre puštanja e-faktura u rad. Ako je greška, jedini ispravan izlaz je da se **iznos avansa
ograniči na bruto koji je u slici funkcije** (kupcu se traži 132,02 ili 132,04), što je
poslovna odluka o naplati, a ne izmena u obračunu.

**Testovi koji ovo drže zapisanim:** `sales/sef/ubl-builder.service.spec.ts` („avans 132,03:
Σ TaxSubtotal == TaxTotal…", meri i sam prekršaj od 0,01), `sales/pdv-trojac.spec.ts`,
`sales/print/invoice-pdf.legacy-forms.spec.ts`.

### S2 — odštampana stopa i odštampani iznos moraju iz ISTOG šifarnika (rešeno; ostaje seed)

**Izmereno 02.08.2026 (šesti krug).** Štampa je stopu za red
`PDV po stopi {stopa}% X {osnovica} = {porez}` čitala iz tabele **`tax_rates.base_rate`**, a
iznos poreza računala iz mape **`VAT_RATE_BY_CODE`** u kodu. Pošto `tax_rates` **nema seed ni
u jednoj migraciji** (0 redova na produkciji — v. **N1-a**), stopa je ispadala `null → 0` i
domaći obrazac je štampao **„PDV po stopi 0% X 500,05 = 100,01"** — jednačinu koja poriče samu
sebe, na redu koji i postoji da bi se mogla proveriti.

**Popravljeno** tako što štampa čita `VAT_RATE_BY_CODE` (`sales/vat-totals.ts` → `vatPercentOf`),
istu mapu iz koje `PricingService` obračunava porez; čitanje `tax_rates` iz štampe je uklonjeno,
a lažni Prisma klijent u `print/invoice-pdf.service.spec.ts` namerno više nema `taxRate`, pa
povratak na bazu pukne umesto da tiho odštampa nulu.

**Ostaje otvoreno:** seed `tax_rates` — pitanje je opisano u **N1-a** (svih 8 redova
`R_Tarife` sa `valid_from`/`valid_to`, efektivna stopa = zbir pet kolona). Dok se to ne uradi,
datumsko važenje stopa ne radi nigde u sistemu, pa ni na papiru.

### S3 — ODLUKA: gde tiha nula sme da ostane, a gde mora da bude glasna (rešeno)

**Nalaz (02.08.2026, sedmi krug).** Nepoznata šifra poreske stope davala je **tihu nulu** na
pet mesta, a branu je imalo samo jedno (`pdv/advance-vat.service.ts`). Ulaz je pritom bio
otvoren: provera tarife artikla (`masters/items.service.ts`) bila je vezana za **praznu**
tabelu `tax_rates` (`if (total === 0) continue`), pa je bila **potpuno isključena**, a robni
DTO-i su imali goli `@IsString`. Šifra „18" ili „99" je prolazila i svuda dalje značila 0 %.

**Pravilo koje je sprovedeno:** granica je **da li se od stope pravi novac, knjiga ili poreski
dokument**, a ne koliko je mesto „duboko".

| mesto | odluka | zašto |
|---|---|---|
| `sales/pricing.service.ts` | **400** | osnovica × stopa ide u GK, na SEF i u KIF |
| `gl/posting/posting.service.ts` | **422** | nalog bi BALANSIRAO bez PDV linije — ni kontrola ΣDug=ΣPot ga ne hvata |
| `robno/calculation.service.ts` | **422** | `KalkMP` bez stope = maloprodajna cena bez PDV-a |
| `pdv/advance-vat.service.ts` | 422 (zatečeno) | poreski dokument |
| `lookups/item-lookup.service.ts` | **0 % + `logger.warn`** | PRIKAZ: jedan pokvaren artikal ne sme da obori celu pretragu — operater tada ne može ni da ga pronađe da bi ga ispravio |

**Ulaz je zatvoren na tri mesta, svi protiv ISTOG izvedenog spiska (`KNOWN_VAT_CODES`):**
šifarnik artikala (`items.service.ts`, sada nezavisno od praznog registra), unos robnog
dokumenta (`robno.service.ts:buildItemData` — DTO je interfejs, `ValidationPipe` ga ne vidi) i
izmena robnog dokumenta (`update-stock-document.dto.ts`, `@IsIn`).

**Šta ovo znači za budući kod:** novo mesto koje čita stopu po šifri ili je uzima iz
`VAT_RATE_BY_CODE` i **pada glasno**, ili je izričito prikaz — pa loguje. `?? 0` bez jednog od
ta dva je regresija ovog nalaza. Isto važi i za `?? 20`: avansni servis je imao baš to
(`VAT_PERCENT_BY_CODE[code] ?? 20`), a **tiha dvadesetka je gora od tihe nule** — ne može se
prepoznati kao izostanak, izgleda kao ispravan porez.

### N5-SEF — „poslato POSLE storna" je suženo, ali nije zatvoreno (traži izmenu u `sef.service.ts`)

**Nalaz (izmereno 02.08.2026, SEF klijent kasni 300 ms).** `SefService.send` proveri da
faktura nije stornirana, pa ode na mrežu. Ako storno prođe DOK traje mrežni poziv, `send` se
vrati i **bezuslovno** upiše `SENT` + `sefInvoiceId` + `sentAt`. Ishod: faktura `CANCELLED`,
outbox red `SENT`, status-log „CANCELLED" → „SENT", a **SEF cancel nije poslat** — kupac na
portalu ima važeću e-fakturu za dokument koji kod nas ne postoji.

**Šta je urađeno (03.08.2026, `sales/fakturisanje.service.ts` → `cancelSefOutbox`).**
1. PENDING redovi se gase LOKALNO PRVI (pre mrežnog `cancel`-a) — pad mreže više ne ostavlja
   red „u redu za slanje";
2. **drugi prolaz**: outbox se posle otkazivanja čita PONOVO i svaki red koji je u
   međuvremenu postao `SENT`/`DELIVERED` se otkazuje na SEF-u, uz `ERROR` u logu.

Prozor je time sužen sa „trajanje mrežnog poziva" (izmereno 300 ms) na „razmak između našeg
poslednjeg čitanja i tuđeg upisa".

**Šta OSTAJE — jedan uslovan upis.** Deterministički lek je da upis statusa `SENT` u
`sales/sef/sef.service.ts` bude **CAS**, a ne bezuslovan `update`:

```ts
// umesto prisma.sefOutbox.update({ where: { id: outboxId }, data: { status: "SENT", … } })
const claimed = await prisma.sefOutbox.updateMany({
  where: { id: outboxId, status: "PENDING" },   // storno ga je prebacio u CANCELLED
  data: { status: "SENT", sefInvoiceId, sentAt: new Date(), errorMessage: null },
});
if (claimed.count !== 1) { /* dokument JE otišao na SEF, a lokalno je otkazan →
   ERROR u log + odmah `cancel` na portalu; status reda ostaje CANCELLED */ }
```

Bez toga red koji je storno prebacio u `CANCELLED` može da se vrati u `SENT`, pa se ne zna
pouzdano da dokument treba otkazati na portalu.

**Zašto nije odmah urađeno:** `sales/sef/**` u ovom paketu menja drugi agent (izmene bi se
sudarile). Izmena je jedan blok u `send()` — uraditi je odmah po spajanju tog paketa.

### N4-ROBNO — račun sa vezanom izdatnicom se od 03.08.2026. ODBIJA dok izdatnica nije proknjižena

**Nalaz (izmereno 02.08.2026).** `postInvoice` je za auto-robnu granu (IFR/IFGP/IZVRO/IZVGP sa
`stockDocumentId`) tražio nalog robnog izlaza (`journalEntry.sourceGoodsDocId`) i, kad ga ne
nađe, **tiho** upisivao `journalEntryId = null`. Ishod: broj potrošen, dokument `POSTED` i
`LOCKED`, a u glavnoj knjizi **nula redova** — račun se štampa i sme na SEF, ali ga nema ni u
saldakontima, ni u KIF-u, ni u POPDV-u; ponovno knjiženje pada na 409 (`isLocked`), a storno
nema šta da reverzira. Put: PROF → IFR → `POST /robno/documents/from-invoice` (izdatnica
nastaje kao DRAFT) → `POST /sales/invoices/:id/post`.

**Šta je urađeno.** Ta grana sada baca **422** sa uputstvom da se prvo proknjiži izdatnica.
Fallback na ručni nalog NIJE uzet: ručni nalog knjiži prihod i PDV, a šema robnog izlaza
(33/36) knjiži i razduženje zaliha — kasnije knjiženje izdatnice bi udvostručilo prihod i
porez.

**🔴 ŠTA TO ZNAČI ZA PRODUKCIJU — proveriti pre puštanja.** Nijedan
`document_types.posting_template` na produkciji nije popunjen (v. nalaz S1 iznad,
`accounting_schemes` 2/25), pa `PostingEngine.postFromStockDocument` za izdatnicu baca
`NoPostingSchemeException`. Dok je tako, račun sa vezanom izdatnicom **ne može da se proknjiži
uopšte** — ranije je prolazio, ali bez ijednog reda u GK. Dakle nije izgubljena nijedna
ispravna radnja, ali JESTE zatvoren put koji je do sada vraćao `200`. Odblokira ga isto što
odblokira i S1: knjigovođa potvrdi šeme kontiranja robnih vrsta, pa se `posting_template`
popuni. Poruka greške imenuje oba uzroka (neproknjižena izdatnica / vrsta bez šeme).

### N3-SEF — PRIHVAĆENA e-faktura se ne može poništiti iz aplikacije (`/sales-invoice/storno` ne postoji u kodu)

**Nalaz (izmereno 02.–03.08.2026).** `SefService.cancel` je dozvoljavao otkazivanje i iz
statusa `DELIVERED` (SEF `Approved`/`Seen` — kupac je fakturu prihvatio). Poziv je odlazio na
`POST /sales-invoice/cancel`, SEF je vraćao **HTTP 400**, a `cancel()` **nije bacao**: status
je ostajao `DELIVERED` uz `error_message` i `ERROR` u status-logu. Korisnik nije dobio nikakav
znak da poništavanje nije prošlo. (Nad `REJECTED` isti poziv daje 409 — dakle brana za
`DELIVERED` prosto nije postojala, a ne da je bila blaža.)

**Šta se zna iz repoa.** `docs/migration/07-bigbit-sef-efaktura.md` §8.2 popisuje **DVE**
izlazne rute sa **DVA** guard-a:

| radnja | ruta | guard (BigBit) |
|---|---|---|
| otkazivanje | `POST /api/publicApi/sales-invoice/cancel` | `ER_FakturaMozeDaSeOtkaze(status, id)` |
| **storniranje** | `POST /api/publicApi/sales-invoice/storno` | `ER_FakturaMozeDaSeStornira(status, id)` |

Implementirana je samo prva (`sef-client.service.ts`); `grep "sales-invoice/storno" src/` = **0
pogodaka**. Jedan skup dozvoljenih statusa (`CANCELLABLE_LOCAL_STATUSES`) je stajao za obe
radnje, pa je storniranje odlazilo na rutu za otkazivanje.

**Šta je urađeno (03.08.2026).** `DELIVERED` je uklonjen iz dozvoljenih statusa: `cancel()`
sada baca **409** sa porukom koja imenuje pravi put i ne izmišlja rutu. Trag ostaje i u
`sef_status_log` (`ERROR`), jer je stanje opasno — dokument je kod nas storniran, a kupac na
portalu ima važeću e-fakturu.

**Šta se NE zna (traži demo ključ, ne pogađanje):**
1. tačan oblik JSON tela za `/storno` (BigBit izvor je zaključan; §8.2 daje samo rutu i guard);
2. koji SEF statusi guard `ER_FakturaMozeDaSeStornira` propušta;
3. da li storniranje prihvaćene fakture na SEF-u traži saglasnost kupca (portal to traži za
   deo slučajeva) — od toga zavisi da li je uopšte sinhrona radnja ili zahtev sa čekanjem.

**Pod kojim uslovima se javlja.** Storno računa čiji je outbox red `DELIVERED`. Lokalni storno
se **izvrši i komituje** (radi se posle transakcije), pa dokument kod nas jeste storniran, ali
zahtev vrati 409 — što je i namera: ispravka prema kupcu tada ide **knjižnim odobrenjem**, a ne
poništavanjem e-fakture. Dok se rute ne implementiraju, jedini put da se prihvaćena e-faktura
poništi jeste **ručno na portalu**.

### N2-SEF — izveštaj o storniranju broji REDOVE, ne ishode (`sales/fakturisanje.service.ts`)

**Kontekst.** Od 03.08.2026. `SefService.cancel` **baca** kad SEF ne potvrdi otkazivanje (red
pada u status `CANCEL_PENDING`, v. obrazloženje u `sales/sef/sef.service.ts`). Razlog je
izmeren: `cancelSefOutbox` id reda upisuje u `cancelledOutboxIds` **bez obzira na ishod**, pa je
ekran na timeout javljao „Račun storniran. Otkazano SEF redova: 1." dok je kupac imao živu
e-fakturu (outbox #901, `SENT`, `sefInvoiceId 555111`, timeout).

**Urađeno (03.08.2026, isti paket, `cancelSefOutbox`).** Ishod se skuplja **po redu**
(`try/catch` u petlji): svaki red se pokuša, uspešni idu u `sefCancelledOutboxIds`, a neuspeli
se loguju kao `ERROR` i prijave ZAJEDNO na kraju — jednim 409 koji kaže da je račun **storniran
u knjigama** i imenuje redove koje treba otkazati na portalu. Prvi neuspeh više ne preskače
ostale redove istog dokumenta.

**Šta ostaje.** Semantika prema pozivaocu je i dalje „greška" (izuzetak), pa FE nema strukturiran
podatak — nedostaje treća lista u odgovoru (`sefCancelPendingIds`) i poruka „stornirano; N redova
čeka potvrdu otkazivanja na SEF-u" umesto crvene greške. To je izmena ugovora odgovora i dodiruje
`frontend/`, pa ide zajedno sa ekranom, ne uz ovu ispravku.

---

## 🔶 OTVORENO — uparivanje uplata (peti krug, 02.08.2026)

Nalazi koji su **svesno ostavljeni otvoreni** uz izmerene primere. Nisu krpljeni jer bi
zakrpa oborila legitimne pogotke; svaki nosi posledicu koju treba znati.

### S6 — prefiks serije ne preživi put kroz banku (`cbc:PaymentID`)

`sales/sef/ubl-builder.service.ts:680-694` šalje `cbc:PaymentID = documentNumber`, pa kupcu
na SEF za avansni račun ide `A-7/26`. Poziv na broj je numeričko polje: `placanja/mod97.util.ts`
(`digitsOnly`) svodi `A-7/26`, `PROF-7/26` i `7/26` na isti niz `726`. Ako banka umesto celog
prefiksa očisti **samo slovo**, PNB se vraća kao `7/26` → uplata na avans zatvara **fakturu
7/26**. Prefiks je jedina stvar koja te serije razdvaja (O-F6/O-F7), a ovde otpada.

**Predlog (nije izveden — `ubl-builder.service.ts` je u tuđem opsegu izmene):** za svaku vrstu
sa serijom `cbc:PaymentID` uzimati iz `invoices.payment_reference` (`schema.prisma:4203`, već
ima prednost nad brojem dokumenta) i tamo upisivati čisto numeričku osnovu koja u sebi nosi
oznaku serije kao CIFRU (npr. vodeći `9` za avans), pa je poziv na broj jednoznačan i posle
svakog čišćenja. Bez toga prefiks štiti knjigu, ali ne i put novca.

Uz to je u `mod97.util.ts` (`digitsOnly`) upisano zašto broj dokumenta sa serijom **ne sme**
da bude osnova poziva na broj.

### S7 — `Opis(100,35)` se ne parsira, a slobodan tekst stiže baš tamo

`izvodi/bank-statement-parser.service.ts` čita `PozivNaBroj(169,20)`, `Model(167,2)`, iznos,
smer i datum — **`Opis` ne**. `parseReference` se zove samo nad `referenceNumber`. Reč-alijasi
(`AVANS`, `PREDRAČUN`, `PONUDA`, ćirilica) zato rade samo na onome što stane u **20 znakova**
PNB-a: `AVANS BR 1/26` (13) staje, „uplata po avansu A-1/26" (24) ne staje — raniji komentari i
fixture-i koji su ga navodili kao primer su ispravljeni, jer su obmanjivali.

**Zašto nije samo uključeno:** `Opis` je 35 znakova slobodnog teksta i vodi ka mnogo više
lažnih kandidata nego PNB. Uvođenje traži zasebnu odluku (i najverovatnije stroži režim:
kandidati iz `Opis`-a samo kad PNB nema nijedan pogodak).

### V1 (ostatak) — četvorocifrena godina bez vodećih nula i dalje daje naš oblik

Brana protiv zatečenih BigBit brojeva vezana je za **vodeće nule**, jer ih nose svi izmereni
BigBit oblici (`AVR-00001/2026`, `0012-26`, `PON-00285/2026`, `IFG-00025/2025`). Skraćivanje
`123/2026 → 123/26` je **namerno ostavljeno**: BigBit-ov auto-broj je uvek zero-padovan, a
kupac koji plaća naš `123/26` realno ume da otkuca punu godinu. Ako se ikad pojavi zatečen
dokument oblika `NNN/GGGG` **bez** vodećih nula, taj PNB bi i dalje mogao da proizvede naš broj.

⚠️ Ispravka tvrdnje (nalaz S-B, šesti krug 02.08.2026): u `numbering.service.ts` je pisalo da
su potpis starog broja „vodeće nule **i** četvorocifrena godina". Kod to nikad nije radio —
`reference-parser.util.ts` kuje `${num}/${last.slice(2)}` bez provere godine — i **ne treba**
da radi, iz razloga iz prethodnog pasusa. Komentar je ispravljen, kod nije diran.

### N-D — BigBit serija faktura JESTE `NNN/YY`, to parser ne može da razdvoji

`migration/BIGBIT_IZLAZNE_FAKTURE_I_AVANSI.md:97-106`: izlazne fakture 2025. dele **jednu
godišnju seriju** `011/25 … 486/25` (483 dokumenta). `486/25` je **isti string** kao naš budući
broj `486/25` — nijedna brana u parseru to ne razlikuje, jer razlike nema. Tvrdnja iz
`numbering.service.ts` („stari i novi broj se ne mogu sudariti") drži **samo dok BigBit istorija
nije uvezena u `ledger_entries`**. Onog trenutka kad se uveze, dva različita dokumenta nose isti
broj i grupisanje otvorenih stavki ih spaja. Rešava se zajedno sa **S9 (seed brojača)** — blok
brojeva po firmi i godini — a ne u parseru.

### S5 (ostatak) — PNB sa dva dokumenta vraća samo onaj uz oznaku

`A-1/26 i 657/25` sada daje `A-1/26` (ranije nijedan od dva), ali **ne** i goli `657/25`: sve
iza oznake serije pripada toj seriji, jer je to jedina odbrana od curenja golog broja. Uplata
tada zatvori avans, a faktura ostaje otvorena — pošten, vidljiv ishod, ne tiho pogrešan.

### V4 → V-B — SVAKA vrsta van registra se ODBIJA (nema više fallback prefiksa)

Nalaz V4 je odbijao samo neupisanu vrstu čija bi šifra bila mešana sa postojećom serijom
(`A`, `AVR2`, `PON2`) ili koju parser ne ume da pročita (nije 2–5 slova); ostale su dobijale
izmišljen prefiks (`XYZ-`, `OTP-`). **Šesti krug (nalaz V-B) je i taj ostatak uklonio.**

Razlog je na DRUGOM kraju sistema: da bi parser poziva na broj umeo da pročita bilo koji
izmišljen prefiks, morao je da drži pravilo „svaka 2–5 slova + `-` + cifra je serija" uz
denylist reči koje to nisu. Izmereno je da to pravilo **jede 29 legitimnih oblika PNB-a** —
`IFR-657/25` (naša sopstvena šifra vrste), `RAC-`, `RAČ-`, `FAK-`, `FA-`, `ФАК-`, `IF-`, `UF-`,
`REF-`, `POZ-`, `RB-`, `DOK-`, `ID-`, `NO-`, `TR-`, `OP-`, `SEF-`, `PP-`, `ZR-`, `PDV-`, `POR-`,
`JN-`, `NAL-`, `UG-`, `UGOV-`, `NAR-`, `OTP-`, `OTPR-`, `KOMP-` — kojima je tačan broj fakture
nestajao iz kandidata. To nije pošten promašaj: uparivanje tada pada na uparivanje **po iznosu**
(`bank-statement.service.ts` → `findFirst` po jednakom iznosu), koje stavku zatvara bez ijedne
informacije o broju.

Grana je uklonjena jer je bila **suvišna za oba svoja cilja** (izmereno): (1) BigBit auto-broj je
uvek zero-padovan, pa ga već hvata brana vodećih nula — cela tabela V1 ostaje zatvorena i bez nje;
(2) numeracija više ne izmišlja prefiks. Registar `DOCUMENT_SERIES` je time **jedini izvor
prefiksa na obe strane**: numeracija ume da upiše samo ono što parser ume da pročita.

**Ako se u produkciji pojavi legitimna vrsta koja pada na ovu branu (422 pri izdavanju broja),
rešenje je upisati je u `DOCUMENT_SERIES` sa svojim prefiksom + reč u `SERIES_ALIASES`** — ne
vraćati fallback. Vraćanje fallbacka bez vraćanja čitača u parseru daje `XYZ-1/26 → 1/26`, tj.
goli broj fakture; to je jedan invariant sa dva kraja.

### V-A (zatvoreno) — procenat/rata se PRESKAČU, ne gase oznaku serije

Nalaz S5 je oznaci serije zabranio da veže procenat/ratu tako što je oznaku **gasio u celini**,
pa je PNB išao normalnim putem i goli `N/GG` izlazio napolje. Izmereno: `PREDRACUN 50% 12/26` →
`12/26`, `AVANS 50% 1/26` → `1/26`, `PONUDA 50% 5/26` → `5/26`, `AVANS 1.RATA 1/26` → `1/26`
(i `PROF 50%`, `AVR 50%`, `A 50%`, `AVANS 40 %`, `REVERS 50%`). Sada se šum **preskače** i oznaka
vezuje sledeći broj. Vlasništvo broja i dalje menja samo reč koja imenuje drugi dokument:
`AVANS 50% PO FAKTURI 657/25` i `avans po fakturi 1/26` daju **goli** broj.

### K-1 — kamata se obračunava i na DATE AVANSE (1520/1521/1530) — čeka knjigovođu

**Izmereno 03.08.2026.** `KamataService.compute` osnovicu bira ovako
(`backend/src/modules/kamata/kamata.service.ts`):

```ts
where: { side: "receivable", tracksOpenItems: true }
```

U registru `saldakonto_accounts` (seed
`prisma/migrations/20260726100000_seed_saldakonto_i_seme_kontiranja/migration.sql:88-101`)
tom uslovu odgovara **pet** konta, a ne dva:

| konto | `side` | `partner_scope` | šta je |
|-------|--------|-----------------|--------|
| 1520 | receivable | **supplier** | Plaćeni avansi za robu u zemlji |
| 1521 | receivable | **supplier** | Plaćeni avansi (ostalo) |
| 1530 | receivable | **supplier** | Plaćeni avansi za robu u inostranstvu |
| 2040 | receivable | customer | Kupci u zemlji |
| 2050 | receivable | customer | Kupci u inostranstvu |

Konta **152x/153x su avansi koje smo MI PLATILI dobavljaču**. Potraživanje jesu (otud
`side = 'receivable'`), ali je to potraživanje **za isporuku robe**, ne dospelo novčano
potraživanje — a zatezna kamata teče po novčanoj obavezi.

**Šta to daje na obračunu** (proporcionalni metod, stopa 9,50 %, presek 02.08.2026):
otvorena stavka `1520 / komitent 77 / AV-3/26 / 500.000,00 / dospeće 01.03.2026` ulazi u
kamatni list kao glavnica **500.000,00**, **154 dana**, kamata **20.041,10**
(`500.000 × 154 × 0,095 / 365`). Obračun se pravi kao `InterestCalculation` u statusu
`DRAFT`, dakle ne knjiži se sam — ali je to list koji se dobavljaču šalje.

**Brane nema ni sa jedne strane.** `ComputeInterestDto` je go TS interfejs (bez
class-validator), a `compute` proverava samo `partnerId`; konto se ne bira niti se može
suziti kroz API.

**Zašto NIJE promenjeno u ovoj izmeni (03.08.2026).** Odgovor nije tehnički. Da li se po
plaćenom avansu dobavljaču obračunava zatezna kamata zavisi od ugovora i od toga da li je
obaveza isporuke prešla u novčanu (raskid/povraćaj) — to presuđuje knjigovođa, ne kod.
Presedan u repou postoji i vuče na obe strane: `OpenItemsService.agingByPartner` bez
izabranog konta **sam sužava na `sa.partner_scope = 'customer'`** uz obrazloženje „aging bez
konta je izveštaj naplate", pa bi ista logika ovde značila filter po `partner_scope`; ali
aging je izveštaj, a kamatni list je dokument koji ide partneru, pa se ćutke ne sužava.

**Šta treba odlučiti (knjigovođa).**
1. Da li se zatezna kamata po DATOM avansu (152x/153x) uopšte obračunava — nikad, ili samo
   posle raskida/isteka roka isporuke?
2. Ako se ne obračunava: filter postaje `partner_scope = 'customer'` (isti obrazac kao
   `agingByPartner`) — jedan uslov u `saldakontoAccount.findMany`.
3. Ako se obračunava u nekim slučajevima: treba nam ulaz kojim se konta biraju po obračunu
   (npr. `accountCodes?` u `ComputeInterestDto`), jer ih danas nema kako suziti.

**Gde se menja kad odgovor stigne:** `KamataService.compute` →
`this.prisma.saldakontoAccount.findMany({ where: { side: "receivable", tracksOpenItems: true } })`
(`backend/src/modules/kamata/kamata.service.ts`), + test u `kamata.service.spec.ts`.
