# Pregled dokumenata u ServoSync 4.0 — može li se ući, pregledati i odštampati

**Datum:** 26.07.2026.
**Pitanje vlasnika:** „Proveri mi modul npr. nabavka ili SEF fakture — da li omogućava da uđem u
sva dokumenta da ih odštampam i pregledam? Sada nemam dokumenta pa ne znam."
**Metod:** revizija koda + **živa proba na DEV bazi** (192.168.64.28:5437) — dokumenti su
zasejavani kroz stvarne servise, štampani, mereni u bajtovima, pa brisani. Gde se kod i proba
ne slažu, u tekstu piše izričito i **veruje se probi**.
**Napomena:** ovo je revizija, ne popravka — aplikativni kod nije menjan.

---

## 0. ŠTA JE U MEĐUVREMENU POPRAVLJENO (27.07.2026, grana `feat/4.0-bigbit-nocni-sync`)

Od 21 nabrojanog kvara popravljena su **DVA — ona koja su blokirala paralelni PDV obračun**.
Ostatak ovog dokumenta ostaje na snazi; ništa drugo nije dirano.

| # | Kvar | Stanje |
|---|------|--------|
| 3.1 | Detalj dokumenta se ne otvara u objavljenoj aplikaciji (5 modula) | **POPRAVLJENO** |
| 3.3 | KIF/KUF/PP-PDV daju besmislene iznose bez upozorenja | **POPRAVLJENO** |
| 3.2, 3.4–3.21 | sve ostalo | **OSTAJE — nije dirano** |

**3.1 — dokumenta se otvaraju.** Pet modula je prebačeno sa `[id]` ruta na statičku rutu
`/<modul>/detalj?id=N`. Posle čistog build-a u `frontend/out` postoje stvarni fajlovi
(`fakturisanje/detalj.html` 11.321 B, `glavna-knjiga/detalj.html` 11.323 B, `izvodi/detalj.html`
11.309 B, `nabavka/detalj.html` 11.311 B, `robno/detalj.html` 11.307 B), a placeholder fajlova
`_` / `_.html` više **nema nijednog** u celom `out/`. Uz to: povratak na listu vraća i filtere i
stranu (ranije se posle svakog otvorenog dokumenta gubio filter i strana 7 od 625 faktura), Esc
u otvorenom dijalogu više ne izbacuje korisnika sa ekrana i ne briše unos, a greška servera se
više ne prikazuje kao „dokument je možda obrisan".

**3.3 — PDV daje tačne brojeve.** Za 03/2026 na dev bazi, kroz stvarne servise:

| | PRE | POSLE |
|---|---|---|
| KUF | 625 stavki, UKUPNO **0,00** | 666 stavki, PDV **26.689.144,42**, osnovica 133.498.724,55 |
| KIF | osnovica **0,00**, PDV −1.236.156,30 | 43 stavke, PDV **5.086.854,53**, osnovica 25.434.272,65 |
| PP-PDV poz. 110 (povraćaj) | **1.236.156,30** | **21.602.289,89** |
| BigBit nalog zatvaranja (2790/4790) | — | 21.602.291,00 (razlika 1,11 = zaokruženje) |

Rekonsilijacija protiv BigBita prolazi za **svih 6 zatvorenih meseci 2026** (`7 prolaz / 0 pad`,
`backend/scripts/pdv-rekonsilijacija.ts`), a implicitna stopa svake knjige je sada 19,9–20,0%
(bila 6,99–20,33%). Zaštita od tihe greške ima 5 pravila i vidi se **i na ekranu i u CSV izvozu**,
ne samo na PDF-u; KIF/KUF lista je dobila podnožje sa zbirom — baš onaj broj koji je nedostajao.

**Šta i posle ovoga NIJE gotovo u PDV-u** (nužan, ne dovoljan uslov za predaju):

- PP-PDV **pozicije 001 i 002** (promet oslobođen PDV-a — izvoz) i dalje su prazne. Izvor su
  PROMETNA konta preko `popdv_account_map`, što je zaseban posao. Obrazac se slaže u donjoj
  liniji, ali **nije potpun za predaju**.
- Rekonsilijacija dokazuje **zbir**, ne razvrstavanje svake stavke po POPDV poljima 1.x–8.x.
- Ekran registra PDV konta ne postoji — registar se i dalje menja migracijom baze.

---

## 1. Odgovor u tri rečenice

> *Napisano 26.07., PRE ispravki iz odeljka 0. Danas se pet modula OTVARA i PDV DAJE TAČNE
> BROJEVE; sve ostalo iz ovog odeljka i dalje važi (19 od 80 vrsta dokumenata ima štampu).*

**Ne — danas ne možete da uđete u sva dokumenta, i još manje da ih odštampate.** Pet
najvažnijih finansijskih modula (nabavka, fakturisanje, robno, izvodi, glavna knjiga) uopšte
nema stranicu detalja u objavljenoj aplikaciji — link tipa `/fakturisanje/12` vraća 404, pa se
ni jedan račun, primka, izvod ni nalog ne mogu otvoriti klikom, osvežavanjem ili iz mejla.
Od 80 vrsta dokumenata samo **19 ima štampu** (i to je uglavnom PDF motor koji radi), dok
otpremnica, popisna lista, kalkulacija, opomena, izjava o kompenzaciji, dnevnik knjiženja,
bilans stanja i bilans uspeha **nemaju nikakvu štampu** — a KIF/KUF i PP-PDV se odštampaju,
ali nad stvarnim uvezenim podacima **sa besmislenim ukupnim iznosima** (mart 2026: KUF nabraja
625 faktura i ispod piše UKUPNO 0,00 din).

---

## 2. Tabela spremnosti

Legenda: **DA** = radi i korisnik do toga dolazi · **DELIMIČNO** = postoji ali je nepotpuno,
skriveno ili nedostupno iz ekrana · **NE** = ne postoji.
Kolona „Detalj" znači: može li korisnik u objavljenoj aplikaciji da otvori jedan dokument i
vidi ga celog (sa stavkama).
Sortirano: **najgore na vrhu**.

### Tier 1 — ne postoji ili je opasno (16)

