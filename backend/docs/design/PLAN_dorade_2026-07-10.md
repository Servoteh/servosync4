# Plan dorada — 10 tačaka (Nenad, 10.07.2026)

> Analiza: multi-agent 10.07 (3 agenta, read-only). Implementacija kreće POSLE P4a commit/deploy-a.
> Status oznake: ✅ već postoji · 🔨 graditi · ⚠️ odluka.

## Ključno otkriće pre svega

**Dodavanje za sve 4 strukture (vrste poslova, operacije, radne jedinice, radnici) VEĆ POSTOJI**
(POST endpointi + „Nova/Novi…" dijalozi), ali iza permisije `strukture.write` koju imaju **samo ADMIN i
ŠEF** (AUTHZ_ENFORCE=true na prod-u). Ako na ekranu nema dugmadi — nalog kojim se gleda nema tu rolu,
ili je build stariji. **Prvo proveriti rolu naloga pre bilo kakvog koda.**

## D1–D4: Proizvodne strukture (obim: S/S/S/M)

| Tačka | Postoji | Graditi |
|---|---|---|
| 1. Vrste poslova | ✅ dodavanje, izmena | 🔨 sakriti kolonu „Dodatna prava" (checkbox u formi OSTAJE — to je signal „ovlašćeni kontrolor" za A-5 završnu kontrolu/kiosk!; preimenovati label u „Ovlašćeni kontrolor"); 🔨 DELETE endpoint + dugme (409 ako ima radnika te vrste; zabraniti id=0 „NN") |
| 2. Operacije (RC) | ✅ dodavanje, izmena, DELETE endpoint sa guard-om | 🔨 dugme „Obriši" u UI (hook već postoji!); 🔨 dopuna guard-a: `tech_processes`/`work_time_entries` nemaju FK ka RC → dodati count pre-check da se istorija kucanja ne orphan-uje |
| 3. Radne jedinice | ✅ dodavanje, izmena | 🔨 DELETE endpoint + dugme (409 ako je referišu operacije/radnici; zabraniti code="0") |
| 4. Radnici | ✅ dodavanje, izmena, deaktivacija (soft) | 🔨 sakriti kolonu „Prava" (flagovi ostaju u detalju/formi); 🔨 dugme „Aktiviraj" kad je neaktivan (PATCH active:true — endpoint već podržava); ⚠️ tvrdo brisanje: spec kaže NIKAD — predlog: DELETE dozvoljen SAMO kad radnik nema nijednu referencu (typo-unos), inače 409 „deaktiviraj umesto brisanja" — potvrda Nenad |

Sync-sudar NEMA: svih 5 tabela je već u `OWNED_PRODUCTION_TABLES` (sync = jednokratni seed).

## D5: Kopiranje TP (obim: M)

- ✅ **Kopiranje u postojeći prazan RN već radi end-to-end**: dugme „Kopiraj iz naloga" na detalju RN-a
  (picker sa pretragom) → `POST /work-orders/:id/copy-from/:sourceId` (sve 4 vrste stavki) = legacy
  „Prepiše stavke, delove, limove".
- 🔨 Fali legacy **„Prepiši isti postupak"** = klon istog RN-a kao **sledeća varijanta** (legacy
  `SledecaVrednostVarijante`): novi endpoint `POST /work-orders/:id/clone-variant` (MAX(variant)+1 po
  (predmet, crtež, revizija) uz advisory lock) + dugme. **Ovim se ujedno oživljava kiosk staleWorkOrder
  guard** (scan-strana je spremna, čeka da varijanta počne da raste — [[rn-barkod-verzioni-guard]]).
  ⚠️ potvrda Negovan: klon-kao-novi-red (legacy semantika) — komentar u kiosk.ts o „bump u mestu" se
  tada ispravlja.

## D7: Prioritet / CAM (obim: M)

- 🔨 Sakriti polje „Prioritet" iz „Dodaj/Izmeni operaciju" dijaloga (backend default „iz RC-a" već radi).
- 🔨 CAM prioritet se zadaje na stranici **„Operacije po prioritetu"** — inline izmena u tabeli (tačno kao
  legacy forma `PregledOperacijaPoPrioritetima` koja je imala unos u gridu). ZAMKA: CNC programer nema
  `rn.write` → novi namenski endpoint `PATCH /work-orders/operations/:id/priority` iza
  `tehnologija.write` (koju CNC_PROGRAMER ima).

## D9: Komitent iz predmeta (obim: S)

- ✅ Prefill logika postoji ali je **nevidljiva** (ComboBox ostane prazan, upiše se samo šifra u DTO) +
  bug: predmet sa `customerId=0` upiše 0 pa validacija obori snimanje.
