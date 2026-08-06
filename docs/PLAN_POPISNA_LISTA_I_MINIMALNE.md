# Plan: popisna lista sa policama + artikli ispod minimalne količine

**Datum:** 06.08.2026 · **Status:** PLAN (ništa nije izvedeno) · **Tražilac:** vlasnik
**Zahtev (doslovno):** „Slike su iz BIGBITA kada idemo na popisnu listu sa policama i opciju da nam da
artikle koji su ispod minimalne količine. U popisnoj listi BigBit prikazuje **stanje** a ne **slobodnu
količinu**. U novoj aplikaciji napravi da prikazuje **i slobodnu količinu ali i stanje pored**, jer ako je
nešto na rezervaciji ugrađeno u mašinu ne možemo ga brojati a knjigovodstveno je i dalje na stanju."

---

## 0-A. ODLUKE VLASNIKA (06.08.2026) — obavezujuće za izvođenje

Dve od četiri stvari koje je plan ostavio otvorenim su odlučene istog dana:

| pitanje | ODLUKA | posledica za izvođenje |
|---|---|---|
| **Artikli bez police na popisnoj listi** (4.789 od 7.179 redova sa stanjem) | Lista se **grupiše po polici**, a sve bez police ide na **kraj, pod naslov „Bez police"** | Grupisanje + poslednja grupa; njen naslov mora da nosi i broj redova, jer taj spisak služi i kao podsetnik šta fali da se upiše |
| **„Artikli ispod minimalne količine" — sa čim se poredi** | Sa **SLOBODNOM količinom**, ne sa ukupnim stanjem | ⚠️ **Namerno odstupanje od BigBita**, koji poredi sa ukupnim stanjem. Naš spisak će biti **duži** od njegovog: artikal koji je ceo rezervisan kod nas se pojavljuje, kod njega ne. To je namera (rezervisano je već obećano nekom nalogu, pa za nabavku ne postoji), a ne greška — i mora tako da piše na samom ekranu, da niko ne prijavi „razliku u odnosu na BigBit" kao kvar |

### Dopuna istog dana — ko unosi minimalne količine i čija je to kolona

Vlasnik: *„ISPOD MINIMALNE KOLIČINE UNOSE MAGACIONERI, za sada korisnici sa mejlom
dusko.kostic, radisav.radevic, nikola.savic."*

🔴 **Prepreka nađena pri merenju, pre bilo kakvog koda:** `items.minQuantity` danas puni
**noćni .mdb uvoz**. Potvrđeno iz dva nezavisna izvora:

- mapa sinhronizacije za `items` (`sync-map.generated.ts`) nosi `Minimalna kolicina → minQuantity`,
  a `importItems()` gradi `data` upravo iz te mape (`itemsMapping()`), pa se kolona upisuje;
- u staging tabeli `bb_mdb_stage_artikli` **810 od 455.897** redova nosi ne-nultu minimalnu.

Dakle unos magacionera bi **prebrisao uvoz u 03:45**. To je isti razred kvara koji je 05.08.
pojeo podatke firme (`companies`), pa se rešava istim postupkom.

| pitanje | ODLUKA vlasnika (06.08.2026) |
|---|---|
| Čija je kolona `min_quantity` | **4.0 preuzima vlasništvo** — `minQuantity` izlazi iz mape sinhronizacije, uz branu koja pada ako je neko vrati. BigBit-ovih **162** vrednosti prestaju da stižu ovamo (u BigBitu ostaju netaknute do prelaska) |
| Ko sme da menja | **Samo tri imenovana čoveka**, kroz `user_permission_overrides` — isto kao knjige 05.08. Rola `magacioner` pravo **NE** nosi |

Izmereno na produkciji 06.08.2026:

| korisnik | id | rola | zatečena pojedinačna prava |
|---|---|---|---|
| dusko.kostic@servoteh.com | 42 | menadzment | 19 prava nad knjigama |
| radisav.radevic@servoteh.com | 51 | magacioner | `robno.read` |
| nikola.savic@servoteh.com | 52 | magacioner | — |

Stanje kolone: **162** artikla imaju minimalnu ≠ 0, **92.460** nulu, **3** prazno (od 92.625).

⚠️ Pravo je **usko — samo minimalna količina**. Ostatak kartice artikla ostaje zaključan
(unos artikala čeka razrešenje 4.298 duplih kataloških brojeva).

**Ostaje otvoreno i dalje blokira** (v. odeljak sa pitanjima):

- 🔴 **za knjigovođu:** sme li roba ugrađena u mašinu uopšte da stoji na 1320, ili se razdužuje u
  nedovršenu proizvodnju? Ako se razdužuje, ceo problem sa rezervacijama nestaje i dva koraka ovog
  plana otpadaju — zato se **ne kreće sa njima** dok odgovor ne stigne;
- 🔴 **za knjigovođu:** ostaje li „Stanje po knjigama" = ukupna zaliha i računa li se manjak prema njoj
  (preporuka plana: DA, formula se ne dira — inače bi 105 redova danas dalo lažan manjak i porez na
  robu koja postoji);
- **za vlasnika:** ko i kada popunjava minimalne količine — danas ih ima **162 od 92.625 artikala**, pa
  bi ekran „ispod minimalne" bio skoro prazan bez obzira kako je napravljen.

---

## 0. Napomena o merenju (pročitati pre svega ostalog)

Merenje koda je rađeno nad **`origin/main`** (radna kopija `C:\Users\nenad.jarakovic\wt\erp-prava`).
Primarni direktorijum `C:\Users\nenad.jarakovic\Documents\GitHub\servosync4` je u trenutku analize bio
**367 commitova iza `origin/main`** i njegov `robno/` modul ne odgovara onome što je živo — npr. u njemu
uopšte ne postoji `backend/src/modules/masters/` ni `backend/src/modules/robno/print/`, a upravo su to
dva mesta koja ovaj zahtev dotiče. Svaki nalaz ispod nosi putanju iz stabla koje odgovara `main`-u.

Merenje podataka je rađeno **read-only nad produkcijom**
(`ssh ubuntusrv 'docker exec -i servosync-pg psql -U servosync -d servosync'`), bez ijednog `UPDATE`/`INSERT`.
Merenje BigBit originala je rađeno nad `_legacy/Izvoz/` (SaveAsText izvoz Servotehovog APL-a).

---

## 1. Šta 4.0 već ima — izmereno

### 1.1 Sažetak (tabela)

