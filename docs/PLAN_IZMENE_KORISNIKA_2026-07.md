# Plan rada — izmene korisnika (jul 2026)

Izvor: `docs/zahtevi/Servosync izmene korisnika.docx` + prijava baga „Prijavi kvar" (forma se
sama zatvara). Analiza: Fable multi-agent (8 agenata, potvrđeni uzroci sa file:line dokazima).
Izvođenje: Opus, po radnim paketima ispod — paketi unutar iste faze mogu paralelno (multi-agent),
faze redom. Svaki paket nosi svoje testove.

## Status izvođenja (18.07.2026)

- **FAZA 0 (B1–B5)** — ✅ urađeno i verifikovano (radno stablo, nije komitovano)
- **FAZA 1 (U1–U4)** — ✅ urađeno i verifikovano
- **FAZA 2 (R1, R2)** — ✅ urađeno i verifikovano; migracija indeksa **napisana ali NIJE primenjena**
- **FAZA 3 (K1)** — ✅ urađeno i verifikovano; migracija `responsible_party` **napisana ali NIJE primenjena**
- **FAZA 4 (S1–S5)** — ✅ kod urađen i verifikovan; **SQL napisan ali NIJE izvršen** (v. čeklistu dole)

### sy15 SQL — čeka ručnu primenu (ništa nije pokrenuto)

Folder: `backend/docs/sql/sy15/sastanci-lifecycle-2026-07-18/` — primeniti kao `supabase_admin`,
ovim redom. Svaki fajl ima zaglavlje (zašto / kako se primenjuje / verifikacija) i rollback blok.

1. `00_preflight_checks.sql` — **samo čitanje**, pokrenuti prvo i sačuvati izlaz (proverava da su
   imena slobodna, da `sast_enqueue_cancel` nema `authenticated` grant, i koliko sastanaka/akcija
   dira čišćenje).
2. `10_sastanci_cancel_sastanak.sql` — funkcija za otkazivanje + grant (šalje `meeting_cancel` mejl
   pozvanima). Guard je namerno **stroži** od `sast_zakljucaj_sastanak`.
3. `20_sast_auto_zatvori_stale.sql` — auto-zatvaranje + pg_cron u 03:30. Nikad ne piše `zakljucan`,
   nikad ne šalje mejl.
4. `30_cleanup_stale_sastanci.sql` — jednokratno čišćenje. **Tek pošto se otvorene akcije prenesu**
   kroz UI. ⚠️ NE pokretati kroz `psql -f` (UPDATE nije u transakciji — pratiti zaglavlje).
5. `40_sastanci_template_id.sql` — nezavisno od 1–4; posle primene re-introspektovati `sy15.prisma`
   i zameniti heuristiku pravim JOIN-om (TODO stoji u `sastanci.service.ts`).

**Migracije — PRIMENJENE 18.07.2026** na produkcionu bazu (`192.168.64.28:5435`, uz izričitu
dozvolu vlasnika), verifikovano upitom: `responsible_party VARCHAR(50)` postoji,
`idx_work_orders_drawing_id` i `idx_work_orders_drawing_number_lower` kreirani, oba reda u
`_prisma_migrations` sa `finished_at`. Napomena: lokalna dev baza (`localhost:5435`) na Nenadovoj
mašini ne postoji — nema Docker-a; radi se direktno na serversku bazu (v. `docs/infra/INFRASTRUKTURA.md`;
podatak da `admnenad` nije u `docker` grupi je zastareo — jeste).

**Select komponenta — URAĐENA kako treba:** `frontend/src/components/ui-kit/select.tsx` + novi
`/dev/ui` katalog + DESIGN_SYSTEM §10; polje „Odgovoran" je koristi. Otvoreno za odluku:
`/dev/ui` ruta je bez autentikacije i ide u prod bundle; ostalih ~290 sirovih `<select>` u ~125
fajlova nije migrirano (usvajaju kit Select kako se ti ekrani budu dirali).

## Donete odluke (potvrdio Nenad, 18.07.2026)

