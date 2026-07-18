# ServoSync 3.0 — playbook migracije + modul-tracker

> **Živi dokument. Postoji IDENTIČAN u oba repoa** — `servoteh-plan-montaze/docs/MIGRACIJA_3.0_PLAYBOOK.md`
> (1.0) i `Servosync 2.0/backend/docs/MIGRACIJA_3.0_PLAYBOOK.md` (2.0). Izmena u jednom = obavezno preslikati
> u drugi (isti sadržaj, da obe strane vide isti plan).
>
> **Šta je ovo:** jedno mesto za praćenje seobe ServoSync 1.0 (Supabase) na 2.0 stack (NestJS + Prisma +
> PostgreSQL + Next.js) → jedna aplikacija (3.0). Konsoliduje planove razbacane po ~15 dokumenata i dodaje
> modul-tracker sa statusom. **Izvori istine iznad ovoga:** [ROADMAP.md](ROADMAP.md),
> [design/AUTHZ_UNIFIED.md](design/AUTHZ_UNIFIED.md), [ODLUKE.md](ODLUKE.md),
> [design/INTEGRACIJA-1.0-2.0-ANALIZA.md](design/INTEGRACIJA-1.0-2.0-ANALIZA.md),
> [frontend/docs/DESIGN_SYSTEM.md](../../frontend/docs/DESIGN_SYSTEM.md). *(Putanje važe iz 2.0 repoa; u 1.0
> repou ekvivalenti su u `docs/db/` i `docs/`.)*

---

## 0. Terminologija i trenutno stanje

| Verzija | Šta | Stack | Status |
|---|---|---|---|
| **1.0** | Operativni web moduli (kadrovska, lokacije, održavanje, sastanci, reversi, plan montaže…) | Vite + vanilla JS + **Supabase** | Živ na produkciji |
| **2.0** | QBigTehn proizvodni core (RN, TP, PDM/BOM, MRP, primopredaje, lokacije delova) | **NestJS + Prisma + PostgreSQL on-prem + Next.js** | **Živ na produkciji (8.7.2026)** — `servosync2.servoteh.com`, API kroz Cloudflare Tunnel |
| **3.0** | Seoba 1.0 modula na stack 2.0 → jedna aplikacija | isti kao 2.0 | **U planiranju — ovaj dokument** |
| **4.0** | BigBit ERP (GK/PDV/SEF/fakture) apsorbovan | isti kao 2.0 | Trigger-based, bez roka |

## 1. Odluke koje ovaj dokument sprovodi

Zabetonirano (ne otvaramo ponovo — vidi [ODLUKE.md](ODLUKE.md), [AUTHZ_UNIFIED.md](design/AUTHZ_UNIFIED.md)):

1. **Authz mehanizam:** NestJS **guardovi + query-scoping SADA**; nativni PostgreSQL RLS tek u 3.0 *ako zatreba*
   („RLS-ready sada, flip-a-switch u 3.0"). 2.0 već ima temelje (GUC `app.user_id`, `user_roles`,
   `worker_id`/`created_by_id` FK, predikat-funkcije) + Fazu 1–2 na produ (shadow-mode guard).
2. **Jedan katalog rola** za 1.0+2.0+3.0 (lowercase snake_case, `src/common/authz/roles.ts`).
   `tim_lider` ≠ `sef` (najopasniji sudar — pogrešno mapiranje bi dalo pogonu approve/launch).
3. **Obrazac seobe:** *initial load → paralelni rad → delta resync → cutover* (NE trajni dvosmerni sync).
   Odvojene baze/šeme na istom PG serveru; **merge po domenu kad modul dođe na red**, ne big-bang.
4. **Authz paritet se povlači sa žive `pg_policies`** modul-po-modul — NIKAD iz `RBAC_MATRIX.md`
   (regex generator preskače CMMS / praćenje proizvodnje / SCADA).
5. **Mobilne (Capacitor) ostaju** — prevodi se 5 šavova, ne aplikacija (vidi §6).

Novo (odluke iz sesije 2026-07-09, Nenad):

6. ✅ **Idemo 1.5 PRE 3.0** (najpre 1.0 Supabase → on-prem PG, pa tek onda strangler-fig na NestJS). Vidi §3.
7. ✅ **Zaposleni ostaju u 1.0 kao izvor istine i ostaju AKTIVNI.** `employees` (38 kolona) je bogatiji od
   2.0 `workers` (16) i već ima **živ istorijat koji se prati** — ne zamenjuje se. 2.0 `workers` je izveden
   operater-profil. Model spajanja u §4.
8. ✅ **Dizajn sistem je responsivan/optimizovan za sve rezolucije uključujući telefon** — V1 zahtev, ne 3.0.
   Uneto u [DESIGN_SYSTEM.md v0.2 §11](../../frontend/docs/DESIGN_SYSTEM.md). 2.0 ekrani danas to nisu →
   saniraju se; novi prolaze responsive proveru (360/768/1024/1440 px).
9. ✅ **Objedinjeni front — `servosync.servoteh.com` (1.0) je JEDINI front; 2.0 = modul „TEHNOLOGIJA".**
   (ODLUKA 09.07, Nenad — razjašnjeno.) 1.0 ostaje home/shell (+ LAN adresa) sa svim operativnim modulima;
   **ceo 2.0 (sad `servosync2`) ulazi kao JEDAN iframe-modul „Tehnologija"** — NE obrnuto. Temelj:
   **2.0 prihvata ISTI JWT kao 1.0** (email claim, isti GoTrue secret) → jedan login (uklapa se u
   [AUTHZ_UNIFIED](design/AUTHZ_UNIFIED.md)). Razrada u §2.1. *(Odlaže se — sada samo plan.)*
