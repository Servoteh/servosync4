# PLAN: BOM rupa posle cutover-night stash/wipe/restore — reparacija + zaštite (2026-07-14)

> Autor analize: Fable (sesija 8ad9b138, 14.07). Izvršilac: Opus.
> Prioritet: **HITNO** — proizvodnja ne vidi poziciju u sklopu; ista klasa štete može postojati i u RN/primopredaja tabelama.

## 1. Simptom (prijava)

Sklop **1139493** → 1139499 → 1139495 → **1097206**: u 2.0 fali pozicija **1097207** („Uležitenje
međuvrata-kućište"), a u QBigTehn (stara aplikacija) postoji. 1097207 B visi kao **dete 1097206**
(obe revizije), ne direktno pod 1139495.

## 2. Nalaz — forenzika (potvrđeno upitima, ne hipoteza)

### 2.1 Šta fali u 2.0 (prod PG, stanje 14.07 ~15h)

- `drawings`: fale **33 reda, id 15809–15841** (kontiguozan blok). U MSSQL `PDMCrtezi` postoje,
  DIVUnosa 08.07 12:10 – 10.07 13:00:01. Među njima **1097207 B = IDCrtez 15841**.
- `drawing_components`: fale **62 veze**: id `620, 13673, 14551, 14585, 15949–16006` — tačno SVE
  veze čiji je parent ILI child u {15809..15841}. Među njima **620** (881 = 1097206 A → 15841) i
  **16006** (15842 = 1097206 B → 15841).
- Jedina 2.0-only stavka: nativni crtež 15929 (danas). MSSQL ↔ 2.0 id prostor **od 14.07 KOLIDIRA**:
  2.0 nativno 15920–15929 ≠ MSSQL legacy 15920–15928 (različiti crteži na istim id-jevima!).

### 2.2 Uzrok

Cutover-night procedura 13.07 uveče (paralelna sesija 0af63231; skripte na ubuntusrv
`/home/admnenad/cutover-night`): **stash nativnih redova → wipe → finalni force sync
(bb_sync_log id 2, 22:26) → „5a: delete legacy-overwritten native id rows" → 02-restore**.

Korak 5a (izvršen NA PRODU, replica mod):

```sql
DELETE FROM drawing_components WHERE parent_drawing_id IN (SELECT id FROM cutover_stash.drawings)
                                  OR child_drawing_id  IN (SELECT id FROM cutover_stash.drawings);
DELETE FROM drawings WHERE id IN (SELECT id FROM cutover_stash.drawings);
```

Greška u pretpostavci: stash id-jevi (15809–15841) su id-jevi koje je **nativna 2.0 sekvenca**
dodelila bridge uvozima tokom paralelnog rada 10–13.07 (sekvenca krenula od 15809 jer je posle
sync-a #1 od 08.07 max id bio 15808). Ali u **MSSQL id prostoru te id-jeve drže DRUGI crteži** —
uvezeni legacy skriptom 08.07 12:10 – 10.07 13:00, tj. PRE nego što je bridge proradio. Finalni
sync ih je ispravno doneo u 2.0, a korak 5a ih je onda obrisao kao tobožnje „pregažene nativne".
02-restore je vraćao stash redove uz dedup po (broj, revizija) — svi su bili duplikati legacy
kopija (paralelni rad — obe strane uvezle iste fajlove), pa **ništa nije vraćeno na te id-jeve**.

Kolateral: 1097207 B (15841) + veze 620/16006. Tehnolog je danas 11:42 ručno re-eksportovao
`1097207_B.xml` → nativni crtež **id 15928** nastao, ali **veze nisu obnovljene**: leaf XML ne
nosi roditeljske veze, a relink starih revizija nema šta da preveže (obrisane su).

### 2.3 Zašto postcheck nije uhvatio

03-postcheck je proveravao stash↔restore brojeve, ne pun id-diff MSSQL↔PG. COUNT po tabeli se
razlikovao za -33/-62, ali to nije bilo u kriterijumu.

## 3. Faza A — HITNA reparacija podataka (prod)

**Preduslov:** SSH na ubuntusrv (u trenutku pisanja pao — sačekati da se vrati; probe u pozadini).
MSSQL pristup radi sa dev mašine (`bridge_reader`, backend/.env). U QBigTehn **isključivo SELECT**.

1. **Uvid — POTVRĐENO 14.07 (Fable):** `cutover_stash` postoji na prod-u; `cutover_stash.drawings`
   = tačno 33 nativna reda, id 15809–15841, signature `pdm-bridge@servoteh.com` (bridge uvozi
   11–13.07). Provera po (broj, revizija) urađena: **31 žrtva potpuno odsutna iz 2.0**; dve
   postoje nativno → idMap: **15841 → 15928** (1097207 B, ručni re-eksport 14.07 11:42) i
   **15840 → 15919** (1126982 B — „dvostruki pogodak": bila i u stash-u kao nativni 15809,
   restore ju je vratio). Svih 33 stash nativnih crteža postoji u 2.0 po (broj, rev) —
   nema dodatnih nativnih gubitaka.
2. **Reparaciona skripta** (jednokratni node skript sa dev mašine — jedini ima i MSSQL i PG pristup;
   obrazac konekcija: `scratchpad/mssql-check*.js` iz sesije 8ad9b138):
   - `SELECT` 33 reda iz `PDMCrtezi` WHERE IDCrtez BETWEEN 15809 AND 15841 — mapiranje kolona
     identično sync-map unosu `PDMCrtezi → drawings` (sync-map.generated.ts:1618).
   - Za svaki red: ako `(drawing_number, revision)` VEĆ postoji u 2.0 → **ne insertuj**, upiši
     `idMap[legacyId] = postojećiId` (potvrđeno: 15841 → 15928 i 15840 → 15919; skript ipak
     proverava svih 33 u trenutku izvršenja); inače `INSERT` sa **legacy id-jem** (slobodni su,
     sekvenca je već na 15930+). Očekivano: 31 insert + 2 mapiranja.
   - `SELECT` 62 veze iz `KomponentePDMCrteza` po listi id-jeva (§5 manifest); `INSERT` sa legacy
     id-jem uz remap parent/child kroz idMap; preskoči (i loguj) ako `(parent, child)` već postoji
     ili endpoint i dalje ne postoji.
   - `alignIdSequence` (3-arg oblik iz `src/common/db-sequences`) za `drawings` i
     `drawing_components` posle eksplicitnih id upisa.
   - Sve u JEDNOJ PG transakciji; ispis inserted/skipped/remap po tabeli.
3. **Verifikacija:**
   - Rekurzivni BOM za 1139493 (CTE kao u `pdm.service.ts` §287+) sadrži 1097207 B pod 1097206 A i B.
   - Ponovni id-diff MSSQL↔2.0 (drawings + drawing_components): dozvoljene razlike SAMO
     kolizioni pojas 15920+ (popisati ga u izveštaju).
   - `drawing_pdfs` za svih 33 (broj, rev) — PDF postoji (1097207 B potvrđen: „zamenjen postojeći").
   - UI: sklop 1139493 na /pdm prikazuje poziciju 1097207.

## 4. Faza B — sistemske zaštite (kod + skripte + runbook)

1. **Guard za intake tabele**: dok se QBigTehn lanac ne iseče iz sync mape (runbook 17, korak 6),
   dodati `drawings`, `drawing_components`, `drawing_pdfs`, `drawing_import_log` (razmotriti i
   `drawing_plans`) u zaštitu tipa OWNED_PRODUCTION_TABLES (bez `force` nema delete+reinsert).
   **VAŽNO:** zbog id kolizije (2.0 nativno vs MSSQL od 14.07) NIJEDAN dalji full refresh tih
   tabela nije bezbedan ni sa force — finalni cutover sync mora raditi rekonsilijaciju po
   `(drawing_number, revision)`, nikako po id-ju.
2. **Ispravka cutover-night skripti** (`/home/admnenad/cutover-night` na ubuntusrv): korak 5a sme
   brisati samo redove čiji sadržaj ZAISTA odgovara stash redu — JOIN po (broj, revizija) +
   signature/created_at, ne po golom id-ju.
3. **Runbook 17 dopuna**: upozorenje o id koliziji tokom paralelnog rada (nativna sekvenca vs
   legacy IDCrtez); posle svake stash/wipe/restore verifikacija = **pun id-diff**, ne COUNT/MAX.
4. **Diff verifikacija ostalih tabela iz wipe liste** — isti obrazac štete je mogao pogoditi:
   `work_orders`, `work_order_operations` (+images), `drawing_handovers`, `handover_drafts`,
   `handover_draft_items`, `drawing_pdfs`. Za svaku: id-diff (odn. (broj,rev)-diff za pdfs)
   MSSQL↔2.0 pa procena da li fali nešto legacy-jevo. Ako da — isti reparacioni obrazac.

## 5. Manifest žrtava (iz MSSQL, 14.07)

Crteži (IDCrtez / broj / rev / naziv): 15809 1136290 B Osovina-aktivator · 15810 1086966 A Cilindar
OK letve-Sklop · 15811 K05733 B DIN 912 M6x20 · 15812 1088839 A Cilindar 32/16 hod 25mm · 15813
1088840 A · 15814 1088841 A · 15815 1088843 A Emerson 1822124002 · 15816 1088844 A Brezon za pn.
cilindar · 15817 1088846 A · 15818 1088845 A · 15819 K21937 A Schnorr VS 8 · 15820 1139397 A
Pločica dorada · 15821 1139399 A Nosač gazišta-dorada · 15822 1136504 B Sklop Grede Komore-Obrada ·
15823 1139376 A · 15824 1139379 A · 15825 1139378 A · 15826 1139374 A · 15827 1139372 A · 15828
1139377 A · 15829 1139373 A · 15830 1139362 A · 15831 1139375 A · 15832 1139380 A · 15833 1139382 A
· 15834 1139383 A · 15835 1139380 B · 15836 1139383 B · 15837 1110204 A · 15838 1110206 A · 15839
1110207 A · **15840 1126982 B (→ postoji nativno kao 15919)** · **15841 1097207 B (→ postoji
nativno kao 15928)**

Veze (IDKomponenteCrteza): 620 (881→15841), 13673 (13908→15822), 14551 (14536→15809),
14585 (14547→15809), 15949–16006 (roditelji 15810 i 15840 + 16006: 15842→15841).
Tačan sadržaj čitati iz MSSQL-a u trenutku izvršenja (mogao se pomeriti relink-om).

## 6. Šta NE raditi

- **NE pokretati ručni QBigTehn sync** (ni bez force) dok Faza B guard ne stane — pregaziće
  nativne crteže od 14.07 (15920+) i vratiti rupu.
- **NE raditi restore iz cutover_stash** — stash sadrži nativne duplikate, ne žrtve.
- U QBigTehn MSSQL se ne piše ništa (pravilo repoa).

---

## 7. IZVRŠENO 14.07 (Fable, ista sesija) — dnevnik reparacije

Backup pre svake faze: `ubuntusrv:~/bom-repair-20260714/` (pg_dump data-only; drawings+components i
ceo RN lanac). Reparacioni SQL-ovi u istom folderu (`repair.sql`, `repair-rn.sql`), generisani iz
ŽIVOG MSSQL-a, idempotentni, izvršeni u po jednoj transakciji.

**Faza A — PDM (izvršeno ~15:26):**
- `drawings`: +31 insert sa legacy id (15809–15839), 2 mapiranja na nativne (15840→15919, 15841→15928).
- `drawing_components`: +62 veze (620, 13673, 14551, 14585, 15949–16006) uz remap kroz idMap; 0 preskočeno.
- Verifikovano: rekurzivni BOM 1139493 → 1139499 → 1139495 → 1097206 B → **1097207 B** ✓;
  pun id-diff MSSQL↔2.0 čist (jedina odstupanja: 15840/15841 mapirani + rastući kolizioni pojas
  nativnih 15920+); PDF-ovi: 24/33 postoje, 9 bez PDF-a ni u legacy-ju (standardni delovi) — ništa
  nije izgubljeno.

**RN lanac (izvršeno ~16:58)** — ista klasa štete nađena diff-om svih stash tabela, vraćeno 53 reda:
- `work_orders`: 8 (47284, 47286–47292 — 9400/3/372, 9400/6/248, 9811-5/83, 9811-5/84, 9400/2/457–460)
- `work_order_operations`: 19 (229041–229049, 229054–229063; RN 47139/47143/47144/47188/47194)
- `work_order_launches`: 3 (4884–4886) · `work_order_approvals`: 1 (id 1, RN 40338 iz januara!)
- `part_locations`: 4 (12943–12946) · `tech_processes`: 11 (117074–117084)
- `handover_drafts`: 4 (3447, 3449, 3451, 3452) · `handover_draft_items`: 3 (8051, 8071, 8079)
- Sekvence poravnate (setval) za svih 10 tabela; dup provera operacija čista.

**Namerno NEvraćeno (nisu žrtve wipe-a):**
- RN 47060/47061 (7918/19, 7918/20, uneti 03.07) + njihove 4 operacije (229000–229003) — bili u oba
  mirror-a, nestali POSLE 13.07 → namerno obrisani u 2.0 (RN_DELETE_FORCE / placeholder čišćenje);
  potvrditi sa Miloradom ako iskrsne.
- Operacija 229832 (RN 47335 / 9400/2/474) — RN u 2.0 ima svih 5 operacija (jedna nativno prekucana
  pod novim id-jem); restore bi napravio duplikat.

**Čisto (bez štete):** drawing_handovers, drawing_handover_pdfs, planner_entries, drawing_pdfs,
tech_process_documents, work_order_operation_images, work_order_components/item_components,
blanks/machined/nonstandard, drawing_plan_items (stash natives = 0 ili svi id-jevi prisutni).

**Faza B (kod):** intake tabele (`drawings`, `drawing_components`, `drawing_pdfs`,
`drawing_import_log`) dodate u `OWNED_PRODUCTION_TABLES` — običan full refresh ih preskače;
upozorenje o id koliziji u runbook 17. Cutover-night skripte na ubuntusrv ispravljene/označene.