1. **Neaktivni sastanci**: bez tvrdog brisanja — zastareli → status `otkazan` (bez mejlova),
   otvorene akcije se prenesu na tekući sedmični; ubuduće **auto-pravilo** (planiran→otkazan,
   u_toku→zavrsen, 7 dana posle datuma).
2. **Odgovoran**: fiksna lista, jedan izbor — `izvrsilac | kontrolor | masina | materijal |
   tehnologija | ostalo` (String kolona, ne Prisma enum — BACKEND_RULES §2).
3. **Izveštaj o broju neusaglašenosti**: podrazumevano **Svi** (škart + dorada) uz vidljivu
   napomenu šta je uključeno; kartice prelaze na serverski ukupan zbir.
4. **sy15 (1.0) baza**: dozvoljene **male aditivne izmene** (cancel funkcija + pg_cron
   auto-close), po šablonu postojećih `sast_*` funkcija.

---

## FAZA 0 — Bagovi (P0, odmah)

### B1 — Dialog: „Prijavi kvar" se sam zatvara [S] ✅ POTVRĐEN UZROK
Backdrop u `frontend/src/components/ui-kit/dialog.tsx:43-47` ima `onClick={onClose}`; drag-select
teksta koji se završi van panela okida click na backdrop-u → dijalog se unmount-uje i unos propada.
Ista mana u svih ~135 potrošača Dialog-a.
- `dialog.tsx`: zatvaranje po **poreklu pritiska** — `onMouseDown` beleži da li je press počeo na
  backdrop-u (`e.target === e.currentTarget`), `onClick` zatvara samo ako su i press i release na
  backdrop-u (obrazac već postoji u `command-palette.tsx:208-209`).
- `dialog.tsx`: nov opcioni prop `dismissable?: boolean` (default `true`) — kad je `false`,
  backdrop klik i Escape NE zatvaraju (samo X / Otkaži).
- `prijava-kvara-dialog.tsx` (:166-168): `dismissable={false}`; isto za `EditMachineModal`
  (`masina-karton.tsx:515`) i druge dijaloge sa unosom na toj strani.
- `masina-karton.tsx:174` (+ `sredstvo-karton.tsx:140`, `vozilo-karton.tsx:176`): skloniti
  `d &&` mount-gate oko dijaloga — podatke mašine snimiti u state pri otvaranju.
- Test: ručno — kucanje + drag-select u Naslov/Opis, Escape, klik na backdrop; e2e smoke ako postoji.

### B2 — Kvalitet: kolona „Ističe" uvek „—" [S] ✅ POTVRĐEN UZROK
Backend šalje `raisedByWorker` (`kvalitet.service.ts:1392`), frontend čita `raisedBy`
(`api/kvalitet.ts:85`, `evidencija-tab.tsx:95`, `report-detail.tsx:60`). „Ističe" = kontrolor
koji je pokrenuo izveštaj (auto-popunjeno sa kiosk kontrola) — kolona OSTAJE, samo se popravlja.
- Frontend-only: preimenovati polje interfejsa u `raisedByWorker` + dva čitaoca.

### B3 — Kvalitet: duplirani Izvršioci [S] ✅ POTVRĐEN UZROK
`culpritSummary` (`helpers.tsx:192-199`) spaja M:N imena radnika + slobodan tekst
`culpritText` u kome su ista imena ponovo otkucana. DB NE sadrži duplikate (unique constraint).
- Dedupe pri prikazu: Set lowercased/trimmed imena iz M:N; iz `culpritText` (split po zarezu)
  dodati samo delove koji već nisu u setu.
- Provera na produkciji (SQL u §Verifikacije) pa odlučiti o jednokratnom čišćenju `culprit_text`.

### B4 — Izveštaji: „311,875 sati" čita se kao 311 hiljada [S] ✅ POTVRĐEN UZROK
Nije duplo sabiranje: `formatNumber` (sr-RS, 3 decimale) renderuje 311.875 h sa decimalnim
ZAREZOM — vizuelno identično engleskom hiljadarskom zapisu. Veliki iznosi sati za škart su
očekivani (formula Σ(Tpz + Tk×qty) po operacijama do škarta, `nonconformity-calc.ts:40-51`)
i ne vide se u Evidenciji (tamo nema kolone Sati) — otud „nema toliko u tabelama".
- `izvestaji-tab.tsx:127,189`: prikaz sati kao `formatDecimal(x, 2) + " h"` → „311,88 h".

