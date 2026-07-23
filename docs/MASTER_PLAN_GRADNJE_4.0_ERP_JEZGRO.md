# Master plan gradnje — ServoSync 4.0 ERP jezgro (BigBit paritet + Pantheon/SAP)

> Izvor: gap-audit 9 ERP modula (Nabavka, Robno, Glavna knjiga, Saldakonti, Bankovni izvodi,
> Priprema plaćanja/virmani, PDV/POPDV/KEPU, Fakturisanje/SEF, Završni račun/APR).
> Napomena: „Saldakonti", „Bankovni izvodi" i „Priprema plaćanja/virmani" su **preklapajući auditi
> istog finansijskog domena** — kompenzacija, virmani, izvodi i kamata se javljaju u više njih. U
> planu su spojeni u jedinstvene stavke da se ne rade dva puta (obeleženo „⊕ deljeno").

---

## 1. Izvršni rezime

**Ukupno gap-ova:** ~155 kroz 9 auditovanih modula (nabavka 20, robno 20, GK 20, saldakonti 20,
izvodi 23, plaćanja 21, PDV 17, fakturisanje 20, završni 20 — sa značajnim preklapanjem u
finansijskom domenu; efektivno jedinstvenih ~120 posle spajanja duplikata).

**Raspodela po vrsti:**

| Kategorija | Broj | Udeo |
|---|---|---|
| **BIGBIT_PARITET** (mora, da bi 4.0 zamenio BigBit) | ~112 | ~72% |
| **PANTHEON_SAP_BOLJE** (poboljšanja iznad legacy-ja) | ~43 | ~28% |

**Paritet gap-ovi po severity:**

| Severity | Broj (paritet) | Značenje |
|---|---|---|
| **BLOKER** | 16 | Modul faktički neupotrebljiv u produkciji dok se ne reši |
| **VISOK** | 27 | Radi delimično, ali ključna funkcija nedostaje / netačna |
| **SREDNJI** | ~45 | Paritet-rupa koju korisnik oseti, ali postoji zaobilaznica |
| **NIZAK** | ~24 | Kozmetika / retko korišćeno |

### Procena: da li 4.0 ima „minimum sav BigBit"?

**NE — trenutno ne.** Ključni nalaz koji se ponavlja u **svakom** modulu: **backend je uglavnom
napisan i zreo, ali FE (unos/štampa/pregled) nedostaje ili je „mrtav kod" (hook definisan, nigde
pozvan).** Sistem je danas u velikoj meri „read-only kroz UI" za jezgro ERP-a.

Tri sistemska obrasca koja obaraju paritet:

1. **Mrtvi FE hookovi / nedostajuće forme** — `useCreateRequest`, `useCreateProforma`,
   `ReceiveOrderDialog`, robno `useCreate`, kompenzacija FE, pregled virmana, APR XML download —
   sve postoji na backendu, ali korisnik ne može da dođe do funkcije. Ovo je **najjeftiniji i
   najvredniji** talas posla (S/M effort, otključava BLOKER-e).

2. **Nedostajuće štampe/izvozi (PDF/XML)** — nijedan modul nema izloženu štampu preko kontrolera
   (print moduli bez `@Controller`); PP-PDV obrazac, IOS, nalog za knjiženje, faktura, APR XML
   dugme — sve fali. Regulatorno blokira zamenu BigBita.

3. **Nedovršeni tokovi zaključavanja/knjiženja** — status-mašine stoje u `draft`/`CREATED`
   zauvek (GK auto-nalozi zaglavljeni u draft → cela GK prazna za korisnika; virmani nikad
   `SIGNED`; nivelacija/kompenzacija/PDV period se ne knjiže ni ne zaključavaju).

**Zaključak:** 4.0 ima **solidno backend jezgro (motor kalkulacije, posting engine, UBL/SEF,
GKEval, numeracija) — bolje projektovano od BigBita** — ali **nema kompletan operativni omotač**.
Do produkcije-parizteta fali ~16 BLOKER + 27 VISOK paritet-stavki (Talas 1). Većina su S/M effort
jer je backend gotov.

---

## 2. Gap matrica po modulu