- 🔨 Lookup predmeta da vraća i IME komitenta; ComboBox se popuni vidljivo (i dalje izmenljiv); guard za 0.

## D10: Preimenovanje (obim: XS — čiste labele)

- Preporuka: stranica „Tehnološki postupci" → **„Realizacija"** (pokriva tabove), tab „Postupci" →
  **„Kucanja"**, „Kartica tehnološkog postupka" → **„Kartica kucanja"**. Rute/permisije/API se NE diraju.
  ⚠️ Nenad bira naziv. Bonus nalaz: tab „Kucanja" i stranica „Evidencija u proizvodnji" listaju istu
  tabelu — kandidat za kasniju konsolidaciju.

## D8: Notifikacije (obim: L — novi mali modul)

- Ništa ne postoji, ali je dizajn već skiciran u MODULE_SPEC_nacrti_primopredaje §3.3/§7.4
  (`AppNotification`), a emit mesta su označena u kodu („poruka tehnologu = P2").
- 🔨 Nova app-owned tabela `app_notifications` (ručna migracija) + notifications modul (lista /
  unread-count / mark-read) + **zvonce u AppShell-u** (React Query polling 30s).
- Emit 1: `tech-processes.control()` kad kvalitet ≠ dobar — legacy notifikuje **i doradu i škart**
  (poruka: RN + operacija + kontrolor) → grupa TEHNOLOG (workers vrste Tehnolog → njihovi users).
- Emit 2: `handover-drafts.submit()` — „Kreirana nova primopredaja 'D-…'" → grupa TEHNOLOG
  (⚠️ pitanje: možda i Miljanu/šefu jer on odobrava? Legacy je slao grupi TEHNOLOG).
- NE koristiti legacy `planner_entries` (Access Planer čita MSSQL — poruke iz PG niko tamo ne vidi).

## Predlog redosleda implementacije (posle P4a deploy-a)

1. **D10 + D9 + D7-sakrivanje + kolone D1/D4** — sve XS/S label/UI izmene, jedan mali talas.
2. **D1–D4 DELETE/aktivacija** — CRUD dopune sa guard-ovima.
3. **D5 clone-variant** (+ variant bump odluka Negovan) i **D7 inline CAM prioritet**.
4. **D8 notifikacije** — poslednje (novi modul + migracija).

## Odluke — POTVRĐENO (Nenad, 10.07.2026 uveče)

1. **Permisije struktura**: dodavanje/izmene dozvoliti i rolama **MENADZMENT i TEHNOLOG** (uz ADMIN/ŠEF)
   → proširiti `strukture.write` dodelu u role-permissions.ts. Aktiviraj dugme + sklanjanje kolona ✅.
2. D5 kopiranje/klon ✅ OK. 3. D9 komitent ✅ OK. 4. D7 prioritet/CAM ✅ OK.
5. **D10 naziv: „Realizacija"** (tab „Kucanja", „Kartica kucanja").
6. **D8 notifikacije** ✅ + **dorada TAKOĐE šalje notifikaciju**; primaoci dorade/škarta: grupa TEHNOLOG
   **+ inženjer koji je izradio crtež** (do njega preko lanca RN → primopredaja → nacrt → designerId;
   fallback `drawings.designedBy` string ako lanac ne postoji) + (email faza) proizvodnja@servoteh.com.
7. Brisanje radnika: bez izričite potvrde → implementira se SAMO bezbedna varijanta (DELETE kad nema
   nijedne reference — typo unos; inače 409 „deaktiviraj"). Ostaje otvoreno za Negovana: klon-varijanta
   semantika (D5 — usvaja se legacy: novi red, MAX+1).

## D8-v2 BACKLOG — email izveštaji škarta (Nenad: „za razradu, veoma korisna opcija")

- **Odmah po škartu** (posebno TOTALNI škart): email na **proizvodnja@servoteh.com + uprava@servoteh.com**
  sa sublimiranim **brojem utrošenih sati za taj komad** (izvor: Σ vremena iz tech_processes za tu trojku
  — podatak već postoji u kartici kucanja).
- **Nedeljni izveštaj**: ukupan škart + troškovi za nedelju (troškovi = sati × cena sata? — satnice još ne
  postoje u sistemu; za razradu).
- Preduslov: SMTP/mail infrastruktura (nova zavisnost/servis — odobrenje + odluka gde šalje: backend
  direktno ili preko postojeće infrastrukture firme). NIJE deo prve faze D8 (in-app zvonce).
