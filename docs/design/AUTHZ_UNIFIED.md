# AUTHZ_UNIFIED — jedinstveni RBAC/RLS model (2.0 + 3.0-ready)

> **Status: IZVOR ISTINE za role i autorizaciju.** Objedinjuje 1.0 taksonomiju
> (`servoteh-plan-montaze/docs/servosync2_role_taxonomy.md`, prod) i 2.0 predlog
> ([RBAC_RLS_PREDLOG.md](RBAC_RLS_PREDLOG.md)). Nastao iz 3-agent grounded analize oba repoa (2026-07-08).
> Odluke (Nenad, 2026-07-08) zapisane u [../ODLUKE.md](../ODLUKE.md); ovaj dokument ih razrađuje.
>
> Materijalizacija u kodu: [`src/common/authz/roles.ts`](../../src/common/authz/roles.ts),
> [`role-permissions.ts`](../../src/common/authz/role-permissions.ts),
> [`permissions.ts`](../../src/common/authz/permissions.ts). Skelet migracije:
> [`sql/authz_rls_ready.skeleton.sql`](sql/authz_rls_ready.skeleton.sql).

## 1. Dva sloja — i zašto to rešava „pokriti 3.0 unapred"

Pitanje „da li da kreiramo RLS sa ovim rolama da pokrijemo i 3.0" ima dva sloja koja se mešaju:

| Sloj | Šta je | Odluka |
|---|---|---|
| **Model politike** (role + permisije + scope pravila + predikat-funkcije) | **trajna imovina** — isto važi i za guardove i za RLS | **Gradimo SADA, jedinstveno i 3.0-ready** |
| **Mehanizam sprovođenja** (nativni PG RLS vs NestJS guardovi) | **zamenljiv** | **Guardovi u 2.0; nativni RLS „flip-a-switch" u 3.0** |

**Zašto ne pun nativni RLS sada** (grounded iz koda, [RBAC §5 / §7.4](RBAC_RLS_PREDLOG.md)):
- App se konektuje kao **owner `servosync`** koji **zaobilazi RLS** → politike ne bi štitile ništa dok se ne
  uvede zasebna ne-superuser rola.
- Prisma je **direktna konekcija na PG (5435), bez poolera**; `PrismaService` je go singleton (nema `$extends`,
  nema request-scope). Pun RLS traži `SET LOCAL app.user_id` u interaktivnoj tx po requestu + prebacivanje
  celog DAL-a (array-`$transaction([...])` → callback-tx) — **širok prepis**.
- 2.0 core (TEHNOLOGIJA) ima **minimalan row-scoping** (tehnolog/CNC vide sve; realno samo RADNIK→mašina i
  TP-lock). Trenutno je i onako „svi ADMIN" (`PermissionsGuard` no-op) → RLS sada = ~nula sigurnosti, puna cena.

**Zašto RLS-ready ipak pokriva 3.0:** ako sada postavimo GUC ugovor, scope kolone, `worker_id`/`created_by_id`
FK i **predikat-funkcije koje zovu i app i buduće politike**, onda je uključivanje RLS-a u 3.0 dodavanje
`CREATE POLICY ... USING(fn())` — bez nove semantike. Vidi §5.

## 2. Objedinjeni katalog uloga (lowercase — kanonski)

Konvencija: **lowercase snake_case** (odluka 2026-07-08; [BACKEND_RULES §2.2](../BACKEND_RULES.md)). Prati 1.0 prod
(CHECK `user_roles_role_allowed`) i lowercase permission ključeve (`tehnologija.read`). **Princip: uloga ≠ radno
mesto** — titula (bravar/monter/tim lider) živi u sistematizaciji/`job_positions`, ne u ulozi.

Faze: **v1** = aktivno odmah (samo `admin`) · **v2** = aktivira se sa 2.0 modulima (proizvodni core) ·
**3.0** = ime rezervisano, aktivira se pri spajanju 1.0 · **deferred** = tek sa svojim modulom.

