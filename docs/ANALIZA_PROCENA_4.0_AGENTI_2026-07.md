# Procena: „naša verzija ServoSync ERP-a" sa Claude agentima (Fable plan / Opus izvršenje)

> **Datum:** 2026-07-18 (rev. 2 — isto veče). **Pitanje:** za koliko bismo, radnim modelom
> Fable-planira / Opus-izvodi (multi-agent), izgradili sopstveno ERP jezgro — profakture/fakture,
> artikli, narudžbine, štampa — odnosno ceo 4.0 gap. **Metod:** izmereno trenutno stanje repoa +
> gap iz migracionih analiza + stvarna istorijska brzina iz git-a. Ništa nije procenjeno „iz stomaka".
>
> **Rev. 2 (18.07 uveče) — dve krupne promene u odnosu na prvu verziju:**
> 1. **Korak 0 je najvećim delom URAĐEN** — imenovani upiti (`PDV_Uknjizi*`, `PDV_Obracun_*`, KEPU/TK)
>    izvučeni iz `OnLine_BigBit_APL.MDB`; POPDV engine potvrđen kao deklarativni (`POPDV_DEF`) u
>    `BigBit_APL_2010.MDB` → **port umesto gradnje od nule**. Vidi
>    [18-gl-pdv-kontiranje-rekonstrukcija.md](../backend/docs/migration/18-gl-pdv-kontiranje-rekonstrukcija.md).
> 2. **Scope sužen** — Nenad na screenshotu glavnog menija precrtao neupotrebljeno: **kursna
>    lista/devizno, komision (3 stavke + odjava dobavljaču), recepti za proizvodnju, nivelacija
>    zaliha, GK unakrsni izveštaji / kartoteke-štampa / prodavci-obračun**. Vidi
>    [BB_T_26_ANALIZA_I_PLAN.md §4](../backend/docs/migration/BB_T_26_ANALIZA_I_PLAN.md).
>
> **Rev. 3 (18.07 kasnije):**
> - **KEPU (veleprodajna) VRAĆENA u scope** — zakonski obavezna (Nenad); tok već ~90% rekonstruisan
>   u doc 18, pa je uticaj na procenu +1 dan. `KEPU_MP` ostaje van (maloprodaje nema).
> - **Knjigovođa kao konsultant** — Nenad angažuje knjigovođu za validaciju regulatornih izlaza
>   (POPDV, KEPU, GL); ponuda: besplatan operativni sistem uz 2-godišnju saradnju na projektu.
>   Ovo direktno adresira rizik br. 1 (validacija) iz §5.
> - **Štampani dokumenti — ✅ IZVUČENO (18.07 uveče):** svih **496/496** layouta iz
>   `OnLine_BigBit_APL.MDB` + 426/713 iz `APL_2010` (uklj. **sva 22 POPDV sekcijska**); katalog
>   meni→forma→report→upit u [migration doc 20](../backend/docs/migration/20-bigbit-stampani-dokumenti-katalog.md).
>   Samo ~303 od 496 je živo (SPECIJAL mehanizam: Servoteh koristi `- DEFAULT` varijante);
>   „Ponuda" = Profaktura; svaki 4.0 PDF šablon sada ima legacy layout kao spec.

## 1. Šta već imamo (izmereno 18.07)

| Metrika | Vrednost |
|---|---|
| Backend | 29 modula, ~66k LOC koda + ~22k LOC testova, 96 Prisma modela, 24 migracije |
| Frontend | 48 ruta, 324 `_components`, ~138k LOC |
| Ukupno kod (ts+tsx) | **~241k LOC** |
| Štampa/PDF | ✅ **postoji** — `documents` (pdf/barcode/logo), RN print (372 LOC), handover bundle (510 LOC), pdfmake/pdf-lib/jspdf |
| Artikli | 🟡 model + sync cache (92.357 art.) + MRP read; **nema CRUD/vlasništva** |
| Fakture/profakture | ❌ ne postoji ni stub |
| Narudžbine (nabavne/prodajne) | ❌ ne postoji (samo `broj_narudzbenice` tekst polje + `OrderType` lookup) |

