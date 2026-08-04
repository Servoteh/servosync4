# Sistem za review koda — kako ServoSync dovodimo i držimo na senior nivou

> Napisano 04.08.2026. posle merenja nad celim repoom (backend + frontend) i jednog
> izvedenog refaktora (`refactor/robno-single-source`) na kome je metod isproban.
> Nalazi te revizije: [REVIZIJA_2026-08-04.md](REVIZIJA_2026-08-04.md).

---

## 0. Šta je ovde zapravo problem

Ovaj kod nije loš. Domensko rezonovanje je iznad proseka: komentari objašnjavaju *zašto*,
citiraju legacy dokument i review koji je izazvao izmenu. To je bolje nego kod većine
seniora.

Problem je druge vrste i lako ga je promašiti: **greške u ovom sistemu se ne prijavljuju.**

Klasična aplikacija kad pogreši — pukne. Vidiš stack trace, popraviš. ERP kad pogreši
najčešće **izračuna drugi broj i mirno ga prikaže**. Nema izuzetka, nema loga, nema
crvenog. Lager kaže 12, kartica artikla kaže 10, a knjiženje koristi treću vrednost.
To otkrije magacioner na popisu — tri nedelje kasnije, kad je već sve proknjiženo.

Zato ovaj sistem NE gađa „čist kod" uopšteno. Gađa tačno jednu klasu problema:

> **tiho razilaženje** — dva mesta koja treba da tvrde istu stvar, a mogu da se raziđu
> a da niko ne primeti.

Sve ostalo (dužina fajla, imenovanje, stil) je sporedno i namerno je nisko na listi.

### Zašto baš to, a ne „pokrivenost testovima" ili „složenost"

Zato što je izmereno. Revizija 04.08. dala je **464 nalaza na backendu**, od kojih je **241
provučen kroz protivproveru i 217 preživelo**. Skoro svi teški imaju isti oblik:

| oblik | konkretan primer iz ovog repoa (svi potvrđeni protivproverom) |
|---|---|
| isti predikat na više mesta | „šta je kretanje zalihe" — 10 kopija u 5 fajlova; „šta je proknjižen nalog" — 20 kopija u 14 fajlova |
| dve mere za istu stvar | `Tpz/Tk` se čita kao **minuti** u gantu i kao **sati** u štampi — jedna strana greši 60× |
| brana koja izgleda kao brana a nije | DTO klasa sa validatorima uvezena kao `import type` → validacija nikad ne radi, a na `PUT /admin/firma` je brisala celo telo |
| iznos u jednoj valuti, oznaka u drugoj | nalog za plaćanje uzima `openAmount` iz RSD kolona a `currency` iz stavke → papir glasi „117.000 **EUR**" |
| broj koji balansira a nije tačan | devizna faktura se knjiži nominalno: 10.000 EUR zaduži kupca sa 10.000 RSD, kontrola totala prolazi |

Nijedan od njih ne bi bio uhvaćen brojem pokrivenosti testovima. Svaki bi bio uhvaćen
pitanjem: *„gde još u sistemu postoji ova ista tvrdnja i može li da se raziđe?"*

---

## 1. Tri pravila koja menjaju najviše

Ovo su pravila, ne saveti. Sve ostalo u dokumentu je razrada.

### Pravilo 1 — Poslovna tvrdnja sme da postoji na TAČNO JEDNOM mestu

Ako u dva SQL upita piše isti `WHERE`, to nisu dva upita — to je jedno pravilo prepisano
dvaput, i pitanje je samo *kada* će se raziđi, ne *da li*.

Redosled izbora, od najjačeg ka najslabijem:

1. **Pogled u bazi** (`CREATE VIEW`) — kad predikat definiše *šta uopšte ulazi u obračun*.
   Najjače, jer ga baza nameće i onome ko čita iz `psql`, iz bridge-a ili iz budućeg BI-ja.
   Primer: [`v_stock_movements`](../backend/prisma/migrations/20260804100000_v_stock_movements/migration.sql).
2. **Izvezena `Prisma.sql` konstanta** — kad je predikat delić upita koji svako drugačije
   sastavlja. Slabije od pogleda (važi samo unutar NestJS-a), ali ga `grep` po simbolu nalazi.
3. **Izvezena TS konstanta** (`POSTED_STATUSES`) — za Prisma `where` objekte.
4. **Komentar „konzistentno sa X"** — ovo NIJE rešenje. Ovo je zabeleška da rešenje fali.

