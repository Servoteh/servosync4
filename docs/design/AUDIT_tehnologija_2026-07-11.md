# Dubinski audit modula Tehnologija — 2026-07-11

> Multi-agentni senior audit (12 agenata: 5 auditora → adversarial verifikacija → čišćenje → završna
> provera). Opseg: ceo backend + frontend modula Tehnologija (Reversi/Sy15 van opsega — paralelni 3.0
> pilot). Rezultat: **49 verifikovanih nalaza, 47 primenjeno** (backend `4753f80→6717769`, frontend
> `c152d5f`), 205→219 testova zeleno, oba builda zelena. Dva verifikatora (legacy-paritet, mrtav-kod)
> prekinuta limitom — njihovi nalazi su dole označeni kao ⚠️ NEVERIFIKOVANI i NISU automatski primenjeni.

## 1. Opšta ocena (senior perspektiva)

**Modul je u jezgru ZDRAV i na više mesta bolji od legacy-ja.** Statusna mašina primopredaje nema
nemogućih prečica (approve/reject samo iz U OBRADI; prepare/launch samo iz SAGLASAN; „odbij posle
prepare-a" ne postoji; lansirano se zaključava). HANDOVER_LEGACY_GUARD pokriva sve mutacione putanje —
bypass NIJE nađen. Advisory-lock disciplina je konzistentna kroz servise. Derivacioni syncer strukturno
ne može pregaziti nativne redove (uq legacy_rn_id). Mrtvog koda praktično nema (nula console.log, nula
zakomentarisanog koda, sve zavisnosti žive). Frontend API sloj disciplinovan, invalidacije korektne.

## 2. Šta je popravljeno u ovom auditu (47 stavki, sve na produkciji)

**Trke i statusna mašina:** cross-servisni launch race zatvoren sa obe strane (uslovni updateMany + isti
advisory lock u work-orders.launch); TOCTOU u approve/reject zatvoren; launch više ne prepisuje napomenu
RN-a; komentar prelaza se briše kad ga nema.

**Validacija:** nevalidni datumi u filterima → 400 umesto 500 (zajednički `common/date-params.ts`, 6
modula); draft numeracija numerički MAX (string-sort bi puštao duplikate posle 999/dan); dužine polja u
svih 5 structures validatora; RFC 5987 filename* (dijakritike u PDF imenu više ne obaraju header).

**Higijena:** literalni NUL bajtovi u 2 fajla (git/ripgrep su ih tretirali kao binarne — kod nevidljiv za
diff/pretragu!) zamenjeni escape sekvencama; svih 7 preostalih 2-arg setval → zajednički alignIdSequence;
bulkClone resetuje drawingHandoverId; mrtav kod uklonjen (isLabelProxyConfigured, nedostižna grana,
nekorišćen prop).

**Frontend permisije (kritično uz AUTHZ_ENFORCE=true):** Can() sakrivanje na 6 mesta gde su dugmad
vraćala 403 živim rolama; **landing posle prijave `/syncs` → `/work-orders`** (sync.read imaju samo
admin/šef/menadžment — svi ostali su sletali na 403); RejectDialog reset na otvaranje; Snimi nacrta
disabled bez predmeta/projektanta; ⚠ znakovi van dizajn sistema uklonjeni.

## 3. Otvoreni nalazi — TRAŽE ODLUKU (nisu automatski primenjivani)

| # | Nalaz | Odluka |
|---|---|---|
| 1 | **Brisanje lansiranog RN-a** ostavlja primopredaju trajno zaključanu u LANSIRAN bez RN-a (ćorsokak, nema recovery) | Miljan/Negovan: zabraniti brisanje lansiranog vezanog RN-a, ili recovery akcija na primopredaji? |
| 2 | **control() knjiži na SKENIRANU varijantu**, scan/start/stop na TEKUĆU — stari papir kod kontrolora tiho zatvara staru varijantu bez upozorenja | Negovan: da li kontrola treba isti staleWorkOrder tok kao kucanje? |
| 3 | `lookups` rute bez permisije (zaobilaze DIRECTORY_READ uz živ enforce) | potvrditi pa dodati guard (izmena u fajlu paralelne sesije — koordinisati) |
| 4 | `GET /sync/log?limit=abc` → 500 (fajl paralelne sesije — fix spreman: parseInt + NaN fallback) | primeniti kad se sesija razreši |
| 5 | Default rola `user` nema permisije uz enforce=true (komentar obećava mapiranje u viewer) | odluka + migracija rola |
| 6 | Unique indeks na `handover_drafts.draft_number` (dodatna mreža — kod je već ispravljen) | migracija uz sledeći talas |
| 7 | Sync gubi per-row greške (ne persistiraju se, kursor preskače preko preskočenih redova) | dizajn za cutover verifikaciju |
| 8 | Off-canvas sidebar <1024px (DESIGN_SYSTEM V1 zahtev, priznat dug) | UI talas |
| 9 | Tabs/ConfirmDialog/NativeSelect duplirani po modulima umesto u ui-kit | UI talas (promocija u kit) |
| 10 | part-locations TODO(auth): ledger upisuje pogrešnog izvršioca (posle JWT plumbing-a akciono) | mali fix, koordinisati sa paralelnom sesijom |

## 4. Legacy paritet — stanje (⚠️ auditor završio, verifikator prekinut limitom)

**Potvrđeno kompletno:** P0, P1, P2, P3, P4a — svaka stavka planova proverena u kodu, uključujući detalje
(obavezan tehnolog validiran na defines_approval, idempotentan prepare, propagacija samo na „original" RN,
ISO format grupe štampe, pasivni bridge...). Svih 9 tačaka dorada verifikovano implementirano.

**Ažuran gap-spisak vs QBigTehn (svesni jazovi, sada na kritičnom putu ka cutover-u):**
1. **PND/PDM/PLP stavke TP-a** — backend ih samo kopira (copy-from), nema CRUD ni UI (legacy tabovi).
2. **Skice operacija** — model postoji, endpoint/UI ne.
3. **BOM auto-populate nacrta** — legacy izbor sklopa automatski ubacuje sve delove sa preračunom.
4. **OdlukePredProvera decision engine** — pre-check duplikata + odluka (Isključi/Predaj ponovo/Dopuni) + gate pre lansiranja.
5. **Tier B-5 pregledi** „Evidencija u proizvodnji" (Zbir/ZbirGrupno...) — preduslov (A-4) isporučen.
6. Sitno: nabavni deo iz XML-a ne upisuje se u artikle (svesno — §11.1 overlay odluka); PDF filename heuristika za brojeve crteža sa `_`; drawing status → PREDAT na submit; reject-notifikacija projektantu.
7. **Dokumentacija zaostaje za kodom:** ODLUKE #3/#12 i dalje kažu „PDM = direktan SQL" iako je isporučen (i deployovan) nativni XML+PDF intake — formalizovati reviziju sa Negovanom; PLAN header-i kažu „čeka realizaciju" za isporučene pakete; PLAN_dorade numeracija preskače D6.

## 5. Šta NE dirati (potvrđeno dobro)

Advisory-lock ključevi i sveže re-čitanje posle locka; id politika derivacije; launch transakcija sa
guard-ovima; batch-resolve + SAFE_WORKER_SELECT svuda; BOM CTE anti-ciklus; PDM import sve-ili-ništa
validacija sa P2002 race handling-om; notifikacije best-effort posle transakcije; kiosk write-path
(create-on-scan validiran, storno kontra-red + audit snapshot); .env.example 100% pokriven.
