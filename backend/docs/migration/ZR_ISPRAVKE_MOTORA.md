# Završni račun — TAČNE izmene motora pre seed-a autentičnih formula

**Datum:** 2026-07-26
**Kontekst:** [`ZR_AOP_FORMULE_AUTENTICNE.md`](ZR_AOP_FORMULE_AUTENTICNE.md) — 179 novih AOP formula
**Ovaj dokument NE menja kod** — samo tačno opisuje šta treba promeniti, u kom fajlu i na kojoj liniji.

Bez izmena §1 i §3 novi seed daje **pogrešan** bilans i **blokira finalizaciju**.
Bez izmene §2 bilans uspeha je **sav u nulama** za svaku godinu za koju je urađen prenos u novu godinu.

---

## 1. CLAMP ≥ 0 — OBAVEZNO (bloker)

### Zašto

BigBit klampuje **svaki** upis u `ZR_Stavke.Iznos_n` — svih 8 UPDATE upita
(`ZR_UpisiVrednostiIzBrutoStanjaUZRStavke_Iznos_{1,2,3}_{Zaokruzeno,Nezaokruzeno}` i
`ZR_UpisiVrednostiuIzAOPUZRStavke_Iznos_{1,2,3}`) ima `IIf(VrednostIzraza(...)>0, VrednostIzraza(...), 0)`.
Naš motor **nema clamp nigde**.

Dokaz na predatim brojkama (nije pretpostavka):

| Pozicija | Sirov izraz | Obrazac piše |
|---|---|---|
| BS 0455 (2023) | 48.570+718+0+651.176−868.293 = **−167.829** | **0** (`bs.txt:475`) |
| BS 0455 (kol. 7) | **−106.670** | **0** |
| BU 1026 (2023) | 610.276−630.409 = **−20.133** | **0** (`bu.txt:88`) |
| BU 1037 (2023) | 1.482−4.578 = **−3.096** | **0** (`bu.txt:118`) |
| BU 1050 (2023) | **−36.158** | **0** (`bu.txt:168`) |
| BU 1052/1053 (LISTOVI, maska 722) | −494 / +494 | **0 / 494** (`bu.txt:175,177`) |

Bez clampa: `A0456` = **1.036.122** umesto 868.293; `A1055` = **143.604** umesto 34.636.

### Gde tačno

**Fajl:** `backend/src/modules/zavrsni/balance-sheet.service.ts`

**(a) UNUTAR iterativne petlje** — linije **262–278**, tačno između `evalFormula` (267) i
`aopValues.set` (272). Clamp **mora** biti u iteraciji, ne na kraju, jer `A<aop>` čita **već
klampovanu** vrednost (BigBit: `ZRVrednostClanaIzrazaTG` radi `DSum("[Iznos_1]", "ZR_Stavke_TG", …)`).
Primer koji to dokazuje: `A1055 = A1049−A1050−…` koristi `A1050 = 0`; bez međuklampa (`A1050 = −36.158`)
1055 izlazi 70.794 umesto 34.636.

```
267:  const next = await this.gkEval.evalFormula(def.formula, asOf, resolveAop);
      // ← OVDE: const clamped = next.isNegative() ? new D(0) : next;
      //          (ako je next < 0 → zabeleži def.aop + next u `clampedAops` listu)
272:  aopValues.set(def.aop, next);      // ← upisati `clamped`
```

**(b) PRI EMISIJI linija** — linije **285–293**, `amount: aopValues.get(def.aop)`. Ako je (a) urađeno,
ovde je vrednost već klampovana; svejedno je bezbedno ponoviti.

**(c) Kolone 2 i 3** — linije **289–290** čitaju `prevYearAmounts`/`prevPrevYearAmounts`, tj. već
sačuvane (klampovane) iznose ranijih obračuna. **Nema šta da se menja** — BigBit isto radi
(`ZR_UpisiuPGizZR.sql` prepisuje `Iznos_2 := ZR_Stavke_PG.Iznos_1`).

### Obavezan dodatak: `clampedFrom` log

Uz univerzalni clamp, **okrenut smer D/P postaje nerazlučiv od legitimne nule** (`gkeval.service.ts:390`
vraća `COALESCE(SUM(...),0)` i za masku bez pogotka). Zato:

