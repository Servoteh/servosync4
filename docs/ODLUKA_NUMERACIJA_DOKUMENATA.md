# Numeracija dokumenata — odluka vlasnika, 27.07.2026

Ulazi u `PLAN_UNOS_DOKUMENATA.md`. Potvrđeno na stvarnom dokumentu: `Ponuda 0285-26.pdf`.

## 1. Formati brojeva — POTVRĐENO

| Dokument | Format | Dodela | Primer |
|---|---|---|---|
| **Ponuda** | `PN-<4 cifre>-<GG>` | **automatski** | `PN-0285-26` |
| **Ponuda — verzija** | `PN-<4 cifre>-<GG>/<n>` | automatski | `PN-0285-26/1` |
| **Profaktura** | isti brojač kao ponuda | automatski | — |
| **Profaktura usluge** | može isti brojač | automatski | — |
| **Izlazni račun** (IFR, IFUSL, IFGP) | `<broj>/<GG>` — **samo broj, bez oznake tipa** | **ručno** | `125/27` |
| **Avansni račun (AVR)** | `<broj>/<GG>` | **automatski** | `77/27` |

**Reset na početku godine** — brojač kreće od 1, godina u broju se menja.

**Verzije ponude:** sufiks `/1`, `/2`… označava reviziju iste ponude. Osnovni broj se ne menja.
To znači da ponuda nije jedan zapis nego **lanac verzija** — treba čuvati istoriju, ne prepisivati.

**Zajednički brojač:** ponuda + profaktura + profaktura usluge dele **jedan** niz.

## 2. Ručni broj izlaznih računa — i zašto

`IFR` (roba), `IFUSL` (usluge), `IFGP` (gotov proizvod) dele **jednu zajedničku seriju**, broj se
kuca ručno. Poklapa se sa nalazom studije: knjigovodstvo sve izlazne tipove vodi u jedinstvenom
godišnjem nizu (`001/25 … 486/25`).

**Razlog zašto automatizam nije radio u BigBitu** (rečeno doslovno):
> „u BigBitu smo fakture mogli da pravimo tipa za 7 dana — da napravimo današnju fakturu pod ovim
> datumom, pa nismo mogli brojeve baš da fiksiramo"

Dakle: račun se pravi **unapred ili unazad u odnosu na datum**, pa redosled brojeva ne prati redosled
unosa. Automatski brojač koji dodeljuje „sledeći" pri snimanju bi napravio niz koji se ne slaže
sa datumima.

**Vlasnik je otvoren za automatizam** ako se to reši. Predlog za razmatranje:
- brojač po **datumu dokumenta**, ne po trenutku unosa — pri snimanju sistem ponudi prvi slobodan
  broj koji poštuje hronologiju, i **upozori** ako bi unos napravio broj van redosleda
