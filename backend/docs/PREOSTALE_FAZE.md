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
(`sales/fakturisanje.service.ts`, `buildSalesLedgerLines`) je poresku šifru **„4" = posebna
stopa 8 % (POLJO)** knjižilo na konto **`4702` — „PDV 20 % na prodate robe na domaćem
tržištu"**, jer je pravilo bilo „ako je šifra `2` → 4710, INAČE → 4702".

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
1. Da li Servoteh uopšte ima izlazni promet po posebnoj stopi od 8 %? (U BigBit izvozima
   šifra „4" postoji u šifarniku tarifa, ali nije potvrđeno da je ijedna faktura nosi.)
2. Ako ima — koji konto: nova analitika pod `471` (kao `4710` za 10 %), ili poseban konto?
   Uz konto ide i red u `popdv_account_map` (`column_def = 'P/0.08'`) i u `vat_account_map`
   (`direction = 'output'`, `rate = 8`), inače POPDV i KIF taj promet ne vide.
3. Ako nema — potvrditi, pa se šifra „4" izbacuje iz šifarnika izlaznih stavki i brana
   postaje suvišna.

**Gde se menja kad odgovor stigne:** `VAT_OUT_ACCOUNT_BY_PERCENT` u
`backend/src/modules/sales/fakturisanje.service.ts` (jedan red) + seed konta + oba mapiranja.

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

### S5 (ostatak) — PNB sa dva dokumenta vraća samo onaj uz oznaku

`A-1/26 i 657/25` sada daje `A-1/26` (ranije nijedan od dva), ali **ne** i goli `657/25`: sve
iza oznake serije pripada toj seriji, jer je to jedina odbrana od curenja golog broja. Uplata
tada zatvori avans, a faktura ostaje otvorena — pošten, vidljiv ishod, ne tiho pogrešan.

### V4 (ostatak) — vrsta sa dvosmislenom šifrom se ODBIJA, ne preimenuje

`seriesPrefixFor` od sada odbija neupisanu vrstu čija bi šifra bila mešana sa postojećom
serijom (`A`, `AVR2`, `PON2`) ili koju parser poziva na broj ne ume da pročita (nije 2–5 slova).
To je 422 pri izdavanju broja. **Ako se u produkciji pojavi legitimna vrsta koja pada na ovu
branu, rešenje je upisati je u `DOCUMENT_SERIES` sa svojim prefiksom** — ne opuštati branu.