10. ✅ **Cutover odluke POTVRĐENE 09.07 (D1–D4, Nenad):**
    - **D1 Backend:** `api.servosync.servoteh.com` + Cloudflare **Total TLS** (subdomen 3. nivoa, Universal
      SSL ga ne pokriva) + **reuse postojećeg `servosync2` cloudflared-a** — dodatni public hostname ingress
      u Zero Trust dashboard-u (`api.servosync.servoteh.com → http://localhost:8080`); jedan cloudflared
      služi više hostname-ova, BEZ novog tunela/kontejnera. CORS u Caddy-ju.
    - **D2 LAN front:** **DA, minimalno** — Caddy vhost servira 1.0 `dist` (static) + same-origin proxy
      (`/rest /auth /storage /functions`) na LAN portu `:8090`; kad internet/CF padne, LAN URL radi sve
      on-prem. ⚠️ Zahteva **same-origin API base u LAN build-u** (`VITE_SUPABASE_URL` relativan/prazan →
      `sbReq` isti origin) = zaseban LAN build ILI runtime-resolve API base (kao 2.0 `client.ts`).
      Forward-compatible sa shell-om (§2.1).
    - **D3 GoTrue SMTP = Resend** (VIŠE NIJE opciono): `SMTP_HOST=smtp.resend.com`, `SMTP_PORT=587`,
      `SMTP_USER=resend`, `SMTP_PASS=<RESEND_API_KEY>`, sender `obavestenja@servoteh.com`. Uz
      `API_EXTERNAL_URL`=backend + `SITE_URL`=front + redirect allowlist (front `/reset-password`) →
      reset lozinke + invite RADE.
    - **D4 Rollback = forward-only:** drain→freeze; rollback (env nazad) SAMO do **tačke-bez-povratka
      ~T+2h** (ili prvi kritičan upis); posle toga se NE vraćamo — Supabase ostaje read-only 7 dana SAMO
      kao READ referenca; reverse-delta (sy15→cloud) samo u katastrofi, ručno.

    Razrada koraka: `infra/self-host/CUTOVER_1.5.md`.

---

## 2. Redosled (sekvenca 3.0)

```
1.5   (1.0 Supabase → on-prem PG, pored 2.0)          ← IZVRŠENO do cutover-a (§3.1)
 └─► AUTH INTEROP  2.0 prihvata 1.0 JWT (isti secret, email claim) → JEDAN identitet   (§2.1)
      └─► 3.0-SHELL  1.0 = JEDINI front (servosync.servoteh.com + LAN); 2.0 = modul „TEHNOLOGIJA" (iframe)   (§2.1)
           │         → OD SADA: jedna aplikacija u prikazu (1.0 home + Tehnologija sub-app)
           └─► 3.0-B  PILOT modul (Reversi/Lokacije) — prelaz = „iframe → nativna Next ruta"
                └─► 3.0-C  prioritetni spojevi: Zaposleni (mapping) + Lokacije
                     └─► 3.0-D  ostali moduli, strangler-fig (svaki: authz paritet §7 + „iframe→ruta")
                          └─► 3.0-E  delta resync → cutover (gase se PostgREST/GoTrue)
```

**Zašto ovim redom:** authz paritet po modulu (§7) je jedini pravi rizik (ocena 5/5,
[migration/03](migration/03-planmontaze-complexity-profile.md)); sve ostalo (UI, data model, čiste funkcije)
je mehaničko. **Novo: shell se pravi PRE migracije modula** — korisnik dobija „jednu aplikaciju" odmah, a
svaki modul se onda migrira nevidljivo (iframe→nativna ruta). Pilot bira samostalan modul da se izmeri tempo
pre nego što se dotakne Kadrovska (PII, zarade, najgušći authz).

---

## 2.1 Faza 3.0-shell — objedinjeni front PRE migracije modula (ODLUKA 09.07, Nenad)

**Cilj:** jedna aplikacija u prikazu ODMAH. **`servosync.servoteh.com` (1.0) je i ostaje JEDINI front**
(+ LAN adresa kao offline fallback). **Ceo 2.0 (sad `servosync2.servoteh.com`) ulazi kao JEDAN modul
„TEHNOLOGIJA"** na ekranu 1.0 — NE obrnuto. Nema prepravke 1.0 modula; 2.0 se samo embed-uje.
*(Smer 3.0 NEPROMENJEN: dugoročno se 1.0 moduli prepisuju NA 2.0 stack — 1.0 shell je privremeni ulaz.)*

> ✅ **PRVA FAZA IZVRŠENA 10.07.2026 — modul 📐 Tehnologija + SSO ŽIVI NA PRODU.**
> - **1.0:** HUB kartica → ruta `/tehnologija` → iframe ka `servosync2.servoteh.com`
>   (`src/ui/tehnologija/`, main `54f514a` + SSO bridge `887d31a`; obrazac za nove module = energetika-scada).
> - **SSO (varijanta postMessage — NE basePath/same-origin; to ostaje opcija za kasnije):** 2.0 u iframe-u
>   bez sesije javi `ss2-sso-ready` → 1.0 vrati `ss2-sso-token` (tekući GoTrue access token, origin-provereno
>   u OBA smera) → 2.0 front `POST /api/auth/sso` → backend (`bbb1b82`) verifikuje token **deljenim
>   `SY15_JWT_SECRET`** i po email-u (`users.email` unique) izda SVOJ token. **Autorizacija = postojanje
>   AKTIVNOG 2.0 naloga** (rola/permisije ostaju 2.0-ove): admin/tehnolozi/kontrolori ulaze bez kucanja;
>   bez naloga → normalan 2.0 login u iframe-u. Zajednički nalozi (npr. `tehnologija@`) NEMAJU SSO — lični email.
> - **Usput otkriveno i REŠENO:** `api.servosync2.servoteh.com` **nije postojao u DNS-u** (2.0 API je radio
>   SAMO sa LAN-a!) → dodata ruta u `servosync2` tunel (`localhost:3000`); 530/1033 = ruta na pogrešnom tunelu.
> - **Tehnički vodič za dalji rad na modulu (2.0 repo): `backend/docs/SSO_TEHNOLOGIJA.md`.**

**Mehanizam (1.0 = shell/home, 2.0 = jedan modul):**
- **1.0 app = home/shell** — već ima hub + nav sa svim operativnim modulima (kadrovska, sastanci, reversi,
  lokacije, održavanje, plan montaže, PB, SCADA…). Posle 1.5 ga on-prem stack servira na
  `servosync.servoteh.com` (+ LAN, kao offline fallback — isti obrazac kao 2.0 „front na :3000").
- **Nova stavka „Tehnologija" u 1.0 nav-u → iframe ka 2.0 app-u** (ceo servosync2 sa svojim RN/TP/PDM/…
  nav-om; bogata domenska pod-aplikacija, kao što SCADA modul već radi kroz iframe).
- Kasnija **Vite→Next migracija** pojedinih 1.0 modula je ODVOJEN, dugoročan tok — ne blokira ovo; end-state
  shell-a (da li ostaje 1.0 ili se prelazi na Next) bira se kasnije. Ovde je cilj **ujedinjenje prikaza**, ne prepravka.