| Modul | Paritet gap-ova (B/V/S/N) | Pantheon/SAP poboljšanja | Najkritičniji nedostatak |
|---|---|---|---|
| **Nabavka (P2P)** | 12 (B3 / V3 / S5 / N1) | 6 | **Kreiranje narudžbenice (PO) ne postoji** — `purchaseOrder.create`=0, `nextYearlyOrder` mrtva; cela ORDERED grana visi |
| **Robno / zalihe / kalkulacija** | 12 (B2 / V6 / S3 / N1) | 6 | **FE nema formu za kreiranje robnog dokumenta** — ceo modul read-only kroz UI; nema Primke/Izdatnice/lager liste |
| **Glavna knjiga** | 13 (B3 / V1 / S6 / N3) | 5 | **Auto-nalozi zaglavljeni u `draft`** → kartica/bruto/BS-BU prazni; nema ručnog unosa naloga ni kontnog plana |
| **Saldakonti** ⊕ | 13 (B2 / V3 / S5 / N3) | 4 | **Obračun zatezne kamate ne postoji** (~1140 linija Kamate.bas, XL); IOS obrazac fali; „Upari" mrtvo dugme |
| **Bankovni izvodi** ⊕ | 17 (B2 / V4 / S6 / N5) | 5 | **Izvod potpuno read-only** — nema ručnog unosa/korekcije stavke; nema pregleda naloga; kompenzacija se ne knjiži |
| **Priprema plaćanja / virmani** ⊕ | 14 (B2 / V3 / S6 / N3) | 5 | **Nema pregleda kreiranih naloga** (refresh ih gubi); status 0→1→2 mrtav kod → nema potpisa; export bez guarda |
| **PDV / POPDV / KEPU** | 12 (B2 / V4 / S5 / N1) | 5 | **`vat_account_map` nije seed-ovan** → KIF/KUF/POPDV vraćaju NULU; nema štampe PP-PDV obrasca |
| **Fakturisanje / SEF** | 13 (B4 / V4 / S4 / N1) | 6 | **FE nema štampu ni mail** (print bez kontrolera); UBL bez PO broja→SEF odbija javni sektor; SEF ulazne fakture (15-dana rok) fale |
| **Završni račun / APR** | 12 (B2 / V5 / S3 / N2) | 4 | **Prave ZR_AOP_Modla formule nisu izvezene** (seed=rekonstrukcija→APR potencijalno pogrešan); FE nema APR XML download |

Legenda: B=BLOKER, V=VISOK, S=SREDNJI, N=NIZAK. ⊕ = deljeni finansijski domen (kompenzacija,
izvod, virman, kamata dele backend `saldakonti`/`placanja`/`izvodi` module).

---

## 3. Prioritizovan plan — 3 talasa

### 🔴 TALAS 1 — Paritet-blokeri (MORA pre produkcije)

Sve `BIGBIT_PARITET` severity **BLOKER + VISOK**. Sortirano po severity, pa po effort (jeftinije prvo).

#### 1A — Mrtvi FE / nedostajuće forme (BLOKER, mahom S/M — najbolji odnos vrednost/trošak)