| Uloga (ključ) | Labela | Poreklo | Modul | Faza | Napomena |
|---|---|---|---|---|---|
| `admin` | Admin | oba | Core/Auth | **v1** | Sve. |
| `menadzment` | Menadžment | oba | Cross | **v2** | Uvid+write; Kadrovska scoped (`managed_sub_department_ids`); bez zarada. Validira završen TP (audit). |
| `sef` | Šef proizvodnje | 2.0 | Tehnologija + RN | **v2** | Pun TEHNOLOGIJA + approve/launch RN + write strukture + plan. Apsorbuje CMMS chief. **≠ `tim_lider`**. |
| `tehnolog` | Tehnolog | 2.0 | Tehnologija | **v2** | Pun modul; autor + potpis TP. |
| `cnc_programer` | CNC programer | 2.0 | Tehnologija — CNC | **v2** | Pun modul, fokus CNC programi (`cnc_programs`). Potpisuje TP. **≠ `cnc_operater`**. |
| `kontrolor` | Kontrolor | 2.0 | Tehnologija — Kvalitet | **v2** | Uža aktivacija 1.0 `kvalitet` (primopredaje/dorada/škart). Validira završen TP (audit). |
| `magacioner` | Magacioner | oba | Lokacije delova | **v2** | Lokacije write. 3.0: + reversi. |
| `proizvodni_radnik` | Proizvodni radnik | oba | RN / Proizvodnja | **v2** | **Objedinjuje 1.0 `proizvodni_radnik` + 2.0 draft `radnik`**. Svoje operacije po `machine_access`; unos rada. |
| `nabavka_view` | Nabavka (uvid) | 2.0 | MRP / Nabavka | **v2** | SAMO uvid — read podskup 1.0 `nabavka`. |
| `tim_lider` | Tim lider | 1.0 | Plan montaže / Proizvodnja | **3.0** | Pogonski šef BEZ Kadrovske. **NE mapirati u `sef`**. |
| `monter` | Monter | 1.0 | Montaža / Servis | **3.0** | Ulazi sa modulom Montaža. Titula ≠ uloga. |
| `cnc_operater` | CNC operater | oba | Proizvodnja — pregled+štampa | **3.0** | Nizak nivo. **Držati odvojeno od `cnc_programer`**. |
| `pm` / `leadpm` | (Lead) PM | oba | Projekti / PB | **3.0** | Jedine per-projekat uloge (`scope_type='project'`). |
| `hr` | HR | oba | Kadrovska | **3.0** | Bez zarada. |
| `poslovni_admin` | Poslovni admin | oba | Kadrovska (bez ugovora/zarada) | **3.0** | PII dokumenti. |
| `projektant_vodja` | Projektant (vođa) | oba | Projektni biro | **3.0** | + flag `finalni_potpisnik` (per-user override). Zamenjuje draft `projektni_biro`. |
| `inzenjer` | Inženjer | oba | Projektni biro | **3.0** | Ograničen edit. |
| `tehnicar_odrzavanja` | Tehničar održavanja | 2.0 | Održavanje / CMMS | **3.0** | 1.0 ekvivalent živi u `maint_user_profiles.role` (paralelni sistem). |
| `viewer` | Viewer | oba | — | **3.0** | Read-only baseline / fallback. |
| `nabavka` | Nabavka (puna) | 1.0 | 🔮 Nabavka | **deferred** | Tim lider + admin nabavke (read+write). |
| `kvalitet` | Kvalitet (pun) | 1.0 | 🔮 Kvalitet | **deferred** | Širi od `kontrolor`. |
| `prodaja` | Prodaja | 1.0 | 🔮 CRM / Ponude | **deferred** | |
| `finansije` | Finansije | 1.0 | 🔮 Finansije | **deferred** | Sad admin-only. |
| `user` | (prelazno) | 2.0 | — | prelazno | Šema default; migrira se u `viewer`. |

## 3. Razrešeni sudari (bilo je dva kataloga)