### B5 — Izveštaji: kartice = klijentski zbir grupisanih redova [S/M]
Kod grupisanja po radniku backend namerno pripisuje izveštaj SVAKOM krivcu
(`kvalitet.service.ts:796-801,815-827`) → kartice se duvaju, izveštaji bez krivca nestaju.
- Backend `summary()` (:689-735): dodati `meta.totals` (jedan negrupisan COUNT/SUM upit,
  reuse `reportWhere`); frontend kartice čitaju `meta.totals` umesto redukcije redova.
- Bonus (usput, isti fajlovi): uskladiti summary-mini oblik (BE :575-581 vs FE
  `api/kvalitet.ts:125-128`) da draft badge na tabovima prestane da prikazuje 0.

---

## FAZA 1 — Brze UI izmene (P1)

### U1 — Izveštaji: preimenovanja + naslov + napomena [S]
`frontend/src/app/kvalitet/_components/izvestaji-tab.tsx`:
- header kolone :102 „Izveštaja" → „Broj neusaglašenosti"; :124 „Sati" → „Utrošeno sati";
- StatCard :187 „Izveštaja" → „Broj neusaglašenosti"; :189 „Sati" → „Utrošeno sati";
- naslov `<h2>` iznad filtera: **„Izveštaj o broju neusaglašenosti"** (tab label ostaje „Izveštaji");
- vidljiva napomena kad je Tip=Svi: „Uključuje škart i doradu" (odluka #3).

### U2 — Evidencija škarta/dorada: izbaciti Status filter [S]
`evidencija-tab.tsx` (deljen za oba taba): obrisati Status blok (:164-178), `status` state (:104),
ključ u pozivu hooka (:116), pominjanja u `hasFilter` (:123) i Očisti (:184). Backend ostaje.
„Nacrt" badge u koloni Br. izveštaja i dalje razlikuje nacrte.

### U3 — Evidencija: izbaciti kolonu Kupac [S]
`evidencija-tab.tsx:56-60` obrisati kolonu; Kupac ostaje u detalju/formi. Iz placeholder-a
pretrage (:137) skloniti „kupac" (backend `q` ionako ne pretražuje kupca).

### U4 — Sastanci Pregled: labela „Sast. 14 dana" [S]
Metrika = planirani sastanci u narednih 14 dana (uklj. danas) — `pregled-tab.tsx:88`.
- Labela → **„Predstoji (14 d)"**; tooltip: „Zakazani (planirani) sastanci u narednih 14 dana,
  računajući i danas. Ne uključuje sastanke u toku, završene ni otkazane."
- Napomena za kasnije (ne sada): metrika je skoro konstantna (~1) — kandidat za zamenu.

---

## FAZA 2 — RN pretraga i kolone (P1)

### R1 — PDM / Crteži: RN filter + RN kolona [M]
Veza crtež↔RN postoji u `work_orders` (ne u `drawings.work_order_ref`, koji je legacy CAD tekst).
**Pravilo poklapanja** (isto za filter i kolonu): `w.drawing_id = d.id OR
lower(w.drawing_number) = lower(d.drawing_number)` (ogledalo `resolveDrawingIdByNumber`).
Jedan crtež može imati VIŠE RN-ova (varijante, relansiranja, `-D`/`-S` deca).
- BE `pdm.service.ts`: `rn?` u `ListDrawingsQuery`; generalizovati raw putanju
  (`listDrawingsWithPdfFilter` → `listDrawingsRaw`) i dodati EXISTS uslov sa
  `w.ident_number ILIKE %rn%` + OR `d.work_order_ref ILIKE %rn%` (legacy fallback);
  rutirati kroz raw kad je `hasPdf || rn`.
- BE kolona: batch resolver `resolveWorkOrderRefs` u postojećem `Promise.all` (:236-239) —
  jedan upit po strani, grupisanje po pravilu, dedupe po `identNumber`, `workOrders[]` (cap 5)
  + `workOrderCount`.
