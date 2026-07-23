# Profakture — pun tok iz koda

> **Status:** ANALIZA (2026-07-18, iz izvučenog VBA + upita + report layouta). Razrešava dvosmislenost
> `Level>=250` vs `T_Profakture` iz [doc 20](20-bigbit-stampani-dokumenti-katalog.md). Koristi
> carry-over mehanizam iz [doc 27](27-prepisivanje-dokumenata-carry-over.md).

## 0. Razrešenje `Level` vs `T_Profakture` — OBA postoje, samo jedno je aktivno

- **AKTIVNA profaktura = robni dokument `T_Robna dokumenta` sa `Level >= 250`.** Dokaz: `Profakture.sql`
  = `SELECT * FROM [T_Robna dokumenta] WHERE Level>=250`; `KreirajProfakturaDok` piše u `T_Robna
  dokumenta` sa `Level=250`; stavke = `T_Robne stavke`.
- **`T_Profakture`/`T_Profakture stavke` = MRTVA legacy tabela** — puni je samo upit `Ponude`, nema
  forme/prepisa/štampe. (Ironično: ONA ima `Status Text(10) NOT NULL`, a aktivna `T_Robna dokumenta`
  nema Status — neko je planirao pravu status-mašinu pa odustao.)
- **→ 4.0: NE migrirati `T_Profakture`.** Profaktura NIJE poseban entitet — to je **„nivo" (Level 250)
  postojećeg dokumenta**.

**Level konvencija** (`Byte` na svakom dokumentu, iz `BBDefUser.Level` po korisniku):
- **`Level < 250` (obično 0) = pravi proknjižen dokument** — utiče na zalihe/KL/GK; svi realni upiti
  filtriraju `Level<250`.
- **`Level = 250` (ponegde 255) = profaktura/nacrt** — ne ulazi u zalihe ni GK. ⚠️ **Skriveni bag:**
  rezervacija/predmet-pregledi keyuju na tačno `Level=250`, a RecordSource je `Level>=250` → profaktura
  na `255` „ispada" iz rezervacije. **4.0: standardizovati na 250.**
- Faktura se razdvaja od profakture samo Level-om + linkom: profaktura ostaje 250, faktura je NOV
  dokument na Level 0 povezan preko `IDDokIF`.

## A) Definicija, numeracija, polja

Izlazni robni dokument (`Ulaz=False`) na `Level>=250`; stavke nose cene/rabate ali ne diraju zalihe/GK.

**Numeracija — dva mehanizma:** (1) globalni brojač `Parametri za rad.Poslednji broj profakture`
+ prefiks/kroz (odvojen od brojača fakture); (2) count-based po vrsti dokumenta
(`1 + BrojProfakturaPoVrstama.CountOf`, rupičav pri brisanju). **Obavezno:** vrsta dok, broj, komitent,
datumi (dok/knjiženja/valute), prodavac (`IDProdavacZaCurrentUser()`), magacin, kurs, Level, predmet,
`Potpis=CurrentUser()`.

## B) Status-tok, prepisivanje, rezervacija, rok

**Nema status-enuma** — „status" se izvodi iz `Level` (250 nacrt/0 proknjižen) + `Potpisano` (otključava
grupa „Potpisivanje") + `Rezervisi` + link-polja `IDDokIF`/`IDDokUF` (da li je prepisana).

**Prepisivanje (carry-over, doc 27):**
- **→ Izlazna faktura** (`DugmeNapraviIzlazniDok`): guard `IDDokIF>0` (anti-duplo) → `KreirajRobniDok(Level=0)`
  → kopija stavki 1:1 (`StavkeZaNaknjizavanje`) → upiše `IDDokIF`. Alternativa: `ProknjiziStavkeIzProfaktureUIzlazni`
  (sa primenjenim KL cenama).
- **→ ulazni „PRZ"** (interni prijem, komitent=MATSIF, link `IDDokUF`).
- **→ nova profaktura** (split, `Level=250`, resetuje `Rezervisi` na originalu).

**Rezervacija zaliha (meka):** flag `Rezervisi` → `RezervisaneKolicinePROF` oduzima od slobodnog stanja
(ne knjiži izlaz). Prepis u novu profakturu gubi rezervaciju.

**Rok važenja:** `Datum valute = DateAdd("d", U roku dana, Datum dokumenta)`. Nije hard-istek — samo filter
u pregledu. **Avansna faktura:** NEMA automatskog profaktura→avansna generatora (avans preko `UsloviPlacanja`
teksta + zasebnih AVR dokumenata) — gap za 4.0.

## C) Cena / rabat (isti engine kao faktura, doc 23 §1.6)

