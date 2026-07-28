# MOBILNA 3.0 — kompletno stanje i šta nam je posle činiti

**Datum preseka:** 26.07.2026 (rano ujutru) · **Autor preseka:** Fable sesija (Faze 0–2 + odluke)
**ODLUKA (Nenad, 26.07): PAUZA — bez flipa `/m` → `/mob` dok je Nenad na odmoru (do 03.08).**
Svi radnici nastavljaju na 1.0 mobilnoj; 3.0 mobilna živi PARALELNO na `/mob` i slobodno se
testira. Ovaj dokument je jedino mesto sa celom slikom: šta je živo, kako radi, i šta ostaje.

Detaljniji plan po fazama: [PLAN_MOB_3.0.md](PLAN_MOB_3.0.md). Memorija sesija: `mob-30-strategija`.

---

## 1. Arhitektura (kako danas radi)

```
servosync.servoteh.com  ──►  Cloudflare Worker `servosync2` (run_worker_first)
   /m, /m/*, /assets/*, /icons/*, /manifest.webmanifest ──► 1.0 (servoteh-plan-montaze.pages.dev)
   SVE OSTALO (uklj. /mob/*) ──────────────────────────────► 3.0 static export (ASSETS)
```

- **APK** = Capacitor ljuska 1.0 repoa, `server.url = https://servosync.servoteh.com/m` —
  tanka ljuska nad živim webom (web izmene stižu bez novog APK-a). Nativni skener radi dok
  WebView ostaje na istom origin-u — zato je `/mob` na ISTOM domenu.
- **SSO most 1.0 → 3.0**: `src/lib/ss2Go.js` u 1.0 (klon `goLivePrisustvo`) šalje
  `#ss_token=<GoTrue JWT>&entry=<ruta>`; 3.0 `auth-context` ga razmeni na `POST /auth/sso`
  (HS256 deljeni `SY15_JWT_SECRET`, JIT provisioning) i obriše iz istorije.
- **Podaci**: kadr_*, sastanci_*, work_hours_remarks, loc_* tabele žive u **sy15 bazi**
  (kontejner `sy15-db`, RLS STVARAN — Supabase nasleđe). Glavna 3.0 baza = `servosync-pg`.
  Self-service write u sy15 = **SECURITY DEFINER RPC** (kanon `sastanci_set_my_rsvp`) —
  NIKAD popuštanje RLS politika.