- Migracija: indeksi `idx_work_orders_drawing_id` + raw `CREATE INDEX ... ON work_orders
  (lower(drawing_number))` (`npm run migrate:dev`).
- FE `api/pdm.ts` + `drawings-tab.tsx`: `rn` param + input „RN" (pored Revizije, placeholder
  „npr. 9400/3"), kolona RN posle Naziva: 1–2 inline, više → „prva 2 +N" (pun spisak u
  postojećem expanded detalju); bez RN-ova → `workOrderRef` izbledeo ili „—". tnums.
- Testovi: `pdm.service.spec.ts` — filter u obe putanje + grupisanje/dedupe resolvera.

### R2 — Primopredaje: RN filter [S]
Kolona RN „—" u Odobrene je OČEKIVANO (RN se vidi samo u prolaznom stanju „otkucan a
nelansiran"; lansiranjem red napušta tab). Zato filter ide na **Odobrene I Sve primopredaje**
(jedini tab gde se lansiran RN i dalje vidi).
- BE `handovers.service.ts`: `rn?` u `ListHandoversQuery`; pre-resolve handover id-jeva preko
  `workOrder.findMany({ identNumber contains, drawingHandoverId gt 0 })` → `where.id in [...]`.
- FE `api/handovers.ts` + `approved-tab.tsx` + `all-handovers-tab.tsx`: poseban SearchBox
  „Broj RN…" pored postojeće Pretrage; Očisti reset.
- Test: `handovers.service.spec.ts` describe('list').

---

## FAZA 3 — Kvalitet: kolona „Odgovoran" (P2) [M]