**Faznost prikaza (POTVRĐENO 09.07, Nenad — na osnovu mockup-a¹):**
1. **Start:** „Tehnologija" = ZASEBNA kartica na HUB-u (pored „Proizvodnja") — nula prepravke, odmah upotrebljivo.
2. **Kasnije — spajanje/grupisanje:** „Tehnologija" (2.0 core) i „Proizvodnja" (1.0 planiranje/praćenje) se
   **prirodno stapaju u jednu grupu** — 1.0 Proizvodnja danas čita `bigtehn_*_cache` koji UMIRE sa QBigTehn
   cutover-om, pa se Praćenje/Plan proizvodnje ionako repointuju na 2.0 `tech_processes` (§4.2, tracker §5).
   Grupisanje modula na HUB-u (i eventualno spajanje kartica) radi se TADA, ne sada.

¹ Interaktivni mockup (HUB + modul Tehnologija + šav-toggle): https://claude.ai/code/artifact/455027a0-0201-44a5-8f37-8374f2cac34f

**JEDAN identitet + JEDAN origin (SSO):**
- **2.0 (NestJS) prihvata ISTI JWT kao 1.0 (GoTrue)** — isti secret, `email` claim → mapiranje na 2.0
  user/role (`AUTHZ_UNIFIED`). Korisnik se loguje jednom u 1.0; „Tehnologija" iframe radi bez novog login-a.
- **Serviranje pod ISTIM origin-om:** `servosync.servoteh.com/*` → 1.0 front; `servosync.servoteh.com/tehnologija/*`
  → 2.0 front (path-routing kroz Cloudflare/gateway). Isti origin → deljen `localStorage`/cookie → iframe čita
  isti token. **2.0 se pokreće pod `basePath=/tehnologija`** (`NEXT_PUBLIC_API_URL` + `next.config` basePath).

**Caveate:**
- **Vizuelni šav:** 1.0 (vanilla) ≠ teal 2.0; `docs/CURSOR_UI_USKLADJIVANJE_2.0.md` gura 1.0 ka teal → šav se smanjuje.
- **„Tehnologija" ima svoj nav** (RN/TP/PDM…) — to je OK (domenski sub-app), nije smetajući dupli nav.

**Kada:** posle 1.5 cutover-a. **BE zadatak:** 2.0 JWT strategija da prihvata GoTrue tokene (isti secret +
`email`→user/role) — i prvi korak ka punom auth paritetu (§7). **FE zadatak:** „Tehnologija" nav stavka +
iframe u 1.0 + 2.0 pod `basePath=/tehnologija` + jedan origin (Cloudflare path-routing).

---

## 3. Faza 1.5 — 1.0 sa Supabase clouda na on-prem PG (KADA i KAKO)

**Cilj:** 1.0 radi na našem Ubuntu serveru (isti kao 2.0), **kod 1.0 nepromenjen** — menja se samo API URL +
ključevi (sav data-access ide kroz `sbReq` wrapper). Posle 1.5 migracija podataka NESTAJE kao poseban posao u
3.0 (NestJS se u 3.0 kači na istu bazu). Detalji: **1.0 repo → docs/db/MIGRACIJA_NA_POSTGRESQL.md**.

**Obuhvat (ne samo PostgREST+GoTrue):**
- [ ] **PostgreSQL 17** + ekstenzije (pg_cron, pgcrypto, uuid-ossp, btree_gist, pg_safeupdate) — pored 2.0 PG.
- [ ] **PostgREST** → `/rest/v1` (ista gramatika — front netaknut).
- [ ] **GoTrue** → `/auth/v1` (login, refresh, recovery, **passkeys** — verzija sa WebAuthn). Rizik-odluka:
      ako self-hosted GoTrue nema kompatibilan passkey API → svesno žrtvovati passkeys (svi imaju lozinku),
      NE blokirati migraciju.
- [ ] **storage-api** → `/storage/v1` (fajlovi na disku/MinIO; provera sign gramatike).
- [ ] **12 edge funkcija** → Node worker (`/functions/v1`), dispatcheri kao interval petlje nad outbox tabelama.
- [ ] **pg_cron ekvivalenti** (17–26 poslova) + 5 outbox tabela + heartbeat monitoring od prvog dana.
- [ ] **Realtime → polling** (jedina upotreba = indikator u grid-u sati; degradira se, servis se NE diže).
- [ ] **Cloudflare Tunnel** → javna adresa OSTAJE ista (`servosync.servoteh.com`) — ključno za passkeys RP ID
      i mobilne (bez novog APK-a).
- [ ] **pgBackRest** + noćni logički dump off-site + testiran restore.

**Kada:** pre pilota 3.0. To je infra posao (~2–3 nedelje po proceni), odvojen od NestJS razvoja; može teći dok
2.0 tim radi domenske module. **Preduslov:** sanacija audit nalaza K1–K3
(**1.0 repo → docs/db/IZVESTAJ_AUDIT_2026-07-04.md**) — migrira se čista baza.

**Posle 1.5 obe baze su PG na istom serveru** → „otvaranje tabela" između njih postaje lako (§4).

### 3.1 Faza 1.5 — STANJE IZVRŠENJA (2026-07-09)

Runbook: `docs/db/RUNBOOK_1.5_SELF_HOST.md` · infra-as-code: `infra/self-host/` (compose, Caddyfile,
scripts `setup`/`restore`/`migrate-storage`/`gen-jwt-keys`, `functions-main` router). **Stack živi na
`ubuntusrv:~/servosync15`, izolovan od 2.0** (projekat `servosync15`, kontejneri `sy15-*`, gateway `:8080`,
db `127.0.0.1:5436`).

**✅ URAĐENO i validirano uživo:**
- **Stack (6 kontejnera):** PG17 `supabase/postgres:17.6.1.136` + GoTrue `v2.189` + PostgREST `v14.12` +
  storage-api `v1.60.4` + Caddy gateway + edge-runtime `v1.74`.
- **Restore žive 1.0 baze:** 198 tabela, 56 korisnika (bcrypt očuvan), 513 RLS, 697 fn, 5542 storage meta.
  **Login E2E** (kreiranje usera → login → token → autentikovani PostgREST 200). Zamke (drop baseline
  auth/storage, ownership, init-restart) rešene u `scripts/restore.sh`.
- **Storage:** 115 realnih fajlova / 185 MB preneto; `bigtehn-drawings` (673 MB) inicijalno preskočen —
  **ISPRAVKA (audit 09.07):** za 1.5 se ipak MIGRIRA, dedup je 3.0 end-state (v. §4.4).
