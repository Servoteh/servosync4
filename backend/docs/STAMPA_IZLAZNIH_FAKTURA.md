# Štampa izlaznih faktura — obrazac koji 4.0 mora da pogodi

**Izvor istine:** pet stvarnih BigBit izlaza koje je vlasnik doneo 01.08.2026, u
[docs/zahtevi/fakture-obrasci-2026-08/](../../docs/zahtevi/fakture-obrasci-2026-08/).
To NISU skice nego papiri koji su izašli kupcima — svaka razlika prema njima je greška naša,
ne njihova.

| fajl | vrsta | broj | šta pokriva |
|---|---|---|---|
| `IFR.pdf` | domaća, roba | 657/25 | magacin **Magacin robe**, 2 stavke, PDV 20 % |
| `IFGP.pdf` | domaća, gotovi proizvodi | 650/25 | magacin **Gotovi proizvodi**, 1 stavka |
| `IFUSL.pdf` | domaća, usluga | 653/25 | zakup prostora, bez artikla i bez magacina |
| `InoFaktura GP 228-25.pdf` | ino, roba | 228/25 | EUR, izvoz robe, IBAN/SWIFT |
| `INOUslugaFaktura 060-26.pdf` | ino, usluga | 060/26 | EUR, **tri strane**, otpremni podaci |

---

## 1. Šta je zajedničko svim obrascima

**Zaglavlje (svaka strana):** logo SERVOTEH levo, TÜV Rheinland / ISO 9001:2008 znak desno,
ispod puna linija pa red firme:

```
Servoteh d.o.o. Dobanovci  Ugrinovačka 163, 11272 Dobanovci  tel: +381 11 31 41 564; 373 29 59;  fax: +381 11 2399 265;
e-mail: office@servoteh.rs   web:: www.servoteh.rs
```

> `web::` sa dve dvotačke je u originalu. Prepisuje se doslovno — nije naš posao da lektorišemo
> tuđi obrazac; ako se ispravlja, ispravlja se svesno i svuda.

**Podnožje (svaka strana):** traka logotipa partnera (AVENTICS · Rexroth Bosch Group · ABB ·
SKF · CASAPPA · MP FILTRI), pa registarski red:

```
Matični broj: 17400169   Registarski broj: 01117400169   Šifra delatnosti: 3320   PIB: 101017443
"Servoteh" d.o.o. je jednočlano privredno društvo upisano u Agenciji za privredne registre pod brojem BD. 222785/2006
```
desno „google mapa" + QR kod.

⚠️ **`www.BigBit.rs` u podnožju ino-usluge se NE prepisuje** — to je vodeni žig tuđeg programa.

---

## 2. Domaća faktura za robu (IFR i IFGP) — jedan obrazac, dve upotrebe

IFR i IFGP se razlikuju **samo po imenu magacina** u bloku potpisa (`Magacin robe` vs
`Gotovi proizvodi`). Sve ostalo je isto → **jedan šablon, magacin kao podatak**.

**Redosled odozgo:**

1. Centrirano: `Tekući račun: 160-110610-83`
2. Levo — okvir „K u p a c:" (razmaknuta slova u naslovu): naziv, poštanski broj + mesto,
   adresa, `PIB: … - MB: …`
3. Desno — `Račun br. 657/25` (krupno), pa `Datum izdavanja računa:`, `Valuta za plaćanje:`,
   pa niže `Mesto izdavanja računa: Beograd`
4. Traka uslova, četiri kolone sa zaglavljem:
   `Roba je FCO | Način plaćanja | Način otpreme robe | Datum prometa dobara`
   (vrednosti: `magacin kupca | virmanom | lično | 25-12-25`)
5. Tabela stavki:

   | R.br. | PDV | Kat. br. | N A Z I V   R O B E | j.m. | Količina | C E N A | R% | VREDNOST |
   |---|---|---|---|---|---|---|---|---|

   Naslovi `N A Z I V   R O B E` i `C E N A` su razmaknuti — deo obrasca.
