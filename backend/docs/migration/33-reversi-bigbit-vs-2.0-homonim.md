# Reversi — BigBit komercijalni revers vs 2.0 `reversi` (magacin alata)

> **Status:** ANALIZA (2026-07-18, revidirano posle korisničke direktive „jedan modul, unapređujemo").
> **Dva različita „reversa" (homonim), + odluka gde ide unapređeni komercijalni revers.**

## 0. Dve stvari sa istim imenom

| | BigBit **komercijalni revers** | 2.0 `reversi` |
|---|---|---|
| Šta je | roba na revers KUPCU (konsignacija) | interni **magacin ALATA** (radnici/mašine) |
| Tabele | `Reversi`/`ReversiStavke` (135/144 reda) | 14 `rev_*` tabela (sy15) |
| Obim | marginalno | ~5.5k LOC BE + 12.7k FE, barkod/rezni/ledger/servis |

**Homonim — magacin-alata `reversi` je zaseban domen i ostaje netaknut.** Ova stranica je o **komercijalnom
reversu** (roba kupcu), koji Nenad želi kao **jedan unapređen modul**.

## 1. Šta BigBit komercijalni revers ZAISTA jeste (ispravka)

⚠️ **Ispravka ranije verzije:** komercijalni revers je **zasebna živa tabela `Reversi`/`ReversiStavke`**,
NE robni dokument sa „Vrsta dokumenta=revers".

- RecordSource forme `Reversi_UnosZad`/`Reversi_Pregled` = **`Reversi ⋈ ReversiStavke`** (`Reversi_Pregled.sql`);
  numeracija `Count(IDReversa) FROM Reversi`. Reporti `Revers`/`Revers_Razduzenje` rade **nad `Reversi`**
  (`OnLine_BigBit_Design\Revers.txt:18`, filter `ReversiStavke.Razduzio=False/True`).
- DDL `Reversi` (schema:1180): Sifra komitenta, Sifra prodavca, Broj reversa, Datum, `RazduzioDok`, Potpis.
  `ReversiStavke` (schema:2762): IDArtikal, Kolicina, `Razduzio`, Datum razduzenja. **Samo 10 kolona.**
- Kontrole na formi (`Vrsta dokumenta`, `Magacin`, `Carina`, `Datum valute`, `Vozac`, `MestoIsporuke`,
  `IDDok`) su **VESTIGIJALNE** — forma je klonirana sa robne/ulazne (kod referiše `Forms![Ulazna faktura]`,
  `Me![Broj dokumenta]=Me!IDDok` zakomentarisano). Te kontrole se **ne persistuju** u `Reversi`.
- **NEMA profaktura→revers carry-overa u kodu** (grep prazan), **NEMA „revers" Vrste dokumenta** u
  `R_Vrste dokumenata.csv` (59 tipova). Živ modul (RW grupe: Komercijala, Serviseri — `security.csv:818`).

→ **Korisnikovo „revers pravimo iz profakture" NIJE trenutni BigBit tok** — to je **željeni obrazac i
direktiva za 4.0**: unaprediti revers tako da se pravi iz profakture (carry-over), sa punim robnim poljima.

## 2. Gde ide unapređeni JEDAN modul → sales / goods-document flow

**Odluka: komercijalni revers = tip robnog dokumenta u sales flow-u (`GoodsDocument`), pravljen iz
profakture. NE u magacin-alata `reversi`.** Razlog je jak — **2.0 `GoodsDocument` (schema:1056) VEĆ nosi
sva polja** (uklj. baš one „vestigijalne" robne kontrole sa BigBit forme + carry-over iz profakture):

| BigBit revers / korisnikov zahtev | 2.0 `GoodsDocument` polje |
|---|---|
| Vrsta dokumenta (REV) | `documentType` |
| Komitent / Prodavac | `customerId` / `salespersonId` |
| Magacin / Carina / Datum valute-knjiženja | `warehouseId` / `customs` / `dueDate`/`postingDate` |
| **Mesto isporuke / ruta / vozač** | `deliveryPlaceId` / `routeId` / `driverId` |
| Potpis (potpisnica) | `isSigned` / `signature` |
| Nivo / lanac dokumenata | `level` / `linkedInvoiceDocId` / `linkedServiceDocId` |
| **„iz profakture" carry-over** | `GoodsDocumentItem.copiedFromItemId` / `postedFromProformaToInvoice` |
| Predmet / RN / cenovni artikal | `projectId` / `workOrderId` / `itemId` |

→ **Ništa se ne gubi** — „vozač/ruta/mesto isporuke" koje smo hteli da sačuvamo **već postoje** u
`GoodsDocument` (bili su robne kontrole, otud na kloniranoj formi). Revers = `documentType='REV'` robni
dokument, napravljen carry-overom iz profakture (doc 27), štampan na „Revers"/„Revers_Razduzenje" šablonu.

## 3. Plan i procena

- **Magacin-alata `reversi` (2.0)** — netaknut (pravi homonim).
- **Komercijalni revers** = deo **4.0 sales/goods-document** modula:
  1. Vrsta `REV` u `DocumentType` (+ razduženje varijanta).
  2. Carry-over profaktura→revers (reuse `DocumentCarryOverService`, doc 27; `copiedFromItemId`).
  3. Print „Revers" / „Revers_Razduzenje" (RecordSource: komitent⋈artikli⋈stavke, filter po razduženju).
  4. Zaduženje/razduženje po stavci (`Razduzio` + datum) → status na `GoodsDocument`/item.
  5. Migracija 135/144 reda `Reversi`→`GoodsDocument` (`documentType='REV'`), jednokratno.
- **Procena:** ~**2–3 AI-dana DODATNO** na sales build (GoodsDocument šema već postoji; treba revers-tip +
  print + carry-over žica + migracija).
- **Zavisnost:** pravi dom je 4.0 — `GoodsDocument` danas postoji samo kao **sync-cache** (nema
  `goods-documents` app modula; §4/§11.1 cache se ne dopunjava). Revers čeka da se otvori sales/goods
  modul; ne radi se u 2.0/3.0 scope-u.

**Sažetak:** korisnik je u pravu da to bude jedan unapređen modul, i da se pravi iz profakture — ali dom
je **sales/goods-document flow** (gde `GoodsDocument` već ima svako polje), ne magacin-alata reversi.
BigBit-ov trenutni izolovani `Reversi` (135 redova) se migrira u taj tok kao `documentType='REV'`.
