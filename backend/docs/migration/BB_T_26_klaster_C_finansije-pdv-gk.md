## Klaster C — Finansije, PDV, Glavna knjiga, Banka, Osnovna sredstva, Konfiguracija

Analiza DDL snimka BigBit baze (`_analiza/bigbit/BB_T_26_schema.sql`, mdb-tools izvoz, 11.07.2026, 207
tabela) za **računovodstveno-finansijski klaster**. Ovo je „prava ERP strana" BigBit-a: glavna knjiga,
nalozi za knjiženje, kontni plan, šeme za kontiranje, PDV/POPDV evidencije i prijave, banka (virmani,
kursna lista, kamata), osnovna sredstva, profakture/usluge i sistemska konfiguracija. **Skoro ništa iz
ovog klastera nije u 2.0** — 2.0 je namerno izostavio knjigovodstvo/PDV (ROADMAP: „Van scope-a 2.0:
knjigovodstvo, PDV/KEPU, fakturisanje, fiskalizacija, POS — ostaje u BigBit-u, dolazi u 4.0"). Ovaj
klaster je zato **temelj domena `finance`/GL, `tax`, `banking`, `sef` iz verzije 4.0**.

> **Napomena o brojevima redova:** realni brojevi redova dati u zadatku (Predmeti, Komitenti, R_Artikli,
> Cenovnik…) **ne pokrivaju nijednu tabelu ovog klastera**. Za finansijske tabele broj redova nije
> priložen u ovom izvozu; treba ga povući `mdb-export`-om iz radne godišnje `.MDB` (GK/nalozi su po
> pravilu najveće transakcione tabele — desetine do stotine hiljada redova po godini). **Dodatni oprez:**
> `BB_T_26` je **eksterni magacinski** izvoz (`BB_T_2x.MDB`); deo finansijskih tabela je ovde prisutan
> strukturno, ali „žive" transakcione podatke (GK, nalozi, PDV) drži glavna godišnja `.MDB` po poslovnoj
> godini — strukturu čitamo odavde, obim/sadržaj se potvrđuje na produkcionoj bazi.

---

### C.1 Glavna knjiga i nalozi za knjiženje (domen `finance`/GL)

Jezgro dvojnog knjigovodstva. Nalog (`T_Nalozi`) je zaglavlje temeljnice, `T_Glavna knjiga` su njegove
dug/potraž stavke, `T_Grk*` su rekapitulacije, `T_GK_IZV_Stavke` su definicije finansijskih izveštaja.

| Tabela | PK (nasl.) | Svrha | Ključne kolone / veze |
|---|---|---|---|
| **T_Nalozi** | `IDNaloga` | Zaglavlje naloga za knjiženje (temeljnica) | `Broj naloga`, `Vrsta naloga`→`Vrsta naloga`, `Datum knjizenja`, `Level` (status), `Zakljucano`, `Godina`, `IDFirma`, `STARIID` |
| **T_Glavna knjiga** | `StavkaID` | Stavka glavne knjige (dug/potraž) | `Konto`→`Kontni plan`, `InoKonto`→`InoKontniPlan`, `Analiticka sifra` (analitika = šifra komitenta/partnera), `Duguje`/`Potrazuje`, `DevDuguje`/`DevPotrazuje`/`DevValuta` (devizno), `IDNaloga`→`T_Nalozi`, `Pozicija`→`Pozicije` (mesto troška), `IDPredmet`→`Predmeti`, `IDRadniNalog`→`RadniNalozi`, `IDDokIzRobnog`/`IDDokIzUsluga`/`IDDokMP`/`IDProdavnicaMP` (poreklo iz robnog/usluga/maloprodaje), `OJ`/`OD`, `Temeljnica`, `PNBOdobBrojGK` |
| **T_GrkZag** | `IDGrk` | Zaglavlje „grupnog knjiženja"/rekapitulacije | `BrojGrk`, `Datum`, `IDKomitent`, `Level`, `IDFirma`/`Godina` |
| **T_GrkStavke** | `ID` | Stavke rekapitulacije, vezuju GK stavke | `IDGrk`→`T_GrkZag`, `IDStavkeIzGK`→`T_Glavna knjiga`, `Duguje`/`Potrazuje` |
| **T_GK_IZV_Stavke** | `ID` | Definicije redova finansijskih izveštaja (bilans stanja/uspeha, ZR) | `IZV` (šifra izveštaja), `Rbr`, `Opis`, `Formula` (formula nad opsezima konta), `Vred`/`_DevVred`, `DIVDef`/`DIVUpdate` |

**Status u 2.0:** GAP — nijedan model ne postoji. Ciljni domen: `finance` (jedan atomski, idempotentan
posting servis koji objedinjuje automatsko i ručno knjiženje — ROADMAP 4.0 §3). `T_GK_IZV_Stavke` je
izveštajni sloj (APR bilansi) — trijaža po kritičnosti, ne migrira se 1:1.

---

### C.2 Kontni plan i šeme za kontiranje (domen `finance` / poreski šifarnici)

Ovde živi **većina automatskog knjiženja** — šeme za kontiranje su posting-rules engine. ROADMAP 4.0
eksplicitno traži „šeme za kontiranje (posting rules) kao podatak".

| Tabela | PK (nasl.) | Svrha | Ključne kolone / veze |
|---|---|---|---|
| **Kontni plan** | `Konto` | Radni kontni plan firme | `Opis`, `Dugacki opis`, `Plan duguje`/`Plan potrazuje` (planske vrednosti), `Dozvoljen unos analitike`, `Fajl sifara` (šifarnik analitike), `InoKonto`→`InoKontniPlan` |
| **KontniPlan_STD** | `Konto` | Standardni/šablonski kontni plan (ista struktura) | seme se iz njega izvodi radni plan po firmi |
| **InoKontniPlan** | `InoKonto` | Paralelni/ino kontni plan (grupno/IFRS izveštavanje) | `Opis` |
| **Sema za kontiranje** | `IDSeme` | Zaglavlje šeme za automatsko kontiranje | `Vrsta naloga`→`Vrsta naloga`, `Opis` |
| **Stavke seme za kontiranje** | `IDStavkeSeme` | Redovi šeme = pravila knjiženja | `IDSeme`→`Sema za kontiranje`, `Konto`, `DefDug`/`DefPot` (izrazi/formule za dug i potraž), `Analitika`, `Poreklo`, `KngSifra_2` |
| **PDV_SemeKontaZaKnjizenje** | `Konto`+`PDVEvidencija` | Mapiranje konta → PDV prepoznavanje pri knjiženju | `DugPot`, `PDVStopa`, `PDVOsnovica`/`ObracunPDVOsnovica`/`ObracunPDVIznos` (flagovi), `PDVGrupa`, `AOP_POPDV` |
| **POPDV_SemeKontaZaKnjizenje** | `Konto`+`PDVOznaka` | Mapiranje konta → POPDV kolone | `K1Def`–`K4Def` (definicije POPDV kolona) |

**Status u 2.0:** GAP. **Kritično:** ROADMAP §11 „Korak 0" upozorava da se većina poslovnih pravila
knjiženja krije u Access **imenovanim upitima** (`PDV_Uknjizi*`, `Sema za kontiranje`, `NSK_*`…) koji NISU
u VBA izvozu — bez ekstrakcije tih upita ove tabele su prazan skelet bez logike. Ovo je preduslov domena
`finance` i `tax`.

---

### C.3 PDV evidencije i prijave (domen `tax`)

Registri KIF/KUF, PPPDV forma i mapiranja ka SEF/Poreskoj upravi.

| Tabela | PK (nasl.) | Svrha | Ključne kolone / veze |
|---|---|---|---|
| **T_PDV_IF** | `ID` | Registar izlaznih faktura (KIF) — PDV po stopama | `PDVVisaStopa`/`PDVNizaStopa`, `VredBezPDVVisa/Niza/Nula`, `UmanjenjeBezPDV*`, `VrstaDok`, `BrDok`, `PIB`, `DatPorPerioda`, `Period`, `IDDokIzRobnog`/`IDDokIzFin`/`IdDokIzUsluga`/`IDPazar` (poreklo), `JestePromet`, `OJ`/`OD`/`Godina` |
| **T_PDV_UF** | `ID` | Registar ulaznih faktura (KUF) | kao IF + `PDVPoljoStopa`, `NabVredVanPDV`, `VredBezPDVPoljo`, `UmanjenjeBezPDVPoljo` |
| **T_PDV_GK** | `ID` | PDV vezan za ručne GK stavke | `StavkaID`→`T_Glavna knjiga`, `PDVEvidencija`, `PDVStopa`, `PDVOsnovica`/`PDVIznos`, `PDVGrupa`, `DatPorPerioda` |
| **PDV_Knjige** | `PDVEvidencija` | Definicija PDV evidencija (knjiga) | `Naziv`, `AOPOsnovica`/`AOPIznosPDV` (AOP mapiranje), `UF` (ulaz/izlaz flag) |
| **PDV_Knjige_DefKolona** | `ID` | Koje kolone pripadaju kojoj knjizi | `IDKnjiga`→`PDV_Knjige`, `IDKolona`→`PDV_Kolone` |
| **PDV_Kolone** | `IDKolonaPDV` | Definicija PDV kolona | `ImeKolone`, `AOP_PPPDV` |
| **PDV_PPPDV** | `ID` | Podaci PPPDV prijave (obrazac) | svi AOP totali osnovica/PDV po stopama (izlaz opšta/posebna/sa i bez prava na odbitak, ulaz uvoz/poljo/ostalo), `OdDatuma`/`DoDatuma`, `Period`, `PIB`, `Firma`, poreski savetnik, `Povracaj`, `OJ`/`OD`/`Godina` |
| **PDV_IF_PU_MAP** | `VrstaDok`+`Kolona` | Mapiranje vrste dok. → kolona za PU/SEF (izlaz) | `Opis` |
| **PDV_UF_PU_MAP** | `VrstaDok`+`Kolona` | Isto za ulaz (individualna/zbirna evidencija PDV) | `Opis` |

**Status u 2.0:** GAP. Regulatorno najosetljiviji podskup (KIF/KUF/PPPDV + SEF eFaktura). ROADMAP 4.0 §6:
„PDV knjige derivišu iz faktura/GK". Domen `tax`, oslonjen na `finance`+`sales`.

---

### C.4 POPDV (domen `tax`, pod-obrazac)

| Tabela | PK (nasl.) | Svrha | Ključne kolone / veze |
|---|---|---|---|
| **T_POPDV_GK** | `StavkaID`(+`PDVOznaka`) | POPDV iznosi po GK stavci | `PDVOznaka`, `DatPorPerioda`, `K1Iznos`–`K4Iznos` |
| **T_POPDV_EvidentiranePrijave_Zag** | `POPDVIDPrijave` | Zaglavlje evidentirane POPDV prijave | `POPDVOdDatuma/DoDatumaPorPerioda`, `POPDVDatumPrijave`, `POPDVVrstaPrijave`, `POPDVIDPrijaveKojaSeMenja` (izmena/storno), `BrDec` |
| **T_POPDV_EvidentiranePrijave_Stavke** | `POPDVIDPrijave`+`PDVOznaka` | Stavke POPDV prijave (sekcije/kolone) | `Rbr`, `Sekcija`, `Header`, `Opis`, `AktivneKolone`, `K1Val`–`K4Val`, `K1Def`–`K4Def`, `K1AOP`–`K4AOP` |

**Status u 2.0:** GAP. **Zapažanje vredno potvrde:** ROADMAP 4.0 §6 kaže da se „POPDV gradi od nule (u
BigBit-u je eksterna `.mdb`)". Ovaj snimak, međutim, **sadrži POPDV strukture** (`T_POPDV_GK`,
`T_POPDV_EvidentiranePrijave_*`, `POPDV_SemeKontaZaKnjizenje`). Znači: **skladište POPDV prijava jeste u
BigBit-u**, dok bi *logika obračuna* mogla biti u eksternoj `BigBit_APL_2010.mdb`. Ovo treba razrešiti
pre 4.0 — možda deo obračuna ipak postoji ovde (uštedelo bi „od nule" gradnju).

---

### C.5 Banka i plaćanja (domen `banking`)

| Tabela | PK (nasl.) | Svrha | Ključne kolone / veze | 2.0 |
|---|---|---|---|---|
| **Virmani** | `IDVirman` | Nalozi za plaćanje (virmani) — state machine | `IDNaTeret`/`IDUKorist`→`UplatniRacuni`, `SvrhaDoznake`, `PNBZadModel`/`PNBZadBroj` + `PNBOdobModel`/`PNBOdobBroj` (poziv na broj, MOD97/11), `SifraPlacanja`, `Iznos`, `NaTeret/UKoristZiroRacun`, `Status`, `IDDokIzRobnog`/`IDDokIzGK`/`IDStavkaIzNaloga`, `RedniBrojSerije`, `Zakljucano` | GAP |
| **UplatniRacuni** | `ID` | Tekući računi firme | `UplatniRacun`, `NazivBanke`, `Default`, `KodZemlje`, `OznakaBanke`, `Rbr` | **`PaymentAccount` / `payment_accounts`** — modelovano i U SYNC MAPI, ali je iz QBigTehn izvora stiglo prazno (ROADMAP: dolazi kroz Sync B, direktan BigBit) |
| **INOUplatniRacuni** | `IDINOUplatniRacun` | Ino računi (korespondentna/beneficijar banka, SWIFT) | `Cor*`/`Ben*` (banka/swift/grad/adresa/zemlja), `Default`, `Rbr` — za devizna plaćanja (IBAN/SWIFT na proformi, ROADMAP nabavka §avansni tok) | GAP |
| **VrstePlacanja** | `IDVrstaPlacanja` | Šifarnik načina plaćanja | `OpisVrstePlacanje` — POS/blagajna | GAP |
| **Kursna lista** | `Datum`+`IDBanka`+`DevValuta` | Kursna lista po danu/banci/valuti | `SrednjiKurs`/`ProdajniKurs`/`KupovniKurs` — hrani devizne stavke GK/faktura, kursne razlike (5630/6630) | GAP |
| **Depoziti** | `ID` | Depoziti/avansni saldo komitenta | `IDKomitent`, `Zaduzenje`/`Uplata`, `Valuta`/`Kurs`, `IDDok`, `IDProdavnica`/`IDKasa`/`IDBlagajnaStavke` (POS veza) | GAP |

**Status u 2.0:** samo `UplatniRacuni` ima cache model. Domen `banking` (ROADMAP 4.0 §7): izvodi
(auto 2040/4350, uparivanje po TR), virmani (state machine), konformna kamata, MOD97/11, formati → ISO 20022.

---

### C.6 Kamata (domen `banking`, pod-modul)

| Tabela | PK (nasl.) | Svrha | Ključne kolone |
|---|---|---|---|
| **KamataRucno** | `KamateRucnoID` | Zaglavlje ručnog obračuna kamate | `Komitent`, `DatumObracuna`, `BrojDokumenta`, `DatumDokumenta`/`Valute`/`Placanja`, `Iznos` |
| **KamataStavkeDetaljno** | (bez ID) | Detaljne stavke obračuna | `Konto`, `Broj dokumenta`, `SaldoStavke`, `KamataDoDatuma`, `KoeficijentKamate`, `SumaZaKamatu`, `IznosKamate` |
| **KamataVrsteStopa** | `VrstaStopeID` | Vrste kamatnih stopa | `NazivStope` |
| **KamatneStope** | `StopeID` | Kamatne stope (effective-dated) | `VrstaStope`→`KamataVrsteStopa`, `OdDatumaStope`, `IznosStope`, `ZaDana` |

**Status u 2.0:** GAP. ROADMAP 4.0 §7 „konformna kamata". Niska prioritet, ali regulatorno tačno.

---

### C.7 KEPU / Trgovačka knjiga / AVR (domen `inventory`↔`tax`)

Zakonske knjige i rekapitulacije avansnih računa.

| Tabela | PK (nasl.) | Svrha | Ključne kolone / veze |
|---|---|---|---|
| **T_Knjiga KEPU** | `IDStavke` | KEPU knjiga (veleprodaja) po magacinu | `IDMagacin`, `Zaduzenje`/`Razduzenje`, `Iznos uplate`, `Rbr`, `Level`, `OJ`/`OD`/`Godina` |
| **T_Knjiga KEPU_MP** | `IDStavke` | KEPU knjiga (maloprodaja) po prodavnici | kao gore + `IDProdavnica` |
| **T_Trgovacka knjiga** | `IDStavke` | Trgovačka knjiga (TK) | `IDProdavnica`, `IDDok`, `Zaduzenje`/`Razduzenje`, `Datum/Iznos uplate`, `Vrsta dokumenta`, `Rbr`, `OJ`/`OD`/`Godina` |
| **T_AVR_Roba** | `ID` | Rekapitulacija avansnih računa — roba | `IDDok`, `BrojDokAVR`/`DatumDokAVR`, `UkIznosSaPDVAVR`, `UkPDVVisa/Niza`, `Koristi*` (iskorišćeni iznosi avansa), `ID_PO` (poresko oslobađanje) |
| **T_AVR_Usluge** | `ID` | Rekapitulacija avansnih računa — usluge | ista struktura kao AVR_Roba |

**Status u 2.0:** GAP. KEPU/TK su regulatorne knjige (ROADMAP: eksplicitno van 2.0, u 4.0); hrane ih
robna dokumenta + GK. AVR se veže na PDV avansni tok (ROADMAP tok B/C).

---

### C.8 Osnovna sredstva (domen `finance` — pod-modul OS)

| Tabela | PK (nasl.) | Svrha | Ključne kolone / veze |
|---|---|---|---|
| **T_OS_Sredstva** | `IDOS` | Registar osnovnih sredstava | `Inventarni broj`, `Kataloski broj`, `Naziv`, `MarkaTipModel`, `Kolicina`, `Grupa`/`Podgrupa`, `ID dobavljaca`→`Komitenti`, `Datum nabavke`, `Stopa otpisa`, `AmGrupa` (amortizaciona grupa) |
| **T_OS_Stavke** | `IDStavke` | Kretanja/amortizacija po sredstvu | `IDOS`→`T_OS_Sredstva`, `Vrednost`, `Otpis`, `DatumObracuna`, `PorAmVrednost`/`PorAmOtpis`/`PorAmProdaja` (poreska amortizacija) |

**Status u 2.0:** GAP. ROADMAP 4.0 §3 pominje OS unutar `finance` (bilansi/ZR/APR). Zaseban, relativno
izolovan pod-modul — kandidat za kasniju fazu 4.0.

---

### C.9 Profakture i usluge (domen `sales`)

| Tabela | PK (nasl.) | Svrha | Ključne kolone / veze |
|---|---|---|---|
| **T_Profakture** | `IDDok` | Profakture (ponude/predračuni) — struktura kao robno | `Broj/Vrsta dokumenta`, `Sifra komitenta`→`Komitenti`, `Sifra prodavca`→`Prodavci`, `IDPredmet`→`Predmeti`, `Kurs`, `Status`, `Level` |
| **T_Profakture stavke** | `IDStavke` | Stavke profakture | `IDDok`→`T_Profakture`, `Sifra artikla`→`R_Artikli`, cene (nabavna/kalkulativna/stvarna VP/MP), `Tarifa*`, `RabatProc`/`KasaProc`, `Neoporezivi deo` |
| **T_Usluge dokumenta** | `IDDok` | Dokumenti usluga (IFUSL i sl.) | `Sifra komitenta`, `IDRadniNalog`→`RadniNalozi`, `IDPredmet`, `IDDokIF`, `Ulaz`, dev. vrednosti (`ObrKurs`/`CarKurs`/`DevVred`/`DevValuta`), `MestoPrometa`/`DatumPrometa`, `Zapisnik` (memo umesto otpremnice — ROADMAP tok B), `PrihvacenDok`, `OJ`/`OD`/`Godina` |
| **T_Usluge stavke** | `IDStavke` | Stavke usluge | `IDDok`, `Opis`, `Kolicina`/`Cena`, `Tarifa usluga`, `Grupa`, `DevCena`, `CarStopa`, `IDRazlogOslobadjanja` (razlog PDV oslobađanja) |
| **T_Usluge Servis** | `IDStavke` | Servisni rad po RN i radniku | `IDRadniNalog`→`RadniNalozi`, `IDRadnik`→`tRadnici`, `Opis`, `Kolicina`/`Cena` |

**Status u 2.0:** GAP. Domen `sales` (najveći domen 4.0). Profakture/usluge su komercijalni dokumenti
vezani kroz `IDPredmet`/`IDRadniNalog` na već postojeće 2.0 entitete (`projects`, `work_orders`) — to je
prirodna spona pri 4.0 integraciji.

---

### C.10 Konfiguracija, statusi, infrastruktura

| Tabela | PK (nasl.) | Svrha | 2.0 status |
|---|---|---|---|
| **CFG_Global** | `Parametar` | Globalni parametri (par firme) | **`GlobalConfig` / `global_config`** — SYNCED. Napomena: u `BB_T_26` verziji nema `IDFirma` kolone, a 2.0 sync mapira `IDFirma`→`companyId` (kompozitni PK) — glavna `.MDB` očito ima `IDFirma`; potvrditi izvor |
| **Parametri za rad** | `Korisnik` | Per-user parametri (brojači faktura/profaktura, prefiksi) | **`WorkParameter` / `work_parameters`** — SYNCED |
| **BBPravaPristupa** | `ID` | UI-nivo prava pristupa (po useru/formi/kontroli) | **`AccessRight` / `access_rights`** — SYNCED. `ImeUsera`, `ImeForme`, `ImeKontrole`, `Visible`/`Locked`/`Enabled`, `Vrednost`, `RecordSource`, `Filter` → **izvor za 2.0 RBAC** (vidi preporuke) |
| **Vrsta naloga** | `Vrsta naloga` | Šifarnik vrsta naloga za knjiženje | **`OrderType` / `order_types`** — modelovano, ali **NIJE u sync mapi** (prazan stub; puni se tek u 4.0 ili dodatkom u Sync B) |
| **Vrste sifara** | `Vrsta sifre` | Šifarnik tipova šifara komitenata | **`CodeType` / `code_types`** — SYNCED (masters lookup, veže `Customer.codeTypeCode`) |
| **T_Statusi** | `IDStatus`(+`Tabela`) | Generički rečnik statusa (polimorfno po tabeli) | GAP — u 2.0 statusi su String polja/lookup po modulu |
| **T_SerijeStatusa** | `IDSerije` | Serije statusa isporuke (grupno) | GAP — `PrimioFakturu`/`UtovarioUVozilo`/`Isporuceno`/`PripremioRobu` + `Upisi*` flagovi (logistika/otprema, domen `sales`/dispatch, ne finansije) |
| **T_StavkeSerijeStatusa** | `ID` | Veza serije statusa ↔ dokument | `IDSerije`→`T_SerijeStatusa`, `IDDok` |
| **Semafor** | `Uredjaj` | Zaključavanje uređaja/mutex (concurrency) | GAP — infra; zamenjuje ga aplikativno zaključavanje, NE migrira se |
| **KASE** | `IDKasa` | POS kase + SHUTTLE sync konfiguracija | GAP — domen POS/maloprodaja (ROADMAP: uslovno, samo ako se koristi) |

---

### Tabela mapiranja BigBit → ServoSync 2.0 (klaster C)

| BigBit tabela | 2.0 model / tabela | Sync | Status | Ciljni domen 4.0 |
|---|---|---|---|---|
| BBPravaPristupa | AccessRight / `access_rights` | ✅ | U 2.0 (cache) | → RBAC (masters/config) |
| CFG_Global | GlobalConfig / `global_config` | ✅ | U 2.0 (cache) | masters/config |
| Parametri za rad | WorkParameter / `work_parameters` | ✅ | U 2.0 (cache) | masters/config |
| Vrste sifara | CodeType / `code_types` | ✅ | U 2.0 (cache) | masters |
| UplatniRacuni | PaymentAccount / `payment_accounts` | ✅ (prazno) | U 2.0 (cache, nepopunjen) | banking |
| Vrsta naloga | OrderType / `order_types` | ❌ | Modelovano, nije sinkovano | finance |
| T_Nalozi | — | — | GAP | **finance/GL** |
| T_Glavna knjiga | — | — | GAP | **finance/GL** |
| T_GrkZag / T_GrkStavke | — | — | GAP | finance/GL |
| T_GK_IZV_Stavke | — | — | GAP | finance (izveštaji/APR) |
| Kontni plan / KontniPlan_STD / InoKontniPlan | — | — | GAP | **finance (kontni plan)** |
| Sema za kontiranje / Stavke seme za kontiranje | — | — | GAP | **finance (posting rules)** |
| PDV_SemeKontaZaKnjizenje / POPDV_SemeKontaZaKnjizenje | — | — | GAP | tax (posting rules) |
| T_PDV_IF / T_PDV_UF / T_PDV_GK | — | — | GAP | **tax (KIF/KUF)** |
| PDV_Knjige / _DefKolona / PDV_Kolone / PDV_PPPDV | — | — | GAP | tax (PPPDV) |
| PDV_IF_PU_MAP / PDV_UF_PU_MAP | — | — | GAP | tax/sef (PU mapiranje) |
| T_POPDV_GK / T_POPDV_EvidentiranePrijave_Zag/_Stavke | — | — | GAP | tax (POPDV) |
| Virmani | — | — | GAP | **banking** |
| INOUplatniRacuni | — | — | GAP | banking |
| VrstePlacanja | — | — | GAP | banking/POS |
| Kursna lista | — | — | GAP | banking (kursne razlike) |
| Depoziti | — | — | GAP | banking/sales |
| KamataRucno / KamataStavkeDetaljno / KamataVrsteStopa / KamatneStope | — | — | GAP | banking (kamata) |
| T_Knjiga KEPU / KEPU_MP / T_Trgovacka knjiga | — | — | GAP | inventory/tax (zakonske knjige) |
| T_AVR_Roba / T_AVR_Usluge | — | — | GAP | tax (avansi) |
| T_OS_Sredstva / T_OS_Stavke | — | — | GAP | finance (osnovna sredstva) |
| T_Profakture / T_Profakture stavke | — | — | GAP | sales |
| T_Usluge dokumenta / stavke / Servis | — | — | GAP | sales |
| T_Statusi / T_SerijeStatusa / T_StavkeSerijeStatusa | — | — | GAP | sales/dispatch |
| Semafor | — | — | GAP (ne migrira se) | infra (app-lock) |
| KASE | — | — | GAP | POS (uslovno) |

**Rezime:** 6 od ~50 tabela klastera su u 2.0 (5 sinkovanih cache + 1 nesinkovan stub `OrderType`). Sve su
konfiguracioni/šifarnički skelet — **nijedna transakciona finansijska tabela (GK, PDV, banka) nije u 2.0**.

---

### Preporuke za pripremu domena (4.0)

**1. Šta migrirati vs. ostaviti u BigBit-u do 4.0.**
- **Ostaje u BigBit-u do triger-a za 4.0** (ROADMAP: 4.0 nema rok, pokreće se trigerima): sve transakciono
  iz C.1/C.3/C.4/C.5/C.6/C.7 — GK, PDV/POPDV, virmani, kamata, KEPU/TK. Ovo BigBit danas radi pouzdano;
  regulatorni rizik prevelik za prevremeni prelaz. „Legitimno stabilno stanje = duži period na 3.0 +
  BigBit na SQL Server-u" (ROADMAP 4.0).
- **Rano/postupno u 2.0/3.0 kao cache (Sync B), pošto su matični i mali:** `Kontni plan`, `KontniPlan_STD`,
  `InoKontniPlan`, `Vrsta naloga`, `VrstePlacanja`, `UplatniRacuni`/`INOUplatniRacuni`, `Kursna lista`.
  Ovi su temeljni šifarnici koje domeni iznad troše i ne menjaju se često; njihova rana dostupnost
  olakšava razvoj `finance`/`banking` bez čekanja pune migracije. **Prošireti sync mapu** (`OrderType`
  već postoji kao model, treba mu samo syncer; `Kursna lista` je kandidat #1 jer je čist read-only feed).
- **Ne migrira se:** `Semafor` (infra mutex — zamenjuje aplikativno zaključavanje/red u bazi), `KASE`
  (POS/SHUTTLE, uslovno), `T_tmp`/pomoćne.

**2. BBPravaPristupa → 2.0 RBAC.** Već se sinkuje u `access_rights`, ali je to **UI-nivo model**
(forma × kontrola × Visible/Locked/Enabled), ne rola-based. Preporuka: koristiti ga kao **izvor za
inventar prava** (koji korisnik šta vidi/menja danas) pri seed-ovanju 2.0 kataloga permisija
(`RBAC_RLS_PREDLOG.md`), ali NE portovati 1:1 — 2.0 ide na role × permisije × per-projekat scope
(`RolesGuard` + `@RequirePermission()`). `access_rights` ostaje read-only referenca za paritetnu
proveru, ne kao aktivni authz sloj. Konkretno: iz `ImeForme`/`ImeKontrole` izvesti mapu ekran→akcija,
pa je preslikati na permisije; `Filter`/`RecordSource` pokazuju per-red scope pravila (kandidati za
query-scoping u NestJS guardovima).

**3. Regulatorne zavisnosti i redosled (odozdo naviše, ROADMAP 4.0 §13):**
`masters` → **`tax` šifarnici (kontni plan, šeme za kontiranje, poreske stope effective-dated)** →
**`finance`/GL (posting engine: T_Nalozi + T_Glavna knjiga, jedan atomski idempotentan servis)** →
`inventory` → `sales` + `sef` → **PDV knjige/POPDV (derivišu iz faktura/GK)** → `banking` → `procurement`/`customs`.
Šeme za kontiranje (C.2) su spona: bez njih ni GL ni PDV nemaju automatiku.

**4. Korak 0 — obavezan preduslov (ROADMAP §11).** Ekstrahovati Access **imenovane upite**
(`PDV_Uknjizi*`, `ProknjiziUKEPU*`, `Sema za kontiranje`, `NSK_*`, `PREB_*`, `CEN_*`) iz `.accdb`/`.mdb` —
tamo živi logika knjiženja/PDV koja NIJE u ovim tabelama (ni u VBA izvozu). Bez toga su C.1–C.4 prazan
skelet. Tabele definišu *strukturu*; upiti definišu *pravila*.

**5. Otvorena pitanja za sastanak Negovan/Vasa/Tatjana (knjigovodstvo):**
- **POPDV:** ovaj snimak *ima* POPDV tabele — potvrditi da li je i *obračun* ovde ili u eksternoj
  `BigBit_APL_2010.mdb`; ako je bar delom ovde, „gradnja od nule" se svodi na derivaciju + validaciju.
- **Izvor Sync B:** `UplatniRacuni` je već modelovan ali stiže prazan (kroz QBigTehn) — potvrditi da
  direktan BigBit (SQL Server upsizing) puni `payment_accounts` i proširiti opseg na kontni plan/kurseve.
- **KEPU/TK:** potvrditi da li su *zakonski* potrebne u novom sistemu od dana cutover-a ili se do 4.0
  vode u BigBit-u (verovatno ostaju u BigBit-u — regulatorni rizik).
- **Broj redova:** povući `mdb-export` count za GK/PDV tabele iz radne godišnje `.MDB` za procenu obima
  migracije (ovaj `BB_T_26` je magacinski izvoz, ne finansijski core).
