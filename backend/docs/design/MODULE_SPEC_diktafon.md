# Diktafon „sanduče" (`dictation_inbox`) — spec

> Telefon diktira → agent povlači. Modul: `backend/src/modules/dictation-inbox/`.
> Frontend: `frontend/src/app/mob/diktafon/page.tsx` (`/mob/diktafon`).

## 1. Čemu služi

Monter/inženjer u pogonu (ili Nenad sa telefona) izdiktira zadatak na srpskom.
Snimak ide kroz `/api/v1/ai/stt` (transkripcija) pa `/api/v1/ai/refine` (doterivanje,
profil „napomena"), a **sređen tekst** se jednim dugmetom odlaže u sanduče
(`POST /api/v1/dictation-inbox`). Audio se posle transkripcije **odbacuje** — u bazi
ostaje samo tekst.

Agent (Claude Code / Cursor) potom taj tekst **povuče i potroši**.

**Pravilo vlasnika (presuda 29.07.2026): sanduče je jedno, ko PRVI povuče — njegov je.**
Nema vraćanja diktata na „neposlato". Zbog toga je preuzimanje moralo da postane
atomično — vidi §3.

## 2. Dva puta za preuzimanje

| Put | Ko ga koristi | Kako | Ograničenje |
|---|---|---|---|
| **INFRA (stari, i dalje važi)** | Claude Code na radnoj stanici u firmi | `ssh ubuntusrv` → `docker exec servosync-pg psql` → `SELECT … WHERE user_id = 2 AND delivered_at IS NULL` pa ručni `UPDATE … SET delivered_at = now()` | Radi **samo iz lokalne mreže** (ubuntusrv = 192.168.64.28) |
| **HTTP `claim` (novo, 02.08.2026)** | **Agent koji NEMA pristup lokalnoj mreži** — Cursor/Claude u oblaku, pokrenut sa telefona | `POST /api/v1/dictation-inbox/claim` sa Bearer tokenom | Traži nalog + (za tuđe sanduče) delegaciju |

> **Ovo je razlog postojanja `claim` rute.** Agent u oblaku nema ni SSH ni
> `192.168.64.28`, pa za njega stari put fizički ne postoji. `claim` mu daje isti
> posao preko interneta, pod njegovim tokenom.

`GET /api/v1/dictation-inbox/latest` i dalje samo **čita** (ne troši) — služi aplikaciji
za prikaz „šta je poslednje poslato, još nepreuzeto".

## 3. `POST /api/v1/dictation-inbox/claim`

Uzme **NAJSTARIJI nepreuzet** diktat (FIFO) i **istim upitom** ga obeleži preuzetim.

> **Zašto FIFO, a ne „poslednji".** Sanduče je komandni kanal. Kad se jedan zadatak
> izdiktira u više delova („prvo uradi X", „pa onda Y"), LIFO bi agentu isporučio
> korake **obrnutim redom**. `latest` (pregled u aplikaciji) ostaje `DESC` — to su
> dva različita posla i namerno imaju različit redosled.

- **Permisija:** `ai.chat` (ista kao ostale rute modula — diktafon je AI alat).
- **Status:** `200` (ne 201 — ništa se ne kreira, postojeći red se troši).
- **Prazno sanduče:** `{ "data": null }` — uredan ishod, ne 404 (agent poziva u petlji).

### Telo (sve opciono)

| Polje | Značenje |
|---|---|
| *(prazno / `{}`)* | **svoje** sanduče (pozivalac iz JWT-a) — dosadašnje ponašanje |
| `ownerUserId` | tuđe sanduče po `users.id` |
| `ownerEmail` | tuđe sanduče po e-mailu — **tačno poređenje** (`trim().toLowerCase()` pa `findUnique`) |

`ownerUserId` i `ownerEmail` zajedno → `400`. Tuđe sanduče bez delegacije → `403`.
Deaktiviran pozivalac **ili** deaktiviran vlasnik → `403` (vidi §6).

> 🔴 **E-mail se NIKAD ne traži kroz `mode: "insensitive"`.** Prisma to prevodi u
> `ILIKE $1`, gde su `%` i `_` **džokeri** — a `@IsEmail` niz `%@servoteh.com`
> propušta kao validan oblik. Mereno nad živom bazom: takav „e-mail" pogađa **59 od
> 68** naloga, i `findFirst` bez `orderBy` ne garantuje ni koji. Za komandni kanal to
> je bio put do tuđih instrukcija. Mala slova su invarijanta ove baze (i upis i
> prijava rade nad `lower`), pa je `findUnique` po `uq_users_email` i tačan i dovoljan.

### Odgovor

```json
{ "data": { "id": 41, "text": "dodaj dugme za štampu na nalogu", "createdAt": "2026-08-02T07:12:00.000Z" } }
```

### Atomičnost (suština)

Jedan jedini SQL, ne dva upita:

```sql
UPDATE dictation_inbox
   SET delivered_at = now(),
       claimed_by_user_id = $1          -- KO je uzeo (nosi oporavak, §3a)
 WHERE id = (
         SELECT id FROM dictation_inbox
          WHERE user_id = $2 AND delivered_at IS NULL
          ORDER BY created_at ASC, id ASC   -- FIFO; id je tie-break u istoj ms
            FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
   AND delivered_at IS NULL
RETURNING id, text, created_at;
```

Da su to bila dva koraka (`findFirst` pa `update`), druga sesija bi između njih
pročitala **isti** red i obe bi dobile isti diktat — što ruši pravilo „ko prvi
povuče". `FOR UPDATE SKIP LOCKED` u jednoj izjavi tera paralelnu sesiju da
zaključan red **preskoči** i uzme sledeći (ili ništa). Provereno i nad živim
Postgresom (dva uzastopna `claim`-a → različiti redovi, treći → prazno) i testom
`dictation-inbox.service.spec.ts`.

## 3a. `GET /api/v1/dictation-inbox/last-claimed` — oporavak

`claim` je **destruktivan i neidempotentan**: red je potrošen i drugog pokušaja nema.
Ako mreža pukne **posle** `UPDATE`-a a **pre** nego što odgovor stigne agentu, diktat
je izgubljen — a izgubljen diktat je izgubljena instrukcija.

Zato `last-claimed` istom pozivaocu vraća red **koji je ON preuzeo** u poslednjih
**15 minuta** (`LAST_CLAIMED_WINDOW_MIN`), iz istog sandučeta:

```json
{ "data": { "id": 41, "text": "…", "createdAt": "…", "claimedAt": "…" },
  "meta": { "windowMinutes": 15 } }
```

- **Ne ruši pravilo vlasnika**: red se NE vraća na „neposlato" i tuđ plen se ne vidi —
  filter je `claimed_by_user_id = pozivalac`. Zato i postoji nova kolona: `delivered_at`
  kaže samo *da* je preuzeto, ne i *ko* je preuzeo.
- **GET** (ništa ne menja) i **van rate-limita** `claim`-a — agent kome je poll pao u
  429 i dalje sme da pročita ono što je već povukao.
- Isti izbor sandučeta kao `claim`, samo kroz query: `?ownerUserId=` / `?ownerEmail=`
  (ista prava: aktivnost naloga + delegacija).
- Redovi preuzeti **starim putem** (ručni psql `UPDATE … delivered_at`) nemaju
  `claimed_by_user_id` i ovde se ne pojavljuju — tačno, jer ih preko HTTP-a niko nije uzeo.

## 4. Delegacija — bez nje ruta ne rešava problem

Diktate piše **Nenadov telefon pod NJEGOVIM nalogom**. Agent koji se prijavi kao
neko drugi gledao bi u prazno sanduče. Zato postoji tabela `dictation_delegates`:

| Kolona | Značenje |
|---|---|
| `owner_user_id` | čiji se diktati povlače |
| `delegate_user_id` | ko sme da ih povuče |
| `created_by_user_id` | admin koji je dodelio (null za redove upisane SQL-om) |
| `note` | slobodna beleška za reviziju |
| `created_at` | kad |

Jedinstven par (`uq_dictation_delegates_owner_delegate`) → ponovljena dodela je
idempotentna. **Default-deny: prazna tabela = niko ne vidi tuđe sanduče.**

**Bezbednije je od starog puta.** Kod psql-a je identitet vlasnika visio o ručno
otkucanom `user_id = 2` u komandi — greška u kucanju vraća **tuđi** diktat, što je
prompt-injection vektor (svaki `ai.chat` nalog upisuje u istu tabelu, glavna baza
je bez RLS, app rola čita sve). Kod `claim`-a identitet visi o **tokenu pozivaoca +
eksplicitnom redu u bazi**; nepoznat vlasnik daje isti `403` kao „nemaš dozvolu",
pa ruta nije ni orakl za nabrajanje naloga.

### Kako se dodaje delegat

**A) HTTP (admin, permisija `settings.users` — ista kao konzola korisnika u Podešavanjima):**