Analitička podloga za 4.0 je **već plaćena**: BB_T_26 (207 tabela, pun DDL), VBA mapa (824
komponente), korisnička uputstva (nabavka, carina, knjigovodstvo), SEF reverse engineering,
i od 18.07 — **rekonstruisana GL/PDV logika** (doc 18) + inventar kontejnera (doc 19).
Sva tri nosioca legacy logike su na disku; ključni upiti su izvučeni.

## 2. Izmerena istorijska brzina (git, maj–jul 2026)

| Metrika | Vrednost |
|---|---|
| Ceo proizvod (241k LOC) izgrađen za | **~17 aktivnih dana** (burst 02–18.07) |
| Neto kod po aktivnom danu | **~15–20k LOC** |
| Ceo modul (backend+frontend+testovi) | **1–4 aktivna dana** (kadrovska 4d, plan-proizvodnje 1d, pracenje 1d, handovers 5d) |
| Vrhovi | 142 commita/dan (14.07), 127 (17.07) |

⚠️ Ograde na tempo: (a) deo julskog rada bio je **port** postojećih 1.0 modula sa referentnom
implementacijom — greenfield je sporiji po „jedinici razmišljanja"; (b) tempo je **burst**, ne
kalendar; (c) regulatorni kod (POPDV, SEF, GL) ima 3–4× veći trošak verifikacije od CRUD-a —
LOC/dan tu nije prava mera.

## 3. Procena po domenima (aktivni dani, Fable+Opus multi-agent) — rev. 2

Ulaz: gap = 103 tabele „ODLOŽI-4.0" **minus isključenja 18.07**; složenost iz
`09-bigbit-online-domain-map.md` §12; de-risk iz doc 18.

| # | Domen | Složenost | Rev. 1 | **Rev. 2** | Zašto promena |
|---|---|---|---:|---:|---|
| 0 | Korak 0 — ekstrakcija upita | — | 3–5 | **1–2** | ✅ urađeno 18.07; ostaje mehanički dump (`POPDV_DEF`, sadržaj šema, `NSK_*` tela) |
| 1 | Artikli — vlasništvo + šifarnici + CRUD | srednja | 2–3 | 2–3 | — |
| 2 | Sales/fakturisanje — profakture, fakture, rabati, cenovnik | Veliki/Visok | 6–10 | 6–10 | — |
| 3 | Procurement/narudžbine — RFQ→PO→prijem (3-way), trebovanja | srednja | 4–6 | 4–6 | — |
| 4 | Inventory/robno — kalkulacija, komadna, popis | Veliki/Visok | 6–10 | **5–8** | ⛔ bez nivelacije, komisiona, recepata |
| 5 | Finance/GL — nalozi, GK, šeme kontiranja, OS | Visok | 6–10 | **5–8** | posting engine rekonstruisan (evaluator A–Z + `Sema za kontiranje` = deklarativni port); ⛔ bez 3 precrtana izveštaja |
| 6 | PDV/POPDV/KEPU | visok rizik | 5–8 | **5–7** | KEPU vraćena (rev. 3) ali tok ~90% rekonstruisan → +1d; POPDV = port `POPDV_DEF`, ne od nule |
| 7 | SEF e-fakture — UBL/CIUS, outbox/inbox, demo env | srednje-visok | 4–6 | 4–6 | — |
| 8 | Banking — virmani, izvodi | srednje-visok | 3–5 | **2–4** | ⛔ bez kursne liste/deviznog |
| 9 | Customs/uvoz — landed cost, evidencija | srednja | 2–3 | 2–3 | — |
| 10 | Štampa dokumenata — faktura/PO/otpremnica šabloni | mala | 1–2 | 1–2 | infra postoji |
| 11 | Integracija, e2e, RBAC, top-30 izveštaja | — | 5–8 | 5–8 | — |
| | **UKUPNO ceo 4.0** | | 47–76 | **42–67** (rev. 3) | |

### 3a. Dubinske domenske procene (dokumentovani domeni) — VAŽNO o jedinicama

Docs 21/22 daju procene u **tradicionalnim 1-dev radnim danima**, dok tabela §3 gore je u
**AI-aktivnim danima** (julski burst: ceo modul = 1–4 dana, ~15–20k neto LOC/dan). Odnos je ~2–4×.
Ne sabirati ih naivno — evo prevoda:

