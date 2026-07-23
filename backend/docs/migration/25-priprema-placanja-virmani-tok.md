# Priprema plaćanja / virmani — tok iz koda (ADVANCED)

> **Status:** ANALIZA (2026-07-18, iz izvučenog VBA + action upita). Dopuna
> [21-banking-izvodi-nalozi-rekonstrukcija.md](21-banking-izvodi-nalozi-rekonstrukcija.md) (koji je
> pokrio FORMAT/EXPORT virmana i uvoz izvoda). Ovde = **selekcija dospelih obaveza, check-off,
> kreiranje naloga, status-mašina** — likvidnosno jezgro. Format naloga se NE ponavlja.

## A) Tri ekrana (KOMITENTI → …), sve nad tabelom `Virmani`

`Doc__Form_Prva maska.txt:250-274` (`IzborZaKomitente`): `Case 3→Virmani_Priprema` (Priprema),
`Case 7→UnosVirmana` (Unos), `Case 8→Pregled virmana` (Pregled).

| Ekran | Forma | Šta radi |
|---|---|---|
| **Priprema plaćanja** | `VIRMANI_Priprema` | vuče **dospele obaveze iz GK**, grupiše po komitentu/dokumentu u editabilni temp-grid, **štriklira se šta se plaća** → kreira redove u `Virmani`. Nalog ne postoji dok se ne klikne „Kreiraj naloge". |
| **Unos plaćanja** | `UnosVirmana` | ručni pojedinačni nalog (bez GK selekcije); novi slog uvek `Status=0`. |
| **Pregled plaćanja** | `Pregled virmana` | posle pripreme: **potpis** (0→1), **export** ka banci (1→2), zaključavanje, dedup, štampa. |

Priprema = masovna GK-vođena selekcija; Unos = ručni slog; Pregled = potpis+export+lock.

## B) Selekcija dospelih — TAČNA logika

Lanac: **GK potražne stavke → salda po dokumentu → filter dospelosti**.

1. **`VIRMANI_PotrazneStavkeNaKontu`** — potražne (credit) stavke: `Konto Like [Za konto]` (klasa 4
   obaveze), `Potrazuje-Duguje>0` (neizmireno), `T_Nalozi.Level Between 0 And F_NivoBaze()` (proknjiženo =
   open items presek).
2. **`VIRMANI_PotraznaSaldaNaKontu`** — agregira po (Konto, Analitička, Broj dok), i računa
   **`DatumValute = Min([Valuta dokumenta])`** po dokumentu (sentinel `#12/31/2099#` za nepotražne).
   Grupisanje: `CheckGrpPoDok=True` → red po dokumentu; False → zbirni red po komitentu.
3. **`Virmani_PregledSpremnihNalogaZaKreiranje`** (RecordSource grida) — **filter dospelosti:**
   `DatumValute <= [ValutaDoDatuma]` (header cutoff, default = danas) + opcioni `IDUKorist Like [ZaUKorist]`.

**Odgovor „kako se računa dospelost":** rok = **`[Valuta dokumenta]`** (DateTime kolona na GK stavci,
schema:1350) — offset dana je **već primenjen pri knjiženju** (na prodaji kroz „Odloženo", §E; na nabavci
dolazi sa dobavljačeve fakture). **„Dospelo ⇔ Valuta dokumenta ≤ danas" je IZRAČUNAT filter, ne
uskladišten status** — nema polja `Valuta="dospelo"` (potvrda: `DospeloINedospeloZaAnalitickuKarticu`
koristi `IIf([Valuta dokumenta]<=[DatDosp], …)`).

## C) Check-off + kreiranje naloga

