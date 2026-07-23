# Prepisivanje dokumenata — centralni „carry-over" mehanizam

> **Status:** ANALIZA (2026-07-18, iz izvučenog VBA + append-upita). Ovo je **skriveni kičmeni stub
> celog toka dokumenata** — kako se jedan dokument „prepiše/pretvori" u drugi. Danas ~25 ad-hoc parova
> istog obrasca; predlog za 4.0 = **jedan generički servis**.

**Terminologija:** BigBit „**Proknjizi**" kod prepisivanja stavki NE znači „knjiži u GK" —
`ProknjiziStavkeIz<IZVOR>U<CILJ>` = **„prepiši stavke iz X u Y"** (isto što VBA zove `Prepisi…`/`Dodaj…`).

## A) Generički obrazac (dva fizička oblika)

**Oblik 1 — append-upit vođen formom:** dugme na CILJNOJ formi pokrene INSERT…SELECT gde **cilj-IDDok
dolazi iz otvorene ciljne forme**, **izvor-IDDok iz dijalog-forme**:
```sql
-- ProknjiziStavkeIzUlaznogUIzlazni.sql
INSERT INTO [Robne stavke] (IDDok, [Sifra artikla], Kolicina, …)
SELECT [Forms]![Izlazna faktura]![IDDok],           -- CILJ
       [Sifra artikla],
       IIf([…]![MinusKolicine],-[Kolicina],[Kolicina]), …
FROM [Robne stavke]
WHERE IDDok = [Forms]![ProknjiziStavkeIzUlaznogUIzlazni]![IzUlaznogIDDok];  -- IZVOR
```
Selekcija stavki: čekboks `Dodaj=True` (tmp-tabela) ili `Prepisi=True`.

**Oblik 2 — VBA fabrika** (`Module__KreiranjeDokumenata.txt`): par `Kreiraj<Tip>Dok(...)→NoviIDDok` +
`Dodaj/PrepisiStavke(NoviIDDok, QDef, ZaIDDok)` (petlja `AddNew`). Na kraju upiše **traceback**:
`TabStav![IDStavkeTrebovanja] = NoviStav![IDStavke]` (:279).

**Negativni/self-ref ključ:** izvor-stavka se pamti kao **negacija svog `IDStavke`** u polje
`IDPrepisaneStavke` cilj-stavke (`… -[IDStavke] AS Expr17`), dekodira se nazad `-[IDPrepisaneStavke]`.
Znak služi (a) razlikovanju smera i (b) `Is Null` testu „još neprepisano". ⚠️ **Konvencija znaka NIJE
uniformna** — deo parova upisuje pozitivan izvor-`IDStavke` (istorijski drift).

## B) Matrica izvor→cilj (~25 parova)

| Izvor → Cilj | Upit/rutina |
|---|---|
| Profaktura → Izlazna faktura | `ProknjiziStavkeIzProfaktureUIzlazni` |
| Profaktura → nova Profaktura (split) | `00_ProknjiziStavkeIzProfUProf` |
| Profaktura → Trebovanje / Proizvodnja / Rezervacija (PRZ) | forme + `KreirajRobniDok("PRZ")` |
| Ulazni → Izlazni (+ PoPredmetu/PoMPCenovniku/PoRN) | `ProknjiziStavkeIzUlaznogUIzlazni*` |
| Ulazni → Ulazni / → Profaktura po predmetu | `…IzUlaznogUUlazni`, `…UProfakturuPoPredmetu` |
| Narudžbenica (Trebovanje) → Ulazni | `ProknjiziStavkeIzPorudzbineUUlazni` |
| Porudžbina → Porudžbina / Uvoz | `…UPorudzbinu`, `…UUVOZ` |
| Upit/Ponuda → Narudžbenica | `ProknjiziStavkeIzTMPUpitaUPorudzbinu` |
| Izlazni → Izlazni / → Kasa blok | `…IzIzlaznogUIzlazni*`, `…UKasaBlok` |
| Lager → Izlazni | `ProknjiziStavkeIzLageraUIzlazni` |
| Popis → Ulazni (manjak/višak) / Robni → Popis | `ProknjiziStavkeIzPopisaUUlazni_*` |
| Nalog GK → Nalog GK | `DoknjiziStavkeIzNaloga` |
| Robni/stanje → Nivelacija | `PripremiStavkeZaNivelaciju` |
| Trebovanje → Robne (naknjižavanje) | `StavkeTrebovanjaZaNaknjizavanje` |
| Ceo dokument → nov (kloniranje) | `KOPIRAJ Robna dokumenta i stavke`, `PS_PrenesiRobneStavke_Prof_i_NG` |