Novo polje — ništa postojeće nije upotrebljivo (odluka #2: fiksna lista, jedan izbor).
- Prisma: `responsibleParty String? @map("responsible_party") @db.VarChar(50)` na
  `NonconformityReport` (schema.prisma ~:2080) + `///` komentar sa dozvoljenim vrednostima
  `izvrsilac | kontrolor | masina | materijal | tehnologija | ostalo`; `npm run migrate:dev`.
- BE: create/update DTO whitelist validacija; `createReport`/`updateReport`/`mapReport`.
- FE: tip + input (`api/kvalitet.ts`), `ReportFormState`/`emptyForm`/`formFromReport`/
  `formToInput` (`helpers.tsx`), `<select>` „Odgovoran" u žutoj Kontrola sekciji
  (`report-fields.tsx`, pored Izvršilaca), kolona „Odgovoran" u `evidencija-tab.tsx`.
- Kasnije (posebna odluka): Odgovoran kao groupBy dimenzija u Izveštajima.

---

## FAZA 4 — Sastanci: životni ciklus i termini (P2)

sy15 izmene su odobrene kao male aditivne (odluka #4); idu kao managed SQL uz 1.0 šablon
`sast_*` funkcija + re-introspekcija `backend/prisma/sy15.prisma` gde treba.

### S1 — Jednokratno čišćenje zastarelih [S/M]
- Pre čišćenja: prenos otvorenih akcija (otvoren/u_toku) na tekući sedmični —
  postojeći `POST /:id/prenos` semantika.
- Zatim maintenance SQL na sy15: `UPDATE sastanci SET status='otkazan', updated_at=now()
  WHERE status IN ('planiran','u_toku') AND datum < current_date - INTERVAL '7 days'`
  (direktan PATCH/UPDATE NE šalje mejlove — `sast_enqueue_cancel` se ne poziva). Trigeri
  bezbedni (`sast_check_not_locked` čuva samo zaključane).
- FE: u status filter (`sastanci-tab.tsx:70-74`) dodati opcije `otkazan`/`zavrsen`.

### S2 — Otkazivanje sa obaveštenjem učesnicima [M]
- sy15: nova DEFINER fn `sastanci_cancel_sastanak(uuid)` (guard kao lock: edit rola ∧
  mgmt∨organizator; `SET status='otkazan'`; `PERFORM sast_enqueue_cancel(id)` → postojeći
  `meeting_cancel` mejl svim `pozvan=true`). Bez direktnog GRANT-a na `sast_enqueue_cancel`.
- BE: `POST /v1/sastanci/:id/cancel` po uzoru na `lock()` (`sastanci.service.ts:879`).
- FE: dugme „Otkaži sastanak" (status planiran/u_toku, uz confirm) u `sastanak-detalj.tsx`
  header + `useCancelSastanak`.

### S3 — Auto-zatvaranje [S]
- sy15 pg_cron pored postojećeg `sast_auto_create_weekly`: fn `sast_auto_zatvori_stale(7)` —
  `planiran→otkazan`, `u_toku→zavrsen` za `datum < current_date - 7`. NIKAD auto-`zakljucan`
  (lock ide samo kroz `sast_zakljucaj_sastanak` — arhiva + obavezni mejlovi).

### S4 — Promena termina pojedinačnog sastanka [M]
Serija se već menja u tabu Šabloni (TemplateModal) — važi za buduće instance; to dokumentovati
u tooltip/uputstvu. Za već kreirane termine:
- FE: „Uredi" (naslov/datum/vreme/mesto) u `sastanak-detalj.tsx` header preko postojećeg
  `useUpdateSastanak` (paritet 1.0 meta-edit) + posle izmene ponuditi postojeće „Pošalji
  ponovo" (`POST /:id/invites` ima re-send semantiku → učesnici dobiju nov .ics). Slanje
  ostaje ručni korak (bez auto re-send).
- Kolona VREME: dodati header tooltip „Planirano vreme". (14:44 je podatak — red „Presek
  stanja — Perun" kreiran ad-hoc sa ručnim vremenom, nije iz šablona; po želji mgmt reopen →
  PATCH vreme 14:00 → ponovni lock.)

### S5 — Kolone „poslednji / sledeći sastanak" [M]
Prirodno mesto: tab **Šabloni** (po seriji).
- „Sledeći termin": computed `nextOccurrence(tpl)` u `listTemplates` (`sastanci.service.ts:557`)
  kroz postojeći `templates-cadence.ts` — bez DB izmena.
- „Poslednji sastanak": aditivna kolona `template_id uuid NULL` u sy15 `sastanci` + upis u
  instantiate (:1871) + backfill; do backfill-a fallback heuristika max(datum) po
  naslov=tpl.naziv.

---

## Verifikacije na produkciji (uz Fazu 0, read-only)

1. **Jul 2 vs 1**: `GET /v1/kvalitet/reports?from=2026-07-01&to=2026-07-31&status=1` — očekuje
   se 1 škart + 1 dorada; ako su 2 škarta za isti događaj (auto-draft + ručni), obrisati
   duplikat i razmotriti upozorenje na isti `sourceTechProcessId` u report-dialogu.
2. **Duplirani izvršioci**: `SELECT r.id, r.culprit_text, string_agg(w.full_name, ', ')
   FROM nonconformity_reports r JOIN nonconformity_workers nw ON nw.report_id=r.id
   JOIN workers w ON w.id=nw.worker_id GROUP BY r.id, r.culprit_text
   HAVING r.culprit_text IS NOT NULL;` + provera duplih imena u `workers`.
3. **Presek stanja — Perun**: `GET /v1/sastanci/:id` — potvrda `createdAt ≈ 16.07. 14:4x`
   (ad-hoc kreiranje).
4. **Primopredaje RN**: `SELECT count(*) FROM work_orders wo JOIN drawing_handovers dh
   ON wo.drawing_handover_id=dh.id WHERE dh.status_id=1;` — ako >0 a UI sve „—", reopen kao bag.

## Redosled i procena

| Faza | Paketi | Procena | Zavisnosti |
|------|--------|---------|------------|
| 0 | B1–B5 | ~1 dan | — |
| 1 | U1–U4 | ~0,5 dana | B4/B5 za U1 (isti fajl) |
| 2 | R1, R2 | ~1 dan | — (paralelno sa 1) |
| 3 | K1 | ~0,5–1 dan | migracija pre FE |
| 4 | S1–S5 | ~1,5–2 dana | S2 pre S3 (deli sy15 pristup); S5 posle S4 |

Posle svake faze: `npm test` + lint (backend), build (frontend), e2e smoke (`e2e/`), pa deploy
po pravilima iz korena `CLAUDE.md`.