- **Edge worker (edge-runtime):** svih 16 Deno fn služe verbatim na `/functions/v1/*`. **Tajne uvezane:**
  `PUSH_DISPATCH_KEY` (povraćen iz `private.app_config`), `RESEND`/`ANTHROPIC`/`OPENAI` (validirani — mejl
  poslat, AI odgovorio), **VAPID par regenerisan** (nov; public `BE9yAAa1…` → mora u `push.js:20` pri rebuild-u).
  `FCM_SERVICE_ACCOUNT` prazno (opciono). Vrednosti u `~/servosync15/.env` + `.found_secrets` (chmod 600).
- **pg_cron:** 22 posla restore-ovana + aktivna; **enqueue** poslovi pune outbox; **dispatch pulse** pokazuju
  na cloud preko vault-a (ne dekriptuje → NE šalje = bezbedno).
- **Committovano na main** (1.0 + 2.0 gde je zajedničko): playbook, runbook, `infra/self-host/`, edge-runtime.

**✅ CUTOVER 1.5 IZVRŠEN u noći 09→10.07.2026 (~23:30–01:00; sve verifikovano uživo):**
- **Freeze clouda:** read-only GUC + terminate + **PostgREST kill-switch** (Management API
  `db_schema→frozen`) — GUC sam NIJE dovoljan, PostgREST otvara transakcije eksplicitnim `READ WRITE`!
  Original config za rollback: `~/servosync15/.postgrest_rollback.json`.
- **Finalni dump+restore:** parity SVE ZELENO (157 employees / 56 auth.users / 5414 work_hours / 513 RLS / 22 cron).
- **Storage 5543/5543 fail=0** iz pre-staged keša (`dumps/storage-cache`, 1.2 GB) za ~2 min; `objects.version`
  se REGENERIŠE pri uploadu → storage migracija UVEK posle finalnog restore-a (inače 404).
- **Dispatch bez flood-a:** outbox mark `'sent'`, 3 cloud-pulse cron ugašena, push trigeri → `http://gateway`,
  scheduler pulsevi svi 200 (fn imaju fail-closed gate → service Bearer na SVE pozive).
- **Front repoint ŽIV:** `servosync.servoteh.com` → `api.servosync.servoteh.com` (reuse `servosync2` tunel +
  Total TLS). Hirurški repoint 10 linija (grana `cutover/front-repoint` je nosila STARIJI `push.js` — checkout
  cele grane bi regresovao native push!). **Shim u `src/lib/constants.js`** (stari/prazan env → on-prem
  URL+anon) jer se **DVA build pipeline-a trkaju** (GH Actions + CF Pages git build sa SVOJIM env-om).
- **Sateliti:** bridge (BigTehn+Katze) = **systemd na ubuntusrv** (`~/servoteh-bridge`) → repointovan na
  `localhost:8080`, sync `success`; `loc_bigtehn_ingest` = pg_cron U BAZI (samo-migrirao). **LAN fallback
  front** `http://192.168.64.28:8090` (T‑4b vhost) živ.
- **Noćne drame (rešene):** dupli CORS (gateway = JEDINI izvor CORS-a, `strip_upstream_cors`), SW keš na
  desktopu drži stari bundle, CF Pages env trka. Sve lekcije: `infra/self-host/CUTOVER_1.5.md`.
- **Zarade hardening (10.07):** `kadr_get_contract_salary` DEFINER RPC je propuštao `poslovni_admin` →
  zategnut na `current_user_is_admin()` (`sql/migrations/20260710_salary_contract_admin_only.sql`).

**⏳ OSTAJE (post-cutover operativa — plan: `docs/PLAN_POST_CUTOVER_KONSOLIDACIJA.md`):**
- **SCADA VM bridge repoint** — upisi stali 10.07 u 00:27; Energetika pokazuje bajato dok se `.env` na
  SCADA VM ne repointuje (isti recept kao bridge).
- **Drawings job:** `BIGTEHN_DRAWINGS_DIR` prazan na ubuntu bridge instanci → treba putanja/share do PDF
  crteža (poslednji uspešan upload 09.07 07:00 sa stare lokacije).
- **CF Pages env fix + konsolidacija na JEDAN build pipeline** (shim štiti u međuvremenu).
- **Cloud = READ referenca do ~17.07** → dekomisija + rotacija ključeva (`send-reminders` edge fn NIJE u
  repou — izvući pre gašenja!).
- `FCM_SERVICE_ACCOUNT` prazan (native push degradiran) · **passkeys ne rade na 1.5** (prijava lozinkom) ·
  `supabase/config.toml` + sb-sql/deploy-edge skilovi još pokazuju na cloud.

**AUDIT 09.07 (Fable-5) — pronađeni i primenjeni fixevi:**
- **Push trigeri na sy15 privremeno DISABLED** — gađali su cloud sa važećim ključem (rizik duplog slanja).
- **`activate-dispatch`:** fix statusa `'queued'` pri označavanju postojećeg outboxa.
- **Freeze/read-only redosled** utvrđen (prvo freeze, pa dump) + **dump-first restore** (nema restore-a bez svežeg dumpa).
- **`verify-parity` gate** — cutover ne ide dalje dok paritet cloud↔on-prem nije potvrđen.
- **`API_EXTERNAL_URL`** ispravljen (GoTrue linkovi) + **Cloudflare Total TLS** za nov hostname.
- **Passkeys se žrtvuju** pri prelasku (nov RP kontekst) + najava **prisilnog re-logina** korisnicima.
- **Rollback tačka-bez-povratka** definisana; **LAN front TBD**.
- Detalji i redosled koraka: `infra/self-host/CUTOVER_1.5.md`.

---

## 4. „Otvaranje tabela" i spajanje domena (KADA i KAKO)