| Stavka | Stanje | Gde |
|---|---|---|
| Popis / inventura (domen, tok, zaključenje) | **POSTOJI, ceo** | `backend/src/modules/robno/inventory.service.ts` |
| Popisna lista PDF (8 kolona, prazna+popunjena) | **POSTOJI** | `backend/src/modules/robno/print/inventory-count-pdf.service.ts` |
| Popisna lista — kolona **Polica** | **NE POSTOJI** | isto |
| Popisna lista — **Rezervisano / Slobodno** | **NE POSTOJI** | isto |
| Podaci nad kojima popis radi (`stock_documents`) | **PRAZNO na produkciji (0 redova)** | mereno |
| Rezervacije — native 4.0 (`stock_reservations`) | postoji kod, **0 redova na produkciji** | `backend/src/modules/robno/reservation.service.ts` |
| Rezervacije + **slobodna količina** — BigBit ogledalo | **POSTOJI I ŽIVO** | `backend/src/modules/masters/lager.service.ts` |
| Lager ekran sa kolonama Stanje/Rezervisano/Slobodno/**Polica** | **POSTOJI I ŽIVO** | `frontend/src/app/artikli/lager/page.tsx` |
| Polica na artiklu (`items.shelf`) | **POSTOJI**, puni je .mdb uvoz | `backend/prisma/schema.prisma` (model `Item`) |
| Minimalna količina (`items.minQuantity`) | **POSTOJI**, puni je .mdb uvoz | isto |
| Ekran/izveštaj „ispod minimalne" | **NE POSTOJI NIGDE** | mereno grep-om nad celim `backend/src` + `frontend/src` |
| Štampa (pdfmake stog, firma iz baze, trag štampe) | **POSTOJI, zreo** | `documents/pdf.service.ts`, `documents/doc-layout/`, `robno/print/robno-doc-layout.ts` |
| Štampa **živog** lagera (ogledala) | **NE POSTOJI** | postojeći `/robno/lager/pdf` gleda prazan native lager |

### 1.2 Popis (inventura)

**POSTOJI, potpuno izveden.**

- Tabele: `inventory_counts` / `inventory_count_items` (`backend/prisma/schema.prisma`, sekcija „D) POPIS / inventura").
  Stavka nosi `bookQuantity` (KolKng), `countedQuantity` (KolPop) i `price` (prosečna nabavna).
- Servis: `backend/src/modules/robno/inventory.service.ts` — `createCount` (predpunjenje), `updateItem`
  (unos popisane količine, CAS guard na status `COUNTING`), `differences` (razlika + zbirovi),
  `finalize` (kreira VISAK/MANJAK robne dokumente pa CAS `COUNTING → POSTED`).
- Rute (`backend/src/modules/robno/robno.controller.ts`): `GET/POST /api/v1/robno/inventory-counts`,
  `GET :id`, `GET :id/differences`, `PATCH :id/items/:itemId`, `POST :id/finalize`,
  `GET :id/pdf?variant=prazna|popunjena`.
- Ekran: `frontend/src/app/robno/popis/` (`page.tsx`, `new-count-dialog.tsx`, `count-detail.tsx`);
  navigacija `frontend/src/lib/navigation.ts` → „Popis / inventura", pravo `robno.read`.
- **Zaključenje popisa:** razlika `KolPop − KolKng`; `> 0` → dokument vrste `VISAR`, `< 0` → `MANJR`
  (podrazumevano; klijent može poslati `VISAM`/`MANJM` za magacin materijala). Manjak ide kao POZITIVNA
  količina uz `kind=MANJAK`, pa važi guard nedovoljnog stanja. Zatim kalkulacija/knjiženje kroz
  postojeće `/documents/:id/calculate` + `/post`.

🔴 **ALI — modul nema podatke.** Mereno na produkciji:

```
stock_documents      0
stock_document_items 0
stock_levels         0
stock_reservations   0
inventory_counts     0
kepu_book_entries    0
invoices             0
```

Predpunjenje popisa (`InventoryService.candidateItemIds`) čita `stock_document_items`, pa bi **svaki
danas kreiran popis imao NULA stavki**. Robno se do cutovera (april 2027) vodi isključivo u BigBitu.

### 1.3 Rezervacije i „slobodna količina" — **postoje DVE nezavisne implementacije**

Ovo je najvažniji nalaz plana i on menja gde se posao izvodi.

**(a) Native 4.0 — mrtvo dok robno ne pređe u 4.0**
`backend/src/modules/robno/reservation.service.ts`. Izvor istine = agregat otvorenih redova
`stock_reservations` (`status='OPEN'`); `available = onHand − Σ OPEN`, gde se `onHand` računa iz
`stock_document_items` (`computeOnHand`). Rute `/robno/availability`, `/robno/reservations`.
Kolona `stock_levels.reserved` je mrtav legacy snapshot koji niko ne upisuje i namerno se ne dira.
**Produkcija: 0 rezervacija, 0 stavki → sve nule.**

**(b) BigBit ogledalo — ŽIVO, ovo korisnik danas gleda**
`backend/src/modules/masters/lager.service.ts`, ruta `GET /api/v1/artikli/lager` (kontroler
`backend/src/modules/masters/items.controller.ts`), ekran `frontend/src/app/artikli/lager/page.tsx`,
navigacija „Lager lista" pod Matičnim podacima (pravo `directory.read`).

Čita ogledala koja puni noćni `.mdb` uvoz. Mereno na produkciji:

```
goods_documents_mirror       27.550
goods_document_items_mirror 185.102
```

Formula (doslovno iz servisa):

```
stanje(artikal, magacin)      = Σ(quantity_in − quantity_out)  nad  level = 0,  sečeno po poslovnoj godini
rezervisano(artikal, magacin) = Σ COALESCE(quantity, quantity_in + quantity_out)
                                nad  is_reservation = true AND level > 0  (podrazumevano ista godina)
slobodno                      = stanje − rezervisano
```

Kolone koje ekran već prikazuje: `Kataloški broj · Naziv · J.m. · **Polica** · Magacin · Stanje ·
Rezervisano · **Slobodno** · VP cena`, uz sort po svakoj od njih i CSV izvoz.

→ **Slobodna količina već postoji i već se prikazuje pored stanja** — samo na lager listi, ne na
popisnoj. To je tačno stanje kakvo vlasnik opisuje za BigBit.

**Mereno na produkciji (godina 2026, tačna formula servisa):**

| Merenje | Vrednost |
|---|---|
| Redova lagera (par artikal × magacin) | **7.727** |
| … sa stanjem ≠ 0 | **7.179** |
| … sa negativnim stanjem | 0 |
| … sa rezervacijom ≠ 0 | **470** |
| 🔴 … stanje > 0 **a slobodno ≤ 0** (celo rezervisano) | **105** |
| … rezervisano veće od stanja (slobodno < 0) | 1 |
| Različitih artikala u lageru | 7.700 |
| Magacina | 3 (`1 Magacin robe`, `2 Repro`, `44 Gotovi proizvodi`) |

Po magacinu: Magacin robe 6.879 redova / 6.429 sa stanjem / 378 sa rezervacijom · Repro 818 / 750 / 92 ·
Gotovi proizvodi 30 / **0 sa stanjem** / 0.

Vrste rezervacionih dokumenata u 2026: `REZR` (33 dok.) i `REZM` (18 dok.), svi `level = 250`.

### 1.4 Polica — i šta NIJE polica

**`items.shelf`** — `String? @db.VarChar(20)`, mapirano na `shelf`, BigBit kolona `Polica`.
Puni je noćni `.mdb` uvoz (`bb_mdb_stage_artikli.polica`). Mereno poklapanje stage → items na poslednjem
dropu (id 7): **92.623 uparenih redova, 3 razlike u polici, 0 razlika u minimalnoj količini** → uvoz je
1:1, ne treba ga dirati.

Gde se već prikazuje: kolona „Polica" na `/artikli` (`frontend/src/app/artikli/page.tsx`), kolona +
sort „Polica" na `/artikli/lager`, polje „Polica" u formi artikla.

🔴 **NE MEŠATI sa domenom `locations`.** `backend/src/modules/locations/` (+ `frontend/src/app/lokacije`,
`/mob/lokacije`, `part-locations`) je potpuno drugi sistem: lokacije **komada / radnih naloga u hali**,
poreklom iz sy15, ključevi UUID, tipovi `hall | shelf | cage | machine`, barkodovi `LP:uuid:uuid` i
`HALA-POLICA`. Reč „shelf" tamo znači policu u hali za komad iz proizvodnje. `items.shelf` je slobodan
tekst police magacina **po artiklu**. Između njih ne postoji nikakva veza — ni u šemi, ni u kodu, ni u
podacima. Ovaj plan dira **isključivo `items.shelf`**.

**Mereno na produkciji:**

| Merenje | Vrednost |
|---|---|
| Artikala ukupno | 92.625 (91.208 iz BigBita, `external_item_id > 0`) |
| Artikala sa upisanom policom | **2.840** (3,1 %) |
| Različitih vrednosti police | 635 |
| 🔴 Redova lagera **sa stanjem** koji imaju policu | **2.390 od 7.179 = 33,3 %** |
| 🔴 Redova lagera sa stanjem **bez police** | **4.789** |

Najčešće police (na redovima sa stanjem): `K5` 80 · `H9` 76 · `J4` 62 · `H4` 59 · `K2` 49 · `H7` 45 ·
`K1` 39 · `K3` 37 · `D1/7` 33 · `H8` 33 · … i slobodan tekst tipa `ispred mag` (31 red) — polje je
Text, ne šifarnik, i u podacima to i piše.

### 1.5 Minimalna količina

**`items.minQuantity`** — `Float? @default(0) @map("min_quantity")`, BigBit `Minimalna kolicina`.
Puni je isti .mdb uvoz, poklapanje 1:1 (0 razlika).

Gde se prikazuje: **samo u formi artikla** (`frontend/src/app/artikli/_forma/…`, polje „Minimalna
količina"). Nije kolona ni na jednoj listi. **Nijedan ekran, izveštaj ni ruta „ispod minimalne" ne
postoji** — provereno grep-om nad celim `backend/src` i `frontend/src` na `main`-u. Jedini presedan za
takvu logiku u repou je CMMS: `backend/src/modules/odrzavanje/odrzavanje.service.ts:1195`,
„Ispod minimuma" = `current_stock <= min_stock` (paritet 1.0, **`<=`, ne `<`**).

**Mereno na produkciji:**

| Merenje | Vrednost |
|---|---|
| Artikala sa `min_quantity > 0` | **162** (od 92.625 = 0,17 %) |
| Raspodela | 2 → 73 art. · 5 → 25 · 1 → 15 · 100 → 15 · 3 → 8 · 50 → 6 · 60 → 5 · 30 → 4 · 20 → 4 · 4 → 4 · 10 → 3 |
| Presek: ima i minimalnu i policu | 87 |
| **Ispod minimalne po UKUPNOM STANJU** (2026) | **86** |
| **Ispod minimalne po SLOBODNOJ količini** (2026) | **86** |
| Razlika između ta dva skupa **danas** | **0** |
| 🔴 Od tih 86 — bez ijednog reda u lageru 2026 (nema prometa) | **79** |

Tumačenje: izbor „stanje vs slobodna" **danas ne menja nijedan red**, ali to je osobina podataka, ne
pravilo — čim jedan artikal sa minimalnom količinom uđe u rezervaciju, razlika se pojavi. Znatno veći
problem je da bi **79 od 86 pogodaka bili artikli bez prometa u tekućoj godini** (stanje 0 → formalno
ispod minimuma), tj. mrtve šifre, a ne stvarne potrebe nabavke.

### 1.6 Štampa — čime bi se ovakav PDF pravio

Zreo, zajednički stog; nema potrebe za novom zavisnošću.

- `backend/src/modules/documents/pdf.service.ts` — pdfmake 0.3, Roboto (pokriva srpsku latinicu).
- `backend/src/modules/documents/doc-layout/index.ts` — `loadIssuer(prisma, companyId)`,
  `loadPrintedBy(prisma, userId)`, značke, paleta.
- `backend/src/modules/robno/print/robno-doc-layout.ts` — `buildDocHeader`, `buildDocTable`,
  `buildFilterStrip`, `buildPageFooter`, `buildSignatureRow`, `buildControlSum`, `PAGE_LANDSCAPE`,
  `GRID_LAYOUT`, `fmtQty`, `fmtMoney`, `safeFileName`.
- `backend/src/modules/documents/document-print.service.ts` — trag štampe (`document_prints`), redni
  broj primerka, žig „KOPIJA"; `DOCUMENT_PRINT_KIND` = `STOCK | INVENTORY_COUNT | INVOICE |
  PURCHASE_ORDER | GL_JOURNAL | CASH_JOURNAL | BANK_STATEMENT`.

**Postojeće štampe robnog** (`robno.controller.ts`): `GET /robno/documents/:id/pdf`,
`/robno/documents/:id/prijem-zapisnik/pdf`, `/robno/inventory-counts/:id/pdf`, `/robno/lager/pdf`,
`/robno/item-card/pdf`.
🔴 `/robno/lager/pdf` (`print/stock-report-pdf.service.ts`) čita `RobnoService.listLager`, tj. **prazan
native lager** → danas izlazi prazan papir. Živi lager (ogledalo) nema nijednu štampu.

**Postojeća popisna lista PDF** — `backend/src/modules/robno/print/inventory-count-pdf.service.ts`:
A4 položeno, dvoredno grupisano zaglavlje, varijante `prazna` (za teren) i `popunjena`, potpisi
„Odgovorno lice | Za knjigovodstvo | Članovi komisije za popis 1) 2) 3)", red „Organizaciona jedinica:
______" i „Popisna lista broj: ____ · list ___ od ___", noga „strana N/M" + trag štampe + kontrolni zbir.

Kolone varijante `popunjena`:
`R.Br. | Kat. broj | Bar kod | Naziv artikla | Jed. mere | Cena | [Stanje po knjigama: Količina, Iznos]
| [Stanje po popisu: Količina, Iznos] | [Višak: Količina, Iznos] | [Manjak: Količina, Iznos]` + red `S V E G A`.
→ **Poklapa se sa slikama koje je vlasnik doneo.** Nedostaju tačno tri kolone iz zahteva:
**Polica**, **Rezervisano**, **Slobodno**.

**Firma se nigde ne upisuje tvrdo.** `loadIssuer` čita `companies` (po `companyId`, inače najmanji `id`).
Produkcija: 1 red — `id 0`, „Servoteh d.o.o.", Dobanovci, Ugrinovačka 163, PIB 101017443, MB 17400169,
`logo` prazan. Postoji rezervni naziv „Servoteh d.o.o." u kodu ako je tabela prazna, ali se vraća sa
`isFallback: true` (v. §5, tačka o drugoj firmi).

### 1.7 BigBit original — izmereno iz `_legacy/Izvoz/`

Ovo je jedini deo koji dokazuje šta je vlasnik tačno video.

**`Upiti/Lager Lista_1Korak.sql`** (RecordSource cele lager priče):

```
Round(Nz([RezervisanaKolicina],0),3) AS RezKol,
Nz([Kolicina],0) - Nz([RezKol],0)   AS SlobodnaKol,
EXT_R_Artikli.Polica
```

→ **BigBit slobodnu količinu računa istom formulom kao mi, i `Polica` mu je u istom upitu.**

**`Upiti/LL_RezervisaneKolicine.sql`:**

```sql
SELECT [Profakture stavke].[Sifra artikla], Sum(Kolicina) AS RezervisanaKolicina
FROM Profakture INNER JOIN [Profakture stavke] ON …
WHERE Profakture.Ulaz = No AND Profakture.Rezervisi = True
GROUP BY [Profakture stavke].[Sifra artikla];
```

🔴 BigBit rezervacije **ne seče ni po godini ni po magacinu**. Naša implementacija ih podrazumevano seče
po poslovnoj godini i grupiše po (artikal, magacin) — namerno i dokumentovano (bez sečenja bi kolona
SLOBODNO pokazivala masovnu prezauzetost: mereno ≈ 1,08 M jedinica ukupno prema ≈ 71 k u 2026). Posledica
koju treba znati: **naše „Slobodno" se već razlikuje od BigBitovog `SlobodnaKol`** — v. pitanje P8.

**`Izvestaji/PopisnaListaSaPolicama.txt`** (SaveAsText izvoz izveštaja):

- `RecordSource = "Lager lista"` — 🔴 **isti upit koji već nosi `SlobodnaKol`. BigBit tu kolonu ima na
  dohvat ruke i prosto je ne štampa.** Zahtev vlasnika je zato po podacima trivijalan; sav teret je u
  odluci šta znače višak i manjak (§2).
- Štampa **6 kolona**: `R.Br. (=1, tekući) | Kat. broj | Naziv | Jed. mere | **Polica** | **Količina**`.
- Grupisanje/sort: `Grupa → Kataloški broj → Naziv`.
- Zaglavlje: naslov `="Popisna lista "`, firma `=DLookUp("[Firma]","Radni fajlovi", …)` (**iz baze, ne
  tvrdo**), magacin `=DLookUp("[Magacin]","Magacini", … [Forms]![Lager lista]![ZaMagacin])`,
  `"sa stanjem na dan ________________________"` (prazno), `"Organizaciona jedinica_________"` (prazno).
- Noga: `=[Page] & " od " & [Pages]`.

🔴 **Razlika u odnosu na slike:** Servotehov `PopisnaListaSaPolicama` **nema** kolone `Iznos`, ni blokove
`Stanje po popisu / Višak / Manjak`. Ti blokovi su sa slika iz instalacije **HAP FLUID d.o.o.** — druga
(bogatija) verzija obrasca. Naš 4.0 `InventoryCountPdfService` **te kolone već ima**; nema policu.

**`Forme/Lager lista.txt`** — potvrđuje ekran sa slika: natpisi `Zalihe\nkoličina`, `Rezerv.\nkoličina`,
`Slobodna\nkoličina`, `Polica`, prekidači „Prikazati i artikle koji nemaju zalihe?" i „Prikazati art.
koji nemaju rezervaciju?", i dugme `DugmePopisSaPolicama` → `DoCmd.OpenReport "PopisnaListaSaPolicama"`.

🔴 **`LL_ArtikliIspodMinKolicine` NIJE u Servotehovom izvozu** (`grep -r IspodMin _legacy/Izvoz` = 0
pogodaka). Naveden je samo u našem katalogu
`backend/docs/migration/20-bigbit-stampani-dokumenti-katalog.md:68` kao izveštaj „nad upitom `Lager
lista`" — ali `Minimalna kolicina` **nije u SELECT-u** tog upita, pa je ili DLookUp ili drugi
RecordSource. **Ne mogu da izmerim da li BigBit poredi minimalnu sa `Kolicina` (stanje) ili sa
`SlobodnaKol`.** → pitanje P6.

---

## 2. Suštinsko pitanje: rezervisana roba je ugrađena, a knjigovodstveno je na stanju

### 2.1 Koja kolona je „Stanje po knjigama"?

**Preporuka: ostaje UKUPNA ZALIHA (stanje). Ne dirati.**

Obrazloženje. „Stanje po knjigama" je pravni termin sa propisanog obrasca — to je broj koji stoji u
KEPU knjizi i na kontu 1320, i to je tačno ono što revizor upoređuje sa prebrojanim. Rezervacija je
komercijalna zastavica na predračunu (`REZM`/`REZR`, `Rezervisi=True`), ona **ne knjiži ništa**: ne
menja ni GK, ni KEPU, ni PDV evidenciju. Ako bi „Stanje po knjigama" postalo slobodna količina, popisna
lista bi tvrdila da firma poseduje manje robe nego što je proknjižila — dokument bi se razišao sa
glavnom knjigom i bio bi neupotrebljiv za reviziju.

Vlasnik to i sam kaže: „knjigovodstveno je i dalje na stanju". Problem nije u koloni „po knjigama" —
problem je što popisivač u ruci ima manje komada nego što piše, pa **prijavi manjak koji ne postoji**.
To se rešava u kolonama 2.2 i postupkom 2.3, a ne premeštanjem knjigovodstvenog stanja.

### 2.2 Gde ide slobodna količina?

**Preporuka: dve dodatne kolone — `Rezervisano` i `Slobodno` — LEVO od bloka „Stanje po knjigama", i
DA, štampaju se.**

- **Zašto se štampaju:** popisna komisija je na terenu bez ekrana. Ako papir ne kaže „od 120 komada je
  40 ugrađeno u mašinu", popisivač prebroji 80 i upiše 80 → manjak 40. To je bukvalno greška koju
  vlasnik opisuje. Kolona koja se vidi samo na ekranu ne rešava ništa.
- **Zašto LEVO od propisanog bloka, a ne unutra:** blok
  `Stanje po knjigama / Stanje po popisu / Višak / Manjak` je ono što knjigovođa i revizor čitaju i
  sabiraju. Kolona ubačena u taj blok razbija zbirove i ustaljeno čitanje obrasca. Zato: identifikacija
  artikla (`R.Br. | Kat. broj | Naziv | J.m. | Polica`) → **radne kolone (`Rezervisano`, `Slobodno`)**
  → propisani blok, netaknut.
- **Vizuelno:** radne kolone manjim/sivim slogom + rečenica u nozi:
  „Rezervisano = roba obećana/ugrađena po predračunu; ona JESTE na knjigovodstvenom stanju i MORA se
  upisati u „Stanje po popisu"."
- **Na ekranu** (`/artikli/lager` i detalj popisa) kolone već postoje odnosno se dodaju istim redom.

*Alternativa ako knjigovođa odbije bilo šta van propisanog obrasca:* radne kolone samo na ekranu +
zasebna „radna popisna lista" za teren. Ne preporučujem — to znači dva papira u ruci komisije i
prepisivanje između njih.

### 2.3 Kako se onda računaju višak i manjak? 🔴 najrizičnije pitanje

**Preporuka: formula se NE MENJA. `razlika = popisano − knjigovodstveno stanje`, kao i danas.**
`InventoryService.differences` i `InventoryService.finalize` ostaju netaknuti.

Zašto ne prema slobodnoj količini:

- Manjak vodi u dokument vrste **`MANJR`** (šema 50: potražuje 1320 zalihe, duguje 5741 rashod po
  manjku) → knjiži se u GK.
- Manjak iznad normativa je u Srbiji **oporeziv PDV-om** (tretira se kao sopstvena potrošnja). Ako bi
  se manjak računao prema slobodnoj količini, **svaka rezervisana stavka bi se automatski prijavila kao
  manjak** i firma bi platila porez na robu koja postoji. Mereno: **105 redova** danas ima stanje > 0 a
  slobodno ≤ 0 — to je 105 lažnih manjaka u punom iznosu zalihe, u jednom kliku.
- Obrnuto (višak) bi kroz `VISAR` (šema 46, potražuje 6740) lažno povećao prihod.

Problem se rešava **postupkom, ne formulom**: rezervisana/ugrađena roba se **popisuje kao prisutna**.
Zato uz kolone iz 2.2 idu dve pomoći:

1. **Na papiru:** kolona `Slobodno` govori komisiji koliko komada neće naći, a prazna kolona `Napomena`
   služi da upiše gde su (nalog/mašina).
2. **Na ekranu** (`frontend/src/app/robno/popis/count-detail.tsx`): pored polja „Popisano" malo dugme
   `+N rez.` koje dodaje rezervisanu količinu. Komisija prebroji 80 fizički prisutnih, klikne, dobije 120
   → razlika 0, nema ni viška ni manjka. (Korak K5.)

🔴 **Mora da potvrdi knjigovođa** (P2, P3): da li je ispravno da roba već ugrađena u mašinu koja nije
isporučena stoji na zalihi 1320. Ako se ugradnjom razdužuje u nedovršenu proizvodnju, **ovaj problem
uopšte ne postoji** — roba tada nije ni na stanju ni na popisnoj listi, a rezervacija na popisu ne bi
smela da se pojavi. To pitanje presuđuje da li su koraci K4/K5 uopšte potrebni.

### 2.4 Artikal koji je ceo rezervisan (slobodno = 0, stanje > 0)

**Mereno: 105 redova** u lageru 2026 (stanje > 0, slobodno ≤ 0); od toga **1 red** ima rezervisano veće
od stanja (slobodno < 0).

**Preporuka: pojavljuje se na listi normalno, ali OZNAČEN.**

- **Nikako ga ne izostavljati.** Artikal koji je izostavljen sa popisne liste se pri zaključenju popisa
  ponaša kao da nije prebrojan — a ako je uopšte u popisu, `countedQuantity = 0` daje **manjak jednak
  celoj zalihi**. Izostavljanje je najgora od svih opcija.
- Na papiru: u koloni `Slobodno` ispis `0` uz oznaku, npr. `0 ⟨celo rezervisano⟩`, i red blago zasenčen.
- Na ekranu: obrazac već postoji — lager panel boji `available ≤ 0` crveno uz ikonicu upozorenja
  (`frontend/src/app/robno/lager-panel.tsx`, `frontend/src/app/artikli/lager/page.tsx`).
- Poseban slučaj `rezervisano > stanja` (danas 1 red): to je greška u BigBit podacima, ne u popisu.
  Papir sme da prikaže negativno `Slobodno`; `Stanje po knjigama` ostaje pozitivno i nepromenjeno.

---

## 3. „Artikli ispod minimalne količine"

### 3.1 Sa čim se poredi minimalna?

**Preporuka: sa SLOBODNOM količinom — `slobodno <= minimalna` — uz prekidač
„poredi sa: slobodnom (podrazumevano) / ukupnim stanjem".**

Obrazloženje: izveštaj postoji da bi neko **naručio robu**. Rezervisano je već obećano kupcu odnosno
ugrađeno u mašinu i neće se vratiti u magacin, pa je u trenutku odluke o nabavci slobodna količina ono
što firma stvarno ima na raspolaganju. Poređenje sa ukupnim stanjem propušta baš one artikle koji su
najhitniji — ima ih na papiru, nema ih u ruci. (Ovo je ista logika po kojoj rezervacija postoji: da se
ista roba ne obeća dvaput.)

Prekidač postoji zato što se **nabavka** i **knjigovodstvo** ne slažu oko toga šta je „imamo", pa
izveštaj ne sme da nametne jedan odgovor obojici.

**Prag `<` ili `<=`:** preporuka **`<=`** — na tačno minimumu se već poručuje, i to je presedan koji 4.0
već ima u CMMS-u (`odrzavanje.service.ts:1195`, paritet 1.0). Uz to kolona **`Nedostaje` =
`minimalna − slobodno`**, da lista bude odmah upotrebljiva kao osnov za trebovanje.

### 3.2 Dva merenja koja moraju u dizajn

| Nalaz | Posledica |
|---|---|
| Razlika „po stanju" vs „po slobodnoj" je **danas 0** (86 = 86) | Izbor se ne vidi na prvi pogled — mora da postoji **oznaka na ekranu i na papiru** po kom kriterijumu je lista napravljena, inače niko neće znati šta gleda |
| **79 od 86** pogodaka su artikli **bez ijednog prometa u 2026** | Bez filtera bi izveštaj otvorio 79 lažnih uzbuna i niko ga ne bi koristio → **prekidač „samo artikli sa prometom u tekućoj godini", podrazumevano UKLJUČEN** |
| Samo **162 od 92.625** artikala ima minimalnu količinu (0,17 %) | Izveštaj je danas skoro prazan. Ako se od njega očekuje da vodi nabavku, minimalne se moraju popuniti — **u BigBitu**, jer je on master do cutovera (P7) |
| Nije poznato šta BigBit tačno radi (`LL_ArtikliIspodMinKolicine` nije u izvozu) | Ne može se garantovati paritet broja redova sa BigBitom — mora se reći korisniku, ne prećutati (P6) |

---

## 4. Plan izvođenja

### 4.0 Osnovna odluka: gde se gradi

Robno se do aprila 2027 vodi u BigBitu; 4.0 native robne tabele su prazne (mereno). Zato:

- **Popisna lista sa policama i „ispod minimalne" grade se nad ŽIVIM ogledalom**
  (`backend/src/modules/masters/lager.service.ts`) — to je jedino mesto gde danas postoje stanje,
  rezervisano i slobodno.
- **Native popis se ne prepravlja, samo dopunjuje** (K4/K5), da bude spreman za cutover. Dok su
  `stock_documents` prazni, ta dopuna se ne može dokazati na produkciji → testira se na dev bazi.

### 4.1 Koraci

| # | Korak | Veličina | Zavisi od |
|---|---|---|---|
| K1 | Polica i minimalna količina u lager podacima i filterima | **mali** | — |
| K2 | Ekran „Artikli ispod minimalne količine" | **srednji** | K1, odluka P6/P7 |
| K3 | PDF „Popisna lista sa policama" nad ogledalom | **srednji** | K1, odluka P4/P5 |
| K4 | Kolone Polica/Rezervisano/Slobodno u native popisnoj listi | **mali** | odluka P1/P2/P3 |
| K5 | Dugme „Popisano = fizički + rezervisano" na detalju popisa | **mali** | K4 |
| K6 | Polica po magacinu (zasebna tabela) | **veliki** | 🔴 NE RADITI — v. 4.2 |

---

#### K1 — Polica i minimalna količina u lager podacima (mali)

**Fajlovi:**
- `backend/src/modules/masters/lager.service.ts` — u `SELECT` lagera dodati `it.min_quantity`
  (`it.shelf` je već tu); novi filteri u `WHERE`.
- `backend/src/modules/masters/dto/list-lager.dto.ts` — novi parametri: `shelf` (tačno/prefiks),
  `hasShelf` (`true|false`), `belowMin` (`true`), `minCompare` (`free` | `stock`),
  `onlyWithTurnover` (`true`); dodati `minQuantity` u `LAGER_SORT_COLUMNS`.
- `backend/src/modules/masters/lager.service.ts` — dodati `minQuantity: "it.min_quantity"` u `SORT_EXPR`.
- `frontend/src/api/lager.ts` — tipovi + parametri.
- `frontend/src/app/artikli/lager/page.tsx` — kolone „Min." i „Nedostaje" (prikazane tek kad je filter
  uključen — lager se ne zatrpava), filter police.

**Rizik:** nizak. 🔴 Jedina prava zamka: `SORT_EXPR` + `LAGER_SORT_COLUMNS` su **allowlist i jedina brana
od SQL injekcije** (izraz sorta ide kroz `Prisma.raw`). Nova kolona mora ući u **oba** spiska, inače
sort tiho puca ili — gore — propušta.
Druga zamka: `min_quantity` je `Float` (`double precision`), a lager barata `numeric` — poređenje
`l.free <= it.min_quantity` mora imati eksplicitan `::numeric` cast, inače se pojavljuju granični
promašaji na vrednostima tipa 0,1.

**Migracija baze: NE.**

---

#### K2 — Ekran „Artikli ispod minimalne količine" (srednji)

**Fajlovi:**
- `frontend/src/app/artikli/ispod-minimalne/page.tsx` — nova ruta (statički export → **bez `[id]` ruta**,
  parametri kroz query string).
- `frontend/src/lib/navigation.ts` — stavka pod Matičnim podacima, pravo `directory.read` (isto kao
  „Lager lista"), ključne reči „minimalna, minimum, nabavka, poručiti, nedostaje".
- `frontend/src/api/lager.ts` — hook nad istom rutom sa prethodno postavljenim filterom.
- Backend: **ništa novo** — koristi K1 filtere nad `GET /api/v1/artikli/lager`.

**Sadržaj ekrana:** kolone `Kat. broj · Naziv · J.m. · Polica · Magacin · Stanje · Rezervisano ·
Slobodno · Min. · Nedostaje`; prekidači „poredi sa: slobodnom / stanjem", „samo sa prometom u godini"
(podrazumevano uključeno), magacin, grupa; CSV izvoz (`exportTableToCsv`, već postoji);
🔴 **obavezna traka koja ispisuje poslovnu godinu, domet rezervacija i kriterijum poređenja** — isti
obrazac kao lager ekran, jer bez toga korisnik gleda „neku" godinu i „neki" kriterijum.

**Rizik:** nizak tehnički. Pravi rizik je **poslovni**: sa 162 popunjene minimalne količine izveštaj je
skoro prazan i može se doživeti kao „ne radi". Zato ekran mora sam da napiše koliko artikala uopšte ima
upisanu minimalnu količinu (npr. „162 od 92.625 artikala ima minimalnu količinu — ostali se ne prate").

**Migracija baze: NE.**

---

#### K3 — PDF „Popisna lista sa policama" nad ogledalom (srednji)

**Fajlovi:**
- `backend/src/modules/masters/print/lager-print.service.ts` — **nov**.
- `backend/src/modules/masters/masters.module.ts` — registracija (+ `DocumentsModule` za `PdfService`).
- `backend/src/modules/masters/items.controller.ts` — `GET /api/v1/artikli/lager/popisna-lista/pdf`
  🔴 **mora stajati PRE `@Get(":id")`** (Nest bira prvu rutu koja se poklopi — pravilo je već zapisano
  u tom fajlu za `lookups` i `lager`).
- `frontend/src/app/artikli/lager/page.tsx` — dugme „Popisna lista sa policama".

**Kolone:**
`R.Br. | Kat. broj | Naziv | Jed. mere | **Polica** | **Stanje** | **Rezervisano** | **Slobodno** |
Popisano (prazno) | Napomena (prazno)` — A4 položeno.

**Grupisanje: po POLICI**, a ne kao BigBit po grupi artikla — popisivač fizički ide polica po polica.
Artikli bez police idu u grupu **„BEZ POLICE"** na kraj (🔴 to je **4.789 od 7.179 redova**, dve trećine
liste — nije rubni slučaj). Ovo je jedina namerna razlika od BigBita i **mora je potvrditi vlasnik** (P4/P5).

**Zaglavlje i noga** (sve kroz postojeći `robno-doc-layout.ts`):
firma iz `loadIssuer(prisma, companyId)`; naslov „POPISNA LISTA"; podnaslov
„sa stanjem na dan ______" (prazno, kao BigBit) ili sa datumom ako je zadat; red „Organizaciona
jedinica: ______"; naziv magacina iz `warehouses`; traka primenjenih filtera (**poslovna godina, domet
rezervacija, magacin, grupa, pretraga**) — bez nje izveštaj nije dokaziv; potpisi
„Odgovorno lice | Za knjigovodstvo | Članovi komisije 1) 2) 3)"; noga „strana N od M" + ko je štampao +
kontrolni zbir (broj redova, Σ stanje, Σ rezervisano).

**`DOCUMENT_PRINT_KIND` se NE proširuje** — ovo je izveštaj (nema dokument-vlasnika i nema `documentId`),
pa nema traga „KOPIJA" ni brojanja primeraka. Trag ima smisla tek za popis iz K4, koji vlasnika ima.

**Rizik:** srednji.
- 🔴 **Obim.** ~7.200 redova sa stanjem (bez filtera) → BigBitova štampa je bila 236 strana. Koristiti
  isti obrazac kao `StockReportPdfService.buildLagerPdf` (petlja kroz strane servisa do `maxRows`), ali
  **kapu podići sa 5.000 na ≥ 10.000** ili tražiti obavezan filter magacina. Kapa koja tiho odseče listu
  je najgori mogući ishod za popisni dokument — ako odsecanje nastupi, papir to **mora** da napiše.
- Memorija/CPU pri render-u; pdfmake tabela sa 10 kolona × 7.200 redova se mora meriti pre isporuke.
- Grupisanje po polici menja poznati BigBit redosled — bez potvrde vlasnika ne isporučivati.

**Migracija baze: NE.**

---

#### K4 — Kolone u native popisnoj listi (mali; za cutover)

**Fajlovi:**
- `backend/src/modules/robno/print/inventory-count-pdf.service.ts` — u varijantu `popunjena` dodati
  `Polica`, `Rezervisano`, `Slobodno` **levo od bloka „Stanje po knjigama"** (blok ostaje netaknut,
  `colSpan` nadnaslova i `injectSubHeader` se pomeraju za 3); u varijantu `prazna` dodati `Polica`.
- `backend/src/modules/robno/inventory.service.ts` — `differences` vraća i `reserved`/`available` po
  stavci (samo za prikaz).
- Izvor rezervisanog: `sumOpenReservations(...)` iz `backend/src/modules/robno/reservation.service.ts`
  (već eksportovano, jedan `groupBy`, bez N+1).

🔴 **`differences` i `finalize` NE menjaju formulu** — višak/manjak i dalje prema `bookQuantity`
(odluka 2.3). Nove vrednosti su isključivo prikazne.

**Rizik:** nizak po kodu, ali 🔴 **ne može se dokazati na produkciji** dok su native robne tabele
prazne. Obavezno: test na dev bazi (192.168.64.28:5437) + obrazac iz `backend/scripts/robno-print-proof.ts`
+ `backend/src/modules/robno/print/robno-print.service.spec.ts`.
Druga zamka: `Polica` na popisnoj listi popisa dolazi iz `items.shelf` koji **noćni uvoz prepisuje** —
polica odštampana danas ne mora biti ista sutra. Za popisni dokument to je prihvatljivo (popis je presek
na dan), ali mora stajati u nozi.

**Migracija baze: NE.**

---

#### K5 — „Popisano = fizički + rezervisano" (mali)

**Fajl:** `frontend/src/app/robno/popis/count-detail.tsx` — pored polja „Popisano" dugme `+N rez.` koje
dodaje rezervisanu količinu stavke; tooltip: „Roba je rezervisana/ugrađena — knjigovodstveno je na
stanju i mora se popisati kao prisutna."

**Rizik:** nizak. Ovo je korak koji **stvarno rešava vlasnikov problem** — bez njega komisija i dalje
ručno sabira i greši.

---

#### K6 — Polica po magacinu 🔴 NE RADITI SADA

Danas je polica **jedno polje na artiklu** (`items.shelf`), a artikal može stajati u 3 magacina. Teorijski
bi trebala tabela `item_shelf_locations (item_id, warehouse_id, shelf)`.

**Ne predlažem migraciju, i evo merenja zašto:** lager 2026 ima **7.727 redova na 7.700 različitih
artikala** → svega ~27 artikala uopšte stoji u više od jednog magacina. Problem koji bi tabela rešavala
praktično ne postoji. Predlagati migraciju bez tog merenja značilo bi izmisliti problem.

Drugi razlog: `items` je **BigBit-ov red**, a `items.shelf` uvoz prepisuje svake noći — svaka „naša"
polica upisana u to polje bila bi pregažena. Overlay nad sync-ovanim tabelama je otvorena arhitektonska
odluka (`backend/docs/BACKEND_RULES.md` §4 / §11.1) i ne sme se prejudicirati.

### 4.2 Redosled

**K1 → K2 → K3 → (K4 ‖ K5) → K6 nikad bez novog merenja.**

K1 je preduslov svemu i sam po sebi već daje korist (filter po polici na lageru). K2 i K3 su nezavisni
isporučivi. K4/K5 čekaju odgovor knjigovođe (P1–P3) i nemaju hitnost jer native robno stoji prazno do
cutovera.

---

## 5. Druga firma (HAP FLUID d.o.o.) — šta ne sme biti tvrdo upisano

- **Firma, adresa, PIB, MB, mesto, žiro račun:** isključivo `loadIssuer(prisma, companyId)` iz
  `backend/src/modules/documents/doc-layout/index.ts`, koji čita `companies`. Isti obrazac koji već
  koriste IOS, faktura, PDV i sve robne štampe. BigBit radi isto (`DLookUp("[Firma]","Radni fajlovi",…)`).
- 🔴 **Rezervni naziv u kodu:** `loadIssuer` vraća `"Servoteh d.o.o."` sa `isFallback: true` kad je
  `companies` prazna. To je prihvatljivo samo dok zaglavlje **vidno označava** da je naziv rezervni. Za
  isporuku drugoj firmi proveriti da svaki novi šablon poštuje `isFallback` — inače bi HAP FLUID-ov
  papir tiho pisao „Servoteh d.o.o.".
- **Logo:** `companies.logo` (`bytea`) je na produkciji **prazan**, a u repou postoji
  `backend/src/modules/documents/servoteh-logo.ts` (`SERVOTEH_LOGO_DATA_URL`) koji koristi IOS. Nova
  štampa mora ići **iz `companies.logo` sa padom na „bez logoa"**, nikad na Servoteh konstantu.
- **Organizaciona jedinica:** BigBit je štampa kao praznu crtu. Isto i kod nas — prazna crta koju
  komisija popuni, uz opcioni parametar `?orgJedinica=` za onoga ko je hoće odštampanu.
- **Magacin:** iz `warehouses` po filteru (naziv, ne broj), nikad konstanta.
- **Natpisi kolona, naslovi, natpisi potpisa:** u konstante na jednom mestu (novi print servis /
  `robno-doc-layout.ts`), ne razbacano po funkcijama.
- **Poslovna pravila koja su Servoteh-specifična** (šifre vrsta dokumenata `VISAR`/`MANJR`, konta
  1320/6740/5741) već su parametrizovana kroz `document_types` i `accounting_schemes` — ne uvoditi nove
  konstante.

---

## 6. Pitanja za vlasnika / knjigovođu (sa preporukom)

| # | Kome | Pitanje | Preporuka | Blokira |
|---|---|---|---|---|
| P1 | knjigovođa | Da li „Stanje po knjigama" na popisnoj listi ostaje **ukupna zaliha**? | **Da** — to je broj iz KEPU/GK; slobodna bi razišla papir sa glavnom knjigom | K4 |
| P2 | knjigovođa | Da li se višak/manjak i dalje računaju prema ukupnoj zalihi, a rezervisana/ugrađena roba se **popisuje kao prisutna**? | **Da** — manjak vodi u `MANJR` → GK 5741 i u PDV; 105 redova bi danas dalo lažne manjke | K4, K5 |
| P3 | knjigovođa | Roba ugrađena u mašinu koja nije isporučena — sme li da ostane na zalihi 1320 ili se razdužuje u nedovršenu proizvodnju? | Ako se **razdužuje**, ceo problem nestaje i K4/K5 nisu potrebni. Ovo pitanje presuđuje obim posla | K4, K5 |
| P4 | vlasnik | Grupisanje popisne liste: **po polici** (predlog) ili po grupi artikla kao BigBit? | **Po polici** — komisija fizički ide policu po policu | K3 |
| P5 | vlasnik | **4.789 od 7.179** redova sa stanjem NEMA policu. Štampaju se u grupi „BEZ POLICE" ili se izostavljaju? | **Štampaju se**, na kraju liste — izostavljena roba se pri popisu ponaša kao manjak | K3 |
| P6 | vlasnik | „Ispod minimalne": porediti sa **slobodnom** (predlog) ili sa stanjem? I prag `<` ili `<=`? | **Slobodna**, prag **`<=`**, uz prekidač za oba. 🔴 BigBitov `LL_ArtikliIspodMinKolicine` nije u izvozu → paritet se ne može garantovati | K2 |
| P7 | vlasnik | Samo **162 od 92.625** artikala ima minimalnu količinu. Ko je popunjava i gde — u BigBitu (master) ili u 4.0? | **U BigBitu** dok je on master; u 4.0 bi je noćni uvoz pregazio | K2 (upotrebljivost) |
| P8 | vlasnik | Rezervacije: seći ih po **poslovnoj godini** (naše podrazumevano) ili uzimati pun BigBit zbir? BigBit ih ne seče — ni po godini ni po magacinu | **Zadržati sečenje po godini**; bez njega bi „Slobodno" pokazivalo ≈ 1,08 M jedinica prezauzetosti umesto ≈ 71 k | K1, K2, K3 |
| P9 | vlasnik | Štampa li se popisna lista i za magacin **„Gotovi proizvodi"** (30 redova, svih 30 sa stanjem 0)? | Ne podrazumevano; ponuditi kao izbor magacina | K3 |

---

## 7. Šta NISAM mogao da izmerim

1. **Definicija BigBit izveštaja `LL_ArtikliIspodMinKolicine`.** Nije u `_legacy/Izvoz/`
   (`grep -r IspodMin` → 0 pogodaka ni u `Upiti/`, ni u `Izvestaji/`, ni u `Forme/`, ni u `Moduli_Tekst/`).
   Naš katalog ga navodi kao izveštaj nad upitom „Lager lista", ali `Minimalna kolicina` **nije** u
   SELECT-u tog upita. → ne mogu potvrditi da li BigBit poredi sa stanjem ili sa slobodnom količinom (P6).
2. **Tačan izgled HAP FLUID-ove verzije obrasca.** Imam samo prepis sa slika. Servotehov
   `PopisnaListaSaPolicama` ima 6 kolona, bez `Iznos` i bez blokova `Stanje po popisu / Višak / Manjak`.
   Te blokove naš `InventoryCountPdfService` već ima — ali ne mogu da uporedim širine, redosled i
   grupisanje sa HAP FLUID-ovim papirom.
3. **Da li isti artikal stoji na različitim policama u različitim magacinima.** `items.shelf` je jedno
   polje po artiklu — i u 4.0 i u BigBitu — pa taj podatak ne postoji nigde. (Posredno merenje: samo ~27
   artikala uopšte stoji u više od jednog magacina, pa je pitanje trenutno bez praktičnog značaja.)
4. **Ponašanje na stvarnim popisnim podacima.** `inventory_counts` i `stock_documents` su prazni na
   produkciji, pa se K4/K5 mogu proveriti isključivo na dev bazi ili posle cutovera.
5. **Vreme render-a i memorija za PDF od ~7.200 redova.** Nisam pokretao render (analiza, ne izvođenje) —
   mora se izmeriti pre isporuke K3.
