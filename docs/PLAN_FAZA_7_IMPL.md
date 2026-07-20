
## Dodatak (19.07): prave ZR AOP formule — čeka mdb-tools

`BalanceFormulaDefinition` seed (`prisma/seed/balance-formulas.sql`) je REKONSTRUKCIJA — bruto bilans i osnovne
AOP pozicije rade, ali prave BigBit AOP formule (`ZR_AOP_Modla.Definicija`, `ZR_BS`/`ZR_BU` upiti) su BINARNE
u `.mdb` i traže `mdb-tools` za izvlačenje. Pokušaj instalacije pao: `sudo apt install mdbtools` na Ubuntu traži
lozinku (ne-interaktivni SSH). **Da se izvuku prave formule:** (a) `sudo apt-get install -y mdbtools` na Ubuntu
(Nenad unese lozinku), pa `mdb-export BB_FIT.mdb ZR_AOP_Modla` → seed; ILI (b) knjigovođa da AOP→formula mapu.
Do tada bilans radi na rekonstrukciji (dovoljno za bruto bilans i pregled; NE za regulatorni izlaz).

### Ažuriranje (20.07): mdb-tools NE MOŽE — baza je ULS-zaključana

Pokušano izvlačenje ZR/GK_IZV formula preko mdb-tools (kroz docker, bez sudo — radi). mdb-tools VIDI katalog
tabela glavne baze `BB_T_26_11-07-26.mdb` (200+ tabela: T_GK_IZV_Stavke, T_Izvestaj, PDV_PPPDV, OP_ModleID,
PSF_AnalitickaKonta_T...), ALI **ne može da čita SADRŽAJ** — čak i `Kontni plan` (1389 redova) vraća 0.
Uzrok: baza je ULS-zaključana (BIGBIT.MDW), a mdb-tools ne podržava `.mdw` workgroup autentifikaciju.
Kandidat-tabele (`T_GK_IZV_Stavke`, `T_Izvestaj`, `PDV_Kolone`) su k tome i **runtime-prazne** (cache).

**Zaključak:** prave ZR AOP formule izvući ISTO kako su i ostali `_extracted` CSV-ovi (Windows DAO/COM sa
`.mdw` credentials na PC-u sa Access-om — vidi kako je rađen `rule_tables/BB_T_26/*.csv`). To je posao na
Nenadovom PC-u, ne mdb-tools na Linux-u. Bilans i dalje radi na rekonstrukciji (bruto bilans + osnovne AOP);
zameniti pravim formulama kad se DAO izvoz uradi. Do tada: NE za regulatorni izlaz, DA za pregled/kontrolu.

### Ažuriranje (20.07 #2): motor DEKODIRAN iz VBA, mdb-tools čita APL ali ne glavnu bazu

Nenad je izvezao ZR VBA kod (Module ZR + ZRXML + Form_ZR_*). Motor je 100% dekodiran (doc 44):
DSL D/P/PSD/PSP/A/AB/AC + wildcard + samo +/-. GkEval usklađen (AB/AC prefiksi, clamp hipoteza),
APR eFI XML exporter napisan (FiForma BS/BU/SI, ruta /zavrsni/statements/:id/apr-xml, ZR_EXPORT).

**Pristup .mdb (novo saznanje):** mdb-tools RADI kroz docker (bez sudo) i ČITA nezaključane baze —
izvučen `CTGK_Vrste_Konta` (613 red) iz `BigBit_APL_2010.MDB`. ALI: (a) `ZR_AOP_Modla` NIJE u APL/OnLine
bazama (samo CTGK, koji je testni: IDCTGK=1 Opis="ssss"); (b) prave `ZR_*` tabele su u glavnoj `BB_T_26.mdb`
koja JE ULS-zaključana → mdb-tools vidi katalog ali ne čita sadržaj (ni Kontni plan sa 1389 redova).

**Za pun bilans seed treba `ZR_AOP_Modla` (kolone: AOP, Definicija=formula, Obrazac BS/BU/SI, StartnaKolona,
BrojKolona, Velicina) iz zaključane BB_T_26.mdb.** Načini: (1) Access na PC-u sa .mdw (Nenad ne može otvoriti);
(2) otključati BB_T_26 kopiju (ukloniti .mdw vezu) pa mdb-export; (3) izvoz iz žive BigBit instalacije koja ima
pristup. Motor + XML čekaju samo taj CSV — sve ostalo radi (bruto bilans na rekonstrukciji).

### ZAKLJUČAK (20.07 #3): `ZR_AOP_Modla` NE POSTOJI kod Servoteha — vendorska je