- **API hostovi**: 3.0 = `api.servosync2.servoteh.com/api` · `api.servosync.servoteh.com` =
  sy15 gateway (⚠️ ima catch-all koji vraća 200 „ServoSync 1.5 gateway OK" — ne testirati rute na njemu).

## 2. Zaštite (mašinske brave — NE uklanjati)

1. **Guard u `deploy-frontend.yml`**: izmena `frontend/worker/index.ts`, `wrangler.jsonc`
   ili `public/sw.js` bez markera **`[worker-change]`** u commit poruci = deploy blokiran.
2. **Smoke posle svakog FE deploy-a**: `/m`, `/m/montaza`, `/m/odrzavanje` moraju vraćati
   1.0 („Servosync V1.0") + `/login` mora 3.0 — pad = crven workflow + uputstvo za rollback.
3. `public/sw.js` je v2 passthrough — povratak na kill-switch = reload petlja u APK-u.
4. Prefiksi `/assets/*`, `/icons/*`, `/manifest.webmanifest` pripadaju 1.0 dok proxy živi.

## 3. ŠTA JE ŽIVO (sve verifikovano na produ 25–26.07)

### 3.1 `/mob` hub (3.0) — 20 ekrana

| Ekran | Ruta | Gate | Poreklo |
|---|---|---|---|
| Hub (kartice + grupe) | `/mob` | prijava | Faza 0 |
| Magacin grupa: sken/premeštanje | `/mob/lokacije` | `lokacije.read` | pre-Faza 0 |
| — Gde je crtež? | `/mob/lokacije/pretraga` | (grupa) | Faza 2 |
| — Batch premeštanje | `/mob/lokacije/batch` | + `lokacije.move` (ekran) | Faza 2 |
| — Moja istorija (BE `mine=true`) | `/mob/lokacije/istorija` | (grupa) | Faza 2 |
| Moji reversi (read; akcije `reversi.manage`) | `/mob/reversi` | `reversi.read` | Faza 2 |
| Prisustvo uživo | `/mob/prisustvo` | `kadrovska.attendance` | pre-Faza 0 |
| Kadrovska pregled (bez PII) | `/mob/kadrovska` | `kadrovska.read` | Faza 2 |
| Moje prisustvo + korekcije | `/mob/moje-prisustvo` | prijava | Faza 0 (bivši /m/prisustvo) |
| Za mene (akcije/RSVP/predlozi) | `/mob/za-mene` | `sastanci.read` | Faza 2 |
| Odsustva/GO (+PDF rešenja) | `/mob/odsustva` | prijava | Faza 2 |
| Moji sati (+primedba HR-u) | `/mob/sati` | prijava | Faza 2 |
| Uvođenje (self-check) | `/mob/onboarding` | prijava | Odluka 2 |
| Odobravanja GO (šef/HR) | `/mob/odobravanja` | `kadrovska.vacreq_manage` | Faza 2 |
| Montaža grupa: plan/izveštaji | `/mob/montaza` | `montaza.read` | Faza 0 |
| — Izveštaj (AI wizard) | `/mob/izvestaj` | (grupa) | Faza 0 |
| — Neusaglašenosti | `/mob/neusaglasenosti` | `montaza.neusaglasenosti.write` | Faza 2 |
| Projektovanje (PB progres) | `/mob/projektovanje` | `pb.read` | Faza 2 |
| Održavanje | `/mob/odrzavanje` | `odrzavanje.read` | Faza 0 |
| Praćenje | `/mob/pracenje` | prijava (pogon!) | Faza 0 |
| Proizvodnja po mašini | `/mob/proizvodnja` | prijava (pogon!) | Faza 0 |
| Sastanci (+ Moja priprema) | `/mob/sastanci` | `sastanci.read` | Faza 0 + Odluka 3 |
| Moj profil | `/mob/profil` | prijava | Faza 2 |
| Energetika (SCADA touch) | `/mob/energetika` | `energetika.read` | Faza 0 |
| AI asistent | `/mob/ai` | `ai.chat` | Faza 0 |

Stare 3.0 rute `/m/<modul>` = redirect stubovi (služe se SAMO na LAN `:3000`).

### 3.2 U 1.0 aplikaciji (Faza 1)

- Hub kartica **„🚀 ServoSync 3.0"** (svi) → `/mob` sa sesijom (ss_token).
- **`/m/pracenje` auto-forward** na `/mob/pracenje` (O8 — stari ekran je čitao zamrznute
  podatke); `location.replace` (nema back-petlje); beg po uređaju: `localStorage.ss2_cutover='off'`.

### 3.3 Sve 4 permisijske odluke — presuđene 26.07 i žive

1. **Reversi self-return: NE** — magacioner potvrđuje/vraća; desktop dugmad iza `reversi.manage`.
2. **Onboarding self-check: DA** — RPC `profile_set_my_onboarding_task` + `PATCH
   /v1/profile/onboarding/tasks/:id` + `/mob/onboarding` ('skipped' ostaje HR-u).
3. **Sastanci: DA** — RPC-ovi `sastanci_set_my_akcija_status` (status svoje akcije) i
   `sastanci_set_my_priprema` (pripremljen+tekst) pod `read`; rute `POST /akcije/:id/moj-status`
   i `POST /:id/moja-priprema`. RLS netaknut.
4. **LZO/grupe proizvoda: ODLOŽENO** — posle migracije iz BigBit-a; reversi se do tada ne
   koristi kompletno; privremeno regex grupisanje ostaje.

SQL (primenjen uživo): `backend/docs/design/authz-snapshots/odluke23-self-rpc-2026-07-26.sql`.

### 3.4 Ključni komiti

Brave `0995f7a` · Faza 0 `6a98b78` · Faza 1 (1.0 repo, grana cutover/front-repoint)
`9de4d6f`+`9e77b51` · Faza 2 `f54c611` · odluka 1 `33967fb` · odluke 2+3 `0da8cf5`.

## 4. ČEKA PROVERU (tap-testovi — niko još nije probao na telefonu!)

1. Hub kartica „ServoSync 3.0" iz 1.0 → sleće na `/mob` ULOGOVAN (APK i browser).
2. „Praćenje" iz 1.0 → auto-prelaz na 3.0 sa svežim podacima; back ne upada u petlju.
3. `/mob/lokacije` sken kamerom u APK WebView-u (ljuska drži sve).
4. Odsustva: probni zahtev → radni dani → otkaži; PDF rešenja na odobrenom.
5. Odobravanja: odobri/odbij/pomeri (šef nivo pa HR nivo).
6. Batch premeštanje: polica → 2–3 skena → pošalji sve → Moja istorija.
7. Za mene: promeni status svoje akcije (bez zapisničara). Sastanak detalj: „Moja priprema".
8. Uvođenje: štikliranje (treba HR da otvori probni run — tabela je danas PRAZNA).
9. iPhone: kamera-dekoder proba (čeka još od 24.07 — vidi memoriju kamera-skener-engine).

## 5. ŠTA NAM JE POSLE ČINITI (posle 03.08)

### 5.1 Faza 3 — kraj seobe (redosled predložen)

1. **GO odluka za flip praćenja i ostalo** — posle tap-testova i par dana korišćenja `/mob`.
2. **Capacitor ljuska za 3.0**: nov APK sa `server.url → https://servosync.servoteh.com/mob`
   (ili koren); plugini: MLKit barcode (opciono — web skener već radi), push, filesystem/share
   (PDF!), app. 1.0 ljuska je šablon (`capacitor.config.json`, `android/`).
3. **Push notifikacije**: FCM projekat + 3.0 push servis (1.0 ima `device_push_tokens` +
   edge dispatch kao referencu; web-push u 3.0 čeka odobrenje zavisnosti).
4. **App-lock** (PIN/biometrija) — port 1.0 `appLock.js` ako se želi.
5. **Flip**: worker `/m` → redirect na `/mob` (izmena traži `[worker-change]`), gašenje
   pages.dev + GoTrue/1.0 fronta (poklapa se sa RADNI_PLAN Blok B4). TEK kad je sve gore ✅.

### 5.2 Sitne dopune (kad se stigne, ne blokiraju)

- Desktop `profil` onboarding sekcija: dodati self-toggle (mobilni ga već ima) + ispraviti
  snake/camel polja (`due_date` vs `dueDate` — desktop danas ne prikazuje rokove).
- Sastanci write ekrani (kreiranje tema/akcija, priprema za druge) — ostaju desktop.
- `/mob` rute u e2e smoke + eventualno u nav model (Ctrl+K skok na mobilne ekrane).
- Hub „grupa" obrazac ozvaničiti u DESIGN_SYSTEM §10 (MobEntry `children`).
- O8 za DESKTOP praćenje 1.0 (iframe klon Tehnologije) — to je F5a posao (PLAN_F5 §3.5).
- Čišćenje: `wt/mob-brave`, `wt/mob-faza0`, `wt/mob10-faza1` worktree-ovi + feature grane.

### 5.3 Vezano, van mobilnog

- Reversi LZO/grupe proizvoda — posle BigBit migracije (odluka 4).
- 1.0 `/m/lokacije` (read-only pregled predmeta) — odluka da li treba `/mob` ekvivalent.

## 6. Operativni recepti (da se ne traže ponovo)

- **1.0 deploy**: živa prod grana = `cutover/front-repoint` (main je divergiran 210/148 — NE
  spajati!). Push = samo preview; **produkcija** = GH dispatch „Deploy Cloudflare Pages" nad
  cutover ref-om sa `promote_to_production=true`. NIKAD lokalni vite build (lokalni `.env` →
  ugašeni cloud Supabase).
- **3.0 FE deploy**: push na main (frontend/**) → auto; LAN `:3000` dobija nove rute TEK uz
  backend deploy (`deploy-backend` workflow_dispatch ako je FE-only).
- **Posle svakog backend deploy-a**: `tr -d '\r' < backend/scripts/post-deploy-verify.sh |
  ssh ubuntusrv 'bash -s'` → mora 🟢 EXIT 0 (sekcija 6 čuva /m).
- **sy15 SQL izmene**: primeniti kroz `ssh ubuntusrv 'docker exec -i sy15-db psql -U postgres -d
  postgres'` + snimiti SQL u `backend/docs/design/authz-snapshots/`.
- Na ovoj mašini nema `gh` ni `python` — GitHub API sa tokenom iz `git credential fill`.
