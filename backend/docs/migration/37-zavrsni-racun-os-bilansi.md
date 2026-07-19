# Završni račun — bilansi (BS/BU/SI, APR), osnovna sredstva, GKEval formule

> **Status:** ANALIZA (2026-07-18). Godišnji regulatorni vrhunac finansija. Dopunjuje [30](30-glavna-knjiga-modul-dubinski.md)
> (GL) i [18](18-gl-pdv-kontiranje-rekonstrukcija.md). **Ispravka doc 30:** `GKEval` JESTE u izvozu
> (`_legacy\Izvoz\VBA\GKEval.bas`, 186 linija) — evaluator bilansnih formula potpuno rekonstruisan (§F).

## ⚠️ SCOPE (Nenad, 18.07): OS se vode KOD KNJIGOVOĐE — mi samo upisujemo u ZR

**Osnovna sredstva (registar, amortizacija, poreska amortizacija/Obrazac OA) NISU naš posao** — vodi ih
knjigovođa. **Naš deo = samo ZR (bilansi/APR XML)**, gde OS-pozicije dolaze kao **spoljni ulaz** (knjigovođa
daje vrednosti, mi ih unosimo u odgovarajuće AOP-ove). → §A (OS model) ostaje samo kao **referenca za AOP
mapiranje** (koja konta klase 0 idu u koju bilansnu poziciju), NE kao modul za gradnju. Procena (§G)
revidirana naniže — OS modul (registar+amortizacija) izbačen.

## A) Osnovna sredstva (OS) — REFERENCA (vodi knjigovođa, ne gradimo)

**Model:** `T_OS_Sredstva` (schema:1573 — registar/kartica: inventarni br., naziv, `Stopa otpisa`, `AmGrupa`
I–V) + `T_OS_Stavke` (schema:1595 — podknjiga: `Vrednost`/`Otpis` računovodstveno + **`PorAmVrednost`/
`PorAmOtpis`/`PorAmProdaja` poreski, zaseban kolosek**). OS je **subledger nezavisan od GK**.
- Sadašnja vrednost = Σ(Vrednost−Otpis); poreska = Σ(PorAmVrednost−PorAmOtpis−PorAmProdaja).