- ili: rezervacija broja unapred (korisnik „uzme" broj pa ga popuni kasnije)
- u svakom slučaju ručni upis ostaje moguć kao izlaz

## 3. Šta sistem radi uz ručni broj

- **Jedinstvenost** — isti broj ne može dvaput; poruka imenuje postojeći dokument
- **Predlog sledećeg slobodnog** iz zajedničke serije (BigBit ima isto dugme)
- **Upozorenje na preskočen broj** — ne blokira (poreski niz je knjigovodstvena odgovornost)
- **Zaključan posle knjiženja**

## 4. AVR — traži zasebnu detaljnu analizu

Vlasnik izričito: *„za AVR isto detaljna analiza mora da bude — kako ih pravimo i pišemo,
vezani su za PDV direktno."* Analiza je pokrenuta zasebno; rezultat ide u
`docs/PLAN_AVANSNI_RACUNI.md`.

---

# Ponuda — polja i izgled (sa stvarnog dokumenta `PN-0285-26`)

Ovo je referenca i za **ekran unosa** i za **štampu**.

## Zaglavlje firme (fiksno)
Logo Servoteh · ISO 9001 sertifikat · adresa, telefoni, fax, e-mail, web · **Tekući račun: 160-110610-83**

## Kupac
Naziv · adresa (poštanski broj, mesto, ulica) · **PIB** · **MB**
**Kontakt osoba kupca:** ime · telefon · fax · e-mail

## Zaglavlje dokumenta
`Ponuda br. PN-0285-26` · **Datum dokumenta** `24-07-26` (format DD-MM-GG) · **Valuta** `24-07-26`

## Traka uslova — pet polja u jednom redu
| Roba je FCO | Način plaćanja | Način otpreme robe | Mesto izdavanja računa | Datum prometa |
|---|---|---|---|---|
| magacin kupca | 30 dana | aks | Beograd | 24-07-26 |

## Tabela stavki
`R.br.` · `PDV` (stopa, npr. 20%) · `Kataloški br.` · `NAZIV ROBE` · `j.m.` · `Količina` · `CENA` · `VREDNOST`

## Zbirovi
Međuzbir · **Vrednost bez PDV (osnovica)** · **PDV po stopi 20% × osnovica = iznos** ·
**Za uplatu (DIN)** — uokvireno, podebljano

## Slobodan tekst ispod stavki
`Opcija ponude 15 dana.` · `Rok isporuke: 4-6 nedelja.`
→ dva polja koja se kucaju po dokumentu (ili se pamte kao podrazumevana)

## Potpis
`Odgovorno lice` + ime (`Dragana Madjerčić`) — iznad linije za potpis

## Podnožje
Logotipi partnera (AVENTICS, Rexroth/Bosch, ABB, SKF, CASAPPA, MP FILTRI) ·
Matični broj · Registarski broj · Šifra delatnosti · PIB · tekst o APR upisu · **QR kod (google mapa)**

## Zapažanja za plan
1. **Datum je DD-MM-GG** (`24-07-26`), ne `dd.MM.yyyy.` kako nalaže naš DESIGN_SYSTEM za ekrane.
   Na štampi treba poštovati zatečeni oblik; na ekranu ostaje naš.
2. **„Datum prometa" je zasebno polje** — ne izvodi se iz datuma dokumenta.
3. **Kontakt osoba kupca sa telefonom, faksom i mejlom** ide na dokument — mora postojati u šifarniku.
4. **Logotipi partnera u podnožju** — treba ih čuvati kao podesivu sliku, ne tvrdo u kodu.
5. **QR kod** vodi na google mapu firme.
6. PDV se prikazuje **po stopi**, sa ispisanim računom `stopa × osnovica = iznos`.

---

# EKRAN UNOSA MORA DA LIČI NA PAPIR — odluka vlasnika, 27.07.2026

> „I VIDIŠ I VELIČINU POLJA, ŠTA SE VIDI I KAKO IZGLEDA — DA FORMA BUDE SLIČNA PONUDE TJ ŠTAMPA PDF!"

Ovo je **glavno pravilo dizajna** ekrana unosa, iznad svih ostalih: korisnik gleda isti raspored
na ekranu i na papiru. Ne „moderan" raspored — **isti** raspored.

## Zašto je to ispravno

Ljudi rade 15 godina naslepo. Kad ekran ima isti redosled i iste širine kao odštampan dokument,
provera se radi očima bez čitanja: „ovde ide kataloški, ovde količina, ovde cena". Greška se vidi
kao **oblik**, pre nego kao pogrešan broj.

## Izmerene proporcije tabele stavki (iz `PN-0285-26`)

Merenje pozicija kolona na štampi (znakovna mreža `pdftotext -layout`, ukupna širina ~150):

| Kolona | Početak | Širina | Udeo | Poravnanje |
|---|---|---|---|---|
| R.br. | 0 | 6 | 4 % | centar |
| PDV | 6 | 15 | 10 % | centar |
| Kataloški br. | 21 | 31 | 21 % | levo |
| **NAZIV ROBE** | 52 | 47 | **31 %** | levo |
| j.m. | 99 | 7 | 5 % | centar |
| Količina | 106 | 15 | 10 % | desno |
| CENA | 121 | 18 | 12 % | desno |
| VREDNOST | 139 | 11+ | 7 % | desno |

**Naziv robe je najšira kolona (31 %)** — to je i najvažniji podatak za prepoznavanje. Kataloški
broj drugi po širini. Brojčane kolone desno poravnate, `tabular-nums`.

## Raspored ekrana — preslikan sa papira

```
┌─────────────────────────────────────────────────────────────────────┐
│  [logo]  Servoteh d.o.o. …  adresa, tel, e-mail, web      [ISO]     │  ← fiksno zaglavlje
│                    Tekući račun: 160-110610-83                      │
├──────────────────────────────┬──────────────────────────────────────┤
│  K u p a c:                  │        Ponuda br. PN-0285-26         │  ← broj DESNO, veliko
│  ┌────────────────────────┐  │        Datum dokumenta: 24-07-26     │
│  │ Naziv                  │  │        Valuta:          24-07-26     │
│  │ Poštanski broj, mesto  │  │                                      │
│  │ Ulica                  │  │                                      │
│  │ PIB  -  MB             │  │                                      │
│  └────────────────────────┘  │                                      │
│  Kontakt: ime   Tel:         │                                      │
│  Fax:     e-mail:            │                                      │
├──────────┬─────────┬─────────┴────┬──────────────┬──────────────────┤
│ Roba FCO │ Nač.pl. │ Nač. otpreme │ Mesto izdav. │  Datum prometa   │  ← traka uslova, 5 polja
├──────────┴─────────┴──────────────┴──────────────┴──────────────────┤
│ R.br │ PDV │ Kataloški br. │ NAZIV ROBE │ j.m │ Kol │ CENA │ VREDN. │  ← grid, iste širine
│  ...                                                                │
├─────────────────────────────────────────────────────────────────────┤
│                        Vrednost bez PDV (osnovica):      28.935,00  │
│                        PDV po stopi 20% × 28.935,00 =     5.787,00  │
│                        ┌──────────────────────────────────────────┐ │
│                        │ Za uplatu (DIN):            34.722,00    │ │  ← uokvireno
│                        └──────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│  Opcija ponude 15 dana.                                             │  ← slobodan tekst
│  Rok isporuke: 4-6 nedelja.                                         │
│                                        Odgovorno lice: ___________  │
└─────────────────────────────────────────────────────────────────────┘
```

## Pravila koja iz toga slede

1. **Iste kolone, isti redosled, iste relativne širine** na ekranu i na papiru.
2. **Zbirovi na istom mestu** — dole desno, sa „Za uplatu" uokvirenim i podebljanim.
3. **Broj dokumenta gore desno**, krupno — kao na papiru.
4. **Blok kupca gore levo, uokviren** — uključujući PIB i MB u istom redu.
5. **Traka uslova kao red od pet polja**, ne kao rasuta polja po formi.
6. **Slobodni tekstovi ispod stavki**, tačno gde su i na papiru.
7. **Pregled pre štampe nije potreban** — ekran JESTE pregled. Dugme „Štampaj" samo pravi PDF
   od onoga što korisnik već vidi.
8. Polje na ekranu je **onoliko široko koliko podatak zauzima na papiru** — ako naziv robe staje
   u 31 % širine na papiru, toliko dobija i na ekranu. Bez „širokih polja za svaki slučaj".

## Šta se NE preslikava

- Podnožje sa logotipima partnera i QR kodom ide samo na štampu, ne na ekran unosa.
- ISO oznaka i pun blok podataka firme na ekranu mogu biti skraćeni (jedan red), jer se ne menjaju.