| Dokument | Lista | Detalj | Štampa | Pretraga | Ocena |
|---|---|---|---|---|---|
| Knjižno odobrenje / zaduženje (KO/KZ) | NE | NE | NE | NE | **NE POSTOJI** |
| Međuskladišnica / prenos (PRENOS) | DELIMIČNO | NE | NE | NE | **OPASNO — roba nestaje** |
| KUF — knjiga ulaznih računa | DA | NE | DELIMIČNO | DELIMIČNO | **OPASNO — Σ PDV = 0,00** |
| KIF — knjiga izlaznih računa | DA | NE | DELIMIČNO | DELIMIČNO | **OPASNO — Σ osnovica = 0,00** |
| PP-PDV poreska prijava | NE | NE | DELIMIČNO | NE | **OPASNO — štampa besmislene brojeve** |
| Ulazna e-faktura dobavljača (SEF) | DELIMIČNO | NE | NE | NE | **OPASNO — prihvata se naslepo** |
| Izlazna e-faktura (SEF outbox, UBL XML) | DELIMIČNO | NE | NE | NE | **NEUPOTREBLJIVO** |
| Storno računa | DA | NE | DELIMIČNO | DA | **OPASNO — štampa se kao važeći** |
| Izvozna faktura (IZVRO/IZVGP/IZVUS) | DA | NE | DELIMIČNO | DA | **OPASNO — bez IBAN/SWIFT** |
| Otpremnica (faktura bez cena) | DA | NE | NE | DA | **MOTOR RADI, DUGME FALI** |
| Izjava o kompenzaciji | NE | NE | NE | NE | **NEUPOTREBLJIVO** |
| Opomena za naplatu (dunning) | NE | NE | NE | NE | **NEUPOTREBLJIVO** |
| Popisna lista / inventura | DA | DELIMIČNO | NE | NE | **BEZ ZAKONSKOG OBRASCA** |
| POPDV obrazac | NE | DELIMIČNO | NE | NE | **BEZ ŠTAMPE I BEZ OPISA** |
| Prijem po narudžbenici (zapisnik) | NE | NE | NE | NE | **NE POSTOJI KAO DOKUMENT** |
| Zahtev za nabavku (interni) | DA | NE | NE | DELIMIČNO | **BEZ DETALJA I ŠTAMPE** |

### Tier 2 — postoji, ali korisnik ne može do njega ili ne može da ga odštampa (30)

| Dokument | Lista | Detalj | Štampa | Pretraga | Ocena |
|---|---|---|---|---|---|
| Ponuda kupcu (PON) | DA | NE | DELIMIČNO | DA | detalj 404; PDF piše „RAČUN" |
| Predračun / profaktura (PROF) | DA | NE | DELIMIČNO | DA | detalj 404; PDF piše „RAČUN" |
| Račun — roba (IFR) | DA | NE | DELIMIČNO | DA | PDF ispravan, ekran 404 |
| Račun — gotov proizvod (IFGP) | DA | NE | DELIMIČNO | DA | isto |
| Račun — usluga (IFUSL) | DA | NE | DELIMIČNO | DA | isto |
| Avansni račun izdat kupcu (AVR out) | DA | NE | DELIMIČNO | DELIMIČNO | red se ne otvara; PDF piše „RAČUN" |
| Avansni račun primljen (AVR in) | DA | NE | DELIMIČNO | DELIMIČNO | tuđi avans se štampa kao naš |
| Revers kupcu (REV) | DA | NE | DELIMIČNO | DA | nema izbora vrste u UI |
| Narudžbenica dobavljaču | DELIMIČNO | NE | NE | NE | lista bez naziva dobavljača |
| Upit dobavljaču (RFQ) | DELIMIČNO | DA | DELIMIČNO | NE | PDF samo kao prilog mejla |
| 3-way match (naručeno/primljeno/fakturisano) | NE | DA | NE | NE | zbirni pregled niko ne zove |
| Upit kupca / RFQ kupca | NE | NE | NE | NE | stavka menija zakomentarisana |
| Prijem / primka robe (UL) | DA | NE | NE | NE | detalj 404, stavke bez naziva artikla |
| Izdatnica / izlaz robe (IZ) | DA | NE | NE | NE | ne može da nastane bez ručne vrste dok. |
| Kalkulacija nabavne cene | NE | NE | NE | NE | motor radi, dokument se ne vidi |
| Nivelacija (NIV) | DA | NE | NE | NE | detalj kaže „nema stavki" a ima |
| Višak po popisu (VISAK) | DA | NE | NE | NE | detalj 404 |
| Manjak po popisu (MANJAK) | DA | NE | NE | NE | detalj 404 |
| Bankovni izvod | DA | DELIMIČNO | NE | NE | sadržaj odličan, štampe nema |
| Nalog za plaćanje / virman | DA | NE | DA | NE | PDF radi, detalja nema |
| Izvoz naloga u banku (Intesa FX) | NE | NE | NE | NE | nema evidencije izvoza |
| Predlog plaćanja / dospele obaveze | DA | NE | NE | NE | ne može na potpis direktoru |
| Otvorene stavke / aging | DA | NE | NE | DELIMIČNO | tihi filter krije obaveze |
| Dnevnik knjiženja (kao knjiga) | DA | NE | NE | DELIMIČNO | knjiga za period se ne štampa |
| Kartica konta (GK) | NE | DA | NE | NE | period postoji na BE, UI ga ne šalje |
| Kontni plan | NE | NE | NE | NE | pretraga radi, ekrana nema |
| Bilans stanja | DA | DA | NE | — | samo APR XML, papira nema |
| Bilans uspeha | DA | DA | NE | — | samo APR XML, papira nema |
| Bruto bilans (zaključni list) | DA | NE | NE | — | ni PDF ni izvoz |
| Lager lista / stanje zaliha | DELIMIČNO | — | NE | DELIMIČNO | limit 100, pretraga posle limita |

### Tier 3 — radi upotrebljivo, uz sitne zamerke (13)

| Dokument | Lista | Detalj | Štampa | Pretraga | Ocena |
|---|---|---|---|---|---|
| Kamatni list / zatezna kamata | DA | DA | NE | DELIMIČNO | fali štampa |
| Blagajnički dnevnik | DA | DA | NE | DELIMIČNO | fali štampa |
| Uplatnica / isplatnica | DA | NE | NE | NE | fali obrazac |
| Evidencija avansa za PDV | DA | DELIMIČNO | NE | DA | radi kao pregled |
| KEPU knjiga | DA | NE | NE | DELIMIČNO | fali štampa |
| Kartica artikla | DA | DA | NE | NE | tačna, bez pickera i štampe |
| Rezervacije zaliha | DA | — | NE | DA | najbolja lista u robnom |
| Kursna lista (NBS) | DA | — | NE | DA | registar radi |
| Registar poreskih stopa | DA | — | NE | DA | registar radi |
| Obračun kursnih razlika | DA | DA | NE | — | preview bogat, štampe nema |
| Dashboard naplate (DSO) | DA | — | NE | — | pregled, ne dokument |
| SEF status log | DA | DA | NE | DELIMIČNO | istorija se ne može priložiti |
| Izveštaji održavanja | DA | — | NE | DA | pregledi bez štampe |

### Tier 4 — zdravi, štampa radi (21)