Tvrdi test: *ako sutra treba dodati jedan izuzetak u to pravilo, na koliko mesta moram
da ga otkucam?* Ako odgovor nije „jedno" — pravilo nema izvor istine.

### Pravilo 2 — Brana mora da bude dokazana, ne pretpostavljena

Tri prave, izmerene zamke u ovom repou gde je brana postojala a nije radila:

- **DTO kao `interface`** → globalni `ValidationPipe` ga tiho preskače. Telo ulazi nevalidirano.
- **DTO klasa uvezena sa `import type`** → TS obriše binding, `design:paramtypes` postane
  `Object`, pipe opet preskoči. Podmuklije: u DTO fajlu stoje uredni dekoratori koji nikad
  ne izvrše.
- **`whitelist: true` bez dekoratora na polju** → polje se TIHO briše iz tela pre nego što
  stigne do servisa.

Zato: nova brana ne postoji dok je test ne obori. Napiši test koji šalje **loš** ulaz i
zahteva 422 — ne test koji šalje dobar ulaz i očekuje 200.

Za ovu konkretnu zamku brana je sada **mašinska**:
[`test/body-validation-coverage.e2e-spec.ts`](../backend/test/body-validation-coverage.e2e-spec.ts)
prolazi kroz sve kontrolere i čita `design:paramtypes` svakog `@Body()` parametra.

- `Function` → **tvrda greška, bez baseline-a i bez izuzetka.** To je uvek `import type` na
  DTO klasi i uvek znači da ruta ne radi ono što piše. Nađeno na dva mesta: u `robno`
  (labava validacija) i na `PUT /admin/firma`, gde je oborilo funkciju u celosti — podaci
  firme se nisu mogli sačuvati **nikako**.
- `Object` (interfejs ili inline tip) → zatečeni dug, meri se prema baseline-u (164 rute) i
  sme samo da opada.

Sama kapija je proverena mutacijom: sa vraćenim `import type` test pada, bez njega prolazi.
Test koji nije viđen kako pada nije brana.

### Pravilo 3 — Prazan skup nije isto što i „nema ničega"

Ovo pravilo je preživelo protivproveru, ali mu je **primer bio prejak i vredi znati zašto** —
to je najčešća greška revizora u ovom repou.

Prvi izveštaj je tvrdio: „`saldakonto_accounts` je prazan, svi čitaoci ga vezuju INNER JOIN-om,
pa kreditni limit propušta svakoga." Protivprovera je to oborila: seed migracija
`20260726100000` **jeste** komitovana (`eeef21dd`) i puni 9 konta, među njima 2040/2050 sa
`tracks_open_items=true`; a `reconciliation.service.ts:277` koristi LEFT JOIN i baca 422.

Ono što **ostaje tačno** je uže i dalje vredi popraviti: `open-items`, `aging`, `partner-card` i
`assertCreditLimit` vezuju registar INNER JOIN-om **bez fail-fast provere**. Konto koji je
saldakonto-relevantan ali nije u tih 9 redova (ili mu je `partner_scope` NULL) tiho ispada iz
otvorenih stavki — bez ijedne poruke. To je **otpornost**, ne aktivan kvar.

Pravilo zato ostaje: za svaki registar od koga zavisi obračun, sistem mora da razlikuje
„nema dugova" od „ne znam, registar nije podešen" — i drugo mora da bude **glasno**. Ali primer
u nalazu mora da imenuje koji konkretan konto ispada, a ne da pretpostavi da je tabela prazna.

---

## 2. Sedam obrazaca koje merimo mašinski

Skener: [`backend/scripts/audit-code.mjs`](../backend/scripts/audit-code.mjs).

```bash
cd backend
npm run audit                       # svi obrasci, čitljiv ispis po modulima
npm run audit -- --module=robno     # jedan modul
npm run audit -- --pattern=dup-sql  # jedan obrazac
npm run audit -- --json             # mašinski ispis (za agente)
npm run audit:check                 # CI kapija: pada ako je broj PORASTAO
npm run audit:baseline              # spusti prag posle popravke
```

