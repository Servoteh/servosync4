# Plan — pretraga u Realizaciji, filter dropdown-a nacrta, PDF dugme u nacrtu (2026-07-20)

Tri zahteva korisnika (Igor Voštić / projektni biro + tehnologija), snimljena sa screenshot-ova
20.07.2026. Analiza: Fable (5 paralelnih čitača), izvođenje: Opus agenti.

## Zahtev 1 — Pretraga u Realizaciji (praćenje delova)

**Stanje:** `SearchBox` na tabu „Kucanja" već postoji (`frontend/src/app/tech-processes/page.tsx:194`)
i backend `q` pokriva ident RN, `work_orders.drawing_number` i `part_name`
(`tech-processes.service.ts:324-344`). Ali:

- pretraga po **broju nacrta** (G-yymmdd-nnn) ne radi — nacrt nije dostižan iz kucanja;
- pretraga po **broju crteža sklopa** nalazi samo kucanja samog sklopa, ne i delova
  (zato Ctrl+F „1140215" → 0/0 dok delovi 1140204/1140208/1140209/1140210 postoje).

**Rešenje:** proširiti semantiku postojećeg `q` u `TechProcessesService` novim privatnim
helperom `expandSearchWorkOrderIds(q)` koji vraća dodatne `workOrderId`-jeve iz dva izvora:

1. **Broj nacrta:** `handover_drafts.draft_number ILIKE %q%` → `handover_draft_items.drawing_id`
   → `work_orders` (preko `drawing_id`, fallback preko `drawings.drawing_number`).
2. **Sklop → delovi:** `drawings.drawing_number = q` (exact, case-insensitive) → deca preko
   iste tabele koju koristi PDM BOM (`GET /v1/pdm/drawings/:id/bom` — proveriti u
   `pdm.service.ts` da li je `drawing_components` ili `drawing_assemblies`; koristiti isti izvor),
   rekurzivno sa cycle-guard-om i cap-om → `work_orders` dece **filtrirano na puštene**
   (`handover_status_id = 3` — LANSIRAN; konstanta kao u `handovers.service.ts:44-49`).

Dobijeni ID-jevi se dodaju u postojeći `filter.OR` kao `{ workOrderId: { in: [...] } }`.
Ista ekspanzija se primenjuje i na `rn-progress` (tab „Gotovost RN") — tamo se vidi i deo
koji je pušten a još nema kucanja (planirano vs urađeno), što je suština „praćenja delova".

Guard-ovi: ekspanzija samo za `q.trim().length >= 3`; scope (`withTechProcessScope`) ostaje.
FE: samo placeholder-i („RN / crtež / naziv / nacrt / sklop…").

## Zahtev 2 — Dropdown „Izaberi nacrt…" (PDM → Dodaj u nacrt)

**Stanje:** `useOpenDraftsLookup` → `GET /v1/handover-drafts?isLocked=false&pageSize=200` —
već isključuje zaključane, ali lista nacrte **svih** korisnika. FE ne može da filtrira sam:
`PublicUser` namerno ne nosi `workerId` (JWT-interno, `auth.service.ts:154`).

**Rešenje (server-side):**

- `ListHandoverDraftsQuery` + novi param `mine`; `list()` u kontroleru dobija `@Req() req`
  i prosleđuje `req.user` servisu.
- U servisu: ako je `mine === "true"` → `resolveActorWorkerId(prisma, actor)`
  (`backend/src/common/workers/resolve-actor-worker.ts`) → `where.designerId = workerId ?? -1`
  (nalog bez povezanog radnika ⇒ prazna lista — poznata posledica, „Novi nacrt" i dalje radi).
- FE: `useOpenDraftsLookup` šalje i `mine=true`. Ostale liste (strana /nacrti) se NE menjaju.

## Zahtev 3 — PDF dugme u detalju nacrta primopredaje

**Stanje:** STAVKE tabela u detalju (`buildItemColumns`, `drafts-tab.tsx:804-898`) nema PDF
dugme; crveni pravougaonici na screenshotu su pored naziva svake stavke. U create/edit formi
već postoji `DraftItemPdfButton` (`drafts-tab.tsx:260-288`) → `openDrawingPdf(drawingId)`
(`api/pdm.ts:11`). `DrawingRef` u detalju ne nosi `hasPdf`.

**Rešenje:**

- Backend: `GET /v1/handover-drafts/:id` — obogatiti drawing ref stavki sa `hasPdf`
  (batch upit nad `drawing_pdfs` po parovima `(drawing_number, revision)`, bez učitavanja
  blob-a — pattern kao `print-bundle.service.ts` `loadPdfMeta`).
- FE: u koloni „Naziv" detalja, odmah pored naziva, malo PDF ikonica-dugme (reuse
  `DraftItemPdfButton`) kad stavka ima `drawing.id`; disabled/skriveno kad nema PDF-a.

## Izvođenje i verifikacija

- 2 paralelna **Opus** agenta: (A) Zahtev 1 — modul `tech-processes` + FE placeholder-i;
  (B) Zahtevi 2+3 — modul `handovers` + FE (`handovers.ts`, `drafts-tab.tsx`). Fajlovi
  disjunktni, `schema.prisma` se ne dira (nema migracija).
- Verifikacija: `tsc --noEmit` + lint (backend i frontend); review agenti nad diff-om
  izmenjenih fajlova; ispravke po nalazima.
- Pre eventualnog push-a backend-a važi boot-smoke pravilo (`node dist/main`).
- Bez commit-a — izmene ostaju u radnom stablu na `feat/4.0-faza1` dok korisnik ne pregleda.