| Dokument | Lista | Detalj | Štampa | Pretraga | Ocena |
|---|---|---|---|---|---|
| Nalog za knjiženje / temeljnica | DA | DELIMIČNO | DA | DA | PDF izdržao 952 stavke (215 KB) |
| Nalog otvaranja godine (PS) | DA | DELIMIČNO | DA | DA | štampa dokazana |
| IOS / NIOS obrazac | NE | DA | DA | DA | fali evidencija izdatih |
| Kartica komitenta | NE | DA | DA | DELIMIČNO | ekran nije u meniju |
| Radni nalog (RN) sa barkodovima | DA | DA | DA | DA | **etalon — ovako treba svuda** |
| Primopredaja tehničke dok. | DA | DA | DA | DA | zdravo |
| Nacrt primopredaje | DA | DA | DA | DA | zdravo |
| Revers alata/LZO sa potpisom | DA | DA | DA | DA | zdravo |
| Barkod nalepnice | — | — | DA | — | zdravo |
| Zapisnik sa sastanka | DA | DA | DA | DA | zdravo |
| Izveštaj sa montaže | DA | DA | DA | DA | zdravo |
| Izveštaj praćenja proizvodnje | DA | — | DA | DA | zdravo |
| Crtež / nacrt (PDF) | DA | DA | DA | DA | zdravo |
| Ugovor o radu / aneks | DA | DA | DA | DA | PDF klijentski (jsPDF) |
| Potvrda o zaposlenju / primanjima | DA | DA | DA | DA | PDF klijentski |
| Rešenja (odmor, porodiljsko, raskid) | DA | DA | DA | DA | PDF klijentski |
| Obračunski listić zarade | DA | DA | DA | DELIMIČNO | PDF klijentski |
| Karnet / evidencija prisustva | DA | DA | DA | DA | PDF klijentski |
| Opis radnog mesta / procena 360 | DA | DA | DA | DELIMIČNO | PDF klijentski |
| Prijava neusaglašenosti (kvalitet) | DA | DA | DELIMIČNO | DA | samo skidanje priloga |
| Spisak predmeta / lokacija | DA | — | DELIMIČNO | DA | browser „Sačuvaj kao PDF" |

**Zbir:** 80 dokumenata → **21 zdravo (26 %)**, 13 upotrebljivo, **46 sa ozbiljnim
nedostatkom (57 %)**, od toga 16 neupotrebljivih ili opasnih.

---

## 3. Šta NE radi — poređano po ozbiljnosti

### 3.1. Detalj dokumenta se ne otvara u objavljenoj aplikaciji (pogađa 5 modula, ~20 dokumenata)

> **✅ POPRAVLJENO 27.07.2026** — pet modula je prebačeno na statičku rutu
> `/<modul>/detalj?id=N`; `[id]` folderi su obrisani, placeholder fajlova `_` više nema.
> Opis ispod je stanje PRE ispravke i ostavljen je kao trag uzroka. Vidi odeljak 0.

**U praksi:** ne možeš da klikneš na račun, primku, izvod ili nalog i vidiš ga — dobiješ „stranica
ne postoji". Isto se dešava kad osvežiš stranicu, pošalješ link kolegi ili otvoriš iz mejla.

Frontend je statički export. Svaki od pet `[id]` layout-a vraća samo jedan lažni ključ:

- `frontend/src/app/fakturisanje/[id]/layout.tsx:4` — `generateStaticParams()` → `[{id:"_"}]`
- isto: `nabavka/[id]/layout.tsx:4`, `robno/[id]/layout.tsx:4`, `izvodi/[id]/layout.tsx:4`,
  `glavna-knjiga/[id]/layout.tsx:4`

Na disk se ispiše samo `_.html`. **Empirijski nad `frontend/out`:** `/fakturisanje` → 200,
`/fakturisanje/_` → 200, ali `/fakturisanje/12` → **404**, `/nabavka/5` → 404, `/robno/1` → 404,
`/izvodi/2` → 404, `/glavna-knjiga/3` → 404.

Backend LAN kopija to ne spasava: `backend/src/main.ts:87–103` samo prepisuje `/put` → `/put.html`
ako fajl postoji, i **nema SPA fallback**; u `out/` nema ni `_redirects` za Cloudflare.

Posledica lančano ruši i sve što na tim ekranima živi: dugme „Štampaj" na računu, dugme
„Kalkuliši" na primci, dugme „Storno", tok predračun→račun i predračun→avans. Ekipa zna za
problem — `/robno/popis` je svesno napravljen kao panel ispod liste, a `/work-orders` koristi
`?id=N` i **radi**. To je i rešenje: isti obrazac na preostalih pet modula.

### 3.2. Prenos između magacina — roba se razduži i nigde ne zaduži

**U praksi:** premestiš robu iz magacina A u magacin B; u A je nema, u B je nema. Lager laže.

Živa proba: prenos 1 kom iz ZZ-PROBA-A u ZZ-PROBA-B → izvorni magacin `onHand=12`, **odredišni
magacin nema nijedan red u lageru**, kartica artikla u odredištu ima 0 redova, a jedina stavka
dokumenta nosi `warehouseId=990001` (izvorni): `[{"warehouseId":990001,"quantity":"1"}]`.
`linkedInboundDocId` = NEMA — parni ulazni dokument se ne pravi. KEPU vrednosno zna za dva reda
(`backend/src/modules/robno/kepu-book.util.ts:185–192` — „(prenos izlaz)" / „(prenos ulaz)"),
ali robna evidencija ne.

Ublažavajuće: iz UI-ja se prenos trenutno ni ne može pokrenuti (dijalog nudi samo UL/IZ/NIV),
a na bazi ne postoji nijedna vrsta dokumenta za prenos. Znači bomba je armirana, ali još nije
dostupna korisniku — **ne puštati je u rad dok se ne popravi**.

### 3.3. KIF, KUF i PP-PDV se odštampaju sa besmislenim iznosima, bez ijednog upozorenja

> **✅ POPRAVLJENO 27.07.2026** — brojevi se slažu sa BigBitom za svih 6 zatvorenih meseci
> 2026, a neispravan period se više ne štampa tiho. Opis ispod je stanje PRE ispravke.
> **Nije rešeno:** PP-PDV pozicije 001/002 (izvoz) i dalje su prazne — vidi odeljak 0.

**U praksi:** odštampaš knjigu ulaznih računa za mart, ona nabroji 625 faktura, i ispod piše
UKUPNO **0,00 din**. Takav papir se ne može predati ni pokazati knjigovođi.

Mereno na dev bazi nad **stvarnim uvezenim BigBit podacima** za 2026-03:

| Knjiga | Redova | Negativan PDV | Σ osnovica | Σ PDV |
|---|---|---|---|---|
| KIF | 34 | 4 reda (min −3.351.621,19) | **0,0000** | **−1.236.156,30** |
| KUF | 625 | 6 redova (min −28.298.900,58) | **0,0000** | **0,0000** |

Uzrok: `buildKifKuf` sabira (potražuje − duguje) po grupi (nalog, partner, konto) nad PDV
kontima, pa **mesečni nalog zatvaranja/prenosa PDV konta iz BigBita ulazi u knjigu kao običan
red sa suprotnim znakom**. Posledično PP-PDV za 2026-03 štampa obračunati PDV −1.236.156,30,
pretporez 0,00 i poziciju 110 (povraćaj) 1.236.156,30.

Uz to: od 228 različitih `partnerId` iz KIF/KUF za mart, **nijedan nema ime u tabeli
`customers`** — i u samom PDF-u se štampa „#1000678" umesto naziva (komitenti još nisu uvezeni
iz BigBita).

⚠️ Dev GK je uvoz u toku (druga sesija ga baš remedira) — proveriti da li isto stoji na
finalnom uvozu.

### 3.4. Ulazna e-faktura sa SEF-a prihvata se bez uvida u stavke

**U praksi:** dobavljač pošalje fakturu, ti pritisneš „Prihvati" ili „Odbij" i time pravno
odgovaraš — a nisi video **nijednu stavku ni cenu**.

Proba: zasejao sam ulaznu fakturu čiji `rawXml` sadrži 2 `cac:InvoiceLine` (Ležaj 6205 2RS,
10 kom / 12.505,00 i Zaptivka NBR, 4 kom / 1.520,00). Te stavke se **nigde ne mogu videti**:
u Prisma klijentu ne postoji tabela stavki ulazne fakture (ni `sefIncomingInvoiceItem` ni
`sefIncomingItem`), nema javne metode za jednu fakturu, a `rawXml` se izbacuje iz liste
(`backend/src/modules/sales/sef/sef-incoming.service.ts:57` — `Omit<SefIncomingInvoice,"rawXml">`).
Nema ni PDF-a ni preuzimanja XML-a.

**Paginacije nema — dokazano:** sa 501 fakturom u bazi `list({})` vratio je tačno 500 (1
nevidljiva), a poziv sa `{skip:100, take:10}` vratio je **opet 500** — parametri se potpuno
ignorišu (tvrd `take: 500`, `sef-incoming.service.ts:266`).

### 3.5. Izlazna e-faktura: UBL XML poslat Poreskoj se ne može ni videti ni preuzeti

**U praksi:** kad Poreska pita „šta ste tačno poslali", nemaš odakle da izvadiš dokument.

`backend/src/modules/sales/sef/sef.service.ts:12` — `Omit<SefOutbox,"ublXml"|"pdfAttachmentBase64">`.
Proba: `ublXml` u odgovoru = false, `pdfAttachmentBase64` = false; **broj fakture, kupac i iznos
ne postoje u redu liste** — po listi se ne prepoznaje koja je faktura. `listOutbox` vraća **goli
niz** (nije `{data, meta}`), pa nema `meta.total` i pager nagađa; sa 60 redova vratio je 50 →
10 nevidljivo. Metoda `getOutbox` je `private` i kontroler je ne izlaže.

### 3.6. Storniran račun izlazi iz štampe identično važećem

**U praksi:** kupcu možeš da pošalješ storniran račun kao da je važeći, i niko to ne primeti.

Proba: PDF storniranog računa generisan normalno (58.374 B), naslov „RAČUN", a pretraga po
stvarnom `docDefinition`-u pokazuje da reč **„STORNIRANO" ne postoji nigde u dokumentu**.

*Ispravka revizije koda:* razlog storna **jeste** dostupan — čuva se u polju `note`
(„STORNO: probni razlog") i to polje se vraća u redu liste; filter Status=Storniran radi.
Znači podatak postoji, samo ga frontend ne prikazuje — lakše nego što je revizija tvrdila.

### 3.7. Svi domaći dokumenti štampaju se sa naslovom „RAČUN"

**U praksi:** ponuda kupcu izlazi kao poreski račun, predračun kao račun, avansni račun kao
običan račun, revers kao račun.

`backend/src/modules/sales/print/invoice-pdf.service.ts:620` — `title: "RAČUN"` je jedini domaći
šablon. Empirijski potvrđeno na svakom tipu: PON0001/2026 → „Račun br. PON0001/2026";
PROF0002/2026 → „Račun br. PROF0002/2026"; AVR0022/2026 → „Račun br. AVR0022/2026"; REV isto.

### 3.8. Izvozna faktura ide stranom kupcu bez podataka za plaćanje

**U praksi:** strani kupac dobije fakturu na engleskom u EUR i **nema po čemu da plati**.

Proba: u generisanom dokumentu nema ni „IBAN" ni „SWIFT". **Potvrđeno na nivou koda i baze:**
`invoice-pdf.service.ts:541–545` ispisuje IBAN/SWIFT samo ako `issuer.iban` / `issuer.swift`
postoje — ali `loadIssuer` (`invoice-pdf.service.ts:134–168`) ta polja **nikad ne postavlja**, a
model `Company` (`backend/prisma/schema.prisma:927–957`) **nema kolone `iban` ni `swift`**.
To je mrtav kod, ne podešavanje: ni ručno se ne može popuniti.

### 3.9. Otpremnica postoji i savršeno radi — a ne može da se odštampa

**U praksi:** magacioner nema šta da da vozaču.

Proba: `buildDeliveryNotePdf(102)` → naslov **„OTPREMNICA"**, podnaslov „Otpremnica br. …",
fajl `OTP-DRAFT-101.pdf`, 56.777 B (za 1.170 B manji od računa jer nema kolone sa cenama).
Backend ruta postoji (`backend/src/modules/sales/sales.controller.ts:73–79`, `?variant=delivery`).
Ali frontend nikad ne šalje varijantu: `frontend/src/app/fakturisanje/[id]/page.tsx:356–362` —
jedno dugme „Štampaj", `pdf.mutate({ id: doc.id })`, bez izbora.

### 3.10. Popisna lista se ne može odštampati

**U praksi:** komisija ne može da iznese praznu listu na teren ni da potpiše popunjenu sa
razlikama. A popis je zakonski obrazac.

`InventoryService` nema nijednu metodu sa `pdf`/`print`/`stampa`/`csv`/`export` u imenu.
Sve ostalo u popisu radi (jedini deo robnog koji radi od liste do zaključenja): predpunjenje,
unos, finalizacija (POSTED), tab „Razlike" ispravan (naziv, šifra, razlika −1, vrednost −250,
zbirovi). Ali **glavni tab „Stavke" ne pokazuje šta se broji** — samo `#990001`
(polja: `id|countId|itemId|bookQuantity|countedQuantity|price`, bez naziva i šifre).
Isto važi za zapisnik o višku i zapisnik o manjku — kreiraju se ispravno, ne štampaju se.