```bash
API=https://api.servosync2.servoteh.com/api   # NAPOMENA: host je servosync2

curl -X POST $API/v1/dictation-delegates \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"ownerEmail":"nenad.jarakovic@servoteh.com","delegateEmail":"agent@servoteh.com","note":"Cursor agent sa telefona"}'
```

- `GET /api/v1/dictation-delegates` — sve dozvole (sa e-mailovima obe strane)
- `DELETE /api/v1/dictation-delegates/:id` — ukloni

Svaka strana se zadaje kao `…UserId` **ili** `…Email` (oba → 400). Vlasnik == delegat → 400
(svoje sanduče ide i bez dozvole). Nepoznat nalog → 404. **Deaktiviran nalog (bilo koja
strana) → 400** — `claim` bi takvu dozvolu ionako odbio, pa nema svrhe upisati mrtav red.
E-mail se i ovde poredi **tačno** (vidi 🔴 u §3). **Nova permisija se namerno NE uvodi.**

**B) Čist SQL** (ako se ne želi ni HTTP površina):

```sql
INSERT INTO dictation_delegates (owner_user_id, delegate_user_id, note)
SELECT o.id, d.id, 'Cursor agent sa telefona'
  FROM users o, users d
 WHERE o.email = 'nenad.jarakovic@servoteh.com'
   AND d.email = 'agent@servoteh.com'
ON CONFLICT (owner_user_id, delegate_user_id) DO NOTHING;
```

