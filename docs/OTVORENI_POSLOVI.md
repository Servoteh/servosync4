# Otvoreni poslovi i odluke na čekanju

**Osnovan 04.08.2026.** Registar svega što je izmereno i pripremljeno ali NIJE izvedeno —
da se svaka stavka može pokrenuti hladno, bez ponovnog istraživanja.

**Kako se koristi:** svaka stavka ima *Kontekst → Izmereno → Šta uraditi → Rizik/cena → Preporuka*.
Brojke su merene na živim bazama na navedeni datum — pre izvođenja ih **ponovo izmeriti**
(populacije se menjaju svakodnevno). Kad se stavka izvede: obriši je odavde i zabeleži u
odgovarajući modul-doc ili commit poruku.

---

## A. DONETE ODLUKE (ne vraćati na sto)

### A1. Op-barkod NE popunjava polja — NE RADITI ❌
**Odluka: Nenad, 04.08.2026.**

Na papirnom RN-u postoje tri barkoda: zaglavlje gore desno (nalog), TP nalepnica (pozicija),
i po jedan u **svakom redu tabele operacija** („op-barkod"). Magacinski tok (`/mob` → Lokacije →
Premesti stavku) op-barkod **odbija** narandžastom porukom koja navodi gde da se skenira.

Predlog je bio: umesto čistog odbijanja, popuniti bar „Broj naloga" iz njega. **Odbijeno** —
op-barkod nije jedinstven (isti kod na više mesta), pa bi delimično popunjavanje moglo da upiše
**pogrešan nalog**; čovek vidi popunjeno polje, misli da je sken uspeo i potvrdi → pogrešno
smeštena roba. Postojeća poruka već tačno navodi korisnika, što je jeftinije i sigurnije.

⚠️ Ako se tema ikad vrati: **prvo izmeriti šta op-barkod stvarno nosi** (generator u
`backend/src/modules/work-orders/work-order-print.service.ts`, parser u
`backend/src/modules/tech-processes/barcode.ts`) — odluka ide na osnovu podatka, ne pretpostavke.
Ako magacin često ima samo op-barkod pred sobom, pravo rešenje je obezbediti TP nalepnicu na
delovima (pogonska mera, ne kod).

---

## B. ČEKA NENADA / POGON (spremno za izvođenje)

### B1. Polica K-D — isprazniti pa ugasiti 🔴
**Status: čeka fizičko premeštanje jednog komada.**

