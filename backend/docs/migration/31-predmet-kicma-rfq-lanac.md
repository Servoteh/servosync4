# Predmet kao kičma lanca — RFQ kupca → predmet → dobavljač → praćenje

> **Status:** ANALIZA (2026-07-18). Dopunjuje [22](22-predmeti-domen-rekonstrukcija.md) (model predmeta)
> i [24](24-nabavka-tok-iz-koda.md) (nabavka) — fokus je isključivo na **VEZAMA i PRAĆENJU** kroz ceo
> životni ciklus („veži to sve").

**Jedna rečenica:** `IDPredmet` (PK tabele `Predmeti`) je **jedini FK koji se provlači kroz ceo
komercijalni i proizvodni lanac** — kupčev RFQ, naša ponuda (profaktura), zahtev za nabavku, upit
dobavljaču, ponuda dobavljača, narudžbenica, RN, faktura, GK — sve nosi `IDPredmet`/`IDPredmetDok` i
agregira se u jednom pregledu `PredmetiPoDokumentima`.

## A) Kupčev zahtev za ponudu — `ZahteviZaPonude` (schema:3135)

Polja: `IDZahteviPonude`, `DatumZahteva`, `RokZaPonudu`, `IDKomitent` (kupac), **`IDPredmet`**,
`PorekloZahteva` (slobodan tekst), `IDProdavac`, **`IDDokProf`** (→ naša profaktura/ponuda kupcu),
`IDDokUSL`, `IDStatus`.

**„Napravi predmet iz zahteva"** (`Doc__Form_ZahteviZaPonude.txt:200-264`): dozvoljeno ako `IDPredmet`
prazan i `Opis` popunjen → otvara `Predmeti`, `BrojPredmeta=max+1`, **kopira `IDKomitent`**, `IDVrstaPosla=1`,
pa **piše nazad** `ZahteviZaPonude.IDPredmet = Predmeti.IDPredmet` (:234) — spaja zahtev i predmet →
odmah nudi `KreirajRadniNalog(...IDPredmet)`. `IDDokProf` dvoklik → skok na profakturu (ponudu kupcu).

## B) Predmet kao čvor — mapa svih `IDPredmet` FK-ova

| Tabela | Kolona | Uloga |
|---|---|---|
| `Predmeti` (PK) | `IDPredmet` | **čvor** |
| `ZahteviZaPonude` | `IDPredmet` | kupčev RFQ |
| `T_Profakture` | `IDPredmet` | **naša ponuda kupcu** |
| `ZahteviZaNabavku` | `IDPredmetDok` | interni zahtev za nabavku |
| `SpecifikacijaZahtevaNabavke` | `IDPredmet` | stavke (`KreirajUpit`) |
| `T_UpitDobavljacu` / Stavke | `IDPredmetDok` / `IDPredmet` | upit / ponuda dobavljača |
| `T_Trebovanja` / stavke | `IDPredmet`/`IDPredmetDok` | narudžbenica |
| `RadniNalozi` | `IDPredmet` | proizvodnja |
| `T_Proizvodnja`, `T_Robna dokumenta`, `T_MagDok`, `T_Usluge dokumenta` | `IDPredmet`/`IDPredmetStavka` | dok. |
| **`T_Glavna knjiga`** | `IDPredmet` | **knjiženje nosi predmet** |

**`IDPredmet` vs `IDPredmetDok`:** zaglavlja dokumenata koriste `IDPredmetDok`, stavke/direktne tabele
`IDPredmet` — obe su ključ predmeta. U 2.0 obe → `project_id` (rename-map).

Forma `Predmeti` = komandni centar: `DugmeOtvoriPonudu` (kači profakturu), `DugmeNoviRadniNalog`,
`DugmePregledPredmetaPoDok` (traceability).

## C) Dobavljačka strana (svi koraci nose predmet)

1. **Zahtev za nabavku** (`ZahteviZaNabavku`, `IDPredmetDok`+`IDRadniNalog`) — može nastati i **iz RN**
   (proizvodnja), ne samo ručno. Stavke `SpecifikacijaZahtevaNabavke` (`KreirajUpit=True` → idu u upit).
2. **Upit dobavljaču** (`T_UpitDobavljacu`, `IDPredmetDok`, `IDTrebVeza=IDZahtevaZaNabavku`,
   `Sifra komitenta`=dobavljač). **Broj upita prefiksiran brojem predmeta** (`IDPredmetDok.broj & "-" &
   count` iz `BrojUpitaPoPredmetima`). Slanje mejlom (doc 24), štampa `UpitZaDobavljaca`.
3. **Ponuda dobavljača** = stavke upita `T_UpitDobavljacu Stavke` (`TrebKol`, `IDPredmet`, `Proizvodjaca`,
   `RokZaIsporuku`, `PrihvacenaPonuda`). ⚠️ **KOREKCIJA pretpostavke:** stavka upita **NEMA kolonu cene**
   u `BB_T_26` — hvata se količina/proizvođač/rok/prihvaćeno; **cena se materijalizuje tek u narudžbenici**
   (`T_Trebovanja stavke.Cena`). Znači „ponuda po ceni" se beleži kroz prihvatanje + prevođenje u trebovanje.
4. **Prihvatanje** (`IDStatus=1` → `UpisiPrihvacenaPonudaUSveStavkeUpita` → `PrihvacenaPonuda=True`).
5. **Narudžbenica** (`T_Trebovanja`, `IDUpita`; stavke nose `IDStavkeUpita`+`IDZahtevaZaNabavku`+`Cena`)
   → prijem → faktura (doc 24).

## D) Praćenje — „gde je predmet"

**Statusi:** `T_Statusi` (`Tabela`+`OpisStatusa` — per-dokument tip); `Predmeti.Status` Text + `NextAction`.
`PredmetiVrstaPosla`: 0 NEBITNA, 1 TRGOVINA, 2 SERVIS, 4 PROJPROZ, 5 PROIZVODNJA. **`PredmetiFaze` je
prazna/neiskorišćena** — praćenje je status-driven, ne faza-driven.

**Master pregled `PredmetiPoDokumentima`** = jedan red po predmetu, boolean „ima li dokument" po fazi
(RFQ / ponuda / profaktura / trebovanje / faktura / usluge / GK — sve LEFT JOIN na `Predmeti.IDPredmet`).
Filteri: kupac/prodavac/status/vrsta/datum. **`Sporni`** = auto-flag za zaglavljene predmete (`RokZaPonudu
< danas` a nema fakture). **Ovo je suština „veži to sve".**

```
Kupac → ZahteviZaPonude (RFQ) ─„Napravi predmet"─► PREDMET (Predmeti.IDPredmet)
                                                    ├─IDDokProf─► T_Profakture (PONUDA KUPCU)
                                                    ├──────────► RadniNalozi (proizvodnja)
                                                    └─IDPredmetDok─► ZahteviZaNabavku (iz RN ili ručno)
                                                            │ KreirajUpit=True
                                                            ▼
                                                    T_UpitDobavljacu (broj=predmet-N)
                                                            │ stavke = PONUDA DOBAVLJAČA (rok/prihvaćeno)
                                                            ▼ IDStatus=1 → PrihvacenaPonuda
                                                    T_Trebovanja (NARUDŽBENICA, cena) → prijem → faktura
   ▲──────────── sve vidljivo u PredmetiPoDokumentima (+ Sporni flag) ──────────▲
```

## E) 2.0 stanje + procena

**2.0:** `Project` = samo keš zaglavlja + proizvodni rep (`work_orders`/`tech_processes`/`part_locations`
koriste `project_id`). **Ceo pre-proizvodni komercijalni levak fali** — nema RFQ, profakture/ponude kupcu,
zahteva za nabavku, upita dobavljaču, ponude dobavljača, narudžbenice. Predmet je danas „mrtvo keš-zaglavlje".

| Stavka | MUST/SHOULD | AI-dani |
|---|---|---|
| `ZahteviZaPonude` (RFQ kupca) + „Napravi predmet" + `IDDokProf` | MUST | 2 |
| Profaktura/ponuda kupcu vezana na `project_id` (zaglavlje+status) | MUST | 2 |
| `ZahteviZaNabavku` + specifikacija (`KreirajUpit`) | MUST | 2 |
| `T_UpitDobavljacu` + stavke (prihvaćeno, veza na zahtev, prefiks broja) | MUST | 2–3 |
| **`PredmetiPoDokumentima` pregled (status po predmetu + Sporni)** | MUST | 2 |
| Narudžbenica + zatvaranje ka prijemu/fakturi + status modeli + mejl | SHOULD | 4–6 |
| **Ukupno MUST** | | **~9–12 AI-dana** |

**Veze:** ovo je „veži to sve" sloj iznad nabavke (doc 24) i profaktura (doc 26); carry-over (doc 27)
mora da **prenese kičmu** — `project_id` je već u proizvodnom core-u, ali komercijalne uzvodne tabele
lanca nisu. `PredmetiFaze` = WON'T (prazno u legacy-ju, Status polje dovoljno).