- skupljati listu `{ aop, rawValue }` za svaku poziciju gde je sirova vrednost bila `< 0`
- vratiti je u `StatementResult` (npr. `clamped: [{aop, raw}]`) i prikazati u odgovoru rute
- **ne** je pisati u bazu ako se ne želi migracija šeme; dovoljno je u response-u + `Logger.warn`

Bez ovoga se svaka greška u smeru tiho guta — od 117 BS pozicija njih 60+ je u predatom 2023
legitimno 0.

---

## 2. SEMANTIKA `D`/`P` — jedina promena je izuzimanje `ZAK` naloga

### Šta se NE menja

**`D`/`P` ostaju kumulativni (`posting_date <= asOf`, bez donje granice) i NASTAVLJAJU da uključuju
`PS` naloge.** To je **ispravno** i mora tako ostati:

- Bilans stanja je **stanje na dan** — kumulativ je definicija.
- `PS` nalog nije duplikat: `year-open.service.ts` prenosi saldo klasa 0–4 u novu godinu, ali se
  prethodna godina posle toga više ne knjiži; `D`/`P` kumulativno daju tačno stanje.
- **Zato se `PSD`/`PSP` NE koriste ni u jednoj od 179 novih formula.** Stari seed je pisao
  `PSD01*+D01*` — to broji početno stanje **dvaput**, jer `ZR_BrutoStanje.Duguje` = `UkPrometDuguje`
  (PS uključen), a `PSDuguje` je njegov **podskup** (`APGK_BrutoStanje.sql`).

Predlog „dodati donju granicu `posting_date >= 01.01.` i vratiti PSD/PSP u formule" je **odbačen** —
pokvario bi bilans stanja, a bilans uspeha ne bi popravio (razlog u nastavku).

### Šta se MENJA — bloker za bilans uspeha

**Problem:** `backend/src/modules/gl/year-open.service.ts`, linije **231–254** (`closeIncomeStatement`)
knjiži kontra-stavku **NAZAD NA ISTO KONTO** klase 5/6:

```ts
231:  for (const b of balances) {
232:    if (b.accountClass !== 5 && b.accountClass !== 6) continue;
237:    closingLines.push({ accountCode: b.accountCode, debit: ZERO, credit: b.net, … });
247:    closingLines.push({ accountCode: b.accountCode, debit: amt,  credit: ZERO, … });
```

- vrsta naloga: `CLOSING_ORDER_TYPE = "ZAK"` (linija **41**)
- datum: `closingDate = new Date(Date.UTC(fromYear, 11, 31))` (linija **113**) → **31.12., unutar godine**
- status: `POSTED` (`posting/posting.service.ts`)

`gkeval.service.ts` (linije **389–399**) nema filter po vrsti naloga za `D`/`P`, pa uračunava i `ZAK`.
**Posledica: `P602*-D602*` = egzaktna 0** — svaka BU maska daje nulu za godinu za koju je urađen prenos.

⚠️ Donja granica datuma (`posting_date >= 01.01.`) ovo **ne rešava**, jer je `ZAK` datiran 31.12.

### Fix

**Fajl:** `backend/src/modules/zavrsni/gkeval.service.ts`, metoda `aggregate()`, linije **378–402**.

Dodati konstantu uz `PS_ORDER_TYPE_PREFIX` (linija **48**):

```ts
/** Vrsta zaključnog naloga (zatvaranje klasa 5/6) — mora se isključiti iz D/P,
 *  inače bilans uspeha izlazi u nulama (year-open.service.ts:231-254). */
const CLOSING_ORDER_TYPE = "ZAK";
```

i u `WHERE` (linije **393–398**) dodati, za `kind === "D" || kind === "P"`:

```sql
AND (je.order_type_code IS NULL OR je.order_type_code <> 'ZAK')
```

**Zašto isključivanje, a ne period:** `ZAK` je tehnički nalog zatvaranja, ne poslovni promet. Isključen
je iz **oba** obrasca — u bilansu stanja `ZAK` dodiruje samo konto rezultata (klasa 3), a taj iznos u
BS ionako dolazi kroz `PS` nalog naredne godine (AOP 0410 = `P341*-D341*` = 34.636 = `A1055`, potvrđeno
`bs.txt:303` vs `bu.txt:183`).

