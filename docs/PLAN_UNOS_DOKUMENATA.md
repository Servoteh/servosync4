# PLAN — UNOS DOKUMENATA NA PUNOM EKRANU (4.0)

> Datum: 28.07.2026. · Grana: `feat/4.0-bigbit-nocni-sync` · Status: **plan, ništa nije implementirano**
> Povod: zahtev vlasnika — „PREDRAČUN treba da se pravi u novom celom ekranu, ne u popupu… ovo važi
> i za SVE ostale dokumente… mora biti POUZDANO… mnogo ima detalja koje mi u BigBitu unosimo kod
> profakture — od kursa ako je cena u EUR do koeficijenta kojim množimo sve, pa uslova plaćanja,
> pariteta isporuke…"

## 0. Izvori i oznake

**BigBit izvorni kod** (koren: `_legacy/BigbitRaznoNenad/_extracted/`):
- `OnLine_BigBit_VBA/` — 527 formi kao VBA tekst. Citira se `Fajl.txt:red`, bez prefiksa foldera.
- `OnLine_BigBit_Design/` + `queries_full/OnLine_BigBit_APL/` — 498 upita i izveštaja.
- Podaci: `BB_T_25.MDB` (istorija 2011–08/2025) i `BB_T_26.mdb` (živa baza) preko
  `ssh ubuntusrv "docker run --rm -v /tmp/bb26:/d mdbtools:local mdb-export /d/… '<tabela>'"`.
- Naš kod: `backend/prisma/schema.prisma`, `backend/src/modules/**`, `frontend/src/**`.

**Legenda obaveznosti** u matricama (§3):

| Ozn. | Značenje |
|---|---|
| **O** | obavezno — bez njega se dokument/stavka ne snima (poruka + fokus na sporno polje) |
| **U** | uslovno obavezno (npr. kurs kad valuta ≠ RSD) |
| **A** | automatski predlog — sistem popuni, korisnik **sme** da prekuca |
| **AZ** | automatski i zaključan — menja se samo uz posebno pravo |
| **P** | opciono — prazno je legitimno; nikad ne izmišljati podrazumevanu vrednost |

**Legenda stanja u našoj bazi**: ✅ POSTOJI (navedena tačna kolona) · ⚠️ postoji ali na pogrešnom
modelu / sa pogrešnim značenjem · ❌ TREBA DODATI (svako ❌ se ponavlja u §5 sa tipom kolone).

---

## 1. Šta menjamo i zašto (za vlasnika, pet rečenica)

1. Danas se svaki dokument u 4.0 unosi kroz mali iskačući prozor u kome se kupac, artikal i magacin
   **kucaju kao goli interni brojevi**, cena i PDV se ne vide dok se ne snimi, Enter prerano pošalje
   formu, nepotpune stavke se tiho izgube, a **kreiran dokument se posle ne može ispraviti** — otud
   utisak „ofrlje".
2. Gradimo **jedan pun ekran dokumenta** (zaglavlje gore, tabela stavki u sredini, zbirovi zakucani
   dole, veze i akcije desno) koji opslužuje **sve vrste** — predračun, ponudu, račun, ino fakturu,
   fakturu usluga, revers, porudžbenicu, ulaznu kalkulaciju — tako što se vrsta dokumenta ne pravi
   kao poseban ekran nego kao **red u registru vrsta**, tačno kao u BigBitu.
3. Vraćamo BigBit ritam kucanja: kucaš šifru → Enter povuče naziv, cenu iz cenovnika, rabat, PDV i
   zalihe → kucaš količinu → Enter → red se sam snimi i otvori se sledeći, bez ijednog klika mišem.
4. Vraćamo i sve „detalje" koji danas ne postoje nigde: kurs sa vidljivim poreklom, uslove plaćanja,
   paritet isporuke (FCO), rok i datum valute, predmet i radni nalog, PO broj kupca, devizni račun sa
   IBAN/SWIFT instrukcijama, klauzulu poreskog oslobođenja i masovne akcije nad svim stavkama.
5. Pouzdanost ide ispred izgleda: dokument nastaje odmah kao nacrt, svaka stavka se snima čim se
   napusti red, prekid mreže ne gubi rad, dvoklik na „Snimi" ne pravi dva dokumenta, greška se javlja
   **u trenutku nastanka** sa porukom šta uraditi — a ne ćutanjem.

---

## 2. EKRAN UNOSA

### 2.1 Osnovna odluka — jedan ekran-školjka, konfigurisan registrom vrsta

BigBit **nema 57 ekrana za 57 vrsta dokumenata**. Ima jedan skelet (zaglavlje → mreža stavki →
zbirovi → veze/prepis) koji tabela `R_Vrste dokumenata` konfiguriše: numeracija i prefiks,
podrazumevani magacin, šema kontiranja, PDV knjige, KEPU, naslov na štampi, da li utiče na zalihe.
Izbor vrste na formi jednim potezom postavlja broj, magacin i cenovnik
(`Doc__Form_Izlazna faktura.txt:900-921`; `Doc__Form_Ulazna faktura.txt:549-562`).

**ODLUKA:** gradimo **jedan React ekran** (`DocumentScreen`) u tri profila iste školjke:

| Profil | Vrste | Stavka |
|---|---|---|
| **P1 ROBNI** | UFROB, UFMAT, UVOZ, IFR, IFGP, PON, PROF, OTP, REZR, REZM, TREB, TREB1, MMPM/MMPR, REV | artikal iz šifarnika + magacin + zalihe + cenovnik |
| **P2 USLUŽNI** | IFUSL, IZVUS, AVR, PON/PROF u uslugama, ZAP | bez artikla: grupa + slobodan višeredni opis |
| **P3 NABAVNI** | porudžbenica (naručivanje), upit dobavljaču | artikal ili opis, bez zaliha, naručeno vs isporučeno + rok |

Ino, avans, izvoz, rezervacija i reizdavanje **nisu profili nego slojevi** nad profilom, koje pali
registar vrsta. BigBit to dokazuje: **ne postoji forma „Ino faktura"** — koristi se ista forma
Izlazne fakture, a ino karakter nose tri polja zaglavlja (valuta, kurs, Fco) plus izbor engleskog
obrasca štampe (`Doc__Form_Profaktura.txt:379-406,463`; `InoFakturaEng.txt` RecordSource).

**Pravilo za implementaciju:** ni jedan `if (documentType === 'IFR')` u ekranu. Nova vrsta = nov red
u registru, bez izmene frontenda. Ako se registar ne proširi pre ekrana, dobićemo 12 poluekrana
skrivenih u granama koda — tj. tačno ono na šta se vlasnik žali.

**Posledica za postojeći kod:** `fakturisanje/new-proforma-dialog.tsx`,
`robno/new-document-dialog.tsx`, `nabavka/new-request-dialog.tsx` prestaju da budu mesto unosa. Ostaju
najviše kao prečica koja odmah otvara pun ekran sa prepopunjenim poljima. To je i po važećem pravilu
(`frontend/docs/DESIGN_SYSTEM.md` §4: kratke forme ≤8 polja u dijalogu, **duge kao stranica sa
sekcijama**) — dokument sa stavkama je nesporno duga forma.

**Profil P2 (`screen_kind = 'SERVICE'`) — šta se tačno menja** *(odluka §8/O4 od 28.07.2026)*

BigBit uslužnu fakturu ne drži kao varijantu robne nego kao **zaseban ekran nad zasebnim tabelama**:
`T_Usluge dokumenta` (41 kolona) + `T_Usluge stavke` (14 kolona), naspram `T_Robna dokumenta` (61) +
`T_Robne stavke` (37) — `_legacy/_analiza/bigbit/BB_T_26_schema.sql:2086-2129, 2142-2158` i
`:1852-1915, 1917-1955`. Mi zadržavamo **jednu tabelu i jedan ekran**, a razliku nosi profil:

| Šta | P1 `GOODS` | P2 `SERVICE` |
|---|---|---|
| kolona Artikal (kat.broj / barkod / ext. šifra / PLU) | ima, obavezna | **nema je uopšte** — prve dve kolone su Grupa i Opis |
| Magacin, zalihe, rezervisano, nabavna cena, RUC | ima | **nema** (uslužna stavka nema `IDMagacin` ni šifru artikla) |
| Opis | snapshot naziva artikla, prekucljiv | **glavno polje**: višeredno, `Text`, sa autocomplete-om ranije korišćenih opisa |
| Jedinica mere | iz artikla | ručno (BigBit `Jedinica mere Text(3)`) |
| unos cene | bez PDV | bez PDV **ili** sa PDV (dvosmerno, §3.4) |
| provera zaliha | po vrsti (`stock_check`) | uvek isključena |
| zaglavlje: Mesto prometa, Zapisnik, Tekst za fakturu | nema | ima (§3.5, §5.3) |
| radni nalog | opciono | **obavezno** (`requires_work_order`) |
| štampa | Račun / Otpremnica | Račun **+ zaseban Zapisnik** (§3.5) |

Kolone se **ne prikazuju sive nego ih nema** — inače operater tabom prolazi kroz mrtva polja. Ali
profil je **podrazumevan, ne tvrdo pravilo po vrsti**: v. §8/O4.5 (u BigBitu osam dokumenata prelazi
granicu tabele, uključujući `IFGP 068/26` iz tekuće godine unet kao uslužni), zato zaglavlje nosi
prekucljivu kolonu `line_profile`.

### 2.2 Raspored — pet zona

Stranica je visine `100dvh` unutar `AppShell`-a. **Na desktopu se stranica ne skroluje globalno** —
skroluje samo tabela stavki, da zbir i zaglavlje ostanu vidljivi dok se kuca.

