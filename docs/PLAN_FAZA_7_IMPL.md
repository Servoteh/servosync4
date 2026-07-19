
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