**Test posle izmene:** `AOP 1003 = P600*+P602*+P604*-D600*-D602*-D604*` na 31.12.2023 mora dati
**178.421**. Ako izađe 0 → `ZAK` još uvek ulazi.

### Sporedno (nije bloker)

`gkeval.service.ts:386` koristi `LIKE 'PS%'` umesto `= 'PS'` — hvatao bi i izmišljene vrste `PSX`.
Pošto se `PSD`/`PSP` u novim formulama uopšte ne koriste, ovo nema efekta; popraviti kad se bude
diralo isto mesto.

---

## 3. KONTROLNA PRAVILA — obavezno u ISTOM commitu (bloker)

**Fajl:** `backend/src/modules/zavrsni/control-rules.service.ts`

### Šta puca

| Linija | Pravilo danas | Sa novim seed-om |
|---|---|---|
| **73–74** | `0001 == 0401` | `0001` = „Uписани а неуплаћени капитал" = **0**; `0401` = „КАПИТАЛ" = **167.829** → **TVRDI FAIL**, `finalizeStatement` (`balance-sheet.service.ts:426-467`) odbija DRAFT→FINALIZED bez `force:true` |
| **79–80** | `1068 == 1064 − 1066` | AOP 1064/1066/1068 **ne postoje** u obrascu 89/2020; `sumTerms` (linija **147**) vraća 0 za nepostojeći AOP → `0 == 0` → **LAŽNO PROLAZI**. Najopasnija tiha regresija. |
| **85–86** | `1025 == 1001 − 1010` | Novi `1010` = „Смањење вредности залиха" (0), a ne „poslovni rashodi" → `20.133` vs `630.409` → **TVRDI FAIL** |

### Zamena

Zameniti niz `CONTROL_RULES` (linije **69–88**) sa:

| Naziv | Obrazac | Levo | Desno | Regresija 2023 / 2022 |
|---|---|---|---|---|
| Bilansna ravnoteža: aktiva = pasiva | BS | `0059` | `0456` | 868.293 / 638.633 |
| Kapital = zbir komponenti | BS | `0401` | `0402+0403+0404+0405+0406−0407+0408+0411−0412` | 167.829 / 141.428 |
| Ukupni prihodi = zbir grupa | BU | `1043` | `1001+1027+1039+1041` | 653.419 / 422.440 |
| Ukupni rashodi = zbir grupa | BU | `1044` | `1013+1032+1040+1042` | 617.063 / 376.763 |
| Poslovni dobitak = prihodi − rashodi | BU | `1025` | `1001−1013` | 20.133 / 38.389 |
| Gubitak iz finansiranja = fin. rashodi − fin. prihodi | BU | `1038` | `1032−1027` | 3.096 / 3.806 |
| Neto dobitak | BU | `1055` | `1049−1050−1051−1052+1053−1054` | 34.636 / 41.817 |

⚠️ **Pravila 5, 6 i 7 rade nad klampovanim vrednostima** — leva strana je klampovana, desna se sabira
iz klampovanih AOP-a, pa jednakost važi samo kad je rezultat ≥ 0. Kad firma pravi gubitak,
`1025 == 1001 − 1013` daje `0 == −X` i pravilo pada iako je bilans tačan. **Rešenje:** ili pravilu
dodati `clampRight: true` (poređenje `left == max(0, right)`), ili ta tri pravila napisati kao parove
(`1025 − 1026 == 1001 − 1013`, `1049 − 1050 == 1045 − 1046 + 1047 − 1048`,
`1055 − 1056 == 1049 − 1050 − 1051 − 1052 + 1053 − 1054`) — **parovi su preporučeni**, jer važe u oba smera.

### Doc-komentar

Linije **14–17** i **62–68** tvrde `BS: UKUPNA AKTIVA = 0001, UKUPNA PASIVA = 0401` i
`BU: NETO DOBITAK = 1068…` — obrisati, zameniti novim oznakama i referencom na
`ZR_AOP_FORMULE_AUTENTICNE.md`.

---