### 3.11. Opomena i izjava o kompenzaciji — postoje kao radnja, ne kao dokument

**Opomena:** PDF je gotov i lep — `Opomena-1-N3-2026-07-26.pdf`, 61.204 B (nivo 3, pred
utuženje) — ali dobijen **isključivo direktnim pozivom servisa iz skripte**; GET rute nema.
`DunningService` ima metode `candidates, send, sendBatch, sendOne, loadProfiles, loadHistory` —
**nijedna ne vraća poslate opomene**. Upisuju se u `dunning_notices` i nikad se ne čitaju.
Korisnik ne može ni da pregleda opomenu pre slanja, ni da je ponovo preuzme.

**Kompenzacija:** predlog radi (potraživanja 12.000 / obaveze 5.000 / prebijeno 5.000), kreiranje
radi (broj 0001/2026, DRAFT) — i tu se gubi. `CompensationService`: `buildFromOpenItems, create,
validateBalanced, postCompensation, sumAbs, allocate, nextNumber` — nema liste, nema detalja,
**nema PDF-a izjave koju obe strane potpisuju**.

### 3.12. Knjižno odobrenje / zaduženje ne postoji

**U praksi:** jedina ispravka izdatog računa je pun storno — nema odobrenja za reklamaciju,
rabat ili grešku u količini.

Doslovna greška servisa pri pokušaju: **„Nepoznata ciljna vrsta računa: KO."** i
**„Nepoznata ciljna vrsta računa: KZ."** Nema vrste dokumenta, numeracije, rute, ekrana ni
obrasca. (Grub upis reda sa `document_type='KO'` je prošao — što usput dokazuje da baza nema
CHECK ograničenje na vrstu dokumenta.)

### 3.13. Zapisnik o prijemu ne postoji kao dokument

Prijem se **knjiži** (količine se upisuju: naručeno 10 / primljeno 8), ali `NabavkaService`
nema nijednu `list*Receipt*` metodu — pregled prijema ne postoji ni na backendu, nema detalja,
nema PDF-a. Primljene količine se vide samo kroz 3-way match.

### 3.14. Bilans stanja i bilans uspeha nemaju štampu — i sve kontrole padaju

Motor formula radi nad stvarnom glavnom knjigom: bilans stanja 32 AOP linije (27 nenultih,
0001 „UKUPNA AKTIVA" = 4.868.569.770,77); bilans uspeha 25 linija (20 nenultih, 1001 „POSLOVNI
PRIHODI" = 535.422.804,43). Ovo je **jedini deo sistema gde se pozicija vidi sa opisom**.
Ali `BalanceSheetService` nema nijednu PDF metodu — jedini izlaz je APR eFI XML
(`BS_2026.xml` = 12.462 B, `BU_2026.xml` = 7.480 B). Bilansi se **ne mogu odštampati ni predati
na papiru**.

Kontrole: bilansna ravnoteža `passed=false` (levo 14.339.469,50, desno 0,0000); 4 od 5 kontrola
bilansa uspeha padaju. **Uzrok nije motor** nego neusklađen prelaz: katalog kontrolnih pravila
gađa zvanične AOP oznake (0059/0456, 1043/1044…), a dev baza još ima stari rekonstrukcioni seed
od 32/25 pozicija. Migracija `20260726090000_seed_balance_formulas_autenticne` (117 BS + 62 BU
pozicija, iz predatih obrazaca za 2023) **postoji na grani ali nije primenjena na dev**.
Ako te dve stvari ikad odu razdvojeno na produkciju, **kontrole će lagati**. Peto pravilo BU
„prolazi" samo zato što su obe strane nule — kontrola koja ništa ne kontroliše.

### 3.15. Dnevnik knjiženja se ne može odštampati kao knjiga

`JournalPrintService`: `buildJournalPdf, loadIssuer, loadOrderTypeName, loadAccountNames,
buildDocDefinition, buildHeader, buildIssuer, buildBalanceNote, buildSignoff`. Jedini javni
ulaz je `buildJournalPdf(id)` = **jedan nalog**. Dnevnik knjiženja kao zakonska poslovna knjiga
za period se ne može ni odštampati ni izvesti.

Pojedinačni nalog je pritom odličan: `nalog-NALOG-0202-2026.pdf` 67.304 B, a uvezeni BigBit
nalog PS 0001/2026 sa **952 stavke** renderuje se u 215.099 B — obrazac izdržava višestranične
naloge.

### 3.16. Skriveni limiti i tihi filteri — korisnik ne zna da nešto ne vidi

| Gde | Šta se dešava | Dokaz iz probe |
|---|---|---|
| Lager lista | limit 100, panel nema pager | `meta={total:1, skip:0, take:100}` |
| Lager pretraga | **pretraga se primenjuje POSLE limita** | `q='ZZ PROBA'` sa `take=1` → 0 redova; isti `q` sa `take=500` → 1 red |
| RFQ, narudžbenice, SEF outbox | tih limit 50 | 60 zasejano → 50 vraćeno, 10 nevidljivo bez poruke |
| SEF ulazne | tvrd `take:500`, parametri ignorisani | 501 zasejano → uvek 500 |
| Aging | podrazumevano skriva obaveze | bez konta 44 reda; sa kontom 4350 **137 redova** |
| Rezervacije | podrazumevano `status='OPEN'` | oslobođena rezervacija nestaje iz prikaza |
| Otvorene stavke | 824 grupe odjednom, bez paginacije | 204 ms, sve u DOM |
| Kartica konta | 7.816 stavki odjednom, bez LIMIT-a | 451–660 ms |

*Ispravka revizije:* `meta.total` **se vraća** i za narudžbenice (61) i za RFQ — nije tačno da
ga backend nema; problem je što ga UI ne prikazuje. To je jeftinija popravka nego što je
revizija tvrdila.

### 3.17. Pretraga po broju dokumenta u robnom ne postoji

Poslao sam `q='0001/2026'`, `documentNumber='0001/2026'` i `search='0001/2026'` — servis je
vratio **sva 2 UL dokumenta**, dakle sva tri polja se tiho ignorišu. Kad primki bude 5.000,
konkretna primka se neće moći naći.

### 3.18. Izdatnica ne može da nastane na svežoj bazi

Doslovna greška: **422 „Tip dokumenta 'IFR' ne postoji (document_types.code)."**
`backend/src/modules/robno/carry-over.service.ts:190` kao podrazumevanu vrstu za prepis
fakture → izdatnicu koristi baš `'IFR'`, a migracije koje se isporučuju seju samo VISAR/MANJR/NIV
— **izlazne vrste nema nijedne**. Kad sam vrstu izmislio, sve radi — ali `customerId` ostaje
`null`, a FE zaglavlje prikazuje samo polje „Dobavljač", pa izdatnica ostaje bez kupca.

### 3.19. Nivelacija prikazuje „Dokument nema stavki" a ima

`getStockDocument(60)` vraća `items=0` (a to FE crta) i `stockLevelingItems=1`. U tom jedinom,
nevidljivom redu stoji sve bitno: stara VP=100 → nova VP=150, revalorizovana količina=10,
razlika vrednosti=500. Uz to `calculate()` ne vraća nikakav podatak o nastaloj nivelaciji, pa
ni poruke „napravljena je nivelacija" nema.

### 3.20. Kalkulacija tiho računa sa nulama

Pozvao sam `calculate()` bez ijednog doc-level parametra (carina, špedicija, kursevi, DevVredFak)
— **jer ih UI nema** — i prošla je bez ijedne primedbe. Kalkulacija nema svoju listu ni svoj
detalj; jedini trag je kolona „Kalkulisan Da/Ne". Ne vidi se koja je kalkulacija i sa kojim
zavisnim troškovima urađena, i nema štampe obrasca.

### 3.21. Sitnije, ali vredi znati

- **Narudžbenica:** lista nema kolonu `supplierName` (za razliku od RFQ liste koja je rezolvuje)
  — dobavljač se prikazuje kao „#id". Backend `getOrder(id)` **radi** (proba: 0001/2026, ORDERED,
  RSD, 2 stavke), ali FE nema hook za `/orders/:id` — klik otvara 3-way match panel.
