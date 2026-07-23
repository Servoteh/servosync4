# 42 — FAZA N Cutover: paralelni rad, gašenje BigBit/MSSQL, rollback (RUNBOOK)

> **Status:** NACRT (2026-07-19). Dizajn ove faze pretpostavlja da su Trake A (finansije: GL→robno→
> saldakonti→fakturisanje→PDV→ZR) i B (komercijala) isporučene i da Kapija 0 odluke NE1–NE4/K1–K3 zatvorene.
> Ovaj dokument je RUNBOOK za **komercijalni/finansijski BigBit** (fakturisanje, GL, PDV, saldakonti) —
> NIJE isti cutover kao [17-cutover-runbook.md](17-cutover-runbook.md) (koji gasi QBigTehn PDM→RN→TP lanac).
> Dva cutover-a su nezavisna; ovaj se izvodi POSLE što 4.0 ima ceo komercijalni ciklus.
>
> Izvori: [17-cutover-runbook.md](17-cutover-runbook.md) (obrazac freeze→final-sync→verify→flip→smoke),
> [12-bigbit-uputstvo-master.md](12-bigbit-uputstvo-master.md) (mesečni ciklus = validacioni scenario),
> [41-konsolidacija-baze-dedup-polja.md](41-konsolidacija-baze-dedup-polja.md) (dual-writer sudar na `items`),
> [BB_T_26-analiza-F2-mehanizam-sync.md](BB_T_26-analiza-F2-mehanizam-sync.md) (tri sync-a A/B/C, allow/deny),
> [../../../docs/ANALIZA_PROCENA_4.0_AGENTI_2026-07.md](../../../docs/ANALIZA_PROCENA_4.0_AGENTI_2026-07.md)
> (knjigovođa gejt), [../../../docs/PLAN_GRADNJE_4.0_FAZNI.md](../../../docs/PLAN_GRADNJE_4.0_FAZNI.md) (faze/Kapija 0).

---

## 0. Model tri sync-a i šta se gde gasi (pojmovnik pre svega)

Iz doc F2 — postoje TRI sync kanala, i cutover ih gasi različitim redosledom:

| Sync | Šta je | Izvor | Sudbina na cutover-u |
|---|---|---|---|
| **A — QBigTehn** | `mssql.client.ts` čita QBigTehn MSSQL kopiju (`vasa-SQL`, `192.168.64.25`) „na dugme"; drži `items`/`customers`/`projects`/`price_list_entries` danas | MSSQL kopija | **Gasi se PRVO** (`QBIGTEHN_CHAIN_ENTITIES` ispada iz mape) |
| **B — BigBit** | `bigbit-bridge` (`mdb-tools`/ACE OLEDB → PG UPSERT). Danas aktivne samo 4 tabele; Faza 2 (Komitenti/Predmeti/R_Artikli/Cenovnik) **napisana ali DEAKTIVIRANA** | direktan BigBit `.mdb` | **Preuzima matične PRE gašenja A**, pa se i sam gasi kad 4.0 postane vlasnik |
| **C — PDM** | direktan SQL na Servoteh međusloj, BOM izvor istine | Servoteh SQL | **TRAJAN — ne gasi se** (`mssql.client.ts` preživljava A) |

**Ključni preduslov (dual-writer, doc 41 §C4/NE1):** dok Sync A radi, `bigbit-bridge` nad `items` sme
SAMO UPDATE — INSERT bi se sudario sa QBigTehn IDENTITY prostorom (57.998 BigBit šifri = lokalni `id`
DRUGOG artikla). Zato je redosled u §2 NEPREGOVARAN: **B preuzme INSERT za matične tek POSLE što A umre.**

---

## 1. FAZA P — Paralelni rad (≥ 1 pun PDV period; acceptance gejt)

**Cilj:** 4.0 i BigBit rade UPOREDO ceo mesec; knjigovođa (Nesa/konsultant) poredi regulatorne izlaze
do dinara. Bez zelenog svetla knjigovođe NEMA go-live (rizik br. 1 iz procene = validacija, ne kod).

