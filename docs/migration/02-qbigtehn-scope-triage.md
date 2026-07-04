# Servosync Faza 2 — Finalni scope izveštaj (QBigTehn used vs bloat)

> Izvor: read-only multi-agent analiza (scope-triage workflow), 2026-07-03. Klasifikacija 873 fajla legacy izvoza (Izvoz/). Ništa u kodu nije menjano.

Ukupno analizirano: **873 fajla** (Moduli 197, Forme 236, Upiti 404, Izvestaji 36).
Podela: **USED 584 (~67%)**, **OUT-OF-SCOPE 226 (~26%)**, **AMBIGUOUS 63 (~7%)**.

---

## 1. USED — ulazi u migraciju (~584 fajla)

**PRODUCTION — RN / TP / shop-floor / radnici / mašine / planer / PPS: ~180 fajlova**
Jezgro sistema. Radni nalozi (tRN, UnosRN, RNPregled*, kopiranje naloga), tehnološki postupci (Kartica TehPostupka, PregledPoPostupcima*, BBTehn_Class/Module), barkod prijava rada na mašini (BarKod_Unos, RN_TouchPanel), analitika učinka po radniku/RJ (AARadnika, AA_PoSatu), planer i PPS pregledi. Pokriva PDF tok: Lansiranje RN → izrada TP → Proizvodnja/kartica TP.

**PDM — crteži / sklopovi / BOM / primopredaja / nacrti: ~87 fajlova**
SolidWorks PDM integracija (PDM_Class, PDMXMLParser, PDMXMLImportLog), stablo sklopova i where-used (PDMTreeView, GdeSeCrtezKoristi, ODBC_ftWhereUsed), sastavnice/BOM (ODBC_ftBOMKolicine), i ceo primopredajni tok. Poklapa se sa PDF-om: PDM → Nacrti → Primopredaja.

**MRP / NABAVKA: ~49 fajlova**
MRP_* forme i upiti (potrebe, rezervisano, po dobavljačima, sa zalihama), planiranje nabavke, specifikacije/zahtevi. Inicijalizacija nabavke ide kroz posebnu aplikaciju, ali uvid/pregled i planiranje ostaju u scope-u.

**INVENTORY / LOKACIJE DELOVA / MAGACIN MATERIJALA: ~36 fajlova**
Lokacije gotovih delova (KarticaLokacijaDela, LokacijaNapravljenihDelova), police/paletna mesta, nalepnice, magacin materijala/trebovanja.

**CORE — komitenti / predmeti-projekti / artikli: ~30 fajlova**
Komitenti, predmeti/projekti (Pisarnica_UnosPredmeta, Predmeti, NeZavrseniPredmeti), izbor artikla/komitenta. Predmeti i komitenti se povlače iz BigBit-a.

**SYNC — BigBit / ODBC / import-export / XML: ~40 fajlova**
BB2CMD, BBCMD_BigBit, ImportIzBB_Module, RunExtBigBit_Module, ODBC_Synch_*, modSyncMirrorTabele, BigBitXML. Realizuje „Preuzmi iz BigBit-a".

**CONFIG / AUDIT / INFRA — DB sloj, UI, prava, logovi: ~162 fajlova**
Najveći deo Moduli_Tekst biblioteke: ADO/CNN konekcije, BBSQLModule, BBPravaPristupa, Ribbon/UI, WriteToLog/Dnevnik audit, CFG_*, validacije (PIB/JMBG). **VAŽNO:** ovaj sloj je napumpan jer je legacy došao kao vendorska biblioteka — većina je reusable plumbing koji se u 2.0 **prepisuje/zamenjuje, ne migrira 1:1.**

---

## 2. OUT-OF-SCOPE — odbacuje se (~226 fajla, ~26%)

**Moduli (35):** glavna knjiga (GlavnaKnjiga, APGK, Kontiranje), fakturisanje (IF/USLF/OP_Fakturisanje), PDV/POPDV, finansije (Kamate, Virmani, FX_HALCOM e-banking, SMS opomene), maloprodaja/POS (BBProdaja, DodelaPLU, Nivelacija, NKEPU), ugostiteljstvo (Kafe*, Konobari), fiskalno (ComPortPar, SHUTTLE).