| # | obrazac | šta traži | zašto boli |
|---|---|---|---|
| 1 | `dup-sql` | isti SQL predikat u ≥2 fajla | tiho razilaženje izveštaja |
| 2 | `n1` | upit u petlji | transakcija pod lock-om raste linearno sa brojem stavki |
| 3 | `dead` | privatni metod bez pozivaoca | mrtva kopija žive logike koju neko „popravi" |
| 4 | `body-type` | telo mutirajuće rute koje pipe preskače | nevalidiran novac ulazi u bazu |
| 5 | `unsafe-num` | `Number(query)` bez NaN provere | 500 iz drajvera umesto 422 |
| 6 | `page-filter` | `.filter()` posle `LIMIT`-a | pretraga tiho ne nalazi ono što postoji |
| 7 | `size` | fajl > 600 linija | signal, ne nalaz — proveri broj razloga za izmenu |

**Skener je nalazač kandidata, ne dokaz.** Preciznost mu je oko 50 % — na istom kodu gde
je prijavio 154 kandidata za `body-type`, pažljiv ljudski/agentski pregled potvrdio je 73.
To je namerno podešeno tako: propušten nalaz košta nedelju dana, lažni nalaz košta jedan
pogled u kod.

### Provera SQL-only migracija

Pogledi, funkcije, parcijalni indeksi i GRANT-ovi idu kroz ručno pisan `migration.sql`, koji
**Prisma ne validira** — samo ga prosledi bazi pri `migrate deploy`. Do tada niko ne zna ni da
li se parsira, a kamoli da li kolone koje pominje postoje. Prva greška se vidi na deploy-u.

```bash
DATABASE_URL=$(grep ^DATABASE_URL .env.dev | cut -d= -f2- | tr -d '"') \
node scripts/verify-sql-migration.mjs prisma/migrations/<folder> \
  --query "SELECT COUNT(*) FROM <novi_objekat>"
```

Primeni migraciju u transakciji, pusti kontrolni upit, pa uradi `ROLLBACK` — puna provera
(sintaksa, imena kolona, tipovi, da agregati rade) bez ijedne trajne izmene. Gađaj **dev** bazu:
iako se sve poništava, `CREATE`/`DROP` na trenutak uzimaju bravu na objektima.

Pogled `v_stock_movements` je ovako proveren pre merge-a — 16 kolona, agregat radi, dev baza
netaknuta. Usput je alat našao i grešku u sopstvenoj prvoj verziji: naivni `split(";")` seče
string literal koji sadrži tačku-zapetu (`COMMENT ON … IS '…;…'`) i prijavljuje lažnu
„unterminated quoted string". Delilac zato poštuje `'…'`, `''` escape i `$$…$$` blokove.

### Baseline umesto nule

Repo ima zatečene nalaze i to je normalno. Kapija zato ne traži nulu nego **da broj ne raste**:

```
scripts/audit-baseline.json     dup-sql 29 · n1 93 · body-type 154 · unsafe-num 69 · page-filter 1 · size 87
```

Kad popraviš grupu, pokreni `npm run audit:baseline` da se prag spusti — od tada je nazadovanje
nemoguće. Ovo je jedina strategija koja radi na zatečenom kodu; „popravimo sve pa uvedemo lint"
nikad se ne desi.

---

## 3. Tri nivoa review-a (kadenca)

### Nivo A — svaki PR (automatski, ~2 minuta)

Kapija u CI, bez ljudi:

```yaml
- run: npm run audit:check     # nijedan obrazac ne sme da poraste
- run: npx tsc --noEmit
- run: npm test
- run: npm run build && node dist/main.js   # boot smoke: DI graf mora da se razreši
```

Boot smoke nije formalnost — dva puta je produkcija pala jer se `dist/main.js` nije ni
pokrenuo, a deploy je javio „success".

### Nivo B — svaka izmena poslovnog pravila (čovek + agent, ~30 minuta)

Okida se kad PR dira novac, zalihe, knjiženje, poreze ili prava. Četiri pitanja, i sva
četiri traže **dokaz**, ne mišljenje:

1. **Gde još postoji ova tvrdnja?** `grep` po predikatu, ne po imenu funkcije. Nabroj sva
   mesta. Ako ih je više od jednog — ili ih spoji, ili napiši zašto smeju da budu odvojena.
2. **Šta se dešava kad je izvor prazan?** Prazna tabela, `null` kolona, nepostojeći
   šifarnik — vraća li se „nema" ili „ne znam"?
3. **Šta se dešava kad dvoje radi isto u isti čas?** Postoji li lock, i uzimaju li ga OBA
   puta koja diraju isti resurs? (Izlaz robe i rezervacija moraju uzeti isti ključ; RN
   numeracija je jednom već dala duplikat jer je logika bila kopirana u `handovers` bez brane.)