- **ZONA 0 — komandna traka** (56 px, sticky): levo „← Nazad na listu" + naslov
  („Predračun PN-0142/26 · Milanović doo") + `StatusBadge`. Desno: indikator snimljenosti
  („Sve snimljeno 14:12" / „Snimam…" / crveno „3 neposlate izmene"), pa **Snimi (Ctrl+S)**,
  **Štampaj (Ctrl+P)**, **Prepiši u…**, pa `⋯` (Knjiži, Zaključaj, Storniraj, Pošalji na SEF,
  Istorija izmena, Duplikuj). Tu je i polje **„Pronađi dokument"** (§2.3).
- **ZONA A — zaglavlje** (kartica, 2 reda u 4 kolone na ≥1440 px):
  red 1 = Komitent (2 kolone) · Vrsta dokumenta · Broj dokumenta;
  red 2 = Datum dokumenta · Datum knjiženja · U roku dana ↔ Datum valute · Valuta + Kurs.
  Ostalo (magacin, predmet, RN, prodavac, način otpreme, paritet/FCO, uslovi plaćanja, način
  plaćanja, kontakt osoba, devizni račun, PO broj kupca, napomena) ide u sklopivi deo **„Više polja"**
  (`Ctrl+Shift+Z`), razvijen pri prvom otvaranju vrste, stanje se pamti po vrsti u `localStorage`.
- **ZONA B — traka iznad tabele** (36 px): „+ Nova stavka (Insert)", brojač stavki, prekidač ključa
  pretrage artikla (čipovi `Kat.broj | Barkod | Ext.šifra | PLU`), „Skener", „Kolone", i za robne
  vrste čipovi aktivnog magacina i **cenovnika** (cenovnik je klikabilan).
- **ZONA C — tabela stavki**: zaglavlje kolona `sticky`, red 34–36 px, `tabular-nums`. Prva kolona =
  Rb + tačka statusa reda (snimljen / šalje se / nije prošao), poslednja `⋯` (Obriši, Dupliraj,
  Kartica artikla, **Istorija prodaje ovom kupcu**, Cenovnik).
- **ZONA D — futer zbirova** (`sticky bottom`, 48 px): Osnovica · Rabat · PDV po stopama kao čipovi
  („20%: 12.480,00") · **UKUPNO** (najkrupnije) · desno „u valuti: 8.410,50 EUR". Uvek vidljiv, i na
  praznom dokumentu. BigBit isto drži živ zbir u podnožju mreže (`Doc__Form_Izlazna faktura -
  Podforma.txt:13,24` — kontrole „Zbir stvarne VP vrednosti" i „Vrednost sa porezom", koje glavna
  forma čita iz koda, npr. `Doc__Form_Izlazna faktura.txt:1207-1208`).
- **ZONA E — desna kolona „Veze i akcije"** (288–320 px, samo ≥1440 px): masovne akcije, panel
  prepisa (izvorni i izvedeni dokumenti), avansi, SEF status, prilozi, „Poslednja izmena: …".
  Ispod 1440 px seli se u bočni panel na dugme.

**Kalibracija visine — bitna ispravka.** Merenje na `BB_T_26.mdb` za 2026 (20.438 robnih stavki /
1.858 dokumenata): **medijana = 1 stavka po dokumentu, p90 = 7**. IFR: prosek 1,7 / medijana 1 /
p90 3 / max 19. UFROB: prosek 3,4 / medijana 1 / p90 6. UVOZ: medijana 4 / p90 16. Jedini dugački
dokument je **TREB1 (medijana 49, p90 756, max 765) — ali ih je 19 godišnje.**
Zaključak: tabela u V1 ne treba virtuelizaciju ni agresivno sažimanje zaglavlja; **težište je
zaglavlje i prvi red**, jer se tu provede većina vremena. Sažimanje zaglavlja ostaje kao ponašanje
(korisno na 768 px laptopu i na trebovanju), ali nije kritični put.

### 2.3 Rute i tok (Next.js static export)

Frontend je `output: export` — dinamički `[id]` segmenti vraćaju 404 na produkciji. Zato:

- `/dokumenti/novi?vrsta=PON` — nov dokument (statička ruta, parametar iz query-ja).
- `/dokumenti/detalj?id=N` — postojeći dokument, **isti React ekran**, dva režima.

Parametar se čita mehanizmom koji već imamo — `frontend/src/lib/use-id-param.ts` (čita
`window.location`, `popstate` slušalac, stroga validacija, `go(nextId)` bez remounta). Dopuniti
`useParamStr(name)` sa istom logikom i validacijom `^[A-Z0-9]{2,8}$` za vrstu.

**Dolazak na ekran:** sa liste dugme „Novi dokument" (`Alt+N`) → paleta vrsta iz registra, filtrirana
pravima, sa „Nedavno korišćene" na vrhu i kucanjem po kodu; Enter → `/dokumenti/novi?vrsta=PON`. Ako
korisnik ima samo jednu dozvoljenu vrstu, izbor se preskače. Enter/dvoklik na redu liste →
`/dokumenti/detalj?id=N`.

**Prelaz novi → postojeći (ključno za pouzdanost):** čim zaglavlje ima minimum (vrsta + komitent +
datum), ekran **tiho kreira nacrt** na serveru i radi `router.replace('/dokumenti/detalj?id=N')` —
`replace`, ne `push`, da „Nazad" ne vrati na prazan `/novi`. Fokus se ne pomera. To je prevod BigBit
ponašanja gde je forma vezana za tabelu i dokument postoji od prvog polja
(`Doc__Form_Izlazna faktura.txt:266-280` — „Novi dokument" = `GoToRecord NEWREC` + fokus na šifru
komitenta).

**Navigacija po dokumentima bez izlaska na listu.** BigBit forma se otvara na **poslednjem**
dokumentu, sa fokusom u polju „Pronađi dokument", a dvoklik na labelu prebacuje pretragu
broj ↔ opis (`Doc__Form_Izlazna faktura.txt:715-739, 784-811`). Korisnici 15 godina skaču s dokumenta
na dokument bez povratka na listu. Zato: polje **„Pronađi dokument"** u komandnoj traci (prekidač
Broj | Opis) + prečice `Alt+←` / `Alt+→` za prethodni/sledeći dokument u tekućem filteru.

**Režimi ekrana** (izvedeni iz statusa, ne iz rute):
- `unos` (DRAFT) — sve editabilno.
- `pregled` (POSTED/LOCKED/CANCELLED) — polja kao tekst na sivoj podlozi (ne „disabled input"),
  katanac + traka „Zaključan 27.07.2026 · Nenad J.", akcije unosa se sklanjaju.
  BigBit isto: zaključavanje menja **boju pozadine cele forme** i gasi unos/brisanje/dodavanje
  (`Doc__Form_Izlazna faktura.txt:1022-1050`; `Doc__Form_Izlazna faktura - Podforma.txt:8-35`).
- `citanje` (bez prava izmene) — kao pregled, bez otključavanja.

**Izlazak sa nesnimljenim unosom:** `beforeunload` + presretanje in-app navigacije + `Esc` →
`ConfirmDialog` „Imate neposlatih izmena na PN-0142/26. Snimi i izađi / Izađi bez snimanja / Ostani".
Ako je nacrt prazan (bez ijedne stavke), ponuditi „Obriši prazan nacrt" — da lista ne bude puna
praznih dokumenata i da se ne troše brojevi.

### 2.4 Izbor komitenta i artikla

BigBit ima **tri sinhronizovana comboa** za komitenta (šifra / naziv / mesto), svaki poziva isto
`UzmiPodatkeIzKomitenta`, plus modalni izbor na dvoklik
(`Doc__Form_Izlazna faktura.txt:1387-1403, 758-772`). Mi pravimo **jedno polje sa prekidačem ključa**
— funkcionalno isto, kraće za tri četvrtine reda.

**Kontrola `CodeCombo`** (nov ui-kit blok):
- prekidač ključa kao čip u polju: `Šifra | Naziv | Mesto | PIB`, menja se klikom ili **`Ctrl+Space`**
  (prevod BigBit dvoklika na labelu); izbor se pamti po korisniku;
- kucanje → serverska pretraga (debounce 250 ms, do 25 rezultata), lista: Naziv (bold) · Mesto ·
  PIB · šifra desno;
- **tastatura obavezno**: `↑/↓`, `Enter` bira, `Tab` bira i ide dalje, `Esc` zatvara bez brisanja
  ukucanog, `Backspace` na izabranoj vrednosti vraća u kucanje sa zadržanim tekstom;
- tačna šifra + Enter, uz jedinstveno poklapanje → bira bez otvaranja liste (BigBit navika);
- bez poklapanja: „Nema komitenta za 'xyz'" + stavka **„+ Unesi novog komitenta"** koja otvara unos i
  po snimanju ga postavlja u polje bez napuštanja ekrana. *(Napomena o poreklu: u BigBitu se novi
  komitent dodaje posebnim dugmetom uz requery liste — `Doc__Form_Izlazna faktura.txt:95-121`; a
  `NotInList` na stavci obrađuje samo barkod i inače tiho odustaje —
  `Doc__Form_Izlazna faktura - Podforma.txt:305-328`. Naša varijanta je **svesno poboljšanje**, ne
  paritet. Na ulaznoj kalkulaciji BigBit ipak nudi „Želite da unesete novi artikal?" —
  `Doc__Form_Ulazna faktura - Podforma.txt:235-270`.)*
- izabrani komitent se prikazuje u dva reda: „MILANOVIĆ DOO" / „Kraljevo · PIB 100234567 · šifra 4821"
  — korisnik uvek vidi **koga** je uneo (danas ne vidi).

Uz polje: ikone „Detaljno", **„Stanje"** (saldo/dug — BigBit „Stanje u valuti", jedan klik iz fakture,
`Doc__Form_Izlazna faktura.txt:438-462`), „Novi komitent". Ispod polja čip upozorenja
„Dug: 1.240.500 RSD · **Preko limita 240.500**" — postojeći 422 „kreditni limit" sa opcijom „Kreiraj
uprkos limitu" ostaje, ali se vidi **pre** kucanja stavki.

**Šta izbor komitenta automatski povuče** (sve prekucljivo, uz tihu oznaku „iz komitenta"):
rok plaćanja → datum valute · cenovnik komitenta (fallback firmin VP cenovnik) · rabat komitenta ·
uslovi plaćanja · način plaćanja · paritet/FCO i način otpreme · kontakt osoba i njen mejl · valuta i
predlog kursa za ino · jezik štampe. **Drugi nivo:** izbor **mesta isporuke** prepisuje rutu i vozača
vrednostima iz šifarnika mesta isporuke (`Doc__Form_Izlazna faktura.txt:30-36`) — komitent daje samo
podrazumevane.

Promena komitenta na dokumentu koji već ima stavke → pitanje „Promenili ste kupca. Da preračunam cene
i rabate po njegovom cenovniku? Da / Ne (zadrži postojeće cene)". Nikad tiho.

**Artikal** — ista kontrola, četiri ključa: `Kat.broj → Barkod → Ext.šifra → PLU`, ciklično
`Ctrl+Space` (BigBit: dvoklik na labelu menja RowSource i natpis —
`Doc__Form_Izlazna faktura - Podforma.txt:279-303`). Kolona **Naziv** je isto `CodeCombo` (pretraga
po delu naziva) i **prekucljiva** — u BigBitu se naziv na stavci otključava dvoklikom i piše preko
šifarničkog (`Doc__Form_Profaktura - Podforma.txt:285-287`); mi to čuvamo kao snapshot na stavci uz
oznaku „izmenjen naziv". Dugme „Skener" u zoni B koristi postojeći `lib/barcode-decoder.ts`:
skenirani kod puni tekući red i odmah otvara sledeći.

### 2.5 Tastatura — tok prstiju

Ovo je srž zahteva „ljudi kucaju 15 godina naslepo". Redosled fokusa je **definisan i testira se**,
nije slučajna posledica DOM redosleda.

Opšta pravila (`DESIGN_SYSTEM.md` §6/§8 ih već propisuju — samo ih niko nije implementirao):
`Enter` = **sledeće polje** (nikad slanje forme; izuzetak: Enter u otvorenoj listi combo-a bira
stavku) · `Tab` isto · `Ctrl+S` snimi · `Esc` izlaz uz potvrdu ako ima izmena · F-tasteri se ne
koriste.

**Redosled u zaglavlju:** Komitent → Broj dokumenta (Enter ga preskače kad je auto; Tab ulazi) →
Datum dokumenta → U roku dana → Datum valute → Valuta → Kurs (samo ako valuta ≠ RSD) → [razvijena
proširena polja] → **prva ćelija tabele**. Enter na poslednjem polju zaglavlja otvara prvi red —
to je BigBit „ulazak u podformu".

**Redosled u redu (P1 izlaz):** Šifra → (Naziv se preskače kad je artikal izabran) → Količina → Cena
→ Rabat% → [Napomena] → **kraj reda: red se snima i otvara se nov red, fokus u Šifru**. Izvedene
kolone (Neto, Iznos, PDV, Zalihe) se u tab-redosledu preskaču.

**Kretanje po tabeli:** `↓/↑` ista kolona sledeći/prethodni red · `Home/End` prva/poslednja ćelija ·
`Ctrl+Home/Ctrl+End` prvi/poslednji red · `Esc` u ćeliji vraća vrednost, `Esc` opet vraća ceo red na
stanje pre ulaska (BigBit „Poništi unos" = `A_UNDOFIELD`, `Doc__Form_Profaktura.txt:265-278`).

**Prečice** (zamena za BigBit F-tastere i dvoklikove; sve u tooltipu, sve `preventDefault`):

| Prečica | Radnja |
|---|---|
| `Alt+N` | nov dokument (globalno) |
| `Insert` / `Ctrl+Enter` | nova stavka |
| `Ctrl+Delete` | obriši stavku (undo toast 10 s) |
| `Ctrl+D` / `Ctrl+Shift+D` | kopiraj iz reda iznad / dupliraj red |
| `Ctrl+S` / `Ctrl+Shift+S` | snimi / snimi i knjiži |
| `Ctrl+P` / `Ctrl+Shift+P` | meni štampi / podrazumevana štampa |
| `Ctrl+Space` | promeni ključ pretrage u aktivnom combo-u |
| `Ctrl+Shift+A` / `Ctrl+Shift+K` | izbor artikla / izbor komitenta |
| `Alt+K` / `Alt+S` / `Alt+Z` | skok na Komitenta / prvu ćeliju tabele / zbirove |
| `Ctrl+Shift+Z` | sklopi/razvij zaglavlje |
| `Alt+P` / `Alt+V` | Prepiši u… / panel Veze |
| `Alt+←` / `Alt+→` | prethodni / sledeći dokument |
| `Esc` | nazad na listu (uz potvrdu) |

Zabranjeno: `Alt+D`, `Alt+E`, `Alt+F`, `Ctrl+W`, `Ctrl+T`, `Ctrl+N` (browser ih otima).

**TOK PRSTIJU — dokument od 20 stavki, bez ijednog klika mišem:**

1. Na listi: `Alt+N` → kuca „pon" → `Enter` (vrsta PON).
2. Fokus je u Komitentu. Kuca „mila" → `↓` do „MILANOVIĆ DOO" → `Enter`. Povučeni rok, cenovnik,
   rabat, uslovi plaćanja, paritet.
3. `Enter` (broj preskočen, auto) → datum je danas, `Enter` → rok 15 dana iz komitenta, `Enter` →
   valuta RSD, `Enter`.
4. Fokus pada u prvu ćeliju tabele; zaglavlje se sažima u jedan red rezimea.
5. **Stavka 1:** kuca „4711-02" → `Enter` (jedinstveno poklapanje: povučeni naziv, JM, cena
   12.400,00, rabat 8%, PDV 20%, zalihe 34/60/6) → fokus u Količinu → „12" → `Enter` → cena je već
   tu, `Enter` → rabat je već tu, `Enter` → **kraj reda: stavka snimljena, otvoren red 2, fokus u
   Šifru**. Futer skače na 133.632,00.
6. **Stavke 2–20:** isti ritam, prosečno 3–5 pritisaka po stavci. Posebna cena → kuca svoju vrednost
   umesto `Enter`. Isti rabat kao gore → `Ctrl+D`.
7. Artikal nije nađen → lista kaže „Nema artikla", `↓` do „+ Unesi nov artikal", `Enter`, unos,
   `Ctrl+S` → vraća se u isti red sa izabranim artiklom.
8. Posle 20. stavke: `Ctrl+S` → „Sve snimljeno 14:12".
9. `Ctrl+P` → meni varijanti („Ponuda", „Ponuda sa neto cenama", „Ino ponuda — engleski") →
   `↓`/`Enter` → PDF.
10. `Alt+P` → „Prepiši u…" → „Račun (IFR)" → `Enter` → nov dokument sa prepisanim stavkama, fokus u
    Broj dokumenta (jer se on prekucava iz sveske).

**Prijemni test.** Ceo tok 1–10 mora biti izvodljiv bez miša. **Ali merilo za svakodnevni rad je
drugačije od ovog primera:** stvarni dokument ima 1–7 stavki, pa je operativni prag
**„3 stavke od otvaranja do snimljenog dokumenta ispod 40 sekundi"**. Tok od 20 stavki je test
izdržljivosti, ne tipičan slučaj.

### 2.6 Pouzdanost

**Model snimanja — „snimanje po redu", kao BigBit.** U Accessu se stavka snima čim se napusti red
(`Form_BeforeUpdate`/`AfterUpdate` su trenutak snimanja); nema dugmeta „sačuvaj stavku".

1. Nacrt dokumenta nastaje čim zaglavlje ima vrstu + komitenta + datum.
2. Izmena polja zaglavlja ide na `blur` (debounce 600 ms, spajanje uzastopnih u jedan PATCH).
3. Stavka se šalje na **napuštanje reda** — jedan poziv po redu, ne po ćeliji.
4. `Ctrl+S` prisilno prazni red čekanja i potvrđuje „Snimljeno."

Nema stanja „kucao sam 40 minuta i sve izgubio".

**Indikacija snimljenosti:** tačka u koloni Rb (siva = snimljeno, narandžasta = šalje se, crvena =
nije prošlo, sa razlogom i „Pokušaj ponovo"); u komandnoj traci tekst stanja. Bez zelenog toasta na
svakih 5 sekundi — toast samo za `Ctrl+S`, knjiženje i greške.

**Prekid mreže:** svaka neposlata izmena ide u red čekanja u memoriji **i** u `localStorage`
(`docdraft:<vrsta>:<id|novo>`, ceo model dokumenta). Auto-retry 1s/3s/8s/20s/30s. Traka:
„Nema veze sa serverom. Nastavite da kucate — čuvam lokalno (3 neposlate izmene)." Unos se ne
blokira. Knjiženje i zaključavanje su blokirani dok ima neposlatih izmena. Pri ponovnom otvaranju:
„Pronađene su nesnimljene izmene od 14:07 (3 stavke). Vrati / Odbaci."

**Dvoklik na Snimi / dupli dokument:** dugme se onemogućava dok mutacija traje; svaka kreirajuća
operacija nosi `Idempotency-Key` (isti pri retry-ju), server pri istom ključu vraća **postojeći**
dokument. Prepis dodatno ima guard po izvoru — BigBit ga ima i poruka mu je uzor:
„Po ovom dokumentu je već napravljen IZLAZ. Njegov ID=N. Ako želite da ga ponovo kreirate morate da
obrišete izlazni dokument čiji je ID=N" (`Doc__Form_Profaktura.txt:640-668`). Naša verzija bez slepe
ulice: „Po ovom predračunu je već napravljen račun IFR-00142/26 (#8121). **Otvori ga / Napravi još
jedan**." Postoji i „Raskini vezu" (`Doc__Form_Profaktura.txt:748-764`).

**Istovremeni rad:** optimistička kontrola preko `expectedUpdatedAt` (obrazac već korišćen u
kadrovskoj); 409 → „Dokument je u međuvremenu menjao Miljan V. u 14:09. Osveži i ponovi izmenu." bez
gubljenja ukucanog.

**Knjiženje i zaključavanje:** „Knjiži" (POSTED — ulazi u PDV/GK/zalihe) i „Zaključaj" (LOCKED).
Potvrda **nabraja posledicu**: „Knjiženjem se stavke skidaju sa zaliha, dokument ulazi u PDV
evidenciju za jul 2026. **i ažurira se status predmeta**. Nastaviti?" — poslednje nije izmišljeno:
BigBit pri zaključavanju ne-internog dokumenta pokreće `PredmetiUpdateStatusaPoFakturi`
(`Doc__Form_Izlazna faktura.txt:1056-1067, 1405-1422`), i to gasi samo oznaka `InterniDokument`.
Otključavanje je posebna akcija sa pravom i **obaveznim razlogom** koji ide u istoriju — to je naše
poboljšanje; BigBit ima samo boolean `Zakljucano` i posebne `Z_Otkljucaj_*` forme
(`Module__Zakljucavanje.txt:4-33`). Za dokumente prenete iz BigBita istorija zaključavanja ne postoji
i prikazuje se kao „preuzeto iz BigBita". Auto-zaključavanje starijih od N dana (BigBit default 7,
`Module__Zakljucavanje.txt:35-58`) ostaje noćni posao, ne ekran.

**Potpis i istorija:** svaka izmena zaglavlja **ili stavke** upisuje ko i kada — BigBit `PotpisiDok`
se poziva na oba nivoa (`Doc__Form_Izlazna faktura.txt:684-687`;
`Doc__Form_Izlazna faktura - Podforma.txt:179-198`; `Module__PotpisivanjeDok.txt:3-31`). U zoni E
„Poslednja izmena: Nenad J. · 27.07.2026 14:12", klik otvara istoriju (polje, staro → novo, ko, kada).

### 2.7 Kontrole — tri nivoa, sve na napuštanju polja/reda

**A) TVRDE (blokiraju; poruka + fokus na sporno polje):**

1. Stavka bez artikla i bez opisa; 2. količina 0 ili prazna („Morate imati količinu!",
   `Doc__Form_Ulazna faktura - Podforma.txt:212-503`); 3. cena prazna na ulaznoj kalkulaciji;
4. **negativna zaliha** na vrstama gde registar kaže „blokira": „Izdajete veću količinu nego što su
   vam zalihe" (`Doc__Form_Izlazna faktura - Podforma.txt:200-210`), i pri **brisanju** stavke
   (`ibid.:227-235`) — sa izuzetkom vrste KODJ; 5. neispravan PIB komitenta, sa izuzetkom
   `NeProveravajPIB` za ino (`Doc__Form_Izlazna faktura.txt:689-696`); 6. kurs 0 na deviznom
   dokumentu („Kurs ne može biti 0!", `ibid.:597-626`); 7. duplikat broja dokumenta u seriji;
8. ino izlazni bez izabranog deviznog računa firme; 9. uslužni dokument bez mesta i datuma prometa;
10. rabat ili kasa = 100% (izvedena fakturna cena bi delila nulom — v. §4.2);
11. dokument bez ijedne stavke ne može da se knjiži.

> **Zaliha je konjunkcija dva uslova, ne jednog.** U BigBitu je provera vezana za **magacin**
> (`F_ProveraZalihaMag()`), i kad je isključena, kolone zaliha se uopšte ne računaju — ostaju 0
> (`Doc__Form_Izlazna faktura - Podforma.txt:499-513`). Zato: blokira se ako
> `warehouses.vodi_zalihe` **i** `document_types.provera_zaliha='BLOKIRA'`; ako magacin ne vodi
> zalihe, kolone zaliha se **skrivaju**, ne prikazuju kao nule. Na ponudi/predračunu je provera
> **namerno isključena** — BigBit kod je zakomentarisan uz obrazloženje „Pošto je ovo profaktura,
> nema provera zaliha" (`Doc__Form_Profaktura - Podforma.txt:155-186`).

**B) AUTO-KOREKCIJA (ispravi + objasni, nikad tiho):**

1. Rabat preko maksimalnog za artikal se svede, uz poruku koja kaže i **gde** se limit menja — ton
   preuzet doslovno iz BigBita: „…To je vrednost koju ste zadali kod unosa artikla. Ukoliko želite da
   je povećate to morate da uradite kroz opciju Unos u sekciji Artikli."
   (`Doc__Form_Izlazna faktura - Podforma.txt:458-470`).
2. Zaokruživanje na dogovoreni broj decimala (§4.5).
3. Normalizacija valute (`eur` → `EUR` — u BigBitu su velika i mala slova izmešana), datuma,
   decimalnog zareza.
4. Prazan red na dnu se ne snima i ne broji.

**C) MEKA UPOZORENJA (žuta traka iznad futera, klik vodi na sporni red):**

1. RUC ispod praga — BigBit javlja na dodiru dugmeta za štampu: „Proverite dokument. Razlika u ceni
   je manja od 25%" (`Doc__Form_Izlazna faktura.txt:198-213`; `ProveraRUC.sql`). Prag ide u
   parametre, ne u kod. 2. Cena ispod nabavne. 3. Kupac preko kreditnog limita.
4. **Nepotpuna stavka pri snimanju**: „Red 7 nema količinu — neće biti snimljen. Dopuni / Obriši
   red." **Tiho odbacivanje nepotpunih stavki se ukida** (danas `new-proforma-dialog.tsx` filtrira
   redove pre slanja, pa dokument nastane sa manje stavki nego što je ukucano — jedan od glavnih
   izvora nepoverenja). 5. Artikal bez cene u cenovniku. 6. Rok plaćanja duži od uobičajenog za tog
   kupca. 7. Datum dokumenta u prethodnom PDV periodu.

**Pravilo za poruke:** rečenica kaže **šta** se desilo i **šta korisnik može da uradi**; nikad
„Nevalidna vrednost"; nikad tiho ne-dešavanje (današnji `if (!valid) return` bez poruke se ukida).

### 2.8 Responsivnost

Obavezna provera na 360 / 768 / 1024 / 1440 px (`DESIGN_SYSTEM.md` §11). Ekran se **preslaguje**, ne
skalira.

- **1440+** — sve zone, zona E kao desna kolona. Ciljni doživljaj (knjigovodstvo, komercijala).
- **1024–1440** — zona E u bočni panel, zaglavlje u 3 kolone, sporedne kolone tabele sa horizontalnim
  skrolom (izbor kolona se pamti po vrsti).
- **768–1024** — sidebar off-canvas, zaglavlje u 2 kolone i podrazumevano sažeto, tabela ostaje
  tabela. Ciljna upotreba: prijem robe sa tabletom, skener + količina.
- **<640** — zaglavlje kao sekcija, stavka kao kartica („7. 4711-02 · Ležaj 6205" / „12 kom ×
  12.400,00 = 148.800,00"), tap otvara donji panel sa svim poljima; „+ Nova stavka" kao FAB; futer
  zbirova ostaje zakucan (2 reda); mete 44×44; `inputMode=decimal`.

Ni na jednoj širini se ne sme desiti da zbir ili broj dokumenta nisu vidljivi.

---

## 3. MATRICA POLJA PO VRSTI DOKUMENTA

### 3.1 Registar vrsta (`document_types`) — konfiguracija koja vozi ekran

| Konfiguracija | Šta određuje | Danas |
|---|---|---|
| smer (ulaz/izlaz) | znak zalihe, kupac vs dobavljač | ✅ `is_inbound` |
| prefiks broja | „AR-", „PN-", „IFU-" | ✅ `document_number_prefix` |
| numeracija od | početni broj serije | ✅ `numbering_start` |
| podrazumevani magacin | auto-magacin pri izboru vrste | ✅ `default_warehouse_id` |
| šema kontiranja / analitika / sintetika | GK nalog | ✅ `posting_template`, `post_analytical`, `post_synthetic` |
| PDV knjiga | KIF/KUF | ✅ `post_in_vat_ledger` |
| KEPU zaduženje/razduženje | trgovačka knjiga | ✅ `kepu_default_charge/discharge` |
| naslov na štampi | „Račun - otpremnica" | ✅ `report_text` |
| utiče na zalihe | razdužuje li magacin | ✅ `affects_stock` |
| interni dokument | gasi ažuriranje statusa predmeta pri zaključavanju | ✅ `is_internal_document` |
| **obračunava PDV na robu / na usluge** | per-stavka poreski prekidač | ⚠️ `sale_with_ppp` / `sale_with_ppu` — **kolone postoje, značenje im je pogrešno opisano** (v. §4.4) |
| **grupa numeracije** | da li više vrsta deli jedan godišnji niz | ❌ `numbering_group` |
| **provera zaliha** | BLOKIRA / UPOZORAVA / ISKLJUČENA | ❌ `stock_check` |
| **rezerviše zalihe** | PROF sa „Rezerviši" | ❌ `reserves_stock` |
| **podrazumevani cenovnik** | koji cenovnik vrsta otvara | ❌ `default_price_list_code` |
| **podrazumevano oslobođenje** | IZVRO → čl. 24 st. 1 tač. 5 | ❌ `default_vat_exemption_code` |
| **traži predmet / RN / PO broj** | tvrdo ili meko | ❌ `requires_project`, `requires_work_order`, `requires_po_number` |
| **dozvoljene štampe** | koje varijante nudi `Ctrl+P` | ❌ `allowed_print_variants` |
| **dozvoljeni ciljevi prepisa** | PON→PROF→AVR→IFR | ❌ `carry_over_targets` |
| **profil ekrana** | P1 / P2 / P3 | ❌ `screen_kind` |
| **upisuje cene u cenovnik** | MP tok (v. §4.7) | ❌ `writes_price_list` |

Izvor: `R_Vrste dokumenata` (57–59 redova, BB_T_26) i `Doc__Form_Izlazna faktura.txt:900-921`.

### 3.2 Zaglavlje — zajednička matrica

**Identitet**

| Polje | Obav. | Odakle | Danas |
|---|---|---|---|
| Vrsta dokumenta | O | registar; okida broj, magacin, cenovnik, PDV režim | ✅ `invoices.document_type` |
| Broj dokumenta | A | auto-predlog; **uvek prekucljiv** + provera duplikata | ✅ `document_number` |
| Broj ručno prekucan (flag) | A | audit + „ne troši sekvencu" | ❌ `document_number_is_manual` |
| Grupa numeracije | AZ | iz registra | ❌ `numbering_group` (na registru) |
| Firma izdavalac | AZ | kontekst prijave | ✅ `company_id` |
| Godina | A | iz datuma dokumenta (ključ serije) | ❌ `year` na `invoices` (✅ na `stock_documents`) |
| Nivo (250 predračun / 0 knjižen) | AZ | iz vrste; promocija PROF→IFR | ✅ `level` |
| Status | AZ | DRAFT/POSTED/SENT/PAID/CANCELLED | ✅ `status` |
| Zaključano | A | ručno + auto posle N dana | ✅ `is_locked` |
| Razlog i vreme otključavanja | AZ | audit | ❌ `unlocked_by_user_id`, `unlocked_at`, `unlock_reason` |
| Poslednja izmena (ko/kad) | AZ | i sa izmene stavke | ✅ `updated_by_user_id`, `updated_at` |
| **Opis dokumenta** (kratak, pretraživ) | A | auto pri prepisu: „Profaktura br: X", „Po trebovanju br: X" | ❌ `summary` |

> `Opis` nije isto što i napomena: BigBit ga automatski puni pri svakom prepisu
> (`Doc__Form_Izlazna faktura.txt:541, 1095`) i po njemu se dokumenti pretražuju (`ibid.:798`).

**Partner**

| Polje | Obav. | Odakle | Danas |
|---|---|---|---|
| Kupac / dobavljač | O | šifra ILI naziv ILI mesto ILI PIB | ✅ `customer_id` |
| PIB / matični (prikaz + provera) | AZ | iz komitenta, sa izuzetkom za ino | ✅ `customers.tax_id`, `skip_tax_id_validation` |
| Kontakt osoba | A | podrazumevana kontakt osoba komitenta | ❌ `contact_person_id` + ❌ tabela `customer_contacts` |
| Mesto isporuke | P | šifarnik mesta isporuke komitenta; **prepisuje rutu i vozača** | ❌ `delivery_place` (⚠️ postoji na `stock_documents`) |
| Rabat komitenta (zaglavlje) | A | `customers.customer_discount` | ❌ `customer_discount_percent` |
| **Cenovnik dokumenta** | A | komitent → firmin VP cenovnik | ❌ `price_list_code` |
| Kreditni limit / saldo | AZ | prikaz jednim klikom | ✅ `customers.credit_limit`, `check_debt` |
| Prodavac / referent | A | iz komitenta ili prijavljeni korisnik | ✅ `salesperson_id` |

**Datumi — vezani trougao**

| Polje | Obav. | Pravilo | Danas |
|---|---|---|---|
| Datum dokumenta | O | default danas; izmena preračuna valutu | ✅ `document_date` |
| Datum knjiženja | A | izmena **prepisuje datum dokumenta i datum izjave**, pa ponovo računa valutu i regeneriše broj naloga | ❌ `posting_date` na `invoices` (✅ na `stock_documents`) |
| Rok plaćanja (dana) | A | iz komitenta; izmena → datum valute | ❌ `payment_term_days` |
| Datum valute | A | datum + rok; izmena → preračuna rok | ✅ `due_date` |
| Datum prometa | O za IFR/IFUSL | zakonski element; **nikad izveden iz datuma izdavanja** | ✅ `supply_date` |
| Mesto prometa | U (usluge/SEF) | ručno / iz magacina | ❌ `place_of_supply` |
| Datum isporuke (rok) | P | dogovoren rok | ❌ `delivery_date` |
| Broj i vrsta naloga GK | A | auto iz datuma (`ObrniDatum` = YYMMDD) + ručna regeneracija dvoklikom | ❌ `gl_order_number`, `gl_order_type` |

Izvor lančanja: `Doc__Form_Izlazna faktura.txt:49-74` i `:61-68` (datum knjiženja → datum dokumenta,
datum izjave, valuta, broj naloga), `:10-12` (`Broj_naloga_DblClick → ObrniDatum`).

**Uslovi plaćanja i isporuke — ono što vlasnik izričito traži**

| Polje | Obav. | Odakle | Danas |
|---|---|---|---|
| **Uslovi plaćanja** (tekst: avans 100%, 50/50, po isporuci…) | A | iz komitenta; u BigBitu polje zaključano osim grupi „KomAvPlacanje" (`Doc__Form_Profaktura.txt:547-553`) | ❌ `payment_terms` |
| **Način plaćanja** (virman/gotovina/kartica/kompenzacija) | A | iz komitenta | ❌ `payment_method` (✅ na komitentu) |
| **Paritet / FCO** | O za izlaz | šifarnik + slobodan tekst; pravilo iz uputstva: <5.000 din = FCO naš magacin, >5.000 = FCO kupac | ❌ `fco` (⚠️ postoji na `stock_documents`) |
| Način otpreme | A | iz komitenta | ❌ `shipping_method` (⚠️ na `stock_documents`) |
| Poziv na broj | A | default = broj dokumenta | ✅ `payment_reference` |
| Račun za uplatu (dinarski) | A | podrazumevani račun firme | ❌ `payment_account_id` |

**Veze na posao**

| Polje | Obav. | Napomena | Danas |
|---|---|---|---|
| **Predmet** | A/U | popunjen na 64% IFR, 90% REZM, 56% IFUSL — masovna praksa | ❌ `project_id` na `invoices` (✅ na `stock_documents`) |
| Radni nalog | U (IFUSL: O) | na ulazima: UFROB 56%, TREB1 47%, UFMAT 31%, UVOZ 30% | ✅ `work_order_id` |
| Magacin dokumenta | O za robne | iz vrste | ❌ `warehouse_id` na `invoices` (✅ na `stock_documents`) |
| **PO broj kupca** (žuto polje) | U (javni sektor: O) | bez njega SEF odbija fakturu | ✅ `po_number` |
| Datum narudžbenice kupca | P | „Po porudžbini od…" | ❌ `po_date` (⚠️ `stock_documents.customer_order_ref`) |
| **Zapisnik — telo** (slobodan tekst, **ne broj**) | P (usluge) | „ide umesto otpremnice"; u BigBitu `Zapisnik` Memo na zaglavlju uslužne fakture, popunjen 67,6 % — **ISPRAVKA §8/O4.1** | ❌ `protocol_text` (`Text`) |
| Zapisnik — naslov („Tekst na zapisniku") | P (usluge) | u BigBitu nevezana kontrola, **ne čuva se nigde** → istorija se ne može migrirati | ❌ `protocol_title` |

**Tekstovi**

| Polje | Obav. | Danas |
|---|---|---|
| Napomena (memo, ide na štampu) | P | ✅ `note` |
| Interna napomena (ne štampa se) | P | ❌ `internal_note` — u BigBitu je sve u jednom Memo polju i to je izvor grešaka |
| Tekst za fakturu (klauzula ispod stavki) | A iz vrste | ❌ `invoice_text` |
| Napomena o poreskom oslobođenju (žuto polje) | U | ❌ `vat_exemption_code`, `vat_exemption_text` |
| **Naslov na štampi** | A iz vrste, prekucljiv | ❌ `print_title` — v. napomenu ispod |

> BigBit pri **svakoj** štampi upisuje naslov u sam dokument (`TekstZaRacun`), pa isti dokument može
> izaći kao „Račun - Otpremnica" ili kao „Otpremnica", zavisno od dugmeta
> (`Doc__Form_Izlazna faktura.txt:162-196, 301-326, 356-379`). Naslov zato ide i na dokument, ne samo
> u registar vrsta.

**Zbirovi**

| Polje | Danas |
|---|---|
| Osnovica / PDV / Ukupno | ✅ `net_total`, `vat_total`, `gross_total` |
| Ukupan rabat (za štampu) | ❌ `total_discount_amount` |
| Zaokruženje | ❌ `rounding_amount` |
| Odbijeni avansi | ✅ `advance_applied_amount` |
| **Za plaćanje** (bruto − avansi ± zaokruženje) | ❌ `amount_due` |
| Osnovica/PDV/ukupno **u valuti** | ❌ `fx_net_total`, `fx_vat_total`, `fx_gross_total` |

**Sloj INO** (pali ga valuta ≠ RSD ili izvozna vrsta)

| Polje | Obav. | Danas |
|---|---|---|
| Valuta (ISO, normalizovano) | A | ✅ `currency` |
| Kurs | U | ✅ `exchange_rate` |
| **Datum i poreklo kursa** (LISTA / RUČNO / UGOVOREN / JCI) | A | ❌ `exchange_rate_date`, `exchange_rate_source` |
| Obračunski (knjigovodstveni) kurs | U (uvoz) | ✅ `accounting_exchange_rate` |
| Carinski kurs | U (uvoz) | ⚠️ `stock_documents.customs_exchange_rate` |
| Devizna vrednost fakture | A | ✅ `fx_invoice_value` |
| **Jezik dokumenta** (sr/en) | A | ❌ `document_language` |
| **Devizni račun firme (IBAN/SWIFT)** | O za ino | ❌ `foreign_payment_account_id` + ❌ tabela `foreign_payment_accounts` |
| Incoterms šifra + mesto | U | ❌ `incoterm_code`, `incoterm_place` |
| Broj i datum izvozne izjave | P | ❌ `statement_number`, `statement_date` |
| JCI referenca (broj + datum) | P | ❌ `customs_declaration_no`, `customs_declaration_date` |

> Danas se **SWIFT instrukcije kucaju rukom u napomenu** (33 dokumenta u BB_T_26), a firma ima samo
> jedan IBAN. BigBit ima šifarnik `INOUplatniRacuni` + combo na fakturi, a pod-izveštaj
> `INOInstrukcijeZaPlacanje` se prikazuje **samo ako je račun izabran** — inače ino faktura izlazi bez
> instrukcija za plaćanje i kupac ne može da plati (`Doc__Report_InoFakturaEng.txt:32-37`). Kod nas to
> postaje tvrda kontrola, ne tiho izostavljanje.

### 3.3 Stavka — robna (profil P1)

| Polje | Obav. | Odakle | Danas |
|---|---|---|---|
| Artikal | O | 4 ključa: kat.broj / barkod / ext. šifra / PLU | ✅ `invoice_items.item_id` |
| Naziv (prekucljiv snapshot) | A | iz artikla | ✅ `description` |
| Kataloški broj (snapshot) | A | da štampa preživi izmenu šifarnika | ❌ `catalog_number` |
| INO naziv (snapshot) | A | `items.foreign_name` sa fallbackom | ❌ `foreign_description` |
| Jedinica mere | A | iz artikla | ❌ `unit` |
| Carinska tarifa (snapshot) | A | `items.customs_tariff` | ❌ `customs_tariff` |
| Količina | O (>0) | ručno | ✅ `quantity` |
| Kutije × kom / transportno pakovanje | P | **dvosmerno** sa količinom | ❌ `box_quantity`, `transport_pack_quantity` |
| **Fakturna cena** (bruto, pre rabata) | A | cenovnik → poslednja kalkulacija (v. §4.3) | ❌ `invoice_price` (✅ postoji na `stock_document_items`) |
| Rabat % / iznos | A | rabatna lestvica, kap po artiklu | ✅ `discount_percent` / ❌ `discount_amount` |
| Kasa % / iznos | A | iz **istog** rabatnog reda kao rabat | ✅ `cash_discount_percent` / ❌ `cash_discount_amount` |
| **Stvarna VP cena** (transakciona) | A | fakturna − rabat − kasa | ✅ `unit_price` |
| Stvarna MP cena (sa PDV) | A | taksa + VP×(1+Σstopa); unos MP računa VP unazad | ❌ `retail_price` |
| Cena i vrednost u valuti | A | izvedeno (v. §4.6) | ❌ `fx_unit_price`, `fx_line_total` |
| Nabavna neto (za RUC) | AZ | poslednja kalkulacija ili prosečna cena zaliha | ❌ `purchase_price_net` (✅ na `stock_document_items`) |
| RUC % | AZ | (VP − nabavna)/nabavna | ❌ `markup_percent` |
| **Poreklo cene** (CENOVNIK / RUČNO / POSLEDNJA KL / PROSEČNA) | AZ | vidljivo uz polje | ❌ `price_source` |
| **Poreklo rabata** (GRUPA / KUPAC / RUČNO / KAP) | AZ | vidljivo uz polje | ❌ `discount_source`, `discount_capped` |
| Šifra poreske stope | A iz artikla | ✅ `vat_rate_code` |
| **Obračunava se porez na robu / na usluge** | AZ | iz vrste dokumenta (PPP/PPU) — jedini način da se PDV ugasi po stavci | ❌ `charges_goods_vat`, `charges_service_vat` |
| Osnovica / PDV / za plaćanje | A | izračunato | ✅ `vat_base`, `vat_amount`, `line_total` |
| Šifra oslobođenja po stavci (SEF Z/E/O + osnov) | U | ❌ `vat_exemption_code` |
| Magacin stavke | A iz zaglavlja | ❌ `warehouse_id` na `invoice_items` |
| Zalihe (u magacinu / ukupno / rezervisano) | AZ prikaz | ✅ izračunljivo (`stock_levels`, `stock_reservations`, `GET /robno/availability`) — **nije na ekranu** |
| Predmet / RN po stavci | P | BigBit `IDPredmetStavka` | ❌ `project_id`, `work_order_id` |
| Rok isporuke po stavci | P | ❌ `delivery_date` |
| Odloženo (dana) po stavci | P | povlači se iz artikla; ulaz za ponderisani prosek | ❌ `deferral_days` |
| Napomena stavke | P | ❌ `note` |
| Redni broj / prepisano iz | A | ✅ `line_no`, `copied_from_item_id` |

Izvori: `Doc__Form_Izlazna faktura - Podforma.txt:617-721` (šta sve povuče izbor artikla), `:342-356,
427-456, 555-561` (pakovanja dvosmerno), `:499-513` (zalihe), `:628, 854-892` (odloženo po stavci),
`:629-647` (poreski prekidači i tri tarife); `Q_RabatKomitentaZaStavkuFakture.sql` (rabat + kasa).

### 3.4 Stavka — uslužna (profil P2)

| Polje | Obav. | Danas |
|---|---|---|
| Grupa usluge | A | ❌ `service_group_code` — **napomena: popunjeno 0,2% u 2026** |
| **Opis usluge (višeredni)** | O | ⚠️ `description` je `VarChar(255)` — **premalo**, treba `Text` |
| Jedinica mere / količina | A/O | ❌ `unit` / ✅ `quantity` |
| Cena bez PDV **ili** cena sa PDV | O (jedno od dva) | ✅ `unit_price` / ❌ ulaz „sa PDV" (izvedeno polje ekrana) |
| Rabat % / PDV stopa | P/A | ✅ |
| Šifra osnova poreskog oslobođenja **po stavci** | U | ❌ `vat_exemption_code` — BigBit ga na uslugama zove `IDRazlogOslobadjanja`, a na robi `ID_PO` (`BB_T_26_schema.sql:2157` vs `:1917-1955`) |
| RN / predmet po stavci | P | ❌ |

Uslužna stavka nema artikal, magacin, zalihe, nabavnu cenu ni RUC — **ista tabela, tri ugašene
kolone**, ne drugi ekran. Dvosmerni unos cene je BigBit ponašanje: polje `CenaSaPDV` je proxy koji
prebaci fokus na unosno polje, a `AfterUpdate` računa `Cena = CenaSaPDVUnos/(1+Σstopa/100)`
(`Doc__Form_USLUGA Faktura - PODFORMA.txt:102-118`). Combo opisa nudi ranije korišćene opise
(autocomplete istorije, `ibid.:39-55`) — to zadržavamo.

**Tri zatečena kvara koja NE prepisujemo** *(nalazi uz §8/O4)*:

1. **Zbir na ekranu i zbir na štampi se u BigBitu ne slažu.** Mreža računa
   `Vrednost = Round(Kolicina × Round(Cena,2),2)` — **bez rabata**
   (`queries/_sq_cUSLUGA_Faktura_sq_cUSLUGA_Faktura___PODFORMA.sql:2-3`), a štampa računa
   `NetoCena = Cena × (1 − RabatProc/100)` pa poreze na `Kolicina × NetoCena`
   (`queries_full/OnLine_BigBit_APL/USLUGA Faktura za stampu.sql:2`;
   `OnLine_BigBit_Design/PDVPoFakturiUSLUGA.txt:17-25`). Kod nas je jedna istina — ona sa §4.5.
2. **SEF izvoz za usluge gubi rabat i oslobođenje.** Upit hardkoduje `0 AS RabatProc` i `0 AS ID_PO`
   (i `KasaProc` na 0), dok robna varijanta prosleđuje prave vrednosti
   (`queries_full/OnLine_BigBit_APL/EDI_ER_Stavke_Usluga_Table_AppendUTmp.sql:3` vs
   `EDI_ER_Stavke_Table_AppendUTmp.sql:3`). To je **zatečen produkcioni bag**, ne pravilo.
3. **Prepis dokumenta gubi rabat i oslobođenje.** `PrepisiStavkeUUslugaDok` kopira opis, JM,
   količinu, cenu, tarifu i grupu, ali **ne kopira `RabatProc` ni `IDRazlogOslobadjanja`**
   (`Module__KreiranjeDokumenata.txt:454-495`). Naš carry-over kopira sve, ili eksplicitno pita.

### 3.5 Delta po vrsti

**PON — ponuda** (~860/god, 2. po obimu)

| Delta | Danas |
|---|---|
| Deli seriju sa PROF (NNNN-YY) | ❌ `numbering_group='OFFER'` |
| **Provera zaliha isključena namerno** | ❌ `stock_check='OFF'` |
| Rok važenja ponude (BigBit ga nema, traži se stalno) | ❌ `valid_until` |
| Uslovi plaćanja + kontakt osoba auto iz komitenta | ❌ |
| Broj često nosi kupčev broj („PO25-00224") | ✅ broj je slobodan tekst |
| Prepis u PROF, AVR, IFR/IFUSL, porudžbenicu | ✅ delimično (`carry-over.service.ts`) |

**PROF — predračun/profaktura**

| Delta | Danas |
|---|---|
| **Rezerviši količine** (checkbox) — rezervacija se posle vidi u koloni „rezervisano" na fakturi | ❌ `reserve_stock` + ❌ `document_types.reserves_stock` |
| Upis cena u cenovnik **isključen** (za razliku od fakture) | ❌ |
| Veza sa nastalom fakturom + „Raskini vezu" | ✅ `linked_invoice_doc_id` (bez „raskini") |
| **Prepis u NOVU profakturu** (revizija ponude) sa brojem „original/1", prenosi kontakt osobu, uslove plaćanja, paritet i način otpreme, gasi „Rezerviši" (`Doc__Form_Profaktura.txt:343-377`) | ❌ |
| Dugme „Kreiraj potvrdu porudžbine" | ❌ |

**IFR / IFGP — izlazna faktura** (~730/god)

| Delta | Danas |
|---|---|
| Provera zaliha = **tvrd blok** (i pri brisanju stavke) | ❌ |
| RUC meko upozorenje (BigBit prag 25%) | ❌ |
| Pravilo iz uputstva: „Mag. VP cena mora biti jednaka Nab. ceni" inače robno ≠ finansijsko | ❌ (traži `purchase_price_net` na stavci) |
| Magacin izlaza obavezan | ❌ `warehouse_id` |
| Razduženje magacina | ✅ `stock_document_id` |
| Avansi (N:M) | ✅ `invoice_advance_applications` — zreo model |
| SEF | ✅ `sef_outbox` |
| Varijante štampe + „Štampaj komplet" (npr. 1 faktura + 2 otpremnice) | ✅ štampe, ❌ varijante i komplet |
| „Napravi KNO" iz kasa-skonta zaglavlja, sa auto-sastavljenim opisom (`Doc__Form_Izlazna faktura.txt:1184-1224`) | ❌ + ❌ `cash_discount_percent` na zaglavlju |
| **Izmena posle greške** | ❌ **nema nijedne PATCH rute na `sales.controller.ts`** |
| Kolone izlazne kalkulacije (Planirana VP/MP, % razlike u ceni, zavisni troškovi) i štampe „KLIF" / „KLIF veza sa UF" — postoje i na IZLAZNOJ fakturi (`Doc__Form_Izlazna faktura - Podforma.txt:118-146, 384-397`; `Doc__Form_Izlazna faktura.txt:328-354, 1351-1366`) | ❌ (opciona grupa kolona, skrivena po pravu) |

> IFGP ima dnevni lanac u istom danu: REZM → TREB → ULGP → IFGP → veza AVR → SEF. Ekran mora
> podržavati „napravi sledeći dokument iz ovog" bez ponovnog kucanja.

**IFUSL — faktura za usluge** (~150/god) — *profil `SERVICE`, v. §2.1 i odluku §8/O4*

| Delta | Danas |
|---|---|
| **Profil ekrana `SERVICE`**: nema kolone artikla, magacina, zaliha, nabavne ni RUC | ❌ `screen_kind` (na registru) + ❌ `line_profile` (na dokumentu, za izuzetke) |
| Stavke bez artikla i lagera | ✅ `invoice_items.item_id` je već `Int?` sa komentarom „null za slobodnu uslužnu stavku" (`backend/prisma/schema.prisma:3889`) |
| Opis stavke = glavno polje, višeredno | ⚠️ `description` je `VarChar(255)` (`ibid.:3890`) — **treba `Text`**; u BigBitu je `Opis Text(255) NOT NULL` |
| Autocomplete opisa iz istorije već kucanih opisa | ❌ (`SELECT Opis FROM [T_Usluge stavke] GROUP BY Opis`) |
| Jedinica mere na stavci | ❌ `unit` — BigBit ima `Jedinica mere Text(3)` na uslužnoj stavci |
| **Radni nalog obavezan** | ✅ kolona `work_order_id`, ali je **mrtva** (nigde se ne upisuje, čita se samo pri knjiženju); ❌ obaveznost iz vrste (`requires_work_order`) |
| **Zapisnik — telo** (slobodan tekst, ide umesto otpremnice, **zasebna štampa**) | ❌ `protocol_text` (`Text`, **ne** `VarChar`) |
| Zapisnik — naslov | ❌ `protocol_title`; **istorija se ne migrira** (v. §8/O4.1) |
| Mesto i datum prometa | ❌ `place_of_supply` / ✅ `supply_date` |
| Tekst za fakturu + napomena o oslobođenju | ❌ `invoice_text`, `vat_exemption_code/_text` |
| Šifra oslobođenja **po stavci** (`IDRazlogOslobadjanja`) | ❌ `invoice_items.vat_exemption_code` |
| Grupa usluge (`R_Grupa`) | ❌ `service_group_code` — popunjeno 0,2 % (§7: kolona da, UI ne) |
| **Ulazi u zajedničku izlaznu seriju** `INVOICE_OUT` — **potvrđeno merenjem, §8/O4.2** | ❌ `numbering_group` |
| Cena kao neto **ili** bruto ulaz | ❌ (dvosmerno polje ekrana, §3.4) |
| Konto prihoda 6140 (ne 6040) | ✅ `SERVICE_TYPES` u `fakturisanje.service.ts:65, 794-796` |
| **Konto izlaznog PDV-a 4703, ne 4702** | ❌ — `ACC_VAT_OUT_20 = "4702"` je hardkodiran bez ijedne grane po vrsti (`fakturisanje.service.ts:59, 820`); v. napomenu ispod |
| Ne razdužuje zalihe (ručni GL nalog) | ✅ `AUTO_STOCK_TYPES` bez IFUSL (`ibid.:66, 368-370`) |
| Prilog uz fakturu (skeniran zapisnik, potpisan) | ❌ nema **nijedne** attachment tabele nad fakturom; obrazac za kopiranje postoji — `ChangeRequestAttachment` nad `Sy15StorageService` (`backend/src/common/sy15/sy15-storage.service.ts`, bucket je parametar) |

> **PDV konto usluga — otvoreno prema knjigovodstvu.** Realni BigBit nalozi knjiže izlazni PDV
> usluga na **4703** (2025: 15.055.261,63 din. na 86 stavki), a mi sve knjižimo na 4702. Nalaz je
> već zaveden kao gap **G8** u `backend/docs/migration/BIGBIT_IZLAZNE_FAKTURE_I_AVANSI.md:767`, gde
> je i širi (gotovi proizvodi 6141+4701, izvoz 6050/6150/6151). **Suština nije pogrešna konstanta
> nego pogrešan model:** BigBit konta vodi kroz `Sema za kontiranje` **po vrsti dokumenta** —
> IFR = 33, IFGP = 36, IFUSL = 30, IZVGP = 47, IZVRO = 24, IZVUS = 0
> (`_extracted/rule_tables/BB_T_26/R_Vrste dokumenata.csv`). Naše grananje kroz `SERVICE_TYPES` /
> `isExport` treba zameniti kolonom `posting_template` na registru vrsta. Ako se ovo ne ispravi,
> paralelni PDV obračun do aprila 2027. neće poklopiti KIF/POPDV.

> **Zamka: `UticeNaZalihe` iz `R_Vrste dokumenata` je smeće — ne „popravljati" kod po njoj.** U tom
> CSV-u IFUSL ima `UticeNaZalihe=True`, a IFR `False` — tačno obrnuto od stvarnosti (uslužna stavka
> nema ni magacin ni šifru artikla pa fizički ne može da mrda zalihe, dok je IFR račun-otpremnica
> koja ih mrda). Naš `AUTO_STOCK_TYPES = {IFR, IFGP, IZVRO, IZVGP}` je **ispravan**. Iz tog registra
> su upotrebljivi `Sema za kontiranje` i `PrefiksBrojaDok`.

**INO sloj** (IZVRO/IZVGP/IZVUS + PON/PROF u EUR)

Nije posebna vrsta ekrana — v. §2.1. Traži: valuta + kurs + poreklo, jezik dokumenta, devizni račun
(obavezan), Incoterms, PDV oslobođenje sa osnovom, dvostruki prikaz iznosa, INO naziv i carinska
tarifa na stavci. IZVRO/IZVGP su praktično mrtvi (2 kom/god), IZVUS živi (~6/god) — **ne graditi im
posebne ekrane**.

**AVR — avansni račun** (~30/god)

| Delta | Danas |
|---|---|
| Osnov avansa: predračun **ili broj ugovora** (2 najveća avansa 2025. su po Ugovoru) | ✅ `advance_basis` |
| Datum i iznos naplate (PDV obaveza nastaje naplatom) | ✅ `advance_paid_at`, `advance_paid_amount` |
| Smer (mi kupcu / dobavljač nama) | ✅ `advance_direction` |
| Primena na konačnom računu (N:M) | ✅ zreo model |
| **Unos od nule** | ❌ danas se pravi samo iz predračuna |
| Izbor **tipa** avansa (roba/usluge — dva izvora), prepis broja/datuma/ukupnog iznosa, pa unos **koliko se koristi** na ovom računu, sa PDV-om razloženim po stopi **važećoj na datum avansa** (`Doc__Form_AVR_Roba.txt:33-48, 50-60, 62-75`) | ❌ (delimično korišćenje) |
| Kontrola „iskorišćeno ≤ raspoloživo po avansu" | ⚠️ u servisu, nije na ekranu |

**KNO / KNZ — knjižno odobrenje/zaduženje**

**0 dokumenata u 2025. i 2026.** Ispravke se u praksi rade kao **reizdanje istog broja sa sufiksom
„/1"** (`Module__KreiranjeDokumenata.txt:331`). Ne graditi poseban ekran — obezbediti sufiks i vezu:
❌ `reissue_of_doc_id`, `reissue_seq`.

> **Dopuna 28.07:** iako ih u poslednje dve godine nema, **istorijski postoji 75 KNO + 6 KNZ**, svi u
> `T_Usluge dokumenta`, sa sopstvenom četvorocifrenom serijom (`0001`, `0002`…) i jednim sudarom sa
> fakturnom serijom (2024, broj 55, KNO vs IFUSL). Ne postoje ni u `PREFIX_BY_TYPE`
> (`backend/src/modules/sales/numbering.service.ts:19-30`), ni u komentaru `Invoice.documentType`,
> ni u `carry-over.service.ts` — **uvoz ih danas nema gde da smesti.** Predlog:
> `numbering_group='CREDIT'`, i dalje bez posebnog ekrana (§9, pitanje 16).

**REV — revers** (1–5/god, istorijski do 58)

Roba (alat, oprema, uzorak) izdata kupcu bez fakture, prati se **po stavci** dok se ne razduži.
*(Pažnja: modul `/reversi` u 3.0 je zaduženje alata radnicima — drugi domen, ne dira se.)*

| Polje | Danas |
|---|---|
| Broj, datum, komitent, prodavac, opis | ✅ |
| Magacin | ❌ |
| Stavka: artikal + isporučena količina | ✅ + ❌ `unit` |
| **Razdužena količina / datum / razdužen (da-ne) / dokument razduženja** | ❌ `returned_quantity`, `returned_at`, `is_returned`, `settled_by_doc_id` |
| Uparena validacija: razdužen bez datuma → blok; datum bez razduženja → blok (`Doc__Form_Reversi_UnosZadStavke.txt:39-59`) | ❌ |
| Štampe „Revers" (nerazduženo) i „Revers razduženje" | ❌ |

**Porudžbenica / naručivanje (P3) — ~3.000/god, pojedinačno najveći obim**

Zaglavlje: dobavljač, datum, broj (auto + provera duplikata: „Već postoji narudžbenica sa ovim
brojem"), valuta + kurs, cenovnik, čekbosi Poručeno / Potpisano / Avans, predmet, OJ, veza na upit
(RFQ) i na profakturu. Stavka: artikal, **naručeno vs isporučeno vs ostatak**, cena, rabat,
**očekivani rok isporuke**, predmet, napomena, čekboks Isporučeno. Masovne akcije: „Upiši stavke iz
profakture", „Upiši stavke iz upita", „Upiši artikle dobavljača", „Upiši cene iz cenovnika", „Obriši
stavke koje nisu trebovane", **„Upiši trebovanu količinu u isporučenu" (= prijem jednim klikom)**.
„Prepiši trebovanje" pravi novu narudžbinu **samo sa razlikom neisporučenog**, sa sufiksom /1, /2.
Štampe: Narudžbina bez cena, sa cenama, **engleska varijanta**, Prijemnica.
Izvor: `Doc__Form_Trebovanje.txt:3-38, 439-475, 510-537, 584-960`;
`Doc__Form_Trebovanje - Podforma.txt:33-70`.

**Ulaz robe / kalkulacija (UFROB, UFMAT, UVOZ) — 1.281 od 1.858 robnih dokumenata 2026 = 69%**

Zaglavlje je **najjednostavnije od svih** (mereno na BB_T_26 2026): Fco, način otpreme, način
plaćanja, uslovi plaćanja, kontakt osoba i predmet u zaglavlju popunjeni su **0%**; stvarno se puni
broj (dobavljačev!), datum, magacin, dobavljač, radni nalog (56/32/30%) i opis. Stavka je „živi
kalkulator" — v. §4.8. Za uvoz se realno koriste samo `OstaliZavTros` (6,2%) i zavisni trošak
sopstveni (4,8%) + `DevVredFak`, `ObrKurs`, `CarKurs`; **Carina i Špedicija su 0% čak i na svih 115
UVOZ dokumenata**.

**Backend za ulaz je gotov.** `CreateStockDocumentDto` već prima `invoicePrice`, `discountPercent`,
`cashDiscountPercent`, `dependentCostOwn/Supplier`, `actualWholesalePrice`, `actualRetailPrice`,
`markupAmount`, `excise`, `fee`, `fixedTax`, `fxPurchasePrice`, `customsRate`, `kgQuantity`, a
zaglavlje `customsExchangeRate`, `accountingExchangeRate`, `fxInvoiceValue`, `customs`, `forwarding`,
`otherDependentCosts`, `customsRefundBase`, `fco`, `shippingMethod`, `shippingDate`, `deliveryPlace`,
`route`, `postingDate`, `projectId`, `workOrderId`, `purchaseOrderId`
(`backend/prisma/schema.prisma` — model `StockDocument`/`StockDocumentItem`).

---

## 4. CENOVNI I PORESKI MOTOR

### 4.1 Lanac (izlazni dokument)

```
Fakturna cena  F                                   (bruto, pre rabata — iz cenovnika)
Rabat          R  = F × r/100
Cena bez rab.     = F − R
Kasa           K  = (F − R) × k/100                (kasa se računa NA CENU POSLE RABATA)
Stvarna VP     VP = F − R − K   ≡ F × (1−r/100) × (1−k/100)
Osnovica reda     = količina × VP
PDV reda          = osnovica × Σstopa/100          (ako je porez uključen — v. §4.4)
Stvarna MP     MP = Taksa + VP × (1 + Σstopa/100)  (taksa je VAN poreske osnovice)
VP iz MP          = (MP − Taksa) / (1 + Σstopa/100)
Iznos reda        = osnovica + PDV + Taksa
```

Izvor: `Doc__Form_Izlazna faktura - Podforma.txt:484-497` (rabat i kasa),
`:476-483` (MP = taksa + VP×(1+Σ)), `:523-534` (MP → VP unazad).
**Naš `pricing.service.ts:130-135` već računa isto** (`base × (1−r) × (1−k)`) — ovde se ne
razilazimo.

**Rabat i kasa se nikad ne primenjuju kumulativno.** BigBit pri ulasku u polje pamti
`StaraFakturnaCena` i pre svakog preračuna vrati fakturnu na nju
(`Doc__Form_Izlazna faktura - Podforma.txt:249-261, 458-474`). Isto pravilo kod nas.

### 4.2 Fakturna cena — odluka koju treba doneti svesno

**Nalaz:** u BigBitu **`Fakturna cena` NIJE kolona** — tabela `T_Robne stavke` čuva samo
`[Stvarna VP cena]`, `[RabatProc]`, `[KasaProc]`, a fakturna se u upitima **izvodi**:

```
Fakturna = 10000 × [Stvarna VP cena] / ((100 − RabatProc) × (100 − KasaProc))
```

(upit „Detaljno stavke IZLAZNE fakture sa RABATOM", `queries_full/OnLine_BigBit_APL/_ALL.sql`;
šema `backend/docs/migration/BB_T_26_schema.sql:1917-1954`). Tako radi i štampa „Faktura sa neto
cenama".

**Dve opcije, ne mešati ih:**

- **(A) BigBit paritet** — čuvaj `(VP, rabat%, kasa%)` i izvedi fakturnu formulom. Manje kolona, nema
  razilaženja, ali kad korisnik prekuca VP, „cena pre rabata" na štampi **poraste** (BigBit
  ponašanje).
- **(B) Snapshot** — čuvaj `invoice_price` kao cenu iz cenovnika i **zabrani direktan unos VP** (VP je
  isključivo izvedena). Ovo je konzistentnije i već je tako na ulazu
  (`stock_document_items.invoice_price`).

**Preporuka: (B)**, jer je jedina koja preživljava masovne akcije (§4.7) i omogućava da se posle
godinu dana zna zašto cena odstupa od cenovnika. Uz obavezan invarijant-test posle svake operacije:
`VP == F × (1−r/100) × (1−k/100)`. Tvrda kontrola: rabat < 100 i kasa < 100 (u opciji A bi to bilo
deljenje nulom).

### 4.3 Odakle dolazi cena — redosled (naš je danas pogrešan)

BigBit redosled pri izboru artikla (`Doc__Form_Izlazna faktura - Podforma.txt:626, 772-825, 673-680`):

1. **Poslednja ulazna kalkulacija za taj magacin** → `Kalkulativna VP` (i nabavna neto + zavisni
   troškovi, što je ujedno ulaz za RUC).
2. Ako je magacin na **prosečnim cenama** (`ProsecneCene`, prekidač po magacinu) → prosečna nabavna
   cena zaliha **na datum dokumenta**, a zavisni troškovi se nuluju (`ibid.:654-664, 950-979`).
3. **Cenovnik dokumenta pregazi** rezultat — ali samo ako je cena u cenovniku ≠ 0.
4. Put „cena iz artikla" je u BigBitu **namerno ugašen** (zakomentarisan 2009/2010, `ibid.:651-652,
   666-667`).

Naš `pricing.service.ts:161-179` ide `PriceListEntry → Item.wholesalePrice → 0` — dakle bez koraka 1
i 2, i sa fallbackom koji je BigBit izbacio. Posledica: upozoravali bismo „nema cene" tamo gde je
BigBit tiho i tačno imao cenu.

**Ispravka:** `POST /sales/price-preview` vraća cenu i **poreklo cene**, po redosledu 1→3, i u istom
odgovoru daje nabavnu neto (za RUC) i zalihe. Traži novu rutu
`GET /robno/poslednja-kalkulacija?itemId&warehouseId`.

**Cenovnik se vezuje za dokument.** BigBit ključa cene po **šifri izabranog cenovnika**
(`CenaIzCenovnika(Nz(ComboCenovnik,"-"), …)`, `ibid.:672-673` — starija varijanta po vrsti dokumenta
je zakomentarisana), a sam cenovnik **ne pamti na dokumentu** (u `T_Robna dokumenta` te kolone nema)
— zato se stare cene ne mogu rekonstruisati. Kod nas: `invoices.price_list_code` **na dokumentu**
(poboljšanje), a `resolveBasePrice` mora **prestati** da ključa po `documentType`.

**MP cenovnik na VP dokumentu.** Ako cenovnik nosi bruto cene, VP = cena/(1+Σstopa/100). BigBit to
prepoznaje po **prefiksu imena cenovnika** („MP\*", `ibid.:675-679`) i pritom **ne oduzima taksu**,
dok ručni unos MP cene taksu **oduzima** (`ibid.:523-534`) — nedoslednost u samom BigBitu. Kod nas:
cenovnik nosi **zastavicu** „cene su bruto" (kolone već postoje: `price_list_entries.price_with_vat`,
`price_without_vat`, `check_price_with_vat`), a formula je **dosledno**
`VP = (bruto − Taksa)/(1 + Σstopa/100)` u oba slučaja. Migracija: prefiks „MP\*" → zastavica.

### 4.4 Rabat, kasa i PDV — tri ispravke

**(a) Rabatna lestvica.** Prioritet: (komitent + **artikal**, u važnosti) → (komitent + grupa
artikla) → rabat komitenta sa zaglavlja → 0; pa **kap** na `items.max_discount_percent` uz poruku.
Tabela za prvi nivo u BigBitu postoji (`RabatiPoArt`: Šifra, IDArtikal, OdDatuma, DoDatuma,
RabatProc, ExtraRabatProc + gotov upit `Q_RabatKomitentaZaStavkuFakture_ARTIKLI.sql`) — **ali forma
izlazne fakture je danas ne poziva, a tabela ima 0 redova**. Zato: model podržava tri nivoa, UI ga ne
prikazuje u V1.

**(b) Kasa se nikad ne povlači sama.** BigBit je vuče iz **istog reda** tabele `Rabati` kao i rabat
(`RabatProc` + `ExtraRabatProc`, `Q_RabatKomitentaZaStavkuFakture.sql`;
`Doc__Form_Izlazna faktura - Podforma.txt:701`). Naš `resolveDiscount`
(`pricing.service.ts:185-219`) vraća **samo rabat**, a kasa dolazi isključivo iz zahteva — dakle
nikad se ne pojavi sama. Ispravka: `resolveDiscount` vraća par (rabat%, kasa%) sa poreklom.
*(Realnost: `KasaProc` je popunjen na **0 od 20.438 stavki** 2026, a `RabatProc` na 130 — v. §7.)*

**(c) PDV je pojednostavljen do netačnosti.** Tri stvari:

1. **Stopa je zbir pet komponenti** iz tarife (osnovna + železnica + gradska + ratna + posebna) i
   **datumski je verzionisana**. Kod nas **tabela postoji i ima sve to** — `tax_rates` sa
   `base_rate`, `railway_rate`, `city_rate`, `war_rate`, `special_rate`, `valid_from`, `valid_to`,
   `vat_group` — ali `pricing.service.ts:26-32` koristi **hardkodovanu TS mapu** `VAT_RATE_BY_CODE`
   (20/10/8/0). Promena stope = deploy. Ispravka: motor čita `tax_rates` po datumu dokumenta.
2. **Porez se dodaje NA neto** (`porez = stopa × VP/100`), ne izvlači iz bruto.
3. **Da li se porez uopšte obračunava je prekidač po stavci**, koji dolazi iz **vrste dokumenta**:
   `Obračunat porez na robu = [Uvek porez na robu] OR [Prodaja sa PPP]`, isto za usluge sa PPU
   (`Doc__Form_Izlazna faktura - Podforma.txt:629-633, 706`).

> **Ispravka pogrešnog tumačenja.** `Prodaja sa PPP` / `Prodaja sa PPU` **nisu** prekidač
> „kuca se neto ili bruto cena". To su zastavice **da li se obračunava porez na promet proizvoda
> odnosno usluga**. Bruto/neto se izvodi iz **tipa cenovnika** (§4.3). Kod nas kolone već postoje —
> `document_types.sale_with_ppp` / `sale_with_ppu` — treba im samo **ispraviti značenje u
> dokumentaciji i u motoru**, i dodati per-stavka polja `charges_goods_vat` / `charges_service_vat`.
> Bez toga se PDV po stavci ne može ugasiti (oslobođenje, prenos poreske obaveze, izvoz) i mešoviti
> dokument (roba + usluga na istom računu) se ne može uneti.

**Zamka u našem kodu — `overrideUnitPrice`.** Dokumentovan je kao „eksplicitna VP cena iz unosa", ali
se koristi kao **bazna** cena (`pricing.service.ts:62-63, 100-135`): posle njega se i dalje primenjuju
rabat i kasa. Ako ekran pošalje prekucanu krajnju cenu kroz to polje **zajedno sa rabatom kupca**,
cena se umanji **drugi put**. To je najčešći stvarni scenario (prekucavanje cene). Ispravka: dva
odvojena ulaza — `fakturnaCena` (ulazi u lanac) i `netoCenaRucno` (isključuje lanac); ako stignu oba
→ greška. Obavezan test: „prekucana cena + rabat kupca = ta ista cena".

### 4.5 Zaokruživanje i agregacija — ugovor (bez ovoga nema poređenja sa BigBitom „do dinara")

BigBit u **istom futeru** koristi **mešovitu** konvenciju (`OnLine_BigBit_Design/Faktura -
DEFAULT.txt`):

| Veličina | Formula | Red |
|---|---|---|
| Bruto vrednost | `Sum(Round(Kolicina × [Fakturna cena], 2))` — **zaokruži svaki red pa saberi** | :1032 |
| Rabat ukupno | `Round(Sum(Kolicina × [Rabat cena]), 2)` — **saberi pa zaokruži jednom** | :1050 |
| Kasa ukupno | isto kao rabat | :1084 |
| **Osnovica** | `Round(bruto − rabat − kasa, 2)` — **oduzimanjem, ne zbirom neto stavki** | :942 |
| PDV | `Round(Sum(…), 2)` | :961 |
| Taksa | `Round(Sum(Kolicina × TaksaSaKursom), 2)` | :997 |
| Sve ukupno | `osnovica + PDV + taksa` | :1122 |

**Odluka:** zadržavamo BigBit konvenciju 1:1 (inače se stari i novi dokumenti ne slažu), **ali**
osnovicu i izračunavamo kao zbir neto stavki i **prijavljujemo razliku** ako se ne poklopi — SEF
traži da se osnovice stavki slože sa zaglavljem.

**Broj decimala.** BigBit ima jedan sistemski parametar po smeru (`F_BrDecIzKl()` / `F_BrDecUlKl()`).
Kod nas te kolone **već postoje**: `companies.outbound_decimal_places` i `inbound_decimal_places`
(default 2).

**Ispravka jedne tvrdnje:** „Poštuj fakturnu cenu" **nije** podešavanje po vrsti dokumenta — to je
globalna konstanta `POSTUJFAKTCENU = True` (`Module__Bliski susret.txt:4`), zbog čega se sve grane
`If Not POSTUJFAKTCENU Then Round(...)` **nikad ne izvršavaju**: transakciona VP cena se **ne
zaokružuje uopšte**. Zaokružuju se samo cena povučena iz cenovnika (jednom) i MP cena
(`Doc__Form_Izlazna faktura - Podforma.txt:481, 526, 683`). Isto radimo i mi: VP u punoj preciznosti
(Decimal), zaokruživanje na prikazu i na definisanim mestima.

### 4.6 Kurs — tri pojma koja se ne smeju mešati

U BigBitu postoje **dva suprotna smera** i to je izvor najskuplje moguće greške (faktor ~117):

1. **Prikaz/štampa u valuti — DELJENJE.** Ino engleski izveštaj računa `[Fakturna cena]/[Kurs]`
   (`OnLine_BigBit_Design/Copy Of InoFakturaEng.txt:18`).
2. **Akcija „Primeni kurs" — MNOŽENJE, destruktivno.** Upit
   `PrimeniKursZaSveStavkeIF.sql:2` radi
   `SET [Stvarna VP cena] = [Stvarna VP cena] × Kurs, [Stvarna MP cena] = … × Kurs` — **ne dira**
   fakturnu, rabat ni kasu, nema poništavanja i **nije idempotentan**. Uz to postoji globalni
   parametar `F_KursDeli` (`Module__Bliski susret.txt:785-790`) koji u drugim modulima menja smer;
   kod nas mu odgovara `companies.split_exchange_rate` (kolona već postoji).
3. `KNGCena` stavke = `Stvarna VP × Kurs` (`Doc__Form_Izlazna faktura - Podforma.txt:482, 705`).

**Odluka za 4.0 — tri odvojena pojma sa različitim imenima:**

- **`exchange_rate`** na zaglavlju + **poreklo** — konvencija tvrdo fiksirana:
  *kurs = koliko RSD za 1 jedinicu strane valute*.
- **Prikaz u valuti** = iznos u RSD **/** kurs. Samo prikaz i štampa, **nikad upis**.
- **Akcija „Preračunaj cene kursom"** = migracija jedinice cene (kucao sam u EUR → prevedi u RSD).
  Mora: snimiti originalne cene pre primene, biti **idempotentna** (`fx_applied_at`, `fx_applied_rate`
  na dokumentu), preračunati i **fakturnu** cenu (da odnos rabat/VP ostane tačan), i tražiti potvrdu
  sa tačnim tekstom BigBita + našom dopunom: *„Kurs 117,15 je već primenjen 22.07. u 14:30. Ponovna
  primena množi cene PONOVO. Nastaviti?"*

**Tri izvora kursa** (sva tri moraju biti moguća, poreklo se vidi ispod polja):

| Izvor | Kada | Danas |
|---|---|---|
| Kursna lista na dan (BigBit dvoklikom uzima **prodajni** kurs, `Doc__Form_Izlazna faktura.txt:741-743`) | podrazumevano | ✅ `exchange_rates` (buy/middle/sell + source) |
| **Ugovoreni komercijalni kurs** — realna praksa: „125 din za sve kupce, osim Robert Bosch = 118" (`12-bigbit-uputstvo-master.md` PROCES 16a/16c) | prodaja | ❌ tabela `customer_agreed_rates` |
| Kurs sa JCI (4 decimale) | uvoz | ✅ `accounting_exchange_rate` |

### 4.7 Masovne akcije nad svim stavkama

Svaka nosi potvrdu koja **rečenicom** kaže posledicu, pa osvežava tabelu (BigBit obrazac,
`Doc__Form_Izlazna faktura.txt:597-626, 1315-1333`; `…- Podforma.txt:77-101, 833-853, 1015-1037`).
Za svaku se u planu implementacije mora napisati **koja polja menja i koja ne dira**, i posle svake
motor preračunava ceo red da invarijanta iz §4.2 ostane tačna.

| Akcija | Šta radi | Zamka iz BigBita |
|---|---|---|
| Preračunaj cene kursom | v. §4.6 | ne dira rabat/kasu → izvedena fakturna se raspadne |
| **Upiši rabat u sve stavke** | `RabatProc = zadati %`, `VP = [Cena] × (1 − %/100)` | **ignoriše kasu** (ostaje upisana), pa fakturna ≠ cenovnička (`UpisiUSveStavkeIFRabatProc.sql`) |
| Upiši cene iz cenovnika X (+ jedinstven rabat) | — | — |
| Upiši magacin u sve stavke | — | — |
| **Odloženo — tri odvojene akcije** | (1) iz zaglavlja u stavke, (2) **iz artikala** u stavke, (3) **sračunaj ponderisani prosek iz stavki** → zaglavlje → valuta | plan je imao samo (3); ulaz za (3) je `deferral_days` **po stavci** (`…- Podforma.txt:628, 854-892`, `:77-101`) |
| Obriši stavke bez količine | — | — |
| **Upiši cene u cenovnik** | vraća cene dokumenta u cenovnik | **nije samo dugme**: ako je na zaglavlju čekirano `CheckUpisiCeneUCenovnik`, **svako snimanje stavke** dopisuje/ispravlja cenu u cenovniku, a izbor MP vrste dokumenta sam pali taj čekboks (`…- Podforma.txt:179-198`; `Doc__Form_Izlazna faktura.txt:912-918`) → treba `writes_price_list` na zaglavlju + vidljiv indikator |

**Koeficijent — ispravka lokacije.** U planu je bio zamišljen kao polje dokumenta. Pretraga svih 527
formi: reč „koeficijent" na dokumentu **ne postoji**; postoji u (a) parametru rezervacija
(`Module__PROFModul.txt:37-38`) i (b) formi **`IzborZaKreiranjeCenovnika`** — alat „iz cenovnika X u
cenovnik Y, operacija × ili ÷, koeficijent, broj decimala" + filteri (grupa, podgrupa, kat.broj,
barkod, poreklo) + akcije „prepiši cenovnik", „dopiši nove artikle", „upiši cene u artikle"
(`Doc__Form_IzborZaKreiranjeCenovnika.txt:19-47, 95-120, 180-195`). Tabela `Cenovnik` ima **82.855
redova** — to je živ i masovno korišćen mehanizam.

**Preporuka:** ono što vlasnik zove „koeficijent kojim množimo sve" je najverovatnije **generator
cenovnika**. Zato: (1) izgraditi **alat „Generisanje cenovnika"** u Šifarnicima (izvorni → ciljni
cenovnik, × ili ÷, koeficijent, decimale, filteri, pregled pre upisa, poštovanje zaključanog
cenovnika `price_list_entries.is_locked`); (2) koeficijent na dokumentu ostaje **opciono naše
proširenje**, jasno označeno kao novo, sa auditom (`price_coefficient`, `applied_at`, `applied_by`) i
zaštitom od dvostruke primene. ✅ **ODGOVORENO 28.07. (§8/O1): misli se na polje na dokumentu.**
Alat za generisanje cenovnika ostaje zaseban, kasniji posao.

### 4.8 Ulazna kalkulacija — dvosmerni motor (profil P1-ulaz)

Najveća BigBit podforma (1.436 redova): unos u **bilo koje** polje preračunava ostala —
`Fakturna cena ↔ Rabat% ↔ Rabat iznos ↔ Kasa% ↔ Kasa iznos ↔ Nabavna neto ↔ Zavisni trošak dobavljača
(%/iznos) ↔ Zavisni trošak sopstveni (%/iznos) ↔ Akciza ↔ Razlika u ceni (%/iznos) ↔ Kalkulativna VP
↔ Kalkulativna MP`. Ubrzivači: „Prenesi iz poslednje kalkulacije" (18 polja odjednom), „Uzmi prosečnu
nabavnu cenu". Uvoz: `ObracunajUvoz` raspodeljuje carinu i zavisne troškove po ključu
`DevNabCena × količina`. Ako se menja cena artiklu koji **ima zalihe** → trosmerni dijalog
„Menjate cenu na zalihama. Da uradim nivelaciju? Da / Ne / Odustani".
Izvor: `Doc__Form_Ulazna faktura - Podforma.txt:35-60, 212-503, 556-1015, 1075-1370`.

**Kod nas kolone već postoje** (`stock_document_items`: `invoice_price`, `purchase_price_net`,
`dependent_cost_own/supplier`, `calculated_wholesale_price`, `calculated_retail_price`,
`actual_wholesale_price`, `actual_retail_price`, `markup_amount`, `excise`, `fee`, `fixed_tax`,
`fx_purchase_price`, `customs_rate`) i postoji ruta `POST /robno/documents/:id/calculate`. Nedostaje
**ekran**.

### 4.9 Dvosmernost cene — svesno odstupanje, ne paritet

Plan predviđa da unos **neto (VP) cene** izračuna rabat unazad, i da unos **iznosa reda** izračuna
cenu. **BigBit to ne radi:** grana koja bi računala rabat unazad je zakomentarisana
(`Doc__Form_Izlazna faktura - Podforma.txt:536-546`), a pošto je fakturna izvedena, prekucavanje VP
**tiho podiže** prikazanu „cenu pre rabata" na štampi uz nepromenjen rabat. Unos iznosa reda ne
postoji uopšte.

To je navika stara 15 godina (naduvana cena pre rabata). Odluka menja izgled **svih štampi sa
rabatom** → ✅ **ODLUČENO 28.07. (§8/O2): rabat ostaje**, uz upisivu kolonu neto cene kao drugu
tačku unosa (tako se ne može pogrešiti kad je krajnja cena dogovorena telefonom).

---

## 5. ŠTA TREBA DODATI U BAZU

> Sve kolone su `NULL`-abilne ili sa default vrednošću, da migracija ne obara postojeće redove.
> Novac = `Decimal(19,4)`, količina = `Decimal(19,6)`, kurs = `Decimal(19,6)`, procenat =
> `Decimal(19,4)`.

### 5.1 `document_types` (registar vrsta)

```
numbering_group            VarChar(20)   -- INVOICE_OUT | OFFER | ADVANCE | PURCHASE | …
numbering_mode             VarChar(10)   -- SEQ | MAX | COUNT (migracija oba BigBit mehanizma)
screen_kind                VarChar(10)   -- GOODS | SERVICE | ORDER
stock_check                VarChar(10)   -- BLOCK | WARN | OFF
reserves_stock             Boolean  @default(false)
writes_price_list          Boolean  @default(false)
default_price_list_code    VarChar(20)
default_vat_exemption_code VarChar(20)
requires_project           Boolean  @default(false)
requires_work_order        Boolean  @default(false)
requires_po_number         Boolean  @default(false)
allowed_print_variants     String[]      -- šifre varijanti štampe
carry_over_targets         String[]      -- dozvoljeni ciljevi prepisa
```

Uz to: **ispraviti dokumentaciju** kolona `sale_with_ppp` / `sale_with_ppu` — one znače „obračunava
porez na promet proizvoda / usluga", ne „cene su sa PDV".

### 5.2 `warehouses`

```
keeps_stock       Boolean @default(true)   -- F_ProveraZalihaMag: da li magacin uopšte vodi zalihe
costing_mode      VarChar(10) @default("LAST")  -- LAST (poslednja KL) | AVG (prosečne cene)
```

### 5.3 `invoices` (zaglavlje prodajnog dokumenta)

```
-- identitet i audit
year                        Int
document_number_is_manual   Boolean @default(false)
document_number_seq         Int               -- NULL-abilno: izvedeni broj iz „125/26" → 125
document_number_year        Int               -- NULL-abilno: izvedena godina iz sufiksa „/26" → 2026
line_profile                VarChar(10)       -- GOODS | SERVICE; NULL = uzmi iz registra vrsta (§8/O4.5)
summary                     VarChar(255)      -- „Opis": auto pri prepisu, pretraživ (indeks)
internal_note               Text
print_title                 VarChar(50)
unlocked_by_user_id         Int
unlocked_at                 Timestamptz
unlock_reason               VarChar(255)
is_internal_document        Boolean @default(false)  -- gasi ažuriranje statusa predmeta

-- partner i komercijalni uslovi
contact_person_id           Int
delivery_place              VarChar(150)
customer_discount_percent   Decimal(19,4) @default(0)
price_list_code             VarChar(20)
payment_terms               VarChar(255)
payment_method              VarChar(30)
fco                         VarChar(100)
shipping_method             VarChar(50)
payment_account_id          Int

-- datumi
posting_date                Timestamptz
payment_term_days           Int
place_of_supply             VarChar(150)
delivery_date               Timestamptz
gl_order_number             VarChar(20)
gl_order_type               VarChar(10)

-- veze na posao
project_id                  Int
warehouse_id                Int
po_date                     Timestamptz
protocol_text               Text              -- ZAPISNIK, telo (BigBit `Zapisnik` Memo). ISPRAVKA
                                              -- 28.07: NIJE broj — max izmereno 496 znakova, 4
                                              -- istorijska zapisa preko 255. Nikad NOT NULL:
                                              -- popunjen je na 67,6% IFUSL. (§8/O4.1)
protocol_title              VarChar(150)      -- naslov zapisnika; u BigBitu se NE čuva → istorija
                                              -- se ne može migrirati, polje kreće prazno

-- porez i tekstovi
invoice_text                Text
vat_exemption_code          VarChar(20)
vat_exemption_text          Text

-- zbirovi
total_discount_amount       Decimal(19,4) @default(0)
rounding_amount             Decimal(19,4) @default(0)
amount_due                  Decimal(19,4) @default(0)
fx_net_total                Decimal(19,4) @default(0)
fx_vat_total                Decimal(19,4) @default(0)
fx_gross_total              Decimal(19,4) @default(0)

-- ino
exchange_rate_date          Timestamptz
exchange_rate_source        VarChar(20)     -- LIST | MANUAL | AGREED | CUSTOMS
document_language           VarChar(2) @default("sr")
foreign_payment_account_id  Int
incoterm_code               VarChar(10)
incoterm_place              VarChar(100)
statement_number            VarChar(50)
statement_date              Timestamptz
customs_declaration_no      VarChar(50)
customs_declaration_date    Timestamptz

-- masovne akcije (idempotencija)
fx_applied_rate             Decimal(19,6)
fx_applied_at               Timestamptz
fx_applied_by_user_id       Int
price_coefficient           Decimal(19,6)
price_coefficient_applied_at Timestamptz
price_coefficient_applied_by Int
writes_price_list           Boolean @default(false)
cash_discount_percent       Decimal(19,4) @default(0)   -- KKProc zaglavlja → generator KNO
advance_invoice_text        Text

-- vrste-specifično
reserve_stock               Boolean @default(false)     -- PROF „Rezerviši"
valid_until                 Timestamptz                 -- rok važenja ponude (nema u BigBitu)
reissue_of_doc_id           Int                         -- reizdavanje „/1"
reissue_seq                 Int @default(0)
```

Indeksi: `(company_id, numbering_group, year)`, `(company_id, document_number_year,
document_number_seq)` — za „prvi slobodan broj" i za proveru duplikata iz §8/O3, `summary`
(trigram/ILIKE), `project_id`, `warehouse_id`.

> **Broj je TEKST, ne broj.** `document_number` ostaje neprozirni string sa originalnim zapisom
> (`086/26/1`, `0446/25`, `210/26S`, `otp0008-26`, `1/1ПП`, `07/02/25`), a poređenje i predlog
> sledećeg broja idu isključivo preko izvedenih `document_number_seq` / `_year`, koji smeju biti
> `NULL` (52+ istorijska broja se ne parsiraju). Sam BigBit je na tome odustao — upit
> `MaxBrojDokPoVrstama` ima `WHERE IsNumeric([Broj dokumenta])=True`, a `IsNumeric("086/26")` je
> `False`, pa taj upit **ne vidi nijedan stvarni broj izlazne fakture**.

### 5.4 `invoice_items` (stavka)

```
unit                    VarChar(10)
catalog_number          VarChar(50)
foreign_description     VarChar(255)
customs_tariff          VarChar(20)
box_quantity            Decimal(19,6) @default(0)
transport_pack_quantity Decimal(19,6) @default(0)
invoice_price           Decimal(19,4) @default(0)   -- fakturna (bruto) — v. §4.2
base_unit_price         Decimal(19,4) @default(0)   -- cena PRE koeficijenta (§8/O1); koeficijent
                                                    -- se primenjuje izvedeno, nikad upisom u
                                                    -- unit_price, da dvoklik ne pomnoži dvaput
discount_amount         Decimal(19,4) @default(0)
cash_discount_amount    Decimal(19,4) @default(0)
retail_price            Decimal(19,4) @default(0)   -- stvarna MP
fx_unit_price           Decimal(19,4) @default(0)
fx_line_total           Decimal(19,4) @default(0)
purchase_price_net      Decimal(19,4) @default(0)   -- za RUC
markup_percent          Decimal(19,4) @default(0)
price_source            VarChar(20)                 -- PRICELIST | MANUAL | LAST_CALC | AVG | ITEM
discount_source         VarChar(20)                 -- ITEM | GROUP | CUSTOMER | MANUAL | CAP
discount_capped         Boolean @default(false)
charges_goods_vat       Boolean @default(true)
charges_service_vat     Boolean @default(false)
vat_exemption_code      VarChar(20)
fee                     Decimal(19,4) @default(0)   -- taksa (van osnovice!)
excise                  Decimal(19,4) @default(0)
non_taxable_part        Decimal(19,4) @default(0)
warehouse_id            Int
reserved_quantity       Decimal(19,6) @default(0)
project_id              Int
work_order_id           Int
delivery_date           Timestamptz
deferral_days           Int
note                    Text
returned_quantity       Decimal(19,6) @default(0)   -- REVERS
returned_at             Timestamptz
is_returned             Boolean @default(false)
settled_by_doc_id       Int
```

**Izmena tipa:** `description` `VarChar(255)` → `Text` (uslužne stavke imaju višeredne opise).

### 5.5 Nove tabele

```
foreign_payment_accounts      -- devizni računi firme (BigBit INOUplatniRacuni)
  id, company_id, currency VarChar(3), iban VarChar(50), swift VarChar(20),
  bank_name VarChar(150), bank_address VarChar(255), bank_country VarChar(50),
  intermediary_swift VarChar(20), intermediary_bank VarChar(150),
  is_default Boolean, is_active Boolean

customer_contacts             -- kontakt osobe komitenta
  id, customer_id, name VarChar(100), role VarChar(50), email VarChar(150),
  phone VarChar(50), is_default Boolean

customer_agreed_rates         -- ugovoreni komercijalni kurs
  id, customer_id (null = svi kupci), currency VarChar(3), rate Decimal(19,6),
  valid_from, valid_to

document_history              -- istorija izmena (polje, staro → novo, ko, kada)
  id, entity VarChar(20), entity_id Int, field VarChar(50),
  old_value Text, new_value Text, user_id Int, changed_at

price_lists                   -- zaglavlje cenovnika (danas postoje samo stavke)
  code VarChar(20) PK, name VarChar(100), is_gross Boolean, is_locked Boolean,
  currency VarChar(3), valid_from, valid_to
```

### 5.6 `document_number_sequences` — DVE GRUPE, ne sekvenca po vrsti

*Ažurirano 28.07.2026 odlukom §8/O4 — pitanje više nije otvoreno.*

Danas je model ključan **po vrsti dokumenta**:
`@@unique([documentType, year, companyId])` (`backend/prisma/schema.prisma:3970-3982`, na ovoj
grani). To reprodukuje numeraciju koju BigBit nikad nije imao. Dodati `numbering_group VarChar(20)`
i prebaciti jedinstveni ključ na `(numbering_group, year, company_id)`.

| Grupa | Vrste | Napomena |
|---|---|---|
| `INVOICE_OUT` | **IFR, IFGP, IFUSL, IZVRO, IZVGP, IZVUS** | odluka §8/O4.2 — jedan godišnji niz `NNN/YY`, broj se kuca ručno |
| `OFFER` | PON, PROF, OTP | dash-serija `0NNN-YY`; živi BigBit brojač `Poslednji broj profakture = 264` = tačno max te serije u 2026 |
| `ADVANCE` | AVR | **potvrda vlasnika — §9, pitanje 15**; ne sme u `INVOICE_OUT` (100+ istorijskih sudara) |
| `CREDIT` | KNO, KNZ | **§9, pitanje 16**; 81 istorijski dokument, danas nemaju gde da slete |

**Redosled radova je obavezan** (v. §8/O4.4): (1) obori `uq_invoices_company_type_number`;
(2) uvezi istoriju sa originalnim brojevima; (3) **tek onda** prebaci ključ na grupu, uz
konsolidaciju postojećih redova po **`MAX` preko grupe** — prosto brisanje redova vraća brojač
unazad i sledeća faktura dobija već zauzet broj; (4) seed = **max u niskom bloku (1..999) uz ručnu
potvrdu**, nikad sirovi `MAX` (sirovi daje 6061 za 2022. i 262 za 2026, čime bi 219–253 nestali);
(5) blok **254/26–261/26 upiši kao potrošen** (§8/O4.6).

⚠️ **Ovaj ključ važi za BROJAČ, ne za broj na dokumentu.** Po odluci §8/O3, na `invoices.document_number`
se **NE stavlja `UNIQUE`** — ručno upisan duplikat prolazi uz upozorenje. Ali indeks
`uq_invoices_company_type_number` **već stoji na produkciji** i mora se oboriti zasebnom migracijom;
bez toga uvoz pada na 16 istotipskih istorijskih duplikata (v. dopunu uz §8/O3). Zato treba i:

| Ruta | Zašto |
|---|---|
| `GET /v1/sales/documents/broj-zauzet?broj=&godina=` | vraća `{zauzet, dokumenti:[{id, datum, komitent}]}` za žutu traku pri snimanju |
| `GET /v1/documents/next-number?grupa=INVOICE_OUT&godina=` | „prvi slobodan broj" iz **grupe**, po `document_number_seq` — BigBit ima isto dugme |

Lista dokumenata označava duplikate (npr. zvezdicom uz broj), da ne ostanu nevidljivi.

> **Format je i dalje neusklađen.** Naš generator vraća `IFR0043/2026`
> (`backend/src/modules/sales/numbering.service.ts:19-30` + `next()`), BigBit ima `043/26` — dakle
> grešimo istovremeno u prefiksu, u paddingu i u godini. Nastavak serije posle cutover-a nije samo
> seed nego i **promena formata**; format je već presuđen 27.07.
> (`docs/ODLUKA_NUMERACIJA_DOKUMENATA.md` §1: `<broj>/<GG>`, bez oznake tipa). Isto važi za AVR:
> mi pravimo `AVR0001/2026`, BigBit `AVR-00001/2026`.

> **Godina se izvodi iz broja, ne iz kolone `Godina`.** U BigBitu `Godina=2017` je kanta u koju je
> smešteno 12.572 robnih i 3.056 uslužnih redova sa datumima od 2002. do 2016; 1.058 redova ima
> `Godina` različitu od godine u broju (npr. `IFR 277/11` sa `Godina=2017`). Ako se ključ sekvence
> veže za tu kolonu, dobijamo lažne sudare u kanti 2017. i propuštene u ostalim godinama.

> **`Level` nije nacrt.** Naš komentar uz `Invoice.level` („250 = draft / predračun") je **naša
> reinterpretacija**; u BigBitu je `Level` mehanizam nivoa baze/vidljivosti (`WHERE
> Level<=F_NivoBaze()`), a `>=250` se samo koristi kao filter za profakture. U `BB_T_26` **357 IFR i
> 24 IFGP nose `Level=250`**. Doslovan uvoz bi 381 knjižen račun pretvorio u nacrt i izbacio ih iz
> KIF-a i POPDV-a. Mapiranje mora biti eksplicitno, ne prepisano.

### 5.7 Backend rute koje ne postoje (bez njih ekran ne radi)

| Ruta | Zašto | Status |
|---|---|---|
| `GET /v1/lookups/items?q=&key=CATALOG\|BARCODE\|EXT\|PLU\|NAME&warehouseId=` | pretraga artikala + zalihe | ❌ `lookups.controller.ts` ima **samo** projects/customers/warehouses |
| `POST /v1/sales/price-preview` | cena, rabat, kasa, PDV, kap, poreklo, nabavna, RUC | ❌ `PricingService` radi, ali nema rutu — motor je mrtav iz UI-ja |
| `GET /v1/lookups/customers` — proširiti | rok, cenovnik, rabat, paritet, način plaćanja, valuta, limit, saldo, kontakt osoba | ⚠️ vraća minimum |
| `PATCH /v1/sales/documents/:id` + `POST/PATCH/DELETE …/items/:lineId` | **izmena dokumenta** | ❌ `sales.controller.ts` nema **nijednu** PATCH/PUT/DELETE rutu |
| `PATCH /v1/robno/documents/:id` + dodavanje/izmena stavke | isto za robno | ⚠️ postoji samo `DELETE`/`restore` stavke i `PATCH …/shipping` |
| `GET /v1/document-types` | registar vrsta kao konfiguracija ekrana | ❌ |
| `GET /v1/documents/next-number?grupa=&godina=` + transakciona dodela | numeracija bez trke | ⚠️ postoji tabela, nema rute |
| `GET /v1/robno/poslednja-kalkulacija?itemId&warehouseId` | cena + nabavna + zavisni troškovi (§4.3) | ❌ |
| `GET /v1/kursna-lista?datum=&valuta=` + čuvanje porekla | kurs | ⚠️ tabela postoji |
| `Idempotency-Key` na svim kreirajućim rutama | dupli dokument | ❌ |
| `POST /v1/documents/:id/carry-over` (generički, konfiguracija po paru) | prepis | ⚠️ postoji samo PROF→IFR |

---

## 6. ISPORUČIVE CELINE

Redosled je **po stvarnom obimu i po tome gde backend već postoji**, ne po vidljivosti. Posle svake
celine sistem je upotrebljiviji nego pre — nema „sve ili ništa". Veličina je orijentaciona za jednog
programera: **S ≈ 1–2 dana, M ≈ 3–5 dana, L ≈ 6–10 dana.**

| # | Celina | Vel. | Šta korisnik dobija odmah |
|---|---|---|---|
| **C1** | **Tastatura i polja (ui-kit)**: `NumberField` (decimalni **zarez**, hiljade tačka, `inputMode=decimal`, selekcija na fokus), `DateField` (`dd.MM.yyyy.`, kucanje bez tačaka, `+`/`−`/`t`), Enter = sledeće polje, potvrda pri `Esc` sa izmenama | M | **Svi postojeći dijalozi** prestaju da prerano šalju formu i primaju zarez. Nezavisno od punog ekrana. |
| **C2** | **`CodeCombo` + pretraga na serveru**: `GET /lookups/items`, proširen `/lookups/customers`, tastatura ↑/↓/Enter/Tab/Esc, prikaz izabranog u dva reda, „+ unesi novo" | M | Prestaje kucanje **golih internih ID-eva** u predračunu, robnom, nabavci, carry-overu. |
| **C3** | **Ekran ULAZA (UFROB/UFMAT)** — prvi pun ekran: školjka `DocScreen` + `DocGrid`, registar vrsta (`GET /document-types` + kolone iz §5.1), zaglavlje od 8 polja, kalkulacija po stavci | **L** | **69% svih robnih dokumenata** dobija pravi ekran. Backend je gotov, zaglavlje najjednostavnije. |
| **C4** | **Izmena dokumenta**: PATCH rute za prodaju i robno (zaglavlje + stavke), optimistička kontrola, `Idempotency-Key` | M | Greška u nacrtu se **ispravlja**, ne pravi se sve ispočetka. Uklanja najveći funkcionalni regres u odnosu na BigBit. |
| **C5** | **Ekran PONUDE/PREDRAČUNA (PON/PROF)** na istoj školjci; gasi se `NewProformaDialog` | M | ~860 dokumenata godišnje; vlasnikov izričit primer. |
| **C6** | **Cenovni motor**: `POST /sales/price-preview`, tarife iz `tax_rates` po datumu, ugovor o zaokruživanju (§4.5), razdvojeni `fakturnaCena` / `netoCenaRucno`, kasa iz rabatnog reda, cenovnik na dokumentu | M | Cena, rabat i PDV se povlače sami i **vide se pre snimanja**; poređenje sa BigBitom „do dinara". |
| **C7** | **IZLAZNA FAKTURA (IFR/IFGP)**: provera zaliha, RUC upozorenje, prepis PON→IFR sa eksplicitnom tabelom mapiranja polja, varijante štampe + „Štampaj komplet", SEF pred-provera | M | Zatvara se lanac ponuda → račun; danas računa nema kao unosa uopšte. |
| **C8** | **UVOZ sloj**: carinski i obračunski kurs, `OstaliZavTros`, raspodela zavisnih troškova, „napravi kalkulaciju iz SEF e-fakture" | M | 115 dokumenata godišnje, ali najskuplji po grešci. |
| **C9** | **PORUDŽBENICA / trebovanje (P3)**: naručeno/isporučeno/ostatak, rok po stavci, prijem jednim klikom, „prepiši razliku neisporučenog", **batch unos („nalepi iz Excela") sa izveštajem odbijenih redova** i virtuelizacija tabele | **L** | ~3.000 dokumenata godišnje — pojedinačno najveći obim. Jedino mesto gde su dokumenti stvarno dugački (TREB1: medijana 49 stavki). |
| **C10** | **USLUGE (IFUSL) + AVR od nule** — profil `SERVICE` (§2.1): tabela bez kolone artikla/magacina/zaliha, opis kao `Text` sa autocomplete-om istorije, j.m. na stavci, cena neto ili bruto, obavezan radni nalog, mesto/datum prometa, klauzula oslobođenja po stavci, **zapisnik (`protocol_text` + `protocol_title`) sa zasebnom štampom „Zapisnik"**, prilog uz fakturu po obrascu `ChangeRequestAttachment` + `Sy15StorageService`, delimično korišćenje avansa | M | ~150 + ~30 dokumenata; danas AVR ne može da se napravi po ugovoru, a zapisnik ne postoji nigde. |
| **C11** | **INO sloj**: `foreign_payment_accounts` + obavezan izbor na ino dokumentu, engleska štampa sa `INONaziv` fallbackom, dvostruki prikaz iznosa, poreklo kursa, Incoterms | M | Ino faktura prestaje da izlazi bez instrukcija za plaćanje i bez ručno prekucanog IBAN-a. |
| **C12** | **REVERS + repne vrste**: razduženje po stavci sa uparenom validacijom, dve štampe, reizdavanje „/1" | S | Vrsta koja danas postoji samo u filteru liste dobija unos. |

**Kritični put:** C1 → C2 → C3. Bez njih se ekran ne može ni prototipirati na stvarnim podacima.
C4 se sme raditi paralelno sa C3 (druga osoba, čist backend posao).

~~**C0 — pre svega ostalog, i van reda**: blok brojeva **254/26–261/26** označiti kao potrošen u
„crvenoj svesci".~~ — **OTPALO 28.07.2026, odluka vlasnika:**

> „ne brini ti o tome i o brojevima faktura u 26 godini, mi na ovaj software možemo preći tek
> kasnije od nove godine i za to ćemo verovatno imati dosta priprema i brojeva i svega"

**Prelaz je na POČETKU GODINE, i to menja ceo odeljak numeracije.** Brojači kreću od 1, pa
**seed-ovanja iz istorije nema** — otpadaju: izbor između 218 i 262, visoki blok 1000+, 26 različitih
oblika broja koji se ne parsiraju, i potrošeni blok 254–261. Istorijski brojevi se uvoze **samo kao
tekst za čitanje**, nikad kao izvor za brojač. Redosled radova iz §8/O4.4 (koraci 3–5) time postaje
bespredmetan; ostaje samo korak 1 (obaranje `uq_invoices_company_type_number`, koji O3 ionako traži)
i korak 2 (uvoz sa originalnim tekstom broja).

**Šta od spora oko serija preživljava.** Argument protiv razdvajanja (§8/O4.2) merio je sudar sa
**već izdatim** brojevima usred godine — čista godina nema šta da sudari, pa vlasnikova zamisao
(IFUSL svoja serija) prolazi bez uslova o početnoj vrednosti iz §8/O4.7 t.1. **Uslov 2 ostaje
nedirnut i ne zavisi od trenutka prelaza:** ako obe serije krenu od 1 u istoj godini, isti izdavalac
šalje `001/27` dvaput, a ponašanje SEF-a na dupli broj **nije poznato ni u jednom smeru**. Prefiks
`U-001/27` to rešava unapred. Bez roka.

**Redosled u odnosu na uvoz istorije:** C10 (usluge) i svaka migracija `numbering_group` idu **posle**
uvoza istorijskih brojeva i **posle** obaranja indeksa `uq_invoices_company_type_number` — v. §5.6.
Zapisnik pritom ulazi u dva koraka: kolone (`protocol_text`, `protocol_title`) idu odmah sa
migracijom C10, a **uvoz tela zapisnika za 1.984 istorijska dokumenta** ide zajedno sa uvozom
uslužnih faktura; naslovi ostaju prazni jer ih BigBit nije čuvao.

**Definicija gotovog za svaku celinu:**
1. tok prstiju bez miša odrađen na dokumentu sa 3 stavke ispod 40 s **i** na dokumentu sa 20 stavki;
2. provera na 360 / 768 / 1024 / 1440 px;
3. obračun poređen sa **20 stvarnih BigBit dokumenata do dinara**;
4. prekid mreže usred unosa ne gubi ništa;
5. dvoklik na „Snimi" ne pravi dva dokumenta;
6. nijedna nepotpuna stavka nije tiho odbačena.

---

## 7. ŠTA SVESNO NE RADIMO U PRVOJ VERZIJI

Sve dole **postoji u BigBitu**, ali merenje na `BB_T_26.mdb` (2026: 1.858 robnih dokumenata, 20.438
robnih stavki, 1.917 trebovanja / 7.544 stavke) pokazuje da se **ne koristi**. Kolone se prave (da
migracija ima gde da sleti), UI ih ne prikazuje.

| Šta | Merenje | Odluka |
|---|---|---|
| **Kasa-skonto po stavci** | `KasaProc` popunjen **0 / 20.438** | kolona ostaje (motor je već računa), **kolona u tabeli se ne prikazuje** |
| **Rabatna politika (matrica)** | `RabatProc` popunjen **130 / 20.438** (0,6%), i to samo PON 107 / IFR 21 / IFGP 2; šifarnik `Rabati` = **14 redova za 15 godina**; `RabatiPoArt` = **0 redova** | jedna **ručna** kolona Rabat%, vidljiva samo na PON/IFR/IFGP; **ne graditi** rabat-iznos dvosmerno, „Upiši rabat u sve stavke", vidljivo plafoniranje, štampu „sa neto cenama" |
| Ruta, vozač, mesto isporuke | **0%** popunjeno | polja u sklopivom delu, bez šifarnika i bez lanca |
| Organizaciona jedinica (OJ) | **0%** | izostavljeno |
| „Potpisano" (overa) kao posebno pravo | **0%** | izostavljeno; ostaje `updated_by` potpis |
| Fiskalno (`StampanFiskalno`, `IDKasa`, `PrimljenNovac`), barkod dokumenta | **0%** | izostavljeno |
| Akciza, fiksni porez, taksa, neoporezivi deo, carinska stopa po stavci | **0%** na izlazu | kolone da, UI ne |
| Carina i Špedicija na uvozu | **0%** čak i na svih 115 UVOZ dokumenata | UI prikazuje samo `OstaliZavTros` + ZT sopstveni |
| Grupa usluge, razlog oslobođenja po stavci | **0,2% / 0,0%** | kolone se prave (§5.4), UI ih ne prikazuje; klauzulu oslobođenja nosi zaglavlje. **Izuzetak od 28.07:** polje za razlog oslobođenja **po stavci** se prikazuje na profilu `SERVICE` kad je stopa 0 % — bez njega SEF za oslobođenu uslugu nema osnov (BigBit ga na uslugama zove `IDRazlogOslobadjanja`) |
| **KNO / KNZ kao ekran** | **0 dokumenata** u 2025. i 2026. | umesto toga: reizdavanje „/1" sa vezom |
| Mrtve vrste: IZVRO, DONAC, MP1/VPBP/VPOS, USL, POVR, REPRE, OTPIS/MANJAK, NIV, UZ, INOTP | **0 dokumenata** | ne graditi; popis/višak/manjak se generišu procedurom |
| Virtuelizacija tabele, „kartica po stavci" kao unos na telefonu | medijana 1 stavka, p90 7 | virtuelizacija tek u **C9** (trebovanje); telefon u V1 = pregled + jednostavan unos |
| Prikaz „ko još gleda ovaj dokument" (prisustvo) | — | dovoljna optimistička kontrola sa porukom o konfliktu |
| ~~Koeficijent kao polje dokumenta~~ | **ODLUČENO 28.07. — RADI SE** (§8/O1): polje na dokumentu + dugme „Primeni", ali nedestruktivno (`base_unit_price` × `price_coefficient`) | alat „Generisanje cenovnika" (§4.7) ostaje zaseban, kasniji posao |
| `FiktRabatKomitenta` | nijedan poziv u živom kodu | **ne migrirati** |

---

## 8. ODLUKE VLASNIKA (28.07.2026) — obavezujuće

Tri pitanja koja su blokirala početak su odgovorena. Zapisano verbatim + kako se sprovodi.

### O1. Koeficijent JESTE polje dokumenta

> „ja sam mislio na samoj formi profakture imaš koef da uneseš i njime primeni dugme da pomnožiš
> svaku stavku sa tim"

Znači: pitanje 4 se rešava u korist **polja na dokumentu**, ne alata za cenovnik. Alat
„Generisanje cenovnika" (§4.7) ostaje kao zaseban, kasniji posao — nije zamena.

**Kako se sprovodi — bez BigBitove zamke.** BigBitov obrazac „primeni pa upiši" je
**destruktivan**: dugme upiše `cena × koef` nazad u kolonu cene, pa drugi klik pomnoži već
pomnoženo, a koeficijent se posle ne može ni promeniti ni poništiti — tačno isti kvar koji je
nađen kod dugmeta „Primeni kurs" (§4.4).

Zato stavka pamti **osnovnu cenu** (`base_unit_price`, ono što je došlo iz cenovnika ili je
prekucano), a dokument pamti `price_coefficient` (podrazumevano 1,0000). Cena na štampi je
izvedena: `unit_price = base_unit_price × price_coefficient`.

Posledice koje vlasnik dobija, a u BigBitu ih nema:
- dugme se sme pritisnuti **više puta** — rezultat je isti;
- koeficijent se sme **ispraviti** sa 1,15 na 1,10 i sve stavke se preračunaju tačno;
- koeficijent se sme **vratiti na 1** i cene se vrate na izvorne (u BigBitu je to nepovratno);
- na štampi se, ako je koeficijent ≠ 1, može prikazati napomena — ili ne, po izboru.

Prekucana cena stavke upisuje se u `base_unit_price`, pa koeficijent i nju množi — to je
ponašanje koje operater očekuje kad na kraju „digne sve za 5%".

### O2. Kad se prekuca cena — rabat OSTAJE

> „rabat ostaje - daj predlog ako ne valja"

Pitanje 3, opcija (a) — **BigBit ponašanje**. Prekucana cena je cena **pre rabata**; rabat se i
dalje obračunava na nju.

**Predlog dopune (ne menja odluku, uklanja jedini način da se pogreši).** Pravilo je tačno dok
komercijalista u glavi ima cenovnik. Ali kad se sa kupcem **dogovori krajnja cena** telefonom
(„pade na 85 dinara"), pa se otkuca 85 uz rabat 10%, kupac dobije 76,50 — a niko to ne primeti
dok ne stigne reklamacija.

Zato: rabat ostaje kako je vlasnik odlučio, a dodaje se **druga tačka unosa** — kolona
**neto cene** (cena posle rabata) je takođe upisiva. Šta se dešava:
- kucaš u **CENA** → rabat ostaje, neto se preračuna nadole *(odluka vlasnika, podrazumevano)*;
- kucaš u **NETO** → rabat se preračuna unazad tako da neto bude tačno ono što si otkucao.

Jedna istina ostaje ista u oba slučaja i to je ono što se štampa:
`cena × količina − rabat = vrednost`. Nijedna štampa se ne menja.

Uz to: prekucana cena se **vizuelno obeležava** u redu (BigBit to nije imao), pa se na pregledu
dokumenta odmah vidi koja cena nije iz cenovnika.

### O3. Duplikat broja — UPOZORENJE, ne blokada

> „3. upozorenje"

Deo pitanja 1: ručno upisan broj izlazne fakture koji već postoji daje **upozorenje sa pravom
prolaza**, ne odbijanje. Razlog je vlasnikov ranije opisan tok — faktura se u BigBitu pravila
unapred za nekoliko dana, pa se brojevi nisu mogli fiksirati.

Sprovodi se kao: `UNIQUE` indeks se **ne stavlja** na broj izlazne fakture; umesto toga upit pri
snimanju i žuta traka „Broj 125/27 već postoji (dokument od 12.03.2027, kupac X) — svejedno
snimi?". Duplikati se vide i u listi dokumenata kao oznaka, da se ne izgube iz vida.

> **Dopuna 28.07. (uz O4):** indeks o kome je reč **već postoji na produkciji** —
> `uq_invoices_company_type_number` na `(company_id, document_type, document_number)`
> (`backend/prisma/schema.prisma:3870`, primenjen migracijom
> `backend/prisma/migrations/20260725200000_faza2_constraint_mreza/migration.sql:93-96`). Sprovođenje
> O3 zato nije „ne stavljaj indeks" nego **obori postojeći** — zasebnom migracijom, verifikovanom na
> živoj bazi. To nije samo formalnost: u istoriji postoji **16 istotipskih parova (godina, broj)**
> koji bi na tom indeksu pali sa P2002 pri uvozu (npr. `030/14`, `343/18`, `283/19`, `375/20`,
> `1160/21`, `679/22`, `2124/22` — sve IFUSL×2; `1124/17`, `284/11` — IFR×2).

*~~Ostaje otvoreno iz pitanja 1:~~ da li je serija jedna zajednička za IFR/IFGP/IFUSL ili po vrsti* —
**ZATVORENO 28.07.2026 odlukom O4: jedna zajednička serija (`numbering_group = 'INVOICE_OUT'`).**

### O4. Uslužna faktura — POSEBAN EKRAN da, POSEBNA SERIJA ne

> „fr i ifgp je zaajed icska for a i ifusl je posebna jer je s e drugacije nema artikal vec opis
> jsluge i zapisnik"

Rečenica se čita na dva načina i oba su provereni:

- **doslovno** (kako piše): „IFR i IFGP je zajednička **forma**, a IFUSL je posebna **forma**, jer se
  drugačije radi — nema artikal već opis usluge i zapisnik". U izvornom tekstu stoji „for a", ne
  „serija", a obrazloženje koje sledi (artikal, opis, zapisnik) je **isključivo o ekranu**;
- **prošireno**: IFR i IFGP dele **seriju brojeva**, a IFUSL ima svoju.

**Prvo čitanje je potvrđeno u celosti i ide u izradu. Drugo pada na podacima** — i, što je važnije,
protivrečilo bi vlasnikovoj sopstvenoj odluci od pre jednog dana
(`docs/ODLUKA_NUMERACIJA_DOKUMENATA.md` §2, 27.07.2026: „`IFR` (roba), `IFUSL` (usluge), `IFGP`
(gotov proizvod) dele **jednu zajedničku seriju**, broj se kuca ručno").

O4 zato razdvaja dve stvari koje je BigBit slučajno spojio u istu rečenicu: **kako izgleda ekran** i
**odakle dolazi broj**. To su nezavisne osi — u BigBitu je uslužna faktura druga forma nad drugim
tabelama, a broj joj svejedno dolazi iz iste ručno vođene sveske.

#### O4.1 EKRAN — vlasnik je u pravu, i to potvrđeno iz četiri nezavisna izvora

| Tvrdnja vlasnika | Nalaz | Izvor |
|---|---|---|
| „nema artikal" | `T_Usluge stavke` ima **14 kolona** i među njima **nema** `Sifra artikla`, `Kataloski broj` ni `IDMagacin` | `_legacy/_analiza/bigbit/BB_T_26_schema.sql:2142-2158` |
| „nema artikal" (druga potvrda) | adapter upit koji uslužne stavke prikazuje kao robne doslovno puni nule: `0 AS IDMagacin, 0 AS [Sifra artikla], 0 AS KatBroj` | `queries_full/OnLine_BigBit_APL/T_Robne stavke_USL.sql:2` |
| „već opis usluge" | `Opis Text(255) NOT NULL` je jedino obavezno polje stavke; combo opisa nije šifarnik nego autocomplete istorije (`SELECT Opis FROM [T_Usluge stavke] GROUP BY Opis`) | `BB_T_26_schema.sql:2142-2158`; `queries/_sq_cUSLUGA_Faktura___PODFORMA_sq_cComboOpisUsluge.sql` |
| „i zapisnik" | `[Zapisnik]` je **Memo kolona na zaglavlju** uslužne fakture; dugme `DugmePrintZapisnik` štampa zaseban izveštaj `USLUGAZapisnik` | `BB_T_26_schema.sql:2086-2129`; `Doc__Form_USLUGA Faktura.txt:775-794` |
| „drugačije se radi" | zasebne tabele: `T_Usluge dokumenta` (41 kolona, **7.021 red**) + `T_Usluge stavke` (**9.747 redova**), naspram `T_Robna dokumenta` (61 kolona, 27.338) + `T_Robne stavke` (37, 182.535) | `_legacy/BB_T_26_11-07-26_tables.csv` |

Uz to, uslužna faktura ima na zaglavlju polja kojih robna **nema uopšte**: `MestoPrometa Text(30)`,
`DatumPrometa`, `TekstZaFakturu Text(50)`, `Zapisnik` Memo, `PrihvacenDok`, `IDDokUSLVeza`
(`BB_T_26_schema.sql:2086-2129` naspram `:1852-1915`).

**Zapisnik nije mrtvo polje.** Mereno nad `T_Usluge dokumenta` (BB_T_26): od **2.935 IFUSL
dokumenata 1.984 (67,6 %)** ima upisan tekst, i upotreba ne opada — 2024: 76 %, 2025: 73 %,
2026: 76 %. Prosečna dužina **73 znaka, maksimum 496**, četiri zapisa prelaze 255 znakova. Tekst je
slobodan (tipičan početak: „Ovim zapisnikom se konstatuje da je preduzeće Servoteh d.o.o. uradilo
sledeće:"). Tri posledice za nas, sve tri obavezne:

1. kolona mora biti **`Text`**, ne `VarChar(255)` — inače četiri istorijska zapisa pucaju na uvozu;
2. polje **ne sme biti obavezno** — skoro trećina istorijskih IFUSL nema zapisnik;
3. **naslov zapisnika se ne može migrirati.** Kontrola `TekstZaZapisnik` je nevezana kontrola na
   formi i **ne postoji ni u jednoj tabeli** (`USLUGAZapisnik.txt:1056-1057` je čita kao
   `=[Forms]![USLUGA Faktura]![TekstZaZapisnik]`; grep po celoj šemi = 0 pogodaka). Za svu istoriju
   naslov je nepovratno izgubljen; u 4.0 uvodimo trajno polje, bez iluzije da se prošlost popuni.

**Zapisnik se popunjava isključivo ručno.** U celom izvozu ne postoji nijedna linija koda ni upit
koji upisuje u polje `Zapisnik` — pretraga po `_extracted` daje pogodke u 6 fajlova, nijedan u
`queries/` ni `queries_full/`. Iako faktura ima `IDRadniNalog`, iz radnog naloga se **ništa** ne
prepisuje u zapisnik.

**Vlasnik je to nezavisno potvrdio istog dana** (28.07.2026, verbatim):

> „zapisnik se pravi posebno u okviru ifuslu"
> „zapisnik slobodna forma sopstveni sadržaj upisuješ ručno.. nekada ga i iz worda pravimo ali
> bolje da bude ovde sve"

Merenje i vlasnik se slažu u svemu: slobodna forma, sopstveni sadržaj, ručan unos, unutar uslužne
fakture. Dodaje se jedna činjenica koje u BigBitu nema — **deo zapisnika se danas radi u Wordu**, i
cilj je da Word otpadne.

**Zato tri stvari koje BigBit nije imao, a bez kojih Word NE otpada.** Ako se svaki zapisnik kuca od
nule, ljudi se za nedelju dana vrate u Word — tamo se poslednji fajl prosto prepravi, i to je
objektivno brže od praznog polja:

1. **Predlošci zapisnika** (šifarnik, po vrsti usluge) — bira se sa liste, pa se dopuni;
2. **„Prepiši prethodni za istog kupca"** — povuče poslednji zapisnik tog komitenta u polje;
3. **bogat tekst** (pasusi, bold, nabrajanje), jer se u Wordu tako i piše. Prosečnih 73 znaka iz
   istorije nisu merilo — to je dužina koju BigBitovo polje *trpi*, ne koju posao traži.

Zaglavlje i potpisne linije se **ne kucaju** — povlače se iz dokumenta (firma, kupac, „br. " + broj,
datum, mesto prometa), tačno kao u `USLUGAZapisnik`. Time unos ovde postaje **brži** od Worda, a ne
samo uredniji, i zapisnik ostaje uz fakturu umesto da se gubi po folderima.

**Šta zapisnik jeste, a šta nije.** Jeste zaseban **štampani obrazac** koji poslovno menja
otpremnicu; nije zaseban dokument sa svojim brojem, ne knjiži se i nije poseban zapis u bazi. Telo
izveštaja je **jedno jedino polje** — cela Detail sekcija ima jedan TextBox `ControlSource="Zapisnik"`
(`USLUGAZapisnik.txt:1131-1159`), bez podizveštaja i bez stavki fakture. Zaglavlje nosi memorandum,
blok kupca, „br. " & broj dokumenta, datum dokumenta i „Mesto: " & `MestoPrometa`
(`ibid.:1038, 912, 1094`). Potpisuje se: **dve vidljive potpisne linije** — levo `="Za " & [Naziv]`
(kupac), desno „Za " + naša firma, uz ime izvršioca i broj lične karte (`ibid.:1312, 1331-1332,
1277, 1294`).

> **Ne praviti polje „Kontrolisao".** Treća potpisna linija i njena labela postoje u dizajnu ali su
> **isključene** — `Text99` i `Line209` imaju `Visible = NotDefault`, tj. `False`
> (`USLUGAZapisnik.txt:1219-1256`), dok susedne linije `Line207`/`Line208` taj atribut nemaju.
> Servoteh ju je svesno ugasio.

Zapisnik **podrazumevano ne ide na SEF** — jedini hardkodiran SEF prilog za usluge je sama faktura
(`ER_USLUGAFaktura`, `Doc__Form_ER_KnjigaStatusa_Usluge.txt:619-626`). Prilozi u BigBitu jesu
generički (do tri, `Class__ER_Class.txt:752-768`), ali se biraju **konfiguracijom**
(`ER_Prilog1_<IzTabele>`, `Doc__Form_ER_Export.txt:108-135`), ne kodom. Dakle: zapisnik = papir, uz
mogućnost da se kasnije uključi kao prilog.

#### O4.2 SERIJA — ostaje JEDNA ZAJEDNIČKA, i to je izmereno, ne pretpostavljeno

Serija `NNN/YY` je deljena između **IFR + IFGP + IFUSL + IZVGP + IZVUS (+ IZVRO)**. Pet nezavisnih
merenja, od kojih nijedno nije uspelo da se obori:

1. **Hronološko preplitanje 2026.** Neprekinut niz od 45 do 62, bez ijedne rupe i bez ijednog
   duplikata: 45 IFR, 46 IFUSL, 47 IFUSL, 48 IFUSL, 49–51 IFR, 52 IFUSL, 53 IFGP, 54–58 IFR,
   59 IFUSL, 60 IZVUS, 61–62 IFR. Isto na početku godine: 001–002 IFR, 003 IFGP, 004 IFR,
   005–006 IFUSL, 007–014 IFR, 015 IFUSL, 016 IZVUS. *(mdb: `T_Robna dokumenta` + `T_Usluge
   dokumenta`, `BB_T_26_11-07-26.mdb`)*
2. **Obim i pokrivenost 2026** (presek 11.07.2026, podaci do 10.07.2026): IFR 151, IFGP 27,
   IFUSL 50, IZVUS 2, IZVGP 0. Dva nezavisna prebrojavanja dala su **228 odn. 230 dokumenata na
   221 odn. 222 različita broja** u opsegu 001/26–218/26 (razlika je u tretmanu radnih kopija sa
   sufiksima „-"/„S"; zaključak od nje ne zavisi). Pokrivenost opsega **98,2 %**.
3. **Godina 2017 — najjači dokaz.** To je jedina puna godina u kojoj robna tabela **nije očišćena**
   (godina uzeta iz sufiksa `/YY` u broju, ne iz kolone `Godina` — v. zamku niže). IFUSL zauzima
   **300** brojeva, IFR **215**, a **presek je tačno 0**. Da IFUSL ima svoj brojač, oba bi bila
   gusta od 1 naviše i dala bi oko **215 kolizija**.
4. **Gustina kroz deceniju.** IFUSL u sopstvenom opsegu zauzima **12–23 %** brojeva — devet
   izmerenih godina u nizu 2017–2026 daje 17,3 / 18,7 / 21,0 / 19,7 / 19,3 / 14,5 / 12,5 / 22,7 /
   20,3 %. Sopstveni brojač dao bi ~100 %, i to bez izuzetka kroz celu deceniju.
5. **Registar vrsta to i konfiguriše tako.** U `R_Vrste dokumenata` postoje kolone `PrefiksBrojaDok`
   i `NumeracijaOd` baš za numeraciju po vrsti. `AVR` ima „AR-", `PON` ima „PN-", a
   **IFR, IFGP, IFUSL, IZVGP, IZVUS i IZVRO svi imaju PRAZAN prefiks i `NumeracijaOd=0`** — baš one
   vrste koje bi se razdvajale su jedine bez sopstvene numeracije
   (`_extracted/rule_tables/BB_T_26/R_Vrste dokumenata.csv`). Uz to je i sam mehanizam prefiksa
   **namerno ugašen** — linija je zakomentarisana u sve tri forme (`Doc__Form_Izlazna
   faktura.txt:908`, `Doc__Form_USLUGA Faktura.txt:645`, `Doc__Form_Profaktura.txt:565`).

**Anti-test.** Sumnja da je preplitanje artefakt naknadne izmene vrste ili antidatiranja je
proverena nad `DatIVreme`/`DatumIVreme` (vreme nastanka sloga, koje operater ne kuca): IFR i IFUSL se
prepliću i po vremenu nastanka.

**A sada odlučujuće — šta bi razdvajanje uradilo u praksi.** Podela je simulirana nad stvarnim
podacima (ROBA = IFR+IFGP+IZVGP+IZVRO, USLUGE = IFUSL+IZVUS), sa sekvencama seed-ovanim iz istorije:

| Godina / varijanta | Sledeći broj po podeli | Šta se desi |
|---|---|---|
| 2026 (sa blokom 254–261) | uslužni **256/26** | 256–261 su **već izdati** kao IFR → **šest sudara zaredom** |
| 2026 (bez tog bloka) | uslužni **217/26** | 217 i 218 su IFR → sudar na **prvoj** uslužnoj fakturi; 10 sudara u sledećih 50 brojeva |
| 2025 (spojeno iz oba dump-a) | robni **486/25** | 486 je već IFUSL → 8 sudara u sledećih 60 brojeva (486, 491, 492, 498, 500, 504, 506, 511) |

Razlog je strukturni, ne slučajan: **u 2026 svih 51 uslužnih brojeva leži UNUTAR robnog opsega, a u
2025 njih 102 od 103.** Brojevi nisu razdvojeni po bloku nego izmešani stavku po stavku — dve serije
se iz ovakve istorije ne mogu rekonstruisati ni unazad ni unapred.

**Zaključak O4.2:** `numbering_group = 'INVOICE_OUT'` za **IFR, IFGP, IFUSL, IZVRO, IZVGP, IZVUS**.
Time je pitanje IZVGP/IZVUS, koje je u planu stajalo otvoreno, **zatvoreno za period 2024–2026**
(za starije godine dokaz je konfundiran arhiviranjem — v. O4.3).

#### O4.3 Šta smo pokušali da dokažemo i NISMO uspeli (pošteno, da se ne ponavlja)

Sledeći argumenti su u ranijim analizama nosili oznaku „dokazano" i **povučeni su**:

- **„Dokaz na nivou koda" — povučen.** Tvrdnja da obe forme koriste isti brojač
  `Parametri za rad![Poslednji broj fakture]` je tačna kao činjenica
  (`Doc__Form_Izlazna faktura.txt:137-141`; `Doc__Form_USLUGA Faktura.txt:148-162`), ali **ne
  dokazuje deljenu seriju**: (a) to je dugme „Odredi slobodan broj", tj. ručni override, a ne
  podrazumevani put; (b) isti brojač daje **različit format** po formi — robna `DoChLeft(…,5,"0")`,
  uslužna `DoChLeft(…,4,"0")`; (c) živa vrednost tog brojača je `Poslednji broj fakture = 19` uz
  `Faktura prefix = "otp"` i `Faktura kroz = "-26"`, što proizvodi `otp0019-26` — a takvih
  dokumenata u celoj 2026. ima **četiri** (`mdb-export 'Parametri za rad'`).
  **Kod, naprotiv, radi po vrsti i po tabeli:** robna zove `SledeciBrojDokumenta` nad
  `Robna dokumenta`, uslužna `SledeciBrojDokumentaUsluga` nad `T_Usluge dokumenta`
  (`Module__DodelaPLU.txt:42-101` i `:103-129`). Ali ti generatori ispisuju `IFR-00043/2026` odn.
  `IFU-00533/2026`, a **takvih brojeva u izlaznim fakturama nema**. Serija `NNN/YY` je
  administrativna konvencija („crvena sveska"), ne kod. **Zaključak preživljava isključivo na
  podacima.**
- **„SEF potvrđuje" — povučen.** Tabela `T_ER_StatusDokumenata` **uopšte ne sadrži broj dokumenta**
  (kolone: ID, IDFirma, IzTabele, IDDok, RequestID, Status, InvoiceID, GlobalUID…), pa se iz nje
  jedinstvenost broja ne može ni izmeriti. Jedini merljivi duplikat (`194/25` IFR vs `194/25` IZVUS,
  oba `Zakljucano=1`) **nikada nije poslat** — postoji samo jedan od njih, i to sa statusom „Draft".
  Ponašanje SEF-a na dupli broj **nije poznato ni u jednom smeru**.
- **„Format je tačno `NNN/YY`" — povučen.** Nad celom istorijom izlaznih faktura izbrojano je **26
  različitih oblika broja**. Četvorocifreni nije retkost nego **969 dokumenata**; 2022. ih je bilo
  **više nego trocifrenih** (132 : 128). Postoje i `NN/NN` (43×), `NNN/NN/N` (34×), goli `NNNN`
  (16×), `IFU-00001/2026`, `otp0008-26`, `FA-NNN/NN`, `B93/11`, `I47/11`, `NNN/NN.`, pa i **`1/1ПП`**
  (ćirilica u broju) i **`07/02/25`** (datum otkucan u polje broja — IFR 2025, normalizuje se na 7 i
  sudara sa `007/25`). Najveći broj u istoriji nije 662 nego **6060** (IFUSL 2022).
- **„Postoje samo 2 kolizije" — povučeno.** Exact-string duplikata para (godina, broj) ima **22**, od
  čega **16 istotipskih** — v. dopunu uz O3.
- **Postoji i drugi, „visoki" blok brojeva.** Od 2015. do 2023. paralelno je korišćen niz od 1000
  naviše (2021: IFUSL 163 broja u 1000..1895; 2022: 132 u 1025..6060). To **nije IFUSL-ova serija** —
  i IFR koristi isti blok (2017: IFR 141 broj u 1000..1713 uporedo sa IFUSL 144 u 1024..1808, **bez
  ijedne kolizije**). Dakle deljene serije su bile **dve** (niska 1..999 i visoka 1000+), i zbog toga
  seed brojača po sirovom `MAX` puca.
- **Za godine pre 2024. dokaz je konfundiran.** `T_Robna dokumenta` se arhivira po godini u zasebne
  `.mdb` fajlove, pa u `BB_T_26` robne strane za 2011–2023 gotovo i nema (2021: IFUSL 349 zapisa vs
  IFR 5; 2022: IFUSL 260 vs IFR 0). „Nema kolizije" u starim godinama je delom posledica toga što
  druga strana serije nije u fajlu. Zaključak stoji čvrsto za **2024–2026**.
- **„Brojevi rastu strogo hronološki" — povučeno.** Mereno po `Datum dokumenta` (koji se slobodno
  kuca) izgleda tako, ali po **vremenu nastanka sloga** u 2026. ima **27 inverzija na 222 broja
  (12 %)**, sa razmacima do pet nedelja. Posledica: **redosled pri uvozu se ne sme rekonstruisati po
  broju.**

#### O4.4 Kako se O4 sprovodi u šemi

| Osa | Vrednost | Vrste |
|---|---|---|
| `document_types.screen_kind` | `GOODS` | IFR, IFGP, IZVRO, IZVGP, PON/PROF robni, OTP, TREB… |
| | `SERVICE` | **IFUSL, IZVUS**, PON/PROF u uslugama, ZAP |
| | `ORDER` | porudžbenica, upit dobavljaču |
| `document_types.numbering_group` | `INVOICE_OUT` | **IFR, IFGP, IFUSL, IZVRO, IZVGP, IZVUS** |
| | `OFFER` | PON, PROF, OTP (dash-serija `0NNN-YY`) |
| | `ADVANCE` | AVR — **v. §9, pitanje 15** |
| | `CREDIT` | KNO, KNZ — **v. §9, pitanje 16** |

Dakle: **dve ose, ne jedna.** Vlasnik dobija tačno ono što je tražio na osi ekrana, a serija ostaje
onakva kakva je i po njegovoj odluci od 27.07. i po podacima.

**Redosled radova je obavezan** (svaki drugi redosled obara uvoz):

1. obori `uq_invoices_company_type_number` (O3 to ionako traži);
2. uvezi istoriju **sa originalnim tekstom broja**, bez prenumerisanja, uz odvojenu izvedenu
   numeričku kolonu (`document_number_seq`, `document_number_year`, oba `NULL`-abilna — 52+ broja se
   uopšte ne parsiraju obrascem `NNN/YY`);
3. **tek onda** prebaci ključ `document_number_sequences` sa `(document_type, year, company_id)` na
   `(numbering_group, year, company_id)`, uz konsolidaciju postojećih redova po **MAX preko grupe**
   (prosto brisanje redova vraća brojač unazad i sledeća faktura dobija zauzet broj);
4. seed brojača = **max u niskom bloku (1..999) uz ručnu potvrdu**, nikad sirovi `MAX` (sirovi MAX
   daje 6061 za 2022. i 262 za 2026, čime bi brojevi 219–253 nestali);
5. rezerviši blok 254/26–261/26 kao potrošen — v. O4.6.

#### O4.5 Profil ekrana je PODRAZUMEVAN, ne tvrdo pravilo po vrsti

Vrsta dokumenta u BigBitu **ne određuje tabelu ni formu**. U `BB_T_26`: tri IFUSL dokumenta žive u
`T_Robna dokumenta` (`420/14`, `857/16`, `1284/17`), a u `T_Usluge dokumenta` žive IFR (`1784/21`,
`07/02/25`), IZVRO (`1556/17`) i **IFGP, uključujući `068/26` iz tekuće 2026. godine** — faktura za
gotov proizvod uneta bez ijedne robne stavke. Uz to u „uslužnoj" tabeli žive i PON (2.010), PROF
(373), OTP (148), AVR (1.398), KNO (75), KNZ (6).

Posledica: ako `screen_kind` bude tvrda validacija („IFGP ⇒ artikal obavezan"), **uvoz odbija stvarne
podatke iz godine u kojoj radimo**. Zato profil dolazi iz registra kao **predlog**, a zaglavlje nosi
prekucljivu kolonu `line_profile` (`GOODS` | `SERVICE`) za pojedinačan dokument. U UI-ju to je
prekidač vidljiv samo administratoru; korisnik ga u 99 % slučajeva ne vidi.

#### O4.6 HITNO — blok 254/26–261/26 se mora rezervisati odmah

U 2026. postoji blok brojeva **254/26–261/26**, izdat **26.02.–02.03.2026** (7× IFR + 1× IFUSL
`255/26`), dok je normalna serija tog datuma bila na ~053; posle njega se serija vratila na 054/26 i
nastavila normalno. Vremenske oznake nastanka sloga su stvarne (26.02.2026 15:18 → 02.03.2026 14:04),
komitenti su raznorodni (1000518, 1002613, 11897, 1000678, 1004143, 1003325), `IDFirma=0` i `OJ=0` na
svim redovima — dakle nije ni druga firma, ni rezervacija za jedan ugovor, ni retroaktivna izmena.
Ti brojevi su **potrošeni unapred**.

**Procena kada ih serija stiže** (ekstrapolacija, ne merenje): dinamika izdavanja po mesecu nastanka
u 2026. je jan 22, feb 28, mar 34, apr 35, maj 38, jun 32, prvih 10 dana jula 31 → oko **33 broja
mesečno**. Serija je 10.07. bila na **218**; do 254 je 36 brojeva ≈ 33 dana → **sredina avgusta
2026**. Ako je tempo ostao isti, danas (28.07.) je serija već na ~235–245.

**Radnja, danas, bez čekanja 4.0:** brojevi 254–261 se u „crvenoj svesci" moraju označiti kao
potrošeni i preskočiti. Pri uvozu se moraju uneti kao zauzeti, a sekvenca seed-ovati na 218 (ne 262).
Ovo je jedini nalaz iz celog paketa koji ima **rok**.

#### O4.7 Ako vlasnik ipak insistira na odvojenoj seriji — dva uslova bez kojih se ne sme

Odluka je vlasnikova i sme se doneti (BigBit numeraciju nikad nije sprovodio softverski, pa se
razdvajanjem ne krši nijedan zatečen invarijant). Ali onda važi:

1. **Istorija se uvozi deljena, bez prenumerisanja.** Odluka važi samo unapred, od datuma preseka.
   Početna vrednost nove IFUSL serije mora biti **eksplicitna odluka politike** (npr. restart na 1),
   **nikad izvedena iz istorije** — inače sistem pročita najveći istorijski IFUSL broj (662 za 2025)
   i krene od 663, pravo u IFR opseg.
2. **Razlikovni prefiks je obavezan.** Bez njega bi od 2027. isti izdavalac imao `IFR 001/27` i
   `IFUSL 001/27` — dva računa istog izdavaoca sa istim brojem u istoj godini. Tvrdnja da SEF to
   odbija je **nedokazana u oba smera** (v. O4.3), pa je pravni rizik neproveren. Predlog:
   `U-001/27`. **Pitanje 14 u §9.**

**Vlasnik je 28.07. sam rasporedio izvozne fakture** (dopuna uz O4, verbatim):

> „izvgp ide sa ifr i ifgp a izvus ide sa ifusl"

| | Robna strana | Uslužna strana |
|---|---|---|
| **Vrste** | IFR · IFGP · **IZVGP** | IFUSL · **IZVUS** |

Na **osi ekrana** to je tačno i već je tako u O4.4: `IZVGP → GOODS`, `IZVUS → SERVICE`. Izvozna
faktura je ista vrsta posla kao domaća, samo drugo poresko oslobođenje — nema razloga da joj ekran
bude drugačiji. **Ovaj deo ide u izradu bez ograde.**

Na **osi numeracije** ovo je isti sporni potez kao razdvajanje IFUSL-a i za njega važe oba uslova
gore. Merenje: u 2026. `IZVUS` zauzima brojeve **016/26** i **060/26** — oba usred robnog niza, a
060/26 leži u onom neprekinutom nizu 45→62 koji meša sve vrste. Znači ni izvozne fakture nisu
imale svoj blok.

---

## 9. PITANJA ZA VLASNIKA

Samo ono što se **ne može odlučiti iz podataka ni iz koda**.
*(Pitanja 1, 3 i 4 su odgovorena — vidi §8; ostavljena su zbog obrazloženja. Nova pitanja koja je
otvorila odluka O4 su 14–17.)*

1. ~~**Numeracija — jedna serija ili po vrsti?**~~ — **ZATVORENO 28.07.2026 (§8/O4).**
   Kod BigBita broji **po vrsti** (`Doc__Form_Izlazna faktura.txt:900-911`), a paralelno postoji i
   drugi mehanizam — brojač u tabeli „Parametri za rad" preko dugmeta „Odredi slobodan broj"
   (`ibid.:123-160`; `Doc__Form_Profaktura.txt:106-146`). U podacima 2025. ipak izgleda kao da
   IFR+IFGP+IFUSL+IZVGP+IZVUS čine **jedan godišnji niz NNN/YY** — što bi bila posledica ručnog
   prekucavanja „iz crvene sveske", ne koda.
   **Odgovor:** jedna zajednička serija (`numbering_group = 'INVOICE_OUT'`) za IFR, IFGP, IFUSL,
   IZVRO, IZVGP, IZVUS; duplikat je **upozorenje**, ne blokada (§8/O3). Ostatak pitanja koji je
   odluka O4 otvorila prešao je u pitanja **14–17**.

2. **Kada se dodeljuje broj?** Pri kreiranju nacrta (rupe u nizu kad se odustane) ili tek pri prvom
   snimanju sa stavkom (predlog plana)? Rupe su knjigovodstveno pitanje, ne tehničko.

3. **Kad komercijalista prekuca krajnju cenu — šta se dešava sa rabatom?**
   (a) BigBit ponašanje: rabat ostaje kakav jeste, a „cena pre rabata" na štampi poraste;
   (b) rabat se izračuna unazad, fakturna ostaje. **Odluka menja izgled svih štampi sa rabatom.**

4. **Koeficijent** — da li se misli na alat „iz cenovnika X u cenovnik Y × koeficijent"
   (`Doc__Form_IzborZaKreiranjeCenovnika.txt`) ili na množenje cena **na jednom dokumentu**? Ako oba,
   koji je prioritet?

5. **Kurs** — koji se kurs predlaže za prodaju (BigBit dvoklikom uzima **prodajni**)? Da li uvodimo
   „ugovoreni kurs po kupcu" kao šifarnik (praksa: 125 za sve, 118 za Robert Bosch) ili ostaje ručni
   upis?

6. **Provera zaliha na izlaznim fakturama** — tvrda blokada kao u BigBitu, ili upozorenje sa pravom
   prekoračenja? Ako sa pravom — **koja rola** sme da prekorači?

7. **Izmena PROKNJIŽENOG dokumenta** — dozvoliti uz storno-trag, ili isključivo protivdokument /
   reizdavanje sa sufiksom „/1" kao u BigBitu?

8. **Ko sme da otključa** zaključan dokument i da li je razlog otključavanja obavezan?
   (BigBit ne beleži ni ko ni zašto.)

9. **Paritet isporuke (FCO)** — uvodimo pravi Incoterms šifarnik ili ostaje slobodan tekst kao u
   BigBitu? (Podaci su danas neujednačeni; na ulazima je polje popunjeno 0%.)

10. **Prag mekog RUC upozorenja** (BigBit koristi tvrdih 25%) i ko ga podešava.

11. **Slobodna stavka bez artikla na robnom dokumentu** — dozvoliti (kao danas u predračunu) ili je
    artikal obavezan? *(Delimičan odgovor iz koda: BigBit dozvoljava prekucavanje naziva preko
    šifarničkog, `Doc__Form_Profaktura - Podforma.txt:285-287` — mi to zadržavamo kao snapshot.)*

12. **Ulazna kalkulacija** — preuzimamo li BigBit dijalog „Menjate cenu na zalihama — da uradim
    nivelaciju?" ili se nivelacija radi isključivo zasebnim dokumentom?

13. **Uslovi plaćanja** — ostaju slobodan tekst (BigBit), ili pravimo šifarnik (avans 100% / 50-50 /
    po isporuci / kompenzacija) koji ide i na štampu i u SEF?

*Pitanja koja je otvorila odluka O4 (28.07.2026):*

14. **Potvrda čitanja odluke O4 — jedno pitanje, dva ishoda.** Razumeli smo izjavu od 28.07. kao
    „IFR i IFGP dele **formu**, IFUSL ima svoju formu" — što se poklapa sa odlukom od 27.07. da sve
    izlazne fakture dele **jednu seriju brojeva**
    (`docs/ODLUKA_NUMERACIJA_DOKUMENATA.md` §2). Ako je mišljena i **odvojena serija brojeva** za
    IFUSL, treba odgovoriti na dopunu: **kakav razlikovni prefiks nosi nova uslužna serija**
    (predlog `U-001/27`) i **od kog broja kreće** (predlog: restart na 1)? Bez toga bi od 2027. isti
    izdavalac imao `IFR 001/27` i `IFUSL 001/27`; ponašanje SEF-a na dupli broj **nije poznato**
    (v. §8/O4.3), pa se podela ne sme implementirati naslepo. *Blokira samo celinu C10, ne početak.*

15. **AVR — svoja serija, potvrda.** Podaci kažu da AVR od 2025. ide **svojim** nizom
    `AVR-00001/2026` (i pre toga, 2016–2024, sopstvenim `NNN/YY` nizom koji se sa fakturnom serijom
    **preklapao preko 100 puta**: 2016 = 27, 2019 = 16, 2021 = 16, 2020 = 11 poklopljenih brojeva).
    Odluka od 27.07. za AVR navodi format `<broj>/<GG>` sa primerom `77/27`, što se čita i kao
    zajednička serija. Pitanje: **AVR ima svoj brojač (`numbering_group='ADVANCE'`) — potvrda?**
    Ako uđe u zajedničku grupu, uvoz istorije pada na stotinak redova.

16. **KNO / KNZ — gde ih smestiti.** Knjižnih odobrenja/zaduženja u 2025. i 2026. **nema nijedno**,
    ali istorijski postoji **75 KNO + 6 KNZ**, sa sopstvenom četvorocifrenom serijom (`0001`,
    `0002`…) i jednim sudarom sa fakturom (2024, broj 55, KNO vs IFUSL). Danas ne postoje ni u
    `PREFIX_BY_TYPE` (`backend/src/modules/sales/numbering.service.ts:19-30`), ni u komentaru
    `Invoice.documentType`, ni u `carry-over.service.ts` — uvoz ih **nema gde da smesti**.
    Predlog: `numbering_group='CREDIT'`, bez posebnog ekrana (§3.5 to već tako rešava).

17. **Nedostaje ~130 izlaznih faktura iz 2025 — treba arhivski `.mdb`.** BigBit prazni Level-0
    knjigovodstvene dokumente iz žive baze za zatvorene godine (`BB_T_26` za 2022/2023/2024 sadrži
    samo PON/OTP/REZM/REZR/PROF), a `BB_T_25.MDB` koji imamo **staje 22.08.2025** sa najvećim brojem
    485. Uslužna tabela se nikad ne prazni, pa se vidi da je serija 2025. išla najmanje do **662/25**
    (26.12.2025). U opsegu 486..662 pokriveno je svega **26,6 %**, i to isključivo IFUSL (46) +
    IZVUS (1). Dakle **IFR/IFGP za 23.08.–31.12.2025 ne postoje ni u jednom fajlu koji imamo.**
    Molba: **godišnji arhivski `.mdb` za 2025 (i za ranije godine) od Slaviše/BigBita.** Bez njega
    KIF/POPDV za 2025. ne može da se rekonstruiše, a to je baš test na kome se 4.0 dokazuje do
    aprila 2027.