**Kontekst.** 04.08. je čišćen šifarnik lokacija: pod **ugašenom halom „MAG" (Centralni magacin)**
zatečeno je 9 aktivnih polica — u listama su padale u „Ostalo" i kvarile redosled. Osam je
ugašeno (0 uloga, 0 pokreta ikad) skriptom
`backend/docs/sql/sy15/lokacije-cistka-2026-08-04.sql`: K-A6, K-B6, K-C6, K-MG, K-MG3, K-MG4,
K-MG8, K-S. Deveta (**K-D „DORADA"**) nije dirana jer na njoj stoji roba.

**Izmereno (sy15, 04.08.):**
| polje | vrednost |
|---|---|
| nalog | 9400 |
| stavka (TP) | 755 |
| crtež | 1121195 |
| količina | 1 kom |
| uloženo | 10.05.2026 13:37 (INITIAL_PLACEMENT) |
| pokreta od tada | nijedan (skoro 3 meseca stoji) |

**Šta uraditi:**
1. Magacin fizički nađe taj komad i premesti ga kroz **„Premesti stavku"** na živu policu
   (evidencija se time sama sredi). Ako komada fizički NEMA → korekcija stanja (tip pokreta
   „Neraspoređeno"/korekcija), ne tiho gašenje.
2. Tek kad je K-D prazna, ugasiti je istim obrascem kao 8 sestrinskih (brana ostaje obavezna):
```sql
-- sy15: docker exec -i sy15-db psql -U supabase_admin -d postgres
UPDATE loc_locations SET is_active = false, updated_at = now()
WHERE location_code = 'K-D' AND is_active
  AND NOT EXISTS (SELECT 1 FROM loc_item_placements p
                  WHERE p.location_id = loc_locations.id AND p.quantity > 0)
  AND NOT EXISTS (SELECT 1 FROM loc_location_movements m
                  WHERE m.from_location_id = loc_locations.id
                     OR m.to_location_id = loc_locations.id);
```
**Rizik ako se ne uradi:** kozmetika — polica ostaje u listi pod „Ostalo" i kvari redosled.
Roba na neaktivnoj lokaciji bila bi „zaključana", zato je gašenje sa robom zabranjeno.

---

### B2. ✅ REŠENO 05.08.2026 — kiosk pita kad količina nije puna
**Odluka Nenada 05.08.:** *„Jedno dugme „Kraj rada", plus pitanje koje iskoči samo kad količina
nije puna: „Otkucao si 21 od 200. Da li je operacija gotova?" — sa podrazumevanim NE."*

**Isporučeno** (grana `feat/kiosk-pitanje-gotovo`, na main-u `f038e346`, deploy potvrđen):
kiosk pita samo ispod plana (podrazumevano „Ne — nastavlja se"); puna količina zatvara bez
pitanja; server ne veruje ekranu (izostanak odgovora ispod plana → NE zatvara); „Odustani" više
ne diže zastavicu nego otkupljuje red (komadi ostaju, poruka upućuje na storno);
`POST /:id/finish` podignut na `TEHNOLOGIJA_WRITE`.

**Zašto promena kanona čitanja NIJE potrebna:** zastavica sada znači ono što piše, pa se
`bool_or` ne dira — otpada korak koji bi menjao ekrane planera i pogona i razišao 1.0.

**Istorija ispravljena** skriptom
`backend/docs/sql/kiosk-istorijska-sanacija-gotovo-2026-08-05.sql`
(granica 01.07.2026, Nenadova odluka): **31 red / 20 operacija / 16 RN**, 18 ostalo vlasniku,
13 otkupljeno; audit red `audit_log id=32481` omogućava povratak. Preostalo van granice: **497**
zatvorenih redova ispod plana (svesno nedirano — planiranje ih pušta kroz zaobilaznicu iz 064).

**Ostaje otvoreno (sitno):**
- Barkod ekran „Završi rad" nema dijalog — tamo radnik ne može da označi operaciju gotovom ispod
  plana (polje `operacijaGotova` postoji na API-ju, FE ga ne šalje).
- 🔴 **Radnik 130, RN 9000/95 op 20 RC 3.12: 10 otvorenih redova iste operacije** — zatečeno,
  nije od ovih izmena. Odluka Nenadu: spojiti u jedan ili otkupiti višak.
- Otkupljeni redovi sele svoje komade na radnika „Korisnik" u tabu **Učinak po radniku**
  (izmereno: 5 komada / 7 radnika). Kozmetika, ali nije u upozorenjima skripta.
- Dva kanona kumulativa i dalje postoje: upis broji SVE kvalitete, `rn-progress`/praćenje samo
  GOOD. Istorijski se razilaze na 119 operacija; **0 otvorenih danas** — nema žive izloženosti.

**Čeka:** Strahinja i Negovan da potvrde FORMULACIJU pitanja radniku (pitano 05.08. u 064/26).

---

## P. PRAVA NAD PODACIMA U APLIKACIJI (osnovano 05.08.2026)

**Zašto poseban odeljak:** 05.08. je zatvoren prvi krug — knjige (glavna knjiga, saldakonta,
izvodi, plaćanja, kamata, blagajna, PDV, završni račun) skinute su sa role `menadzment` i vraćene
**imenom** Jeleni Stanišić i Dušku Kostiću, a Radisav Radević dobio `robno.read` (grana
`feat/erp-prava-allowlist`, commit `3c48c0c5`; dozvole upisane na produkciju pre koda).

Time je krug za knjige sveden sa **24 na 7 ljudi**. Ali analiza je izmerila da **knjige nisu bile
najveće curenje** — ostatak je ovde, i Nenad je 05.08. rekao da je zasad **U REDU**, da se rešava
kasnije. Ne brisati dok se ne izvede ili dok se izričito ne odustane.

> **Merodavan izvor:** puna analiza (7 delova, sa predlogom teksta pravila) je u izveštaju od
> 05.08.2026; ovde stoji samo ono što ostaje da se uradi.

### P1. Kartica artikla pokazuje nabavnu cenu, dobavljača, kupca i rabat — vidi je 67 od 69 ljudi 🔴

**Kontekst.** Kroz isto pravo kojim se gledaju artikli i lager lista (`directory.read`) otvara se i
kartica artikla, koja **po svakom dokumentu** prikazuje nabavnu cenu, ime dobavljača, ime kupca i
odobreni rabat — uz dugme za izvoz u Excel.

**Izmereno (05.08.2026):** 67 od 69 aktivnih naloga (svi osim kiosk terminala u pogonu i servisnog
naloga diktafona). 20.416 redova ulaza/izlaza · 228 dobavljača · 1,36 mlrd RSD nabavne vrednosti ·
164.574 reda profaktura na 2.361 komitentu · **marža vidljiva na 9.845 redova = 429,5 mil. RSD**.

**🔴 Ovo je REGRESIJA, ne zatečeno stanje.** Brana je postojala: taj deo je ranije tražio pravo za
robno (24 osobe), a **PR #90 ju je skinuo** i krug se proširio sa 24 na 67.

**Šta uraditi.** Vratiti karticu artikla pod pravo za robno; lager listu i spisak artikala NE dirati
(odluka Nenad 05.08.: „lager može da vidi sve, ne komplikujmo").

**Rizik/cena:** sitno. **Preporuka:** uraditi u istom potezu sa P2.

### P2. Izvoz u Excel zaobilazi ekran i ne ostavlja trag

**Izmereno.** Dugme „Export" na artiklima i lageru **ne izvozi ono što je na ekranu** — ponovo zove
server i prolazi kroz sve strane (do 60 zahteva, do 5.000 redova po izvozu), sa kolonama VP cena,
MP cena, devizna cena. Kapa nije brana: filtriranjem po grupama ceo cenovnik izlazi u više navrata
(92.620 artikala, 21.760 sa cenom). **Gledanje i izvoz se ne beleže nigde** — dnevnik hvata samo
izmene.

**Šta uraditi.** Odlučiti da li izvoz traži svoje pravo, i da li se beleži (ko, kad, koliko redova).

### P3. Slanje van kuće ide pod pravom čitanja

**Izmereno.** Dve rute pretvaraju „smem da gledam" u „smem da pošaljem": **IOS bilo kog komitenta**
i **PP-PDV prijava firme** šalju se na adresu koja se upiše u zahtev — bez ograničenja domena i bez
evidencije poslatog. (Opomena je urađena kako treba: traži pravo izmene i upisuje se u tabelu.)

**Šta uraditi.** Slanje na spoljnu adresu vezati za pravo iz kruga knjiga + evidentirati primaoca.

### P4. Stari sistem može da promoviše čoveka u administratora

**Izmereno.** Sinhronizacija je namerno jednosmerna: administrator se ne skida, ali **se dodaje** —
jedan red u staroj bazi i čovek u 3.0 dobija **sva** prava. Danas je rupa prazna (provereno: niko ko
nije već administrator nema tu rolu u starom sistemu), ali je put od „prazna" do „otvorena glavna
knjiga" jedan upis u drugom sistemu, koji radi neko ko o ERP pravima ne odlučuje.

### P5. Pravo upisa u šifarnik ima 67 ljudi, drži ga jedan prekidač

**Izmereno.** Ugrađeno pravilo „ko sme da čita šifarnik, sme i da piše" (odluka O-6 od 30.07.) daje
`masters.write` svakoj roli sa `directory.read`. Danas ih zaustavlja poslovna brana koja vraća
odbijanje — ali ta brana je **jedan prekidač daleko od otvaranja**, i onog dana kad se unos artikala
otvori, otvoriće se **svima odjednom**, bez ijedne nove odluke.

### P6. Baza nema drugi pojas

**Izmereno.** Glavna baza ima **0 sigurnosnih politika na 224 tabele** — brana je tačno onoliko jaka
koliko je tačan spisak dozvola po rutama. Dobra vest, takođe izmereno: stroga provera je **uključena**
na produkciji (nije „tihi režim") i **nijedna** ERP ruta nije bez prava (skenirano svih 66 kontrolera
/ 1.257 ruta).

### P7. Kako izgleda čoveku kome se pravo skine

Nije provereno da li dobija razumljivu poruku ili praznu stranu. Pre sledećeg reza proveriti —
17 ljudi je 05.08. izgubilo uvid u knjige.

### P8. ⚠️ Nije mereno i ne može se meriti odavde: ko ima pristup samom BigBitu

BigBit je živ do prelaska (april 2027) i u njemu su **svi ovi podaci u punom obimu**. Zatvaranje
3.0 nema smisla ako je BigBit otvoren istom krugu ljudi. **Za Nenada.**

### P9. Rola-prerada (najavljena, nije počela)

Nenad 05.08.: „to ćemo posle rešavati sa ROLAMA". Ostaje otvoreno: 19 ljudi nosi `menadzment`;
pojedinačna prava **nemaju ekran** (interfejs poznaje samo tri zakucana ključa) ni trag (tabela ima
4 kolone — bez vremena i bez autora), pa se dodaju SQL-om. Rola `finansije` postoji u katalogu i u
padajućoj listi, ali **nema nijedno pravo**; probano 05.08. da bude nadskup menadžmenta i
**odbačeno** — osam paritet-brana (34 testa) pokazalo je da bi uz knjige tiho dala i upravljanje
SCADA-om, forsiranje plana proizvodnje i izmenu montaže.

### P10. Šifarnik VRSTA USLUGE nema ekran za uređivanje — menja ga samo SQL (05.08.2026)

**Šta je urađeno.** Uvedena je tabela `service_revenue_types` (migracija
`20260805190000_sifarnik_vrsta_usluge`) sa četiri potvrđene vrste: `USL` → konto 6140 uz PDV 20 %,
`USL-INO` → 6151 bez PDV-a (čl. 12 st. 3), `OTPAD` → 6796 gde PDV obračunava KUPAC (čl. 10 st. 2
t. 1), `ZAKUP` → 6501 uz PDV 20 %. Uslužni račun nosi izbor na zaglavlju
(`invoices.service_revenue_type_id`), a konto prihoda, poreski tretman i napomena na papiru slede
iz njega. Komercijala bira **šta prodaje**, ne konto. Ekran: padajuća lista na detalju računa
(`/fakturisanje/detalj`), vidljiva samo na `IFUSL`/`IZVUS` i na predračunu.

**Šta OSTAJE.** Šifarnik je posao **knjigovođe** (odgovor 28 iz upitnika: „knjigovođa i
administratori, ali da se beleži izmena"), a ekran za njegovo uređivanje **nije napravljen**.
Danas se nova vrsta, izmena konta ili gašenje rade SQL-om nad produkcijom. Konkretno fali:

- ekran u Podešavanjima (spisak + dodavanje + izmena + prekidač „aktivno"), uz rutu koja piše;
- **pravo** koje to razdvaja od komercijale — ko sme da menja konto prihoda i poreski tretman;
  danas ruta za čitanje ide pod `sales.read`, a rute za upis nema uopšte;
- **trag izmene** (ko i kada je promenio konto ili tekst napomene). Tabela ima samo
  `created_at`/`updated_at`, bez autora — isti nedostatak kao kod pojedinačnih prava iz P9.

**Zašto nije hitno:** četiri vrste pokrivaju sve što je izmereno u knjizi 2026 (57 od 57 stavki),
peta se ne očekuje uskoro, a vlasnik je uz 6501 rekao „to može posle da se promeni" — što je
izmena JEDNOG polja u JEDNOM redu. **Rizik/cena:** srednje (ekran + pravo + audit kolona).
**Preporuka:** raditi zajedno sa P9 (rola-prerada), jer je to isto pitanje — ko sme šta da menja.

**Nije rešeno ni ovo (uže, tehničko):** avansni račun (`AVR`) za promet po vrsti `OTPAD` /
`USL-INO`. Danas AVR uvek računa porez iz bruta i ne gleda vrstu usluge; avans na promet gde PDV
obračunava kupac po zakonu ni ne nosi porez, pa bi ga trebalo ili zabraniti ili obraditi posebno.
Nije mereno da li se takav avans u praksi izdaje (u knjizi 2026 — nijedan).

---

## C. TEHNIČKI FOLLOW-UP (nalazi verifikatora, po prioritetu)

### C1. Nišan gejt — POPRAVLJEN 05.08. (radi i u Chrome-u), čeka potvrdu sa terena ⏸
Popravka „promašaj ~2 cm" (04.08., `frontend/src/lib/barcode-decoder.ts`,
`shouldLimitScanToReticle()`) bila je gejtovana na UA `SM-A16x/SM-A17x`. **Chrome na Androidu od
v110 šalje redukovan UA** (`Linux; Android 10; K`) → model se ne vidi → gejt se tiho NIJE
aktivirao. Radio je samo u **Samsung Internetu** (UA zadržava model) i verovatno u APK WebView-u —
otud Nenadova prijava 05.08. „i dalje na A16 nišan ne radi".

**Stanje posle 05.08.: automatika po profilu je ŽIVA i sada stvarno radi i u Chrome-u.** Model se
razrešava kroz `navigator.userAgentData.getHighEntropyValues(['model'])` —
`frontend/src/lib/device-model.ts`, `primeDeviceModelHint()` (taj modul namerno NEMA nijedan
import, da ne pravi ciklus sa `barcode-decoder`; greje se pri otvaranju skenera, pre `attach`-a).
Odluku donosi `matchesReticleGateProfile(getDeviceModelHint())`.

**Prekidač više ne traži konzolu:** dug pritisak (~450 ms) na dijagnostički red u bilo kojoj
skener-ljusci otvara panel sa tri prekidača (`ss3_scan_roi_gate`, `ss3_scan_autozoom`,
`ss3_scan_af_kick`), svaki `auto`/`uklj`/`isklj`. Promena važi **od sledećeg otvaranja skenera** —
zato red prikazuje STVARNO stanje sesije (`VideoDecoderHandle.roiGateActive`), a prekidač koji se
s tim ne slaže ispisuje posebno („→ važi od sledećeg otvaranja").

**Uraditi:** na A16 uporediti sken sa gejtom `uklj` i `isklj` i potvrditi da automatika ostaje.
**A26/S26/iPhone moraju ostati van gejta** (Nenadov tvrd uslov, 04.08.).

### C2. Kvalitet modul ima istu „hapfluid" rupu 🔴
034/26 je sredio primaoce obaveštenja o neusaglašenostima (tabela `montaza_nm_primaoci`), ali
**modul kvalitet i dalje šalje po roli `menadzment`**: `quality-events.service.ts:595`,
`quality-events-mail.service.ts:65`. Ta rola je 04.08. obuhvatala **19 naloga**, uključujući
**spoljnu adresu `bojana.trifunovic@hapfluid.rs`**, `test@servoteh.com` i `jarakovic@gmail.com`.
**Uraditi:** isti obrazac kao 034 (tabela primalaca + sekcija u Podešavanja → Notifikacije,
`settings.system` = admin). Deljena logika već postoji: `common/workers/named-primaoci.ts`.

### C3. Admin forme lokacija nude ZADU zaduženja
04.08. je picker premeštanja očišćen (`isStorageLocation` u `location-select.tsx`), ali admin
forme nisu: `cage-form-dialog.tsx:37` i `bulk-shelves-dialog.tsx:23` nude **28 ZADU redova među
~19 pravih hala** pri izboru roditelja; `location-form-dialog.tsx:146` nudi čak i police kao
„nadređenu halu"; `stampa-tab.tsx:89` isto. **Uraditi:** primeniti isti helper.

### C4. „Sa lokacije" prazno za rezni alat (rev_tools)
Jedini ulozi na ne-skladišnim lokacijama su **39 redova `rev_tools`** na ZADU. Za njih
stavke-tab preset postavi `fromLocationId`, ali `LocationSelect` sa filtriranom listom ne nalazi
selektovano → polje se renderuje **prazno** (state je ispravan, submit radi, čip iznad prikazuje
lokaciju). Kozmetika, ali zbunjuje. `movement-dialog.tsx`, `stavke-tab.tsx:104`.

### C5. 9400 familija — „preostalo" može biti precenjeno
„Uloži preostalo sa naloga (K kom)" (059/26) računa K = plan − Σ uloga po **tačnom** ključu
(nalog, TP). Na produ je **310 od 979** živih uloga pod legacy composite ključem `o/t` — **svi u
9400 familiji** (9400:154, 9400/2:64, 9400/3:35, 9400/1:29, 9400/6:28). Za te stare naloge Σ
ispadne manji → **K precenjen**. Regularni nalozi su čisti (0 composite van 9400). 1.0 je hvatala
i legacy varijante. **Uraditi:** proširiti filter Σ na legacy ključeve ili jednokratno
normalizovati te redove (odluka: data-fix vs kod).

### C6. FK nacrt ↔ primopredaja ne postoji (055 kapija sudi heuristikom)
PDF liste pozicija (055/26) i ceo handovers modul vezuju nacrt i primopredaju **best-effort** po
crtežu (`resolveDraftContext`, `handovers.service.ts:1606`) jer FK ne postoji. Posledica: kapija
„samo odobrene" bira **najskoriju primopredaju crteža globalno** — nacrt **3462 / G-260713-001**
dobija lažno 422 iako je njegova sopstvena primopredaja lansirana. Izloženost: **336 crteža je u
više od jednog zaključanog nacrta**; danas 1 lažno-negativan od 409, 0 lažno-pozitivnih.
Količine i nazivi u PDF-u **uvek** dolaze iz traženog nacrta (nema mešanja podataka).
**Uraditi:** uvesti FK ili ograničiti kapiju na primopredaje nastale submitom tog nacrta
(vremenski prozor). Već otvorena tačka spec-a.

### C7. 016 sweeper — brane za drugu instancu i vreme u mejlu
Zbirna obaveštenja o lansiranju (016/26) imaju in-process sweeper na 30 s koji **nema DB branu**
(nema `SKIP LOCKED`/claim) ni env gejt — druga instanca = dupli mejlovi; instanca sa
nekonfigurisanim mejlom bi stampovala redove i **tiho izgubila talas**. Danas bezopasno (prod =
jedna instanca), ali oba postojeća tik-obrasca u repou (`scheduler.service.ts:24-26,62`,
`grid-autofill.service.ts:306-312`) imaju branu. **Uraditi:** `NODE_ENV` gejt ili
`FOR UPDATE SKIP LOCKED` claim.
Uz to: vreme u mejlu je **vreme slanja**, ne lansiranja (`launch-notify.service.ts:363-365`) —
zastareo talas (posle pada) stiže sa današnjim vremenom; `_max.createdAt` grupe već postoji.

### C8. Izvozi praćenja se raziđu sa ekranom
053/26 je uklonio kolone crteža sa ekrana i uveo redne brojeve, ali **XLSX/PDF izvoz
(`pracenje-export.ts`) i dalje nosi kolone crteža i nema redne brojeve**. Odluka: uskladiti ili
svesno ostaviti (izvoz = drugi konzument).

### C9. Sitnice iz verifikacija (jeftino, bez rizika)
- **055:** FE dugme „Štampaj PDF" traži status SAGLASAN, a BE prima i LANSIRAN → potpuno lansiran
  nacrt nema dugme nigde (`handover-detail.tsx:394`).
- **046:** `q='%%'` prolazi min-len gejt i vraća prvih 5000 (parametrizovano, nema injekcije).
- **060:** dugme „Dodaj" (delovi) je disabled bez objašnjenja zašto (naziv dela prazan) — dodati
  hint.
- **024 minori:** brisanje auto-kreiranog termina → automatika ga sutra u 08:00 ponovo napravi
  („zombi termin", jedini stop = promena tipa); ručno kreiran „sledeći" periodični ne postavlja
  lanac → dupli termin; najava u listi gleda praznike 90 dana a automatika 420; pozivnice se
  stampuju i za seriju bez učesnika.
- **OCR crop:** `cropTopRightLabelRegion` seče gornji desni ugao **frejma**, a ne prikaza — u
  portret „cover" prikazu je ~79% tog isečka van ekrana. Paritet sa 1.0; popravka bi menjala i
  iOS pa je van nišan-gejta. Zaslužuje poseban zahtev.
- **tsc higijena:** pun `tsc --noEmit` (van build configa) pada na 6 grešaka u 3 spec fajla:
  `handover-draft-print.service.spec.ts` (4×TS2322), `kadrovska.zahtev-026.spec.ts:50`,
  `moj-profil.zahtev-026.spec.ts:126`. CI ih ne vidi (build config isključuje spec fajlove).
- **e2e `netzero/zahtevi.probe` pada 3 kruga zaredom** (draft→submit→arhiviraj, vozi se protiv
  ŽIVE produkcije). Stvarni korisnici uredno podnose zahteve (068 podnet 04.08. u 20:34), pa je
  sumnja na e2e nalog — isti nalog dobija **403 na `/completed-orders`, `/nacrti`,
  `/cnc-programs`**. Ako je tako, probe ne testira ništa i treba mu popraviti prava ili ga ugasiti.
- **Nijedan FE test se ne pokreće.** `frontend/src/app/artikli/_forma/pravila.spec.ts` je jedini
  FE spec u repou; frontend nema `test` skriptu, backend jest ima `rootDir: "src"`, nijedan
  workflow ga ne hvata → nula zaštite na FE strani.

### C10. Da li MSSQL sync kanal uopšte ostaje? 🔴 STRATEŠKO
Posle 061 popravke (04.08.) ručno dugme „Pokreni sync" vozi još **~21 tok iz izvora zamrznutog
22.07.2026** — BigBit→QBigTehn prenos je ugašen, MSSQL kopija se ne osvežava
(`tRN` MAX izmene = 14.07., 6 tabela prazno). Živi kanal za predmete/komitente/artikle je
**noćni `.mdb` uvoz ~03:45** (izvoz iz BigBita jednom dnevno oko kraja smene, mereno 16:04–19:28).
**Pitanje za vlasnika:** gasimo MSSQL kanal u celosti (dugme + kod + env) ili ga držimo dok se ne
odluči sudbina QBigTehn-a? Držanje košta: svaki klik javlja grešku na 6 tokova, a admin
eksplicitnim pozivom i dalje može da pregazi noćni uvoz (sada bar uz warn u logu).
**Preporuka:** ugasiti kad se potvrdi da ništa iz MSSQL-a više nije potrebno — prethodno izmeriti
da li ijedan tok iz preostalog 21 nosi podatke kojih nema u `.mdb` kanalu.

### C11. Migracije se NIGDE ne proveravaju pre produkcije 🔴
04.08. je deploy pao usred primene migracije 016 (PostgreSQL 42P01 — ciljna tabela `UPDATE`-a
referencirana u `JOIN` uslovu unutar `FROM`). Šteta nula (transakcija, 0 primenjenih koraka),
ali **neuspela migracija blokira SVE naredne**: dok se ne označi kao vraćena, svaki sledeći
deploy pada. Nijedan gejt (jest, tsc, nest build, e2e) migracije ne izvršava — prvi put se
pokreću na PRODUKCIJSKOJ bazi.
**Uraditi:** CI korak koji pusti `prisma migrate deploy` na praznoj bazi (postgres service u
workflow-u). Jeftino, hvata tačno ovu klasu.
**Ručni obrazac koji je te večeri radio** (koristiti dok gejta nema): celu migraciju pustiti na
produ unutar `BEGIN; … ROLLBACK;` i uporediti brojke sa očekivanim, pa tek onda push.
**Sanacija kad se ipak desi:** `UPDATE _prisma_migrations SET rolled_back_at = now() WHERE
migration_name = '…' AND finished_at IS NULL;` pa popravka i novi deploy.

### C12. Odbijanje zahteva nema dvostruku kontrolu
`makeup_reject` traži samo `can_manage_vacreq()` + `manages_employee()` — bez provere
„prvi nivo nisam ja" koju odobravanje (`makeup_approve`) ima. Šef koji je sam prosledio zahtev
može ga odbiti. Nije novo, ali je od 04.08. na jedan klik jer se zahtev konačno vidi u listi.
**Odluka Nenadu:** zaključati i odbijanje kao odobravanje?

### C13. Badž broji sve godine, tabela prikazuje jednu
U kadrovskim listama zahteva badž taba računa sve godine a tabela je sužena na izabranu — ista
patologija „brojka se vidi, sadržaj ne" koju je 068 zatvorio za statuse. Dodato je glasno
upozorenje kad godina skriva zahteve koji čekaju odluku; trajno rešenje nije urađeno. Danas se
ne pali (svi zahtevi su 2026).

### C14. Prelaz u „šef odobrio" 31.07. u 20:23 nema trag obaveštenja
Za isti tip prelaza 02.07. postoje 3 reda u `kadr_notification_log`, za ovaj nijedan. Kod poziva
`kadr_queue_makeup_notification`, ali `queueBestEffort` guta greške — moguće da je nešto tiho
palo. Uzrok NIJE dokazan; prijavljeno kao merenje. Ako se ponovi, tražiti trag u logu backenda
u tom minutu.

### C15. 016: veza nacrt ↔ primopredaja i dalje bez FK
Zbirno obaveštenje po nacrtu radi samo kad je crtež u tačno jednom nacrtu; **oko trećine
pozicija (232/646) i dalje ide pojedinačno**, a za porodicu 9400/7 čak 27 od 34
(G-260724-008 i G-260724-010 dele 27 crteža). Strahinja je o tome iskreno obavešten 05.08.
Trajno rešenje = FK nacrt↔primopredaja (ista tema kao C6, drugi ugao).

### C16. Pločica „Vozila" verovatno broji isto što je IT pločica brojala (šum)
05.08. je popravljena IT pločica na `/odrzavanje` — pisala je „N zahtevaju pažnju", a otvaranje
je pokazivalo uređaje u statusu **Radi**: `reportAttention()` je vraćao SVE nearhivirane redove
pregleda, bez ijednog uslova. Sad broji samo stvarne razloge (`status <> 'running'` ili otvoren
radni nalog ili istekla licenca/garancija ili backup `missing`/`stale`) —
`backend/src/modules/odrzavanje/odrzavanje.service.ts`, `reportAttention()`.
**Isti obrazac nije proveren na pločici „Vozila"**: ona broji redove plana održavanja uključujući
`ok` i `inactive`, pa verovatno pokazuje isti tip lažne uzbune.
**Uraditi:** izmeriti koliko redova pločica broji vs koliko ih stvarno traži akciju, pa suziti
istim `WHERE`-om. Jeftino, bez migracije.
⚠️ Vozila su se radila u zasebnoj sesiji („VOZILA — ODRŽAVANJE I EVIDENCIJA") — pre izmene
proveriti da ne gazi tamošnji rad.

---

## D. ČEKA KORISNIKE (ne blokira razvoj)

- **Nenad:** proba nišana na **A16** — obavezno u **Samsung Internetu** (vidi C1); 05.08. nije
  urađena (svi otišli sa terena), prenosi se na prvi dan kad je telefon dostupan;
  proba stonog (wedge) čitača u „Premesti stavku" — 04.08. je isporučeno rastavljanje skena
  u obe aplikacije; proba štampe barkoda 62.65 × 13 mm.
- **Nenad (odluka, 1 minut):** **radnik 130 ima 10 otvorenih redova na istoj operaciji**
  (RN 9000/95, op 20, RC 3.12) — zatečeno stanje, nije od izmena 05.08. Spojiti u jedan red ili
  otkupiti višak? Do odluke „Učinak po radniku" mu deli komade na 10 redova. Vidi B2.
- **Nenad / Nevena / Zoran:** **6 zahteva** izašlo iz nevidljivosti 04.08. i čeka klik —
  4 GO (Branislav 23.07 · Marija 30.07 · Miljan 10–21.08 · Milan Stojadinović 07.08; prva dva
  za datume koji su VEĆ prošli), 1 zamenski dan (Stamenić 01.08), 1 plaćeno odsustvo.
- **Strahinja + Negovan:** potvrda FORMULACIJE pitanja radniku na kiosku (B2 je izveden 05.08.,
  pitanje je živo; traži se samo saglasnost na tekst — pitano u komentaru na 064/26).
- **Strahinja (016/26):** 4 pitanja postavljena 04.08. uveče — koji su tačno predmeti
  „Servotransfer prese" (7 kandidata, numeracija se preklapa); da li Dijana prati i nadređeni
  predmet **9400** (789 RN i 55 nacrta ove godine — najživlji, a nije na spisku) i 9400/8; ostaje
  li Strahinja globalni planer ili se sužava na spisak; potvrda 9881 → 9811.
  ⚠️ Dok ne odgovori, SQL `backend/docs/sql/predmet-planeri-016-2026-08-04.sql` se NE pušta.
  Nalaz usput: **Dijana i Branislav nemaju nijedan red u `predmet_planeri`** — nikad nisu mogli
  da dobiju obaveštenje (cela tabela ima 4 reda).
- **Kadrovska (Nevena/Nenad/Zoran):** finalizacija zahteva za zamenski dan `20f99be3`
  (Nedeljko Stamenić, subota 01.08.) — čim popravka „zahtevi za odobravanje" bude živa, pojaviće
  se u listi. Detalji u forenzici 068: ništa nije obrisano, fali tačno taj jedan dan.
- **Podnosioci:** potvrde na zahtevima u statusu „Spreman za test" (dugme „✔ Potvrđujem — radi").

---

## Napomene za rad (naučeno 04.–05.08.)

- 🔴 **SQL koji MENJA podatke mora biti u ZASEBNOM fajlu od pregleda (preview-a).** 05.08. je
  verifikator dobio zadatak „pusti samo KORAK 1 (pregled)", a `sed` opseg je zahvatio i KORAK 2 —
  33 reda su otvorena na produkciji bez odobrenja (vraćeno za par minuta, ostala je razlika u
  milisekundama na `finished_at`). Pregled i mutacija u istom fajlu se **ne razdvajaju pouzdano
  alatom** — razdvojiti ih fajlom, i mutaciju pušta samo čovek.
- **Agenti imaju mandat SAMO ZA ČITANJE baze.** Svaki `UPDATE`/`INSERT`/`DELETE` priprema se kao
  fajl, a izvršava se posle ispisanog pregleda.


- **Skripte pokretati iz git blob-a**, ne iz checkout-a:
  `git show origin/main:putanja | ssh ubuntusrv 'bash -s'` — primarno stablo često stoji na tuđoj
  grani (starija verzija), a Windows worktree checkout nosi CRLF koji lomi bash.
- **`set -o pipefail` + `grep -q`** = lažni pad **na pogodak** (grep izađe na prvom pogotku →
  SIGPIPE uzvodno → cev „padne"). Koristiti `grep -c`. Ovo je 04.08. proizvelo tri lažna 🔴
  post-deploy-verify-ja na potpuno zdravom produ.
- **Redosled sy15 SQL vs deploy nije uvek isti:** ako Prisma model dobija nove kolone → **SQL
  PRE deploy-a** (inače 42703 pri svakom čitanju); ako se menja samo telo funkcije → deploy pa
  SQL. Header svakog SQL fajla mora reći koji je slučaj.
- **Enum kolone u sirovom SQL-u traže eksplicitan kast** (`::public.maint_operational_status`) —
  bez njega 42804 („column is of type X but expression is of type text").
