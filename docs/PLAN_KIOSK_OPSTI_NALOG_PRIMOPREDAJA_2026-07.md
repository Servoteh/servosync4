# PLAN: primedbe iz pogona 22.07.2026 — kiosk više radnika, opšti nalog, mail odbijenice, barkod nalepnica

**Datum:** 22.07.2026 · **Analiza:** Fable · **Izvršenje:** Opus (posle ovog plana)
**Izvor:** primedbe iz pogona (fotografija legacy „RADNI NALOG 0000.0 rev A, predmet 4521, Op. 5 · RC 0.0 OPŠTI NALOG"; fotografije nalepnica 15-06-26 vs 16-07-26).

## STATUS IZVRŠENJA (ažurirano 22.07, Fable)

| Stavka | Status |
|--------|--------|
| 1 — kiosk više radnika | ✅ IMPLEMENTIRANO (grana `fix/pogon-primedbe`): guard u `accumulateStopWork`, `finishForAll` DTO+dijalog, dismiss guard, higijena sesija u finish/reachedPlan, `othersOpenCount` u „Moji otvoreni"; 7 novih testova, 1610/1610 zeleno |
| 2 — opšti nalog nosač-RN | ✅ RAZREŠENO proverom na produ 22.07: nosač-RN **VEĆ POSTOJI** (`work_orders` id=4698, predmet 4521, ident `0000.0`, rev A, op. 5 · RC `0.0`, plan 100000) i **kucanje RADI** (9043 reda u `tech_processes`, poslednje 22.07 05:00). „Ne vidi se" = simptom baga iz stavke 1 (završen deljeni red nestane svima iz „Mojih otvorenih"; nov START sken otvara nov red). U praćenju ga nema jer predmet 4521 NIJE aktiviran (`predmet_aktivacije.is_active=f`) — namerno, odluka 5. Kod-provera `markWorkOrderIfComplete` ✅ (`0.0` ima `significant_for_finishing=f` na produ → RN se ne može auto-završiti). Runbook ispod je BEZPREDMETAN osim ako se traži nova štampa barkoda. |
| 3 — mail odbijenice | ✅ IMPLEMENTIRANO (ista grana): `notifyRejected` u HandoversService (1 mail+in-app po generatoru), `batchTransition` vraća stvarno prebačene, `.env.example` RESEND_*; testovi zeleni |
| 4 — barkod nalepnica (HITNO) | ✅ IMPLEMENTIRANO (22.07, ista grana): nalepnica sada nosi KRATKI legacy oblik `RNZ:0:{ident}:0:0` (`formatLabelBarcode`), `parseBarcode` prihvata IDPredmet=0, svi sken ulazi (scan/start/stop/control/openSession/decode) razrešavaju predmet po identu (`resolveScanProjectId`: 404 nepoznat / 422 dvosmislen), TSPL2 modul podebljan `narrow` 2→3 (0,254 mm) uz auto-pad na 2 za predugačak sadržaj. Usput rade i STARE 1.0 nalepnice. RN A4 papir netaknut. ⚠️ OBAVEZNO: proba ručnim skenerom u pogonu na svežoj nalepnici pre zatvaranja. |

## Preduslovi za izvršioca (Opus)

- **Grana:** novi branch od **svežeg `main`** (pravilo iz korenskog CLAUDE.md). NE raditi na
  `feat/4.0-faza1` — to stablo je prljavo (~171 fajl) i nosi 4.0 izmene.
- Pre pusha backend koda: **boot-smoke** (`node dist/main` posle build-a). Posle deploy-a:
  `ssh ubuntusrv 'bash -s' < backend/scripts/post-deploy-verify.sh` — ne javljati „radi" bez 🟢 EXIT 0.
- Sve linije ispod su verifikovane 22.07. na `feat/4.0-faza1`; kod modula je isti kao na `main`,
  ali pre izmene proveriti da se linije nisu pomerile.

---

## STAVKA 1 (prioritet 1 — bag u pogonu): završetak jednog radnika zatvara nalog svima

### Simptom (prijava)

Radnik 1 otkuca operaciju opšteg naloga i počne rad; Radnik 2 uradi isto (ista operacija).
Kad Radnik 1 otkuca kraj, nalog se „zatvori" i Radniku 2 (i svima koji su ga otvorili).

### Utvrđeni uzrok (verifikovano u kodu)