- **Robna stavka bez naziva artikla:** stavka primke nosi samo `itemId`, pa ekran crta „#990001".
  Isto u popisu.
- **3-way match zbirni pregled:** `matchSummary({onlyWithFindings:true})` radi i vraća pun red
  (orderNumber, supplierName, iznosi, `codes:['PRICE_VARIANCE']`) — **ali ga nijedan ekran ne
  zove**. Pojedinačni match je odličan: stvaran nalaz doslovno glasi „WARNING/PRICE_VARIANCE:
  Jedinična cena na fakturi 1400,00 je viša od naručene 1250,50 za 11,96 % (1196,00 RSD)."
  Ograničenje: kad stavka nema `articleId`, `matchable=false` i fakturisana kolona ostaje 0.
- **Kartica artikla:** tačna (6 kretanja, ulaz 18, izlaz 4, stanje 14 — poklapa se sa lagerom) i
  red **već nosi `documentId` i `documentNumber`** za skok na izvorni dokument, ali ekran to ne
  koristi; otvara se samo ukucavanjem internih brojeva, bez pickera po nazivu.
- **Kontni plan:** `searchAccounts({q:'kupci'})` vratio 18 pogodaka od 1.397 konta — **pretraga
  radi**, samo je frontend nikad ne poziva, pa se konto u ručnom nalogu kuca napamet.
  Najjeftinija rupa u sistemu: servis je gotov, fali ekran.
- **Kartica konta i IOS:** presek perioda / `asOf` **postoje na backendu** (kartica sa
  from/to → 41 red umesto 614; IOS na 31.12.2025 → drugi dokument, 63.044 B), a **UI ih nikad ne
  šalje**. Godišnji IOS na 31.12. je tehnički rešen, samo nedostupan.
- **IOS bez komitenta:** obrazac se uredno generiše i za analitiku koja nema zapis u komitentima
  (IOS-1003696, 69.345 B). Na dev bazi **748 od 749 analitika iz GK nema komitenta** — takav
  obrazac izlazi sa praznim blokom DUŽNIK umesto da bude odbijen.
- **Izvoz u banku:** radi (364 B TXT, 2 linije, `exportedAt` upisan), ali jedina evidencija je
  ta kolona — nema paketa izvoza, nema liste izvršenih izvoza, nema čitljive specifikacije
  (spisak naloga + zbir) za potpis i arhivu.
- **Bankovni izvod:** sadržajno odličan — kontrola `{opening:1000, inflow:12000, outflow:0,
  expected:13000, actual:13000, difference:0, ok:true}`. Štampe nema (proveren ceo inventar
  metoda `BankStatementService`).
- **POPDV:** nema opisa pozicije — polja linije su tačno `id, vatReturnId, aop, amount,
  computedAt`, **polja `label` nema**. Korisnik dobija 287 redova oblika „1.1K1 | 0,00", od
  kojih je 233 nula, bez ijedne reči objašnjenja i bez filtera „samo nenulte".
- **PP-PDV obrazac nije zvaničan:** 8 redova (001, 002, 003/103, 004/104, 005/105, 008/108, 109,
  110), pozicije 001 i 002 **hardkodovano prazne**, bez mesta/datuma/potpisa, uz fusnotu
  „obrazac je rekonstruisan".
- **Upiti kupaca (RFQ kupca):** backend rute postoje, ali je stavka menija zakomentarisana —
  `frontend/src/lib/navigation.ts:264`.

---

## 4. Gde se revizija koda i živa proba NE SLAŽU — veruje se probi

Šest tvrdnji iz revizije koda proba je oborila. **Sve u korist proizvoda** — stanje je bolje
nego što je papirna revizija tvrdila:

| Tvrdnja revizije | Šta je proba pokazala |
|---|---|
| „POPDV compute daje 287 linija, sve 0,00" | **Netačno.** Kad podatak dođe iz glavne knjige, POPDV se stvarno puni: kontrolni dokument → 15 nenultih AOP pozicija (3.2K1=100.000, 3.2K2=20.000, 5.1K1=100.000…); stvarni BigBit 2026-03 → **54 nenulte pozicije** (8а.2K1=142.511.726,95). Motor radi. |
| „Kvartalni obveznik nije podržan (404)" | **Netačno.** `buildPpPdvPdf('2025-Q4')` pre obračuna baca jasnu poruku, ali čim se pozove `popdv.compute({year:2025, quarter:4})` obračun prolazi (287 linija) i **kvartalni PDF se odštampa (68.772 B)**. Backend kvartal podržava u potpunosti — rupa je samo u ekranu (dugme „Obračunaj" uvek šalje mesec). |
| „`listStatusLog` bez filtera vraća prazno" (piše i u komentaru koda) | **Netačno.** Vratio je sva 3 zapisa. Komentar u `sef.service.ts` je pogrešan i revizija ga je prepisala. |
| „Backend nema `meta.total` za narudžbenice" | **Netačno.** Vraća `meta={total:61}`. Problem je što ga UI ne prikazuje — mnogo jeftinija popravka. |
| „Razlog storna se nigde ne čuva" | **Netačno.** Čuva se u `note` i **vraća se u redu liste**; filter Status=Storniran radi. Podatak postoji, frontend ga ne prikazuje. |
| „Prepis predračuna u revers nije podržan" | **Netačno.** `createInvoiceFromProforma(PROF,'REV')` **prolazi** i pravi REV dokument. Nedostaje samo izbor te vrste u frontendu. (Prvi pokušaj je pao porukom „Predračun 101 je već prepisan u račun 102." — to je anti-duplo zaštita, ne odbijanje reversa.) |