4. **Kako bi ovo palo tiho?** Ako ne umeš da opišeš scenario tihog otkaza — nisi još
   razumeo izmenu.

### Nivo C — dubinski review domena (agentski, jednom po domenu, pa kvartalno)

Ovo je metod koji je proizveo reviziju 04.08. i koji je isplativ. Recept je u §5.

---

## 4. Šta ide u „definiciju gotovog"

Dopuna postojećih pravila (`BACKEND_RULES.md`, `frontend/CLAUDE.md`). Predlog za usvajanje:

**Backend**
- [ ] Mutirajuća ruta ima DTO **klasu** sa `class-validator` dekoratorima na **svakom** polju
      (`whitelist` briše nedekorisana), i uvezena je **vrednosno** (ne `import type`).
- [ ] Postoji test koji šalje LOŠ ulaz i očekuje 422.
- [ ] Brojevi iz `@Query`/`@Param` idu kroz `common/number-params.ts`.
- [ ] Poslovna greška je `HttpException` potomak (inače je filter pušta kao 500).
- [ ] Nijedan upit u petlji; grupni upit ili `createMany`.
- [ ] Novi SQL predikat nad poslovnim podacima: pogled ili izvezena konstanta — nikad prepis.
- [ ] Lista sa `take` ima i filtere u SQL-u (nikad `.filter()` posle strane).

**Frontend**
- [ ] Tabela je server-side paginirana, a pretraga se šalje serveru (ne filtrira stranu).
- [ ] Prikazano je stanje greške, ne samo prazna tabela.
- [ ] `Ctrl+S` / `Esc` / Enter-navigacija rade.

---

## 5. Kako se vodi agentski review (recept koji je radio)

Ovo je isprobano 04.08. na celom repou. Rezultat: ~150 potvrđenih nalaza za jednu noć.

### 5.1 Podeli po DOMENU, ne po folderu

Loše: „pregledaj `modules/`". Dobro: pet domena, svaki jedan agent:

1. **Knjiženje + PDV** (`gl`, `pdv`, `zavrsni`) — koren istine, najveći zakonski rizik
2. **Novac** (`saldakonti`, `placanja`, `izvodi`, `kamata`)
3. **Prodaja + nabavka** (`sales`, `sef`, `nabavka`)
4. **Zalihe** (`robno`)
5. **Proizvodnja** (`work-orders`, `tech-processes`, `pdm`, `mrp`, `handovers`, planovi)
6. **Frontend** — svoja pravila (paginacija, tokeni, tastatura)

Redosled je po **riziku × novcu**, i tako treba i popravljati.

### 5.2 Prompt koji daje upotrebljive nalaze

Četiri stvari su napravile razliku između korisnog i beskorisnog izveštaja:

**(a) Traži posledicu, ne manu.** Ne „nađi loš kod" nego „nađi mesto gde sistem izračuna
pogrešan broj bez ijedne greške u logu".

**(b) Zahtevaj scenario kao uslov za nalaz.** Doslovno u promptu:

> Svaki nalaz mora imati (a) `fajl:linija`, (b) scenario „ako korisnik uradi X dobiće Y
> umesto Z", (c) zašto se to NEĆE primetiti odmah. Ako ne možeš da napišeš konkretan
> scenario — nalaz ne ide u izveštaj.

Ovo jedno pravilo izbacuje skoro sav šum.

**(c) Daj mu kalibraciju.** Ubaci 2–3 već poznata, potvrđena nalaza sa uputstvom
„potvrdi ili ospori, ne traži ponovo". Agent time nauči prag ozbiljnosti — i, što je
vrednije, počne da **ospori** ono što je zastarelo. (U ovoj reviziji jedan agent je
osporio moj nalaz o `three-way-match` i bio u pravu.)

**(d) Reci mu da ne dira kod.** Read-only, jedan izveštaj na kraju. Agent koji „usput
popravlja" pravi konflikte i gubi nalaze.

### 5.3 Protivprovera je obavezan korak, ne opcioni

Nalaz nije nalaz dok ga nije pokušao da obori neko ko nije njegov autor.