**Klasa 0 — stvarni kontni plan Servoteha (parcele sa katastarskim brojevima!):**
- **Zemljište `021x`** (CSV l.29–51): `021` građevinska zemljišta; pojedinačne parcele `0203`, `0210`–`0219`,
  `02100`–`02109` sa KP i m² (npr. `02102` „6145 KP Zemlj 2.036m² V ZONA"). **Analitika = katastarska parcela.**
  ⚠️ **Zemljište NEMA konto ispravke vrednosti** (ne amortizuje se) — ulazi u bilans punom vrednošću.
- **Objekti `022x`** (hale) + **ispravka `0229x`** (konvencija: konto objekta sa umetnutim „9"); `02277/02278`
  parking dodat 13-03-2026 (aktivan razvoj).
- **Oprema `023`** + ispravka `0239`; investicione nekretnine `024`; nematerijalna `01`/`012`; OS u pripremi `027`.

**Amortizacija** (`LIB_OS.bas`): računovodstvena **linearna** (`Koef=(meseci/12)×(Stopa/100)`, počinje mesec
posle nabavke); **poreska grupna degresivna** (grupe II–V na saldo grupe, **pravilo 5 prosečnih zarada** →
grupa se otpiše kad padne ispod; grupa I proporcionalno) → **Obrazac OA** za PPDG. ⚠️ **Knjiži se SAMO u OS
podknjigu, NE u GK** — GK nalog (540 amortizacija → 0x9 ispravka) ide **ručno, vrsta `AMOR`**. → **4.0
poboljšanje: auto OS→GL knjiženje.** Revalorizacija (`OS_Stope revalorizacije`) — istorijska, praktično mrtva.
**Popis OS ne postoji kao dokument** (samo izveštaj) — rupa za 4.0.

## B) Zaključni nalozi (zatvaranje godine)

**Nalaz: zatvaranje klasa 5/6→7 NIJE automatizovano** (grep = 0). BigBit ne generiše fizičke zaključne
naloge; rezultat i bilans uspeha se **izvode analitički iz bruto stanja** preko GKEval (§F). Klasa 7
(`710/720/723`, rezultat → `34` dobit / `35` gubitak) postoji u planu kao nasleđe, ali „zatvaranje" je
opcioni ručni nalog. **Legitiman pristup** — rezultat se računa iz salda 5/6, formalno zatvaranje nije preduslov.

**Otvaranje nove godine = nalog vrste `PS` (početno stanje):** `PSF_PrenesiNaloguUNG` prenosi naloge iz
prethodne godine (`T_Nalozi1`) isključujući robna dokumenta. Bruto stanje izdvaja PS: `PSDuguje = Σ IIf(Vrsta
Like "PS", Duguje, 0)`. Balansna konta (0–4) se prenose kao PS; klase 5/6/7 kreću od nule. (Veza doc 27 PS + doc 12 §1.)

## C/D) Bilans stanja (BS) i uspeha (BU)

Dva sistema: (1) **interni** GK izveštaji (`T_GK_IZV_Stavke` + GKEval, slobodne pozicije); (2) **zvanični APR**
(`ZR_Zaglavlje`/`ZR_Stavke` + `ZR.bas`). Model `ZR_Stavke`: `AOP, GrupaKonta, Definicija (formula), Obrazac
(BS/BU/SI), StartnaKolona, BrojKolona, Iznos_1/2/3`.

**Tok:** snimi bruto stanje **zaokruženo na hiljade** (`Round(/1000,0)` — APR obrasci u 000 din) → kopiraj AOP
šablon **po veličini preduzeća** (`ZR_AOP_Modla`, mikro/malo dobija manje AOP-a) → popuni konto-formule
(`Iznos_1=VrednostIzraza(Definicija)/1000`) → pa AOP-reference (`A*`) → prethodna godina `Iznos_3` → **kontrola
`ZR_AOP_Pravila`** (aktiva=pasiva…). **Zemljište/OS u aktivi:** `PSD022*+D022*−PSD0229*−D0229*` (bruto−ispravka);
zemljište `021*` bez ispravke. **BU** puni klase 5 (rashodi, `D5*`) i 6 (prihodi, `P6*`); amortizacija `540`.

## E) APR / statistički izveštaj / PPDG — XML izvoz

`ZR.bas`+`ZRXML.bas`. Aktuelni **APR eFI format (FiForma)**: `ZR_EksportXML_BS/BU/SI`, namespace
`schemas.datacontract.org/…/Domain.Model`, struktura `<NumerickoPolje><Naziv>aop-{AOP}-{kolona}</Naziv>
<Vrednosti>{Round(0)}</Vrednosti>`, nule kao `i:nil="true"`. → upload u **APR Poseban informacioni sistem za
FI**. Poreska amortizacija (Obrazac OA) = prilog uz PPDG-1 (ide preko ePorezi, van APR XML-a). **Logika živi
u `BigBit_APL_2010`** (ZR_* i T_GK_IZV_Stavke su u APL sloju).

## F) GKEval — sintaksa bilansnih formula (rekonstruisano)

Rekurzivni evaluator stringa (`GKEval.bas`, 186 l.). Atomi (prefiks + konto + `*` wildcard):

| Prefiks | Značenje |
|---|---|
| `D<konto>*` / `P<konto>*` | Σ dugovni / potražni promet |
| `PSD<konto>*` / `PSP<konto>*` | početno stanje dug. / potr. |
| `A<aop>` / `AB` / `AC` | vrednost druge AOP pozicije (kolona 1/2/3) |
| konstanta | `Eval()` |

Redosled parsiranja: 3 znaka (`PSD/PSP`) → 2 (`AB/AC`) → 1 (`D/P/A`). Operatori `+ − ( )` + logički za pravila.
⚠️ **Parser je naivan** (split na prvom operatoru, bez prioriteta osim zagrada) → **4.0 poboljšanje: pravi
parser sa prioritetom**, ali zadržati DSL sintaksu (`D/P/PSD/PSP/A`+`*`) zbog kompatibilnosti definicija.
Formule žive u `T_GK_IZV_Stavke.Formula` i `ZR_AOP_Modla` (u binarnom `.MDB`, nisu CSV — motor i sintaksa
rekonstruisani iz VBA). Primer: `D202* + P433* − D021*`.

## G) 2.0 stanje + procena

**2.0: NIŠTA finansijsko** — grep za amortizacija/bilans/OS daje samo `odrzavanje` (tehnički karton
mašina/vozila, NE finansijska OS). Cela oblast greenfield, zavisi od GL (doc 30).

**Revidirano (OS kod knjigovođe → izbačen OS modul):**

| Celina | MUST/SHOULD | AI-dani |
|---|---|---|
| ~~OS registar + amortizacija + poreska (Obrazac OA)~~ | ⛔ **VAN SCOPE-a — knjigovođa** | 0 |
| Motor bilansnih formula (GKEval port + pravi parser) | MUST | 4–6 |
| Bruto stanje + PS separacija | MUST | 2–3 |
| BS/BU/SI + **APR eFI XML** (auto iz GK + ručni unos OS-pozicija od knjigovođe) | MUST (regulatorno) | 4–5 |
| Zaključni nalozi kl.7 (opciono) | SHOULD | 1–2 |
| **Ukupno (ZR bez OS modula)** | | **~11–16 AI-dana + GL preduslov** |

**Napomena:** OS-pozicije u bilansu (klasa 0 — zemljište/objekti/oprema) se ne računaju kod nas nego
**unose ručno iz knjigovođinih podataka** (ili se prime kao vrednosti). GKEval formule za te AOP-ove
ostaju, ali izvor su spoljni brojevi, ne naš OS subledger.

**Veze:** GL (doc 30) = apsolutni preduslov (bruto stanje = izvor svega); audit (doc 29 — obračuni
verzionisani/immutable posle predaje); PS/carry-over (doc 27). **Terminologija (doc 38):** „Osnovna sredstva",
„Amortizacija", „Bilans stanja/uspeha", „Završni račun" (Pantheon/APR standardni nazivi).

**Ključno poboljšanje nad Access-om:** auto-knjiženje amortizacije OS→GL (legacy radi ručno), pravi
formula-parser, i undo/audit na obračunima (doc 29/36).
