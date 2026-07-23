# Banking — izvodi (uvoz) + nalozi za plaćanje (izvoz) — rekonstrukcija

> **Status:** ANALIZA (2026-07-18, iz izvučenog VBA + record-source upita). Potvrđeno (Nenad):
> izvoz naloga = **FX / Banca Intesa, export VEĆ RADI**; izvod = **TXT fiksne kolone**.
> Nadgrađuje [BB_T_26_klaster_C_finansije-pdv-gk.md](BB_T_26_klaster_C_finansije-pdv-gk.md) (tabele
> = GAP) sa **kako** (tačni formati, parser, MOD97 kod).

**Ključno:** nigde u kodu **nema ISO 20022 / pain.001 / camt / MT940 / SWIFT XML** (provereno —
jedini „camt/SEPA" pogoci su reč „Separator"). I uvoz izvoda i izvoz naloga su **proprietarni
fiksno-širinski TXT** (FX / Halcom / LHB). Format je star („YUM", 6-cifreni datum) ali **radi** sa
njihovim FX klijentom — za 4.0 zadržati isti export (Nenad).

## A) IZVOD — uvoz + auto-knjiženje

Ulaz: forma `FX_HAL_KnjizenjeIzvoda` (iz naloga GK, prosleđuje `IDNaloga`); korisnik bira TXT fajl.
Tri banke, svaka svoja Access Import Specifikacija (`Doc__Form_FX_HAL_KnjizenjeIzvoda.txt`):

| Banka | Format | TransferText | Import spec | Temp tabela |
|---|---|---|---|---|
| **FX** | fiksne kolone | `acImportFixed` | `"FX Import Specification"` | `FX_Imported_Izvod` |
| HALCOM | delimited | `acImportDelim` | `"HALCOM Import Specification"` | `HALCOM_Imported_Izvod` |
| **LHB** | fiksne kolone | `acImportFixed` | `"LHB_Import Specification"` | `LHB_Imported_Izvod` |

**Tačne kolone import specova** (pročitano iz `MSysIMEXColumns`, 18.07 → `_extracted\queries_full\_MSysIMEX\`):
- **FX Import Specification** (fixed, cp1252, dec `.`, god. 4-cifr.), 14 kolona (Start,Width):
  `MatTR(1,18) NazivKomitenta(19,35) MestoIAdresa(54,43) SifraPlacanja(97,3) Opis(100,35)
  Iznos(135,13) DugPotInd(148,1) TRKomitenta(149,18) Model(167,2) PozivNaBroj(169,20)
  DatumDok(189,8) BrojZaReklamaciju(197,19) Field14(216,4) TipStavke(220,1)`.
- **HALCOM Import Specification** (delimited `#`, cp1250, StartRow 1), 26 kolona slovenačke terminologije
  (`ST_RACUNA, DATUM_OBD, ZNESEK_V_BREME, ZNESEK_V_DOBRO, SKLIC_ODOBR/OBREM, MODEL_ODOBR/OBREM…`).
- **LHB Import Specification** (fixed, cp437, god. 2-cifr.), 21 kolona (`Datum(26,8) Duguje(67,24)
  Potrazuje(91,24) Komitent(115,125) TRKomitenta(260,18) SifraPlacanja(280,3) Model/BrojZaduzenja/Odobrenja…`).

Time je jedina rupa iz ranije verzije (kolonske širine izvoda) **zatvorena** — parser se piše 1:1.

**Iznos:** `IznosIgnorZgSep2Dec` — izbaci ne-cifre, podeli sa 100 (poslednje 2 cifre = pare)
(`Module__FX_HALCOM.txt:58-77`). **Poziv na broj:** `FX_OdrediBrojDokumenta…` parsira `(brojDok)/`
po `(`,`)`,`/` (`:35-56`). **Uparivanje komitenta:** JOIN uvezene stavke ↔ `Komitenti` po žiro
računu (`Ziro racun_1/_2/_3`) → analitička šifra. **Uparivanje sa otvorenom stavkom** (combo `BrDok`):
strana po klasi konta — `IIf(Konto Like "4*", Potrazuje, Duguje)` (obaveze→potražna).

**Auto-knjiženje — dugme `Proknjizi`** pokreće 2 action upita (`…KnjizenjeIzvoda.txt:113-127`):
`FX_HALCOM_ProknjiziStavkeUGK` (analitička strana komitenta) + `FX_HALCOM_ProknjiziPrometUGK`
(protivstavka na kontu banke) → dvojno knjiženje pod tekućim `IDNaloga`. **Izvod se NE knjiži kroz
„Šemu za kontiranje"** (to je za fakture) — direktno banka↔analitika.

## B) NALOZI ZA PLAĆANJE — izvoz (fiksni TXT, ne XML)

Forma `ExportVirmana`; grana po firmi: **Servoteh → `PrebaciUFX`** (FX format), ne Halcom
(`Doc__Form_ExportVirmana.txt:27-31`). Isti upit `PregledVirmanaExport`; posle izvoza
`OznaciPlaceneVirmane` (status=plaćeno).

**FX format** (`Module__ExportTXTCSVXML.txt:764-898`) — vodeći slog: `banka(3)+racun(15,pad)+
naziv(35)+mesto(20)+ukupno(15,*100)+brNaloga(5)+"YUM"+kontakti…+"3"+"9"`; detaljni po nalogu:
`banka(3)+racunPrimaoca(15)+naziv(35)+mesto(20)+…+SifraPlacanja(3)+SvrhaDoznake(35)+iznos(13=11+2
pare)+PNBOdobModel(2)+PNBOdobBroj(20)+datum(ddmmyyyy,8)+…"3"+"1"`.
**Halcom** (`Module__ExportUHalcom.txt:46-120`, „MULTI E-BANK" marker) — razlike: mesto 10 (ne 20),
PNB 23 (ne 20), datum ddmmyy (6, ne 8), bez „YUM".

**Kreiranje virmana:** `KreirajVirman` iz ulazne fakture (`Izvoz\VBA\Virmani.bas:5-57`) — default
`SvrhaDoznake="UPLATA ZA ROBU"`, `SifraPlacanja="221"`, `PNBOdobModel="99"`, na teret = firma, u
korist = komitent. Bulk iz otvorenih stavki: forma `VIRMANI_Priprema` (46*→putni troškovi).

**Poziv na broj** (`Module__KontrolniBrojevi.txt`): **MOD97** `KBroj97 = 98-((broj*100) mod 97)`
(`:35-56`); **MOD11** `Kbroj22` (težine 7..2); `DobarTR` validira račun `banka(3)+racun(13)+KK`.
Modeli u `PNBZadModel`/`PNBOdobModel`: **97**=MOD97, **11**=MOD11, **99**=bez. Zad*=platilac, Odob*=primalac.

## C) Tabele (DDL `BB_T_26_schema.sql`)

Nema zasebne `Izvodi` tabele — izvod ide u temp (`*_Imported_Izvod` + `FX_HAL_ImportovaneStavke`).
- **`Virmani`** (:2241): `IDVirman, IDNaTeret, IDUKorist, SvrhaDoznake, PNBZadModel/Broj,
  SifraPlacanja, Iznos, PNBOdobModel/Broj, Mesto, Datum, Valuta, NaTeret/UKoristZiroRacun,
  IDDokIzRobnog/GK, IDStavkaIzNaloga, **Status, Zakljucano**, RedniBrojSerije` — state machine.
- **`UplatniRacuni`** (:2214) — TR firme; **`INOUplatniRacuni`** (:338, SWIFT/korespondent — samo
  štampa instrukcija na profakturi, bez deviznog exporta); **`Kursna lista`** (:507).
- Ciljne GK: `T_Nalozi` (:1548), `T_Glavna knjiga` (:1350, `PNBOdobBrojGK`), kompenzacije `T_GrkStavke` (:1384).

## D) Status (18.07 — najvećim delom REŠENO)

1. ✅ **Kolone import izvoda** — pročitane iz `MSysIMEXColumns` (FX/HALCOM/LHB, gore u §A).
2. ✅ **Doslovan SQL action upita** — izvučen: `FX_HALCOM_ProknjiziStavkeUGK`/`ProknjiziPrometUGK`,
   `*_Izvod_Stavke_ZaKnjizenje/_UpisiUTabelu`, `VIRMANI_KreirajIzPregleda`, `OznaciPlaceneVirmane`,
   `PregledVirmanaExport`, `Virmani_SaldoPoKomitentima` → `_extracted\queries_full\<baza>\_highlights\`.
3. ⏳ **Konto banke** protivstavke + **`VrstePlacanja`** — u toku (rule-tabele agent).
4. **Devizni tok** — samo štampana instrukcija, nema mašinskog izvoza (van scope-a — devizno isključeno).

## E) Ocena i procena

**Rekonstrukcija ~80%** (export layout 100%, MOD97/11 100%, tok/tabele 100%; nedostaje import
col-spec + doslovan SQL — par sati iz `.mdb`).

| Podmodul | Dani | Napomena |
|---|---|---|
| Uvoz izvoda: parser TXT fiksne kolone + upload + preview | 4–7 | 1 format ~4d |
| Auto-uparivanje (žiro→analitika, otvorena stavka, klasa konta) | 3–5 | |
| Auto-knjiženje u GK (dvojno) | 4–6 | zavisi od zrelosti GK modula |
| Virmani CRUD + state machine + kreiranje iz fakture/otvorenih | 5–7 | |
| Poziv na broj MOD97/11 + validacija TR | 1–2 | gotov algoritam |
| **Export naloga (FX) — VEĆ RADI u legacy** | **1–3** | samo re-point podataka na isti format (Nenad potvrdio) |
| Kompenzacije / IOS (pomoćno) | 4–6 | preko GRK, delom u GK domenu |
| **Ukupno** | **~22–36 dana** | 1 developer |

**Olakšice (Nenad 18.07):** izvoz naloga u istom FX formatu → export je gotovo rešen (najveća
neizvesnost — ISO 20022 — otpada); izvod = 1 TXT format (ne trebaju sva tri). To skida procenu sa
gornjeg ka **donjem opsegu**. Najveći realni trošak = **auto-knjiženje izvoda u GK**, koje zavisi od
toga koliko je GL/nalog modul zreo (doc 18).