Uklanjanje: `DELETE FROM dictation_delegates WHERE id = <id>;`

## 5. Ceo tok za agenta van lokalne mreže

```bash
API=https://api.servosync2.servoteh.com/api   # host je servosync2 (ne servosync)

# 1) Token — nalog agenta; treba mu bilo koja rola sa `ai.chat` (praktično sve aktivne).
#    `/auth/login` je VERSION_NEUTRAL → bez `/v1`, i vraća token BEZ `data` omotača.
TOKEN=$(curl -s -X POST $API/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"agent@servoteh.com","password":"…"}' | jq -r .accessToken)

# 2) Povuci Nenadov NAJSTARIJI nepreuzet diktat (TROŠI ga — drugog pokušaja nema)
curl -s -X POST $API/v1/dictation-inbox/claim \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"ownerEmail":"nenad.jarakovic@servoteh.com"}'
# → {"data":{"id":41,"text":"…","createdAt":"…"}}   ili   {"data":null}

# Svoje sanduče — bez tela:
curl -s -X POST $API/v1/dictation-inbox/claim \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'

# 3) OPORAVAK: ako odgovor iz koraka 2 nije stigao (prekid mreže) — pročitaj ga ponovo.
#    Vraća SAMO ono što je OVAJ token povukao, i samo u poslednjih 15 min.
curl -s "$API/v1/dictation-inbox/last-claimed?ownerEmail=nenad.jarakovic@servoteh.com" \
  -H "Authorization: Bearer $TOKEN"
# → {"data":{"id":41,"text":"…","createdAt":"…","claimedAt":"…"},"meta":{"windowMinutes":15}}
```

## 6. Zaštite

| Sloj | Šta radi |
|---|---|
| Permisija `ai.chat` | ruta nije javna; `PermissionsGuard` + `JwtAuthGuard` |
| **Delegacija** | tuđe sanduče je default-deny; bez reda u `dictation_delegates` → 403 |
| **Aktivnost naloga** | `claim`/`last-claimed` na SVAKOM pozivu čitaju `users.active` — i za pozivaoca i za vlasnika. `JwtStrategy` veruje potpisu tokena i ne dira `users`, pa bi deaktiviran nalog inače radio do isteka tokena; za komandni kanal je to predugo. Deaktivacija deluje **odmah** |
| **Rate-limit** (`claim-throttle.ts`) | **10 poziva/min po nalogu** → 429 sa `Retry-After`. Broj mora biti **niži od punog sandučeta** (`MAX_UNDELIVERED = 50`): sa 60/min napadač isprazni sve u prvom minutu bez ijednog 429 — brana koja se nikad ne okine nije brana. Agent koji poll-uje na ~10 s (6/min) je ne dodiruje. In-memory klizni prozor, obrazac `common/login-throttle.ts`, bez nove zavisnosti |
| **Backpressure na upisu** | `MAX_UNDELIVERED = 50` nepreuzetih po korisniku → 429 na `POST /dictation-inbox` |
| **Audit** | vidi §7 |
| Ne otkriva naloge | nepoznat `ownerEmail`, nedozvoljen vlasnik i deaktiviran vlasnik bez dozvole daju **isti** 403 |
| Tačno poređenje e-maila | bez `ILIKE` — `%@servoteh.com` ne razrešava nikoga (vidi 🔴 u §3) |

