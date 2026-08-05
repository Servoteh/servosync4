# Dubinski review — PRAVA PRISTUPA + PODEŠAVANJA + SYNC

Baza: `C:\Users\nenad.jarakovic\wt\robno-quality\backend\src`
Obuhvat: `common/authz/**`, `modules/auth/**`, `modules/podesavanja/**`, `modules/sync/**`, `common/sy15/**`
Metod: čitanje koda + tri žive provere (kompajlirani `dist` metapodaci, izolovan `ValidationPipe`,
podignut Nest app sa pravim globalnim pipe-om). Nijedan fajl osim ovog izveštaja nije menjan.

**Nalaza po kategoriji:** 1) 6 · 2) 8 · 3) 8 · 4) 6 · 5) 7 — ukupno **35**
(🔴 5 · 🟠 16 · 🟡 14)

---

## 1. Ruta bez zaštite ili sa pogrešnom permisijom

| fajl:linija | ozb. | scenario | zašto se ne primeti |
|---|---|---|---|
| `common/authz/permissions.guard.ts:64` | 🟠 | Kontroler dobije `@RequirePermission` + `PermissionsGuard`, ali neko izostavi `JwtAuthGuard` (ili ga skine radi „javnog" GET-a). `req.user` je `undefined` → guard vrati `true` → **svaka permisija na tom kontroleru se preskače**, i za anonimnog pozivaoca. Danas je stanje čisto (provereno: svaki `UseGuards(` u repou nosi `JwtAuthGuard`), ali brana ne postoji. | Coverage audit ovaj slučaj SAMO upiše u `reports/` kao `BEZ-GUARDA(javno?)`; nijedan `expect` ga ne obara. Ruta se ponaša normalno za prijavljenog korisnika, pa se u testu ručno ništa ne vidi. |
| `common/authz/scope.service.ts:78-80` vs `permissions.guard.ts:41-44` | 🟠 | Na produkciji bez `AUTHZ_ENFORCE`: guard **enforce-uje** (fail-closed, red 43), a `ScopeService.isEnforced()` vraća `false` jer traži doslovno `"true"`. Radnik prijavi rad na mašini van svog `machine_access` → guard ga pusti (ima `tehnologija.report_work`), servis pozove `isEnforced()` → dobije „shadow" → upiše rad uz warn. Dva različita odgovora na isto pitanje u istom procesu. | Ničiji test ne pokreće oba sloja sa istim env-om; e2e matrice postavljaju `AUTHZ_ENFORCE=true` eksplicitno, pa razlika ne postoji ni u jednom testu. Na produkciji je posledica „warn u logu", ne greška. |
| `modules/auth/auth.controller.ts:225` | 🟡 | Isto razilaženje, prema frontendu: `/auth/me/permissions` vraća `enforced: process.env.AUTHZ_ENFORCE === "true"`. U produkciji bez env-a backend odbija, a FE-u kaže „nije aktivno" → FE prikaže dugmad koja sve vraćaju 403. | Izgleda kao „bag u dugmetu", ne kao neusklađena zastavica; niko ne poredi `enforced` sa stvarnim ponašanjem guarda. |
| `modules/sync/sync.controller.ts:39-57` | 🟠 | `POST /sync/run` **ne poziva** `SyncSwitchService.assertEnabled`, iako ugovor u `modules/podesavanja/sync-switch.service.ts:41-42` doslovno kaže: „svaki ručni ulaz (ruta `/sync/run`, `run-now`) poziva `assertEnabled(...)`". Admin ugasi prekidač u Podešavanjima da zaustavi sinhronizaciju, pa pritisne „Pokreni sada" na starom ekranu → MSSQL kanal se izvrši. Prekidač `bigbit_mdb_sync` uopšte ne pokriva ovaj kanal. | Prekidač i ekran su pisani za `.mdb` kanal; `/sync/run` je stara ruta koja je ostala. Kartica u Integracijama i dalje pokazuje „isključeno" — jer meri drugi posao. |
| `modules/podesavanja/podesavanja-users.service.ts:111-149` + `:738-752` | 🟠 | `PATCH /admin/users/:id` prima `role: "admin"` bez ijedne provere da je AKTER admin — jedina kapija je ključ `settings.users`. `guardSelfLockout` brani samo samo-deaktivaciju i samo-skidanje admina, **ne i samo-promociju**. Ko god dobije `settings.users` grant-om (`user_permission_overrides`) može sebi upisati `admin`. Gore: 3.0 master se piše PRVI (`write2_0`, red 126), pa tek onda sy15 (`trySy15`, red 142) — dakle merodavna DB provera (`user_roles` RLS `current_user_is_admin()`) **ne može da spreči** 3.0 eskalaciju; 42501 daje HTTP 200 sa `sy15Synced:false`. | Odgovor je 200 i „uspeh". `sy15Error` je jedno polje u JSON-u koje FE ne mora ni da prikaže. `settings.users` danas ima samo admin (kroz `ALL`), pa put deluje zatvoreno — ali brave nema, samo konvencije. |
| `modules/auth/auth.controller.ts:142-150` | 🟡 | `POST /auth/refresh` i `POST /auth/logout` nemaju throttle (samo `login`/`sso`, redovi 80 i 103). Svaki poziv radi SHA-256 + indeksirani `findUnique` nad `refresh_tokens`. Neautentikovan napadač može neograničeno da pumpa CPU/DB kroz `/auth/refresh`. | Token je 48 nasumičnih bajtova, pa pogađanje nije realno — i zato izostanak throttlea deluje bezopasno; problem je iscrpljivanje resursa, ne pogađanje. |

### Šta `test/route-permission-coverage.e2e-spec.ts` STVARNO pokriva, a šta ne

CI (`.github/workflows/ci-backend.yml:111`) vozi ga kao tvrdu kapiju
(`jest --config test/jest-e2e.json "permissions|coverage|command-safety"`). Čist reflection nad
Nest metapodacima, bez baze i bez boot-a.

**Pokriva (3 `expect`-a koji stvarno obaraju CI):**
- `:193` MRTVA PERMISIJA — `@RequirePermission` bez `PermissionsGuard` u lancu.
- `:205` GEJT — svaka `POST/PUT/PATCH/DELETE` ruta iz stabla `AppModule` ima permisiju ili je na
  `INTENTIONAL_OPEN` listi (`:155-168`, danas 7 unosa).
- Implicitno: da se `AppModule` uopšte učitava.

**NE pokriva (i to je mesto gde su nalazi iz ove tabele preživeli):**
1. **Semantiku ključa.** Test pita „ima li rutu išta zaključava", nikad „da li je ključ pravi". READ
   ključ na WRITE ruti prolazi. To nije teorijski — `common/authz/permissions.ts:137-146` opisuje da su
   `POST/PATCH /v1/komitenti` do 28.07. visili na `directory.read` (ključ koji ima skoro svaka rola), a
   `/v1/artikli` na `sync.run`. Oba su nađena RUKOM, ne ovim testom.
2. **Rolu.** Ne postoji nijedna tvrdnja oblika „rola X NEMA pravo na rutu Y" — to rade zasebne
   `*-permissions.e2e-spec.ts` matrice, i to samo za 17 od ~46 modula (nema `sync`, nema `auth`,
   nema `admin/firma`, nema `admin/sync/bigbit`, nema `masters`, nema `gl/izvodi/placanja/sales/robno`).
3. **`JwtAuthGuard`.** `hasJwtGuard` se izračuna (`:114`) i ispiše, ali se nikad ne tvrdi. Nalaz 1a
   (guard bez identiteta = prolaz) je tačno ovaj slep ugao.
4. **Validaciju tela.** Test ne gleda `design:paramtypes` — pa ne vidi kategoriju 4a
   (`import type` gasi ValidationPipe). Ni jedna matrica ne šalje pravo telo kroz pravi pipe:
   `podesavanja-write-permissions.e2e-spec.ts` mokuje servis, a `company-details.service.spec.ts`
   zove servis direktno.
5. **Row-scope / IDOR.** Van dosega po konstrukciji (nema baze).
6. **Rute van `AppModule` stabla** i sve što se montira kao middleware (`main.ts` statički servis).
7. **Prefiks i verziju.** `fullPath` je `/admin/users/:id`, ne `/api/v1/admin/users/:id` — konzistentno
   sa `INTENTIONAL_OPEN`, ali izveštaj koji čita čovek ne odgovara stvarnom URL-u.
8. **Read rute.** `:223` ih samo prebroji i upiše u fajl; `expect(...).toBeGreaterThanOrEqual(0)`
   je tautologija.

---

## 2. Rola/permisija koja se tiho gubi ili menja

> Istorijski kvar („sync spušta 3.0-native na `viewer`, nestaju opcije") **je popravljen samo
> delimično.** `applyRoleSync` (`auth.service.ts:475-503`) danas štiti dva slučaja: rolu `admin`
> (pravilo 3) i role kojih 1.0 katalog NE poznaje (pravilo 4, `SY15_KNOWN_ROLES`). Sve ostalo
> se i dalje prepisuje — i naviše i naniže.

| fajl:linija | ozb. | scenario | zašto se ne primeti |
|---|---|---|---|
| `modules/auth/auth.service.ts:486-498` (pravilo 4) | 🔴 | `SY15_KNOWN_ROLES` je izveden iz `SY15_ROLE_PRIORITY` (`:109-124`) i sadrži 14 rola: `admin, leadpm, pm, menadzment, hr, poslovni_admin, projektant_vodja, inzenjer, tim_lider, cnc_operater, magacioner, monter, proizvodni_radnik, viewer`. Zaštićene su SAMO role izvan te liste (`tehnolog`, `sef`, `kontrolor`, `cnc_programer`, `nabavka_view`, `tehnicar_odrzavanja`, `nabavka`, `kvalitet`, `prodaja`, `finansije`, `user`). Admin u Podešavanjima dodeli nekome `magacioner`; u 1.0 `user_roles` taj čovek je `viewer`; sledeće jutro se prijavi → `applyRoleSync` upiše `viewer` i `lokacije.write`/`reversi.manage` nestanu. Isto za `hr`, `pm`, `leadpm`, `menadzment`, `poslovni_admin`, `tim_lider`, `monter`, `cnc_operater`, `inzenjer`, `projektant_vodja`. | Jedini trag je `logger.log` na `:492` („rola-sync (login): x → y"). Korisnik vidi „nestale su mi opcije", admin otvori Podešavanja i **vidi svoju izmenu** — jer ekran čita sy15 `user_roles`, a promenjen je 3.0 `users.role`. Dva ekrana, dve istine. |
| `modules/auth/auth.service.ts:145-158` (`effectiveRoleFromRows`) | 🔴 | Nepoznata 1.0 rola → `?? ROLES.VIEWER` (`:157`). Uvede se nova rola u 1.0 `user_roles` (npr. `nabavka_lead`) koju `SY15_ROLE_PRIORITY` ne zna → SVI njeni nosioci na sledećoj prijavi u 3.0 padnu na `viewer`. Pravilo 4 tu ne pomaže: ono gleda ZATEČENU 3.0 rolu, ne dolaznu. | Nema poruke. Nastupa masovno i istovremeno (svi se prijavljuju ujutru), pa liči na „pao je sistem prava", a ne na jednu izmenu u drugoj bazi. |
| `modules/podesavanja/podesavanja-users.service.ts:126-148` + `auth.service.ts:475` | 🔴 | Kombinacija. `update()` piše 3.0 master, pa sy15 „best-effort". Padne li sy15 leg (42501, mreža, zastareo `sy15RoleId`), odgovor je **200** sa `sy15Synced:false`. Dve baze su sada u raskoraku, a `applyRoleSync` je programiran da veruje sy15 → **prva sledeća prijava tog korisnika poništi adminovu izmenu**. Izmena ne „ne uspe", nego uspe pa se sama vrati sa zakašnjenjem od nekoliko sati. | 200 + zeleni toast. Kauzalni razmak (izmena danas, poništenje sutra ujutru) sakrije vezu. `sy15Error` je polje koje FE ne mora ni da renderuje. |
| `modules/auth/auth.module.ts:16-18` + `modules/auth/jwt.strategy.ts:32-40` | 🟠 | Access JWT traje **7 dana** (`JWT_EXPIRES_IN ?? '7d'`), a `JwtStrategy.validate` NE dira bazu — vraća `role` iz tokena. `PermissionsGuard:66-72` prosleđuje baš tu (zastarelu) rolu u `resolvePermissionDecision`. Posledice: (a) skinuti nekome `admin` → ostaje admin do 7 dana; (b) `POST /admin/users/:id/deactivate` NE opoziva ni access token ni `refresh_tokens` redove (`setActive:496-518` ih ne dira, `revokeAllForUser` se zove SAMO iz reuse-detekcije, `auth.service.ts:642`) → otpušten čovek radi u sistemu do 7 dana. | Override-i se čitaju sveže iz baze (i to je i dokumentovano u zaglavlju guarda), pa se stvara utisak da je „sve sveže". Rola je jedini deo koji nije, i to nigde ne piše. `refresh()` JESTE fail-closed (`:653`), pa test „odjavi pa se prijavi" pokaže da deaktivacija radi. |
| `modules/auth/auth.service.ts:295-323` | 🟠 | Self-service promena lozinke ne opoziva nijednu drugu sesiju. Posle sumnje na kompromitaciju korisnik promeni lozinku; napadačev refresh token živi punih 30 dana (`refresh-token.util.ts` `DEFAULT_TTL_DAYS`), a access token 7 dana. | Promena lozinke se svuda doživljava kao „presekao sam pristup". Ništa u odgovoru ne kaže suprotno. |
| `modules/podesavanja/podesavanja-users.service.ts:479-481` vs `modules/auth/auth.controller.ts:266-268` | 🟠 | Dva ogledala iste allowliste sa **različitom semantikom brisanja**. Kontroler namerno briše samo `allow: true` (i to obrazlaže na `:250`: „deny redovi se NE diraju"). Migracija briše `deleteMany({ key, userId: { notIn: [...] } })` — dakle **i eksplicitne deny redove**. Admin postavi deny na `kadrovska.grid_edit` za nekoga ko jeste na sy15 listi, pa neko pokrene `POST /admin/migrations/allowlist-overrides-backfill` → deny nestane, a upsert ga vrati kao **grant**. | Endpoint je opisan kao „idempotentan mirror, ponovljiv poziv konvergira" — i jeste, samo konvergira ka drugom stanju nego dnevni self-heal. Poziva se ručno i retko. |
| `modules/podesavanja/podesavanja-users.service.ts:583-598` | 🟡 | `resetGlobalRole` (istinit i kad se menja SAMO `managedSubDepartmentIds`) radi `deleteMany` + `create` nad global `UserRole` redom, umesto update. Novi red = nov `id` i nov `createdAt`; svaka buduća referenca ili audit po `user_roles.id` u glavnoj bazi puca. | Sadržaj reda je isti, pa provera „da li je scope upisan" prolazi. |
| `common/sy15/sy15.service.ts:122-140` | 🟡 | `subByEmail` keš nema TTL ni invalidaciju. Korisnik čiji GoTrue nalog nastane POSLE prvog promašaja ostaje na keširanom `sub: null` do restarta kontejnera → svaka sy15 mutacija koja traži `auth.uid()` (reversi `issued_by`, sastanci) pada na NOT NULL. | „Radi posle restarta" — pa se pripiše mreži. Keš se puni po instanci; iza dva kontejnera ponašanje je nedeterministično. |

---

## 3. Integritet BigBit `.mdb` sync kanala

> Ovaj fajl je najbolje odbranjen deo obuhvata: prazan drop, bajat drop, ponovljeni sha256, sudar
> broja naloga, nestali matični redovi, zaključani period, rezervisan opseg ključeva i
> `external_item_id` kao ključ (a ne `items.id`) — sve je pokriveno i obrazloženo. Nalazi ispod su
> rupe **oko** tih brana, ne u njima.

| fajl:linija | ozb. | scenario | zašto se ne primeti |
|---|---|---|---|
| `modules/sync/generic.syncer.ts:411-419` + `modules/sync/bigbit-mdb-import.service.ts:2725,3024,3356` | 🔴 | **Dva pisca nad istim tabelama, bez zajedničke brave i sa RAZLIČITIM ključem identiteta.** `.mdb` uvoz ključa artikle po `externalItemId` i sam dodeljuje `items.id` (`nextBigbitItemId`), komitente po `Sifra`=`id`. MSSQL `GenericSyncer` za `items` radi pun refresh: `deleteMany({ id: { lt: 900_000_000 } })` pa `createMany` sa `id` = QBigTehn brojem. Admin pritisne „Sinhronizuj" (`POST /sync/run`, permisija `sync.run`) → obriše se ceo BigBit opseg artikala i vrati snimak MRTVOG MSSQL izvora od 22.07 (`bigbit-mdb-import.service.ts:52-66` sam dokumentuje da je taj izvor mrtav). Svih 59 artikala koje je `.mdb` kanal kreirao nestane; `price_list_entries` i `work_order_item_components` ostanu siročad (brisanje ide pod `session_replication_role='replica'`, FK trigeri ćute). Isto važi za `customers` (`CustomerSyncer`) i `projects` (aditivno). | Brana „prazan izvor nikad ne briše" (`generic.syncer.ts:389`) **ne okine** — MSSQL je i dalje dostupan i vraća punih ~92k zamrznutih redova. Sync prijavi `status: success` sa velikim `rowsUpserted`. Kvar se vidi tek kad neko potraži artikal unet posle 22.07. |
| `modules/sync/bigbit-mdb-import.service.ts:1044-1057` | 🟠 | `assertStagingNotEmpty` traži `gk > 0 && nalozi > 0 && konta > 0`, i posebno (uslovno) proverava komitente/predmete (`:1072-1114`). **`bb_mdb_stage_artikli` nije u nijednoj proveri.** Ispadne li `R_Artikli` iz manifesta u `bigbit-mdb-export.sh` ili se tabela preimenuje u BigBitu, drop prođe, `importItems` vrati `staged=0, +0/~0/=0`, a run je `DONE`. Šifarnik artikala se zamrzne — tiho, svake noći. | Za komitente postoji izričita `staged === 0` poruka (`:3540-3544`); za artikle je nema. U `describe()` (`:1370`) linija `items +0/~0/=0` izgleda kao „ništa se nije promenilo", što je legitiman noćni ishod. |
| `modules/sync/bigbit-mdb-import.service.ts:704-888` | 🟠 | **Uvoz nema obuhvatnu transakciju i redovno ostavlja polovično stanje.** 12 koraka (`:735-761`) commit-uju nezavisno; `catch` na `:866` samo upiše `importStatus: FAILED` i rethrow-uje — ništa se ne vraća. Konkretno: `journal_entries` i sve stranice `ledger_entries` su već upisane kad `BigbitMdbConflictError` (`:801`) ili `BigbitMdbVanishedMasterError` (`:847`) puknu — obe provere idu POSLE svih upisa. Nadzornik ujutru javi „uvoz PAO", a glavna knjiga već nosi taj drop. Ako je pad bio pre `applyBigbitLocks` (`:761`), nalozi koje je BigBit zaključao ostanu `POSTED` u 4.0. | Poruka o padu je duga i ubedljiva („Uvoz JE upisao sve što je u fajlu" stoji SAMO u `VanishedMasterError`, ne i u `ConflictError`). Operater vidi crveno i zaključi „nije ušlo ništa" → ponovi ručno → drugi prolaz je idempotentan pa deluje kao da je prvi bio prazan hod. Da autori znaju da se dešava, dokazuje popravka prekinutog uvoza na `:2106-2114`. |
| `modules/sync/bigbit-mdb-import.service.ts:2947-2956` i `:3517-3523` | 🟠 | **Red koji ne može da se upiše se proguta.** `catch` oko `item.update/create` i `customer.upsert` broji `skipped++`, imenuje prvih 20 (`MAX_NAMED_SKIPS`) i **korak i dalje vraća uspeh**. Baci li baza 300 artikala na CHECK/duž kolone, run je `DONE`, a summary kaže `items ~50/=91000/preskočeno 300`. Jedini korak koji na `skipped` obara uvoz je `journal_entries` (`:800`). | `skipped` u summary liniji izgleda kao brojač brane (a ne kao „upis nije uspeo"), jer se ISTA reč koristi za namerne preskoke (native red, paritet katbroja). Razlika je samo u tekstu `notes`, a `notes` ide u `import_row_counts` JSON. `countMissingFromOurSide` (`:777-793`) to uhvati — ali tek SLEDEĆE noći i opet samo kao `note`. |
| `modules/sync/bigbit-mdb-import.service.ts:2787-2958` (petlja) | 🟠 | Upit po redu: `prisma.item.update` (`:2935`) / `item.create` (`:2941`) unutar petlje kandidata. Prvi prolaz .mdb kanala je izmerio „ažurirano je `updated` od 91k" (`:2975`) — dakle ~91.000 pojedinačnih round-tripova. Isto u `importCustomers:3510` (~6,7k) i u `GenericSyncer:154`/`:174`. Ostatak fajla je set-based SQL; artikli i komitenti su izuzeci. | Prvi prolaz je i inače najduži, pa se sporost pripiše količini. Trajanje se meri (`durationMs`) ali se ne poredi ni sa čim. |
| `modules/sync/bigbit-mdb-import.service.ts:3346-3350` | 🟡 | Docstring `importCustomers` tvrdi: „⚠️ NIJE UVEZANO U `runImport`. Korak stoji sam… i `assertStagingNotEmpty`, koji za komitente još ne zna". **Oba iskaza su netačna** — `runImport:735` ga zove, a `assertStagingNotEmpty:1072-1114` ima punu proveru za komitente. Ko planira rad po ovom ugovoru misli da matični podaci nisu u noćnom lancu. | Komentar je duži i uverljiviji od koda koji opovrgava; `⚠️` mu daje težinu odluke. |
| `modules/sync/bigbit-mdb-import.service.ts:3011-3035` + `:2783,2944` | 🟡 | `nextBigbitItemId()` se čita JEDNOM po prolazu i dalje inkrementira u memoriji. Obrazloženje (`:3019-3022`) glasi „uvoz drži mutex nad drop-om" — ali `claimDrop` (`:958`) zaključava **drop**, ne tabelu. Ručno `runImport({ dropId: X })` uporedo sa noćnim poslom nad drop-om Y: oba krenu od istog `MAX(id)+1`, gubitnik padne na PK. | Padne u `catch` iz prethodnog nalaza → `skipped`, run `DONE`. Retko i nedeterministički. |
| `modules/sync/bigbit-mdb-import.service.ts:939-955` + `modules/podesavanja/sync-switch.service.ts:64-78` | 🟡 | Oba prekidača fail-**open** na grešku čitanja (namerno i dokumentovano). U kombinaciji sa nalazom o artiklima: nečitljiv prekidač + prazan artikli-staging = uvoz koji ništa ne radi, a kartica u Integracijama je zelena. | Po dizajnu ne sme da ćuti — i ne ćuti, ali samo u `logger.error`, koji niko ne čita dok nema alarma. Nadzornik gleda `warnings`, a ovo stanje ih ne pravi. |

**Odgovori na tri postavljena pitanja:**
- *Red koji ne može da se mapira* — **prijavi se, ali samo kao broj + tekst u `notes`/`import_row_counts`.**
  Tri različite kategorije (`filtered` = filter pre obrade, `skipped` = namerna brana ILI neuspeo upis,
  `blockedLocked` = zaključan period) uredno se broje i sabiraju se uz kontrolu (`:3001-3007`,
  `:3598-3607`). Jedina kategorija koja **obara** run je sudar broja naloga.
- *Delimičan uvoz* — **da, i to je normalno stanje posle svakog pada.** Vidi nalaz 3c.
- *`external_item_id`* — **poštovano i zaključano branom.** `itemsMapping()` (`:3038-3063`) baca izuzetak
  ako kolona `externalItemId` nestane iz mape, `columns` filtrira `isId` (`:2733`), a merenje
  „0 od 92.511 redova ima id = external_item_id" je upisano u poruku greške.
  37 artikala sa duplim katbrojem: brana je popuštena 31.07 (`:2892-2927`) tako da izmena prolazi kad
  ne menja sam katbroj — poklapa se sa produkcijskom `guard_catalog_unique`.

---

## 4. 500 umesto jasne poruke + tajne/podaci u logovima

| fajl:linija | ozb. | scenario | zašto se ne primeti |
|---|---|---|---|
| `modules/podesavanja/podesavanja.controller.ts:54,56` (+ `:628-632`, `:646-653`) | 🔴 | **`PUT /admin/firma` i `PUT /admin/firma/racuni/:id` tiho odbacuju CELO telo zahteva.** Oba DTO-a su uvezena sa `import type`, pa TypeScript u `design:paramtypes` emituje `Function` umesto klase — provereno u `dist/modules/podesavanja/podesavanja.controller.js:754` (`[Function]`) i `:771` (`[Number, Function]`); poređenje: `:609` za `updateExpectation` uredno nosi `UpdateExpectationDto`. Globalni `ValidationPipe({transform:true, whitelist:true})` (`main.ts:67`) `Function` ne prepoznaje kao primitiv → `plainToInstance(Function, body)`; taj objekat nema validacione metapodatke → `whitelist` **obriše sva polja**. **Provereno na podignutom Nest app-u:** servis dobije `typeof dto === "function"`, `Object.keys(dto) = []`. Pravi `CompanyDetailsService.update` tada padne na `Object.keys(data).length === 0` (`company-details.service.ts:190`) i baci **422 „Nijedno polje nije prosleđeno."** Knjigovođa ne može da unese memorandum, PIB, tekući račun, IBAN ni SWIFT — ni na jednom polju, nikad. Isto za devizni račun (`payment-accounts.service.ts:143`), tj. blok banke na izvoznoj fakturi ostaje prazan. | Poruka je na srpskom, uljudna i **zvuči kao korisnička greška** („nisi ništa uneo"), pa se ne prijavljuje kao bag nego kao nespretnost. Nijedan test ne prolazi kroz pravi pipe: e2e matrica mokuje `CompanyDetailsService`, a `company-details.service.spec.ts` zove servis direktno. Ironija: zaglavlje samog DTO-a (`podesavanja-company-details.dto.ts:12-17`) objašnjava da je klasa uvedena 27.07. baš da bi se popravio 500 na ovoj ruti — `import type` je tu popravku poništio. |
| `modules/podesavanja/podesavanja.service.ts:1142-1155` | 🟠 | `rethrowSy15` prosleđuje SIROVU Postgres/Prisma poruku u telo 403/422/409: `permission denied for table kadr_vacation_editor_allowlist`, imena constraint-a, delovi upita. Isto radi `podesavanja-users.service.ts:792-798`. Admin dobije poruku o šemi 1.0 baze na ekranu. | Poruke su „korisne" pri razvoju i prolaze kao tipizirane 4xx, pa ih `AllExceptionsFilter` (koji baš takvo curenje sprečava za 500) namerno ne dira. |
| `modules/podesavanja/podesavanja-users.service.ts:95-105` i `:200-202` | 🟠 | `invite` i `resetPassword` vraćaju **lozinku u čistom tekstu** u HTTP odgovoru. Odluka je dokumentovana (nema self-service reset toka) i mejl je namerno ne nosi (`sy15-auth-admin.service.ts:297-303`) — ali lozinka time prolazi kroz reverse proxy, Cloudflare, browser devtools i FE state, i ostaje u svakom HAR/nalogu koji neko snimi dok reprodukuje problem. | Baš zato što je odluka svesna i zapisana, više se ne preispituje; ono što se nije razmatralo je putanja odgovora, a ne sam princip. |
| `common/authz/permissions.guard.ts:75-78` | 🟡 | Na svakom DENY se u log upiše `request.url` — **sa query stringom**. `GET /api/v1/kadrovska/employees?q=<JMBG>` ili `?q=<prezime>` odbijen guardom upiše JMBG u aplikacioni log, koji nema iste kontrole pristupa kao Kadrovska. Ista linija ide i u shadow režimu (`:80`), gde se loguje SVAKI promašaj. | Log-linija je pisana za dijagnostiku prava; niko je ne čita kao „kanal za PII". U shadow režimu je zapisa najviše — a to je režim u kome se sistem namerno ostavlja duže. |
| `modules/sync/mssql.client.ts:64-66` + `:96-100` | 🟡 | Neuspela konekcija se pretvori u `ServiceUnavailableException` sa sirovom driver porukom (host, instanca, korisnik). `GET /sync/health` vraća `@@VERSION` — punu verziju SQL Servera i OS build — svakome sa `sync.read`, a `sync.read` ima i `sef` (`role-permissions.ts:140`). | Ruta se zove „health" i deluje kao ping. Odgovor niko ne gleda dok nešto ne pukne. |
| `modules/scheduler/scheduler.controller.ts:90-100` | 🟡 | `runNow` hvata SVE i pretvara u 422 sa `e.message`. Za `.mdb` greške je to tačno (srpske poruke). Za neočekivanu Prisma/raw-SQL grešku znači da poruka o šemi izlazi kao „poslovna" 422 i **zaobilazi** redakciju u `AllExceptionsFilter`. | 422 sa tekstom izgleda namerno; `traceId` (koji bi odao da je u pitanju neuhvaćena greška) izostane baš tada. |

---

## 5. Performansa

| fajl:linija | ozb. | scenario | zašto se ne primeti |
|---|---|---|---|
| `modules/sync/bigbit-mdb-import.service.ts:2935,2941` · `:3510` · `modules/sync/generic.syncer.ts:154,174` | 🟠 | Upit po redu (vidi 3d): ~91k `UPDATE`/`INSERT` round-tripova za artikle, ~6,7k za komitente, N za svaku inkrementalnu MSSQL tabelu. | Noćni posao; niko ne meri. |
| `modules/sync/generic.syncer.ts:399-432` | 🟠 | Full refresh drži JEDNU transakciju sa `timeout: 20 * 60 * 1000` preko `deleteMany` + chunked `createMany` nad ~92k redova, uz `SET LOCAL session_replication_role='replica'`. Do 20 minuta zaključan `items` sa 6 indeksa; autovacuum stoji, svaki čitalac čeka. `maxWait: 30s` znači da paralelni pisci padaju sa timeout-om, ne sa jasnom porukom. | Radi se retko i ručno. Kad se desi danju, izgleda kao „aplikacija se zaledila". |
| `modules/auth/auth.controller.ts:210-227` + `:243-276` | 🟠 | `GET /auth/me/permissions` na **svaki poziv** radi `reconcileAllowlistMirror`: interaktivnu sy15 transakciju (`setClaims` → `SELECT` nad `auth.users` → `SET LOCAL ROLE authenticated` → 2 DEFINER poziva) plus do 2 upisa u glavnu bazu. To je endpoint koji FE gađa pri svakom učitavanju stranice, za svih ~157 korisnika. Self-heal predviđen za drift stoji na najtoplijoj ruti u sistemu. | Latencija je par desetina ms po pozivu i utapa se u učitavanje stranice; opterećenje se vidi tek kao „sy15 je spor ujutru". |
| `modules/sync/bigbit-mdb-import.service.ts:2845-2853` | 🟡 | Po svakoj seriji od 2000 artikala dva `findMany` nad `items` (`externalItemId IN (2000)` + `catalogNumber IN (…)`), pri čemu prvi vraća PUNE redove (67 kolona) — ~46 serija × 2 upita × pun payload. | Memorija je ograničena na ~40 MB po seriji (`ITEMS_BATCH` komentar `:145`), pa je razmatran samo taj aspekt. |
| `modules/sync/bigbit-mdb-import.service.ts:2748-2765` | 🟡 | Pre-prolaz koji čita SVIH ~92k staging redova u stranicama po 10k samo da napravi `Set` šifara. Drugi pun prolaz kroz istu tabelu sledi odmah zatim. | Traje sekunde nad 92k redova; skriveno u ukupnom trajanju koraka. |
| `modules/podesavanja/podesavanja.service.ts:121-146` | 🟡 | `listUsers` radi `SELECT ... FROM user_roles` **bez `LIMIT`** i bez paginacije (za razliku od `auditLog:371`, koji ima `parsePagination`). Danas ~200 redova; raste sa svakim projektnim scope-om (`project_id` po redu). | Tabela je mala pa je „radi". Nema signala pre nego što ne bude. |
| `common/authz/effective-permission.ts:102-105` | 🟡 | Jedan indeksiran `findUnique` po ZAŠTIĆENOM zahtevu — dokumentovano i prihvaćeno. Beleži se jer se broj skalira sa brojem `@RequirePermission` ruta po strani, a FE ume da povuče 5-10 zaštićenih ruta po ekranu. | Po dizajnu; navedeno radi potpunosti, ne kao zamerka. |

---

## TOP 10 (redosled = šteta × verovatnoća)

| # | nalaz | fajl:linija | ozb. | trud |
|---|---|---|---|---|
| 1 | `PUT /admin/firma` i `/admin/firma/racuni/:id` odbacuju celo telo — matični podaci firme i devizni račun se **ne mogu sačuvati**; izvozna faktura ostaje bez podataka za uplatu | `podesavanja.controller.ts:54,56` | 🔴 | **S** (skini `type` iz dva importa; + `.eslintrc` pravilo `@typescript-eslint/consistent-type-imports` sa izuzetkom za DTO, ili tvrdnja u coverage auditu da nijedna `@Body()` ruta nema `Function` u `design:paramtypes`) |
| 2 | Rola-sync i dalje prepisuje lokalno dodeljene role — 14 od 25 rola nije zaštićeno; adminova izmena se poništi na sledećoj prijavi korisnika | `auth.service.ts:486-498` | 🔴 | **M** (odluka: da li je 1.0 još izvor istine; ako jeste — dodati marker „3.0 ručno dodeljeno" na `users` i poštovati ga kao pravilo 4) |
| 3 | Master-first + best-effort sy15 garantuje raskorak, koji zatim nalaz #2 pretvara u tihi rollback; 42501 daje HTTP 200 | `podesavanja-users.service.ts:126-148` | 🔴 | **M** (sy15 leg mora biti fail-closed za promenu ROLE — ili 3.0 upis kompenzovati, ili odgovor mora biti 409/207, ne 200) |
| 4 | `POST /sync/run` briše i vraća `items`/`customers`/`projects` iz MRTVOG MSSQL izvora, preko svega što je `.mdb` kanal upisao | `generic.syncer.ts:411-419` | 🔴 | **S** (ugasiti registraciju MSSQL syncera za `items`/`customers`/`projects`, ili staviti `assertEnabled` + tvrdu branu „izvor stariji od X dana") |
| 5 | Deaktivacija naloga i degradacija role ne važe do 7 dana (JWT bez DB provere, bez opoziva tokena) | `auth.module.ts:16-18`, `jwt.strategy.ts:32` | 🟠 | **M** (skratiti access TTL na ~15 min i osloniti se na refresh; ILI `revokeAllForUser` + provera `active`/`role` u strategiji uz keš) |
| 6 | Uvoz ostavlja polovično stanje na svaki pad; „FAILED" ne znači „ništa nije ušlo" | `bigbit-mdb-import.service.ts:704-888` | 🟠 | **M** (obe kasne provere — sudar naloga i nestali matični — pomeriti u pre-flight nad staging-om, PRE prvog upisa; i u poruku `ConflictError` dopisati šta jeste ušlo) |
| 7 | Prazan `bb_mdb_stage_artikli` prolazi kao uspeh — šifarnik artikala se tiho zamrzne | `bigbit-mdb-import.service.ts:1044-1057` | 🟠 | **S** (dodati artikle u `assertStagingNotEmpty` po istom uslovu „a ranije ih je nosio" + `staged === 0` note u `importItems`) |
| 8 | Neuspeo upis reda broji se kao `skipped` i run ostaje `DONE` — 300 odbijenih artikala izgleda kao brana koja radi | `bigbit-mdb-import.service.ts:2947`, `:3517` | 🟠 | **S** (razdvojiti `skipped` (namerno) od `failed` (upis pao) u `MdbStepResult`; `failed > 0` → `danger` upozorenje na kartici) |
| 9 | `POST /sync/run` bez prekidača + `PATCH /admin/users/:id` bez provere „ko sme da deli admina" + guard koji propušta bez identiteta — tri kapije koje se oslanjaju na konvenciju | `sync.controller.ts:39`, `podesavanja-users.service.ts:738`, `permissions.guard.ts:64` | 🟠 | **S** (`assertEnabled` u `/sync/run`; provera aktera pre `role: admin`; `return false` umesto `true` kad nema `user` + tvrdnja u coverage auditu da svaka `@RequirePermission` ruta ima `JwtAuthGuard`) |
| 10 | `reconcileAllowlistMirror` na svakom `/auth/me/permissions` — sy15 transakcija + do 2 upisa na najtoplijoj ruti | `auth.controller.ts:213` | 🟡 | **S** (pomeriti u sesijski keš — jednom po prijavi ili jednom na N minuta po korisniku; drift i dalje pokriva idempotentni backfill) |

**Trud:** S = do pola dana · M = 1–3 dana (traži odluku vlasnika) · L = više od 3 dana.
Nalazi #2 i #3 su jedan posao i ne treba ih raditi odvojeno; #1, #4, #7, #8 i #9 su nezavisni i mogu paralelno.
