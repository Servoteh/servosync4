# Skriveni UI sloj — desni klik, štampa-varijante, prečice, dupli-klik

> **Status:** ANALIZA (2026-07-18, iz izvučenih formi/makroa). „Mišićna memorija" iskusnih korisnika —
> nevidljivo na screenshot-u, ali ako fali u 4.0, sistem se **oseti kao gori** (svaka radnja 1 gest →
> 3-4 klika). Ovo je UX-kritičan sloj, ne data.

**Ključni nalaz:** desni klik **NIJE** VBA `MouseUp Button=2` (nigde u ~420 formi). Skriveni sloj stoji
na 4 stuba: (1) Access `ShortcutMenuBar` po koloni, (2) globalni `BBTools` panel (Ctrl+F3), (3) `AutoKeys`
globalne prečice, (4) `DblClick` konvencije.

## A) Kontekst meniji (desni klik)

- **Per-kolona `ShortcutMenuBar`** (produkcioni QBigTehn): `LokacijaNapravljenihDelovaZag.txt` ima 6
  menija na 6 kolona (IDRN, NazivDela, NazivKomitenta, IdentBroj, BrojCrteza…); `Lager lista.txt`→
  `ReportiLagerListe`. ⚠️ **Sadržaj menija je Access CommandBar u `.mdb` — NIJE izvezen.** → otvorena
  tačka: pročitati te menije iz `.mdb` pre finalne spec (`ReportiLagerListe`, `Broj crteza`…).
- **BBTools panel (Ctrl+F3)** = de-facto univerzalni desni-klik nad aktivnom formom: Filter po vrednosti /
  Filter bez vrednosti / Poništi filter / Sort A-Z / Z-A / Export XLS / Pošalji mail / SPEC. **Ovo je
  spisak akcija koje SVAKI grid u 4.0 mora imati.**
- **Access default** (Filter by Selection/Excluding, Sort, Remove Filter) — korisnici masovno koriste;
  u web app-u NE postoji → mora se namerno ugraditi (najtiši regres ako se izostavi).

## B) Štampa-varijante (nema jednog „dropdown-a")

Varijanta se bira kombinacijom: **(a) koje dugme, (b) na kom tabu, (c) `Specijal` firme, (d) da li custom
report postoji**.

**Sistem „Specijal"** — ista dugmad štampaju fizički drugi report po firmi: `InicSPECIJAL()` puni
`ImeFakture/ImeOtpremnice/ImeIzjave` + broj kopija; `PostojiReport(X)` → custom ili fallback `X - DEFAULT`.

**Izlazna faktura** — ~15 zasebnih print dugmadi: račun (`ImeFakture`), otpremnica (`ImeOtpremnice`,
fallback faktura sa naslovom „Otpremnica"), prazna faktura/izjava, KLIF kalkulacija, **„Printuj SVE"**
(petlja N kopija faktura+otpremnica+izjava), faktura sa avansima, KNG, MP račun, prenosnica, PRIF loši
artikli… Otpremnica **sa cenama** (`Otpremnica - ABB`) vs **bez cena** (`OtpremnicaBezCena`) = zasebni reporti.

**Radni nalog** (`UnosRN.txt:3433-3451`) — glavni print dugme štampa report **po AKTIVNOM TAB-u**:
tab0→`rRN` (sa barkodom), tab1→`rRN_tPND`, tab2→`rRN_tPDM`, tab3→`rRN_tPLP`, tab4→`rRN_tKomponente`,
tab5→`rRN_tNDKomponente`; + dugme „Sa skicama"→`rRN_SaSlikama`; varijanta `rRN_BezBarKoda`.

→ **4.0 mora imati eksplicitan „Štampaj kao…" izbor:** varijanta RN-a (std/sa slikama/bez barkoda/po
komponentama), cene da/ne, jezik (INO), broj kopija, per-firma layout (Specijal + DEFAULT fallback).

## C) Prečice (globalne AutoKeys)