| Domen | Doc | 1-dev radni dani | ≈ AI-aktivni dani | Napomena |
|---|---|---|---|---|
| Predmeti (CRUD+kartica, BEZ RFQ) | [22](../backend/docs/migration/22-predmeti-domen-rekonstrukcija.md) | 8–10 | **~3–4** | odgovara Nenadovoj tezi „modul za 10 dana" |
| Predmeti PUN (+ RFQ „Zahtevi za ponude" + faze) | [22](../backend/docs/migration/22-predmeti-domen-rekonstrukcija.md) | 16–22 | **~5–7** | RFQ je lead-in vrednost, ne izostaviti |
| Banking (izvod TXT + virmani + MOD97/11) | [21](../backend/docs/migration/21-banking-izvodi-nalozi-rekonstrukcija.md) | 22–36 | **~6–10** | export FX **već radi** → donji opseg; „auto-knjiženje izvoda" deli obim sa GL |

**Zaključak o „modul za 10 dana":** realno za pojedinačan, dobro-pripremljen domen (predmeti-CRUD,
štampa, artikli, čak i banking-export). NIJE realno za regulatorne domene sa validacijom (POPDV/GL)
ni za domen sa nedovršenom zavisnošću (banking auto-knjiženje bez zrelog GL-a). Priprema koju sad
radimo (rekonstrukcija + izvučeni formati/upiti) je upravo ono što obara po-domen procenu ka 10 dana.

### 3b. Nove MUST stavke iz sweep-a (doc 23) — nisu bile u §3 tabeli

Sweep kroz ceo BigBit (18.07) našao je računovodstveno obavezne domene koje ranija tabela nije
brojala eksplicitno:

| Nova MUST stavka | ≈ AI-aktivni dani |
|---|---|
| IOS + otvorene stavke (saldakonti) + auto-zatvaranje | 2–4 |
| Kompenzacija (multilateralno prebijanje) | 1–2 |
| Godišnji prelaz + početno stanje (PS/PSF) | 2–3 |
| Avansi-alokacija (+ ispravka legacy bug-a) | 1–2 |
| Pricing engine + 2-nivo rabat | 2–3 |
| **Zbir** | **+8–14** |

→ **Scenario B revidiran: ~50–81 AI-aktivnih dana** (bilo 42–67). Saldakonti (IOS/kompenzacija) i
godišnji prelaz su srž komercijalnog knjigovodstva — ne mogu se izostaviti.

**Scope odluke (Nenad, 18.07) i njihov uticaj:**

| Stavka | Odluka | ≈ AI-dani |
|---|---|---|
| Servisni radni nalozi (obračun+garancija) | ✅ MUST | +2–3 |
| Reversi (roba na revers) | ✅ u scope | +1–2 |
| Kalo / rastur / škart | ✅ u scope | +1–2 |
| Opomene / dunning (net-new) | ✅ gradi | +2–3 |
| Kampanjski pricing / promo (net-new) | ✅ gradi | +2–4 |
| Provizija prodavaca · OTKUP | ⛔ SKIP | 0 |

→ **+8–14 AI-dana** dodatno → **Scenario B ukupno ~58–95 AI-aktivnih dana** (≈ **4–7 kalendarskih
meseci** julskim burst-tempom, sa validacijom knjigovođe kao gejtom). Servis RN dodiruje 2.0
proizvodnju; reversi dodiruje postojeći 2.0 `reversi` domen (pažnja: homonim, druga semantika).

### 3c. Duboko rekonstruisani tokovi (docs 24–25) — spremni za spec

| Tok | Doc | Pokrivenost | MVP procena |
|---|---|---|---|
| **Nabavka** (zahtev→upit auto-mail→ponuda→PO→prijem→3-way match) | [24](../backend/docs/migration/24-nabavka-tok-iz-koda.md) | status-mašina + auto-mail (OSSMTP) + upiti izvučeni | ~16–23 AI-dana |
| **Priprema plaćanja / virmani** (dospelost→check-off→nalog→potpis→export) | [25](../backend/docs/migration/25-priprema-placanja-virmani-tok.md) | ceo tok + formule dospelosti izvučeni | ~8.5 AI-dana **+ GL/registar preduslov** |