Obrnuto, proba je našla **dva nalaza teža nego revizija koda**: prenos robe koji gubi zalihu
(§3.2) i KIF/KUF/PP-PDV sa besmislenim ukupnim iznosima nad stvarnim podacima (§3.3). Nijedan
od ta dva se ne vidi čitanjem koda — vide se tek kad se pusti podatak kroz sistem.

---

## 5. Šta radi, ali nije dokazano

Pošteno navedeno — ovo živa proba nije mogla ili nije smela da zasejе:

1. **Prenos poslovne godine (početno stanje).** `createYearOpen` zatvara klase 5/6 nad svih
   20.366 stavki dev baze i pravi nalog od stotina linija — previše invazivno za reviziju.
   Dokazani su samo **detalj i štampa** nastalog PS naloga (952 stavke, 215.099 B). Tvrdnja
   „prenos godine radi" **ostaje nedokazana**.
2. **Pun prijem po narudžbenici sa artiklom** kroz robno + kalkulaciju + knjiženje u GK. Taj put
   pravi robni ulaz, kalkulaciju i nivelaciju koje se ne mogu čisto poništiti na **deljenoj dev
   bazi** (na njoj paralelno radi druga sesija). Robni ulaz je zaveden ručno i obrisan. Nalaz se
   time ne menja — nedostaju lista, detalj i PDF, a ne knjiženje.
3. **Izvršenje obračuna kursnih razlika** (`run()`) — upisuje nalog u glavnu knjigu, nije
   pokretano. Dokazan je samo `preview` (67 stavki, pun set polja).
4. **Stvarno slanje mejla** — RFQ je kreiran istom transakcijom kao `createAndSendRfq` ali **bez
   `MailService`-a**, da proba ne pošalje upit stvarnom dobavljaču. Mejl put nije proveren.
5. **`[id]` rute na statičkom exportu za izvode i glavnu knjigu** nisu ponovo obarane u
   finansijskoj probi — nalaz je iz revizije koda i empirijske provere nad `frontend/out`
   (§3.1), što je dovoljan dokaz, ali nije prošao kroz živi klik.
6. **Kadrovski dokumenti (8 vrsta)** — PDF se pravi klijentski (jsPDF, `frontend/src/lib/hr-pdf/*`)
   i nisu vožene kroz probu; ocenjeni su po kodu kao zdravi jer imaju i ekran i generator.
7. **Ponašanje na produkciji sa popunjenom tabelom `company`.** Na dev bazi `company` sada ima
   1 red, pa raniji nalaz „RAČUN POŠILJAOCA izlazi prazan na virmanu" **više ne stoji kao
   dev-nalaz** — treba proveriti **sadržaj** tog reda na produkciji, ne broj redova.
8. **Da li KIF/KUF anomalija (§3.3) preživljava finalni BigBit uvoz** — dev GK je uvoz u toku.

---

## 6. Šta predlažem da se uradi

Procena veličine: **mali** = do 1 dana · **srednji** = 2–5 dana · **veliki** = više od nedelju dana.

### 6.A. Potrebno ZA PARALELNI PDV OBRAČUN (bez ovoga se PDV ne može voditi paralelno)