Korisnikova hipoteza („zatvaranje tuđeg naloga bez pitanja") NIJE uzrok — legacy feature
`ZavrsiNalogDrugogRadnika` uopšte nije implementiran (eksplicitno P2, vidi
`backend/src/modules/tech-processes/dto/stop-work.dto.ts:9`). Sesije se svuda zatvaraju
striktno po `workerId` — tuđa sesija se nikad ne dira.

Pravi uzrok je **deljeno globalno stanje reda operacije**:

1. **Data model:** `tech_processes` red operacije je JEDAN i DELJEN između svih radnika na istoj
   (trojka + operacija) — komentar to i kaže u `openForWorker`
   (`tech-processes.service.ts:685-690`). Otvorenost operacije = `is_process_finished` na tom
   deljenom redu. Per-radnik su samo sesije `work_time_entries` (`workerId`, `stoppedAt IS NULL`).
2. **START:** oba radnika dobiju ISTI `tech_processes` red — `findOrOpenRoutingTp`
   (`tech-processes.service.ts:3845-3849`) vraća postojeći OTVOREN red; i za
   `withoutProcess` (opšti nalog) nov red se otvara SAMO ako je postojeći zatvoren.
3. **„Kraj rada" (stopWorkById):** zatvori SVOJU sesiju (`:2403-2412`, filter po `workerId` —
   korektno), pa pozove `accumulateStopWork(..., forceFinish=true, ...)` (`:2414-2425`).
4. **Tačka baga — `accumulateStopWork` (`:2644-2650`):**
   `const finish = reachedPlan || forceFinish;` → `techProcess.update({ isProcessFinished: true })`
   na DELJENOM redu. `forceFinish=true` je uveo **FIX B, commit `ad00352` (15.07.2026)** —
   pre toga je „Kraj rada" zatvarao red samo kad je plan dostignut.
5. **Posledica:** lista „Moji otvoreni" (`openForWorker`, filter
   `isProcessFinished: { not: true }` na `:703`) izbaci red SVIM radnicima. Sesija Radnika 2
   ostaje da visi otvorena (`stopped_at IS NULL`) dok je noćni auto-close ne pokupi
   (`session-auto-close.service.ts`); njegov STOP sken pada 422 „već zatvorena" ili (ispod plana,
   FIX A) otvori nov red, a stara sesija ostane siroče.

Napomena: i pre FIX B isti simptom postoji kad se dostigne plan (`reachedPlan`) dok drugi rade;
FIX B je samo proširio okidač na „uvek".

### Rešenje (dizajn — dva dela, oba u istom PR-u)

**1a. Backend guard — „Kraj rada" ne gasi red dok drugi imaju otvorene sesije** (srž popravke):

- U `accumulateStopWork` (`tech-processes.service.ts:2585-2672`) dodati parametar
  `finishForAll = false` i pre odluke o `finish` izračunati:
  `othersOpen = await tx.workTimeEntry.findFirst({ where: { techProcessId: tp.id, stoppedAt: null, workerId: { not: workerId } } })`
  (NAPOMENA: sopstvena sesija je u tom trenutku već zatvorena od pozivaoca — filter
  `workerId: { not: workerId }` je zaštita za slučaj više sopstvenih redova).
- Nova odluka: `finish = reachedPlan || (forceFinish && (!othersOpen || finishForAll))`.
  Ponašanje za jednog radnika ostaje IDENTIČNO današnjem (nema tuđih sesija → forceFinish
  zatvara, FIX B očuvan). Backward-kompatibilno: stari FE bez flag-a dobija novo (bezbedno)
  ponašanje.