Recept: za svaki nalaz (ili grupu nalaza iz istog poglavlja) jedan agent sa **zadatkom da ga
obori**, i sa pravilom odluke: *„ako posle čitanja koda nisi siguran → nalaz je oboren."*
Lažno potvrđen nalaz je skuplji od propuštenog, jer vodi izmenu nad pravim knjigovodstvom.

Izmereno na ovoj reviziji: **241 nalaza provučeno kroz protivproveru, 217 preživelo, 24 oborena
ili bitno oslabljena** (prvi krug 12 → 8/4, drugi krug 229 → 209/20). Oborenih je oko 10 % — ali
među njima su bila **dva koja su stajala na vrhu liste prioriteta**. Cena provere je bila mnogo
niža od cene jedne nepotrebne izmene knjiženja.

#### Pet obrazaca po kojima se nalazi sistematski precenjuju

Od 24 oborena, 18 pada u ove kalupe. Karakteristično: precenjuje se **posledica**, skoro nikad
činjenica. „Netačno u jezgru" je bilo retko; „tačno jezgro, prejaka posledica" je bilo pravilo.

**1. Apsolutna negacija izmerena jednim grepom.** „Nema nijednog pozivaoca", „nigde se ne
proverava", „jedini u aplikaciji", „nije komitovano". Oboreno u praksi: seed migracija „untracked"
(bila komitovana — merena `git status` umesto `git ls-files`), „nema unique u šemi" (postoji, dve
linije dalje), „`tableEmpty` na 2 mesta" (4 definicije, 38 poziva), „jedini `alert()`" (45 u 14
fajlova), „IOS mejl ne upisuje trag" (globalni `AuditInterceptor` upisuje aktera i primaoca).
→ **Pravilo:** apsolutna tvrdnja traži DVA nezavisna merenja — ime stvari *i* mehanizam koji bi to
mogao raditi globalno (interceptor, guard, `@@unique`, migracija, DB ograničenje). Stanje repoa se
dokazuje `git ls-files` / `git log -S`, **nikad** `git status`. Pazi i na fajlove koje git tretira
kao binarne (`handover-drafts.service.ts`) — bez `grep -a` tiho gube pogotke.

**2. Čitanje jednog sloja, pa ekstrapolacija na korisnika.** Oboreno: „`VatBridgeError` → 500" (DTO
validator odbija srpski format sa 400 *pre* mosta), „finalizuje se neproveren bilans" (backend
nezavisno ponovo evaluira kontrole i vraća 409), „traka je zelena" (FE ima poseban neutralan
prikaz), „storno u zaključenu godinu" (nizvodna `LOCKED` brana vraća 409).
→ **Pravilo:** posledica je svojstvo **cele putanje**, ne linije. Pre pisanja scenarija prođi:
DTO/validator → guard → servis → DB ograničenje → FE `disabled`. Ako bilo koji sloj hvata slučaj,
nalaz je „duplikat brane" ili „loša poruka", a ne „tiho pogrešan podatak".

**3. „Dupli tap" scenario koji ne postoji.** Naveden 4× u jednom izveštaju i nijednom nije bio
moguć: kit dugme je `disabled={disabled || loading}`.
→ **Pravilo:** za svaki nalaz o idempotenciji imenuj **konkretnu putanju** koja proizvodi drugi
zahtev. Jedina realna je korisnički retry **posle** greške ili timeouta — tako se i formuliše.

**4. Nedostižno stanje i zastarela meta.** Oboreno: `Math.max(1, …)` (stanje koje ga budi ne pravi
nijedna ruta), 3-way match sa `CANCELLED` (status ne postoji u enumu), „kooperacija ne postoji kao
pojam" (postoji u overlay tabeli). Dva nalaza bila su **već ispravljena** (jedan istim commit-om
koji je uneo izveštaj), a dva su bila **dokumentovana namera** (Ctrl+S nad zatvorenom branom).
→ **Pravilo:** nalaz se ne piše dok se ne imenuje ruta ili UI radnja koja proizvodi ulazno stanje;
ako je nema, ishod je „neprovereno", ne „nalaz". Pre pisanja: `git log -1 -S<izraz>` i pročitaj
komentar / `pravila.ts` / spec uz kod — **postojanje objašnjenja u kodu prebacuje teret dokaza na
revizora.**

**5. Brojevi se izmišljaju.** „~3.700 agregacija" (bilo ≤2.492), „PG limit 32k" (65535),
„`loadLedgerFacts` 3× po evaluaciji" (1×), „Postgres nema skip-scan" (baza je pg18).
→ **Pravilo:** brojka bez merenja se ne piše. Ni kao procena.