| # | Posao | Zašto | Veličina |
|---|---|---|---|
| A1 | **Ispraviti znak i isključiti naloge zatvaranja PDV konta iz `buildKifKuf`** | Bez ovoga su KIF, KUF i PP-PDV brojevi besmisleni (Σ PDV = 0,00 uz 625 faktura) — sve ostalo je uzalud | **srednji** |
| A2 | **Kontrola pre štampe: blokirati PDF ako Σ osnovica = 0 uz nenulte redove, ili ako ima negativan PDV** | Da se besmislen papir ne može izneti iz sistema neprimećen | **mali** |
| A3 | **Uvesti komitente iz BigBita** (228 partnera iz KIF/KUF nema ime; 748/749 GK analitika bez komitenta) | Bez toga i ekran i PDF pišu „#1000678"; IOS izlazi sa praznim DUŽNIK blokom | **srednji** |
| A4 | **Detalj KIF/KUF reda + link na izvorni nalog** (`VatLedgerService` nema ni `getById` ni `findOne`) | Kad poreski inspektor pita „odakle ovaj red", nema odgovora | **srednji** |
| A5 | **Nazivi AOP pozicija u POPDV** (dodati `label`; danas je red „1.1K1 \| 0,00") + filter „samo nenulte" (233 od 287 su nule) | 287 nemuštih redova se ne može kontrolisati | **mali** |
| A6 | **Štampa POPDV obrasca** (`PdvPrintService` ima samo `buildPpPdvPdf` i `buildLedgerSpecPdf`) | POPDV je obavezan prilog — danas se ne može odštampati | **srednji** |
| A7 | **Zvaničan PP-PDV obrazac** (danas 8 redova, 001/002 hardkodovano prazne, bez mesta/datuma/potpisa, uz fusnotu „rekonstruisan") | U ovom obliku se ne predaje | **srednji** |
| A8 | **Kvartal u UI** — dugme „Obračunaj" uvek šalje mesec, a backend kvartal **potpuno podržava** (dokazano) | Čista frontend izmena, otključava kvartalne obveznike | **mali** |
| A9 | **Veza KUF reda ↔ SEF ulazna faktura ↔ nalog** | Danas su to tri odvojena sveta bez ijednog linka | **srednji** |

**Ukupno A: ~3–4 nedelje.** Bez A1 ništa drugo iz ove grupe nema smisla raditi.

### 6.B. Najveći efekat po uloženom trudu (raditi odmah posle A1)

| # | Posao | Efekat | Veličina |
|---|---|---|---|
| B1 | **Prebaciti 5 modula sa `[id]` rute na `?id=N`** (obrazac već postoji i radi: `/work-orders`, `/robno/popis`) | **Jednim potezom otključava ~20 dokumenata** — detalj, štampu, storno, kalkulaciju. Ovo je ubedljivo najisplativija stavka u celom izveštaju | **srednji** |
| B2 | **Dugme „Štampaj otpremnicu"** — samo dodati izbor varijante (`?variant=delivery` radi, PDF je 56.777 B i savršen) | Magacin dobija papir za vozača. Jedan dan posla za funkciju koja je već napisana | **mali** |
| B3 | **Zaustaviti prenos između magacina** dok se ne napravi parni ulazni dokument | Sprečava tihi gubitak zaliha (§3.2) | **mali** (blokada) / **srednji** (popravka) |
| B4 | **Naslovi obrazaca:** PONUDA / PREDRAČUN / AVANSNI RAČUN / REVERS umesto svuda „RAČUN" | Danas ponuda kupcu izlazi kao poreski račun | **mali** |
| B5 | **Vodeni žig „STORNIRANO"** na PDF-u storniranog računa + prikaz razloga iz `note` (podatak **već stiže** u listi) | Sprečava slanje storniranog računa kao važećeg | **mali** |
| B6 | **Prikazati `meta.total` i pager svuda** (backend ga već vraća: RFQ 60, narudžbenice 61, lager `total`) | Korisnik prestaje da radi nad nevidljivo isečenom listom | **mali** |
| B7 | **Pretraga po broju dokumenta u robnom** (`q`/`documentNumber`/`search` se danas tiho ignorišu) | Bez toga se konkretna primka ne može naći | **mali** |
| B8 | **Naziv i šifra artikla u stavkama** primke, izdatnice i popisa (danas „#990001") | Popisivač trenutno ne vidi šta broji | **mali** |
| B9 | **Ekran „Kontni plan"** — `searchAccounts` **već radi** (18 pogodaka od 1.397 konta) | Servis je gotov, fali samo ekran | **mali** |
| B10 | **Poslati `from`/`to` i `asOf` iz UI** za karticu konta i IOS — backend to **potpuno podržava** (dokazano) | Otključava godišnji IOS na 31.12. i karticu po periodu | **mali** |
| B11 | **Nivelacija: prikazati `stockLevelingItems`** (danas piše „Dokument nema stavki" a stavka postoji sa staro 100 → novo 150) | Otklanja poruku koja laže | **mali** |
| B12 | **Ukloniti tihi filter u aging-u** (bez konta 44 reda, sa 4350 → 137 redova obaveza se ne vidi) i podrazumevani `status=OPEN` u rezervacijama | Korisnik ne zna da mu se skriva 137 redova | **mali** |

**Ukupno B: ~2–3 nedelje, a otključava veći deo sistema.** B1 je jedina stavka koja se isplati
uraditi pre bilo čega drugog osim A1.

### 6.C. Nedostajući dokumenti (nova gradnja)

| # | Posao | Veličina |
|---|---|---|
| C1 | **Štampa popisne liste** (prazna za teren + popunjena sa razlikama) — zakonski obrazac koji komisija potpisuje | srednji |
| C2 | **Štampa bilansa stanja i bilansa uspeha** + primeniti migraciju `20260726090000_seed_balance_formulas_autenticne` (117 BS + 62 BU pozicija) — **popravka postoji, samo nije uključena** | srednji |
| C3 | **Knjižno odobrenje / zaduženje (KO/KZ)** — vrsta dokumenta, numeracija, ruta, ekran, obrazac | veliki |
| C4 | **Detalj ulazne SEF fakture sa stavkama** — parsirati `cac:InvoiceLine` u tabelu stavki, prikazati pre „Prihvati/Odbij" | srednji |
| C5 | **Detalj i preuzimanje izlazne SEF e-fakture** (UBL XML + PDF prilog) + broj/kupac/iznos u listi | srednji |
| C6 | **Lista i štampa poslatih opomena** — PDF je gotov (61.204 B), fali GET ruta i ekran | mali |
| C7 | **Lista kompenzacija + PDF izjave o kompenzaciji** koju obe strane potpisuju | srednji |
| C8 | **Štampa dnevnika knjiženja za period** (danas samo nalog po nalog) | srednji |
| C9 | **Štampa bankovnog izvoda** i **specifikacije izvoza u banku** (spisak naloga + zbir za potpis) | srednji |
| C10 | **Zapisnik o prijemu** (lista + detalj + PDF), **obrazac kalkulacije**, **zapisnik o višku/manjku** | srednji |
| C11 | **Narudžbenica: ekran detalja + PDF** (backend `getOrder` **već radi**) + naziv dobavljača u listi | srednji |
| C12 | **RFQ: GET ruta za PDF** (danas dostupan samo kao prilog auto-mejla) | mali |
| C13 | **IBAN/SWIFT za izvoznu fakturu** — dodati kolone u `Company`, popuniti `loadIssuer` (kod za ispis već postoji, `invoice-pdf.service.ts:541–545`, ali je mrtav) | mali |
| C14 | **Vrste dokumenata za izlaz i prenos** u `document_types` seed (danas samo UFROB/VISAR/MANJR/NIV — izdatnica pada sa 422) | mali |
| C15 | **Paginacija SEF ulaznih** (tvrd `take:500`, parametri se ignorišu) i **paginacija kartice konta** (7.816 stavki odjednom) | mali |

### 6.D. Redosled koji preporučujem

1. **A1 + A2** — dok su KIF/KUF brojevi besmisleni, PDV se ne može voditi paralelno ni u probi.
2. **B1** — jedan potez otključava ~20 dokumenata; bez toga svaka nova štampa ostaje nedostupna.
3. **B3** (blokada prenosa) — dok se ne popravi, da se ne izgubi zaliha.
4. **B2, B4, B5, B6, B7, B8, B9, B10, B11, B12** — sve mali poslovi, zajedno menjaju utisak sistema.
5. **A3–A9** — ostatak PDV grupe.
6. **C1, C2, C6, C12, C13, C14** — jeftini dokumenti gde motor već postoji.
7. **C3, C4, C5, C7, C8, C9, C10, C11, C15** — prava nova gradnja.

---

## 7. Zaključak u jednoj slici

Backend je uglavnom **jak** — PDF motor renderuje nalog od 952 stavke u 215 KB, 3-way match daje
doslovno upotrebljive nalaze, kartica komitenta računa tačno, popis prolazi od predpunjenja do
zaključenja, bilansi se računaju nad stvarnom glavnom knjigom. Frontend je **taj koji ne
isporučuje**: detalj ne postoji na objavljenoj aplikaciji, dugmad za varijante štampe fale,
gotove servise (pretraga konta, presek perioda, zbirni match, `meta.total`) niko ne poziva.

Otud i redosled: **najveći deo posla nije pisanje novog koda nego povezivanje onoga što već
radi** — uz jednu tvrdu ispravku u PDV knjigama i jednu blokadu u robnom.

---

*Izveštaj: revizija koda + živa proba na DEV bazi 192.168.64.28:5437, 25–26.07.2026. Svi probni
podaci su posle merenja obrisani. Aplikativni kod nije menjan.*