6. Zbirni blok desno, bez okvira osim poslednjeg reda:
   ```
                                    99,363.64
                          Rabat:         0.00

   Vrednost bez PDV (osnovica):     99,363.64
   PDV po stopi 20% X 99,363.64 =   19,872.73
   Za uplatu (RSD):                119,236.37     ← uokvireno, podebljano
   ```
   Red PDV-a ima **osnovicu unutar teksta** („PDV po stopi 20% X 99,363.64 ="), ne samo iznos.
7. Napomene (levo, sitno):
   ```
   Napomena o poreskom oslobodjenju: NEMA
   Reklamacije primamo u roku od 5 dana po prijemu robe.
   Za sve sporove nadležan je Privredni sud.
   U slučaju prekoračenja roka za plaćanje obračunavamo zakonom propisanu zateznu kamatu.
   ```
8. **Četiri kolone potpisa** sa linijama:

   | Robu primio | Preuzeo za prevoz | Robu izdao | Odgovorno lice |
   |---|---|---|---|
   | (prazno) | `SERVOTEH doo` / `Dobanovci, Ugrinovačka 163` / `PIB: 101017443 MB: 20748346` | `Broj l.k.:______` / `iz magacina <MAGACIN>` / `Ugrinovačka 163, Dobanovci` | ime, npr. `Dragana Korkut` |

   ⚠️ Gornji red je **prepis papira**, ne opis onoga što mi štampamo. Na tri mesta svesno
   odstupamo, po odlukama iz [STAMPA_FAKTURA_ODLUKE.md](STAMPA_FAKTURA_ODLUKE.md):
   `MB: 20748346` je matični broj KUPCA i mi štampamo naš `17400169` (**O-F8**); ime je jedan
   jedini oblik iz baze — `Servoteh d.o.o.`, ne `SERVOTEH doo` (**O-F9**); natpis `Broj l.k.`
   se ne štampa uopšte (**O-F3**). Adresni redovi ovog bloka ostaju **bez poštanskog broja**,
   tačno kao na papiru — zato je broj i izdvojen u svoju kolonu (**O-F10**).

---

## 3. Domaća faktura za uslugu (IFUSL) — poseban obrazac, ne varijanta

Odluka vlasnika O1–O4 (v. [PLAN_UNOS_DOKUMENATA.md](PLAN_UNOS_DOKUMENATA.md) §8) kaže da je
usluga **poseban ekran**; štampa to potvrđuje — razlike nisu kozmetičke:

| | roba (IFR/IFGP) | usluga (IFUSL) |
|---|---|---|
| naslov | `Račun br. 657/25` u jednom redu | `Račun` pa ispod `br. 653/25` **podvučeno** |
| gornji desni blok | Datum izdavanja, **Valuta za plaćanje**, Mesto | Datum izdavanja, Mesto, **Rok za plaćanje**, **Datum prometa** |
| traka uslova (FCO/otprema) | **ima** | **nema** |
| kolone stavki | Kat. br. + NAZIV ROBE | **bez Kat. br.**, kolona se zove `O P I S` |
| poslednja kolona | `VREDNOST` | `I Z N O S` |
| rabat kolona | `R%` | `Rab%` |
| zbir | 5 redova | 5 redova, ali svaki **uokviren** i sa `Ukupno vrednost bez PDV (osnovica)` kao zasebnim redom |
| poslednji red | `Za uplatu (RSD):` | `Ukupno za uplatu (RSD):` |
| reklamacije | „u roku od 5 dana **po prijemu robe**" | „u roku od 5 dana" |
| sud | **Privredni sud** | **Trgovinski sud u Beogradu** |
| potpisi | 4 kolone + magacin | **samo `Odgovorno lice`** + ime + `Br. l.k.:008165163` |

---

## 4. Ino faktura za robu (Invoice 228/25)

Ceo obrazac je na **engleskom**, iznosi u **EUR**, bez ijednog PDV reda.

* Naslov desno: `Invoice No. 228/25`
* Levo, kao parovi labela/vrednost: `Date:`, `Customer:`, `Address:`, `Delivery term:`,
  `Payment terms:` — **vrednosti ostaju na srpskom** („magacin kupca", „virmanom"), jer se
  prepisuju iz šifarnika. Ne prevoditi ih.
* Stavke: `No. | Catalog No. | Description | Unit | Stat. goods No. | Quantity | Price | Total ( EUR)`
  — kolona **Stat. goods No.** (carinska tarifa) postoji i prazna je na ovom primeru, ali mora
  da se štampa.
* Zbir: `TOTAL`, `DISCOUNT:`, pa uokvireno `TOTAL AMOUNT ( EUR)`. Razmak u `( EUR)` je iz originala.
* Slobodan tekst ispod: poziv na ponudu (`Fakturisanje je izvršeno na osnovu ponude 0206-25`),
  broj izvozne deklaracije (`25-0401-000005`), `Način plaćanja: avansno`.
* Poresko oslobođenje — **za robu**:
  `Oslobodjeno PDV na osnovu člana 24. stav 1 tačka 2 Zakona o PDV.`
* Blok banke u dve kolone:
  ```
  Beneficiary Customer:                    Bank of beneficiary:
  IBAN : RS35160005010003501186            SWIFT: DBDBRSBG
  Servoteh d.o.o. Dobanovci                Banca Intesa a.d. EUR
  Ugrinovačka 163, 11272 Dobanovci         Milentija Popovića 7b, 11070 New Belgrade
                                           Republic of Serbia
  ```
* **Nema potpisnih linija.**
* U originalu je blok „Reklamacije/sud/kamata" odštampan **dvaput** — to je greška BigBita i
  ne prepisuje se.

---

## 5. Ino faktura za uslugu (Invoice 060/26) — višestrana

Najsloženiji obrazac; nosi tri zahteva koje ostali nemaju.

* Stavke: `No. | Description | Unit | Quantity | Price | Total` — **bez `Catalog No.` i bez
  `Stat. goods No.`** (usluga nema carinsku tarifu).
* Gornji levi blok ima `Date of delivery:` sa **datumom i mestom** (`06-03-26 , Beograd`).
* **Prelama se na tri strane, i zaglavlje se ponavlja na svakoj**: logo, red firme, `Invoice No.`,
  kupac, adresa, datumi — pa tek onda nastavak tabele. Podnožje nosi `Strana X od Y`.
* Zbir dolazi na kraju stavki (strana 2), a **blok banke ide na zasebnu, poslednju stranu**.
* Poresko oslobođenje — **za uslugu, drugi član nego za robu**:
  `Oslobodjeno PDV-a na osnovu člana 24. stav 2 Zakona o pdv.`
* Dodatni otpremni blok koga na ostalim obrascima nema:
  ```
  Paritet: FCA Dobanovci-Beograd
  Količina: 1 paleta
  Dimenzije: 400 x 800 x 2400 mm
  Ukupna brutto: 1.720,00 kg
  Ukupna Netto: 1.700,00 kg
  Mesto istovara: <naziv, adresa, mesto, država>
  Kontakt špeditera u uvozu: <firma, telefoni>
  ```

---

## 6. Pravila koja se lako previde

1. **Član oslobođenja zavisi od vrste prometa.** Roba → `član 24. stav 1 tačka 2`.
   Usluga → `član 24. stav 2`. Pogrešan član na izvoznoj fakturi je poreski problem, ne kozmetika.
2. **Sud se razlikuje po obrascu**: roba → `Privredni sud`; usluga → `Trgovinski sud u Beogradu`.
   (Naziv „Trgovinski sud" je zastareo u pravu, ali se u njihovom obrascu štampa — menja se
   samo uz izričitu odluku.)
3. **Domaća faktura ima `Tekući račun` u zaglavlju; ino ima IBAN/SWIFT blok na dnu.** Nikad oboje.
4. **Rabat se štampa i kad je nula** (`Rabat: 0.00`, `DISCOUNT: 0.00`) — red se ne izostavlja.
5. **Brojevi:** decimalna tačka, hiljade zarezom (`119,236.37`) — obrnuto od srpske norme, ali
   je tako u originalu na SVIH pet obrazaca.
6. **Datumi:** domaći `DD-MM-YY` (`25-12-25`); ino `DD.MM.GGGG.` sa tačkom na kraju
   (`25.04.2025.`), a `Date of delivery` u ino-usluzi opet `DD-MM-YY`.
7. **Broj računa** je `NNN/GG` (`657/25`) — kosa crta, dvocifrena godina.
8. **Magacin se štampa samo na robi** i to unutar bloka potpisa, u koloni „Robu izdao".

---

## 7. Stanje koda (01.08.2026, posle vezivanja obrazaca)

`backend/src/modules/sales/print/invoice-pdf.service.ts` više ne crta fakturu — on je **spona**:
učita `PrintCtx` (jedno učitavanje za sve), izabere obrazac **po vrsti dokumenta** i obmota ga
memorandumom u pdfmake `header:`/`footer:` funkcijama.

| gde | šta |
|---|---|
| `print/templates/domaca-roba.ts` | IFR, IFGP |
| `print/templates/domaca-usluga.ts` | IFUSL |
| `print/templates/ino-roba.ts` | IZVRO, IZVGP |
| `print/templates/ino-usluga.ts` | IZVUS (višestran; `header:` + `Strana X od Y`) |
| `print/memorandum.ts` | zaglavlje i podnožje strane, isto na sva četiri |
| `print/format.ts` | brojevi, datumi, broj računa |

Varijanta više ne bira obrazac nego samo da li se štampaju cene (`withPrices | withoutPrices`);
`export` je zadržana zbog rute `?variant=export`, ali ništa ne prebacuje — engleski obrazac
dolazi od vrste dokumenta. `PON`/`PROF`/`REV` nemaju doneti obrazac: štampaju se na najbližem uz
**upozorenje u logu**, a nepoznata vrsta baca izuzetak umesto da tiho izabere pogrešan papir.

**Dva puta u istom servisu (spajanje 02.08.2026).** Ispod četiri obrasca stoji i **zatečeni
opšti renderer** (`buildLegacyPdf` + `build*` metode uz njega), koji crta dokumente za koje
obrazac NIJE donet i za koje je „najbliži papir" premalo:

| varijanta | dokument | šta nosi preko običnog papira |
|---|---|---|
| `advance` | avansni račun (AVR) | osnov avansa, stanje naplate, napomena da poreska obaveza nastaje NAPLATOM |
| `creditNote` | knjižno odobrenje | vrednosne stavke (bez količine i cene), klauzula o potvrdi primaoca |
| `debitNote` | knjižno zaduženje | vrednosne stavke, napomena o uvećanju osnovice |

Skretnica je u `buildInvoicePdf` i jednoznačna je: te tri varijante → opšti renderer, sve ostalo
→ obrazac po vrsti dokumenta. Dokument vrste `AVR` bez izričite varijante sam bira `advance`.
Kad vlasnik donese papir za AVR/KO/KZ, ta vrsta prelazi u `FORM_BY_DOCUMENT_TYPE`, a grana se
briše — nikad obrnuto. Trag štampe u nozi („Štampao …") nose SAMO dokumenti opšteg renderera:
podnožje četiri obrasca je prepisano sa BigBit papira i dodatni red bi bio odstupanje od
originala.

Ostaje otvoreno (v. [STAMPA_FAKTURA_GAP.md](STAMPA_FAKTURA_GAP.md) §5): adresa magacina u bloku
„Robu izdao" (štampa se adresa sedišta), `Način plaćanja` i `Payment terms` na ino robi čitaju
isto polje, prelom domaćeg računa preko jedne strane i devizni račun za valute osim EUR.

---

## 8. Devizni račun — gde se unosi i jednokratni SQL

### Kvar koji je ovo zatvorilo

Blok banke je bio **lanac od tri karike koje su sve „postojale" a nijedna nije radila**:
šablon `ino-roba.ts` crta blok, `PrintIssuer` ima polja, migracija
`20260801100000_stampa_faktura_polja` je dodala kolone `payment_accounts.iban`, `swift`,
`bank_address` i `currency` — ali ih **nijedan pisac nije punio**. Rezultat: izvozna faktura
izlazi bez ijedne bankarske instrukcije, papir izgleda potpuno ispravno, a strani kupac nema
na koji račun da plati. Kvar se otkrije tek kad kupac pozove — a papir je već otišao.

Zatvoreno 02.08.2026. na tri mesta:

| gde | šta |
|---|---|
| Podešavanja → Firma → **Devizni računi** | unos IBAN-a, SWIFT-a, naziva i adrese banke i valute (`payment-accounts.service.ts`) |
| `invoice-pdf.service.ts` → `loadForeignAccount` | izvozni račun **sa cenama** bez IBAN-a/SWIFT-a se NE štampa — 422 sa uputstvom gde se unosi |
| `sync/table-ownership.ts` → `NATIVE_COLUMN_TABLES` | `payment_accounts` zaštićen od full refresh-a, inače bi noćni sync obrisao unete kolone |

Provera je **na štampi, ne na knjiženju**: knjiženje je računovodstveni čin (glavna knjiga,
saldakonti, SEF) i račun je po zakonu punovažan bez našeg bloka banke — zaustaviti knjiženje
zbog praznog polja u podešavanjima značilo bi zaustaviti knjige zbog kozmetike. Otpremnica
(`withoutPrices`) je izuzeta: na njoj nema nijednog iznosa, pa ni podatke za uplatu ne očekuje.

`companies.iban`/`swift` (Podešavanja → Firma → Podaci za plaćanje) ostaju kao **rezerva** —
uzimaju se samo kad nijedan račun nema bankarske podatke. Nose IBAN i SWIFT, ali ne i naziv i
adresu banke (`companies` te kolone nema), pa je to minimum po kom uplata može da se izvrši,
a ne pun blok.

### Zašto stvarni podaci NISU u migraciji ni u seedu

Postojeći seed obrazac (`prisma/migrations/*_seed_*`, `prisma/seed/*.sql`) drži **šifarnike i
registre** — kontni plan, POPDV mapiranja, statuse, formule bilansa. To je referentni sadržaj
koji je isti na svakoj instalaciji i koji kod smatra svojim.

Broj bankovnog računa firme **nije referentni podatak** nego živ poslovni podatak jedne firme.
Uz to, `payment_accounts` je BigBit tabela (`UplatniRacuni`) čije ključeve dodeljuje BigBit —
migracija ne može znati koji `id` nosi Servotehov Intesa račun na produkciji, a koji na dev
bazi. `INSERT` sa tvrdim `id`-jem bi na jednoj od njih pogodio tuđi red i spojio **dinarski
broj računa sa deviznim IBAN-om** — papir gori od praznog. Zato SQL ispod pušta **vlasnik ili
administrator baze, jednom, svesno**, pošto pogleda šta u tabeli već stoji.

### Podaci sa donetog papira (Invoice 228/25)

```
IBAN : RS35160005010003501186     SWIFT: DBDBRSBG
Banca Intesa a.d. EUR
Milentija Popovića 7b, 11070 New Belgrade, Republic of Serbia
```

### Korak 1 — pogledati šta postoji

```sql
SELECT id, company_id, account_number, bank_name, currency, iban, swift, is_default
FROM payment_accounts
ORDER BY company_id, is_default DESC, sort_order, id;
```

IBAN `RS35160005010003501186` odgovara domaćem broju **160-0050100035011-86** (šifra banke
`160`, partija `0050100035011`, kontrola `86`). Ako u ispisu postoji red sa tim brojem računa,
ide **korak 2a**; ako ne postoji nijedan devizni račun, ide **korak 2b**.

### Korak 2a — dopuna postojećeg reda (očekivani slučaj)

```sql
UPDATE payment_accounts
SET iban         = 'RS35160005010003501186',
    swift        = 'DBDBRSBG',
    bank_name    = COALESCE(NULLIF(btrim(bank_name), ''), 'Banca Intesa a.d.'),
    bank_address = 'Milentija Popovića 7b, 11070 New Belgrade' || chr(10) || 'Republic of Serbia',
    currency     = 'EUR'
WHERE id = <ID_IZ_KORAKA_1>;
```

> `bank_name` se dopunjuje samo ako je prazan — naziv banke donosi BigBit i njegova vrednost
> ima prednost. `chr(10)` je prelom reda: „Republic of Serbia" je na papiru **drugi red** adrese.

Posle ovoga se sve dalje menja kroz ekran — **Podešavanja → Firma → Devizni računi**.

### Korak 2b — ako deviznog računa nema uopšte

Red se otvara **u BigBitu** (`UplatniRacuni`), pa ga sync donese ovamo, i tek onda ide korak 2a.
Razlog je isti kao gore: `payment_accounts` nema rezervisan 4.0 opseg ključeva
(`chk_*_native_id_range` koji postoji za `customers` i `items`), pa bi red napravljen ovde uzeo
`id` iz istog prostora iz kog BigBit deli svoje — a sync upsertuje **po `id`-u**. Sudar bi bio
tih: BigBit bi prepisao broj računa i naziv banke, a naš IBAN bi ostao.

Ako se iz nekog razloga ipak unosi ručno, `id` se bira **iznad BigBit maksimuma** i to se
zapisuje kao odluka:

```sql
-- SAMO ako red ne može da se otvori u BigBitu. Proveriti prostor ključeva PRE unosa.
INSERT INTO payment_accounts
  (id, company_id, account_number, bank_name, is_default, sort_order, iban, swift, bank_address, currency)
VALUES
  ((SELECT COALESCE(MAX(id), 0) + 1000 FROM payment_accounts),
   1, '160-0050100035011-86', 'Banca Intesa a.d.', false, 90,
   'RS35160005010003501186', 'DBDBRSBG',
   'Milentija Popovića 7b, 11070 New Belgrade' || chr(10) || 'Republic of Serbia', 'EUR');
```

### Provera da je stiglo do papira

```sql
SELECT id, account_number, currency, iban, swift FROM payment_accounts WHERE iban IS NOT NULL;
```

pa odštampati bilo koju izvoznu fakturu (IZVRO/IZVGP/IZVUS) — blok banke mora da nosi
`IBAN : RS35160005010003501186`, `SWIFT: DBDBRSBG`, `Banca Intesa a.d. EUR` i obe linije adrese.
Dok podataka nema, štampa vraća poruku koja imenuje valutu i upućuje na ekran.