| # | Modul | Effort | Stavka |
|---|---|---|---|
| 1 | Bankovni izvodi | L | **Ručni unos/korekcija stavke izvoda** + izbor strane/analitike (izvod je danas 100% read-only, hardkod 2040/4350) — *poznati blocker, počni odavde* |
| 2 | Priprema plaćanja | M | **Pregled kreiranih naloga** (`GET /placanja/orders` + FE ekran) — bez njega refresh gubi naloge, ništa se ne može potpisati/izvesti |
| 3 | Priprema plaćanja | M | **Životni ciklus 0→1→2** — izložiti `sign`/`pay` rute + FE dugmad (`markSigned`/`markPaid` su mrtav kod) |
| 4 | Nabavka | S | **Wiring „Novi zahtev" forme** — `useCreateRequest` mrtav; korisnik ne može napraviti zahtev iz UI |
| 5 | Nabavka | S | **Status-prelazi PO →ORDERED/SIGNED** — bez njih PO zauvek DRAFT, prijem nemoguć |
| 6 | Nabavka | L | **Kreiranje narudžbenice (PO)** — `createOrder` servis + ruta + FE lista/detalj (koren zašto je pola audita „NE") |
| 7 | Robno | L | **FE forma za kreiranje robnog dokumenta** (UL/IZ/NIV/popis) — ceo modul read-only; preduslov za sve robno |
| 8 | Robno | L | **Lager lista** (stanje po magacinu + cene) — bez nje nema izlaza/popisa/kontrole; `averageAsOf` konačno uvezati |
| 9 | Glavna knjiga | M | **Auto-nalozi draft→posted→locked** — bez toga cela GK prazna za korisnika (kartica/bruto/BS-BU) |
| 10 | Glavna knjiga | M | **Kontni plan** — endpoint + FE ekran (danas 0 ruta, knjigovođa ne vidi kontni plan) |
| 11 | Glavna knjiga | L | **Ručni unos naloga (temeljnica)** — `postManualEntry` nije HTTP-izložen |
| 12 | Fakturisanje | M | **FE štampa + mail** — `SalesPrintController` (print modul bez kontrolera, sav PDF/mail mrtav) |
| 13 | Fakturisanje | M | **„Novi predračun" forma** — `useCreateProforma` neuvezen |
| 14 | PDV | S | **Seed `vat_account_map`** — koren; bez njega KIF/KUF/POPDV vraćaju nulu (konvertovati `_nacrt` u aktivan seed) |
| 15 | Završni | S | **APR/eFI XML download dugme** na FE (backend radi, FE hook = 0) |
| 16 | Završni | M | **Import pravih ZR_AOP_Modla formula** iz Slavišine .mdb (seed je rekonstrukcija → APR nesme na predaju dok se ne verifikuje 1:1) |

#### 1B — Visok paritet (radi delimično, ključna rupa)

| # | Modul | Effort | Stavka |
|---|---|---|---|
| 17 | Nabavka | S | **Wiring prijema robe** — `ReceiveOrderDialog` mrtav; backend gotov (zavisi od #6) |
| 18 | Nabavka | M | **Prihvatanje ponude** (accept quote) + upis cene/roka → lanac RFQ→ponuda→PO prekinut |
| 19 | Nabavka | M | **RFQ lista/grid + detalj** (`GET /rfqs`) — poslati upit se ne vidi |
| 20 | Nabavka | M | **PDF prilog na RFQ mejlu** + email dobavljača iz Komitenti |
| 21 | Robno | S | **Kontrola negativnog stanja** pri izlazu (`stateAsOf` postoji, ne poziva se) |
| 22 | Robno | M | **Knjiženje nivelacione razlike** (`valueAdjustment`) u GK — GK i lager se razilaze |
| 23 | Robno | S | **PDV u kalkulaciji (`taxRateOf`)** — vraća 0, MP cene pogrešne; centralizovati stopu |
| 24 | Robno | L | **Popis/inventura tok** (predpunjenje→unos→razlika→VISAK/MANJAK) — zakonski obavezan popis |
| 25 | Robno | M | **KEPU punjenje** — tabela ostaje prazna uprkos komentaru |
| 26 | Robno | M | **Spec testovi robno** (kalkulacija/uvoz/costing/nivelacija = 0 testova, finansijski osetljivo) |
| 27 | Saldakonti ⊕ | M | **Kompenzacija FE** — backend pun (`compensation.service`), 0 dugmadi na FE |
| 28 | Bankovni izvodi ⊕ | M | **Dovršiti knjiženje kompenzacije** (`postCompensation` TODO, ostaje DRAFT) |
| 29 | Saldakonti | M | **„Upari" mrtvo dugme** — izvedeni pogled ne vraća `ledgerEntry` id-eve; reconcile grana nedostupna |
| 30 | Saldakonti / Izvodi ⊕ | L | **Izvoz virmana pain.001 (ISO 20022)** — ostao samo FX TXT; e-banking traži XML |
| 31 | Bankovni izvodi | M | **Parsiranje poziva na broj** (`FX_OdrediBrojDokumenta`) + normalizacija TR — auto-match promašuje |
| 32 | Bankovni izvodi | M | **Ručno per-stavka uparivanje** („Poveži po BrDok" fallback) |
| 33 | Bankovni izvodi | L | **Devizni izvod + `ExchangeRate`/`KursnaLista` model** — deljeni FX servis (banka/izvod/fakture) |
| 34 | Priprema plaćanja | S | **Export guard „samo potpisani" + export→PAID** (danas šalje bilo koji nalog) |
| 35 | Priprema plaćanja | S | **Pozvati `DobarTR` (validacija TR)** + guard poziva na broj (funkcija postoji, nigde pozvana) |
| 36 | PDV | L | **Štampa PP-PDV obrasca + KIF/KUF/POPDV specifikacije** (0 reporta; regulatorni bloker) |
| 37 | PDV | M | **Poreske stope/tarife CRUD + datumski resolver** (`baseRate` Float→Decimal) |
| 38 | PDV | L | **KEPU FE + punjenje + numeracija** rbr=(N\45)+1 |
| 39 | PDV | M | **Period-lock PDV-a** — predat PP-PDV se tiho pregazi novim buildom |
| 40 | PDV | M | **Ručni unos/edit KIF/KUF stavki** (source manual vs gl-derived) |
| 41 | Fakturisanje | S | **UBL `BrojNarudžbenice` (PO broj)** — SEF odbija javni sektor bez njega |
| 42 | Fakturisanje | XL | **SEF ulazne fakture** (accept/reject u roku 15 dana) — zakonski rizik; cela dobavljačka strana |
| 43 | Fakturisanje | M | **Zaključavanje proknjiženog dokumenta** (nema tehničke brave) — cross-domenski (doc 29) |
| 44 | Fakturisanje | L | **Auto-robno GL knjiženje** (šeme 33/36) — danas samo preuzima postojeći nalog |
| 45 | Fakturisanje | S | **PDF prilog uz SEF fakturu** (builder podržava, enqueue ne puni) |
| 46 | Glavna knjiga | M | **Storno nalog** — niko ne piše `reversesEntryId`; nema ispravke zaključanih naloga |
| 47 | Glavna knjiga | L | **Blagajna (gotovinski dnevnik)** ⊕ — ceo pod-modul fali (deljeno sa saldakonti) |
| 48 | Saldakonti ⊕ | XL | **Obračun zatezne kamate** (kamatni list) — pravni preduslov za utuženje; najveći paritet-gap |
| 49 | Saldakonti | L | **IOS/NIOS obrazac usaglašavanja** (PDF) — zakonska godišnja obaveza |
| 50 | Završni | S | **Finalize/predaja akcija** — `FINALIZED` se nikad ne postavlja; obračun se tiho pregazi |
| 51 | Završni | M | **7-iteraciona konvergencija A-referenci** — forward-ref daje 0 → pogrešan bilans |
| 52 | Završni | L | **Iznos_2/Iznos_3 kolone** (PG/PS) — XML nevalidan bez višekolonskih AOP |
| 53 | Završni | L | **Kontrolna pravila (aktiva=pasiva)** + Boolean motor — APR odbija neuravnotežen obračun |
| 54 | Završni | M | **Zaglavlje firme** (PIB/matični/veličina/svojina/zaposleni/kodeksi) — XML nepotpun |

> **Napomena za Nesa/Negovana (POTVRDITI pre L/XL investicije):** Blagajna (#47) i Obračun kamate
> (#48) su XL a nose oznaku „potvrditi da li se realno koristi" u auditu. Ako Servoteh ne vodi
> gotovinu / ne obračunava zateznu kamatu, oba padaju iz Talasa 1 u opcioni backlog.

---

### 🟡 TALAS 2 — Paritet-ostatak (SREDNJI + NIZAK)

Paritet-rupe sa zaobilaznicom. Sortirano po modulu; effort u zagradi.

**Nabavka:** zaključavanje PO `ZakOtkDok` (M) · konfigurabilan šifarnik statusa + reject/odustali
(M) · auto-punjenje iz MRP/BOM (L) · valuta+kurs `exchangeRate` na PO (S) · proizvođačka šifra na
stavci (N).

**Robno:** carry-over/prepisivanje dokumenata (PO→Primka, Profaktura→Izdatnica) (L) · kartica
artikla sa running saldom (M) · eksplicitno zaključavanje robnih dokumenata + auto po periodu (S) ·
`averageAsOf` uvezati u izlaz/lager/karticu (S).

**Glavna knjiga:** salda po poslovima (`costCenter` se ne puni) (M) · prepisivanje/carry-over
naloga + početno stanje (M) · reconciliation pregled neproknjiženih + batch (M) · efektivno-datumska
PDV stopa `R_Tarife` (M) · IOS/NIOS obrazac (M, ⊕ sa saldakonti #49) · auto-lock starijih naloga (S) ·
štampa naloga za knjiženje PDF (S).

**Saldakonti:** izbor komitenta — reusable picker (M) · salda i promet po komitentima / SPEC / ZTST
(L) · devizne otvorene stavke (L) · kartica komitenta sa picker/drill/štampom (M) · auto-zatvaranje
sitnih salda `MaxSaldo` (M) · grid alati XLS/desni-klik/drill (M).

**Bankovni izvodi:** reset/brisanje uvezenog izvoda (S) · skok na karticu komitenta iz izvoda (S) ·
kontrola prometa/salda banke na formi (M) · zaključavanje virmana ruta/masovno/periodsko (M) ·
validacije pripreme (46*→putni, PNB guard) (M) · Halcom grana + naziv/mesto primaoca u FX slogu (M) ·
INO uplatni računi SWIFT + CRUD (M) · avansne uplate na porudžbine (L) · obračun kamate ⊕ (L).

**Priprema plaćanja:** zaključavanje naloga ruta + role-gate + period (M) · persist
`PNBOdobModel`+`SifraPlacanja`+naziv primaoca u export slogu (S) · Halcom/MULTI e-bank + auto-detekcija
(M) · ručni pojedinačni nalog `UnosVirmana` (M) · grupisanje po dokumentu vs zbirno po komitentu (S) ·
obračun kamata ⊕ (L) · odloženo plaćanje weighted-due (M) · štampa virmana + prečice (S).

**PDV:** PDV stavke naloga (dvosmerni bruto↔neto most) (M) · APGK rekonsilijacija GL↔PDV `PDVProvera`
(L) · POPDV legacy VBA formule (tiho 0) mapirati (L) · KUF „van PDV" tok (S) · avansni računi AVR (XL,
verovatno u fakturisanje/saldakonti domenu).

**Fakturisanje:** rezervacija zaliha na predračunu (L) · kurs na FX fakturama (M) · KarticaProfaktura
+ bogatiji filteri (M) · SEF storno kao zaseban tok + obavezan razlog (S) · UBL PDV granularnost
(10%/8%/AE) + CreditNote/knjižno odobrenje (M).

**Završni:** katalog formula UI (Modla forma) (M) · selekcija AOP po veličini firme (M) · SI
statistički aneks formule (M) · štampani obrasci PDF BS/BU/SI (L) · snapshot bruto + ZaokruženoNa1000
(M).

---

### 🟢 TALAS 3 — Može-više (Pantheon/SAP poboljšanja, po vrednosti)

`PANTHEON_SAP_BOLJE`. Grupisano po tipu vrednosti; radi tek kad Talas 1 stoji.

**A) Deljena infra — jednom uraditi, svuda iskoristiti (najviši ROI):**
- **Soft-delete + Undo toast + audit** na stavkama svih dokumenata (nabavka/robno/GK/izvodi/fakture/PDV)
  — doc 36 §2 / doc 29; jedan generički obrazac, primeni širom. (M jednom)
- **Resend attachments (PDF na mail)** — infra postoji, fali `attachments` u `MailService`; otključava
  „Pošalji na mail" za fakturu/PO/IOS/nalog/PP-PDV/kompenzaciju. (S, ~1-2 AI-dana; doc 36 §3)
- **Terminologija Pantheon/SAP** (doc 38) — UI nazivi Primka/Izdatnica/Temeljnica/Nalog za
  plaćanje/Bruto bilans; kod ostaje engleski. Čist labeling sloj, nula backend rizika. (S po modulu)
- **Grid kontekst-meni** (Export XLS / filter po vrednosti / mail / drill) — platformski DataTable
  dodatak, kros-domenski. (M jednom)

**B) Finansijska kontrola (SAP-standard, iznad BigBita):**
- **3-way match blokada plaćanja** (naručeno=primljeno=fakturisano, tolerancija) — zavisi od Faze 5. (L)
- **Kreditni limit + blokada komitenta** na osnovu salda (SAP credit mgmt). (M)
- **Automatske opomene / dunning** (nivoi, mail, kamata) — zamenjuje BigBit SMS. (M)
- **Payment Run / F110-stil** (proposal→review→execute, segregacija dužnosti, audit). (M-L)
- **EBS auto-match uplata** (fuzzy po pozivu na broj, % sigurnosti, FIFO delimično). (L)
- **Dimenzije knjiženja** (cost/profit center, projekat) kao prava GL dimenzija — SAP CO. (L)
- **Zatvaranje OS sa tolerancijom `MaxSaldo` / SAP F-32**. (M)

**C) Robno/nabavka poboljšanja:**
- **Cenovnik dobavljača (info record, auto-cena)** + kartica cena po artiklu/dobavljaču. (L)
- **Prevrednovanje kao prvorazredni dokument** (SAP MR21/MR22) + istorija cena. (M)
- **Delivery monitor** (rok isporuke, kašnjenja, SAP ME2M). (M)
- **Uvozni ZT po vrsti troška** (carina po carinskoj osnovici, ne samo po vrednosti). (M)
- **Avansni račun / down-payment** (nabavka i fakturisanje, SAP F-47/F-48). (L)
- **„Prevod za carinu"** kao eksplicitna akcija (ne skriveni gest). (M)

**D) Analitika / UX:**
- **Dashboard naplate** (DSO, aging heatmapa, top dužnici). (M)
- **Interaktivni validator formule** završnog (dry-run + drill do ledgera). (M)
- **Više-godišnja komparativa AOP** (trend, GK je jedinstvena baza). (M)
- **Istorija SEF statusa** (document flow timeline). (S)
- **camt.053/pain.001 kao dodatni bank format** (kad banka ponudi XML kanal). (L)
- **Uvoz/carina razdvajanje u KUF/POPDV** (pretporez pri uvozu). (M)

---

## 4. Preporuka redosleda

**Vodeći princip:** backend jezgro je zrelo — **najveći paritet-dobitak je jeftin FE wiring i
štampe.** Krenuti od poznatih „mrtvih kodova" i regulatornih blokera, ne od novih XL modula.

**Korak 0 — deljena infra pre svega (otključava desetine stavki jeftino):**
1. `MailService` attachments (Resend) — jedan S task, koristi ga fakturisanje/nabavka/saldakonti/PDV.
2. Generički soft-delete/undo/audit obrazac — jedan M task, primeni širom (doc 36 §2 / doc 29).
3. Reusable `CustomerPicker` — koristi ga saldakonti/GK/izvodi/plaćanja/fakturisanje.

**Korak 1 — „mrtvi FE" blokeri (najbolji odnos vrednost/trošak, mahom S):**
Prati redosled iz Talasa 1A. **Počni ručnim unosom/korekcijom stavke izvoda (#1)** — to je poznati
blocker i tipičan primer: bez njega svaki nestandardan izvod pada. Zatim pregled+potpis virmana
(#2, #3), pa nabavka „Novi zahtev"+prijem (#4, #5, #17), pa robno create-forma (#7). Svaki otključava
lanac koji trenutno „visi u vazduhu".

**Korak 2 — GK kičma (bez nje su izveštaji prazni):**
Auto-nalozi draft→posted→locked (#9) — dok se ovo ne reši, cela glavna knjiga je za korisnika
prazna iako se knjiži. Odmah zatim kontni plan (#10) i ručni nalog (#11).

**Korak 3 — regulatorni blokeri (da 4.0 sme na predaju):**
Seed `vat_account_map` (#14, S — trivijalno a koren PDV-a), PP-PDV štampa (#36), APR XML dugme (#15)
+ import pravih ZR formula (#16), SEF ulazne fakture rok-15-dana (#42, XL — započeti rano jer je velik).

**Korak 4 — kreiranje PO i robni tok (najveći „NE" blok u auditu):**
PO create (#6) → status-prelazi (#5) → prijem FE (#17) → lager lista (#8) → negativno stanje (#21).
Ovo je najveći pojedinačni blok posla ali ga vodi jasan lanac zavisnosti.

**Korak 5 — potvrde sa korisnikom pre XL ulaganja:**
Pre Blagajne (#47) i Obračuna kamate (#48) — **eksplicitno potvrditi sa Nesom/Negovanom** da se
realno koriste. Oba su XL i audit ih uslovljava potvrdom scope-a.

**Korak 6 — Talas 2, pa Talas 3** po prioritetu iznad, tek kad paritet stoji i 4.0 može da zameni
BigBit u produkciji.

**Kritični put do „minimum sav BigBit":** Korak 0 → 1 → 2 → 3 (regulatorno) → 4 (robno/nabavka).
Tek posle toga sistem realno zamenjuje BigBit; Koraci 5-6 su dovršetak i nadogradnja.
