# DEFINICIJA 3.0 ZAVRŠEN — formalni gejt za zvanično proglašenje

**Verzija:** v2, 2026-07-18 · **Status:** AKTIVAN (Nenad izabrao Blok C kao sledeći fokus)
**Svrha:** jedno mesto koje odgovara na „**da li smo gotovi sa 3.0?**". Kad su obavezni [ ] čekirani,
3.0 se zvanično proglašava. Izvori istine iznad ovoga: [ROADMAP.md](ROADMAP.md) §3.0,
[MIGRACIJA_3.0_PLAYBOOK.md](MIGRACIJA_3.0_PLAYBOOK.md), [design/MIGRACIONA_DOKTRINA_3.0.md](design/MIGRACIONA_DOKTRINA_3.0.md).

> **v2 zabeleška:** ovaj dokument je jednom nestao (nekomitovan na staroj grani → obrisan resetom).
> Zato je sada **komitovan na `main`**. Ako ga menjaš, komituj — ne ostavljaj u working-tree.

---

## 0. Dve definicije „3.0" — biramo eksplicitno

| | **3.0-PRODUKT** („sve u jednu app") | **3.0-ZAVRŠEN** (inženjerski, po doktrini) |
|---|---|---|
| Šta | jedan domen, jedan login, jedan shell, svi moduli na 2.0 | + legacy sloj ugašen + paritet dokazan (e2e/authz) |
| Stanje 18.07 | ✅ **DOSTIGNUTO** (Blok A) | ⏳ ostaje **B** (dekomisija) + **C** (kvalitet) |
| Kada objaviti | **odmah moguće** (prekretnica) | kad su B + C obavezne stavke ✅ |

---

## A. Unifikacija — „sve u jednu aplikaciju" ✅ (izvršeno 17–18.07.2026)

- [x] Svi 1.0 moduli cutover-ovani na 2.0 (FE `759eeae` uklonio „Razvojna faza" skelu).
- [x] Shell v2 — sidebar (full/rail/hidden) + Ctrl+K + `/pocetna` HUB + landing po ulozi + nav-reorg + dark/light.
- [x] Hard-flip domena: `servosync.servoteh.com` servira 2.0; 1.0 penzionisan kao primarni ulaz.
- [x] Native auth (58 GoTrue lozinki prekopirano) + refresh-token rotacija.
- [x] Per-modul cutover-auditi 17.07 svi GO (Energetika 18/18, Kadrovska 1v2, Lokacije 13/13, Plan+Praćenje 8/8, Održavanje NO-GO→GO posle F2, PB 3-agent CLEAN).

**→ 3.0-PRODUKT ispunjen.** B i C su uslov za 3.0-ZAVRŠEN.

---

## B. Finalni cutover — dekomisija legacy sloja (OBAVEZNO; ovo STVARNO zatvara 3.0)

Verifikovano stanje 18.07 (ground-truth `origin/main` oba repoa):

| # | Stavka | Status | Dokaz |
|---|---|---|---|
| 1 | QBigTehn **lanac** sync (Sync A) | ✅ **UGAŠENO** 14.07 | commit `62a1e81`; chain synceri obrisani |
| 1b | QBigTehn **master** read (33 šifarnika, `Vasa-SQL:5765`) | 🟡 **ŽIVO** (on-demand) | `tools/bigbit-bridge/` napisan ali **NEAKTIVAN** |
| 2 | Konsolidacija dve PG baze (sy15 + 2.0) | ⬜ **NIJE** | `prisma/sy15.prisma` = 2. datasource; Reversi + auth čitaju sy15 |
| 3 | PostgREST + GoTrue (Supabase-native) | 🟡 **ŽIVO** on-prem (od 1.5, 10.07) | `sy15-*` kontejneri; koriste ih 2.0 auth + Reversi + 1.0 front |
| 4 | Loc-most repoint (§4.2) | 🟡 **KOD SPREMAN** 18.07, živa sekvenca čeka prozor | `LocTpFeedService` + SQL skripte + [RUNBOOK_LOC_MOST_REPOINT.md](RUNBOOK_LOC_MOST_REPOINT.md) |
| 5 | 1.0 Vite front dekomisija | 🟡 **ŽIVO** (SSO kapija + iframe host + mobil `/m/*`) | `ss2Cutover.js` enabled |

**Redosled (tvrde zavisnosti):**
- [ ] **(1) Loc-most repoint** — 1.0 `loc_*` ingest: QBigTehn cache → 2.0 `tech_processes`; outbound `sp_ApplyLocationEvent` gasi. ⚠️ **blokira gašenje QBigTehn-a.**
  **Kod sletio 18.07** (feeder `LocTpFeedService` puni iste cache tabele iz 2.0 → ingest motor netaknut; outbound enqueue skripta spremna). Ostaje **živa sekvenca po
  [RUNBOOK_LOC_MOST_REPOINT.md](RUNBOOK_LOC_MOST_REPOINT.md)** (koraci 0–11) + 4 otvorena pitanja iz runbook §4 (auth za feed cron · backfill A/B · granularnost signala · ServoTehERP potvrda).
- [ ] **(2) Aktiviraj `bigbit-bridge`** → master read (33 tab.) sa `Vasa-SQL:5765` na direktan BigBit mdb → QBigTehn zavisnost pada na nulu. *(Sync B ostaje trajan do 4.0.)*
- [ ] **(3) Konsolidacija baza** — sy15 moduli lift-and-shift u jedinstvenu 2.0 bazu; ukloni 2. datasource.
- [ ] **(4) Gašenje PostgREST + GoTrue** (`sy15-*`) + potpuna dekomisija 1.0 Vite fronta — kad ni 2.0 auth ni mobilni `/m/*` ne gađaju sy15.
- [ ] Poslednji delta resync + env svuda + rebuild + grep živog bundle-a + rollback prozor 7–14 dana.

---

## C. Kvalitet + sigurnost — paritet DOKAZAN (AKTIVAN blok, izbor Nenada 18.07)

Referenca: [MIGRACIONA_DOKTRINA §D](design/MIGRACIONA_DOKTRINA_3.0.md).

**Izmereno stanje harness-a (`Servosync 2.0/e2e/`, gađa živi front, 1 admin nalog):**
- [x] **Modul smoke** (Nivo 1): 34/34 modula 🟢 (navigacija+render+tab-klik, 0 crash/5xx/console).
- [x] **Native core READ-only e2e** (`core-read.spec.ts`): drill RN/TP/Kvalitet detalj-GET 2xx + kiosk/MRP surface, 5/5 PASS (hvata orphan-FK 500).
- [x] **Net-zero write probe** (4 modula): Reversi/Kadrovska/Kvalitet/RN create→delete / edit→revert, 4/4 PASS, nula rezidua.
- [x] **Preventivni sweep 18.07** — harness dokazao vrednost: nađena+popravljena **3 realna prod buga**
  (2× shape-mismatch objekat-vs-niz → crash: /profil tim-tools `e1ffcd8` + attendance-drill `277306f`;
  1× PB optimistic-lock µs/ms → lažni 409 svima `f852a75`). µs/ms audit: nema drugih (Kadrovska već imuna).

**⚠️ Ispravka premise (provereno u kodu): „7 TODO(auth)" NISU hitan bag.**
RN `approve()`/`launch()` **VEĆ** vezuju izvršioca (`resolveActorWorkerId` → `createdBy/updatedByWorkerId`).
Ono što stvarno ostaje pod `TODO(auth)`:
- **RN `definesApproval`/`definesLaunch` drugi gate** (`work-orders.service.ts:1038/1080/1095`) = **namerni V2
  RBAC business-rule** (koji tip radnika sme da odobri/lansira) → **HOLD za Nenadovu poslovnu odluku**
  (pogrešno uključivanje BLOKIRA legitimna prod odobravanja). Nije bag.
- **part-locations ledger izvršilac ×3** (`part-locations.service.ts:331/342/409`) — upisuje RN-radnika
  umesto stvarnog magacionera; niska atribuciona vrednost, popravljivo, off-hours.

**PREOSTALO u C (po vrednosti/riziku):**
- [ ] **C1 — Permission matrica** rola×endpoint×200/403 (`AUTHZ_ENFORCE`) — sad SAMO Reversi ima
      (`test/reversi-permissions.e2e-spec.ts`). **Traži infra odluku:** (A) prod test-nalozi po roli /
      (B) lokalni seed backend / (C) mint-JWT-po-roli (coarse guard; write-endpointi samo lokalno). Najveći security-lever.
- [ ] **C2 — Native core WRITE probe** (net-zero) za TP/kiosk/MRP — off-hours (živa baza).
- [ ] **C3 — part-locations izvršilac fix** (`resolveActorWorkerId`, FK-safe) — bounded prod, off-hours deploy.
- [ ] **C4 — RBAC `definesApproval/Launch` gate** — čeka Nenadovu poslovnu odluku (koji tip radnika).

---

## D. Mobilni šavovi — Capacitor (5 veza, [PLAYBOOK §6](MIGRACIJA_3.0_PLAYBOOK.md))

- [ ] Offline queue → NestJS ugovor (idempotencija `client_event_uuid`).
- [ ] Auth tok — GoTrue PKCE/refresh/passkeys → NestJS JWT + WebAuthn (passkeys ne rade posle 1.5).
- [ ] Push — FCM/APNs/VAPID sa Supabase edge sloja → NestJS (`FCM_SERVICE_ACCOUNT` prazan = degradiran).
- [ ] Realtime (`work_hours`) → WS/LISTEN-NOTIFY.
- [ ] Service worker / PWA keš — nove API putanje.
- [ ] Svi mobilni `/m/*` putevi i dalje 1.0 — prelaze na 2.0 zasebno.

---

## E. Loose ends (ne blokiraju, čiste se pre proglašenja)

- [ ] GoTrue `SITE_URL` (reset lozinke) · `servosync2` front pao (počistiti).
- [ ] Lokacije: BigTehn search/lookup + OCR (1.0-only) · Štampa ulazna tačka iz Praćenja.

---

## F. Sign-off

3.0 se **zvanično proglašava završenim** kad su čekirane obavezne stavke **B + C** (D i E preporučeni, odluka Nenad).

| | Datum | Ko | Napomena |
|---|---|---|---|
| 3.0-PRODUKT objavljen | — | Nenad | Blok A ✅ |
| B (dekomisija) završen | — | | loc-most → bigbit-bridge → konsolidacija → gašenje PostgREST/GoTrue |
| C (kvalitet+sigurnost) završen | — | | permission matrica + write probe + part-locations + RBAC gate |
| **3.0-ZAVRŠEN** | — | Nenad | |