| Sudar | Razrešenje |
|---|---|
| **lowercase vs UPPERCASE** | ✅ **lowercase** u oba repoa (1.0 prod ima 313 politika + 54 naloga u lowercase; 2.0 UPPERCASE nije implementiran → jeftino uskladiti). Menja [BACKEND_RULES §2.2](../BACKEND_RULES.md). |
| `tim_lider` vs `sef` | **Različite uloge, NE 1:1.** `tim_lider` = laki pogonski šef bez Kadrovske/approve; `sef` = pun TEHNOLOGIJA + approve/launch. Pogrešno mapiranje bi dalo pogonu prava koja 1.0 uskraćuje. |
| `proizvodni_radnik` vs `radnik` (2.0) | **Isti pojam → jedan ključ `proizvodni_radnik`** (2.0 varijanta je nadskup: + machine-scope + unos rada). |
| `cnc_operater` vs `cnc_programer` | **Ostaju odvojene** (skoro isto ime, suprotan nivo prava — visok rizik zabune; svesno). |
| `monter`/`tim_lider`/`proizvodni_radnik` fale u 2.0 | ✅ **Dodati u katalog** (bili dodati u 1.0 posle 4.7. → „nadskup 1.0" invarijanta vraćena). |
| `nabavka`/`kvalitet` (deferred) vs `nabavka_view`/`kontrolor` | 2.0 uvodi **uže aktivacije** unutar modula Tehnologija (MRP-uvid, primopredaje); pune role čekaju svoje module. |

## 4. Šta 1.0 ima i šta 3.0 mora da preuzme (ground truth)

1.0 authz sloj (živa baza / migracije, bez `.claude/worktrees`): **~147 tabela sa RLS, 313 politika, 260
SECURITY DEFINER funkcija**. Auto-`RBAC_MATRIX.md` (111/313/260) **potcenjuje** jer preskače non-public šeme
`production/core/pdm`, SCADA, i `EXECUTE format()` dinamičke politike.

**Predikat-funkcije SU authz jezgro** — politike delegiraju na `has_edit_role()`,
`current_user_manages_employee()`, `maint_machine_visible()`, `is_sastanak_ucesnik()`, `current_user_is_admin()`.
To je ono što 3.0 mora verno preneti (u guardove ILI u RLS `USING`).

**3.0 mora da preuzme (kontrolna lista):**
- 260 SECURITY DEFINER predikata + RPC write-path-ove (append-only/audit tabele pišu SAMO oni; `USING(false)` +
  `REVOKE`). → NestJS servisne metode u tx uz zadržanu audit garanciju.
- **Skriveni moduli** koje matrica preskače: CMMS `maint_*` (profile-role + machine scope), Praćenje proizvodnje
  (non-public `production/core/pdm` + public wrapperi + `format()` politike), SCADA (`scada_*` + service_role bridge).
- Storage bucket RLS (`storage.objects`) → 3.0 (Cloudflare R2) reprodukovati u app sloju (presigned + ista provera).
- PII zaštita: `v_employees_safe` maskirani view + `employees_sensitive_guard` trigger + admin-only na
  `employee_children`/`salary_*`. **Poznat gap:** direktan SELECT na `employees` i dalje vraća PII — 3.0 zatvara na DTO nivou.
- **Anti-rekurzija** obrazac (politika NIKAD ne SELECT-uje `user_roles` direktno, već preko DEFINER helpera) — inače `42P17`.
- Identitet je **email-baziran** (`lower(auth.jwt()->>'email')`) svuda osim CMMS (`auth.uid()`) — 3.0 zadržati stabilan authz ključ.
- **Footgun:** RLS-disabled tabela čini admin-write politike inertnima → 3.0 CI provera + `FORCE ROW LEVEL SECURITY`.

## 5. RLS-ready blueprint (šta gradimo SADA)

Da 3.0 uključenje RLS-a bude flip-a-switch (skelet: [`sql/authz_rls_ready.skeleton.sql`](sql/authz_rls_ready.skeleton.sql)):

| Temelj | Šta | Status |
|---|---|---|
| **GUC ugovor** | app na svakom requestu: `SET LOCAL app.user_id` u interaktivnoj tx (pooler-safe; dokazano u `generic.syncer.ts`) | skelet |
| **`user_roles` + `user_permission_overrides`** | app-owned tabele (nadskup 1.0: + `managed_sub_department_ids[]`, + override flagovi) | skelet |
| **`users.worker_id` FK** | most JWT-user → `Worker` (definesApproval/definesLaunch/machine_access) | skelet |
| **`created_by_id` FK → users** | kanonsko vlasništvo reda (sad je string `created_by`) za owner-only obrazac | skelet (po tabeli) |
| **Scope kolone** | `project_id` (već na 5 tabela), `worker_id`, kasnije `department_id` | delom postoji |
| **Predikat-funkcije** | `app_current_user_id/has_role/is_admin/is_owner/has_machine/can_edit_project/manages_sub_department` — zovu ih **i** `ScopeService` **i** buduće politike | skelet |
| **Ne-superuser runtime rola + FORCE RLS** | **3.0 korak** (sad app ide kao owner koji zaobilazi RLS) | odloženo (zakomentarisano u skeletu §D) |

## 6. Sprovođenje u 2.0 — guardovi (već u kodu)

Luka je već napisao V1 skelet ([RBAC §5](RBAC_RLS_PREDLOG.md)):
- `JwtAuthGuard` (enforce-uje se), `JwtStrategy`, `AuthService` (bcrypt, JWT sa `role`).
- `PermissionsGuard` = **NO-OP** (svi ulogovani prolaze; §7 „svi ADMIN"), `@RequirePermission()` dekorator,
  `PERMISSIONS` katalog (23 ključa `modul.akcija`).

Ovaj dokument dodaje **izvor istine za V2 aktivaciju**:
- `roles.ts` — katalog uloga (lowercase) + metapodaci.
- `role-permissions.ts` — mapa `uloga → permisije[]` (== 1.0 `erpRbacMatrix.js`); FE dobija preko `GET /me/permissions`.
- **Dvoslojna autorizacija** (kao 1.0 „rola × flag"): `rn.launch`/`rn.approve` traže i `Worker.definesLaunch`/
  `definesApproval` (provera u servisu, ne u mapi). Row-scope (RADNIK→mašina, owner-na-TP, TP-lock) → `ScopeService`.

**V2 aktivacija = konfiguracija, ne prepravka kontrolera:** uključi logiku u `PermissionsGuard`
(`roleHasPermission`) + seed `user_roles`. Kontroleri se ne diraju.

### 6.1 Preduslovi aktivacije — da ne zaključamo produkciju

Radimo **direktno na produkciji (bez staging-a)** → aktivacija guard-a mora biti fazna:

1. **Normalizacija podataka:** živi `users.role` drži `'ADMIN'`/`'USER'` (uppercase), katalog je lowercase.
   Bez `UPDATE users SET role = lower(role)` aktivacija bi **odbila i admina** (lockout). Kod ima i
   defanzivnu normalizaciju (`normaliseRole()` u `role-permissions.ts`) — ali data-migracija je obavezna;
   `'user'` je prelazna uloga → mapira se u `viewer`.
2. **SHADOW MODE prvo (obavezno):** guard se prvo pušta u *log-only* režimu — env flag (npr.
   `AUTHZ_ENFORCE=false` default): guard **izračuna** odluku, **loguje** would-be `403` (user, uloga,
   permisija, endpoint), ali **pušta** zahtev. Nedelju dana na prod → pregled logova → tek onda
   `AUTHZ_ENFORCE=true`. Ovo je jedina bezbedna aktivacija bez staging okruženja.
3. **JWT most:** dok `user_roles` tabela ne zaživi, guard čita jednu ulogu iz `users.role` (JWT `role`
   claim); posle migracije prelazi na union preko `user_roles` + `UserPermissionOverride`
   (deny > grant > rola). `permissionsForRoles()` je rola-sloj — override se primenjuje POSLE uniona.
4. **Break-glass:** pre flipa na enforce, potvrditi da bar dva naloga imaju `admin` (i da je
   `AUTHZ_ENFORCE=false` rollback = restart sa env promenom, bez deploy-a).

## 7. Lanac dodavanja uloge u 2.0 (paralela 1.0 „7 mesta")

1.0 ima 7-mesto lanac (taxonomy §5) — dupliranje liste na 4 mesta je rizik drifta. **2.0 svodi na 2 izvora:**
1. `src/common/authz/roles.ts` (`ROLES` + `ROLE_CATALOG`) — jedini izvor liste uloga.
2. `src/common/authz/role-permissions.ts` — mapa prava.
Sve ostalo (DB CHECK, `/me/permissions`, FE dropdown) se **izvodi** iz ova dva (ne prepisuje).

## 8. Akcije

- [x] Objedinjeni katalog (§2) + kod (`roles.ts`, `role-permissions.ts`).
- [x] Konvencija = lowercase (BACKEND_RULES §2.2).
- [x] Skelet RLS-ready migracije (`sql/authz_rls_ready.skeleton.sql`).
- [ ] Kad DB bude gore: preneti §A u `schema.prisma` + `migrate:dev`; §B/§C kao raw SQL u istoj migraciji.
- [ ] `RBAC_RLS_PREDLOG §2` i `servosync2_role_taxonomy.md` → referenciraju OVAJ dokument (ne drže svoju listu).
- [ ] `ScopeService` (RBAC §5 Sloj 2) — where-builderi koji zovu iste predikat-funkcije.
- [ ] Dodati `proizvodni_radnik` unos-rada endpoint permisiju u kontrolere (`tehnologija.report_work`).
- [ ] (3.0) uvesti ne-superuser rolu + `FORCE RLS` + `CREATE POLICY` po skeletu §D.