Posle 1.5 imamo **dve PG baze/šeme na istom serveru** (1.0 i 2.0). Ne spajaju se prvog dana u jednu — spajaju
se **po domenu, kad taj modul dođe na red** u 3.0. Pravila (iz ROADMAP „Sync tokom tranzicije"):

- **Jedan izvor istine po tabeli, jednosmerno po tabeli.** „Oba smera" = više jednosmernih tokova, nikad
  dvosmerno na istim redovima (izbegava konflikt-pakao).
- **PG↔PG je lako** (obe strane Postgres): opcija A — reuse `bb-sync` framework sa novim `SourceConnector`
  (čita 1.0 bazu); opcija B — `postgres_fdw`; opcija C — logička replikacija. Za matične podatke (stotine
  redova) trošak je mali.
- **Stabilan ključ mapiranja** (`legacy_*` na obe strane) + **delete/tombstone** strategija su jedini pravi trošak.
- Svaki most ima **„sunset" datum** — umire čim se modul integriše u 3.0.

### 4.1 Zaposleni — 1.0 `employees` je i ostaje izvor istine (ODLUKA #7)

**`employees` (1.0) ostaje aktivan i vlasnik podataka o osobama.** Razlog: 38 kolona (matični, datum rođenja,
adresa, banka, obrazovanje, lekarski, hitni kontakt, tim…) i **živ istorijat koji se prati** — nemerljivo
bogatiji od 2.0 `workers` (16 kolona: login, kartica, radna jedinica, `defines_launch/approval`).

| | 1.0 `employees` | 2.0 `workers` |
|---|---|---|
| Uloga | **person-master** (osoba, HR) — izvor istine | **operater-profil** (ko radi/potpisuje/lansira RN) |
| Ključ | `uuid` | `integer` (legacy QBigTehn id) |
| Vlasništvo u 3.0 | 1.0 / Kadrovska modul (migrira POZNO) | 2.0 (proizvodnja) |

**Problem:** nema zajedničkog tvrdog ključa (mereno 8.7): matični 0/169 u `workers`; `card_id` 169/169 u
`workers` vs `card_barcode` 0/155 u `employees`; ime = samo fuzzy (100/169).

**Model spajanja:**
1. **`worker_employee_map`** (mapping tabela sa potvrdom — isti obrazac koji 1.0 već ima za prisustvo
   `katze_employee_map`: `match_method`, `confirmed_by`, `confirmed_at`). Seed = fuzzy po imenu → **čovek potvrdi**.
2. **Uspostaviti tvrd ključ za ubuduće:** popuniti `card_id` ↔ `card_barcode` (ili matični) na jednoj strani.
   *Otvoreno pitanje (Nesa/kadrovska): da li je `card_id` iz QBigTehn-a ista fizička kartica kao `card_barcode`
   u 1.0? Ako da → najbrži tvrd ključ.*
3. **`users.worker_id` FK** (već u 2.0 authz skeletonu) je most JWT-user → `worker` → (preko mape) → `employee`.
   Tako proizvodni događaj (otkucana operacija) zna i koja je HR-osoba.
4. **Smer podataka:** `employees` → `workers` je **jednosmerni pull** samo za identitet/display; proizvodna
   polja (kartica, `machine_access`, `defines_*`) žive na `workers`/overlay, HR polja na `employees`. **Nijedna
   tabela ne pokušava da poseduje oboje.** Ako 2.0 vraća nešto HR-u (npr. sati) → **zaseban push u zasebnu tabelu**.

**Kada:** mapping se postavlja rano (već sada koristan — 2.0 proizvodnja referencira `workers`), ali **pun
Kadrovska modul migrira pozno** u 3.0-D (rich šema se čuva, ne stapa se u `workers`).

### 4.2 Lokacije — `loc_*` (1.0) je jedinstveni sistem (INTEGRACIJA §3)

- **Fizičke lokacije = `loc_*` model iz 1.0** (hijerarhija, placements, movements ledger, offline
  `client_event_uuid`) — jasno napredniji → postaje jedinstven sistem lokacija u 3.0.
- **2.0 `part_locations` = praćenje proizvodnje** (koliko komada RN/pozicije je na kom kvalitetu/koraku), NE
  fizička polica → mapira se na proizvodni status, ne na `loc_locations`.
- ⚠️ **Kritičan most pri gašenju QBigTehn-a:** 1.0 loc modul zavisi od žive QBigTehn baze u OBA smera
  (auto-ingest gde je deo na mašini iz `tTehPostupak`; outbound `sp_ApplyLocationEvent`). Pri cutover-u 2.0
  preuzima proizvodnju kao vlasnik → 1.0 loc ingest se **repointuje sa QBigTehn cache-a na ServoSync
  `tech_processes`**, outbound se gasi/preusmerava. **Ne gasiti QBigTehn dok ovaj most nije prebačen.**

### 4.3 Ostala preklapanja imena (usaglasiti pre stapanja)

`projects` (2.0 = predmeti 7.602 ≠ 1.0 = interni projekti 23) · `departments` (1.0 = izvor istine, 13 vs 1) ·
`audit_log` (dve šeme → objediniti) · crteži (vidi §4.4). **Ne stapati naslepo po imenu.**

### 4.4 Crteži — DEDUP: 1.0 viewer čita iz 2.0 `drawing_pdfs` (ODLUKA 2026-07-09, Nenad)

**Nalaz (mereno uživo 09.07):** 1.0 `bigtehn-drawings` bucket (5426 fajlova, **673 MB**) i 2.0 `drawing_pdfs`
(`pdf_binary` bytea, 5425) su **isti crteži iz istog PDM izvora** — 1.0 kao PDF izvezen u
`C:\PDMExport\PDFImportovano` (bridge `syncBigtehnDrawings` → bucket), 2.0 direktno iz PDM MS SQL
(`Was: PDM_PDFCrtezi`). Pokrivenost **4595/4596 distinct brojeva = 99,98%** u 2.0 `drawing_pdfs`.

**Odluka:** NE duplirati crteže — 2.0 `drawing_pdfs` je jedina kanonska on-prem kopija.
- 1.0 pregled crteža (Praćenje proizvodnje, Plan Montaže) **čita iz 2.0 `drawing_pdfs`**: adapter u
  `src/services/drawings.js` (`drawing_no` `1133219_B` → `drawing_number=1133219`+`revision=B`; resolver već
  ima revision-fallback). Izvodi se pri cutover-u (§ App repoint u §5 tracker-u / RUNBOOK Faza 3).
- Bridge `syncBigtehnDrawings` se **gasi** — u 3.0 ostaje JEDAN put uvoza crteža (2.0 PDM sync).
- ⚠️ **VAŽNA DISTINKCIJA (ispravka 09.07, Fable-5 audit): dedup je 3.0 END-STATE, ne 1.5.** Za **1.5
  cutover** 1.0 ostaje **self-contained** → bucket `bigtehn-drawings` (673 MB) **SE MIGRIRA** na on-prem
  storage (ne preskače se), jer adapter u `src/services/drawings.js` i JWT-interop ka 2.0 `drawing_pdfs`
  nisu spremni na 1.5. Ranija tvrdnja da „storage migracija 1.5 preskače `bigtehn-drawings`" je POVUČENA.
  Preskakanje/dedup se izvodi tek u 3.0, kad 1.0 viewer pređe na 2.0 `drawing_pdfs`.
- Do audita je kroz `infra/self-host/scripts/migrate-storage.sh` preneto 115 realnih 1.0 fajlova (185 MB);
  `bigtehn-drawings` se donosi u sklopu cutover pripreme (v. `infra/self-host/CUTOVER_1.5.md`).

---

## 5. Modul-tracker (3.0)

Legenda statusa: ⬜ nije poč(e)to · 🟡 u toku · ✅ gotovo (živo). „Authz težina" = koliko je authz paritet
težak za taj modul. Sve iz 1.0 su **owner** (ServoSync piše).

| Modul (1.0) | Faza | Authz izvor & težina | Ključne teškoće | Zavisnosti | BE | FE | Mob | Status |
|---|---|---|---|---|---|---|---|---|
| **Lokacije** (`loc_*`) + **Štampa** | Talas A | scoped write; srednje-visoka | most na tech_processes (§4.2); front(12 fn)/bridge(24) podela — bridge OSTAJE u sy15; movements već idempotentni (client_event_uuid) | Reversi (loc spoj) | 🟡 | ⬜ | ⬜ | 🟡 **spec ODOBREN + R0 grants na sy15 IZVRŠEN 12.07 + R1 U TOKU (Opus, grana wave-a/lokacije)** |
| **Reversi** | pilot | modul-manager write; srednje | transakcioni inventar RPC → NestJS tx; idempotencija | ⚠️ loc_* atomarnost (issue/return piše u loc u ISTOJ tx → podaci OSTAJU u sy15 bazi, 2.0 BE drugi datasource + GUC most) | 🟢 | 🟢 | 🟢 | ✅ **UŽIVO 11.07** (servosync2/reversi kroz živi backend); ostaje domenska validacija reznog (Nenad) |
| **Sastanci + AI asistent** | Talas B | participant-scoped; srednje | 13 front RPC; ai-chat (4 engine-a, 22 RPC alata) → NestJS; deljeni STT/refine servis nastaje u B | storage | ⬜ | ⬜ | ⬜ | 🟡 **spec ✅ 12.07** (2,5–4 MN; 10 pitanja) |
| **Plan montaže** | Talas C | per-projekat (`has_edit_role`); srednje | ⚠️ tim_lider edit u 1.0 = FANTOMSKI (samo localStorage); Gantt port; AI izveštaji edge→NestJS | employees map | ⬜ | ⬜ | ⬜ | 🟡 **spec ✅ 12.07** (Talas C Σ 4,5–6,5 MN; 11 pitanja) |
| **Plan proizvodnje** | Talas C | modul-manager; srednje | overlay nad bigtehn keš (MOST, repoint uz QBigTehn cutover) | 2.0 RN | ⬜ | ⬜ | ⬜ | 🟡 **spec ✅ 12.07** |
| **Praćenje proizvodnje** | Talas C | ~~format() VISOKA~~ → **uniformno (2 gate fn); srednje** | non-public šeme kroz public view/RPC most; „realtime" = polling 30s | 2.0 proizvodnja | ⬜ | ⬜ | ⬜ | 🟡 **spec ✅ 12.07** (131 politika popisana) |
| **Projektni biro (PB)** | Talas D | `inzenjer`/`projektant_vodja`; srednje | `finalni_potpisnik` NE POSTOJI u 1.0 (netačna činjenica); bez realtime/PDF | employees map | ⬜ | ⬜ | ⬜ | 🟡 **spec ✅ 12.07** (Talas D Σ 6–8 MN; 11 pitanja) |
| **Moj profil** | Talas D | self-service RLS; nisko | čist agregator (0 svojih tabela) → CEO u D kroz GUC; deljeni RPC sa G popisani | Kadrovska RPC (netaknuti) | ⬜ | ⬜ | ⬜ | 🟡 **spec ✅ 12.07** |
| **Podešavanja (RBAC admin)** | Talas D | admin; **VISOKA (novi rizik)** | dvostrani identitet naloga (2.0 master → piše u GoTrue+sy15 I 2.0) | user_roles | ⬜ | ⬜ | ⬜ | 🟡 **spec ✅ 12.07** |
| **SCADA / Energetika** | Talas E | `scada_*`; **authz NAJMANJI** (9 pol, 1 front RPC) | trošak = iframe host + `__SCADA_BRIDGE__` most + touch port; safety semantika ZAMRZNUTA; repoint na sy15 VEĆ urađen 11.07 (port 3010) | SCADA VM ✅ | ⬜ | ⬜ | ⬜ | 🟡 **spec ✅ 12.07** (1,5–2,5 MN; 8 pitanja) |
| **Održavanje (CMMS)** ⚠️ | Talas F | **odvojen role sistem (`maint_user_profiles`); VISOKA** | GUC most mora `sub` I `email`; 9/16 front RPC bez maint prefiksa; ⚠️ notif dispatch MRTAV na produ (paritet only) | employees map | ⬜ | ⬜ | ⬜ | 🟡 **spec ✅ 12.07** (5–6,5 MN; 102 politike popisane; 8 pitanja) |
| **Kadrovska (HR)** ⚠️ | Talas G (POZNO) | **PII + zarade admin-only; NAJVIŠA** | `employees` = izvor istine (§4.1); `v_employees_safe` maska; zarade immutability | employees master | ⬜ | ⬜ | ⬜ | ⬜ **spec PENDING** (agent zaustavljen 12.07; sačuvani fn-snapshot 119 fn + radna beleška — relansirati pred talas G) |

> ⚠️ = „skriveni modul" koji auto-`RBAC_MATRIX.md` preskače → authz OBAVEZNO povući sa žive `pg_policies`.
> Kadrovska namerno ide poslednja: najgušći authz + PII + zarade; `employees` ostaje aktivan izvor istine celo vreme.

---

## 6. Mobilni šavovi (Capacitor ostaje — 5 tačaka)

Ljuska i native plugini preživljavaju (`server.url` → web, javna adresa ista zbog Tunnel odluke; nov APK samo
ako se adresa promeni). Prevodi se 5 veza sa Supabase-om, ne aplikacija:

- [ ] **Offline queue** (~424 LOC) — čuva PostgREST putanje, replay; prepisati na NestJS ugovor uz očuvanu
      idempotenciju (`client_event_uuid`). ⚠️ najopasnija tačka: greška = tihi duplikati u magacinu.
- [ ] **Auth tok** — GoTrue PKCE/refresh/**passkeys** utkani u `sbReq` → NestJS JWT refresh + WebAuthn iznova.
- [ ] **Push** — FCM v1 / APNs / Web Push VAPID dispatch prelazi sa Supabase edge sloja u NestJS; native plugin ostaje.
- [ ] **Realtime** (`work_hours`) — `postgres_changes` → WS gateway ili LISTEN/NOTIFY.
- [ ] **Service worker / PWA keš** — Workbox regex ima hardkodovane Supabase URL-ove → ažurirati na nove API putanje.

Mobilni UI ekrani (~7.3K LOC) idu kroz istu preradu kao desktop — nisu poseban trošak.

---

## 7. Authz paritet — kontrolna lista po modulu (obrazac)

Za svaki modul u 3.0, pre „gotovo":
- [ ] Povučene žive politike modula sa `pg_policies` (NE iz RBAC_MATRIX.md).
- [ ] Coarse sloj: `@RequirePermission('modul.akcija')` na endpointima.
- [ ] Row sloj: `ScopeService` builder(i) — `scopeOwn` / `scopeManagedDepartments` / `scopeProject` /
      `scopeMachineAccess` / `scopeUnlocked` po potrebi.
- [ ] Mutaciona pravila u servisu: zaključavanja (lock/finished), flag provere (`definesLaunch`),
      no-client-write tabele (audit/history piše samo servis).
- [ ] SECURITY DEFINER RPC-ovi modula → NestJS servisne metode u transakciji + provera role u telu.
- [ ] Storage bucket authz → presigned + ista provera u aplikaciji.
- [ ] **e2e permission matrica** (rola × endpoint × 200/403 + row-scope asercije) — bez ovoga se paritet ne dokazuje.

## 8. Cutover — kontrolna lista

> ⚠️ **SVAKI cutover ide UVEČE / off-hours (kad niko ne radi).** Dva cutover-a: **(A) 1.5 cutover** —
> 1.0 sa Supabase clouda na on-prem (blizak; stanje/pending u §3.1); **(B) finalni 3.0 cutover** — gase se
> PostgREST/GoTrue + QBigTehn sync. Kritično: dok stari izvor radi, **NE uključivati dispatch** na novom
> stacku (dupli mejlovi/push realnim korisnicima).

**(A) 1.5 cutover (1.0 → on-prem) — ✅ IZVRŠEN 10.07.2026** (stanje/lekcije: §3.1 + `infra/self-host/CUTOVER_1.5.md`):
- [ ] Cloudflare Tunnel hostname za `sy15` gateway; javna adresa (jedan origin ako se radi shell §2.1).
- [ ] Repoint 1.0 front: `VITE_SUPABASE_URL` + nov anon ključ + hardkodovani URL-ovi (ocena.html/legacy/SW regex) + sateliti + APK.
- [ ] ⚠️ **Cloud read-only je PREDUSLOV za start schedulera (ne posle)** — scheduler na sy15 se NE pokreće dok cloud još piše (dupli mejlovi/push).
- [ ] **Označi postojeći outbox obrađenim** → uključi scheduler (naše dispatch fn) → **repoint push trigera** (cloud URL → gateway).
- [ ] Nova VAPID public u `push.js:20` + rebuild.
- [ ] Supabase → read-only; rollback prozor 7–14 dana; grep živog bundle-a za novi URL.

**(B) finalni 3.0 cutover (kraj migracije modula):**
- [ ] Freeze izmena šeme; poslednji delta resync po restrukturiranim domenima (transform, ne plain copy).
- [ ] Smoke test novog stacka (login lozinka + passkey, RPC uzorak, upload/sign, mejl iz outboxa, push).
- [ ] Env promena svuda (CF Pages, GitHub Secrets, `.env`, SW regex, mobilni `server.url` ako se menja adresa).
- [ ] Rebuild + deploy; **grep živog bundle-a** za novi URL (SW drži stari bundle satima).
- [ ] Supabase/stari izvor → read-only, rollback prozor 7–14 dana.
- [ ] Gase se PostgREST/GoTrue (1.0) **i** QBigTehn sync (2.0) — cilj: isti prozor (ako write-paritet + usvajanje gotovi).
- [ ] Loc most (§4.2) prebačen PRE gašenja QBigTehn-a.

---

## 9. Otvorena pitanja (za tim)

1. **`card_id` (QBigTehn) == `card_barcode`/katze (1.0)?** Ako da → tvrd ključ za spajanje zaposlenih (§4.1).
2. **`part_locations` (2.0)** = fizička pozicija ili proizvodni status? (Negovan; §4.2).
3. **1.5 obuhvat i tempo** — potvrditi verzije komponenti (pinned) i redosled infra koraka.
4. Koje su matične tabele „deljene" od prvog dana 3.0 (departments, auth) a koje ostaju po modulu.

## 10. Changelog

| Datum | Šta |
|---|---|
| 2026-07-13 | **MASOVNO IZVRŠAVANJE (Opus multiagenti).** Svih 6 backend talasa dobilo **R1 read sloj + adversarni review + fix**: B(sastanci-ai)/C(planovi-pracenje)/D(pb-profil-podesavanja)/E(energetika)/F(odrzavanje) — svaki na `wave-*` grani (NIJE na main). **B pun stek**: +R2 (mutacije/storage/AI port) +R3 frontend (`wave-b-fe`). Review (Workflow multiagent) uhvatio klasu bagova koju mock-testovi ne vide: **BYPASSRLS curenje** (fix = doktrina §A.2a `withUserRls` + sy15 `GRANT authenticated TO servosync2_app`), pogrešna imena kolona (F `effective_status`→`status`, 500 na CMMS), integer=text (C), no-op filteri (D), skraćen AI safety-prompt (B). **Integracioni dry-run** (`integration/waves-bcdef`) validiran: 5 talasa spojeno, tsc+build čisti, 572/578. **G (Kadrovska) spec gotov** (`81600d3`): 141 politika, PII=admin+poslovni_admin (HR nema!), 8.5-11 MN, 11 pitanja čekaju presudu. **U toku:** R2 mutacije C/D/F + R2 komande E + R2 Lokacije. **Kapija:** merge na main čeka Nenada (main deljen sa Tehnologija sesijom). Lekcija: proveravati živost agenata (2 tiho umrla ~27h, recovered). |
| 2026-07-12 | **SPEC FAZA B–F ZAVRŠENA (5 paralelnih Fable agenata) + Talas A R0/R1 pokrenut.** Specovi + authz snapshoti na 2.0 main `663abf3` (`MODULE_SPEC_{sastanci_ai,planovi_pracenje,pb_profil_podesavanja,scada,odrzavanje}_30.md`); konsolidovana pitanja `OTVORENA_PITANJA_TALASI_B-F_2026-07-12.md` (48 + H1–H4 harmonizacije) čekaju Nenadovu presudu. Ključni nalazi: tim_lider edit PM fantomski (C1); `finalni_potpisnik` ne postoji (D); maint dispatch MRTAV na produ (F1); SCADA repoint VEĆ urađen 11.07; Praćenje politike uniformne (rizik razrešen). Kadrovska (G) spec PENDING — agent zaustavljen, fn-snapshot (119) + radna beleška sačuvani. R0 Lokacije grants izvršeni na sy15 (`20260712_loc_talas_a_grants.sql`, 9=9 politika); R1 delegiran Opusu (grana `wave-a/lokacije`). PROCENA ažurirana: faza 2.0 ~44→**~40 MN** (izmereno B–F Σ 19,5–27,5). |
| 2026-07-10 (2) | **PILOT 3.0-B (Reversi) POKRENUT — spec + živi authz snapshot** (2.0 repo: `backend/docs/design/MODULE_SPEC_reversi.md`, grana feat/wave-3 `4cfc721`). Ključni nalaz: Reversi NIJE bez zavisnosti — `rev_issue_reversal`/`confirm_return` atomarno pišu i u `loc_*` → **pilot NE seli podatke** (rev_* ostaje u sy15 bazi; NestJS drugi datasource + GUC most `request.jwt.claims`; „cutover" modula = čist UI preklop). Tracker: Reversi 🟡. Usput: hub 1.0 domen-sekcije (73889ba) + 2.0 sidebar sekcije (fe `ff61063`) — `PLAN_MODULA_MES_3.0.md` Korak 0+1 ✅. |
| 2026-07-10 | **CUTOVER 1.5 IZVRŠEN** (§3.1: freeze uz PostgREST kill-switch — GUC nedovoljan!, parity zeleno, storage iz keša 5543/5543, scheduler, LAN vhost :8090, shim za trku DVA build pipeline-a) + **§2.1 prva faza IZVRŠENA: modul 📐 Tehnologija + SSO RADI** (postMessage handoff, 2.0 `POST /api/auth/sso`, `api.servosync2` ruta u tunelu — DNS NIJE postojao). Zarade: `kadr_get_contract_salary` admin-only. Tehnolozi otvoreni na obe strane. Detalji: `CUTOVER_1.5.md` + 2.0 `backend/docs/SSO_TEHNOLOGIJA.md`. |
| 2026-07-09 | Prva verzija. Konsoliduje ROADMAP + AUTHZ_UNIFIED + INTEGRACIJA + RBAC_RLS_PREDLOG + migration/03,16 + DESIGN_SYSTEM. Ugrađuje odluke sesije 09.07: 1.5 pre 3.0 (§3), zaposleni = 1.0 izvor istine i aktivni (§4.1), responsivnost V1 zahtev (§1.8). Modul-tracker §5. |
| 2026-07-09 (2) | **Faza 1.5 IZVRŠENA do data+auth+storage** — self-host stack živ na `ubuntusrv:~/servosync15` (`infra/self-host/`): baza restore (198 tabela, 56 korisnika, 513 RLS), storage 115 fajlova/185 MB, login E2E. **§4.4 dodato: crteži DEDUP** (1.0 viewer → 2.0 `drawing_pdfs`; `bigtehn-drawings` 673 MB se NE migrira; bridge `syncBigtehnDrawings` se gasi). Ostaje: Node worker, pg_cron, Tunnel, repoint. |
| 2026-07-09 (6) | **Potvrđene 4 cutover odluke (D1–D4, §1 #10)** — backend `api.servosync.servoteh.com` + Total TLS + reuse `servosync2` cloudflared tunela (ingress u dashboard-u), LAN front DA (minimalni same-origin Caddy vhost `:8090`, CUTOVER T‑4b), GoTrue SMTP=Resend (obavezno, ne opcija), rollback forward-only (tačka-bez-povratka ~T+2h). |
| 2026-07-09 (5) | **Fable-5 audit primenjen** — cutover runbook + skripte ojačane (push trigeri disabled, activate-dispatch `'queued'` fix, freeze/read-only redosled, dump-first restore, verify-parity gate, API_EXTERNAL_URL, Total TLS, passkeys+re-login, rollback tačka-bez-povratka); **1.5 zadržava `bigtehn-drawings`** (dedup je 3.0 end-state, §4.4/§3.1); §8: cloud read-only PREDUSLOV za scheduler. |
| 2026-07-09 (4) | **Razjašnjen pravac shell-a (§1 #9, §2.1, §2 dijagram):** `servosync.servoteh.com` (1.0) je JEDINI front (+ LAN); ceo 2.0 (`servosync2`) ulazi kao JEDAN iframe-modul „TEHNOLOGIJA" — NE 2.0-kao-shell. SSO: 2.0 prihvata isti JWT + jedan origin (`/tehnologija` path-routing, `basePath`). Cutover-readiness dodat: `CUTOVER_1.5.md` + scheduler (profil `cutover`) + `activate-dispatch.sql` (na main). |
| 2026-07-09 (3) | **Edge worker gotov + odluka o objedinjenom frontu.** Edge-runtime služi svih 16 fn verbatim; sve tajne uvezane i validirane (mejl/AI/push; VAPID par regenerisan; PUSH_DISPATCH_KEY povraćen iz `private.app_config`). **§1 #9 + §2.1 dodato: Faza 3.0-shell** (objedinjeni front PRE migracije modula; **2.0 prihvata isti JWT kao 1.0** = jedan identitet; iframe-embed + jedan origin + embed-mode). **§3.1 dodato: stanje izvršenja 1.5** (done vs pending). **§8 razdvojen** na 1.5 cutover i finalni 3.0 cutover, uz off-hours upozorenje. **Cutover JOŠ NIJE odrađen** — ide uveče. |