### 1.1 Setup paralelnog rada
- [ ] 4.0 u produkciji, svi moduli Trake A+B živi, feature flag-ovi (§3) u **SHADOW** modu (4.0 računa,
      ali BigBit ostaje izvor istine za korisnike/SEF/knjiženje).
- [ ] Migracija početnog stanja (PS) u 4.0 URAĐENA (§1.4) — bez PS-a poređenje saldakonta je besmisleno.
- [ ] Isti mesec se **duplo unosi**: operativa i dalje kuca u BigBit (izvor istine), a 4.0 se puni
      paralelno (bilo dual-unos, bilo carry-over iz istih izvornih dokumenata — odluka po modulu).
- [ ] SEF ostaje vezan na BigBit (4.0 NE šalje na produkcioni SEF u fazi P; koristi SEF **demo** za dry-run).

### 1.2 Acceptance gejt — knjigovođa poredi do dinara (izvedeno iz doc 12 mesečnog ciklusa)

Ceo mesečni ciklus iz [doc 12 PROCES 17–20](12-bigbit-uputstvo-master.md) postaje test-matrica. Za pun
PDV period 4.0 mora dati identičan broj kao BigBit na svakom od:

| # | Kontrolna tačka (doc 12) | 4.0 mora = BigBit | Tolerancija |
|---|---|---|---|
| G1 | **PDV obaveza** `47 − 27 − 2790` (PROCES 20) | do dinara | 0 |
| G2 | **POPDV obrazac** svih 22 sekcije (POPDV_DEF) | do dinara po polju | 0 |
| G3 | **Bruto bilans** (PROCES 17) — sva konta | do dinara | 0 |
| G4 | **Saldakonti**: kartica analitike 2040/2050/4350/4360/avansi (PROCES 17) | do dinara po komitentu | 0 |
| G5 | **Slaganje SEF↔BB** (PROCES 19 VIII) — izlazni PDV konto 47 = SEF | do dinara | 0 |
| G6 | **Robno↔finansijski** (PROCES 18) — klase 1320/1010 GK = lager lista; RuC=0 | do dinara | 0 |
| G7 | **KEPU** (veleprodaja) — slaže se sa robnim | do dinara | 0 |
| G8 | **Fakture** — svaki broj iz „crvene sveske" (KIF) postoji u 4.0 sa istim iznosom | 1:1 | 0 |

**Verifikacioni alat:** `backend/tools/cutover-verify-fin/` (paralela postojećem
`tools/cutover-verify/`) — skripta koja povuče iste izveštaje iz 4.0 i iz BigBit snapshota i emituje
diff po tački G1–G8; **exit 0 = paritet.** Odstupanje se rešava PRE go-live, ne posle.

- [ ] G1–G8 svi `exit 0` za ceo PDV period.
- [ ] **Knjigovođa potpiše GO** (email/dokument) — ovo je formalni acceptance, ne tehnički exit code.
- [ ] Ako iole promašuje: produžiti paralelni rad još jedan pun period (ne skraćivati gejt).

### 1.3 Zašto ≥ 1 PUN period, ne „par dana"
PDV/POPDV/bilans/saldakonti su **mesečni agregati** — greška u kontiranju jedne vrste dokumenta se
vidi tek na kraju meseca na kontu 47/27. Kraći period ne pokriva sve vrste dokumenata (IFR/IFGP/IFUSL/
UFROB/UFMAT/UVOZ/TROS/BPDV/AVR/IZVOD) niti mesečne ručne naloge (TROS/BPDV = jedan nalog/mesec).

### 1.4 Migracija početnog stanja (PS) — preduslov paralelnog rada
Iz [doc 12 PROCES 1](12-bigbit-uputstvo-master.md) (otvaranje poslovne godine) — šta se prenosi u 4.0:
- Otvorene stavke saldakonta: 2040/2050 (kupci), 4350/4360 (dobavljači), avansi 4300/4302/1500/1520/1521/1530.
- Otvoreni dokumenti: PROFAKTURE (PON/PROF/OTP/REZR/REZM), USLUGE (PON/IFUSL/AVR), Narudžbine, PREDMETI.
- **Koliko godina istorije (NE3):** odluka Nenad — predlog: PS + tekuća godina prometa; istorija >1g
      ostaje read-only u `bigbit_raw` staging-u (NE2), ne u aplikativnim modelima.