Iscrpna pretraga (mdb-tools kroz docker image `mdbtools:local` na ubuntusrv; stabilan — flaky apt rešen
build-om trajnog image-a) SVIH dostupnih baza: `_legacy/BigBit26/*` (= kopija P:\SERVOTEH\BigBit26),
`BigbitRaznoNenad/*` (BB_T_25, MojaBIgBitBaza 201 tab., OnLine APL), TG/PG, EXTENDED, Desktop\BigBit26
(ŽIVA radna kopija, OnLine APL 12.07.2026 — 285 razrešenih linkova u MSysObjects Type=6), share-ovi
`\\BigBit` (192.168.64.14) i `S:\BigBit`:

- **`ZR_AOP_Modla` nema NI U JEDNOJ bazi** — ni fizički ni kao link (285 živih linkova → sve na
  P:\Servoteh\BigBit26\{STH26,SHUTTLE,CFG...}, nula ZR).
- **Arhitektura (iz `BazeITabele_APL` + `Baze_Tipovi_APL` u APL bazi):** ZR je ZASEBNA aplikacija —
  IDBaze 9000=`ZR_APL`, **9010=`ZR_MOD`** (ZR_AOP_Modla, ZR_AOP_Pravila, ZR_VelicinaPreduzeca — FORMULE),
  9020=`ZR_POD` (ZR_BrutoStanje, ZR_Stavke, ZR_Zaglavlje — podaci). Ti .mdb fajlovi **nisu instalirani
  kod Servoteha** (nema ih na P:, u profilima, na share-ovima).
- **`Form_ZR_Start.Form_Close`: `If CurrentUser <> "Slavisa" Then DoCmd.Quit`** — ZR modul koristi samo
  Slaviša (autor BigBit-a). Završni račun je vendorski servis; Servoteh dobija gotove PDF-ove
  (S:\Servoteh\ZAVRSNI RACUNI\2023 — ćirilični APR obrasci, kopirano u `_legacy/BigBit26/ZR_validacija/`).

**Posledice za 4.0:** (a) rekonstruisani seed (`balance-formulas.sql`) OSTAJE — formule su ionako javna
regulativa (APR pravilnik AOP pozicija), Slavišina tabela je samo njegov zapis istog; (b) validacija:
uporediti izlaz našeg motora sa zvaničnim 2023 PDF-ovima (ZR_validacija/) kad budemo imali bruto stanje
te godine; (c) ako se ipak želi Slavišina tabela — tražiti od Slaviše `ZR_MOD.mdb` ili CSV izvoz (1 mejl).
Motor (GkEval) + APR XML su gotovi i ne zavise od ovoga.

### Dopuna (20.07 #4): statutarni ZR radi KNJIGOVOĐA u svom softveru — potvrđeno

Nenadova hipoteza potvrđena dokazima: (1) bilans za 2014 je generisan „**iz Holpen programa**"
(knjigovodstveni softver — fajl u S:\Servoteh\ZAVRSNI RACUNI\staro); (2) `T_OS_Sredstva` i `T_OS_Stavke`
u BB_T_26 imaju **0 redova** — OS modul BigBit-a se ne koristi; (3) BigBit **nema tabele za plate**
(samo `tRadnici`, 123 zaposlena, operativna evidencija). Dakle **plate, porezi na zarade, OS amortizacija
i statutarni završni račun žive kod knjigovođe** — BigBit (i time 4.0 zamena) pokriva robno/GL/saldakonti/
PDV/fakturisanje. Naš `zavrsni` modul je pregled + kontrola za menadžment i priprema podloge (bruto
bilans / zaključni list) za knjigovođu — NIJE kanal za predaju APR-u. Obračun plata i OS amortizaciju
NE graditi u 4.0 bez izričite odluke (van scope-a, kod knjigovođe).

### Definitivan dokaz (20.07 #5): Access COM sa Slavišinim kredencijalima — tabele nema

Poslednji mogući nivo provere: otvorena **živa radna baza** `Desktop\BigBit26\OnLine_BigBit_APL.MDB`
(modifikovana 12.07.2026, svi linkovi razrešeni kroz `.mdw`) preko **Access COM automatizacije** sa
BigBit kredencijalima (`/wrkgrp BIGBIT.MDW /user Slavisa /pwd kalendar`) — isti mehanizam kojim su
izvučeni `_extracted/rule_tables/*` CSV-ovi. Rezultat (`_legacy/_tools/access-com-extract/zr_probe.ps1`):

```
CurrentProject: OnLine_BigBit_APL.MDB
TableDefs matching ZR/AOP/Modla:  PDV_PPPDV_SviAOP   (jedina — i to za PDV prijavu, ne ZR)
OPEN FAIL [ZR_AOP_Modla] :: cannot find the input table or query 'ZR_AOP_Modla'
```

Sam Access engine, sa punim pravima, potvrđuje da tabela ne postoji nigde u sistemu. Istraga zatvorena.
Alat za buduća vađenja iz zaključanih `.mdb` sačuvan u `_legacy/_tools/access-com-extract/` (gitignored).