Cena iz cenovnika (po komitentu, fallback `BBCFG.VPCenovnik`); formula:
`Rabat=Fakturna×Rabat%/100 → CenaBezRab=Fakturna−Rabat → Kasa=CenaBezRab×Kasa%/100 → StvarnaVP=Fakturna−Rabat−Kasa`.
Rabat komitenta iz `Rabati` po (komitent, grupa artikla); **kapa `MaxRabatProc`** (na artiklu) uz upozorenje.
Dugme „Primeni kurs na sve stavke".

## D) Štampa — bogata lepeza (osa: {domaća|INO}×{sa cenama|neto|bez rabata|bez cena}×{roba|usluge|MP}×{default|per-firma})

Domaća: `Profaktura - DEFAULT`/`- ABB`, `ProfakturaBezRabata`, `ProfakturaSaNetoCenama`. Otpremnica:
`ProfakturaOtpremnica - ABB`, `ProfakturaOtpremnicaBezCena`, `ProfakturaZaMag`. INO: `InoPROFaktura`,
`InoPROFakturaEng`, `INOInstrukcijeZaPlacanjePROF`. Usluge: `USLUGA Profaktura`. Registri: `KnjigaProfaktura`,
`PDVPoProfakturi`. Trebovanje-profaktura (dobavljač): `TrebovanjeProfakturaBezCena`. → **4.0 MUST ~4–5**
(DEFAULT, neto/bez rabata, INO+eng, bez cena-otpremnica), ostalo template.

## E) Kartice + Pregled

**KarticaProfaktura** = kartica po artiklu kroz sve profakture (ko/koliko/koji predmet/RN, `IDPrepisaneStavke`
= da li prepisano). **PregledProfaktura** = lista sa filterima (valuta, datum, vrsta, prodavac, komitent,
magacin, RN, Level, potpisano, rezervisano, predmet) + agregati.

## F) Veza sa nabavkom + jedinstven obrazac

`Trebovanje.DugmeKreirajProfakturu` → ubaci stavke trebovanja u profakturu (avansno-nabavni tok ka
dobavljaču kroz zasebnu `TrebovanjaProfakture` familiju, `T_Trebovanja WHERE Level>=250`). **Ključno:
`Level>=250` je JEDINSTVEN „profaktura/nacrt" obrazac preko 4 familije** (robna, usluge, trebovanja, MP)
— profaktura je nivo, ne silos.

## G) 2.0 stanje + procena

**2.0: DATA sloj VEĆ postoji, app logike nema.** `GoodsDocument` model već nosi: `level @db.SmallInt`
(:1085), `reserveStock` (:1090), `linkedInvoiceDocId/InboundDocId/ServiceDocId`, `dueDate`, `isSigned`,
`isLocked`, `paymentTerms`; `GoodsDocumentItem`: `discountPercent`/`cashDiscountPercent`, **`copiedFromItemId`**
(=IDPrepisaneStavke!), `postedFromProformaToInvoice`. Numeracija sync-ovana (`WorkParameter.lastProformaNumber`).
Pricing blokovi postoje (`PriceListEntry`, `TaxRate`). **ALI:** sync-ovan je samo `GoodsDocumentMirror`
(količine); pun `GoodsDocument` se ne koristi nigde. Sync tabele = read-only cache (§11.1 overlay odluka
otvorena) → profaktura kao app-feature traži app-owned tabelu ili overlay odluku.

| Stavka | MUST/SHOULD | AI-dani |
|---|---|---|
| Model+migracija (overlay na GoodsDocument, level=250) | MUST | 1 |
| CRUD + numeracija (WorkParameter brojač) | MUST | 1.5 |
| Pricing/rabat engine (deljeno sa fakturom) | MUST | 2 |
| Prepisivanje profaktura→faktura (carry-over servis, doc 27) | MUST | 1.5 |
| Rezervacija zaliha | SHOULD | 1 |
| Rok/status prikaz | SHOULD | 0.5 |
| Frontend (unos+podforma+Pregled+Kartica) | MUST | 3 |
| Štampa 4–5 varijanti | MUST/SHOULD | 2 |
| Trebovanje→profaktura + usluge/MP | SHOULD | 1.5 |
| **Ukupno** | | **~14 AI-dana** |

**Preporuka:** profakturu modelirati kao **tip/nivo nad postojećim GoodsDocument obrascem** (kao BigBit
Level), ne kao nov silos — prepisivanje u fakturu = promena tipa + kopija stavki (carry-over servis
doc 27), i isti kod pokriva usluge/trebovanje. **Ne migrirati** `T_Profakture`; standardizovati Level 255→250.