## 7. Audit — i šta se NE loguje

Za svaki uspešan `claim` upisuje se red u `audit_log`:

```
action      = "CLAIM diktat"
entity_type = "dictation_inbox"
entity_id   = <id povučenog diktata>
after_data  = { owner_user_id, claimed_by_user_id, delegated, text_len, claimed_at }
```

Dakle **ko je i čiji diktat povukao**. Upis je best-effort: pad audita ne obara
`claim` (diktat je već potrošen, drugog pokušaja nema).

> **TEKST DIKTATA SE NIKAD NE LOGUJE** — ni u `audit_log`, ni u app log. Može nositi
> poslovne podatke. U auditu stoji samo `text_len`.

🔴 **To je do 02.08.2026 bilo samo obećanje.** Globalni `AuditInterceptor` upisuje
**celo telo zahteva** u `after_data`, pa je uz svaki `POST /api/v1/dictation-inbox`
u audit odlazio **pun tekst diktata** (potvrđeno na produkciji). Sada interceptor
skida sadržaj tih polja po resursu (`REDACTED_BODY_FIELDS`):

| Ruta | Polje | U auditu ostaje |
|---|---|---|
| `POST /api/v1/dictation-inbox` | `text` | `"[redacted]"` + `text_len` |
| `POST /api/v1/ai/refine` | `tekst` | `"[redacted]"` + `tekst_len` |

`/ai/refine` je tu jer telefon **isti tekst** prvo provuče kroz doterivanje pa ga tek
onda odloži u sanduče — bez toga bi curio kroz susednu rutu. **Ostale rute se ne
diraju** (njihov audit je koristan baš zato što pokazuje šta je promenjeno);
`password`/`token`/`secret` su i dalje redigovani svuda. Pokriveno testom
`src/common/audit/audit.interceptor.spec.ts`.

Interceptor uz to upisuje i svoj generički red za POST rutu, ali njemu je `entity_id`
doslovno „claim" (izvodi ga iz URL-a) i ne zna koji je red uzet — zato servis piše
svoj, smisleni. Iz istog razloga su admin rute delegacije na **top nivou**
(`/v1/dictation-delegates`), a ne pod `/v1/admin/…`: interceptor bi inače upisao
`entity_type=admin, entity_id=dictation-delegates`.

## 8. Migracija

`prisma/migrations/20260802100000_dictation_delegates/` — aditivna i idempotentna
(`CREATE TABLE/INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), bez FK-ova
(paritet sa bratskom `dictation_inbox`). Radi dve stvari:

1. `CREATE TABLE dictation_delegates` (+ unique par, + indeks po delegatu);
2. `ALTER TABLE dictation_inbox ADD COLUMN claimed_by_user_id` (+ indeks
   `idx_dictation_inbox_claimed_by_delivered`) — nosi `last-claimed` (§3a).

**Mora se primeniti na `servosync-pg` pre nego što `claim` sa `ownerUserId` proradi.**
Bez tabele `claim` bez parametra (svoje sanduče) i dalje radi, ali tuđe puca; bez
kolone puca i `claim` i `last-claimed`.

Usklađenost šeme i migracija provereno alatom (a ne na oko):

```bash
npx prisma migrate diff --from-migrations ./prisma/migrations \
  --to-schema-datamodel ./prisma/schema.prisma \
  --shadow-database-url "$SHADOW_URL"
# → nijedan pomen `dictation_inbox`/`dictation_delegates`
```

## 9. Otvorena pitanja

- **Nalog za agenta u oblaku** — treba mu poseban `users` red (ne deliti Nenadov).
  Bilo koja aktivna rola nosi `ai.chat`; `viewer` je dovoljan.
- **Lozinka/rotacija tog naloga** — nema posebne mašinske autentikacije; agent koristi
  isti `POST /auth/login`. Ako se ukaže potreba, sledeći korak je namenski dugoživeći
  token samo za `claim`.
- **Bez UI-ja** za delegaciju (samo HTTP/SQL) — namerno, tabela ima nekoliko redova.
