# ServoSync 3.0 — RADNI PLAN (jedno mesto: šta je urađeno + šta ostaje)

> Radni checkpoint u monorepou **servosync4**. Ovde se nastavlja rad „sa jednog mesta".
> Prateće: migracija u monorepo → [MONOREPO_MIGRACIJA.md](MONOREPO_MIGRACIJA.md) · detaljni plan verzija →
> [../backend/docs/ROADMAP.md](../backend/docs/ROADMAP.md) · playbook → [../backend/docs/MIGRACIJA_3.0_PLAYBOOK.md](../backend/docs/MIGRACIJA_3.0_PLAYBOOK.md).
> **Datum:** 2026-07-18.

---

## 0. Gde smo — TL;DR

- **3.0-PRODUKT** („migriramo sve u jednu aplikaciju") = ✅ **DOSTIGNUTO 17–18.07** (svi 1.0 moduli na 2.0, jedan shell, jedan login).
- **Kod se konsoliduje u ovaj monorepo** (`Servoteh/servosync4`). Migracija Faza 1–3 ✅, **Faza 4 (zatvaranje) ostaje**.
- Za **3.0-ZAVRŠEN** ostaje: **Blok B (dekomisija legacy sloja)** + **Blok C (kvalitet+sigurnost, u toku)**.

---

## 1. Šta je urađeno

**3.0 unifikacija (17–18.07):**
- Svi 1.0 moduli cutover-ovani na 2.0 (FE `759eeae` uklonio „Razvojna faza" skelu).
- Shell v2: sidebar (full/rail/hidden) + Ctrl+K + `/pocetna` HUB + landing po ulozi + nav-reorg + dark/light.
- **Hard-flip** `servosync.servoteh.com` → 2.0 + **native auth** (58 GoTrue lozinki) + refresh-token rotacija.
- Per-modul cutover-auditi 17.07 svi **GO** (Energetika 18/18, Kadrovska 1v2, Lokacije 13/13, Plan+Praćenje 8/8, Održavanje NO-GO→GO posle F2, PB 3-agent CLEAN).

**Kvalitet / e2e (18.07) — harness `e2e/`** (gađa živi front, 1 admin nalog; `npm test` + `npm run summary`):
- **Smoke 34/34** modula 🟢 (navigacija+render+tab-klik, 0 crash/5xx/console).
- **Native core read-only** e2e (`core-read.spec.ts`) 5/5 — hvata orphan-FK 500 na detalj-GET.
- **Net-zero write probe** 4 modula (Reversi/Kadrovska/Kvalitet/RN create→delete / edit→revert), nula rezidua.
- **Permission matrica (C1)** — sletela na **core module**: `test/*-permissions.e2e-spec.ts` za work-orders,
  tech-processes, pdm, kvalitet, mrp, structures, handovers, cnc-programs, part-locations + `route-permission-coverage`, **CI-gated**.
- **Preventivni sweep** → **3 realna prod buga nađena i popravljena** (dokaz da harness hvata stvarno):
  - `/profil` crash (tim → zaposleni) — shape objekat-vs-niz → `tools.map` (FE `e1ffcd8`).
  - `/profil` „Prisustvo" day-drill crash — isti class (FE `277306f`).
  - PB „Snimi" **409 svima** — optimistic-lock µs vs ms (BE `f852a75`).

---

## 2. Migracija u servosync4 (monorepo) — status i SYNC

Detalji: [MONOREPO_MIGRACIJA.md](MONOREPO_MIGRACIJA.md). Sažetak:

| Faza | Šta | Status |
|---|---|---|
| 1 | Skelet + spoj `backend/` + `frontend/` uz očuvanu istoriju + `e2e/` u git, `_legacy/` van gita | ✅ |
| 2 | GitHub repo `Servoteh/servosync4` (push 635 commit-a) | ✅ |
| 3 | Deploj: backend runner `servosync4-onprem` (.28) + frontend `wrangler` iz Actions — test-deploj Succeeded | ✅ |
| 4 | **Zatvaranje:** diskonektuj staru CF Git-integraciju, ugasi stari runner, arhiviraj stare repoe, `feat/montaza-fe` merge, očisti grane | ⬜ |

**✅ SYNC STATUS servosync4 ↔ stari repoi — ZATVOREN 18.07 popodne:**
- **backend:** ✅ **potpuno current** — src + docs (gejt + ROADMAP checkpoint) + permission matrica 10 specova (`b712319`) + CI kapija (`ci-backend.yml`, GitHub-hosted, kapije: typecheck + 1025 unit + permission matrice/coverage audit).
- **frontend/src:** ✅ **potpuno current** — attendance-drill fix portovan (`277306f` → port `1320abf`); ceo `frontend/src` verifikovan diff-om protiv starog repoa (preostale razlike samo CRLF/LF, sadržinski identično).

**Deploy okidači (`.github/workflows`):** backend deploj na push `backend/**` **osim** `backend/test/**` i `backend/docs/**` (`1796892`; ručni ventil `workflow_dispatch`); frontend na push `frontend/**`.
→ **push koda u ove foldere OKIDA prod deploj monorepoa.** *(Ovaj dokument je u `docs/` → NE okida deploj.)*

---

## 3. ŠTA OSTAJE — gejt „3.0-ZAVRŠEN"

3.0 se zvanično zatvara kad su **Blok B + C** čekirani (D, E preporučeni).

### Blok B — dekomisija legacy sloja (ovo FORMALNO zatvara 3.0)
QBigTehn **lanac** sync već ugašen 14.07 (`62a1e81`). Ostaje redom (tvrde zavisnosti):
- [~] **(1) Loc-most repoint** — 🟡 **KOD SLETIO 18.07**, živa sekvenca čeka prozor. ⚠️ **blokira gašenje QBigTehn-a.**
  Feeder `LocTpFeedService` (2.0 `tech_processes` → iste `bigtehn_*_cache` tabele) + `POST /locations/sync/feed-run`;
  ingest motor i placement trigger NETAKNUTI (1.0 i mobilni `/m/*` ne vide promenu). SQL za sy15 + kompletna
  sekvenca/rollback: **[backend/docs/RUNBOOK_LOC_MOST_REPOINT.md](../backend/docs/RUNBOOK_LOC_MOST_REPOINT.md)**.
  Adversarijalna verifikacija našla i zatvorila 2 blokera (`skip_zero_qty` bi gutao transfere · deljeni watermark
  bi progutao backlog od 14.07). **Čeka 4 odluke** (runbook §4): auth za feed cron · backfill (A) ili start „od sada" (B)
  · granularnost legacy signala · potvrda da niko ne čita ServoTehERP lokacije.
- [ ] **(2) Aktiviraj `tools/bigbit-bridge/`** — master read (33 šifarnika) sa `Vasa-SQL:5765` → direktan BigBit mdb. *(Sync B trajan do 4.0, samo menja izvor.)*
- [ ] **(3) Konsolidacija dve PG baze** (sy15 + 2.0) — Reversi+auth još čitaju `sy15` preko 2. Prisma datasource-a.
- [ ] **(4) Gašenje PostgREST + GoTrue** (`sy15-*`) + potpuna dekomisija 1.0 Vite fronta (SSO kapija + `/m/*`).

### Blok C — kvalitet + sigurnost (AKTIVAN, izbor Nenada)
- [x] Native core read-only e2e (5/5) · net-zero write probe 4 modula · smoke 34/34.
- [x] **Permission matrica core** (10 spec, CI-gated) — vidi §1.
- [ ] **C2 — Native core WRITE probe** (net-zero) za TP/kiosk/MRP — off-hours (živa baza).
- [ ] **C3 — part-locations izvršilac fix** — ledger upisuje RN-radnika umesto magacionera (`part-locations.service.ts:331/342/409`); `resolveActorWorkerId` postoji, FK-safe; bounded prod, off-hours deploy.
- [ ] **C4 — RBAC `definesApproval/Launch` gate** (`work-orders.service.ts:1038/1080/1095`) — **čeka Nenadovu poslovnu odluku** (koji tip radnika sme da odobri/lansira); pogrešno uključivanje BLOKIRA prod. **Nije bag.**
- ℹ️ Ispravka: „7 TODO(auth)" NISU hitan bag — approve/launch VEĆ vezuju izvršioca (`resolveActorWorkerId`); ostalo = namerni V2 gate (C4) + niska part-locations atribucija (C3).

### Blok D — mobilni (Capacitor, 5 šavova) — svi `/m/*` još 1.0
- [ ] Offline queue → NestJS ugovor (idempotencija) · Auth/passkeys → NestJS JWT+WebAuthn (passkeys ne rade posle 1.5) · Push (FCM prazan) · Realtime → WS/LISTEN-NOTIFY · SW/PWA keš.

### Blok E — loose ends
- [ ] GoTrue `SITE_URL` (reset lozinke) · `servosync2` front pao · Lokacije BigTehn search/OCR · Štampa ulazna tačka iz Praćenja.

### Monorepo — Faza 4 (paralelni migracioni tok)
- [x] Sinhronizuj `frontend/src` attendance fix (`277306f` → port `1320abf`) — ✅ 18.07, sync ZATVOREN (vidi §2).
- [ ] Diskonektuj staru CF Git-integraciju (`servosync/frontend`) · ugasi stari `servosync-backend` runner · arhiviraj stare repoe · `feat/montaza-fe` merge · očisti mrtve grane.

---

## 4. Sign-off

| | Datum | Ko | Napomena |
|---|---|---|---|
| 3.0-PRODUKT objavljen | — | Nenad | unifikacija ✅ |
| Monorepo Faza 4 zatvorena | — | | servosync4 jedini izvor + deploj |
| B (dekomisija) završen | — | | loc-most → bigbit-bridge → konsolidacija → gašenje PostgREST/GoTrue |
| C (kvalitet+sigurnost) završen | — | | write probe TP/kiosk/MRP + part-locations + RBAC gate |
| **3.0-ZAVRŠEN** | — | Nenad | |