- **Check-off = boolean kolona `Stampati`** u temp-tabeli `Virmani_PregledZaKreiranje` (to je „Prn" flag).
  Materijalizuje je `Virmani_PregledZaKreiranje1Korak` iz GK-salda; default = header checkbox `CheckPRN`.
- **Iznos = `PotSaldo`** (pun otvoreni saldo dokumenta). **Delimično plaćanje = ručna izmena `Iznos` ćelije**
  u editabilnom gridu (nema poseban tok).
- **Platilac** = `F_IDMaticnaSifra()` (matična firma); **primalac** = `IDUKorist` (komitent/dobavljač);
  žiro računi iz `Komitenti.[Ziro racun_1]` / `NaTeretTR`.
- **Poziv na broj `PNBOdobBroj`** = `PNBOdobBrojGK` sa GK stavke; fallback = **broj dokumenta (fakture)**
  dupli-klikom (`VIRMANI_Priprema.txt:182-185` → potvrđuje „odobrenje = broj fakture").
- **Masovno štrikliranje:** `UpisiPrnYesUPripremiVirmane` / `…No…` = `UPDATE … SET Stampati=True/False`
  nad filtriranim (dospelim) view-om.
- **Kreiranje** (`VIRMANI_Priprema.txt:255-310`): validacije → (1) bar jedan `Stampati=True`; (2) svaki
  ima PNB; (3) `ProveriTkRnPreKreiranjaVirmana` (validnost TR, `DobarTR`); (4) **DEDUP:**
  `ProveraPozivaNaBroj` spaja štriklirane sa postojećim `Virmani` po **(PNBOdobBroj, IDUKorist)** → ako
  poklapanje, blokira + `PregledDuplihVirmana` (sprečava dvostruko plaćanje fakture); (5) čisto →
  `VIRMANI_KreirajIzPregleda`.
- **`VIRMANI_KreirajIzPregleda`** — INSERT štrikliranih u `Virmani` sa **`Status=0`, `Stampati=True`,
  `Zakljucano=False`, `DPO=Date()`**.
- **Kontrola:** `Virmani_RazlikaUIznosima` — zbir pripremljenih naloga po komitentu vs otvoreni saldo
  (`Virmani_SaldoPoKomitentima`) → likvidnosna provera.

## D) Status-mašina virmana

Dve **ortogonalne** dimenzije (DDL `Virmani`@2241: `Status Long`, `Stampati Bool`, `Zakljucano Bool`, `DPO`, `DatumValute`).

**`Status` (životni ciklus):**

| Status | Značenje | Prelaz |
|---|---|---|
| **0** | Kreiran/nacrtan | INSERT iz pripreme / ručni unos (`UnosVirmana.txt:59-61`) |
| **1** | Potpisan | `PotpisiVirmane`: `UPDATE … SET Status=1 WHERE Status=0` |
| **2** | Plaćen (exportovan) | `OznaciPlaceneVirmane`: 1→2, posle upisa fajla u banku |

Guardovi (forma `Pregled virmana`): potpis samo ako filter `ZaStatus=0`; export samo ako `ZaStatus=1`
+ definisan platilac (`PregledVirmanaExport`: `Iznos<>0 AND Status=1`); posle exporta → `OznaciPlaceneVirmane`.

**`Zakljucano` (lock, nezavisno):** po slogu (`PromeniZakljucanoUVirmanu`, role `Admins`/`Otkljucavanje`),
po periodu (`Z_Zakljucaj/OtkljucajVirmaneZaPeriod`), kraj dana (`Z_ZakljucajVirmaneNaKrajuDana`). Lock
gasi `AllowEdits/Deletions`; brisanje samo nezaključanih (`Virm_ObrisiVirmane … AND Zakljucano=False`).

```
GK potražna salda (klasa 4, DatumValute<=danas) → temp grid → štrikliraj Stampati=True
   → [validacije: TR? PNB? dedup (PNBOdobBroj,IDUKorist)] → VIRMANI_KreirajIzPregleda
   → Status 0 KREIRAN → PotpisiVirmane → Status 1 POTPISAN → export+OznaciPlaceneVirmane → Status 2 PLAĆEN
   (ortogonalno: Zakljucano False↔True — slog/period/kraj dana, role-gated)
```

## E) Odloženo plaćanje (`Odlozeno placanje 1K/2K`)

**Izvor dospelosti na PRODAJNOJ strani** — računa **ponderisani prosek dana odloženog plaćanja** po
fakturi (svaka stavka pondiše se učešćem u vrednosti): `2K` = `Sum(Odlozeno*Kolicina*VP / UkVP)`.
Rezultat = offset za `[Valuta dokumenta]` izlazne fakture. **Nije raspodela na rate** — jedinstvena
ponderisana valuta. `Odlozeno` po stavci se puni iz „U roku dana" ili `R_Artikli.Odlozeno`. Zatvara
petlju sa §B: „dospelo ⇔ Valuta dokumenta ≤ danas".

## F) Veza sa saldakontima / IOS

Isti GK izvor (`T_Glavna knjiga ⋈ T_Nalozi`, `Level 0..F_NivoBaze`) = otvorene stavke:
`Sum(Potrazuje-Duguje)` obaveze (klasa 4), `Sum(Duguje-Potrazuje)` potraživanja (klasa 2). Isti
`ValutaDoDatuma` cutoff u `Virmani_SaldoPoKomitentima`, `DospelaINenaplacenaPotrazivanja`,
`DospeloINedospeloZaAnalitickuKarticu`. **Priprema plaćanja = payment-proposal nad saldakontskim
otvorenim stavkama klase 4** (vidi doc 23 §1.3 IOS).

## G) 2.0 stanje + procena

**2.0 nema ništa** od likvidnosnog jezgra: nema `Virmani`/naloga, nema GK/otvorenih stavki/ulaznih
faktura. Postoji samo `PaymentAccount` (bivši `UplatniRacuni`, schema:1167) + komitent
`paymentTermDays/paymentAccountId/paymentMethod` (schema:191-203) — šifarski temelj.

**Preduslov (blokira) — ODLUKA (Nenad, 18.07): vučemo iz GK kao postojeći sistem → put (A) pun GL.**
- **(A) Pun GL** (nalozi, GK, valuta dokumenta, saldakonti klase 4) — **izabrano**; priprema plaćanja
  čita iste otvorene stavke iz Glavne knjige kao BigBit danas. Znači **GL (doc 18) je tvrd preduslov**
  i plaćanja dolaze POSLE njega.
- ~~(B) Lakši registar obaveza~~ — odbačeno (ne replicira postojeći tok).

| Deo | MUST/SHOULD | AI-dani |
|---|---|---|
| Model `Virmani` + Status/Zakljucano/Stampati + migracije | MUST | 0.5 |
| Selekcija dospelih (salda po dok, `DatumValute<=cutoff`, grupisanje) | MUST | 1.5 |
| Priprema ekran (grid, check-off, masovno Yes/No, edit iznosa/PNB, filteri) | MUST | 2 |
| Kreiranje + validacije (TR, PNB, **dedup (PNBOdobBroj,IDUKorist)**) | MUST | 1 |
| Status-mašina (potpis 0→1, export 1→2, guardovi) | MUST | 0.5 |
| Zaključavanje (slog/period/kraj dana) + role | SHOULD | 0.5 |
| Kontrola razlike + dupli izveštaj | SHOULD | 0.5 |
| Unos plaćanja (ručni) | SHOULD | 0.5 |
| Export (format iz doc 21) + „označi plaćene" | MUST (reuse) | 0.5 |
| Odloženo plaćanje (ponderisana valuta) | COULD | 0.5 |
| **Zbir (bez GL preduslova)** | | **~8.5 AI-dana** (~23 dev-dana) |

**Kritičan rizik:** bez (A)/(B) preduslova modul je „prazan" — prvo obezbediti izvor otvorenih obaveza
klase 4. Ovo je isti preduslov kao za GL (doc 18) i IOS (doc 23 §1.3) — tri domena dele saldakonti.
