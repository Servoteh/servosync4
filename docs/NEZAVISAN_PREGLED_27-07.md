# Nezavisan pregled — grana `feat/4.0-bigbit-nocni-sync`

**Datum:** 28.07.2026. · **Predmet:** 8 commitova (`9cafad5`..`db28007`), dan rada, jedna sesija
**Metod:** šest nezavisnih revizora + ukrštanje i sopstvena kontrolna merenja (dev baza
`192.168.64.28:5437`, čitanje koda, upiti nad `_prisma_migrations`)
**Ovo je PREGLED — ništa nije popravljeno.**

---

> ⚠️ **PROČITAJ PRVO:** presuda iz §1 je od 28.07. UJUTRU i **prevaziđena je**. Deo nalaza je u
> međuvremenu ispravljen, deo je odbačen sa obrazloženjem, a drugi krug pregleda je našao **četiri
> nova defekta u samim ispravkama**. Važeća presuda o deploy-u je u **[§8](#8-integracija-i-presuda-o-deploy-u-28072026)**;
> uz svaki nalaz niže stoji red **„ISHOD 28.07."** sa ishodom (ISPRAVLJENO / ODBAČENO / OSTAJE).
> Originalni tekst nalaza nije menjan.

## 1. PRESUDA (pet rečenica)

Ovaj paket **ne sme na produkciju u celini**: motor završnog računa ima jedan defekt u
korenu (`aggregate()` bez donje granice datuma) koji od druge godine naduvava i bilans
uspeha i bilans stanja, a šest od sedam kontrolnih pravila su tautologije pa ga ne mogu
uhvatiti. Robno/štampe/PDV deo je u znatno boljem stanju i **sme uz tri uslova**: guard u
migraciji `20260726090000` (danas bezuslovno briše izračunate bilanse i vraća ih u DRAFT),
guard u `20260727090000` (menja PDV registar ispod već predatih perioda), i upis obe
migracije u `_prisma_migrations` — jer su im efekti u dev bazi, a Prisma ih vidi kao
neprimenjene, pa bi ih `migrate deploy` **ponovo izvršio**. Noćni BigBit uvoz **ne sme na
produkciju dok postoje tri stvari**: prekidač seedovan `enabled=FALSE`, skripta za
poništavanje uvoza, i guard koji odbija prepis naloga u statusu `LOCKED`. Tri nove funkcije
(N:M avansi, spisak kompenzacija, KEP po magacinu) su **izgrađene u backendu a nedostupne
iz aplikacije** — plaćene su, a korisnik do njih ne može. Ono što DRŽI je stvarno provereno
i nije malo: 179 AOP formula je strukturno zatvoreno, PDV brojevi za 2026 se ponavljaju do
pare protiv BigBit-ovog naloga zatvaranja, obe test-svite (2591 + 4086) su zelene, statički
export nema nijednu `[id]` rutu, a prenos između magacina više ne gubi zalihu.

---

## 2. NALAZI PO OZBILJNOSTI

Oznaka **⛌ n×** = koliko je nezavisnih revizora našlo isti nalaz. Oznaka **✔ potvrdio pregled**
= sam sam ponovio dokaz nad kodom ili bazom pri ukrštanju.

### 2.1 KRITIČNO

#### K1 · Jedan uzrok, dva ishoda: `aggregate()` nema donju granicu datuma ⛌ 2× ✔ potvrdio pregled

> **ISHOD 28.07. → ISPRAVLJENO.** `aggregate()` je dobio prozor `je.year = Y` (jedna fiskalna godina) kao jedini obavezni predikat perioda (`GkEvalPeriod` / `fiscalYearPeriod` u `gkeval.service.ts`). Kodifikovano i sa druge strane: test „pogrešan prozor agregacije" u `control-rules.service.spec.ts` pravi knjigu sa DVE godine i tvrdi da `BS_GK_SAGLASNOST` PADA sa Δ = tačno prošlogodišnji promet, dok sirova strana ostaje netaknuta. **Ostaje otvoreno (b):** donja granica za bilans stanja je početak godine, a ne datum poslednjeg PS naloga — dok na dev bazi nema nijednog PS naloga to se ne može izmeriti, pa se mora ponovo proveriti pre prve godine koja PS nalog ima.

`backend/src/modules/zavrsni/gkeval.service.ts:429` — jedini vremenski uslov je
`je.posting_date <= asOf`. Donje granice nema nigde (`balance-sheet.service.ts:197` postavlja
samo `asOf = endOfYear`). To proizvodi **dva odvojena kvara**:

**(a) Bilans uspeha sabira sve ranije godine.** Do commita `9cafad5` je zaključni nalog
prethodne godine poništavao njen promet unutar maske `P6010*-D6010*`. Commit `33c39a7` je
taj nalog izuzeo za klase 5 i 6 — i time uklonio jedinu godišnju granicu.
*Scenario:* konto 6010 ima prihod 100 u 2022. (+ZAK) i 250 u 2023. (+ZAK). Bilans uspeha
za 2023 daje **350 umesto 250**. Za 2022 daje tačnih 100 samo zato što je prva godina.
*Dokaz:* dva revizora nezavisno reprodukovala — jedan sintetičkim nalozima u `$transaction`
sa rollback-om (staro 0/0, novo 350 uz tačno 250), drugi CTE-om (stari filter 300, novi 800
uz tačno 300).

**(b) Bilans stanja dvostruko broji početno stanje.** `D<maska>`/`P<maska>` uzimaju sav
promet od početka knjige, a `YearOpenService` (`year-open.service.ts:357`,
`OPENING_ORDER_TYPE = "PS"`) svake godine knjiži PS nalog sa saldom klasa 0–4 — **bez
prethodnog zatvaranja tih konta** (ZAK zatvara samo klase 5 i 6). `psFilter` izuzima PS
naloge samo za `PSD`/`PSP` atome, koje novi seed uopšte ne koristi.
*Scenario:* konto 2410 — 2022. D100/P40 (saldo 60), PS 01.01.2023. D60, 2023. D10/P20.
Tačan saldo 31.12.2023. = 50; motor daje **110**. Obe strane bilansa su naduvane za isti
iznos, pa kontrolno pravilo `0059 = 0456` to **ne hvata**.

*Zašto je bilo nevidljivo:* dev baza ima **samo 2026. godinu**, **nula naloga vrste `ZAK`** i
**nula naloga vrste `PS`** (provereno pri ukrštanju: `select order_type_code, count(*) from
journal_entries group by 1` → NALOG/IZVOD/UFROB/UVOZ/… ni ZAK ni PS). Nijedno merenje ijednog
revizora nije moglo da okine defekt na podacima.

*Napomena o sporenju:* jedan revizor je zapisao „izuzimanje ZAK-a radi kako je zamišljeno,
commit `33c39a7` drži". Njegov test je bio nad **jednom** godinom uz ručno dodat ZAK — to je
uži slučaj i **ne pobija** nalaz. Komentar u kodu (`gkeval.service.ts:50-64`) tačno kaže da
donja granica ne rešava problem ZAK-a unutar iste godine — ali iz toga je izveden pogrešan
zaključak da granica nije potrebna. Potrebna je, zbog **ranijih** godina.

**Predlog:** dodati donju granicu perioda u `aggregate()` za D/P grane
(`AND je.posting_date >= startOfYear(godina)`) i zadržati izuzimanje ZAK-a za klase 5/6 unutar
te godine. Za bilans stanja donja granica mora biti **datum poslednjeg PS naloga**, ne početak
godine. Uz to: regresioni test sa **DVE** godine u knjizi — postojeći `gkeval.service.spec.ts`
testira samo jednu i time kodifikuje grešku.

---

#### K2 · N:M avansi su izgrađeni a nedostupni iz aplikacije ⛌ 1× ✔ potvrdio pregled

> **ISHOD 28.07. → ISPRAVLJENO, i defekt je bio DVOSTRUK.** Uslov prikaza je vezan za neiskorišćen ostatak (`advanceRemainderCents(a) > 0`), ali je pregled promašio drugu polovinu: `sales.controller.ts` je gradio novo telo `{ invoiceId, advanceInvoiceId }` i ISPUŠTAO `amount`, pa delimično odbijanje kroz HTTP nije postojalo ni sa popravljenim dugmetom. Oba su zatvorena i pokrivena: smoke `scripts/smoke-avansi-nm.ts` (14 OK / 0 FAIL nad dev bazom; 37.902 → 20.802 + 17.100 kroz iste rute koje zove ekran) i novi `sales.controller.spec.ts` (mutacija „kontroler opet guta `amount`" sada pada). Usput zatvoreno i prekoračenje avansa kroz legacy vezu: iskorišćenost je sada UNIJA spojne tabele i 1:1 kolona, ne „ili-ili".

Migracija `20260726120000_avansi_nm_primene`, model `invoice_advance_applications` i +382
linije u `advance-invoice.service.ts` — sve postoji. Ali dugme „Veži na konačni račun" se
prikazuje **samo dok je `a.linkedFinalInvoiceId == null`**
(`frontend/src/app/fakturisanje/avansi/page.tsx:243`, potvrđeno čitanjem). To polje se izvodi iz
**denormalizovane 1:1 kolone** `invoices.advance_invoice_id`, koju backend upisuje pri PRVOJ
primeni (`advance-invoice.service.ts:948-961`, `isFirstApplication`). Posle prve primene dugme
trajno nestaje; drugog ulaza u `LinkFinalDialog` nema.

*Scenario:* AVR-00013/2025 od 37.902,00 naplaćen. Veže se 20.802,00 na IFR 353/25. Preostalih
**17.100,00 se više ne može odbiti nigde u aplikaciji.** U samom dijalogu piše suprotno: „Isti
avans se sme podeliti na više računa — dok se ne potroši ceo naplaćen iznos."

**Predlog:** uslov prikaza vezati za `advanceRemainingAmount > 0` (backend ga već računa), a
kolonu „Vezan za" hraniti iz `invoice_advance_applications`, ne iz 1:1 kolone.

---

### 2.2 VISOK

#### V1 · Šest od sedam kontrolnih pravila završnog računa su tautologije ⛌ 3×

> **ISHOD 28.07. → ISPRAVLJENO, uz doradu u drugom krugu.** Svih 7 tautologija je OBRISANO; novi katalog (7 pravila za BS, 5 za BU) poredi izračunat obrazac sa ravnim SQL agregatom nad `ledger_entries`. Drugi krug pregleda je u NOVOM katalogu našao dva VISOKA promašaja i oba su zatvorena: (1) `NEPRIMENLJIVO` se preslikavalo u `passed=true`, pa je ŠTAMPANI OBRAZAC iznad aktive 2.351.185 i pasive 2.240.370 (u hiljadama) pisao zeleno „PROLAZI" — sada je zeleno SAMO `PROLAZI`, a papir i ekran prikazuju sva četiri ishoda uz poruku i dokaze; (2) `GK_VAN_OBRASCA` je sabirao poreska konta 721/722 u „saldo van obrasca" a izbacivao ih iz spiska dokaza, pa bi proknjižen porez na dobit oborio dva BLOKIRAJUĆA pravila na ispravnom obrascu, i to sa praznom listom konta. Mereno posle ispravke nad stvarnom BigBit knjigom (dev, 2026): 10 prošlo / 0 palo; 169/169 i 95/95 konta pokriveno; Δ=0,0000 na sva tri ukrsna pravila.

`control-rules.service.ts:80-146`. Desna strana pravila je **doslovno seed formula leve
strane**: `0401`, `1043`, `1044` su znak-za-znak prepisane; parovi `1025/1026`, `1037/1038`,
`1055/1056` su identiteti `clamp(x) − clamp(−x) = x` jer je formula druge pozicije para tačno
negacija prve. Jedino `0059 = 0456` poredi dva različita izraza — i ono postaje tautologija u
grani kad je `0455 > 0`.

*Empirijski (jedan revizor, motor nad 2026):* šest pravila daju L i D jednake **u cifru**
(314.008.748,74 = 314.008.748,74; 546.968.917,91 = 546.968.917,91; …), a jedino pravilo sa
različitim formulama pada. *Drugi revizor* je isto dokazao skriptom koja parsira 179 seed
formula i poredi ih sa katalogom pravila.

*Zašto je ovo ozbiljno:* commit `9cafad5` i `PREGLED_DOKUMENATA_4.0.md` tvrde „nova kontrolna
pravila **umesto** tautologija". Popravka je zamenila slučajne tautologije egzaktnim. Knjigovođa
vidi sedam zelenih značaka „Prolazi" i finalizuje bez `force` — a K1 iznad prolazi kroz njih
neprimećen. Uz to je zadržan `sumTerms` (`:206`) sa `amounts.get(t.aop) ?? 0`, pa nepostojeći
AOP i dalje ćuti kao nula — isti obrazac zbog kog je staro pravilo `1068 == 1064 − 1066` lažno
prolazilo.

**Predlog:** pravila moraju porediti **dva nezavisna izvora** — npr. Σ po klasama konta iz
bruto bilansa protiv AOP zbira, ili prethodna kolona protiv arhiviranog obračuna. `sumTerms`
da razlikuje „AOP ne postoji" od „AOP je nula" i takvo pravilo prijavi kao NEPRIMENLJIVO, ne
kao prošlo.

---

#### V2 · Dve migracije nisu u `_prisma_migrations`, a jedna od njih bezuslovno briše bilanse ⛌ 3× ✔ potvrdio pregled

> **ISHOD 28.07. → ISPRAVLJENO.** Obe migracije su u `_prisma_migrations` sa pravim sha256 (`af90beae…` i `0282a6bc…`, preračunato posle današnjih izmena teksta), obe imaju branu (`ZAVRSNI_RACUN_PREDAT` / `PDV_PRIJAVA_PREDATA`) i arhivu (`arch_*`). Drugi krug je našao da poruka brane vodi u ćorsokak — posle pada u `migrate deploy` ostaje NEZAVRŠEN red, pa SVAKI naredni deploy pada sa P3009 — i to je zatvoreno: poruka i zaglavlja sada nalažu `prisma migrate resolve --rolled-back <ime>` i prekidač NA NIVOU BAZE (`ALTER DATABASE … SET`) umesto ručnog `psql \i`. Dokazano nad svežom bazom `servosync_int_dokaz`: brana opali (P3018 + srpska poruka) → tri koraka iz poruke → „All migrations have been successfully applied" i `migrate status` = „Database schema is up to date!". Dopunjeno: arhiva sada čuva i `statement_finalized_at` (datum zaključenja se ranije gubio bespovratno).

Provereno danas nad dev bazom:

| provera | rezultat |
|---|---|
| `20260726090000_seed_balance_formulas_autenticne` u `_prisma_migrations` | **NE** |
| `20260727090000_pdv_registar_ispravka` u `_prisma_migrations` | **NE** |
| `balance_formula_definitions` | 117 BS + 62 BU (= novi seed, efekat JESTE tu) |
| `vat_account_map` | 26 redova, kolone `has_base` nema (efekat JESTE tu) |
| `financial_statements` | 2 reda, oba DRAFT, 179 linija |

Dakle SQL je pušten mimo Prisme. **Sledeći `prisma migrate deploy` ponovo izvršava obe.**
`20260726090000` (linije 85-97) radi bezuslovno:

```sql
DELETE FROM balance_formula_definitions WHERE statement_type IN (…);
DELETE FROM financial_statement_lines WHERE statement_id IN (…);
UPDATE financial_statements SET status='DRAFT', finalized_at=NULL WHERE …;
```

Bez guarda, bez arhive, bez `down` puta. Na produkciji (gde `/zavrsni-racun` živi za pilot krug
od 22.07.) isti DELETE pogađa svaki finalizovan bilans. Jedan revizor je to i **izveo na
prod-slici**: napravio bazu sa `origin/main` migracijama (1398 konta / 2 šeme / 0 saldakonta =
opis produkcije), ubacio dva `FINAL` obračuna, pustio 11 migracija → oba `DRAFT`,
`finalized_at=NULL`, 0 linija.

`20260727090000` u zaglavlju piše „PAZI PRE PRODA … proveri da nema `vat_returns` u statusu
POSTED", ali **sama ništa ne proverava** — dokazano ubacivanjem `POSTED` povraćaja pre
`migrate deploy`: prošla bez ijedne poruke, registar promenjen ispod već predatog perioda.

*Dva revizora su ranije u noći izmerila `32 BS + 25 BU` (stari seed) i zaključila da novi seed
NIJE primenjen. To odbacujem kao trenutno stanje — danas je 117 + 62. Njihov zaključak o
ledgeru ipak stoji, i to je važniji deo.*

**Predlog:** `prisma migrate resolve --applied` za obe na dev-u; `RAISE EXCEPTION` guard u
090000 kad postoji `financial_statements` sa `status <> 'DRAFT'` i u 20260727090000 kad postoji
`vat_returns` sa `status = 'POSTED'`; pre DELETE-a upis starih redova u arhivsku tabelu.

---

#### V3 · APR eFI (FiForma) XML i štampa istog obračuna se razlikuju za faktor 1.000 ⛌ 1× ✔ potvrdio pregled

> **ISHOD 28.07. → OSTAJE (blokira P1).** Nije dirano: `apr-xml.service.ts` i dalje šalje dinare, štampa hiljade. To je jedina razlika koja iz aplikacije izlazi u dva kanala, pa je u presudi uslov: `exportFiForma` se ne sme koristiti za predaju dok knjigovođa ne odgovori na P1.

`apr-xml.service.ts` — `grep` za `1000` i za `hiljad` daje **nula pogodaka**; `xmlTag`
(`:317-324`) zaokružuje iznos na ceo broj u jedinici glavne knjige (dinar) i tako ga upisuje.
`statement-pdf.service.ts:630` deli isti iznos sa 1.000. Kod to **sam priznaje** u napomeni
koju štampa korisniku (`statement-pdf.service.ts:507-509`): „u XML-u su zaokruženi na ceo broj
u jedinici glavne knjige (dinar), a ovde svedeni na hiljade". `git diff --stat
origin/main...HEAD` pokazuje da `apr-xml.service.ts` u ovom talasu **nije ni diran**, iako je
štampa dodata i eksplicitno dokumentuje neslaganje.

*Nesporno:* ista finansijska linija izlazi iz aplikacije kroz dva kanala sa razlikom 1.000×.
*Sporno i mora se potvrditi:* **koji je kanal tačan.** Obrazac po Pravilniku 89/2020 nosi
zaglavlje „— у хиљадама динара —" (vidi `backend/reports/zr/bs.txt:12`), pa je papir po svemu
sudeći tačan. Ali `xmlTag` je port BigBit-ovog `ZRXML` modula — ako je BigBit godinama slao
dinare i APR to prihvatao, onda je XML tačan a napomena samo objašnjava razliku jedinica. **To
mora presuditi knjigovođa ili APR shema, ne kod.** Vidi pitanje P1.

**Predlog:** uvesti jedinicu obrasca kao svojstvo obračuna i primeniti je na JEDNOM mestu, pre
nego što iznos uđe i u PDF i u XML. Dok se ne presudi, `exportFiForma` treba da traži
eksplicitnu potvrdu jedinice umesto da tiho izda fajl koji se sme predati.

---

#### V4 · KEP: ekran i papir daju različit redni broj i različit saldo ⛌ 1× ✔ potvrdio pregled

> **ISHOD 28.07. → OSTAJE (blokira P2a).** `useKepu(period)` i dalje ne prima `warehouseId`, pa ekran i papir mogu dati različit redni broj i saldo. Uz to je i sam propis sporan (O19).

Izbor „Magacin" na tabu KEPU utiče **samo na PDF**. `useKepu(period)`
(`frontend/src/api/pdv.ts:218`) ne prima `warehouseId`, a `rbr` (`ROW_NUMBER`) i `running_balance`
(`SUM OVER`) se u SQL-u računaju **unutar** filtera po magacinu.

*Dokaz (revizor, replika SQL-a nad dev bazom):* bez filtera dokument id=3 ima rbr 3 / saldo 180;
sa `warehouse_id = 1` isti dokument ima rbr 2 / saldo 130. KEP je zakonska evidencija — redni
broj reda i saldo su njen sadržaj.

Ruta `GET /v1/pdv/kepu` **već prima** `warehouseId` (`pdv.controller.ts:197-206`) — nedostaje samo
prosleđivanje iz hook-a.

Uz to postoje **dva suprotna tumačenja istog propisa u istom modulu**: `docs/STAMPE_4.0.md` §3
kaže „obrazac je vezan za JEDAN magacin (čl. 3: knjiga se vodi po prodajnom mestu)", a docstring
u `kepu.service.ts:141-142` kaže „kumulativni saldo je globalan (svi magacini zajedno) — knjiga
se vodi na nivou obveznika". Dok se to ne presudi (pitanje P2), ne zna se ni koji je broj tačan.

---

#### V5 · KEP nema trajan redni broj ni početno stanje godine ⛌ 2× (različiti aspekti) ✔ potvrdio pregled

> **ISHOD 28.07. → OSTAJE (blokira P2b/P2d).** `kepu_book_entries` i dalje nema ni `rbr` ni `strana`, ni unos početnog stanja godine.

Provereno danas: `kepu_book_entries` ima kolone `id, company_id, warehouse_id, document_id,
entry_date, charge, discharge, charge_vp, discharge_vp, description, created_at` — **nema `rbr`
ni `strana`**, ni posle nove migracije `20260727150000_kep_vrednovanje_mp_vp`. Broj se
preračunava pri svakom čitanju (`ROW_NUMBER() OVER (ORDER BY entry_date, id)`), a punjenje briše
i ponovo upisuje po `documentId` (`kepu-book.util.ts:230-235`).

*Scenario:* strana 1 knjige je odštampana i potpisana (redovi 1/05.03., 2/10.03., 3/20.03.).
Sutradan se unese primka datirana 07.03. Ponovna štampa daje: nova primka = r.br. 2, stari 2 → 3,
stari 3 → 4. Kod knjige duže od 45 redova pomeraju se i granice strana, dakle i DONOS/ZA PRENOS
na **već potpisanim** listovima. Dva potpisana lista iste knjige protivreče jedan drugom.

Drugo: nema unosa početnog stanja godine — jedini pisač `kepu_book_entries` je vezan za
`documentId` robnog dokumenta, a `KepuService.book` ograničava kumulativu na tekuću godinu
(`kepu.service.ts:149-152`), pa DONOS na prvoj strani svake godine izlazi 0,00.

*Napomena:* jedan revizor je proverio i **potvrdio** lanac DONOS/ZA PRENOS (ZA PRENOS strane 1 =
DONOS strane 2, pročitano iz PDF-a). To je unutrašnja konzistentnost **jednog snimka** i ne
pobija ovaj nalaz — pobija samo sumnju da je aritmetika zbirova pogrešna.

Vidi pitanje P2 (b) o obrascu.

---

#### V6 · Noćni uvoz može tiho prepisati proknjižen i ZAKLJUČAN nalog, bez traga ⛌ 1×

> **ISHOD 28.07. → ISPRAVLJENO, uz TRI regresije nađene u drugom krugu i zatvorene.** Brana odbija izmenu zaključanog naloga i zapisuje je u `bb_import_rejected_changes` (staro→novo). Drugi krug je pokazao da je brana bila i preširoka i pogrešno raspoređena: (R1) 4.0-nativno zaključavanje perioda (`lockOlderThan`) je pravilo TRAJNU razliku u koloni `status`, pa se svaki takav nalog SVAKE noći brojao kao odbijena izmena i ispadao iz upsert-a — status se više ne poredi, a BigBit ga ne sme skinuti; (R2) fajl koji i menja i zaključava nalog davao je NOVO zaglavlje uz STARE iznose — zaključavanje je izdvojeno u poseban korak NA KRAJU uvoza (`applyBigbitLocks`); (R3) prekinut uvoz je ostavljao zaključan nalog sa delom stavki koje NIKAD više ne bi ušle — nedostajuća stavka sada sme da uđe na nalog koji ne zbraja u nulu. Sve tri su pokrivene smoke-om `scripts/smoke-uvoz-zakljucani.ts` (18 OK / 0 FAIL), a stara zaštita je i dalje živa (R3b: dopisana stavka na URAVNOTEŽENOM zaključanom nalogu se i dalje odbija i zapisuje).

`bigbit-mdb-import.service.ts:925-940` — `ON CONFLICT (bb_stavka_id) DO UPDATE SET debit, credit,
account_code, analytical_code, posting_date`; `:769-787` isto za nalog uključujući `status`. Nema
nijednog guarda prema zaključanom PDV periodu ni prema finalizovanom obračunu; `:726` samo
**mapira** BigBit-ovo `zakljucano` u status. Uvoz nikad ne briše (`:273`), pa nalog obrisan u
BigBitu ostaje u 4.0 kao fantom.

*Scenario:* PDV prijava za 03/2026 izračunata i period zaključan. Knjigovođa u BigBitu prekontira
stavku marta. Sledeće noći u 03:45 uvoz prepiše `ledger_entries`; KIF/KUF i `vat_returns` ostaju
stari, glavna knjiga više ne odgovara predatoj prijavi, a stara vrednost nigde nije zapisana.

**Predlog:** odbiti (ili izdvojiti u red za ručnu odluku) izmenu stavke koja pripada nalogu u
statusu `LOCKED` ili periodu za koji postoji `vat_return`/`financial_statement`, i svaku
prepisanu vrednost upisati u tabelu izmena (staro → novo, `drop_id`, vreme).

---

#### V7 · Prekidač noćnog uvoza je seedovan UKLJUČEN, a korak 1 se instalira ručno ⛌ 1× ✔ potvrdio pregled

> **ISHOD 28.07. → ISPRAVLJENO.** Prekidač je posejan `FALSE` (migracija 20260728130000; dokazano nad svežom bazom — uvoz vraća `DISABLED` i upisuje 0 naloga). Nadzornik ćuti samo u stanju „isključen I nijedan uvoz nikad nije uspeo". Drugi krug je našao da je to utišavanje bilo PREŠIROKO — rani `return` je stajao pre filtera, pa je gutalo i „poslednji pokušaj uvoza je PAO" — pa se sada izuzimaju samo dva upozorenja po STABILNOJ ŠIFRI (`PREKIDAC_ISKLJUCEN`, `NIKAD_NIJE_PRORADIO`), a upozorenje bez šifre se nikad ne utišava (3 nova testa).

`20260726150000_prekidac_bigbit_sync/migration.sql:22-24` — `VALUES ('bigbit_mdb_sync', TRUE, …)`.
Host skripta koja puni staging (`bigbit-mdb-export.sh` + systemd timer) instalira se ručno
(`BIGBIT_NOCNI_SYNC.md:31`, `:452`) i **nije** u `deploy-backend.yml`.

*Scenario:* deploy na produ, `bb_mdb_drops` prazna. U 03:45 posao baca `BigbitMdbDropStaleError`,
`scheduled_job_runs` = FAILED + 2 retry-a. Posle 48 h (`NEVER_IMPORTED_GRACE_HOURS`) ekran prelazi
u `danger`, a jutarnji nadzornik u 07:15 (namerno bez prekidača) šalje `app_notifications`
**svakom aktivnom adminu — jednu poruku dnevno, zauvek**, jer uzrok nije na strani 4.0.

**Predlog:** seedovati `enabled = FALSE`, ili instalaciju koraka 1 uvrstiti u deploy pre nego što
migracija prođe. Alternativa: nadzornik ne alarmira dok `bb_mdb_drops` nema **nijedan red ikad**
(kanal nije podignut ≠ kanal je pukao).

---

#### V8 · Nema puta nazad iz uvoza ⛌ 1×

> **ISHOD 28.07. → ISPRAVLJENO.** `backend/scripts/bigbit-mdb-unimport.ts` postoji: prvo ISPISUJE šta bi obrisao pa staje, traži `--izvrsi --potvrdi=<drop>`, odbija se ako je nad tim stavkama računata predata PDV prijava, i vraća zaključane naloge u DRAFT unutar iste transakcije da bi trigger `POSTED_DELETE_FORBIDDEN` ostao uključen.

Uvezeni nalozi se upisuju kao POSTED/LOCKED (`bigbit-mdb-import.service.ts:726`); DB triger
`POSTED_DELETE_FORBIDDEN` (`20260725200000_faza2_constraint_mreza`) zabranjuje brisanje; pet novih
FK-ova prebačenih na `ON DELETE RESTRICT` (`20260726170000_bigbit_sync_remedijacija:29-53`)
zabranjuje i brisanje samog drop-a. `grep` po `src/` za bilo kakav delete/undo po `imported_drop_id`
→ 0 pogodaka; `sync.controller.ts` nema rutu za poništavanje.

*Scenario:* prva noć u kojoj korak 1 proradi upiše ~1.100 naloga i ~20.000 GK stavki u
**produkcijsku** glavnu knjigu (danas 0 redova). Ako se ispostavi da je fajl pogrešan, povratak nije
moguć aplikativno — ostaje ručna hirurgija uz gašenje trigera.

**Predlog:** napisati i testirati `backend/scripts/bigbit-mdb-unimport.ts` PRE nego što uvoz prvi
put pogodi produkciju.

---

#### V9 · Spisak kompenzacija je izgrađen a ne renderuje se ⛌ 1×

> **ISHOD 28.07. → OSTAJE.** Spisak kompenzacija se i dalje ne renderuje; `docs/STAMPE_4.0.md` §3 i dalje tvrdi suprotno (O8).

Ruta `GET /v1/saldakonti/compensation` postoji (`saldakonti.controller.ts:273`), hook
`useCompensations` postoji i **poziva se** (`compensation-panel.tsx:36`) — ali se rezultat
**nigde ne renderuje**. Jedini `DataTable` u fajlu (`:216`) prikazuje predlog prebijanja. Štampa
izjave visi isključivo o prolaznom `lastCreated` banneru, koji nestaje pri reload-u; uz to
`submit()` na uspehu radi `setPartnerId(null)`.

*Scenario:* izjava napravljena u petak, druga strana u ponedeljak traži još jedan primerak za
potpis. Nema tabele, nema kolone „Štampa", nema načina da se nađe. Papir je izgubljen dok se ne
napravi NOVA kompenzacija — što bi dvaput proknjižilo prebijanje.

---

#### V10 · Ulazni obrasci traže interne bazne id-jeve; šifarnik artikala ne postoji ⛌ 1× ✔ potvrdio pregled

> **ISHOD 28.07. → OSTAJE.** `LookupsController` i dalje nema artikle; četiri obrasca i dalje traže „Artikal (#)". Robni unos je time i dalje neupotrebljiv za magacionera.

`LookupsController` ima **samo** `projects`, `customers`, `warehouses` — pročitao sam ceo fajl
(29 linija). Za artikle lookup-a nema, a četiri obrasca traže „Artikal (#)" kao broj
(`transfer-dialog.tsx:216`, `new-document-dialog.tsx:182`, `item-card-panel.tsx:132/:143`,
`carry-over-dialog.tsx:181`). Lager lista, jedini ekran gde magacioner vidi artikle, prikazuje
`#itemId` **samo kao rezervu** kad nema naziva. Šifra komitenta se traži na 9 mesta, a `/customers`
je nema ni u koloni ni u detalju. „Vrsta (kod)" je slobodan tekst sa hintom „DocumentType.code" —
ime kolone iz baze prikazano magacioneru.

*Scenario:* magacioner treba da prenese 5 kom „Test ležaj" iz A u B. Magacini su Select (radi),
stavka traži „Artikal (#)". Nađe „Test ležaj / TEST-001" na lageru — id se ne vidi. Nema pretrage
artikala, nema šifarnika u meniju, nema `/v1/lookups/items`. **Prenos se ne može uneti.**

---

#### V11 · Esc u dijalogu gasi celo stablo obrađivača ⛌ 1× ✔ potvrdio pregled

> **ISHOD 28.07. (dopuna, isti dan) → POPRAVLJENO I DOKAZANO U PRAVOM CHROMIUM-U.**
> Uslov iz presude („pre FE deploy-a ILI vrati staro ponašanje ILI popravka proveri u pretraživaču")
> je **ispunjen drugom granom** — popravka je proverena u pretraživaču, pa vraćanje starog nije
> potrebno. Izabran je **stek najgornjeg sloja**, ne bubble-nad-panelom: druga varijanta zavisi od
> toga gde je fokus, a upravo u spornom toku (skeniranje) fokus drži skener, ne polje u panelu.
>
> Uvedeno: `frontend/src/components/ui-kit/escape-layer.ts` — **jedan** deljeni `keydown`
> capture-slušalac na `window` + stek slojeva. Na Esc reaguje **samo poslednji otvoreni sloj**, uz
> `stopPropagation` **i** `stopImmediatePropagation`, pa događaj ne stiže ni do ekrana ispod ni do
> ostalih slušalaca na istom čvoru. Prevedeno na četiri potrošača: `dialog.tsx`,
> `reversi/_components/quick-return-dialog.tsx` (Esc kroz sloj, Enter ostaje sopstveni),
> `lokacije/_components/scan-overlay.tsx`, `mob/odrzavanje/maint-scan-overlay.tsx` — **i
> `reversi/_components/scan-overlay.tsx`, koji pregled nije imenovao a upravo je u spornom toku**
> (postoje dva različita skenera; pregled je našao lokacijski, a „Brzi povraćaj" koristi reversni).
> `help-mode.tsx` je **namerno ostavljen** — već ima sopstvenu slojevitost i već ustupa Esc otvorenom
> dijalogu; dok steka nema, ponaša se identično kao pre.
>
> **Dokaz:** `frontend/scripts/escape-layer.proof.mjs` pokreće pravi Chromium (Playwright iz `e2e/`),
> učitava **jezgro iz samog izvora** (skinu se samo TS anotacije, uz branu koja pada ako je skidanje
> pojelo neku ključnu naredbu) i meri redosled okidanja nad topologijom ekran/dijalog/kartica.
> Reprodukuje nalaz pregleda i pokazuje ispravku: **STARO → `["DIALOG","INNER"]`, NOVO →
> `["INNER"]`**; kad se kartica zatvori Esc pripada dijalogu, kad se sve zatvori pripada ekranu;
> stek se prazni (2 → 0). **6/6 provera 🟢.**
>
> Usput ispravljena i zamka u samom dokazu: prva verzija je slala Esc direktno na `window`, čime
> `window` postaje meta i nema ni capture ni bubble faze nad njim — merenje je bilo bezvredno i
> pokazivalo lažan pad. Esc se sada šalje sa fokusiranog polja, kako i stiže u stvarnosti.
>
> *(Zatečeno stanje pre ove dopune, radi istorije: `dialog.tsx` je izmenjen u commitu `f80fd13`,
> unutar 8 komitova pod pregledom, i regresiju je uneo taj paket.)*

`frontend/src/components/ui-kit/dialog.tsx:48-56` — slušalac je premešten na **capture** fazu na
`window` uz `e.stopPropagation()`. Događaj se time zaustavlja na prvom čvoru putanje i **ne stiže
ni do jednog elementa u dokumentu**: gase se svi element-level i React `onKeyDown` Escape
obrađivači dok je bilo koji Dialog otvoren. Istovremeno, unutrašnji potrošači koji su DOSAD štitili
dijalog (capture na `window` + `stopPropagation`) to više ne rade — `stopPropagation` ne zaustavlja
druge slušaoce na ISTOM čvoru (za to treba `stopImmediatePropagation`), pa se sada okidaju OBA.

*Scenario:* Reversi → „Brzi povraćaj" → skeniraš barkod → kartica potvrde → Esc. Komentar u kodu
(`quick-return-dialog.tsx:183`) doslovno kaže: „inače Esc zatvori ceo tok umesto samo potvrde".
Posle izmene se zatvara **i cela dijalog „Brzi povraćaj"**, pa se tok skeniranja prekida.

*Dokaz (revizor, Playwright u pravom Chromium-u, dve skripte):* STARO → `['INNER(capture)']`;
NOVO → `['DIALOG(capture)','INNER(capture)']`. Bez unutrašnjeg potrošača: STARO →
`['NATIVE','REACT-onKeyDown','DIALOG(bubble)']`; NOVO → `['DIALOG(capture)']`.

Ista klasa važi i za `lokacije/_components/scan-overlay.tsx:1017`,
`mob/odrzavanje/maint-scan-overlay.tsx:148`, `ui-kit/help-mode.tsx:241`.

---

#### V12 · Ekran „Podaci firme" piše 15 polja koja sync vraća na BigTehn vrednost ⛌ 1× (sporno razrešeno)

> **ISHOD 28.07. → OSTAJE.** 15 mapiranih polja ekrana „Podaci firme" i dalje nije zaštićeno od sync-a.

`NATIVE_COLUMN_TABLES` (`table-ownership.ts:215`) štiti samo **nemapirane** kolone — `update: d`
piše sva **mapirana** polja. Novi ekran (`PUT /v1/admin/firma`, `SETTINGS_SYSTEM`, uveden u istom
paketu) dozvoljava izmenu 15 polja koja **jesu** mapirana u sync-u tabele `companies`
(`sync-map.generated.ts:2458+`, `watermark: null` → full refresh): companyName, address, city,
municipality, phone, fax, email, webAddress, taxId, registrationNumber, businessActivity,
businessActivityCode, bankAccount, owner, invoiceIssuingPlace, footerText. Zaštićeni su samo
`iban` i `swift`.

*Scenario:* ispraviš adresu i tekst u podnožju memoranduma → Sačuvaj → sledeći sync ih tiho vrati.
Zaglavlje i podnožje svih 46 obrazaca se vrate na staro; korisnik nema nikakvu poruku.

*Razrešenje sporenja:* drugi revizor je zapisao „zaštita `companies.iban/swift` stvarno radi" i
označio to kao prošlo. Tačno je — ali za **dve** native kolone. Ostalih 15 su mapirane i nezaštićene.
Nalaz stoji; „prošlo" je bilo užeg obima.

---

#### V13 · Dnevnik knjiženja za godinu je neizvodljiv nad stvarnim podacima ⛌ 1×

> **ISHOD 28.07. → OSTAJE.** Kapa od 20.000 stavki i dalje stoji, a knjiga za 2026. ih ima preko 20.400 — dnevnik za godinu i dalje nije izvodljiv ni za jednu godinu.

Kapa je 20.000 stavki (`journal-book-print.service.ts:126-130`), a dev baza ima **20.366** stavki GK
za 2026 — i to samo za sedam meseci (izvoz ide do 11.07.). Puna godina bi bila ~35.000.

*Scenario:* /glavna-knjiga → Dnevnik → „Dnevnik (PDF)" → godina 2026 → HTTP 400 „Dnevnik za zadati
obim ima 20372 stavki (najviše 20000 po dokumentu)". **Nijedan izbor godine nikad neće proći.**

Usput: `proof-stampe-finansije.ts:346` na tom padu prekida celu skriptu, pa **devet** preostalih
štampi (bruto bilans, izvod, kompenzacija, opomena, kartica konta, kartica komitenta + tri rubna
slučaja) nikad nije izmereno.

---

### 2.3 SREDNJI

#### S1 · Uvoz ubacuje saldakonto konta bez `partner_scope`, guard fail-uje otvoreno ⛌ 3× (jedan produbio) ✔ potvrdio pregled

> **ISHOD 28.07. → OSTAJE.** `partner_scope` i dalje nije u INSERT listi uvoza; guard i dalje fail-uje otvoreno. Uz noćni uvoz je to uslov u presudi.

INSERT lista u `bigbit-mdb-import.service.ts:670-686` glasi `(account, side, control_account,
tracks_open_items, holds_din_balance, holds_fx_balance, imported_drop_id)` — **`partner_scope` nije
ni u INSERT-u ni u DO UPDATE SET.** Četiri nova potrošača filtriraju `partner_scope = 'customer'`
/ `'supplier'` (`fakturisanje.service.ts:721`, `open-items.service.ts:293`,
`payment-preparation.service.ts:128`), a SQL jednakost sa NULL nikad nije TRUE.

*Scenario:* BigBit knjigovođa otvori novo analitičko konto kupaca (npr. 2041); migracija
`20260726100000` pokriva samo 9 imenovanih šifara. Noćni uvoz ga ubaci sa `partner_scope = NULL`,
status DONE, bez napomene. Kupac ima 5.000.000 duga na 2041 uz limit 1.000.000 → `assertCreditLimit`
sumira uz `partner_scope='customer'` → suma 0 → **faktura preko limita prolazi kao da duga nema**, a
isti dug nestaje iz aging izveštaja. Guard koji je ovim paketom prvi put uključen fail-uje **otvoreno
i bez traga.**

Uz to, tri revizora su nezavisno našla da je danas na dev-u **10** saldakonto konta, ne 9 kako tvrdi
`REMEDIJACIJA_PO_BIGBIT_STUDIJI.md` §1. Potvrdio sam: deseti je **9911** („Dobit po osnovu prodaje
materijala", vanbilansna klasa 9) sa `side='receivable'`, `partner_scope='customer'`,
`imported_drop_id=NULL` — dakle red je došao mimo migracije i mimo uvoza, a pošto scope **nije**
NULL, mehanizam „NULL scope se ne uzima" ga ne štiti. **Vanbilansno konto od sada ulazi u starenje
potraživanja i u kreditni limit kupca.**

**Predlog:** `partner_scope NOT NULL` sa eksplicitnom vrednošću `'unknown'` (pa potrošači prijave
listu nesvrstanih umesto da ćute), zdravstvena provera u `bigbitStatus()` za `partner_scope IS NULL`,
i odluka šta 9911 tu traži.

---

#### S2 · Kontrola P5 (osnovica vs stopa) je algebarski identitet ⛌ 2×

> **ISHOD 28.07. → OSTAJE.** P5 je i dalje algebarski identitet. Ista klasa greške kao V1, ali u PDV modulu — nije bila u obimu ovog kruga.

`deriveBase` (`vat-ledger.service.ts:511-516`) računa osnovicu kao `PDV / (stopa/100)`; P5
(`vat-sanity.ts:272-302`) zatim proverava da li je `osnovica × stopa = PDV`. To je ista jednačina
rešena unazad — **ne može pasti ni za jedan automatski izveden red.**

*Izmereno nezavisno, dva puta:* 0 odstupanja od 3.468 redova; i po grupama:
`SUM(vat_amount) − SUM(vat_base)*stopa/100` = `0.000000000000` u **svih 21** grupu (7 meseci × smer ×
stopa) za 2026.

*Scenario:* konto u registru dobije pogrešnu stopu (npr. 4703 kao 10 % umesto 20 %). Osnovica se
izvede dvostruko veća; P5 poredi (dvostruka osnovica) × 10 % sa PDV-om i dobija razliku 0 → period
prolazi kao ispravan, a KIF i PP-PDV prijavljuju dvostruku osnovicu. Osnovica u KIF/KUF i POPDV
**nema nijednu drugu kontrolu** — P4 meri PDV, ne osnovicu.

Iz istog razloga je oborena i tvrdnja „implicitna stopa 19,9–20,0 %" kao dokaz (vidi §3).

---

#### S3 · Bilansna ravnoteža ne prolazi ni sa zaključnim nalogom: tolerancija 0,01 vs izvorne 0,10 ⛌ 1× ✔ potvrdio TOLERANCE

> **ISHOD 28.07. → ISPRAVLJENO, ali NE po predlogu pregleda.** Predlog „podići toleranciju na nivo zaokruženja izvora" je ODBAČEN uz obrazloženje: podignuta tolerancija skriva i STVARNU grešku iste veličine. Umesto toga se neuravnoteženost MERI i ulazi kao imenovan sabirak — pravilo `GK_URAVNOTEZENA` nabraja svih 13 naloga poimence (AVANS 0011 #3574 = 0,09; UFROB 260415 #4484 = 0,02; ostalih 11 po 0,01), nosi status UPOZORENJE i `blocking=false`, pa finalizacija zbog njih NIJE blokirana i `force` nije potreban. `TOLERANCE` je ostao 0,01.

`control-rules.service.ts:35` — `TOLERANCE = 0.01`. Uvezena BigBit GK 2026 nosi **13
neuravnoteženih naloga** sa neto razlikom **0,10** (Σduguje 13.655.640.165,50 / Σpotražuje
13.655.640.165,40; najveći pojedinačni `AVANS 0011`, `bb_nalog_id 9205`, diff 0,09).

*Scenario:* sa dodatim ZAK nalogom aktiva 2.351.134.038,18 vs pasiva …,08 → `passed=false` →
`finalizeStatement` baca `StatementControlsFailedException`. Jedini izlaz je `force=true`, koji
preskače **svih 7** pravila — a šest ionako ne mogu da padnu (V1). Finalizacija time postaje rutinsko
gaženje kontrola.

**Predlog:** podići toleranciju na nivo zaokruženja izvora uz **obavezan ispis stvarne razlike**, i
uvesti zasebnu kontrolu „glavna knjiga je uravnotežena" nad `ledger_entries` koja **imenuje** tih 13
naloga — da korisnik zna da je kvar u izvoru, ne u obrascu.

---

#### S4 · Bilans za godinu bez zaključnog naloga ne zatvara, a korisnik ne dobija objašnjenje ⛌ 2×

> **ISHOD 28.07. → ISPRAVLJENO.** Bilansna ravnoteža pre zaključnog naloga prijavljuje se kao NEPRIMENLJIVO sa punim objašnjenjem (konto 341 je prazan do ZAK naloga), ne blokira finalizaciju, i — posle ispravke iz drugog kruga — NIJE zelena. Odstupanje 0,10 koje pregled traži da se objasni JESTE objašnjeno: to je u celosti neuravnoteženost knjige (Σ klase 0–4 = 110.814.642,89 vs Σ klase 5/6 = 110.814.642,79), pada na bilans stanja i nije posledica clamp-a.

Nad stvarnom uvezenom GK bez ZAK naloga: aktiva 2.351.134.038,18 / pasiva 2.240.319.395,29, razlika
**110.814.642,89** = neto rezultat A1055. Uzrok: AOP 0410 „Neraspoređeni dobitak **tekuće** godine"
= `P341*-D341*`, a konto 341 je prazan do zaključnog naloga (u GK postoji samo 3400). Uz to se AOP
0455 klampuje sa sirovih **−424.823.391,63** na nulu.

Korisnik vidi crvenu kontrolu i klampovanu poziciju bez ijedne poruke da je to normalno za period
pre zaključka. *Napomena:* jedan revizor je izmerio odstupanje **0,10** između razlike bilansa i
A1055 (110.814.642,89 vs …,79) koje se ne svodi na jedno zaokruženje — verovatno posledica clamp-a na
6 BU pozicija, ali **nije objašnjeno** i treba ga objasniti pre nego što se brojevi predaju.

Dodatno, ista formula `P341*-D341*` u kombinaciji sa K1(b) znači da pozicija označena kao „tekuće
godine" od druge godine prikazuje **višegodišnji zbir** (klasa 3 je namerno izuzeta iz izuzimanja ZAK-a,
ali donje granice i tu nema). AOP 0409 čita drugi konto (`P340*-D340*`), pa se ne kompenzuje.

---

#### S5 · PP-PDV pozicije 001 i 002 su tvrdo prazne ⛌ 1× ✔ potvrdio pregled

> **ISHOD 28.07. → OSTAJE (blokira P3).** Pozicije 001 i 002 su i dalje tvrdo prazne; papir i dalje izlazi bez oznake „NIJE ZA PREDAJU".

`pdv-print.service.ts:351-352` — literalno `["001", "…", null, null]` i `["002", "…", null, null]`.
Uzrok je strukturni: osnovica se u celom modulu izvodi iz PDV-a, pa promet **koji ne nosi PDV**
(izvoz, oslobođenja) po konstrukciji ne može ući ni u jednu knjigu. Registar `vat_account_map` (26
redova) nema nijedno konto sa stopom 0.

*Scenario:* Servoteh ima izvozni promet (predati BU 2023: AOP 1004 = 1.523 hilj. + AOP 1007 = 201.754
hilj. ≈ 203 mil RSD). Odštampa se papir sa naslovom **„PORESKA PRIJAVA POREZA NA DODATU VREDNOST"** i
pozicijom 001 = prazno.

**Predlog:** dok pozicije nemaju izvor, štampa mora nositi vidljivu oznaku „NIJE ZA PREDAJU". Trajno:
izvoditi oslobođen promet iz **prometnih** konta preko `popdv_account_map`, kako i sama migracija
`20260727090000` u obrazloženju predviđa.

---

#### S6 · `clamped` se beleži a nigde ne prikazuje ⛌ 1×

> **ISHOD 28.07. → ISPRAVLJENO.** Pravilo `ODSECANJE_NA_NULU` imenuje odsečene ZBIRNE pozicije sa SIROVIM iznosom (BS: AOP 0455 = −424.823.391,63; BU: 1050/1056 po −110.814.642,79, pa 1046, 1026, 1038) i to se od danas vidi i na ekranu i na štampanom obrascu. Domet je izričito zapisan u samoj poruci: odsecanje LISTOVA sa maskom konta se ovim putem ne vidi.

Motor beleži svaku poziciju spuštenu na nulu sa sirovim negativnim iznosom
(`balance-sheet.service.ts:71/235/289/291/400`) i vraća je u API odgovoru — ali `grep 'clamped'` po
celom `frontend/` daje **nula** pogodaka; tip `FinancialStatement` (`api/zavrsni.ts:104-113`) polje ne
deklariše, nijedan ekran ga ne prikazuje, PDF ga ne štampa.

*Scenario:* za 2023. je 0455 sirovo −167.829 (hiljada) i klampuje se na nulu; bez clamp-a A0456 izlazi
1.036.122 umesto 868.293. Knjigovođa vidi bilans koji se zatvara i kontrolu koja prolazi, bez ijednog
traga da je 167.829 hiljada ućutkano. Ako je clamp posledica greške u maski, greška je nevidljiva do
APR/revizorske provere — dakle godinu dana.

---

#### S7 · Nalog nestao iz BigBita se ne prijavljuje nigde gde ga neko vidi ⛌ 1×

> **ISHOD 28.07. → OSTAJE.** „Nestalo iz BigBita" je i dalje ⚠ substring u summary stringu; `bigbitStatus()` ga ne čita, nadzornik ne zvoni. Uz noćni uvoz je to uslov u presudi.

Uvoz je čist upsert i nikad ne briše; `describe()` (`bigbit-mdb-import.service.ts:518-521`) rezultat
lepi kao ⚠ **substring unutar summary stringa**, status ostaje DONE. `bigbitStatus()` gradi `warnings`
iz šest izvora i **vanished nije nijedan od njih**; ekran ga prikazuje kao neobojen podnaslov pločice
(`integracije-tab.tsx:320`); jutarnji nadzornik okida **isključivo** na `level === 'danger'`
(`bigbit-mdb-jobs.ts:98`). Komentar u kodu (`:293-296`) tvrdi da se to „GLASNO broji" — ne broji se.

*Scenario:* knjigovođa obriše pogrešno unet nalog od 3.000.000 RSD. Posao zelen, ekran bez upozorenja,
zvonce ne stiže. Nalog ostaje u 4.0, ulazi u KIF/KUF i PDV osnovicu, PP-PDV odlazi Poreskoj sa
3.000.000 viška — po sopstvenom komentaru koda „tiho diže PDV osnovicu".

---

#### S8 · Trag štampe popisne liste je mrtav kanal ⛌ 1× ✔ potvrdio pregled

> **ISHOD 28.07. → OSTAJE.** Dugmad popisne liste i dalje ne šalju `?stampa=1`.

Backend je potpun (`?stampa=1`, `inventory-count-pdf.service.ts:125` zove `prints.register` sa
`INVENTORY_COUNT`, žig KOPIJA za varijantu „popunjena"), ali `grep trackPrint` po `frontend/src/app/`
daje **jedan jedini** pogodak — `robno/detalj/page.tsx:487`. Dugmad na
`robno/popis/count-detail.tsx:276` i `:294` zovu `pdf.mutate({ id, variant })` **bez** `trackPrint`.
`document_prints` za `INVENTORY_COUNT` ostaje trajno prazna, papir uvek izlazi kao original, ništa ne
pada i ništa se ne loguje.

Isto: hook `useDocumentPrints` (`api/robno.ts:921`) nema **nijednog** potrošača — jedini mehanizam
kojim se u aplikaciji može objasniti odakle papiru žig KOPIJA i broj primerka nema ekran.

---

#### S9 · Ostali srednji nalazi (bez razrade)

> **ISHOD 28.07. → SVIH PET OSTAJE** (S9a–S9e). Nijedan nije bio u obimu ovog kruga ispravki.
> S9e (nema testa za `postNivLeveling`) je posebno vredan pomena: isti obrazac „funkcija radi,
> dokaz ne postoji" je u ovom krugu potvrđen mutacionim testom na dva druga mesta
> (`finalizeStatement`, prosleđivanje `amount` u kontroleru) i oba su dobila test.

| # | nalaz | gde |
|---|---|---|
| S9a | Detalj robnog dokumenta prikazuje `#<id artikla>` iako backend u ovom talasu vraća `itemName/itemCode/unit`; frontend tip ih ne deklariše. Papir je popravljen, ekran nije. | `frontend/src/app/robno/detalj/page.tsx:86` |
| S9b | Lager lista nema filter po magacinu iako ga hook, ruta i PDF podržavaju; „traka primenjenih filtera" na papiru zato nikad ne imenuje magacin. | `frontend/src/app/robno/lager-panel.tsx:131`, `:168` |
| S9c | Tok „konačni račun → otpremnica" je prekinut: sa detalja fakture nema dugmeta koje pravi robni izlaz; jedini put je prepisati id iz adresne linije na `/robno` → „Iz predračuna". Bez `stockDocumentId` faktura pada u granu ručnog naloga umesto auto-robnog knjiženja. | `frontend/src/app/fakturisanje/detalj/page.tsx:924` |
| S9d | `kind='NIV'` u `createStockDocument` sada uvek pada sa 422 i porukom koja sama sebi protivreči (`is_inbound=true` u šifarniku, ali NIV nije u `INBOUND_KINDS={UL,VISAK}`); NIV uz to ima `affects_stock=false` pa je provera smera za njega besmislena. Redovni tok nivelacije nije pogođen. | `backend/src/modules/robno/robno.service.ts:69` |
| S9e | Gašenje knjiženja nivelacije (`postNivLeveling`) nije pokriveno **nijednim** testom, a dokument tvrdi da jeste — vidi §3. | `backend/src/modules/gl/posting/posting.service.ts:425-470` |

---

### 2.4 NIZAK

> **ISHOD 28.07.:** peta stavka („guard migracije `20260726110000` proverava samo tri tabele")
> **OSTAJE**. Druga stavka (redosled migracija) je **postala bezopasna**: `20260726090000` više
> ne briše bezuslovno — pada na brani pre nego što išta dodirne, a sve što briše ide u arhivu.
> Prva stavka (prazan skup primalaca = DONE) **OSTAJE**, ali je uz ispravku V7 sada ređa:
> nadzornik u stanju „prekidač isključen pre prvog uvoza" uopšte ne pokušava da šalje.
> Preostale dve (tekst na ekranu popisa, poruke motora prenosa) **OSTAJU**.

- Prazan skup primalaca u jutarnjem nadzorniku vraća **DONE** sa opisnim stringom umesto FAILED —
  „nemam kome da javim" ima isti ishod kao „nisam javio". `bigbit-mdb-jobs.ts:113-130`.
- `prisma migrate deploy` je atomičan po fajlu, ne preko paketa; `20260726090000` (najdestruktivnija)
  je **prva** u nizu, pa se njena šteta dešava pre svake kasnije potencijalne greške.
  `.github/workflows/deploy-backend.yml:153`.
- Ekran popisa piše bez dijakritika, prikazuje korisniku kod dozvole („potrebna dozvola robno.write")
  i sadrži „predpunjavaju". `frontend/src/app/robno/popis/count-detail.tsx:376`, `:387`.
- Poruke motora prenosa nose ime migracije i uputstvo za programera umesto „javite administratoru".
  `backend/src/modules/robno/transfer.service.ts:735-748`.
- Guard migracije `20260726110000` proverava samo `ledger_entries`, `accounting_scheme_lines` i
  `saldakonto_accounts`, dok `warehouses.account`, `cash_journals.account_code`,
  `document_types.analytical_account`, `popdv_account_map` i `vat_account_map` — **koje sam komentar
  nabraja** — ostaju neprovereni.

---

## 3. OBORENE TVRDNJE

> **ISHOD 28.07. po tvrdnjama** (ništa iz tabele nije brisano — ovo je samo šta je sa njima danas):
> **ISPRAVLJENO u kodu:** O1 (katalog pravila prepisan, vidi V1), O2/O3 (prozor `je.year = Y`, vidi K1),
> O9 (dugme se nudi dok ima ostatka, vidi K2), O11 → **NIJE**, vidi ispod, O13 (obe migracije su u
> ledgeru sa pravim sha256, vidi V2), O15 (brojevi preračunati danas: **146 suita / 2.683 testa**
> jest + **22 suite / 4.086 testova** e2e, sve zeleno).
> **ISPRAVLJENO u dokumentaciji:** O4 (zaglavlje migracije više ne tvrdi da je bilans zatvoren
> motorom — merenje motora je danas u §8), O16/O17/O18 ostaju netačni brojevi u `STAMPE_4.0.md`
> i zaglavljima i **treba ih preračunati pre nego što se ti dokumenti citiraju**.
> **OSTAJE (netačna tvrdnja i dalje stoji u dokumentu ili kodu):** O5, O6, O7, O8, O10, O11, O12,
> O14, O16, O17, O18, O19, O20, O21, O22, O23.
> Napomena o metodi (§7, treći obrazac): svi brojevi u §8 su izmereni **danas**, komandom koja je
> uz njih zapisana, i to nad **svežom bazom napravljenom iz migracija** (`servosync_int_dokaz`,
> `servosync_int_dokaz_d`) svuda gde je merenje smelo da zavisi od stanja zajedničkog dev-a.

**Ovo je najvažniji odeljak.** Sve što sledi je nešto što smo napisali kao gotovo, izmereno ili
provereno — a nije.

| # | tvrdnja i gde stoji | stvarno |
|---|---|---|
| **O1** | commit `9cafad5` + `PREGLED_DOKUMENATA_4.0.md`: „nova kontrolna pravila **umesto** tautologija" | **6 od 7 su i dalje tautologije** — 0401/1043/1044 su znak-za-znak prepisane seed formule, a parovi 1025/1026, 1037/1038, 1055/1056 su identiteti `clamp(x)−clamp(−x)=x`. Popravka je zamenila slučajne tautologije egzaktnim. **Tri revizora, dva nezavisna dokaza.** |
| **O2** | `ZR_ISPRAVKE_MOTORA.md` / implicitno u svim ZR dokumentima: izuzimanje zaključnog naloga je **ispravilo** bilans uspeha | **Ispravno samo za PRVU godinu u knjizi.** Sa dve zatvorene godine BU sabira obe. Dva revizora reprodukovala: 350 umesto 250; 800 umesto 300. |
| **O3** | zaglavlje migracije `20260726090000`: stari seed „`PSD01*+D01*` je brojao početno stanje DVAPUT" (implikacija: novi ne) | **Novi ga takođe broji dvaput** čim postoji PS nalog — čist `D01*` bez donje granice + PS nalog iz `year-open.service.ts:357`. Dokazano: D=170, P=60 → 110 umesto 50. |
| **O4** | zaglavlje migracije `20260726090000`: „BILANS ZATVARA: A0059 = A0456" | Provereno **aritmetički nad predatim obrascem 2023**, ne motorom. Motor nad stvarnom GK **bez** ZAK-a daje razliku 110.814.642,89; **sa** ZAK-om ostaje 0,10. Ni u jednom slučaju koji se realno može desiti na produkciji „bilans ne zatvara" nije izjava o motoru. |
| **O5** | `REMEDIJACIJA_PO_BIGBIT_STUDIJI.md` §2 (B-3): „Test u `posting.service.spec.ts` zaključava novo ponašanje" | **Taj fajl ne postoji.** `ls backend/src/modules/gl/posting/` → README.nacrt.md, expression-parser.spec.ts, expression-parser.ts, posting.module.ts, posting.service.ts, prisma-decimal-arith.ts, vat-rates.ts. `grep postNivLeveling` po svim `*.spec.ts` → 0 pogodaka. **Dva revizora.** |
| **O6** | `docs/STAMPE_4.0.md`: „Smoke `backend/scripts/smoke-grupa-b.ts`: 23/23" | Skripta kakva je komitovana daje **19 prošlo / 4 palo** — `buildPdf` se zove sa tri argumenta, a 4. (`isPrintAction`) je u ISTOM commitu dobio default `false`. Sa dodatim argumentom prolazi 23/23. **Funkcija radi, dokaz ne — broj nikad nije izmeren nad komitovanim kodom.** |
| **O7** | `PREGLED_DOKUMENATA_4.0.md`: „implicitna stopa svake knjige sada 19,9–20,0 %; ranije 6,99–20,33 %" kao **dokaz** ispravnosti | **Samopotvrđujuće.** Osnovica se izvodi kao PDV/(stopa/100), pa je implicitna stopa identički jednaka nominalnoj: 0 od 3.468 redova odstupa, po grupama tačna nula u svih 21. Broj je tačan, ali ne dokazuje ništa. |
| **O8** | `docs/STAMPE_4.0.md` §3: „Izjava o kompenzaciji · `/saldakonti` → tab Kompenzacije → tabela kompenzacija, kolona Štampa" | **Ni tabele ni kolone nema.** Jedini `DataTable` u fajlu prikazuje predlog prebijanja. Isto obara i dva komentara u kodu koji tvrde da je to rešeno (`api/saldakonti.ts:257-259`, `compensation-panel.tsx:33-35`). |
| **O9** | tekst dijaloga u `advance-dialogs.tsx`: „Isti avans se sme podeliti na više računa — dok se ne potroši ceo naplaćen iznos" | **Iz ugla korisnika netačno** — dugme koje otvara dijalog nestaje posle prve primene. Backend to ume, aplikacija ne. |
| **O10** | `docs/STAMPE_4.0.md`: trag štampe pokriva „popisnu listu u obe varijante" | Jedino dugme koje je štampa nikad ne šalje `?stampa=1`. `document_prints` za `INVENTORY_COUNT` je trajno prazna. |
| **O11** | `bigbit-mdb-import.service.ts:293-296`: nalog nestao iz BigBita se „GLASNO broji" | Rezultat je ⚠ substring u summary stringu; `bigbitStatus()` ga uopšte ne čita, ekran ga prikazuje kao neobojen podnaslov, nadzornik okida samo na `danger`. **Zvonce ne ide nikad.** |
| **O12** | `REMEDIJACIJA_PO_BIGBIT_STUDIJI.md` §1: „Posle seed-a na DEV: `saldakonto_accounts` = 9" | **10.** Deseti je 9911, vanbilansna klasa 9, `partner_scope='customer'`, `imported_drop_id=NULL`. Ulazi u aging i kreditni limit. **Tri revizora.** |
| **O13** | `REMEDIJACIJA_PO_BIGBIT_STUDIJI.md` §6: „jedina stvarno neprimenjena je `20260726090000`" | **Neprimenjena je i `20260727090000_pdv_registar_ispravka`** — baš ona iz koje potiču SVI ponovljeni PDV brojevi. Efekti obe su u bazi, ledger nijednu ne zna. Potvrđeno danas upitom nad `_prisma_migrations`. |
| **O14** | `PREGLED_DOKUMENATA_4.0.md:307`: „`transfer.service.spec.ts` (11 testova)" | **15** (`npx jest` — dva revizora nezavisno). Isti dokument na `:38` kaže 15; kontradikcija se rešava u korist 15. *Treći revizor je izbrojao 13 `it(` blokova — to je broj blokova, ne testova (postoji jedan `it.each`); njegov nalaz odbacujem.* |
| **O15** | `REMEDIJACIJA_PO_BIGBIT_STUDIJI.md:157`: „122 suite / 2315 testova: 2312 prošlo, 3 pala" | **Zastarelo.** Na HEAD-u: 141 suita / 2591 test, sve zeleno; e2e 22 suite / 4086, sve zeleno. Izveštaj ostavlja utisak da je ZR paket još crven. |
| **O16** | zaglavlje `20260726090000`: „svih 154 lista prošlo ručnu proveru strane D/P" | **124** lista (pozicija sa maskom konta: 88 BS + 36 BU). 154 se ne može izvesti ni iz jednog preseka seed-a (179 = 41 zbirna + 14 MANUAL + 124 lista). |
| **O17** | `docs/STAMPE_4.0.md:97-98`: Bilans stanja „~73 KB", Bilans uspeha „~72 KB" | **103.291 B / 105.254 B / 82.841 B.** Mereno PRE autentičnog seed-a od 179 formula i nikad preračunato, iako je seed deo istog talasa. |
| **O18** | „Kontni plan: 1.398 konta" | **1.397** (migracija 110000 briše 1329). Objašnjivo, ali svaki izvedeni broj („23 konta ne hvata nijedna maska") treba preračunati. |
| **O19** | `docs/STAMPE_4.0.md` §3 vs `kepu.service.ts:141-142` | **Dva suprotna tumačenja istog propisa u istom modulu:** dokument kaže „knjiga je vezana za JEDAN magacin (čl. 3)", docstring kaže „saldo je globalan — knjiga se vodi na nivou obveznika". Posledica je V4. |
| **O20** | zaglavlje `20260726110000`: „ponovno pokretanje je no-op" i „provereno … i na produu" da konto 1329 nema mekih referenci | SQL to **ne proverava** — guard gleda tri tabele, a pet drugih koje sam komentar nabraja ostaju neproverene. Tvrdnja o proveri postoji samo u komentaru. |
| **O21** | `new-count-dialog.tsx:11-12`: „warehouses nema lookup" | Netačno od commita `45cb94a` — `GET /v1/lookups/warehouses` i `useWarehousesLookup` postoje i koriste se. |
| **O22** | `MAPA OBIMA` §4.3: odgovor `findOne` obogaćen sa `itemName/itemCode/unit` (kao poboljšanje) | Tačno za backend, **ali obogaćivanje nema nijednog potrošača** — frontend tip polja ne deklariše, tabela i dalje renderuje `#{it.itemId}`. |
| **O23** | `ZAPISNIK` §R0: „Motor završnog računa nikad nije pokrenut nad stvarnim podacima" | Netačno u trenutku pisanja i sada: dva revizora su ga pokrenuli nad stvarnom uvezenom BigBit GK sa novim seed-om (117 + 62 linije, konkretni iznosi), a `PREGLED_DOKUMENATA_4.0.md:457` je i pre toga davao brojeve motora. |

**Odbačeno od nalaza revizora (ne stavljam u tabelu jer nije tačno):**
- Tvrdnja dva revizora da `balance_formula_definitions` na dev-u ima **32 BS + 25 BU** (stari seed) —
  odbacujem kao **trenutno stanje**. Provereno danas: **117 + 62**. Njihova merenja su bila ranija u
  toku noći, pre nego što je neko pustio seed ručno. Njihov *zaključak* (nije u ledgeru) stoji i to je
  važniji deo.
- Tvrdnja jednog revizora da `transfer.service.spec.ts` ima 13 testova — vidi O14.

---

## 4. ŠTA JE NAPADNUTO I DRŽI

Ovo je popis onoga što je neko **pokušao da obori i nije uspeo** — da se zna šta je stvarno provereno,
a ne samo napisano.

**Motor i formule**
- **179 AOP formula je strukturno zatvoreno.** Simboličkim razlaganjem: AOP 0059 i 0456 rekurzivno
  razvijeni u linearnu kombinaciju D/P atoma; za **svako** od 766 konta klase 0–4 sa prometom koeficijent
  je tačno (+1 D, −1 P) na aktivi i ogledalo na pasivi. Neispravan koeficijent ima 19 konta — sva
  sintetičke „glave" klasa i **sva sa nula prometa**.
- **Pokrivenost maski:** u opsegu BS od 792 konta nepokriveno 19 (sva bez prometa); u opsegu BU od 471
  nepokriveno 10 (sva bez prometa). „Nijedno konto sa prometom ne ispada iz obrasca" — DRŽI.
- **Nijedna referenca na nedefinisan AOP** u novom seed-u — stara zamka „zbir nepostojećih pozicija = 0
  pa pravilo lažno prolazi" se ne ponavlja.
- **Aritmetika predatog BU 2023 ručno ponovljena:** 1043 = 653.419 ✓, 1044 = 617.063 ✓, 1045 = 36.356 ✓,
  1049 = 36.158 ✓, 1055 = 34.636 ✓. Clamp **mora** biti unutar iteracije — potvrđeno (1026, 1037, 1050,
  1052 su sirovo negativni).
- **12 nasumičnih maski provereno protiv obrasca** (0005, 0045, 0046, 0047, 0402, 0404, 0451, 1015, 1019,
  1020, 1023, 1039) — sve odgovaraju.

**PDV**
- KIF/KUF 03/2026 ponovljeni **do pare, dva puta, nezavisnim SQL agregatom nad `ledger_entries`** (ne
  čitanjem sačuvanog stanja): KUF 666 stavki / 26.689.144,42 / 133.498.724,55; KIF 43 / 5.086.854,53 /
  25.434.272,65.
- **Poklapanje sa BigBit-om je do poslednje pare, ne približno:** Σ kredita na 27x konta naloga
  zatvaranja = 26.689.144,42; Σ debita na 47x = 5.086.854,53; kontrola 2790/4790 = 21.602.291,00 uz
  razliku 1,11 koja je linija 6799 (zaokruženje) iz istog naloga.
- POPDV 03/2026: 287 linija, 54 nenulte, 8а.2K1 = 142.511.726,95. PP-PDV 110 = 21.602.289,89.
- **Izbor 26 PDV konta je tačan:** sva konta koja nalog vrste PDV zaista dodiruje u 2026. jesu u
  registru; van registra ostaju samo tranzitna 2790/4790 i zaokruženja 5799/6799 — namerno.
- Ukidanje `has_base`: `grep` po celom repou nalazi samo komentare, migraciju i spec fajlove — nijedan
  proizvodni čitalac nije ostao.
- Izuzimanje tehničkog naloga vrste PDV je vezano za **konto**, ne globalno za nalog — provereno u oba
  POPDV upita i podacima.
- P1–P3 nose uslov `count > 0` („period bez prometa je legitiman"), pa `build` nad praznom produkcijom
  ne pada.
- PDV sanity upozorenja **stvarno stižu do korisnika** (`vat-ledger.service.ts:245` → `pdv.controller.ts:55`
  → `pdv/page.tsx:720-726`), sa punim srpskim rečenicama i uputstvom; `/pdv` ima izlaz iz zida („Ipak
  prikaži"), a CSV neispravnog perioda nosi oznaku **u imenu fajla**.

**Robno / štampe**
- **Prenos između magacina ne gubi zalihu:** 10 kom / 2.500,00 → A=6 (1.500) + B=4 (1.000), ukupno
  očuvano; prenos 999 odbijen 422 bez pomeranja; storno vratio A=10/B=0 i 2.500,00; drugi storno 409.
  „SVE PROŠLO".
- Smer KEPU para prenosa se ne može razići sa lagerom — `isInbound` prosleđen na sva tri poziva; stara
  jednostrana grana sačuvana za rebuild.
- Guard za `kind='PRENOS'` u `createStockDocument` i „druga vrata" (PREIZ/PREUL preko
  `documentTypeCode`) su zatvoreni; nova provera smera **ne lomi popis** (VISAR/VISAK, MANJR/MANJAK).
- `document_prints` dodeljuje redni broj pod `pg_advisory_xact_lock` u transakciji i **poništava ga kad
  render padne** — nema trke ni potrošenog broja na neuspelu štampu; `register` nikad ne baca (papir
  izlazi i kad upis traga padne, uz `copyNo=null` umesto lažnog „primerak 1").
- Lager PDF **nema tihog odsecanja** — ispisuje „NEPOTPUNO — izveštaj je odsečen na N redova (ukupno M)".
- 46 štampi prebrojano u tabelama §1–§5 (13+7+11+8+7); 12 od 13 nasumično uzetih obrazaca ima stvarno
  dugme u kodu (jedina neistinita je kompenzacija — O8). Veličine PDF-ova robnog/nabavke/SEF-a ponovljene
  u okviru zaokruženja.
- **Nivelacija bez knjiženja u GK je računovodstveno ispravna** — napadnuto i nije oboreno: ukupna
  vrednost zaliha se pri ponderisanom prosečnom preračunu ne menja, pa `valueAdjustment` ima tačno
  suprotan par; jedini pisač `stockLevelingItem` je automatski put iz kalkulacije.
- KEP obrazac: 45 redova po strani i 5 kolona po čl. 15 Pravilnika 99/2015 — pročitano iz PDF-a, sa
  izričitim objašnjenjem zašto se BigBit-ova 6. kolona ne štampa.

**Infrastruktura i deploy**
- `prisma migrate deploy` sa svih 11 novih migracija **prolazi** i na svežoj bazi i na bazi-slici
  produkcije. Nijedna ne puca zbog FK-ova ni podataka.
- **Redosled migracija je ispravan i posle spajanja sa `main`**; sudari prefiksa ne prave problem (Prisma
  poredi puno ime foldera); `main` ima 7 migracija koje grana nema i nijedna ne dira iste objekte.
- Fiksni legacy id-evi šema **ne lome sekvencu** (`setval` na kraju migracije radi).
- **Nema drift-a** između `schema.prisma` i migracija za ovaj rad.
- **Obe test-svite zelene, dva puta nezavisno:** jest 141 suita / 2591 test; e2e 22 suite / 4086 testova.
- Frontend `tsc --noEmit` bez greške, `npm run build` prolazi, **sve rute statičke, nijedna `[id]`**;
  pet prebačenih modula ima `detalj.html` i nijedan zaostali `/modul/123` u `router.push`-u.
  `readIdFromLocation` odbija „0x10"/„1e3"/„+5".
- Kontekst liste se **ne gubi** posle povratka sa detalja (`useListQueryState` + `listHref` + `popstate`).
- Otvaranje PDF-a posle `await` **ne pada na blokator prozora** — `lib/open-pdf.ts` pada nazad na
  `<a download>` i javlja korisniku.
- **Retention posao se ne sudara sa novim `ON DELETE RESTRICT` FK-ovima** — bila je realna sumnja
  („popravka popravke nad constraint-om") i ne potvrđuje se.
- Lanac svežine BigBit drop-a **pada glasno pre** grane „već uvezeno" (nepostojeći drop, `stage_status`,
  starost > 24 h, ponovljeni sha256); host skripta ima nezavisne brane (sentinel/settle, poređenje CSV
  zaglavlja, pad broja redova > 20 %, twin-sha).
- `bigbitStatus()` degradaciju **prijavljuje** kao `danger` umesto da tiho izgleda kao „sve u redu" —
  provereno praktično (`scheduled_job_runs` ne postoji na dev-u i grana se okida).
- Ključ prekidača i ključ posla dolaze iz **jednog** fajla; ranija greška „ekran gleda drugi ključ" je
  zatvorena.
- Šema kontiranja koja nedostaje **ne prolazi tiho** — `NoPostingSchemeException` + `findUniqueOrThrow`.
- Uklanjanje `implements OnModuleInit` iz `SchedulerService` **nije ubilo pokretanje** poslova.
- Frontend guard za finalizaciju ZR koristi `?? []` (pa bi nedovršena kontrola dala `anyFail=false`) —
  **nije iskoristivo**, jer backend nezavisno ponovo evaluira pravila u `finalizeStatement`.
- **Trag revizije nad ručnim nalozima:** `gl.controller.ts` nema nijednu `@Patch` ni `@Delete` rutu nad
  nalogom — proknjižen nalog se kroz aplikaciju ne može ni izmeniti ni obrisati, samo stornirati.
- Panel „Prenos u drugi magacin" na detalju: prikazuje obe strane, dugme „Otvori drugu stranu", storno sa
  razlogom, a jednostrani zatečeni prenos prikazuje kao **crvenu poruku „Prenos je nepotpun"** umesto da
  ćuti.
- Robno štampa **razdvaja** „Štampaj" (troši primerak) i „Pregled" (ne troši), sa objašnjenjem u `title`.
- `/customers` pošteno objašnjava zašto nema dugmeta „Novi komitent" i šta korisnik treba da uradi; isti
  tekst je jedan izvor istine za backend i ekran.
- BigBit uvoz, treći prolaz: `import_duration_ms = 5109` i svih 7 `stage_row_counts` ponovljeni tačno.

---

## 5. PITANJA ZA KNJIGOVOĐU

> Spremno za slanje. Svako pitanje blokira konkretnu odluku — bez odgovora se ne sme predavati.

**P1 · APR eFI (FiForma) XML — dinari ili hiljade?**
Naša štampa bilansa stanja/uspeha svodi iznose na **hiljade dinara** (obrazac po Pravilniku 89/2020 nosi
zaglavlje „у хиљадама динара"). XML koji šaljemo APR-u za **isti obračun** šalje iznose u **dinarima**
(ceo broj, bez deljenja sa 1.000) — to je doslovan port BigBit-ovog `ZRXML` modula.
- (a) Kako je BigBit do sada slao APR-u — u dinarima ili u hiljadama?
- (b) Da li je APR ikada vratio grešku ili primedbu na te iznose?
- (c) Ako je BigBit slao dinare i APR to prihvatao — potvrdite da tako i ostaje, pa da razliku samo
  dokumentujemo. Ako ne — XML se mora svesti na hiljade **pre prve predaje**.

**P2 · KEP knjiga (Pravilnik 99/2015)**
- (a) Vodi li se KEP **po magacinu / prodajnom mestu** ili **na nivou obveznika** (svi magacini zajedno)?
  Kod nam trenutno tvrdi oba: dokumentacija kaže „po prodajnom mestu (čl. 3)", a modul kaže „saldo je
  globalan — na nivou obveznika". Od odgovora zavisi koji je redni broj i saldo tačan.
- (b) Unosi li se u KEP na početku godine **stanje zaliha sa 31.12. prethodne godine kao prvi red**? Kod
  nas prva strana svake godine ima DONOS 0,00.
- (c) Obrazac KEP po čl. 15 — ima li kolonu „Stanje"? Mi štampamo **pet** kolona (r.br., datum
  evidentiranja, opis, zaduženje, razduženje); šestu BigBit-ovu smo odbacili kao „Iznos uplate na račun"
  (pred-2015 oblik). Ako je šesta kolona zapravo „Stanje", obrazac nam je nepotpun.
- (d) Sme li se redni broj u knjizi **prenumerisati** kad se naknadno unese dokument sa ranijim datumom?
  Kod nas se prenumeriše — pa dva potpisana lista iste knjige mogu da protivreče jedan drugom. Naš
  predlog je da se ispravka unosi kao **nov red**, ne prenumeracijom.

**P3 · PP-PDV pozicije 001 i 002**
Naša štampa poreske prijave ima pozicije 001 (promet oslobođen sa pravom na odbitak) i 002 (bez prava)
**trajno prazne**, jer se osnovica u sistemu izvodi iz iznosa PDV-a — pa promet koji PDV ne nosi (izvoz,
oslobođenja) ne može ući. Servoteh ima izvozni promet (BU 2023, AOP 1004 + 1007 ≈ 203 mil RSD).
- (a) Kako se te dve pozicije danas popunjavaju u BigBitu — iz kojih konta?
- (b) Do tada: sme li papir da izađe sa oznakom „NIJE ZA PREDAJU", ili ga potpuno gasimo?

**P4 · Trinaest neuravnoteženih naloga u BigBit-ovoj glavnoj knjizi**
U uvezenoj GK za 2026. postoji 13 naloga kod kojih Σduguje ≠ Σpotražuje, neto razlika **0,10 RSD**
(najveći pojedinačni: `AVANS 0011`, razlika 0,09). Zbog toga bilansna ravnoteža ne prolazi ni sa
zaključnim nalogom.
- (a) Je li to poznato/prihvaćeno zaokruženje u BigBitu, ili greška koju treba ispraviti u izvoru?
- (b) Koju toleranciju smemo da postavimo da finalizacija prolazi, a da se stvarna greška i dalje vidi?

**P5 · AOP 1054 i konto 723**
AOP 1054 je kod nas MANUAL (trajna nula), a komentar uz seed kaže da Servotehov konto **723** verovatno
tu pripada. Pripada li? Ako da, neto dobitak (AOP 1055) nam je za toliko previsok, a kontrolno pravilo to
**ne može da uhvati** jer koristi istu nulu na obe strane.

**P6 · Konto 9911 u saldakontima**
Vanbilansno konto 9911 („Dobit po osnovu prodaje materijala", klasa 9) upisano je u registar saldakonta
kao **potraživanje od kupca**, pa od sada ulazi u starenje potraživanja i u obračun kreditnog limita
kupca. Je li to namerno? Naša pretpostavka je da nije i da ga treba izbaciti.

---

## 6. PITANJA ZA VLASNIKA (odluke, ne struka)

**V1 · Da li završni račun ide na produkciju u ovom talasu?**
Preporuka: **NE.** Motor od druge godine daje pogrešne brojeve (K1), kontrole to ne mogu uhvatiti (V1), a
APR XML i papir se razlikuju za faktor 1.000 dok P1 ne bude odgovoreno. Ostatak paketa (robno, štampe,
PDV, `?id=N`) može ići odvojeno. **Šta odlučujemo?**

**V2 · Da li noćni BigBit uvoz sme da pogodi produkcijsku glavnu knjigu?**
Danas je prekidač seedovan **uključen**, a skripte za poništavanje uvoza **nema**. Prva uspešna noć upisuje
~1.100 naloga i ~20.000 stavki u knjigu koja je danas prazna, i to nepovratno. Preporuka: prekidač na
`FALSE` u seedu, skripta za poništavanje napisana i testirana, pa tek onda uključivanje ručno.

**V3 · Ko dobija zvonce kad uvoz padne, i koliko dugo?**
Sa današnjim podešavanjima svaki administrator dobija po jednu poruku **svakog dana, zauvek**, sve dok
korak 1 ne bude instaliran na hostu. Hoćemo li: (a) prekidač isključen dok se ne instalira, (b) alarm
ćuti dok kanal nikad nije proradio, ili (c) ostaje kako jeste?

**V4 · Tri funkcije su plaćene a nedostupne — kada se dovršavaju?**
N:M avansi (K2), spisak kompenzacija (V9), KEP po magacinu (V4). Sve tri imaju gotov backend i nedostaje
im samo ulaz iz ekrana. Uz njih ide i **šifarnik/pretraga artikala** (V10) — bez njega magacioner ne može
da unese ni prenos ni prijem robe, jer se od njega traži interni bazni broj artikla.

**V5 · Ko presuđuje sporne računovodstvene odluke i u kom roku?**
Šest pitanja u §5 blokiraju predaju obrazaca. Nesa ili spoljni knjigovođa? Ako se ne odgovori, obrasci se
mogu štampati ali se **ne smeju predavati**, i to mora biti vidljivo na papiru.

---

## 7. METODOLOŠKA NAPOMENA — zašto je ovo promaklo

Tri obrasca se ponavljaju kroz ceo paket i vredi ih zapisati, jer nisu vezani za konkretan modul:

1. **Popravka koja je rešila simptom a razbila drugu stranu.** Izuzimanje zaključnog naloga (K1) je treći
   put da se ista linija menja i treći put da popravka razbije nešto drugo. Uzrok je što je svaki put
   menjan **filter**, a nikad korenski nedostatak — `aggregate()` nema pojam o **periodu**.

2. **Dokaz koji potvrđuje sam sebe.** Kontrolna pravila ZR-a (V1) i P5 u PDV-u (S2) su oba oblika
   „izračunaj X iz Y, pa proveri da li X odgovara Y". Oba su u dokumentaciji navedena kao **dokaz
   ispravnosti**. Kontrola koja ne može pasti je opasnija od kontrole koje nema, jer proizvodi zelenu
   značku.

3. **Brojevi izmereni jednom, pa prepisivani.** Šest brojeva u dokumentima (O6, O12, O14, O15, O16, O17)
   nikad nisu ponovljeni posle izmena koje su ih promenile. Predlog: svaki broj u dokumentaciji nosi
   **komandu kojom je dobijen**, pa ga svako može ponoviti u jednom redu.

Dodatno, oba merenja koja su se **razišla između revizora** (`balance_formula_definitions` 32+25 vs
117+62) razišla su se zato što je **paralelna sesija menjala dev bazu tokom revizije**. Dev baza nije
stabilna podloga za dokaz. Preporuka: merenja koja ulaze u dokument rade se nad **svežom bazom napravljenom
iz migracija**, ne nad zajedničkim dev-om.

---

# 8. INTEGRACIJA I PRESUDA O DEPLOY-U (28.07.2026)

**Ovo je dopuna, ne prepis.** Ništa iznad nije obrisano; uz svaki nalaz stoji ishod
(ISPRAVLJENO / ODBAČENO sa razlogom / OSTAJE). Ovaj odeljak dodaje ono što prvi pregled
nije mogao da zna: **šta je drugi krug našao u samim ispravkama** i **šta sme na produkciju**.

## 8.1 Drugi krug je našao 4 nova defekta U ISPRAVKAMA — svi zatvoreni

Ispravke iz prvog kruga su same unele nove kvarove. To je četvrti primer obrasca iz §7.1
(„popravka koja je rešila simptom a razbila drugu stranu") i vredi ga zapisati:

| # | šta je nova ispravka pokvarila | posledica da je otišlo na prod | zatvoreno |
|---|---|---|---|
| N1 | `NEPRIMENLJIVO` → `passed = true` | ŠTAMPAN I POTPISAN obrazac sa zelenim „PROLAZI" iznad aktive 2.351.185 i pasive 2.240.370 (u hiljadama). Pre paketa je taj red bio CRVEN. | `passed = (status === "PROLAZI")`; papir i ekran prikazuju 4 ishoda |
| N2 | `GK_VAN_OBRASCA` broji poreska konta 721/722 | Knjigovođa proknjiži porez na dobit → 2 BLOKIRAJUĆA pravila padaju na ISPRAVNOM obrascu, i to sa praznom listom konta; jedini izlaz je `force` | poreska konta izuzeta i iz salda i iz ZAK kontra-stavki |
| N3 | brana zaključanih poredi kolonu `status` | 4.0 zaključa period → **100 % naloga tog perioda** svake noći „odbijena izmena" i TRAJNO van upsert-a; stvarna izmena se gubi u buci | status se ne poredi i ne preuzima; `applyBigbitLocks` na kraju uvoza |
| N4 | ekran šalje `force=true` na svaku finalizaciju | Trajan trag „svesnog gaženja kontrola" za rutinski klik; kad jednom stvarno padne pravilo, navika ga progura | ekran blokira samo na `blocking && status ∈ {PADA, NEPRIMENLJIVO}` i traži OBRAZLOŽENJE |

Uz to su zatvorena tri manja: prekoračenje avansa kroz legacy vezu (unija umesto „ili-ili"),
ulazni avans se nije mogao platiti iz aplikacije (DTO tražio `number`, ekran slao string),
i jutarnji nadzornik je u stanju „prekidač isključen" gutao i „poslednji uvoz je PAO".

## 8.2 Šta više ne može da prođe nezapaženo (mutacioni test)

Prvi krug je pokazao da nekoliko ključnih ponašanja **nema nijedan test** — mutacija ih ne obara.
Danas imaju:

- `finalizeStatement` — nov `balance-sheet.finalize.spec.ts` (8 testova): upozorenje ne blokira,
  `PADA` blokira, blokirajuće `NEPRIMENLJIVO` blokira, trag se upisuje u istoj transakciji sa
  ko/kada/šta/zašto, `force` bez blokirajućeg pada NE upisuje trag, CAS trka baca Conflict.
- prosleđivanje `amount` u `apply-advance` — nov `sales.controller.spec.ts` (4 testa).
- pretpostavke u SIROVOM SQL-u kontrolnih pravila (izuzimanje ZAK kontra-stavki, filter
  prenosnih 599/699, prozor `je.year`) — test tvrdi šta u SQL-u MORA da stoji, jer lažni Prisma
  telo upita nikad ne izvršava.
- brana zaključanih naloga — `scripts/smoke-uvoz-zakljucani.ts` vozi PRAVI uvoz nad pravom bazom
  kroz tri scenarija koja su u drugom krugu bila slomljena.
- ulazni avansni DTO — `advance-vat.dto.spec.ts` (7 testova).

## 8.3 Puna verifikacija (sve mereno 28.07., komanda je uz broj)

| provera | komanda | rezultat |
|---|---|---|
| tipovi (backend) | `npx tsc --noEmit` | čisto (0 grešaka u `src/`) |
| jest (backend) | `npx jest --silent` | **146 suita / 2.683 testa, sve zeleno** (pre paketa 141/2591; pri prvom pregledu 143/2644 sa **1 crvenim**) |
| jest e2e | `npx jest --config ./test/jest-e2e.json` | **22 suite / 4.086 testova, sve zeleno** |
| build + boot | `npx nest build` pa `node dist/main` | „Nest application successfully started" |
| tipovi (frontend) | `npx tsc --noEmit` | čisto |
| build (frontend) | `npx next build` | 93/93 statičke strane, **nijedna `[id]` ruta** |
| migracije, sveža baza | `prisma migrate deploy` + `migrate status` nad `servosync_int_dokaz` | „All migrations have been successfully applied" / „Database schema is up to date!" — **nijedno „not applied", nijedno „modified"** |
| migracije, dev baza | `migrate status` nad `servosync` | 14/14 današnjih migracija sa TAČNIM sha256; 21 STARIJA (20260720–20260725, tuđe oblasti) je i dalje „not applied" jer dev nikad nije bio pun klon — **to se namerno ne „popravlja" lažiranjem ledgera** |
| kontrole ZR nad stvarnom knjigom | `scripts/smoke-zr-kontrole.ts 2026` | **10 prošlo / 0 palo**; 169/169 i 95/95 konta pokriveno; Δ=0,0000 na sva tri ukrsna pravila |
| N:M avansi kroz rute | `scripts/smoke-avansi-nm.ts` | **14 OK / 0 FAIL** |
| brane uvoza | `scripts/smoke-stavka-d.ts` | **17 OK / 0 FAIL** |
| brana zaključanih, drugi krug | `scripts/smoke-uvoz-zakljucani.ts` | **18 OK / 0 FAIL** |
| brana + oporavak migracije | ručno nad `servosync_int_dokaz` | brana opali (P3018 + srpska poruka) → 3 koraka iz poruke → deploy prolazi; arhiva 117 linija **uz `finalized_at`** |

## 8.4 PRESUDA PO CELINAMA

Presuda je namerno konzervativna: prvi pregled je već jednom rekao „ne sme u celini" i bio u pravu,
a drugi krug je našao da su i same ispravke unele četiri nova defekta.

### ✅ SME NA PRODUKCIJU SADA

**1. Registri i knjiženje (PDV registar, saldakonta, kontni plan, GL).**
Brojevi su ponovljeni do pare protiv BigBit-ovog naloga zatvaranja, obe migracije su u ledgeru sa
pravim sha256 i imaju brane nad predatim obrascem/prijavom, a sve što brišu ide u arhivu.
*Uslov pre merge-a:* pustiti dva upita iz zaglavlja migracija nad PRODUKCIJSKOM bazom
(`financial_statements` van DRAFT-a; `vat_returns` van DRAFT/CALCULATED). Ako oba vrate prazno,
deploy prolazi bez ijedne ručne radnje. Ako ne — deploy će NAMERNO pasti, i tada važi tročlani
postupak iz poruke (**drugi korak, `migrate resolve --rolled-back`, se ne sme preskočiti**).

**2. Robno, prenos između magacina, štampe robnih dokumenata.**
Napadnuto i nije oboreno (§4). Prenos ne gubi zalihu, trag štampe ne troši broj na neuspelu štampu.

**3. Motor završnog računa + kontrolna pravila — ZA RAČUNANJE I PROVERU, ne za predaju.**
K1 je zatvoren (prozor jedne fiskalne godine), tautologije su obrisane, kontrole sada stvarno padaju
kad je formula pogrešna, a forsiranje ostavlja trajan trag.

### ⚠️ SME UZ USLOV

**4. Noćni BigBit uvoz — SME DA SE DEPLOYUJE, NE SME DA SE UKLJUČI.**
Prekidač je posejan `FALSE` i to je ispravno stanje za isporuku. Pre nego što se prvi put UKLJUČI
(ručno i danju), moraju biti zatvorena dva otvorena nalaza koja uvoz čine tihim:
- **S1** — uvoz ubacuje saldakonto konta bez `partner_scope`, pa kreditni limit i aging tiho
  promašuju novo analitičko konto kupca;
- **S7** — nalog nestao iz BigBita se ne prijavljuje nigde gde ga čovek vidi.
Uz njih: `bb_import_rejected_changes` nema ekran, pa se odbijene izmene vide samo kroz SQL.
*Prva noć nije nepovratna:* `bigbit-mdb-unimport.ts` postoji i testiran je.

**5. Frontend — SME. ~~ALI NE SA ZATEČENIM `dialog.tsx`~~ → USLOV ISPUNJEN 28.07.**
V11 je bila regresija koju unosi ovaj paket (`f80fd13`): Esc u dijalogu gasi ceo lanac obrađivača, pa
se tok „Reversi → Brzi povraćaj → skeniranje" prekida. **Popravljeno stekom slojeva
(`ui-kit/escape-layer.ts`) i dokazano u pravom Chromium-u** — `frontend/scripts/escape-layer.proof.mjs`,
6/6 provera 🟢, STARO `["DIALOG","INNER"]` → NOVO `["INNER"]`. Detalji uz nalaz V11 gore.
Provereno uz to: FE `tsc` čisto, `next build` 93/93 statičkih strana, nijedna `[id]` ruta.

### ⛔ NE SME NA PRODUKCIJU

**6. Predaja obrazaca APR-u — `exportFiForma` (APR eFI XML).**
V3 stoji nedirnut: XML u dinarima, papir u hiljadama, razlika 1.000×. Dok P1 nema odgovor, fajl se
ne sme predati. Preporuka: iza dugmeta postaviti eksplicitnu potvrdu jedinice.

**7. KEP knjiga kao zakonska evidencija.**
V4 + V5 + O19: ekran i papir mogu dati različit redni broj i saldo, redni broj se prenumeriše, nema
početnog stanja godine, a modul i dokumentacija tvrde dva suprotna tumačenja istog propisa. Dok P2
nema odgovor, KEP se sme gledati ali ne i voditi kao knjiga.

**8. Štampa PP-PDV prijave kao dokumenta za predaju.**
S5: pozicije 001 i 002 su tvrdo prazne, a Servoteh ima izvozni promet. Papir mora nositi vidljivu
oznaku „NIJE ZA PREDAJU" ili se gasi dok P3 nema odgovor.

**9. Dnevnik knjiženja za celu godinu (PDF).**
V13: kapa 20.000 stavki, a knjiga za 2026. ih ima preko 20.400 — nijedan izbor godine neće proći.
Dugme vodi u sigurnu grešku.

**10. Robni unos za magacionera.**
V10: bez šifarnika/pretrage artikala se prenos i prijem ne mogu uneti, jer se od korisnika traži
interni bazni broj artikla.

### Šta ostaje kao dug, a ne blokira

V9 (spisak kompenzacija), V12 (Podaci firme vs sync), S2 (P5 je identitet — ista klasa kao V1, ali u
PDV modulu), S8 (trag štampe popisne liste), S9a–S9e i sve iz §2.4.