⚠️ **Avansni računi** (profaktura→avansna) NISU 1:1 prepis — osnovica se računa iz uplata
(`PDV_AvansniRacun*`, `NSK_KorisceniAvansiRoba`). Tretirati odvojeno.

## C) Prenos vs preračun (3 režima — razlog N ad-hoc upita)

1. **Verni prepis 1:1** (`00_ProknjiziStavkeIzProfUProf`): cene/rabat/kasa/količina doslovno.
2. **Cena zadržana, PDV/MP preračunat iz tarife** (`StavkeTrebovanjaZaNaknjizavanje`): VP=Cena,
   `KalkMP=Cena*(1+PDVStopa/100)`, tarife sveže iz `R_Artikli`.
3. **Cena obračunata iz rabata/kase sa dijaloga** (`ProknjiziStavkeIzUlaznogUIzlazni`):
   `Round(KalkVP*(1-Rabat/100)*(1-Kasa/100), …)`. `MinusKolicine` → negativne količine (storno/povrat).

**Količina:** nabavni tokovi prenose **isporučenu** (`IsporucenaKolicina<>0`), „razlika" prenosi
ostatak (`TrebKol-IsporucenaKolicina>0`). Nivelacija: „Stara"=„Nova" snapshot pa ručni edit.

## D) Anti-duplo / delimično (uvek `LEFT JOIN … Is Null` po traceback ključu)

```sql
-- StavkeTrebovanjaZaNaknjizavanje.sql — kanonski
FROM [T_Trebovanja stavke] LEFT JOIN [T_Robne stavke]
     ON [T_Trebovanja stavke].IDStavke = [T_Robne stavke].IDStavkeTrebovanja
WHERE IDTreb=[ZaIDDok] AND [T_Robne stavke].IDStavkeTrebovanja Is Null;  -- još neprepisano
```
Isto sa `IDPrepisaneStavke`. **Delimično** = po ostatku količine (bez ključa). **Sanitarni sloj:**
serija „doktor" upita `000_DuplePrepisaneStavke*` (GROUP BY `IDPrepisaneStavke` HAVING Count>1) →
`001_Oznaci` (`Taksa=-12345`) → `002_Obrisi` — dokaz da je `IDPrepisaneStavke` de-facto ključ jedinstvenosti.

## E) Traceback (dva nivoa, u DDL)

- **Stavka:** `T_Robne stavke.IDPrepisaneStavke` (:1952), `ProknjizenoIzProfUIF` (:1953),
  `IDStavkeTrebovanja` (:1954); `T_Proizvodnja stavke.IDPrepisaneStavke` (:3014).
- **Dokument:** `T_Glavna knjiga.IDDokIzRobnog/IzUsluga` (:1365/1374), `IDDokIF/UF` (:1800/1801),
  `OP_Dokumenta.IDDokVeza` (:646), kloniranje preko `STARIID`.
→ Omogućava reviziju i **storno** (`MinusKolicine` = storno-prepis).

## F) Za 4.0: JEDAN generički `DocumentCarryOverService`

Danas ~25 parova, isti oblik, ali nekonzistentne konvencije (znak `IDPrepisaneStavke`, gde se cena
preračunava) → duplikati koji traže „doktor" upite. Predlog — deklarativna konfiguracija po paru:
`sourceType`, `targetType`, `fieldMap`, `pricePolicy` (`keep`|`recalcFromPricebook`|`recalcFromRabatKasa`),
`qtyPolicy` (`full`|`deliveredOnly`|`remaining`), `dedupKey` (uz `NOT EXISTS` guard), obavezan
`sourceDocId`+`sourceItemId` (jedan **pozitivan** FK umesto negacije) + event-log za storno.

| Deo | Procena |
|---|---|
| Model (2 kolone traceback na tabelama stavki + tabela mapiranja parova) | 1–2 dana |
| Core servis (mapiranje, 3 price/qty politike, dedup, traceback, event) | 4–6 dana |
| Migracija N parova u konfiguraciju + parity testovi vs legacy | 6–10 dana |
| **Ukupno MVP** (glavni parovi: prof→faktura, narudžbenica→ulazni, ponuda→narudžbenica, ulazni→izlazni) | **~2–3 nedelje** |

**Ključna vrednost:** N upita → 1 servis + tabela mapiranja; anti-duplo, delimično prepisivanje i
traceback postaju uniformni i testabilni. Ovaj servis je temelj za profakture (doc 26), nabavku
(doc 24), fakturisanje — svi ga koriste.