| Prečica | Akcija | | Prečica | Akcija |
|---|---|---|---|---|
| F3 | izbor artikla | | Ctrl+F3 | **BBTools** (filter/sort/export panel) |
| F6 | zalihe artikla pod kursorom | | Ctrl+I | BBInfo (dijagnostika) |
| F10/F12 | fiskalna fioka / štampa (kasa) | | Ctrl+K | OK_Start (kamate) |
| Ctrl+D | Digitron (kalkulator) | | Ctrl+M | OP_Start |
| Ctrl+E | BBMail | | Ctrl+B | BBAll (admin, samo „Negovan") |
| Ctrl+L | SetNivoBaze | | Ctrl+7/8/9 | SQL skripte / CFG / QueryDef (dev) |
| Ctrl+3/4 | prevod forme SRP/ENG | | Ctrl+Z | Zaključavanje |

**Per-forma:** Enter=prenesi+zatvori, Space=inkrementalna pretraga; F-tasteri kase aktivni samo kad je
`MPRacun` otvoren. Za 4.0 (srednji prioritet): bar F3 (izbor artikla) i F6 (zalihe pod kursorom) su
svakodnevni u unosu stavki.

## D) Dupli-klik konvencije (sistematske — korisnici znaju napamet)

1. **Dvoklik na filter/datum polje = obriši filter (`=Null`)** ili postavi danas — desetine polja
   (`APGK.txt:36-58`, `AG_SaldaAnalitike`…).
2. **Dvoklik na ćeliju/red = drill-through** (filter roditelja / otvori karticu konta/komitenta/dokumenta).
3. **Dvoklik na header = toggle skrivene kolone** (npr. interni `StavkaID`).
4. Ostalo: dvoklik na combo otvara vezanu formu (Predmeti/Magacini/RadniNalozi…), na kurs→popuni iz
   kursne liste, na barkod→clipboard, na komitenta→preuzmi cenu.

→ **4.0 visok prioritet:** svaki filter chip = brzo brisanje (dvoklik i „x"); svaki red u pregledu =
drill-through; combo polja = dvoklik na vezanu formu.

## E) Role/status-uslovna (skrivena) dugmad

- **`Level` polje** vidljivo samo ako `F_NivoBaze()>0` (iz `BBDefUser.Level` po korisniku) — obični ne vide.
- **Zaključan dokument** (`Zakljucano=True`): forma menja boju (`C_LockColor`), `AllowEdits/Deletions=False`,
  gasi „proknjiži" dugmad (`Enabled=False`). → lock mora **vizuelno i funkcionalno** gasiti akcije
  (zaključan dok koji izgleda editabilno = izvor grešaka).
- **Kasa mod:** ista forma `MPRacun` menja UI po kontekstu (krije kupca, uključuje DataEntry, zaključava datum).
- **Admin alati:** BBTools (Ctrl+F3), BBInfo (Ctrl+I — Record/Control source, prava pristupa, obračun cena),
  BBAll (Ctrl+B, samo „Negovan").

## F) Za 4.0 — šta MORA da se replicira (prioritet)

**Visok:**
1. Dvoklik-na-filter = obriši; dvoklik-na-red = drill-through (najdublja navika).
2. **Grid akcije na svakoj tabeli** (kolonski/desni meni): filter po/bez vrednosti, sort, export Excel,
   mail — to je bio BBTools na svakom gridu.
3. Štampa RN sa varijantama (std/skice/bez barkoda/po komponentama) — eksplicitan izbor.
4. Otpremnica/faktura: sa cenama / bez / INO / kopija-original / N kopija.
5. Per-firma layout (Specijal + DEFAULT fallback) — Servoteh ima brendirane dokumente.
6. Role-uslovni UI: lock → read-only + siva dugmad; `Level` vidljivost.

**Srednji:** power-user prečice (F3/F6), per-kolona kontekstni meniji (crtež/predmet/komitent/RN —
sadržaj izvući iz `.mdb`).

**Rizik:** desni klik je delom bio Access-default koji korisnici koriste nesvesno; u web 4.0 ne postoji
→ mora se namerno ugraditi, inače najtiši i najbolniji regres.

## Otvorena tačka
Per-kolona `ShortcutMenuBar` sadržaj (CommandBar-ovi `ReportiLagerListe`, `Broj crteza`, `Personalna
administracija`, `Dimenzija materijala`) — u `.mdb`, nije u tekst-izvozu. Izvući iz Access-a pre finalne
UX spec da se ne izgubi.