Ovih pet ide u prompt svakog budućeg pregleda, kao lista protiv koje agent proverava sopstveni
nalaz **pre** nego što ga zapiše.

### 5.4 Šta obavezno proveriti u rezultatu

Agenti greše samouvereno. Tri stvari uvek proveriti:

- **Da li su linije još tačne?** Ako se kod menjao tokom skeniranja, brojevi linija su
  pomereni. Jedan agent je to sam prijavio — to je znak dobrog izveštaja, ne lošeg.
- **Da li je nalaz još živ?** Grana koju čitaš možda kasni za `main`-om. (Meni se u ovoj
  reviziji desilo: prvi nalaz o lager pretrazi bio je tačan za granu, a već popravljen na
  `main`. Uvek radi nad svežim `main`-om, u zasebnom worktree-u.)
- **Poklapaju li se dva nezavisna izvora?** Skener je našao `status IN ('posted','locked')`
  14× u 9 fajlova; agent je nezavisno našao 20× u 14 fajlova (šire, jer hvata i Prisma oblik).
  Kad se dva metoda slože oko iste stvari, nalaz je siguran.

### 5.5 Higijena rada

- Rad ide u **zaseban worktree** sa svežeg `main`-a (`git worktree add … origin/main`) —
  primarni direktorijum nosi tuđi WIP.
- **Jedan pisac po worktree-u.** Dva paralelna agenta u istom folderu proizvode fantomske
  greške prevođenja (uhvaćeno u ovoj sesiji).
- Analiza može paralelno (read-only), **izmene idu redom** kad diraju iste fajlove.

---

## 6. Redosled popravki (od nalaza ka planu)

Kad izađe izveštaj, ne popravlja se odozgo nadole. Sortira se po ovome:

```
prioritet = (tiho? 3 : 1) × (novac/zakon? 3 : 1) × (već se dešava? 2 : 1) / trud
```

Praktično, u četiri talasa:

| talas | šta | zašto tim redom |
|---|---|---|
| **1. Krvarenje** | greške koje UPRAVO daju pogrešan broj na produkciji | svaki dan čekanja je još podataka za ispravku |
| **2. Brane** | guardovi koji ne rade (validacija, limiti, prazan registar) | sprečava nastanak nove štete |
| **3. Izvori istine** | spajanje prepisanih predikata u pogled/konstantu | sprečava da se talas 1 ponovi |
| **4. Struktura** | podela prevelikih servisa, mrtav kod | najjeftinije odloženo, najskuplje uraditi prvo |

Uobičajena greška je krenuti od talasa 4 („hajde da sredimo kod"). To je jedini talas
koji ništa ne popravlja korisniku.

---

## 7. Šta je već urađeno po ovom sistemu

Grana `refactor/robno-single-source` je dokaz da metod radi — u modulu zaliha:

- `v_stock_movements` — jedan izvor istine, 10 prepisa uklonjeno
- `stateAsOfMany` — guard izlaza: do 120 serijskih upita pod lock-om → 2
- 110 linija mrtvog koda obrisano (bila je divergentna kopija žive logike)
- DTO klase sa validacijom + popravljena `import type` zamka
- `common/number-params.ts` — NaN više ne ulazi u SQL
- `RobnoService` 1300 → 944 linija; izdvojeni `LagerQueryService` i `KepuService`
- 151/151 test prolazi, build čist, DI graf se diže sa 63 modula

Merenje istog modula skenerom pre/posle: `dup-sql` u `robno` sa 10 na 1.

---

## 8. Šta ovaj sistem NE rešava

Pošteno, da se ne očekuje pogrešno:

- **Ne nalazi pogrešnu poslovnu formulu.** Ako je BigBit računao amortizaciju drugačije nego
  mi, to nađe samo čovek koji zna propis, sa legacy dokumentom u ruci.
- **Ne zamenjuje testove nad pravim podacima.** Paralelni obračun PDV-a kroz oba sistema
  ostaje jedini pravi dokaz — zato i stoji uslov od ≥3 paralelna obračuna pre gašenja BigBit-a.
- **Skener ne razume semantiku.** On broji oblike. Presudu i dalje donosi čovek.
- **Ne rešava prazne produkcijske registre.** `saldakonto_accounts` se ne puni kodom nego
  odlukom knjigovođe koja konta prate otvorene stavke.
