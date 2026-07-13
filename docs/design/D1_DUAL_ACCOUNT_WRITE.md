# D1 — Dvostrano upravljanje nalozima (2.0-master dual-write)

**Talas D · R2 · WRITE sloj Podešavanja/RBAC** — MODULE_SPEC_pb_profil_podesavanja_30.md §7 P1
(PRESUĐEN 12.07: „2.0 postaje master; invite/edit/reset piše u sy15 (GoTrue admin API +
`user_roles`) I u 2.0 (`users`/`user_roles`/`user_permission_overrides`); smer sync SAMO 2.0→1.0;
1.0 usersTab read-fallback do cutover-a").

> ⚠️ **GATE dokument.** 1.0 je ŽIV na produkciji. Bag u pisanju naloga/rola može da ZAKLJUČA
> ljude. Ovaj dizajn je usvojen PRE koda; svaka nebezbedna operacija je ili odbačena (TODO), ili
> izvedena roll-forward/idempotentno, reverzibilno, bez destruktivnih koraka bez eksplicitne provere.

## 0. Tri sistema koja se pišu (i čime)

| # | Sistem | Šta drži | Kako 2.0 BE piše | Ključ identiteta |
|---|---|---|---|---|
| A | **sy15 GoTrue** `auth.users` | 1.0 login (email+lozinka) + SSO izvor za 2.0 | GoTrue **admin REST** (`/auth/v1/admin/users`), `SY15_SERVICE_KEY` (service_role) | `email` (jedinstven) |
| B | **sy15** `user_roles` (email-based) | 1.0 rola/scope/override-flagovi/`is_active`/`must_change_password` | `Sy15Service.withUserRls(adminEmail)` → RAW SQL pod `SET LOCAL ROLE authenticated` (RLS `ALL=current_user_is_admin()` + audit triger vidi `actor_email` — §P10 paritet) | `email` (+ `id` uuid reda) |
| C | **2.0** `users` + `user_roles` (FK) + `user_permission_overrides` | 2.0 login (bcrypt/SSO) + kurirana rola + per-user override-i | `PrismaService.$transaction` (atomarno) | `email` (unique) / `userId` (FK) |
| (D) | **sy15** `kadr_notification_log` | welcome/reset mejl outbox | GoTrue-adjacent REST (service key), **best-effort** | — |

**„Master" znači:** za IZMENU postojećeg naloga (edit/deactivate/reset), 2.0 (sistem C) je izvor
istine i piše se PRVI, atomarno; sy15 (A/B) je propagacija. Za INVITE novog naloga, GoTrue (A) je
identitet-sidro i mora nastati da bi čovek uopšte mogao da se uloguje u 1.0 — pa je redosled drukčiji
(vidi §2). Nikad ne postoji povratni sync (1.0→2.0) osim postojećeg SSO/JIT čitanja rola (netaknuto).

## 1. Bezbednosni invarijant (šta „zaključavanje" znači i zašto ga ovaj dizajn ne pravi)

„Zaključan" = korisnik ne može da uđe ni u 1.0 ni u 2.0 iako treba. Analiza po delimičnom padu:

- **Orphan GoTrue bez role** (invite stao posle A): 1.0 login radi, `get_my_user_roles`=∅ → 1.0 ga
  tretira kao `viewer` (postojeći 1.0 fallback, auth.service.ts). 2.0 SSO/JIT ga provisionuje kao
  `viewer`. → **Nije lockout** (degradiran uvid, retry dovršava nalog).
- **2.0 promena bez sy15 propagacije** (edit stao posle C): master je primenjen; sy15 stale. Ako je
  promena RESTRIKCIJA (deactivate/downgrade) → 1.0 zadržava STARI (veći) pristup = *security drift*,
  NE lockout; površ. i logovano, admin ponovi. Ako je GRANT (activate/upgrade) → korisnik ima novi
  pristup u 2.0, stari u 1.0 → **nije lockout**.
- **JIT vaskrsava deaktiviranog** (opasan skriveni slučaj): sy15 `is_active=false` NE blokira GoTrue
  login; `get_my_user_roles` vrati ∅ → ali 2.0 `ssoLogin` bi kroz JIT napravio NOV aktivan viewer
  nalog (`if (user && !user.active) throw 401` se preskače ako 2.0 red ne postoji!). → Zato
  **deactivate MORA da UPSERT-uje 2.0 `users` red sa `active=false`** (sistem C, master) da JIT-ova
  `!user.active` grana blokira. Ovo je ključni nalaz dizajna — bez njega je „soft delete" rupa.

**Zaključak:** delimičan pad nikad ne ostavlja *zaključan* nalog; najgori ishod je *degradiran-uvid*
(invite) ili *security-drift-permisivniji* (edit-restrikcija) — oboje reverzibilno retry-jem. Zato je
model **roll-forward (resumable idempotency)**, NE rollback. Rollback bi značio hard-delete GoTrue
naloga na pola posla = destruktivno i zabranjeno.

## 2. Redosled i kompenzacija — po operaciji

### INVITE (nov nalog) — roll-forward, idempotentno po prirodnim ključevima
```
1. GoTrue create (A)   idempotentno: 422/"already" → findByEmail → uzmi postojeći id
                       PAD → ABORT (ništa nije grantovano nigde; retry bezbedan)
2. 2.0 tx (C)          upsert users(email) [SSO-only random hash, active=true, role]
                       + zameni global UserRole + upsert overrides (D2)
                       PAD → GoTrue postoji, 2.0 nema → SSO/JIT ili retry dovrši; NIJE lockout
3. sy15 tx (B)         INSERT user_roles AKO ne postoji (email+role+coalesce(project_id))
                       PAD → čovek je viewer u 1.0 dok se ne ponovi; NIJE lockout
4. welcome mejl (D)    best-effort; greška se guta (paritet 1.0 edge)
```
**Idempotencija:** svaki korak je upsert/anti-dup po prirodnom ključu (email / userId+role) → ponovljen
invite sa istim email-om KONVERGIRA (ne duplira). `clientEventId` se prihvata (budući 2.0 audit dedup),
ali stvarna idempotencija su prirodni ključevi — NE `rev_api_idempotency` registar (koji bi kratkospojio
ceo poziv i mogao da preskoči dovršavanje polu-naloga).

### EDIT (postojeći: role/scope/override/aktivnost/must_change) — 2.0 master, pa propagacija
```
1. 2.0 tx (C)   ATOMARNO: users(role, fullName, active, mustChangePassword)
                + global UserRole(role, scope) + overrides(D2)
                PAD → ništa se nije promenilo NIGDE (tx rollback) → čist 4xx/5xx
2. sy15 (B)     UPDATE user_roles po :id (role/scope/flags/is_active/must_change) kroz withUserRls
                PAD → vrati 200 sa `sy15Synced:false` (parcijalno; master primenjen) — admin ponovi
```
Za **deactivate/delete** poredak (C pre B) je bezbedan i zbog JIT-a (§1): 2.0 `active=false` se upiše
pre nego što 1.0 strana krene, pa nema prozora u kom JIT vaskrsava nalog.

### RESET LOZINKE — GoTrue prvo (stvarna bezbednosna akcija), pa flagovi
```
1. GoTrue (A)   findByEmail → PUT admin/users/:id { password: random }   PAD → ABORT (stara lozinka i dalje važi)
2. flag (B+C)   must_change_password=true (sy15 user_roles + 2.0 users)  PAD → nebitno; korisnik i dalje resetuje
3. reset mejl (D) best-effort
```
Reset NE menja 2.0 bcrypt lozinku (2.0 je SSO-only/odvojen login); postavlja `mustChangePassword` da
force-change ekran (R3 FE) reaguje. Ne zaključava: korisnik postavlja lozinku sam kroz „Zaboravljena
lozinka" tok (paritet 1.0 — privremena lozinka se NE šalje mejlom).

### DEACTIVATE / ACTIVATE — soft, reverzibilno
- deactivate: 2.0 `users.active=false` (**upsert** ako 2.0 red fali — zatvara JIT rupu) + sy15
  `user_roles.is_active=false`. NE dira GoTrue (paritet 1.0 — 1.0 ne banuje u GoTrue). Reverzibilno.
- activate: obrnuto (`active=true`, `is_active=true`).

## 3. Šta ovaj sloj NE radi (eksplicitno — gate ishodi)

| Nije urađeno | Zašto (gate) | Status |
|---|---|---|
| **Hard-delete GoTrue naloga** | destruktivno; 1.0 ni ne radi (1.0 „delete" briše samo `user_roles` red) | NIKAD u D1 |
| **`DELETE /admin/users/:id` = soft** | KRITICNO/gate „ne briše naloge hard" > doslovni 1.0 DELETE parity; deactivate reverzibilno postiže isti cilj; traži `confirmEmail` == email cilja | soft-deactivate; hard row-remove = TODO |
| **Preimenovanje email-a** | email je JOIN ključ kroz sva 3 sistema + `employees` mapiranje + audit; rename rizikuje orphan. (1.0 „edit email" menja samo string u `user_roles`, ne GoTrue login — latentni footgun) | TODO — svesno odbačeno |
| **Rollback (kompenzujuće brisanje) na pad** | brisanje polu-kreiranog GoTrue = destruktivno; model je roll-forward | po dizajnu |
| **Self-lockout** (admin gasi/deaktivira/skida-admin sebi) | KRITICNO: bag ne sme da zaključa ni admina; **DODATA bezbednosna provera 422** (dokumentovano §C odstupanje sa razlogom — nije tiha izmena) | IMPLEMENTIRANO kao guard |
| **Bulk data-migracija override-a (#44)** | jednokratni skript kasnije | TODO (odloženo zadatkom) |
| **2.0 AuditLog konsolidacija (D10)** | odloženo zadatkom; sy15 audit triger i dalje hvata actor_email kroz withUserRls (§P10) | TODO |
| **Kopiranje prava (#34)** | 1.0 = klijentski form-fill „ne snima"; BE nema šta da piše — postojeći `GET /admin/users/:id` je dovoljan | R3 FE |
| **Multi-row per-projekat rola** | invite/edit upravljaju PRIMARNIM (global) redom; per-projekat pm/leadpm scope = kasnije | primarni red |
| **GoTrue ban na deactivate** | 1.0 ne banuje (is_active=false → viewer fallback); paritet | paritet — svesno |

## 4. Kanonski override ključevi (D2) — 1.0 bool kolone → `user_permission_overrides`

| 1.0 `user_roles` kolona | 2.0 override `key` | `allow` | semantika |
|---|---|---|---|
| `plan_montaze_readonly=true` | `plan_montaze.write` | **false** (deny) | Plan montaže read-only |
| `kadrovska_access=true` | `kadrovska.access` | **true** (grant) | pristup Kadrovskoj |
| `kadrovska_hide_contracts=true` | `kadrovska.contracts_read` | **false** (deny) | sakrij ugovore |

Semantika guarda = **deny > grant > rola** (već predviđeno). Kad je 1.0 bool `false`, odgovarajući
override red se BRIŠE (ne postoji override → pada na rolu). Potrošači (Plan montaže C, Kadrovska G)
čitaju iste ključeve kad stignu. `finalni_potpisnik` = zaseban 2.0-native named-flag, NIJE deo D1
migracije podataka (§ MODULE_SPEC 2.3.2).

## 5. Autorizacija + mapiranje grešaka

- Guard: `settings.users` (admin) na svim write rutama (`@RequirePermission` na kontroleru).
- sy15 write (B) ide kroz `withUserRls(adminEmail)` → DB dodatno RLS-proverava `current_user_is_admin()`
  (defense-in-depth; ako 2.0 admin nije i sy15 admin → 42501 → parcijalni `sy15Synced:false`, master
  ostaje). Audit triger dobija `actor_email` iz GUC claims (§P10).
- SQLSTATE→HTTP: 42501→403, 23505→409, 23514/P0001/P0002→422 (paritet Reversi/Sastanci §5).
- GoTrue greške: 422/already→tretiraj kao „postoji", ostalo→502/400 sa sažetim detaljem; nedostupan
  `SY15_SERVICE_KEY`/URL → 503 (boot-safe: app se diže, tek upotreba vraća 503).

## 6. Env (dodaci)
- `SY15_AUTH_URL` (opciono) — GoTrue admin baza; fallback = izvedeno iz `SY15_REST_URL` (`/rest/v1`→`/auth/v1`).
- `SY15_SERVICE_KEY` — postoji (Reversi storage); reuse kao GoTrue admin apikey/Bearer.
- `SY15_REST_URL` — postoji (SSO JIT); reuse za `kadr_notification_log` outbox.

## 7. Verifikacija šeme (protiv žive baze)
Kolone `user_roles` (email/role/project_id/is_active/full_name/team/created_by/must_change_password/
managed_sub_department_ids/plan_montaze_readonly/kadrovska_access/kadrovska_hide_contracts) potvrđene
iz DVA autoritativna izvora: `prisma/sy15.prisma` (`UserRoleSy15`, `prisma db pull` sa žive) I
produkcioni 1.0 edge `admin-invite-user` koji te iste kolone piše svakodnevno. 2.0 `users` dobija NOVU
kolonu `must_change_password` (migracija — D3 #4).