**Forme (17):** e-faktura export (ER_Export), POS izbor stola (IzborStolaPanel), **13 reklamnih panela** (ReklamniPanel*), uplatni računi (UplatniRacuni).

**Upiti (170) — najveći izvor bloata:** dominiraju **migracioni skriptovi za DRUGE klijente vendora** — GR_*, DX_*, VULEMARKET_*, JUGOLEK_*, PSR_*/PSF_*, ABB_*, Paffoni, Cyclamin, M_*. Uz to: robno-trgovinske zalihe, cenovnici, KEPU/trgovačka knjiga, GK stavke, PDV IF/UF, osnovna sredstva, PLU/retail, profakture.

**Izvestaji (4):** pisarnica/delovodnik (DnevnaKnjiga, DostavnaKnjiga, OmotZaPredmet) — kancelarijsko poslovanje.

---

## 3. AMBIGUOUS — mora da potvrdi Nesa/Negovan (~63 fajla)

1. **Ulazna faktura / uvoz materijala:** `UF_Class`, `UF_Modul`, `UVOZ` (carinski troškovi → nabavna cena). U nabavku/magacin ili van scope-a?
2. **Robni sloj — dvonamenski:** `Robna dokumenta`, `Robne stavke`, `ZaliheMagacina`, `B_ZaliheArtPoMag`, `Lager lista`. Magacin MATERIJALA proizvodnje ili čista trgovina?
3. **Recepturni/BOM modul:** `00_PrenesiRecepte`, `00_PrenesiProduktObrade`, popisi. Koristi li se receptura/normativ ili sve ide kroz PDM/RN?
4. **Master-data klasifikacija:** `Grupe artikala`, `frmGrupe`, `[Vrste sifara]`, `Raster*` (dimenzije metala vs generički setup).
5. **Shop-floor hardver (verovatno USED):** `LIB_ACS` (čitač ID kartica), `NumKBD`/`KbdNum`, `BBTouchScreenCMD` — RN touch panel ali deljeno sa POS-om.
6. **Lokalizacija:** `Recnik`, `SRPENG_*`, `LIB_SlovimaIznos`. Treba li 2.0 višejezičnost?
7. **Dev leftover „NeKoristiSe":** `rRN_*_NeKoristiSe`, `Copy Of *`, `Form1/2/3`, `TestForm`, `_TEST*`, `Digitron`. Potvrditi da su zamenjeni.
8. **Client-specific/mrtvo (verovatno OUT):** `BEOHOME`, `LIB_BOSSON`, `RasterModul`, `ProdavciModule`, `PPS_Modul`.

---

## 4. Zaključak — koliko legacy koda je realno relevantno

- **~67% (584/873) je USED**, ali optimistično jer uključuje ~162 infra/config fajla (reusable plumbing → prepisuje se, ne migrira 1:1).
- **Realno proizvodno jezgro** (production + pdm + mrp + inventory + core) je **~382 fajla, ~44%** — stvarni migracioni payload.
- **~26% čist bloat** za bacanje (POS/kafe/fiskal/maloprodaja/knjigovodstvo/e-faktura + tuđi klijentski migracioni skriptovi).
- **~7% čeka ljudsku odluku** (granica robno/magacin-materijala, recepturni modul, lokalizacija).

**Praktična preporuka:** migraciju voditi po proizvodnom toku iz PDF-a (PDM → Nacrti → Primopredaja → RN → TP → Proizvodnja → Lokacija dela); infra sloj tretirati kao *rewrite* ne *migrate*; suvišne module iz PDF-a (Lansiranje/Lansiranje primopredaje, Razlike verzija 1 i 2, Unos predmeta u meniju Razno) ne prenositi. Poznato ograničenje za 2.0: pregled gotovosti/dinamika **ne radi za ceo sklop** — samo za pojedinačne delove.