- Uvoz istorije GL/PDV/carina (ako NE2=da): jednokratni `bigbit_raw` schema (doc 41 §D-ii), `mdb-export`
      1:1, nijedan FK ne gleda u njega, briše se posle migracije.

---

## 2. FAZA G — Redosled gašenja (NEPREGOVARAN zbog dual-writer sudara)

> Redosled je iz doc 41 §C4 + F2.1: **B preuzima INSERT za matične TEK POSLE što A umre.** Obrnuti
> redosled = IDENTITY sudar na `items`.

### Korak G0 — Freeze (van radnog vremena, dan go-live)
1. [ ] Obavestiti operativu/knjigovodstvo: od T0 se u BigBit više NE unosi komercija/GL/PDV.
2. [ ] Revoke write na BigBit za operativne naloge (ili ukloniti ikone) — BigBit postaje read-only.
3. [ ] Sačekati poslednji ciklus legacy 10-min skripti (BigBit→MSSQL kopija) — proveriti da je MSSQL
       kopija u koraku sa BigBit-om (watermark `PoslednjaIzmena` poravnat).

### Korak G1 — Poslednji Sync A (QBigTehn) + verifikacija
4. [ ] Finalni `POST /sync/run` iz MSSQL kopije (force/full) za `QBIGTEHN_CHAIN_ENTITIES` + matične.
5. [ ] `node tools/cutover-verify/cutover-verify.mjs` — COUNT/MAX(id) paritet, **exit 0 obavezan**.
6. [ ] `setval` poravnanje sekvenci (`alignIdSequence`) za sve matične tabele.

### Korak G2 — Gašenje Sync A (MSSQL) — matične ostaju „zamrznute"
7. [ ] Iz `sync-map.generated.ts` ispadaju `QBIGTEHN_CHAIN_ENTITIES` (izbacivanje = ne-registracija,
       ne runtime flag — doc F2.2). Deploy backenda.
8. [ ] **`items`/`customers`/`projects`/`price_list_entries` su od sada BEZ pisca** — QBigTehn IDENTITY
       prostor postaje trajni 2.0 prostor (doc 41 §D-i). Ovo mora prethoditi G3.

### Korak G3 — Aktivacija Sync B (bigbit-bridge) kao izvor matičnih
9. [ ] Uključiti Fazu 2 bridge tabela (Komitenti/Predmeti/R_Artikli/Cenovnik) iz DEAKTIVIRANOG stanja.
10. [ ] **Sada je INSERT dozvoljen** (A mrtav, nema IDENTITY sudara): `bigbit-bridge` nad `items` prelazi
        sa UPDATE-only na **INSERT+UPDATE** po prirodnom ključu (`BBSifra artikla` → `external_item_id`).
11. [ ] Pre-flight `validate-contract` (doc F2.6) nad prvim pravim BigBit exportom — hvata šema-drift
        (npr. `BBOdeljenja(OD,Naziv)` vs mapa) za stolom, ne u prvoj noćnoj sinhronizaciji.
12. [ ] Prva puna sinhronizacija preko bridge-a; `bb_sync_log.metadata.driftReport` čist.

### Korak G4 — Gašenje BigBit-a kao operativnog sistema
13. [ ] Po modulu, feature flag-ovi (§3) sa SHADOW → **LIVE** (4.0 postaje izvor istine za taj modul).
14. [ ] SEF se prevezuje: 4.0 šalje na **produkcioni** SEF (throttle 3/s, kategorije S20/Z, avans→0).
15. [ ] Kad su svi moduli LIVE i knjigovođa potvrdio prvi LIVE mesečni ciklus: **BigBit u read-only arhivu**
        (`.mdb` snapshot sačuvan; bridge Sync B se gasi jer je 4.0 sada vlasnik i matičnih).
16. [ ] Sync C (PDM) OSTAJE — `mssql.client.ts` ne umire.

> **Napomena о „gašenju BigBit-a":** BigBit se ne briše. Postaje trajni read-only arhiv (istorija,
> forenzika, poređenje). „Gašenje" = prestanak unosa + prekid Sync B + arhiviranje `.mdb`.