**Zajednički preduslov za plaćanja/IOS/GL:** izvor **otvorenih stavki klase 4** (dospele obaveze).
Tri domena (GL doc 18, IOS doc 23 §1.3, priprema plaćanja doc 25) dele isti saldakonti temelj —
graditi ga **jednom, prvo**. **ODLUKA (Nenad 18.07): vučemo iz GK kao postojeći sistem → pun GL je
tvrd preduslov** (lakša opcija „registar obaveza" odbačena). Redosled: GL → saldakonti/IOS → plaćanja.

**Nabavka je najzreliji „sprint" kandidat:** auto-mail RFQ + status-tok su kompletni u kodu, i modul
ne zavisi od GL-a (za razliku od plaćanja). Dobra prva meta za tvoju tezu „modul za ~10 dana".

### 3d. Dva presečna (cross-cutting) nalaza koji NISU u po-domen brojkama

- **Prepisivanje dokumenata → 1 generički servis** ([27](../backend/docs/migration/27-prepisivanje-dokumenata-carry-over.md)):
  ~25 ad-hoc parova u BigBit-u; u 4.0 = jedan `DocumentCarryOverService` (~2–3 nedelje / ~1 AI-nedelja).
  **Gradi se JEDNOM, pa ga koriste svi dokument-tokovi** (profakture, nabavka, fakturisanje, popis…).
  Odbiti napast da se radi ad-hoc po modulu — to vraća BigBit haos.
- **Skriveni UI sloj** ([28](../backend/docs/migration/28-skriveni-ui-desni-klik-stampa-precice.md)):
  desni-klik grid akcije, dupli-klik (obriši filter / drill-through), štampa-varijante, lock-uslovna
  dugmad. Nije poseban „modul" nego **UX-standard koji svaki ekran mora poštovati**. Trošak je razuđen
  (few dana za grid-toolbar komponentu + print-varijanta dropdown, pa reuse svuda), ali **ako se
  izostavi, korisnici osete regres** iako je „sve tu". Uračunati u frontend svakog modula, ne zvati
  „gotovo" bez ovoga.
- **Audit + zaključavanje** ([29](../backend/docs/migration/29-audit-zakljucavanje-predlog-4.0.md)):
  2.0 već ima `AuditLog`+interceptor+identitet → **nadogradnja, ne greenfield**. Prisma extension za
  field-level old→new diff + auto-stamp (CLS) + soft-delete + jedinstven lifecycle (draft→posted→locked,
  server-side, logovano otključavanje). ~9–15 AI-dana, **presečna infra — radi se JEDNOM pre finansija**
  (GL/plaćanja/fakture ionako traže tvrd audit+lock). Nadmašuje BigBit (koji ima samo „poslednji potpis").

### 3e. Tri BigBit modula koja se stapaju u postojeći 2.0 (docs 32–34) — scope korekcija

Nenadova odluka: RAZNO→podešavanja, REVERSI→2.0, IZVEŠTAJI/SERVIS→2.0. Analiza da ništa ne promakne:

| Modul | Nalaz | Uticaj |
|---|---|---|
| **RAZNO** ([32](../backend/docs/migration/32-razno-u-podesavanja-map.md)) | većina šifarnika VEĆ postoji kao cache, fali samo admin UI; **Šeme za kontiranje + Kontni plan FALE i to su GL-preduslov** | ~11–12 AI-dana (uski šifarnici); +8–10 za GL-temelj (izdvojiti u finance-foundation) |
| **REVERSI** ([33](../backend/docs/migration/33-reversi-bigbit-vs-2.0-homonim.md)) | homonim: magacin-alata `reversi` netaknut; **komercijalni revers → 4.0 sales** kao `documentType='REV'` iz profakture — `GoodsDocument` već ima sva polja | Nenad: „jedan unapređen modul, iz profakture" ✅; ~2–3 AI-dana na sales build + migracija 135 reda |
| **IZVEŠTAJI/SERVIS** ([34](../backend/docs/migration/34-izvestaji-servis-bigbit-vs-2.0.md)) | servisni izveštaj **već nadmašen** 2.0 `montaza`; GK izveštaj+Analiza prodaje = 4.0 finance/sales | ~1–3d (multi-interval gap); BI deo ostaje u finansijskoj fazi |

**Neto:** ova tri „modula" nisu tri nova gradnje — dva su uglavnom pokrivena (RAZNO cache postoji, izveštaj
nadmašen), jedan je homonim (reversi). Realno scope-smanjenje, ALI RAZNO otkriva tvrde GL-preduslove
(Šeme za kontiranje + Kontni plan) koji moraju pre finansija.

## 4. Dva scenarija (rev. 2)

### Scenario A — komercijalno jezgro (ono što je Nenad naveo)
Artikli + narudžbine + profakture/fakture + štampa = redovi 1+2+3+10 ≈ **13–21 aktivnih dana**.

Faktura u Srbiji bez SEF-a nije upotrebljiva za B2B (obavezan od 2023), a bez PDV evidencije ne
zamenjuje BigBit ni za knjigovodstvo. Realni minimum-upotrebljiv paket = jezgro + SEF + PDV osnove
+ ostatak Koraka 0:

> **Scenario A realno: ~21–33 aktivnih dana ≈ 1,5–2 meseca** julskim tempom
> (uz burst kadencu ~15 akt. dana/mesec).

### Scenario B — ceo 4.0 (zamena BigBit-a)
41–67 aktivnih dana čistog razvoja →

> **Scenario B: ~3–4,5 kalendarska meseca** julskim tempom, realnije **4–6** jer:
> - regulatorni output (POPDV, bilansi) mora da validira **knjigovođa (Nesa)** ručno,
>   paralelnim vođenjem — agent to ne može da „samopotvrdi";
> - SEF demo→prod ciklus ima eksternu latencu (MFIN okruženje);
> - blokeri čekaju ljude: Negovan (BB READ kredencijal, magacin tipovi, RadniNalozi scope),
>   Tatjana (landed cost ključ), Nenad (izveštaji trijaža).

## 5. Šta procenu najviše ugrožava (redom, rev. 2)

1. ~~Korak 0~~ → **✅ ZATVOREN 18.07** (docs 18/21/23). Izvučeni: NSK posting engine, PDV/POPDV/KEPU
   upiti, banking action upiti, import specovi izvoda (FX/HALCOM/LHB kolone), i **formule kontiranja
   kao podatak** (DefDug/DefPot, R_Vrste dokumenata, kontni plan 1389). Posting engine se sad specira
   1:1 iz podataka. **`BB_POPDV_T.mdb` doneo Nenad 18.07 → `POPDV_DEF` (164 reda) izvučen, POPDV ~95%.**
   Korak 0 kompletan — nema više eksternih izvora. Više NIJE rizik br. 1.
2. **Validacija, ne pisanje koda** — sada rizik br. 1, ali **sa mitigacijom (rev. 3)**: Nenad
   angažuje knjigovođu-konsultanta (free operativni sistem uz 2-godišnju saradnju) za potvrdu
   POPDV/KEPU/GL izlaza. Plan i dalje uključuje paralelni rad BigBit + 4.0 bar jedan pun PDV period.
3. **Latenca odluka** — julski burst nije čekao nikoga; 4.0 ima otvorene tačke koje čekaju
   Negovana/Nesu/Tatjanu (`BB_T_26_ANALIZA_I_PLAN.md` §5, `ODLUKE.md`).
4. **Šema-drift** — 2.0 sinkuje QBigTehn kopiju, ne BigBit original; prelaz na direktan izvor
   (bigbit-bridge, 3.0 Blok B) je preduslov i još nije aktiviran.

## 6. Preporučeni redosled (ako se krene)

1. Zatvoriti 3.0 Blok B (bigbit-bridge aktivacija — ionako preduslov za direktan BB izvor).
2. Ostatak Koraka 0 (dump `POPDV_DEF` + sadržaj šema za kontiranje + `NSK_*` tela — 1–2 dana) +
   sakupiti preostale odluke od Negovana/Nese u JEDNOM sastanku.
3. Scenario A jezgro: artikli → procurement → sales/fakture → štampa (svaki modul: Fable
   spec/plan → Opus multi-agent implementacija → e2e — obrazac koji je već radio u julu).
4. SEF + PDV osnove → prva „prava" faktura kroz SEF demo.
5. Tek onda GL/POPDV/banking (Scenario B ostatak), sa paralelnim PDV periodom kao gejt.

---
*Izvori: merenja agenata 18.07.2026 nad repoom; `backend/docs/migration/*` (BB_T_26 serija, 09,
12–14, 16, **18, 19**); `backend/docs/ROADMAP.md`; git istorija `main` (646 commita,
04.05–18.07.2026); screenshot glavnog menija BigBit (Nenad, 18.07 — isključenja).*
