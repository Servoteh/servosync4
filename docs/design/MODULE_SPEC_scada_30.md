# Module Spec: Energetika / SCADA — 3.0 TALAS E

| | |
|---|---|
| **Modul** | 1.0 „⚡ Energetika / SCADA" — nadzor + kontrola kotlarnica (kot1/kot2/kot3) i solara (KACO, Sigenergy) |
| **Verzija spec** | 1.0 (2026-07-12) |
| **Faza** | 3.0-E — Talas E (samostalan, safety) |
| **Izvor** | 1.0 ŽIVI kod (`src/ui/energetika-scada/` 482 LOC + `src/services/scada.js` 146 + `src/ui/mobile/myEnergetika.js` 1078 + `public/scada-hmi/` ~2.4k LOC HMI ekrani/shim) + živi DB kroz Management API (snimljeno 12.07 sa cloud restore-izvora) |
| **Authz snapshot** | [`authz-snapshots/talasE-fn-defs-2026-07-12.sql`](authz-snapshots/talasE-fn-defs-2026-07-12.sql) (5 fn + appendix: 9 politika, trigger, cron, grants, živost) |
| **Doktrina** | [`MIGRACIONA_DOKTRINA_3.0.md`](MIGRACIONA_DOKTRINA_3.0.md) — VAŽI U CELOSTI; posebno §C (komandna semantika se NE dira) |
| **Status** | NACRT — čeka Nenadov review (§7) |