- **Higijena pri svakom gašenju reda:** kad `finish` postane `true` (bilo `reachedPlan`, bilo
  `finishForAll`), u istoj transakciji zatvoriti SVE preostale otvorene sesije tog reda:
  `workTimeEntry.updateMany({ where: { techProcessId: tp.id, stoppedAt: null }, data: { stoppedAt: now, pieceCount: 0, autoClosed: true } })`
  — vreme tuđe sesije se sačuva do `now`, komadi 0, nema više siročića za noćni auto-close.
  (Proveriti tačan naziv/semantiku `autoClosed` kolone u šemi — `schema.prisma`
  `WorkTimeEntry` :1753-1776 — i eventualno dodati `note` npr. „zatvoreno sa operacijom".)
- U povratnoj vrednosti `accumulateStopWork` vratiti i `finishSkipped: boolean` (traženo
  gašenje preskočeno jer drugi rade) + listu `otherOpenWorkerIds`, da `stopWorkById` može da
  ih vrati u response (`:2450-2474` — dodati `finishSkipped`, `otherOpenWorkers` sa imenima
  preko postojećeg `resolveWorkers`).
- **`stopWorkById`** (`:2362`): DTO `StopWorkByIdBody` dobija opcioni `finishForAll?: boolean`
  (`dto/stop-work.dto.ts`); prosleđuje se u `accumulateStopWork`.
- **`dismissEntry`** (`:2485`, bezuslovno gašenje reda oko `:2547-2550`): isti guard — ako
  postoje TUĐE otvorene sesije, zatvoriti samo svoju sesiju, red NE gasiti (vratiti
  `finishSkipped: true`). „Odustani" jednog radnika ne sme da obriše rad ostalih.
- **`stopWork`** (barkod STOP, `forceFinish=false`): ne menja se — već je plan-gated; kad
  `reachedPlan` zatvori red, nova higijena počisti tuđe sesije.
- **`finish`** (`POST /:id/finish`, oko `:1778-1789`): dodati istu higijenu sesija pri gašenju
  (i po želji isti guard — proceniti pri implementaciji da li „Zatvori" iz liste treba pitanje;
  preporuka: da, isti dijalog kao „Kraj rada").

**1b. Frontend — korak-pitanje (ono što je korisnik i tražio):**

- `openForWorker` (`:663-717`): za svaki vraćeni red dodati `othersOpenCount` — broj TUĐIH
  otvorenih sesija (`work_time_entries` po `techProcessId`, `stoppedAt: null`,
  `workerId != moj`; jedan `groupBy` upit za sve redove, ne N+1).
- Kiosk „Moji otvoreni" (`frontend/src/app/kiosk/_components/my-open-panel.tsx`, hook
  `useStopWorkById` u `frontend/src/api/kiosk.ts:275-285`): kad red ima `othersOpenCount > 0`,
  na „Kraj rada" prikazati izbor:
  - **„Završi samo moj rad"** (podrazumevano) → poziv BEZ `finishForAll` — zatvara moju sesiju,
    upisuje moje komade, red ostaje otvoren ostalima;
  - **„Zatvori operaciju za sve (N radnika još radi)"** → poziv sa `finishForAll: true`.
  - Isti dijalog za „Odustani" (dismiss) i „Zatvori" (finish) kad `othersOpenCount > 0`.
- Ako red nema tuđih sesija — ponašanje i UI identični današnjem (bez novog klika!).
- Fallback: ako backend vrati `finishSkipped: true` (stari ekran / trka), prikazati poruku
  „Tvoj rad je završen; operaciju i dalje koristi X — nije zatvorena."

### Testovi (obavezno)

- `tech-processes.service.spec.ts` / `tech-processes.regression.spec.ts`:
  1. dva radnika, R1 „Kraj rada" bez flag-a → R1 sesija zatvorena, red OSTAJE otvoren,
     R2 sesija netaknuta, R2 i dalje vidi red u `openForWorker`;
  2. R1 „Kraj rada" sa `finishForAll` → red zatvoren, R2 sesija zatvorena (`pieceCount 0`);
  3. jedan radnik „Kraj rada" → red zatvoren (FIX B regresija ne sme da se vrati);
  4. `reachedPlan` sa tuđom otvorenom sesijom → red zatvoren + tuđa sesija počišćena;
  5. dismiss sa tuđim sesijama → red ostaje otvoren.
- Ručna proba na kiosku sa dve ID kartice (scenario iz prijave).

---

## STAVKA 2 (prioritet 2 — operativno): „Ne vidi se opšti nalog RN1000 — kako se dodaje?"

### Utvrđeno stanje

- „Opšti nalog" u 3.0 **nije radni nalog nego OPERACIJA** — radni centar `0.0`, `operations.
  without_process = true` („opšti nalog za sve radove": čišćenje, sastanak, edukacija…).
  Kanon: `backend/docs/design/MODULE_SPEC_structures.md` (:171, :257, :652). Kucanje `0.0` ima
  posebnu granu (uvek radna, bez routinga) u `findOrOpenRoutingTp`
  (`tech-processes.service.ts:3795-3805, 3851-3892`).
- Ali toj grani i dalje treba **nosač-RN u `work_orders`**: `findCurrentWorkOrder`
  (`:3676-3687`, lookup po `projectId + identNumber`) baca 404 „RN … nije nađen" ako reda nema
  — i tu kucanje staje. Legacy nosač (papir sa slike: predmet 4521, ident `0000.0`, rev A,
  100000 kom) **ne postoji u 3.0 bazi**: sync radnih naloga je ugašen na cutover-u 14.07.
  (`sync.service.ts:44-51`, `table-ownership.ts`), a servisni predmet 4521 nije ušao u finalni
  uvoz (legacy SQL ga je i inače izuzimao: `IDPredmet<>4521`, vidi
  `backend/docs/migration/15-bom-mrp-odluka-bez-negovana.md:268-289`).
- Nijedan where-filter NE sakriva takav RN — problem je isključivo nepostojanje reda.
- Legacy ident `0000.0` je nevalidan po 3.0 pravilima (bez `/` separatora); numeraciju ionako
  generiše server: `<brojPredmeta>/<redniBroj>` (`work-order-numbering.service.ts:13-43`).
  Stari papirni barkodovi zato NE mogu da rade — barkod nosi ident.

### Šta uraditi (mali runbook, bez novog koda)

1. **Provera seed-a:** na produkcionoj bazi potvrditi da `operations` ima red
   `work_center_code='0.0'` sa `without_process=true` (kanonski seed po MODULE_SPEC).
   Ako nema — dodati kroz postojeći šifarnik operacija (UI), ne SQL-om.
2. **Kreirati nosač-RN kroz postojeći UnosRN** (`POST /work-orders`,
   `work-orders.service.ts:596-644`): predmet **4521**, naziv dela / crtež / materijal =
   „OPŠTI NALOG", količina **100000** (kao legacy — da `reachedPlan` nikad ne okine;
   guard „preko plana" ionako preskače `withoutProcess`, `:2611-2630`). Komitent: interni
   Servoteh (proveriti id internog komitenta u `customers`; legacy papir nema komintenta).
3. **Dodati operaciju** RC `0.0` na taj RN (`addOperation`, `work-orders.service.ts:717-780` —
   validira da RC postoji u šifarniku).
4. **Odštampati novi papir sa 3.0 barkodovima** (postojeća štampa RN-a,
   `work-order-print.service.ts`) — nosi novi ident (npr. `4521/1`) i ispravne barkodove.
   Stari papir iz 2018. povući iz pogona.
5. **Proba kucanja:** START + STOP na `0.0` sa dve kartice (posle Stavke 1!).
6. **NE aktivirati predmet 4521 u praćenju** (`predmet_aktivacije`) — opšti nalog nije
   proizvodni predmet i ne treba mu mesto u portfoliju/kontrolnoj tabli; kucanje radi i bez
   aktivacije. (Filteri `is_active` postoje samo u pregledima praćenja:
   `pracenje-read.service.ts:398, :555, :1352`.)
7. **Verifikacija za Opusa (kod, bez izmene):** proveriti da `markWorkOrderIfComplete`
   (`tech-processes.service.ts`, poziv iz `accumulateStopWork:2659`) ne može da „završi" RN
   čija je jedina operacija `0.0` — ako može, izuzeti `withoutProcess` RN iz te logike.

---

## STAVKA 3 (prioritet 3 — feature): mail odbijenice generatoru nacrta primopredaje

### Utvrđeno stanje

- Generator nacrta = `handover_drafts.designer_id` (`schema.prisma:502`); pri submit-u nacrta
  se kopira u `drawing_handovers.handover_worker_id` (`handover-drafts.service.ts:1269`) —
  dakle svaka primopredaja VEĆ nosi ID generatora.
- Odbijanje: `HandoversService.reject()` (`handovers.service.ts:625-645`,
  `POST /handovers/:id/reject`, razlog obavezan → `status_change_comment`) i `rejectBatch()`
  (`:527-545` → `batchTransition` `:553-623`). Status `REJECTED = 2` (`:44-49`).
- Mail infrastruktura POSTOJI: `MailService` (Resend) u `backend/src/common/mail/`,
  `@Global()` modul, `send()` nikad ne baca (D8). Gotov obrazac in-app + mail:
  `HandoverDraftsService.notifyApprover()` (`handover-drafts.service.ts:525-557`).
- Email radnika: `workers` NEMA email; razrešava se preko `users`
  (`users.worker_id → users.email`, `schema.prisma:1869, :1884`).
- `HandoversService` trenutno injektuje samo `NotificationsService` (`handovers.service.ts:170-173`).

### Šta uraditi

1. U `HandoversService` injektovati `MailService` (modul je globalan — bez izmene modula).
2. Nova privatna metoda `notifyRejected(rejected: {id, handoverWorkerId, drawingId}[], reason,
   actor)` po uzoru na `notifyApprover`: POSLE transakcije, best-effort, svaki kanal u svom
   try/catch:
   - grupisati po `handoverWorkerId` → **jedan mail po generatoru** sa listom odbijenih
     crteža (broj + naziv, preko relacije ka `drawings`), razlogom i imenom odbijača
     (`actor`); subject npr. „Primopredaja odbijena — <broj crteža / N stavki>";
   - email preko `prisma.user.findFirst({ where: { workerId }, select: { email, fullName } })`
     — ako radnik nema `users` nalog, samo logovati i preskočiti (bez greške);
   - uz mail i in-app notifikacija (`NotificationsService.notifyWorkers`) — isti sadržaj.
3. Hook mesta: `reject()` posle uspešnog `transition()`; `rejectBatch()` posle
   `batchTransition()` — **proširiti `batchTransition` da vrati ID-jeve stvarno prebačenih**
   redova (danas vraća samo brojeve), pa mailovati samo njih.
4. `.env.example`: dodati `RESEND_API_KEY` i `RESEND_FROM` (koriste se u kodu, a nema ih —
   pravilo br. 10 iz backend/CLAUDE.md). Bez ključa MailService je ionako DRY-RUN.
5. Testovi (`handovers.service.spec.ts`): reject šalje tačno jedan mail generatoru sa razlogom;
   approve NE šalje; generator bez `users` naloga → bez izuzetka; batch sa 3 stavke istog
   generatora → jedan mail sa 3 stavke.

---

## STAVKA 4 (HITNO — prioritet 0): skener ne čita barkod na nalepnicama iz 3.0

### Prijava

„Da li si promenio izgled barkoda slučajno ili namerno u 3.0 u odnosu na 1.0? Ovaj novi izgled
neće da čita." Fotografije: nalepnica 15-06-26 (1.0, čita se) vs 16-07-26 (3.0, ne čita se).

### Utvrđeni uzrok (verifikovano u kodu OBA repoa)

Promena je **nenamerna posledica promene puta štampe**, ne svesna promena izgleda:

1. **1.0 je nalepnicu dela štampao kroz BROWSER** (`printTechProcessLabelsBatch` →
   `window.open` + JsBarcode SVG + `window.print()`, Windows drajver;
   `servoteh-plan-montaze/src/ui/lokacije/labelsPrint.js:1200-1281`). TSPL2 na TCP 9100 je bio
   samo opcioni paralelni kanal „ako proxy postoji" (`:1262-1280`). Otud na staroj nalepnici
   proporcionalni fontovi i **deblji moduli barkoda** (SVG se skalira u okvir nalepnice —
   efektivno ~0,25–0,30 mm po modulu).
2. **3.0 štampa isključivo RAW TSPL2** na TSC ML340P
   (`frontend/src/lib/tspl2.ts:117` → `BARCODE …,"128M",…,0,0,2,4,…`; transport
   `backend/src/common/printing/label-print.service.ts`, TCP 9100). `narrow=2` na 300 DPI =
   **0,169 mm po modulu** — znatno tanje linije nego što je pogon ikad skenirao. Otud i
   „monospace" izgled teksta (interni TSC fontovi umesto browser fontova).
3. **Sadržaj je usput i duži:** 3.0 enkodira `RNZ:{projectId}:{identNumber}:{variant}:{revision}`
   (`backend/src/modules/tech-processes/barcode.ts:327-349`, poziv iz `buildLabelData`,
   `tech-processes.service.ts:4069-4118`), dok je 1.0 slao `RNZ:0:{nalog}/{tp}:0:0`
   (`barcodeParse.js:308-331`). Kod Code128 sa fiksnim `narrow` duži sadržaj NE stanjuje
   linije nego ŠIRI barkod (~41 mm → ~51 mm za tipičan sadržaj) — još uvek staje na nalepnicu,
   ali BLOKIRA rešenje „samo podebljaj module": sa `narrow=3` tipičan 3.0 sadržaj (~299
   modula ≈ 76 mm) NE staje u raspoloživih ~71 mm (širina 80,34 mm − 7 mm leva margina −
   quiet zona).
4. Softverski parseri NISU problem: i kiosk `parseBarcode` (5 polja) i lokacijski
   `parseBigTehnBarcode` (koji je pravljen baš za legacy `RNZ:0:…` oblik!) prihvataju oba
   sadržaja. Ne čita FIZIČKI skener. RN A4 papiri (laserska štampa, veći barkod) se zato
   normalno skeniraju od cutover-a.

### Ispravka (za Opusa — backend + frontend, jedan PR)

Cilj: modul ≥ 0,25 mm (kao što je pogon čitao kod 1.0), bez prelivanja preko 80 mm.

1. **Skrati sadržaj barkoda NALEPNICE na legacy oblik** `RNZ:0:{identNumber}:0:0`:
   u `buildLabelData` (`tech-processes.service.ts:4069-4118`) za nalepnicu koristiti
   legacy-kompatibilan kratki oblik umesto punog `formatOrderBarcode`. RN A4 papir
   (`work-order-print.service.ts`) ZADRŽAVA pun oblik — tamo skeniranje radi.
2. **Ident-only fallback pri skeniranju:** `findCurrentWorkOrder` (`tech-processes.service.ts:
   3676-3687`) — kad je `projectId === 0` (legacy/kratki barkod), traži po `identNumber`
   samo; ako ident postoji u VIŠE predmeta → 422 sa jasnom porukom (ne pogađati). Proveriti
   i `control()`/`scan()` pozivaoce da prosleđuju 0 bez prepakivanja. (Ovim automatski
   prorade i STARE 1.0 nalepnice koje su već po pogonu!)
3. **Podebljaj module:** u `buildTspLabelProgram` (`frontend/src/lib/tspl2.ts:117`)
   `narrow` 2→3 uz AUTO-FALLBACK: proceni broj modula iz sadržaja (Code128: ~11 modula po
   znaku + 35 režijskih; za parove cifara 5,5) i ako `narrow=3` ne staje u ~71 mm, spusti na
   2 uz `console.warn`. Kratki sadržaj (`RNZ:0:9811-17/158:0:0` ≈ 266 modula ≈ 67,6 mm na
   narrow=3) staje; time modul postaje 0,254 mm ≈ ono što je browser-štampa iz 1.0 davala.
4. **Test u pogonu pre šireg puštanja:** odštampati probnu nalepnicu i skenirati ručnim
   skenerom sa kioska (i na lokacijama) — tek onda zatvoriti stavku. Ako i narrow=3 ne čita
   pouzdano, sledeća poluga je štampa preko `BITMAP` komande (server-side bwip-js PNG →
   TSPL2 BITMAP) — tek ako zatreba.

Napomena: NE dirati štampač (SIZE/GAP/DENSITY su read-only po dizajnu), ne dirati RN A4
barkodove, ne dirati lokacijske/reversi nalepnice (kratki sadržaji — njihova gustina nije
sporna).

## Redosled izvođenja i obim

| # | Stavka | Tip | Obim |
|---|--------|-----|------|
| 4 | **HITNO: barkod nalepnica (skener ne čita)** | backend + frontend + proba u pogonu | ~pola dana |
| 1 | Kiosk više radnika (guard + dijalog) | backend + frontend + testovi | ~1 dan |
| 2 | Opšti nalog nosač-RN | operativno (runbook) + 1 provera koda | ~1-2 h |
| 3 | Mail odbijenice | backend + testovi | ~pola dana |

Stavke su nezavisne — svaka svoj PR/commit (Conventional Commits, engleski; scope
`tech-processes` / `work-orders` / `handovers`). Stavku 2 izvesti POSLE deploy-a Stavke 1
(inače dva radnika na opštem nalogu odmah reprodukuju bag).

## Podrazumevane odluke (primenjene u planu; prijaviti ako se menjaju)

1. „Kraj rada" bez izbora zatvara SAMO svoj rad kad drugi rade (bezbedan default); gašenje za
   sve je eksplicitan izbor u dijalogu.
2. Pri svakom gašenju reda operacije tuđe otvorene sesije se zatvaraju sa 0 komada i očuvanim
   vremenom (nema siročića).
3. `reachedPlan` i dalje gasi red i kad drugi rade (plan je plan) — uz higijenu iz tačke 2.
4. Jedan mail po generatoru po akciji odbijanja (ne po stavci).
5. Opšti nalog se NE aktivira u praćenju (nije proizvodni predmet).