## 4. Kontrola pokrivenosti konta (preporučeno, ne bloker)

23 konta iz kontnog plana ne hvata nijedna od 179 maski (`ZR_AOP_FORMULE_AUTENTICNE.md` §7 R2).
Ako ijedno nosi saldo, `A0059 ≠ A0456` bez ikakvog objašnjenja u UI-ju.

**Predlog:** u `balance-sheet.service.ts`, posle iterativne petlje (linija **278**), dodati proveru
koja poredi `Σ` klampovanih listova sa `grossTrialBalance(asOf)` (`gkeval.service.ts:290-333`) i
vraća listu konta bez pokrivenosti. Alternativa bez koda: SQL upit u `backend/scripts/`.

---

## 5. Testovi koji se moraju ažurirati / napisati

### Postojeći testovi koji padaju

**Nijedan.** Provereno: `Grep GkEval|BalanceSheetService|balanceFormulaDefinition|financialStatement|AprXml|ControlRules`
po 119 `*.spec.ts` i 24 e2e fajla → **0 pogodaka**. Modul završnog računa ima **0 testova**.

To znači da promena semantike `D`/`P`, dodavanje clampa i prepisivanje seed-a **ne obaraju ništa** —
i zato su regresije nevidljive dok se ne napišu novi testovi.

### Novi testovi (obavezni pre proglašenja gotovim)

**T1 — `gkeval.service.spec.ts` (unit, bez baze):** parser.
Pokriti: levu asocijativnost (`A-B-C == (A-B)-C`), unarni minus, zagrade, `PSD`/`PSP`/`AB`/`AC`
prefikse, `GkEvalError` za nepoznat prefiks i za praznu formulu.
**Ključni slučaj:** `A1049-A1050-A1051-A1052+A1053-A1054` sa vrednostima
`36158, 0, 2016, 0, 494, 0` mora dati **34.636** (BigBit-ov desno-rekurzivni parser bi dao 38.668).

**T2 — `balance-sheet.service.spec.ts` (unit, mock Prisma):** clamp.
Formula koja daje `−100` mora upisati `0`; `A<aop>` referenca na nju mora videti `0`, ne `−100`
(dokazuje da je clamp **unutar** iteracije).

**T3 — regresija nad predatim obrascem 2023 (e2e, test-baza).** *Traži bruto stanje 31.12.2023 iz
BigBit-a — trenutno NEDOSTUPNO.* Kad bude:
1. učitaj bruto stanje kao jedan `PS` nalog;
2. `computeStatement(BALANCE_SHEET, 2023)` → tvrdi `0059 == 0456 == 868.293`;
3. kotve: `0011=107.552`, `0032=132.729`, `0034=186.795`, `0057=138.272`, `0441=553.857`,
   `0445=78.303`, `0410=34.636`, `0429=718`, `0039=97.762`, `0041=0`;
4. `computeStatement(INCOME_STATEMENT, 2023)` → `1055 == 34.636`, `1043 == 653.419`,
   `1044 == 617.063`, `1003 == 178.421`;
5. 2022: `0059 == 638.633`, `1055 == 41.817`.

**T4 — `control-rules.service.spec.ts`:** svih 7 novih pravila prolazi na fixture-u iz T3, i pada
kad se jedna pozicija namerno pomeri za 1 din.

**T5 — pokrivenost konta:** za svaki konto iz `accounts` sa prometom, bar jedna maska mora ga hvatati.
Danas bi pao na 23 konta (§4) — pokrenuti ga kao **izveštaj**, ne kao crveni test, dok se ta konta
ne razreše sa knjigovođom.

---

## 6. Redosled izvođenja

1. `20260726090000_seed_balance_formulas_autenticne` (migracija — već napisana)
2. §3 kontrolna pravila **u istom commitu** (inače finalizacija tvrdo pada)
3. §1 clamp + `clampedFrom` log
4. §2 isključivanje `ZAK` naloga
5. T1, T2, T4 (mogu odmah — ne traže bruto stanje)
6. §4 kontrola pokrivenosti → lista za knjigovođu
7. T3 kad bruto stanje 2023 bude izvezeno iz BigBit-a → tek tada se sme reći „bilans je tačan"
