# Konto prihoda za usluge — predlog sa preporukom (05.08.2026)

> ## ✅ POTVRĐENO I IZVEDENO (05.08.2026)
>
> Vlasnik i knjigovođa su prihvatili predlog iz odeljka 2 („**6501 zakup, ali to može posle
> da se promeni, sve ostalo ok**"). Sva četiri odgovora iz odeljka 3 su time data:
> spisak je tačan, zakup ide na **6501**, tekstovi napomena su potvrđeni, podrazumevana
> vrsta je **`USL`**.
>
> **Šta je napravljeno.** Šifarnik `service_revenue_types` (migracija
> `20260805190000_sifarnik_vrsta_usluge`) + polje na **zaglavlju** uslužnog računa
> (`invoices.service_revenue_type_id`). Iz izabrane vrste sada slede tri stvari:
> konto prihoda u glavnoj knjizi (`buildSalesLedgerLines`), poreski tretman
> (`vat-totals.ts` — otpad i ino usluga obaraju PDV na nulu, uz kategorije `AE` odn. `O`
> u e-fakturi) i napomena na papiru (`domaca-usluga.ts`, `ino-usluga.ts`).
> Značenje tretmana je na jednom mestu: `backend/src/modules/sales/service-revenue-type.ts`.
>
> **Zašto zaglavlje, a ne stavka** — izmereno nad knjigom 2026 po
> `ledger_entries.document_number`: **57 od 57** dokumenata sa uslužnim prihodom nosi
> tačno JEDNO konto prihoda. Nalog `236`, koji naizgled meša `6140` i `6796`, je ZBIRNI
> nalog sa tri zasebna dokumenta (`042/26` otpad bez PDV-a, `043/26` i `044/26` usluga sa
> PDV-om) — knjigovođa različite vrste već danas razdvaja u zasebne račune.
>
> **Otvoreno ostaje** samo ekran kojim knjigovođa uređuje sam šifarnik (danas SQL) —
> zapisano u `docs/OTVORENI_POSLOVI.md`, **P10**.
>
> Tekst ispod je ostavljen nepromenjen, kao zapis o tome šta je i na osnovu čega odlučeno.

Nenad: *„Spisak vrsta usluge → konto za promenljivi konto prihoda nemam da ti odgovorim.
Daj mi to detaljnije uz preporuku neku."*

Evo ga, ali **ne kao pretpostavka** — sve ispod je izmereno u knjigama za 2026.

---

## 1. Šta se stvarno dešava danas

Knjigovođa je na pitanje 2 rekao: *„usluge se knjiže ručno (2040 / 4703 / 6140 ili 6796 ili
6501). Knjiže se ručno zato što se u zavisnosti od prometa menja i konto 6. Takođe se kod
knjiženja usluga menja i poresko oslobođenje."*

Izmereno nad glavnom knjigom (promet 2026, potražna strana):

| konto | naziv u kontnom planu | stavki | promet |
|---|---|---|---|
| **6140** | Prihodi od prodaje usluga na domaćem tržištu | 45 | 18.273.557,50 |
| **6151** | Prihodi od prodaje usluga na inostranom tržištu | 2 | 2.490.465,79 |
| **6796** | Naknadno utvrđeni vanr. prihod **OTPAD**, čl. 10 st. 2 t. 1 | 10 | 1.222.645,05 |
| 6501 | Prihodi od **zakupa poslovnog prostora** | **0** | — |

**Ključno zapažanje: to nisu „razna konta", nego ČETIRI različite poslovne situacije.** I
rečenica „menja se i poresko oslobođenje" nije usput — ona je **posledica** iste podele:

| situacija | konto | PDV |
|---|---|---|
| usluga domaćem kupcu | 6140 | 20 %, konto **4703** |
| usluga stranom kupcu | 6151 | bez PDV-a — čl. 12 st. 3 (mesto prometa van RS) |
| **prodaja otpada** | 6796 | **PDV ne obračunavamo mi — obveznik je PRIMALAC** (čl. 10 st. 2 t. 1) |
| zakup poslovnog prostora | 6501 | 20 %, konto 4703 |

Treći red je razlog zbog kog ovo ne sme da ostane „slobodan unos konta": kod otpada se PDV
**ne obračunava na našoj fakturi** — kupac ga sam obračunava. To nije izbor konta nego
drugačiji poreski tretman, i na papiru mora da stoji napomena.

Doneti papir to potvrđuje: `IFUSL 653/25` glasi doslovno **„Zakup poslovnog prostora za
Decembar 2025"** — dakle četvrta situacija postoji, samo u 2026. nije bilo prometa
(konto 6501 ima nulu, a taj račun je iz 2025. i nije u uvezenoj knjizi).

---

## 2. PREPORUKA

**Ne pitati korisnika za konto. Pitati ga ŠTA PRODAJE, a konto i PDV izvesti iz toga.**

Uvodi se mali šifarnik **„Vrsta usluge"** — četiri reda, uređuje ga knjigovođa kroz
Podešavanja (isti ekran kao pravila kontiranja):

| šifra | naziv koji vidi komercijala | konto prihoda | PDV | napomena na fakturi |
|---|---|---|---|---|
| `USL` | Usluga (domaće tržište) | 6140 | 20 % → 4703 | — |
| `USL-INO` | Usluga stranom kupcu | 6151 | bez PDV-a | „PDV nije obračunat u skladu sa članom 12. stav 3 Zakona o PDV — mesto prometa usluge je van teritorije Republike Srbije" |
| `OTPAD` | Prodaja otpada | 6796 | **obveznik je primalac** | „PDV nije obračunat — poreski dužnik je primalac dobara, član 10. stav 2. tačka 1. Zakona o PDV" |
| `ZAKUP` | Zakup poslovnog prostora | 6501 | 20 % → 4703 | — |

Na uslužnom računu se bira **vrsta usluge** (podrazumevano `USL`), a sistem sam upisuje
konto, poreski tretman i napomenu. Komercijala ne mora da zna nijedan konto.

### Zašto baš tako

- **Konto i porez idu zajedno.** Da se bira samo konto, neko bi pre ili kasnije izabrao
  6796 a sistem bi svejedno obračunao PDV — i faktura za otpad bi izašla sa porezom koji
  po zakonu obračunava kupac. Vezivanjem u jedan izbor ta greška postaje nemoguća.
- **Spisak je kratak i zatvoren**, jer je i posao takav: tri situacije u 2026, četvrta
  poznata iz 2025. Nije potrebno ništa šire.
- **Knjigovođa ga menja sam**, kao i pravila kontiranja (odgovor 28: „knjigovođa i
  administratori, ali da se beleži izmena").
- **Ne dira robu.** Robni računi i dalje idu kroz šeme; ovo važi samo za `IFUSL` i `IZVUS`.

### Šta ako se pojavi peta vrsta

Doda se red u šifarnik. Bez izmene koda i bez novog puštanja u rad.

---

## 3. Šta tražim da potvrdiš

1. **Ova četiri reda** — jesu li tačna i fali li nešto što se stvarno prodaje?
2. **Zakup: 6501 ili 6140?** Konto 6501 postoji u planu i zove se baš „zakup poslovnog
   prostora", ali u 2026. nema promet. Da li je zakup u međuvremenu prestao, ili se
   knjižio na 6140?
3. **Otpad — tekst napomene.** Predlog je gore; treba potvrda tačne formulacije, jer to
   ide na poreski dokument.
4. **Podrazumevana vrsta** — predlažem `USL` (domaća usluga), pošto je 45 od 57 stavki.

---

## 4. Šta se radi dok potvrda ne stigne

Ništa se ne blokira. Konto prihoda za usluge je danas konstanta `6140`, što je **tačno za
45 od 57 izmerenih stavki**. Ostaje tako dok šifarnik ne stigne — a PDV usluge je već
prebačen sa `4702` (roba) na `4703` (usluge), što je bio stvaran kvar i popravljeno je
05.08.2026.
