# Glavna knjiga (GL) — dubinska analiza modula

> **Status:** ANALIZA (2026-07-18, iz dumpovanih rule-tabela + VBA + GL upita). Operativna dopuna
> [18](18-gl-pdv-kontiranje-rekonstrukcija.md) (posting mehanizam broadly) — ovde konkretna konta,
> smerovi knjiženja, saldakonti, izveštaji, životni ciklus naloga.

> ⚠️ **ISPRAVKA PREMISE (iz stvarnog `Kontni plan.csv`):** u OVOM kontnom planu **`220` NIJE „kupci"** —
> `220 = Potraživanja za kamatu i dividende` (csv:261), i **ne knjiži ga nijedna auto-šema** (samo ručni
> nalog). **Kupci su klasa 20:** `202/2020/2040 Kupci u zemlji`, `2050 Kupci u inostranstvu`.
> **`4350 = DOBAVLJAČI U ZEMLJI` je tačno** (csv:596). Dalje se kupac obrađuje na stvarnim konfor 202x.

## A) Kontni plan

DDL `Kontni plan` (schema:442): `Konto Text(10)`, `Opis`, `Dugacki opis`, `Plan duguje/potrazuje`,
**`Dozvoljen unos analitike`**, **`Fajl sifara`** (koji šifarnik puni analitiku, npr. `4331→KUPDOB`), `InoKonto`.
- **1389 konta**, srpski okvir, klase 0–9, hijerarhija po dužini šifre (2=grupa, 3=sintetika, 4–5=analitika;
  npr. `435` sint. / `4350` anal., isti Opis „DOBAVLJAČI U ZEMLJI").
- **Saldakonto filter NIJE `Dozvoljen unos analitike`** (svuda True) nego posebna tabela
  **`PSF_AnalitickaKonta_T`** (schema:2610): `Konto, DinSaldo, DevSaldo, OTST` — koja konta drže
  din/dev saldo i **otvorene stavke**.

| Konto | Opis |
|---|---|
| 202/2020/2040/2050 | **Kupci** u zemlji / inostranstvu |
| 220/2200/2201/2202 | Potraživanja za kamatu i dividende (**ne kupci**) |
| 2700/2710 | PDV u primljenim fakturama 20%/10% |
| 435/4350/4351/4360 | **Dobavljači** (sint./zemlja/fiz.lica/inostranstvo) |
| 4700/4710 | PDV po izdatim fakturama 20%/10% |
| 1010/1320/1200 | Materijal / Roba u prometu VP / Gotovi proizvodi |
| 6040/6121 | Prihodi od prodaje robe/proizvoda |

## B) Mehanizam knjiženja (kako šema postaje nalog)

`R_Vrste dokumenata` (`Sema za kontiranje`→IDSeme) → `Sema za kontiranje` (IDSeme→vrsta naloga) →
`Stavke seme za kontiranje` (konto + **`DefDug`/`DefPot`** formula slova A–Z) → **evaluator `VredIzraza`**
(`Module__SemaZaKontiranje.txt:3-52`: slovo→vrednost, VBA `Eval`).

**Mapiranje slova → kolone dokumenta** (autoritativno iz `SKStavkeZaKnjizenjeAnalitika1Korak.sql`):
`A=NabNetoVred, B=ZTS, C=ZTD, D=PPDOsn(PDV20 osn), E=PPDZel(PDV10), … O=StvarnaVP, P/Q=PDV po stopama, X/Y/Z=avans`.
⚠️ Komentari A–K u VBA su STARIJI šablon — pri portovanju koristiti mapiranje iz upita, ne iz komentara.

Lanac proknjiženja: `SKStavkeZaKnjizenjeAnalitika1Korak` (Dug/Pot = `VredIzraza(DefDug/DefPot)`,
analitika=`Sifra komitenta`) → `…2Korak` (GROUP BY konto+komitent+dok, `Sum`, odbaci nula-redove) →
`SKProknjiziStavkeNalogaIzRobnog` (INSERT u GK) + `SKProknjiziZaglavljaNaloga…` (kreira nalog „AUTO-ROBA").
Analogno `SK_MP*` (maloprodaja), `USL_*` (usluge).

## B2) Kupac (potraživanje) — knjiži se na DUGUJE

Šeme izlaznih faktura (analitika=komitent):
- **IFUSL (usluge, IDSeme 30):** `2020 DefDug=O+P+Q` (kupac Duguje bruto); protiv `6121 Pot=O` (prihod),
  `4700 Pot=P` / `4710 Pot=Q` (PDV).
- **IFR (roba, IDSeme 33):** `2040 DefDug=O+P+Q`; + rashod `5010 Dug` / `1320 Pot`.
- **IZVOZ (IDSeme 47):** `2050 DefDug=O` (bez PDV).
- **KNO knjižno odobrenje (IDSeme 31):** `2020 DefDug=-O-P-Q` (negativno = storno/umanjenje).

Kupac raste izdatom fakturom (Duguje), zatvara se uplatom/kompenzacijom (Potražuje).

## C) 4350 (dobavljači) — knjiži se na POTRAŽUJE

- **UFROB (ulaz robe, IDSeme 3):** `4350 DefPot=A+B+C+D+E` = NabNeto + zavisni troškovi + oba PDV =
  **ukupan bruto obaveza**; protiv `1320 Dug=A+B+C` (roba), `2700 Dug=D` / `2710 Dug=E` (pretporez).
- **UFMAT (materijal, IDSeme 34):** `4350 DefPot=A+D+E`; + `1010 Dug=A`, `2700 Dug=D`.

Analitika=komitent. **Otvorene stavke 4350 po komitentu + `Valuta dokumenta` (dospeće) = ulaz za
pripremu plaćanja/virmane (doc 25).** Avansi `4300`/`AVR` (Sema 39). **`220` se NE pojavljuje ni u jednoj
šemi** — kamate se knjiže ručnim nalogom.

**Kontrolni konti su KONFIG parametri** (`Module__Bliski susret.txt:339-354`): `KontoKupca()`/
`KontoDobavljaca()` iz `ReadParameter` (stari default `201`/`432`). ⚠️ Auto-zatvaranje OS oslanja se na
**po JEDAN** kontrolni konto — iako postoji više pod-konta (2020/2040/2050, 4350/4351/4360). Za 4.0
razmisliti o listi kontrolnih konta.

## D) Životni ciklus naloga (veže se na doc 29 audit+lock)

DDL `T_Nalozi` (schema:1548): `Broj naloga`, `Vrsta naloga`, `Godina`, **`Level Byte`**, **`Zakljucano`**,
**`Potpis`/`DatumIVreme`**. `T_Glavna knjiga` (schema:1350): `Konto`, `Analiticka sifra`, `Duguje/Potrazuje`
(+dev par), **`IDDokIzRobnog/IzUsluga/IDRadniNalog/IDPredmet/Temeljnica`** = traceback ka izvoru.

- **Numeracija:** `1 + Count po vrsti` (`BrojNalogaPoVrstama`), zero-pad 4; jedinstvenost `(Broj, Vrsta,
  Level, Godina)`.
- **Ručni vs auto:** od 117 vrsta naloga samo ~30 ima auto-šemu; ostalih ~87 (izvodi/blagajna/plate/OS/
  kamate) = **ručni nalog** (jedini put za konta bez šeme, uklj. 220).
- **Nacrt→proknjižen = `Level`** (0=radna, `Between 0 And F_NivoBaze()`; `DugmePostaviNivo`→Level 1 =
  „zaključen"). **Višenivo zaključavanje.**
- **Hard lock** `Zakljucano` (`Z_Zakljucaj_NalogGK`) → `AllowEdits/Deletions=False`. **Zaključan nalog =
  immutable, reversal samo protiv-nalogom (KNO/storno), nikad edit.**
- **Audit:** `PotpisiDok` (Potpis+DatumIVreme) + globalni `UpisiUDnevnik` (tabela `Dnevnik`).
- **Storno:** nema dugmeta — negativna protiv-stavka/šema (KNO `-O-P-Q`) ili brisanje neproknjiženog.

## E) GL izveštaji (nad `Detaljno stavke glavne knjige`)

| Izveštaj | Šta daje |
|---|---|
| **Dnevnik** | hronološki sve stavke; filteri datum/vrsta/Level |
| **Bruto stanje** (probni bilans) | po kontu: PS Duguje/Potrazuje (nalog „PS"), promet, saldo (+dev); osnov za bilanse |
| **Kartica konta** / sintetička | hronološka kartica jednog konta |
| **Kartica analitike** | kartica po (konto+komitent) = saldakonto partnera |
| **Salda analitike / bruto salda** | din/dev saldo po (konto, komitent), `HAVING Saldo<>0` |
| **Otvorene stavke** | nezatvorene po (konto,komitent,dok), `Saldo<>0`, `PrekoracenjeDana` (docnja) |
| **Komitent po kontima / Promet** | promet/saldo komitenta preko svih konta |
| **Unakrsni (PDV/POPDV)** | rekapitulacije po šemama konta |

⚠️ **Bilansne formule (bilans stanja/uspeha, AOP)** — ISPRAVKA: `GKEval` JESTE u izvozu
(`_legacy\Izvoz\VBA\GKEval.bas`), rekurzivni evaluator sa DSL sintaksom (`D/P/PSD/PSP/A` + `*` wildcard).
Bilansi BS/BU/SI + APR eFI XML izvoz + osnovna sredstva/amortizacija su **razrađeni u
[37](37-zavrsni-racun-os-bilansi.md)** (završni račun). Formule žive u `T_GK_IZV_Stavke`/`ZR_AOP_Modla`.

## F) 2.0 stanje + procena

**2.0: GL je greenfield** — nijedan finansijski modul; `Journal` model (schema:1213) je samo app-log,
NE knjigovodstveni dnevnik.

| Deo | MUST/SHOULD | AI-dani |
|---|---|---|
| Šema: `chart_of_accounts` + `journal_orders` + `ledger_entries` (Decimal, dev par, traceback) | MUST | 4–5 |
| Rule-tabele + **`VredIzraza` port** (safe-parser A–Z, NE `eval`) | MUST | 3–4 |
| Posting engine (auto iz dok, balans-kontrola ΣDug=ΣPot) | MUST | 4–5 |
| Numeracija + ručni nalozi | MUST | 2 |
| Izveštaji: Dnevnik, Bruto stanje, Kartica konta/analitike | MUST | 4–5 |
| Saldakonti (otvorene stavke, dospeće, auto-zatvaranje, IOS) | SHOULD | 4–5 |
| Devize | SHOULD | 2–3 |
| Bilansne/PDV/POPDV rekapitulacije (gap §E) | SHOULD | 2–4 |
| **Ukupno** | | **MUST ~18–26, +SHOULD 8–12** |

**Veze:** `Level`/`Zakljucano`/`Potpis` → audit+lock (doc 29, zaključan nalog immutable); PS kroz vrstu
naloga „PS" → carry-over (doc 27); otvorene stavke 4350 → priprema plaćanja (doc 25); `VredIzraza` + PDV/
POPDV šeme → doc 18. **GL je najveći pojedinačni finansijski modul i temelj svega — radi se posle
presečne infre (audit/carry-over), pre plaćanja/saldakonata.**

## Napomene za tim
1. **`220` nije kupci** — kupci su 202x; uskladiti očekivanje.
2. Auto-zatvaranje OS pretpostavlja 1 kontrolni konto kupca/dobavljača (konfig) — razmisliti o listi.
3. Bilansne formule nemaju gotov modul — rekonstrukcija iz Bruto + POPDV.
4. **NE koristiti `eval()`** za DefDug/DefPot — safe aritmetički parser (26 promenljivih, +−*/ zagrade).