> ⚠️ **SAFETY MODUL (živi kotlovi).** Komandni tok ima tri sloja zaštite koji se prenose
> BEZ izmene semantike: (1) UI potvrda + **cancel-on-timeout 15 s** (komanda ne sme da
> „procuri" i izvrši se naknadno), (2) DB safety (`expires_at` 2 min; stale `claimed` >2 min
> → `failed` „ishod nepoznat — NIJE ponovo izvršeno", nikad nazad u pending), (3) bridge
> allowlist + opsezi + rate-limit + kill-switch (`SCADA_CONTROL`). **`Web_Estop` je NAMERNO
> van allowlist-a** — daljinski E-stop ne postoji ni u jednom UI-ju i tako ostaje.

> ✅ **Bridge repoint na sy15 JE urađen** (provereno 12.07): cloud upisi stali tačno na
> cutover (max `scada_snapshots.updated_at` = 09.07 22:27 UTC), a 1.0 commit `dc8bb57`
> (11.07) dokumentuje seobu scada-app + bridge-relay na **ubuntusrv systemd user unite**
> (`scada-app.service` port **3010** — 3000 drži 2.0 backend! — + `servoteh-bridge-scada.service`
> → sy15 gateway `localhost:8080`) i repoint push trigera na `http://gateway/functions/v1/push-dispatch`.
> Svežinu upisa NA sy15 ovaj spec nije mogao da potvrdi (NIKAD ssh iz spec faze) → **R0 provera**.

## 0. Obim — šta se SELI, šta NE (front vs pozadina)

Ceo hardverski lanac je pozadina; korisnička površina je tanka (5 tabela read + 1 INSERT + 1 RPC).
**HMI ekrani se NE prepisuju** — originalni HP-HMI ostaje iframe i u 2.0 (odluka iz talasa, paritet 1:1).

**SELI SE (korisnička površina):**
- **Ljuska modula**: tabovi Pregled/kot1/kot2/kot3/solar-kaco/solar-sigen/Komande, status tačke
  po sistemu (🟢/🔴/🟡 stale), baner „Bridge offline / sistem ne javlja", header „Bridge: HH:MM:SS".
- **Roditeljski most `window.__SCADA_BRIDGE__`** koji shim u iframe-u zove:
  `getSnapshot` (payload + `online`/`_stale`/`_ageMs`), `getHistory` (per-site sastav metrika),
  `getAlarms`, `sendCommand` (potvrda→insert→poll→**cancel na timeout**), `canControl`.
- **postMessage protokol** roditelj↔iframe: `scada-nav` (drill-down), `scada-confirm`/
  `scada-confirm-result` (potvrda u roditeljskom modalu), `scada-theme` (dark/light uživo).
- **HMI statika `public/scada-hmi/`** (6 ekrana + js + shim + theme + fontovi + `kot1-tags.json`)
  — **kopira se** u 2.0 front (isti origin!), ne prepisuje. ⚠️ shim `*/`-u-komentaru zamka:
  svaka izmena shim-a → `node --check public/scada-hmi/scada-bridge-shim.js`.
- **Komandni tok** (desktop kroz HMI ekrane + touch): potvrda modal → INSERT `scada_commands`
  (`pending`, u svoje ime, `idempotency_key`) → poll statusa (1.5–2 s) → posle 15 s bez ishoda
  `scada_cancel_command` → toast STVARNOG statusa. Semantika 1:1 (nalazi B3/B7 u kodu).
- **Komande (audit) tab**: poslednjih 40 komandi (vreme/sistem/target/vrednost/ko/status/ishod).
- **Touch-first ekrani** (paritet 1.0 `/m/energetika`, 1078 LOC): M1 pregled (5 kartica sa hero
  cifrom + aktivni alarmi + poslednje komande, poll 8 s) i M2 po sistemu — kot1 (režim, zone
  setpoint ±0.5 uz opsege-ogledalo allowlist-a, uređaji K1–K5/P1–P4 „Ručno", Reset VFD), kot2
  (setpoint 10–30, režimi, kotao ručno, pumpe/kaloriferi, raspored po hali 0–23 h, RESET alarma;
  **E-stop samo status, nikad komanda**), kot3 (sobe cilj 5–35 + heat/cool po `tempTarget` pravilu,
  ventilatori 0–max, prekidači po prostoriji), sigen (KPI + režim SAMO ako `payload.control===true`
  — „cloud bez kontrole" poruka inače), kaco (read-only, blue'Log nema kontrolni API).
- **Clock-safe staleness** (pravilo firme, ne UX detalj): svežina se računa relativno na
  server-vreme procenjeno iz max `updated_at` + proteklog klijentskog vremena, NIKAD iz
  apsolutnog sata uređaja (domenske mašine odlutaju → sve bi lažno bilo „offline"). Prag 60 s.
- **History čitanje — lekcija B2**: OBAVEZNO filter metrika + `ORDER BY ts DESC LIMIT 12000` pa
  reverse; bez filtera kot1 (14 metrika × 1440 min) premaši limit i ASC bi odsekao NAJNOVIJE sate.

**NE SELI SE (pozadina — ostaje na ubuntusrv/sy15, netaknuto):**
- `scada-app/` (PLC drajveri PCOM/S7/Loxone/blue'Log/Sigen, lokalni API **port 3010** + LAN UI)
  i `bridge/` relay (`src/scada/*`: snapshot 5 s, history 60 s, alarmi diff-sync, command executor
  2 s sa allowlist/opsezi/rate-limit/kill-switch, Telegram notifier, history retencija 90 d)
  — oba systemd user unita na ubuntusrv (docs: 1.0 `docs/scada/bridge-scada-install.md`).
- RPC `scada_claim_commands` (service_role ONLY — FOR UPDATE SKIP LOCKED + expiry + claimed
  recovery) — zove ga isključivo bridge.
- Push pipeline: trigger `scada_alarm_push_aigt` → `net.http_post` → gateway edge `push-dispatch`
  → `device_push_tokens` (1.0 web/native push). Primaoci: aktivni admin+menadzment kroz
  `scada_notify_prefs` (default enabled, severity ≤ 3; info=4 se ne šalje); push `url` vodi na
  1.0 `/m/energetika` (mobilni šav — ne dira se do finalnog 3.0).
- pg_cron `scada_watchdog_every_5_min`: snapshot > 5 min star → alarm `BRIDGE_STALE` (sev 2,
  tag `scada-stale` kolabira notifikacije); bridge ga sam čisti diff-sync-om kad se vrati.
- 1.0 Capacitor `/m/energetika` ekran — ostaje u 1.0 app-u do finalnog 3.0 (mobilni šavovi).

## 1. Živi podaci i model (12.07, cloud restore-izvor; sveže brojke na sy15 proveriti u R0)

| Tabela | Redova | Prisma model? | Napomena |
|---|---:|---|---|
| `scada_sites` | 5 | ✅ `ScadaSite` | seed 5 sistema; `key` text PK, kind kotlarnica/fne, `last_seen` heartbeat |
| `scada_snapshots` | 5 | ✅ `ScadaSnapshot` | 1 red/sistem; `payload` jsonb = sirovi `/api/*` JSON (oblik se NE menja — HMI ekrani ga čitaju 1:1) |
| `scada_history` | 438.086 | ✅ (`@@id([siteKey, metric, ts])`) ili $queryRaw | long format; čitanje SAMO uz metrika-filter + DESC (B2) |
| `scada_alarms` | 12.747 (8 aktivnih) | ✅ `ScadaAlarm` | jedan AKTIVAN red po (site,code) — partial unique; severity 1–4 (ISA-18.2) |
| `scada_commands` | 15 (11 applied/4 rejected) | ✅ `ScadaCommand` | outbox+audit u jednom, NIKAD se ne briše; uuid PK; `idempotency_key` partial unique |
| `scada_notify_prefs` | 0 | — ($queryRaw, v2) | v1 bez UI (default važi za sve admin/menadzment) |

**PK se zadržavaju** (text `key`, uuid, composite). Modeli se DODAJU u postojeći `prisma/sy15.prisma`.
Idempotencija komandi: koristi POSTOJEĆI `idempotency_key` (1.0 UI šalje `ui-<ts>-<rand>`;
2.0 BE prima `clientEventId` iz fronta ili generiše svoj) — NE uvoditi `rev_api_idempotency` (doktrina A4).

## 2. Žive politike + authz (snapshot 12.07 — appendix A; RE-VERIFIKOVATI na sy15 u R0)

9 politika na 6 tabela, JEDAN helper — najčistiji authz od svih talasa:

| DB pravilo | Ko prolazi | → 2.0 permisija |
|---|---|---|
| SELECT na svih 6 tabela | `scada_is_admin_or_management()` = **globalna** rola (`project_id IS NULL`, `is_active`) admin ILI menadzment, po lower(email) | `energetika.read` |
| INSERT `scada_commands` | isto + `requested_by = jwt email` + `status='pending'` + `result/claimed_at/applied_at` NULL | `energetika.control` |
| `scada_cancel_command(uuid)` (DEFINER, jedini front RPC) | isti skup; menja SAMO svoju `pending` → `expired`, vraća STVARNI status (`applied` ako je bridge stigao pre) | `energetika.control` |
| UPDATE/DELETE komandi, upis snapshot/history/alarma | **niko od authenticated** — samo service_role (bridge) | — (ostaje u bazi) |
| `scada_notify_prefs` self-scope (select/insert/update samo svoj red) | admin/menadzment, `user_email = jwt email` | v2 (bez UI u v1) |

**Skrivena pravila firme (doktrina §C — POPISANO, ne sme se izgubiti):**
1. Kontrola = pristup u v1 (`canControlScada()` ≡ `canAccessEnergetikaScada()`), ali su u kodu
   NAMERNO odvojene funkcije → 2.0 zadržava DVA ključa (`read`/`control`) sa istom dodelom.
2. Audit je nepromenljiv — otkazivanje NIJE UPDATE iz aplikacije nego DEFINER RPC sa uskim uslovom.
3. Stale `claimed` → `failed`, NE nazad u `pending` („ne znamo da li je upis na PLC već otišao —
   re-izvršavanje je opasnije od false-negative").
4. E-stop: kot2 `Web_Estop` van allowlist-a; UI ga NIKAD ne prikazuje kao komandu (samo status).
5. Sigen kontrola dodatno uslovljena `payload.control === true` (scada-app `SIGEN_CONTROL`).
6. Klijentski opsezi (K1_SP_RANGES, kot2 10–30, kot3 5–35, sat 0–23) su OGLEDALO bridge
   allowlist-a — čist UX; **bridge ostaje krajnji autoritet** i to se ne menja.

**Dodela u `role-permissions.ts`:** `energetika.read` + `energetika.control` → `admin` (ALL) i
`MENADZMENT`; **NIKO drugi** (ni viewer baseline, ni sef/tehnolog — paritet 1.0 „samo admin+menadzment").
**GUC most:** sve politike/fn čitaju `auth.jwt()->>'email'` (nema `auth.uid()` u ovom modulu),
ali claims šaljemo standardno SA `sub` (doktrina A2). Ključeve po potrebi harmonizuje glavna
sesija (`energetika.*` vs `scada.*` — vidi §7 P5).

## 3. API (predlog, `/api/v1/energetika/*`)

| Endpoint | Metod | Permisija | 1.0 poreklo |
|---|---|---|---|
| `/energetika/sites` | GET | read | fetchScadaSites (sort_order) |
| `/energetika/snapshots` | GET | read | fetchScadaSnapshots (svi; + predlog `serverNow` u odgovoru — §7 P4) |
| `/energetika/snapshots/:siteKey` | GET | read | fetchSnapshotRow (payload/online/updated_at) |
| `/energetika/history/:siteKey?hours=24&preset=…` | GET | read | fetchSiteHistory — **BE preseti po sistemu** umesto sirovih PostgREST filtera: kot1 (tags iz kot1-tags.json: temp+setpoint), kot2 (6 fiksnih metrika), kot3 (`mix:*`,`analog:*`,`rooms_avg`), sigen (`<sys>:*` + suffix mapa), kaco (pv, grid); interno DESC+12000+reverse (B2) |
| `/energetika/alarms?active=true` | GET | read | fetchActiveAlarms (limit 100) |
| `/energetika/alarms/:siteKey?limit=100` | GET | read | fetchAlarmHistory (→ shim `/api/alarmmeta`) |
| `/energetika/commands?limit=40` | GET | read | fetchRecentCommands (audit tab) |
| `/energetika/commands/:id` | GET | read | fetchCommand (poll posle slanja) |
| **`/energetika/commands`** | **POST** | **control** | insertCommand — GUC INSERT (RLS paritet: svoje ime, pending); telo `{siteKey, target, op='set', value, clientEventId?}` → `idempotency_key` |
| **`/energetika/commands/:id/cancel`** | **POST** | **control** | `scada_cancel_command` kroz GUC; vraća stvarni status |
| `/energetika/notify-prefs` | GET/PUT | read | v2 (P6) — self-scope prefs; u v1 SE NE RADI |

Bez SSE/WS u v1 — front poll-uje kao 1.0 (snapshots ~5–10 s aktivan tab, banner 10 s, komanda
1.5–2 s do 15 s). Payload JSON oblici se NE normalizuju (HMI ekrani i touch čitači zavise od njih).

## 4. FE (Next) — `/energetika` pod nav sekcijom **Energetika** (samostalna, kao 1.0 hub kartica)

1. **Iframe host**: `scada-hmi/` statika kopirana u 2.0 front `public/` (ISTI origin — shim
   sinhrono čita `window.parent.__SCADA_BRIDGE__`; cross-origin bi tiho pao na „bridge nije
   dostupan"). Headeri za `/scada-hmi/*`: `X-Frame-Options: SAMEORIGIN` + CSP `frame-ancestors
   'self'` + **no-cache/revalidacija** (fiksna imena bez hash-a — ispravke shim-a moraju odmah).
2. **Parent klijentska komponenta**: instalira most (getSnapshot/getHistory/getAlarms/
   sendCommand/canControl → pozivi §3 API-ja), postMessage protokol (nav/confirm/theme),
   teardown čisti most. Potvrda = 2.0 ui-kit modal, tekst identičan 1.0 („Komanda se izvršava
   na živom postrojenju i trajno beleži u audit."). Tema: 2.0 shell šalje `scada-theme`
   poruke po svom theme mehanizmu — **shim se ne menja**.
3. **Tabovi**: Pregled + 5 sistema (iframe) + Komande (audit tabela) — paritet 1.0 ljuske,
   uklj. status tačke i banere (clock-safe staleness algoritam prenet 1:1).
4. **Responsive/mobilni prikaz**: iframe HMI (SVG sinoptici) NIJE upotrebljiv na telefonu →
   port touch-first ekrana iz `myEnergetika.js` kao prikaz za male ekrane (breakpoint ili
   toggle „Touch prikaz"): M1 kartice + M2 kontrole po sistemu, isti komandni tok (§0).
   1.0 Capacitor `/m/energetika` ostaje netaknut do finalnog 3.0.
5. **Bez novih env** na frontu; BE traži postojeće SY15_* (boot-safe 503 bez njih, doktrina A6).

## 5. Parity matrica (doktrina B — status se ažurira TOKOM rada)

| # | Funkcija | Status |
|---|---|---|
| 1 | Ljuska: tabovi + status tačke + baneri + „Bridge: HH:MM" (clock-safe staleness) | NOT_STARTED |
| 2 | Iframe hosting HMI ekrana (6) sa istog origina + headeri (SAMEORIGIN/no-cache) | NOT_STARTED |
| 3 | Most `__SCADA_BRIDGE__`: getSnapshot (online/_stale/_ageMs semantika) | NOT_STARTED |
| 4 | Most: getHistory preseti za svih 5 sistema (B2: filter+DESC+reverse) | NOT_STARTED |
| 5 | Most: getAlarms (`/api/alarmmeta` — prava vremena u ekranima) | NOT_STARTED |
| 6 | postMessage: scada-nav drill-down + scada-theme sync (init + uživo) | NOT_STARTED |
| 7 | Potvrda komande: scada-confirm → 2.0 modal → scada-confirm-result | NOT_STARTED |
| 8 | **Komandni tok: POST → poll → cancel-on-timeout 15 s → stvarni status** | NOT_STARTED |
| 9 | Read-only režim (bez `energetika.control`): shim sakriva/blokira komandne elemente | NOT_STARTED |
| 10 | Komande (audit) tab — 40 poslednjih, status badge-ovi (6 statusa) | NOT_STARTED |
| 11 | Touch M1: pregled kartica (hero cifre po sistemu) + aktivni alarmi + poslednje komande | NOT_STARTED |
| 12 | Touch M2 kot1: režim/zone setpoint (opsezi)/uređaji ručno/Reset VFD | NOT_STARTED |
| 13 | Touch M2 kot2: setpoint/režimi/kotao/pumpe/kaloriferi/raspored/RESET alarma; E-stop samo status | NOT_STARTED |
| 14 | Touch M2 kot3: sobe (heat/cool pravilo)/ventilatori/prekidači | NOT_STARTED |
| 15 | Touch M2 sigen (`payload.control` gate) + kaco read-only | NOT_STARTED |
| 16 | e2e permission matrica (read/control × admin/menadzment/ostali × 200/403) | NOT_STARTED |
| 17 | e2e komandni lanac BEZ dodira PLC-a (van-allowlist target → bridge `rejected`) | NOT_STARTED |
| 18 | Živi smoke: bezopasna komanda (setpoint na ISTU vrednost) → `applied` + audit | NOT_STARTED |

## 6. Redosled izvođenja (R-faze za ceo talas)

| Faza | Šta | Gate |
|---|---|---|
| R0 | Nenad presudi §7 + **re-verifikacija na živoj sy15**: snapshot drift (očekivan SAMO trigger URL → gateway), svež `scada_snapshots.updated_at` (bridge živ), `cron.job` scada_watchdog postoji i radi na sy15, pg_net + `private.app_config.push_dispatch_key` živi, poslednji `BRIDGE_STALE`/push ishodi; **grants za `servosync2_app`** (SELECT 6 tabela, INSERT `scada_commands`, EXECUTE `scada_cancel_command` + `scada_is_admin_or_management`) — ISKLJUČIVO kao `supabase_admin` (doktrina A6), migracija u 1.0 repo | odobreno |
| R1 | BE read: Prisma modeli u sy15.prisma + svi GET (§3) + `energetika.*` permisije + e2e read matrica | read paritet |
| R2 | BE komande: POST /commands (GUC, idempotency_key) + /cancel; e2e: svoje-ime CHECK, non-admin 403, **van-allowlist target → `rejected` end-to-end** (vežba ceo lanac bez dodira PLC-a) | write paritet |
| R3 | FE: iframe host + most + protokol + tabovi + touch prikaz + audit tab; `node --check` na shim posle SVAKE izmene statike | UI paritet |
| R4 | Živi smoke (setpoint na istu vrednost → applied; timeout tok sa ugašenim bridge-relayem → cancel/expired) + Playwright happy-path + paralelni rad sa 1.0 → hub preklop (1.0 kartica → 2.0 ruta, 1.0 fallback) | parity gate (doktrina D) |
| R5 | Retrospektiva tempa → ažurirati PROCENA_SEOBE | kalibracija |

## 7. Otvorena pitanja (Nenad presuđuje; svako sa predlogom)

> ✅ **PRESUĐENO 12.07.2026 (Nenad): „VAŽE PREDLOZI" — sva pitanja + H1–H4 usvojeni bez izuzetaka.**

1. **Hosting HMI statике**: kopija `public/scada-hmi/` u 2.0 front public/ (dva primerka do
   gašenja 1.0 — ispravke se rade u 1.0 repou pa kopiraju)? **Predlog: DA, kopija** + README
   napomena „izvor istine = 1.0 repo"; sinhronizacija je retka (ekrani stabilni od 07/2026).
2. **Touch-first prikaz u 2.0 v1**: port `myEnergetika` touch ekrana (stavke 11–15) ODMAH, ili
   2.0 v1 samo desktop iframe (telefonski korisnici ostaju na 1.0 `/m/energetika` do 3.0)?
   **Predlog: port odmah** — parity gate traži proveren mobilni prikaz (doktrina D), a iframe
   na telefonu ne prolazi; trošak ~1/3 talasa.
3. **Komandni transport**: čist poll (paritet) ili SSE za status komande? **Predlog: poll**
   (paritet, jednostavnije, latencija ionako 1–5 s kroz bridge poll).
4. **`serverNow` u snapshot odgovoru** (svesno MALO odstupanje): BE vrati svoje `now()` da
   staleness ne zavisi ni od procene — front zadržava 1.0 algoritam kao fallback.
   **Predlog: DA** (tačnije, aditivno polje, ne menja 1.0 ponašanje).
5. **Imenovanje permisija**: `energetika.read`/`energetika.control` (ruta `/energetika`,
   1.0 alias postoji) ili `scada.*`? **Predlog: `energetika.*`** — korisničko ime modula;
   glavna sesija harmonizuje preko svih 6 talasa.
6. **`scada_notify_prefs` UI** (1.0 ga NEMA — default za sve admin/menadzment): dodati mali
   „Obaveštenja" panel u 2.0 (RLS već postoji)? **Predlog: NE u v1** (strogi paritet); P2
   kandidat posle parity gate-a.
7. **Push `url: '/m/energetika'`** u trigeru vodi u 1.0 mobilnu app: repoint na 2.0 rutu pri
   hub preklopu? **Predlog: NE dirati** — push primaju 1.0 Capacitor telefoni; menja se tek
   sa mobilnim šavom finalnog 3.0.
8. **pg_cron/pg_net na sy15**: watchdog (jobid 21 na cloudu) i push trigger zavise od obe
   ekstenzije — da li su žive posle restore-a? **Predlog: R0 obavezna provera** (`cron.job`,
   `net.http_post` probni poziv, poslednji BRIDGE_STALE red); ako fali → poseban infra task
   PRE talasa (nije blokada za read deo R1).

**Procena:** **1,5–2,5 MN** (ispod grube 2–3 iz PROCENA_SEOBE: authz je najmanji od svih talasa
— 9 politika, 1 front RPC, 0 storage — a trošak je FE mehanika: iframe host + most + touch port
~1.1k LOC + safety e2e). Uslov: komandna semantika se NE dira (svako „poboljšanje" toka = rizik).