---

## 3. Feature flag-ovi po modulu (postepen prelaz, ne big-bang)

Prelaz ide **modul po modul**, ne odjednom. Svaki flag ima 3 stanja:

| Stanje | Značenje |
|---|---|
| `OFF` | 4.0 modul ne radi; BigBit jedini |
| `SHADOW` | 4.0 računa/piše paralelno; BigBit i dalje izvor istine (faza P) |
| `LIVE` | 4.0 izvor istine; BigBit read-only za taj domen |

**Predloženi flag-ovi (env, red u `.env.example` po pravilu 10):**

| Flag | Modul | Zavisnost (ne sme LIVE pre) |
|---|---|---|
| `CUTOVER_INVOICING` | fakturisanje (IFR/IFGP/IFUSL/AVR) + SEF | `CUTOVER_GL` (kontiranje), robno |
| `CUTOVER_GL` | Glavna knjiga (nalozi, kontiranje, bruto bilans) | robno (klase 1320/1010), Faza 2 |
| `CUTOVER_PDV` | PDV/POPDV/KEPU | `CUTOVER_GL` + `CUTOVER_INVOICING` (KIF/KUF izvor) |
| `CUTOVER_SALDAKONTI` | saldakonti/IOS + priprema plaćanja | `CUTOVER_GL` (otvorene stavke iz GK) |
| `CUTOVER_PROCUREMENT` | nabavka/ulazne fakture | matične (Sync B) |

**Redosled paljenja LIVE:** GL → robno je preduslov (u GL flag-u) → INVOICING → SALDAKONTI →
PROCUREMENT → PDV (poslednji, jer agregira sve). PDV LIVE tek kad je pun mesec svih ostalih čist.

**Implementacija:** flag se čita u posting/SEF/izveštaj servisima; u SHADOW modu 4.0 piše u svoje
tabele ali ne emituje ka SEF-u i ne tretira se kao regulatorni izvor. Guard po obrascu postojećih
env flag-ova (bez nove zavisnosti).

---

## 4. Rollback plan

**Princip: paralelni rad JE rollback osiguranje.** Dok BigBit prima unos (faza P) ili je sveže
arhiviran (rane LIVE nedelje), povratak je moguć bez gubitka.

| Tačka u vremenu | Rollback = | Gubitak |
|---|---|---|
| Faza P (SHADOW) | ništa — BigBit je i dalje izvor istine; 4.0 podaci se odbace | 0 |
| Posle G2 (A ugašen), pre G4 LIVE | vratiti `QBIGTEHN_CHAIN_ENTITIES` u mapu, re-deploy, nastaviti unos u BigBit | 0 (matične zamrznute, ne izmenjene) |
| Posle G4 pojedinog modula LIVE | flag tog modula LIVE→SHADOW; ručno preneti u BigBit dokumente unete u 4.0 od LIVE trenutka | ručni re-entry dokumenata iz LIVE prozora |
| Posle punog LIVE meseca + knjigovođa GO | nema planiranog rollback-a; BigBit arhiv služi samo za forenziku | — |

**Zato:** (a) LIVE se pali modul-po-modul da rollback prozor bude uzak; (b) prvi LIVE mesec i dalje
čuva BigBit kao „topli" arhiv (moguć re-import PS-a nazad); (c) SEF produkciono slanje (G4 korak 14)
je **tačka bez lakog povratka** — pušta se TEK kad su svi ne-SEF moduli potvrđeni LIVE.

**Rollback okidači (unapred definisani):**
- G1–G8 diff > 0 dinara u LIVE mesecu koji se ne reši za 48h → taj modul SHADOW.
- SEF odbijanje/status greška na produkciji > prag → INVOICING SHADOW, SEF nazad na BigBit.
- Šema-drift na Sync B obori matični entitet (validate-contract `failed`) → bridge stop, istraga.

---

## 5. Checklist otvorenih odluka Kapije 0 koje MORAJU biti zatvorene PRE cutover-a

Iz [PLAN_GRADNJE_4.0_FAZNI.md Kapija 0](../../../docs/PLAN_GRADNJE_4.0_FAZNI.md):

