# Legacy Access kontejneri — inventar za Korak 0

> **Status:** POPIS (2026-07-18). Šta od legacy `.mdb`/`.accdb` kontejnera POSTOJI na disku
> (`_legacy\`, van gita), šta kod pominje a NEMA ga, i gde koja poslovna pravila žive.
> Prati [18-gl-pdv-kontiranje-rekonstrukcija.md](18-gl-pdv-kontiranje-rekonstrukcija.md).

## 1. Na disku ✅ (ključni)

| Fajl (rel. `_legacy\`) | Veličina | Uloga |
|---|---|---|
| `BB_T_26_11-07-26.mdb` | 358 MB | tehnološka baza podataka (analizirana u BB_T_26 seriji) |
| `BigbitRaznoNenad\BB_T_25.MDB` | 297 MB | prethodnogodišnja tehnološka baza (izvor stvarnih `R_Tarife` redova) |
| `BigbitRaznoNenad\MojaBIgBitBaza.accdb` | 241 MB | komercijalni podaci |
| `BigbitRaznoNenad\BigBit_APL_2010.MDB` | 117 MB | **APGK/knjigovodstvo aplikacija — POPDV engine, 5.236 upita** |
| `BigbitRaznoNenad\OnLine_BigBit_APL.MDB` | 99 MB | **komercijala/knjigovodstvo front — NSK_/PDV_Uknjizi/PREB_ upiti, 4.173 upita** |
| `BigbitRaznoNenad\QBigTehn_APL.accdb` (+ `QBigTehn\` radna + 4 `.accde` backup-a) | 38–52 MB | tehnološka aplikacija |
| `BIGBIT.MDW` (4 kopije) | 4.7–42 MB | workgroup security (potreban za DAO otvaranje) |
| `APL\PDM_XMLParser.accdb` (4 kopije) | 0.9–14.5 MB | PDM XML import parser |
| `BB_TMP.mdb`, `BB_CFG_Lokal.mdb` | <2 MB | temp / lokalna konfiguracija |

**Postojeće ekstrakcije:**
- `Izvoz\` — tekst-izvoz **tehnološke** aplikacije: 454 VBA modula (1 FAIL: `Form_Unos / Pregled
  radnika`), 237 formi, 36 izveštaja, 404 `.sql` upita (od toga ~55–95 migraciono/klijentski:
  `Prenesi*`, `DX_*`, `GR_*`, `JUGOLEK*`, `ODBC_*` 55…).
- `QBigTehn_APL\` — paralelna ekstrakcija ISTE aplikacije (455 objekata, 208 upita) drugim alatom.
- `BigbitRaznoNenad\_extracted\` — **OnLine BigBit**: VBA 824 fajla + **2.412 upita** u
  `_extracted\queries\` (osnova za doc [09](09-bigbit-online-domain-map.md)).

## 2. Pominje se u kodu, NEMA ga na disku ❌

| Kontejner | Šta sadrži (po referencama) | Bitnost za 4.0 |
|---|---|---|
| `BigBit_APL_LIB.MDB` | biblioteka funkcija komercijale | proveriti kod Slaviše |
| `BigBit_APL.mdb` (tačno ime) | glavna komercijalna app — verovatno = `_2010` varijanta | proveriti ekvivalenciju |
| `BB_T_MOD.MDB` | master/model tehnološka baza (kreiranje novih) | niska |
| `BB_FIT.MDB` | „FIT" modul (fiskalizacija/inventura) | niska (POS van scope-a) |
| `BB_Dnevnik.mdb`, `Shuttle.mdb`, `Digitron.mdb`, `BB_SrpEngRecnik.mdb`, `QBigBit_Kasa_LIB.accdb`, `MalaKasa_T.mdb` | pomoćne/POS | zanemarljiva |
| `BB_T_TG.mdb`, `BB_T_Test.mdb`, `bb_t_14.MDB`, `Makovica_T_18.MDB`, `EXT_BB_T_25.MDB` | test/arhive/klijentske | zanemarljiva |

**Zaključak:** ništa kritično ne fali — sva tri nosioca poslovne logike (tehnološki APL, OnLine
BigBit, APL_2010) su na disku. Jedina vredna provera: `BigBit_APL_LIB.MDB` (biblioteka).

## 3. Gde tražiti koju logiku (brzi vodič)

| Tražiš | Kontejner | Kako |
|---|---|---|
| NSK_ knjiženje naloga, PREB_ prebacivanja | `OnLine_BigBit_APL.MDB` | DAO QueryDefs dump (kredencijali u `_legacy`, van gita) |
| PDV_Uknjizi*/PDV_Obracun_* | `OnLine_BigBit_APL.MDB` (+duplikat u `_2010`) | ✅ izvučeno u [18](18-gl-pdv-kontiranje-rekonstrukcija.md) |
| POPDV_DEF + sekcije obrasca | `BigBit_APL_2010.MDB` | sekcijski izveštaji ✅ izvučeni 18.07 (22/22, [20 §6](20-bigbit-stampani-dokumenti-katalog.md)); `POPDV_DEF` dump preostaje ([18 §4](18-gl-pdv-kontiranje-rekonstrukcija.md)) |
| Layout štampanih dokumenata (Profaktura/Faktura/Kartice/KEPU/IOS…) | `OnLine_BigBit_APL.MDB` | ✅ **496/496 izvučeno 18.07** → `_extracted\OnLine_BigBit_Design\`; APL_2010 426/713 (ostatak traži `P:\` share — [20 §6](20-bigbit-stampani-dokumenti-katalog.md)) |
| Sema za kontiranje SADRŽAJ (DefDug/DefPot) | radna godišnja baza (`BB_T_26`/komercijalna) | dump tabela |
| sp*/fs* tela | SQL Server `vasa-SQL` | `script.sql` metod ([05](05-qbigtehn-sqlserver-logic.md)) |