| Odluka | Vlasnik | Zašto blokira cutover | Stanje |
|---|---|---|---|
| **NE1** — cutover timing MSSQL→BigBit direktno (dual-writer) | Nenad | definiše redosled §2 (G2 pre G3) | ⬜ |
| **NE3** — koliko godina istorije migrirati | Nenad | određuje obim PS-a §1.4 | ⬜ |
| **NE4** — period paralelnog rada (≥1 PDV period) | Nenad | definiše dužinu faze P §1 | ⬜ |
| **NE2** — graditi li `bigbit_raw` staging za GL/PDV/carina | Nenad | put migracije istorije §1.4 | ⬜ |
| **K1** — validacija POPDV/KEPU/GL/bilansi paralelno | Nesa/knjigovođa | ceo acceptance gejt §1.2 | ⬜ |
| **K2** — potvrda kontnog plana + šema za kontiranje | Nesa | tačnost G2/G3 kontiranja | ⬜ |
| **K3** — OS pozicije u ZR (knjigovođa daje brojeve) | Nesa | završni račun paritet | ⬜ |
| **N1** — magacin ID→tip | Negovan | robno G6/G7 ispravno | ⬜ |
| **N6** — BB ULS read-kredencijal (nalog `Slavisa`) | Negovan | Sync B aktivacija §2 G3 | ⬜ |
| **T1** — landed-cost ključ raspodele | Tatjana | uvoz kalkulacija = G6 | ⬜ |

**Pravilo:** cutover se NE zakazuje dok sve gornje nisu ✅. Ovo je „go/no-go" tabela za go-live sastanak.

---

## 6. Redosled na go-live dan (sažetak, izvod iz §1–§2)

1. Faza P završena, G1–G8 exit 0, **knjigovođa potpisao GO**, Kapija 0 tabela sva ✅.
2. G0 Freeze BigBit (van radnog vremena).
3. G1 Poslednji Sync A + `cutover-verify` exit 0 + `setval`.
4. G2 Gašenje Sync A (matične zamrznute) + deploy.
5. G3 Aktivacija Sync B (bridge INSERT+UPDATE) + validate-contract čist.
6. G4 Flag-ovi SHADOW→LIVE po redosledu GL→INVOICING→SALDAKONTI→PROCUREMENT→PDV; SEF na produkciju.
7. Smoke test: pun tok jedne fakture (predračun→IFR→kontiranje→SEF→saldakonti) + jedan ručni GL nalog.
8. Prva LIVE nedelja: dnevni G1–G8 spot-check; BigBit „topli" arhiv (rollback moguć).
9. Prvi pun LIVE mesečni ciklus = BigBit → knjigovođa GO → Sync B stop → BigBit u hladni arhiv.

---

## 7. Fajlovi (postojeći + predloženi novi)

**Postojeći (referenca/obrazac):**
- `backend/src/modules/sync/` — `SyncService`, `sync-map.generated.ts`, `table-ownership.ts`
  (`QBIGTEHN_CHAIN_ENTITIES`, `OWNED_PRODUCTION_TABLES`), `mssql.client.ts` (Sync A+C).
- `backend/tools/cutover-verify/cutover-verify.mjs` — paritet za QBigTehn lanac (obrazac).

**Predloženi novi (ova faza):**
- `backend/src/modules/sync/bigbit-allowlist.ts` — `BIGBIT_SYNC_ALLOWED_SOURCES` / `BIGBIT_HARD_EXCLUDED_SOURCES` (doc F2.2).
- `backend/tools/cutover-verify-fin/` — G1–G8 diff 4.0↔BigBit (PDV/POPDV/bilans/saldakonti/SEF/KEPU/RuC).
- `backend/src/modules/*/cutover.flags.ts` (ili centralno) — `CUTOVER_*` SHADOW/LIVE guard.
- `.env.example` — redovi za `CUTOVER_INVOICING/GL/PDV/SALDAKONTI/PROCUREMENT`.
- (ako NE2=da) jednokratni `bigbit_raw` staging schema + `mdb-export` skripta (briše se posle migracije).
