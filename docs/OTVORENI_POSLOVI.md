# Otvoreni poslovi i odluke na čekanju

**Osnovan 04.08.2026.** Registar svega što je izmereno i pripremljeno ali NIJE izvedeno —
da se svaka stavka može pokrenuti hladno, bez ponovnog istraživanja.

**Kako se koristi:** svaka stavka ima *Kontekst → Izmereno → Šta uraditi → Rizik/cena → Preporuka*.
Brojke su merene na živim bazama na navedeni datum — pre izvođenja ih **ponovo izmeriti**
(populacije se menjaju svakodnevno). Kad se stavka izvede: obriši je odavde i zabeleži u
odgovarajući modul-doc ili commit poruku.

**Odeljci:** [A](#a-donete-odluke-ne-vraćati-na-sto) odluke · [B](#b-čeka-nenada--pogon-spremno-za-izvođenje) čeka Nenada/pogon ·
[P](#p-prava-nad-podacima-u-aplikaciji-osnovano-05082026) prava nad podacima · [C](#c-tehnički-follow-up-nalazi-verifikatora-po-prioritetu) tehnički follow-up ·
[D](#d-čeka-korisnike-ne-blokira-razvoj) čeka korisnike · **[K](#k-kadrovska--zamrznuta-do-pune-seobe-na-30-osnovano-06082026) Kadrovska — 🔴 ZAMRZNUTA (i dorade i popravke) do seobe na 3.0**

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

### B3. ✅ REŠENO 05.08.2026 — plan sudi gotovost po DOBRIM komadima (069/26)

**Zahtev (Strahinja):** *„kad majstor na mašini završi, tj. kompletira operaciju po planu, da se
automatski ažurira u planu da je gotova operacija"*; na dopunu je dodao: *„označiti u planu ako
piše škart, umesto štiklirano da je gotovo, da piše škart"*.

**Merenje je promenilo zahtev.** Automatika je već radila: **nijedna** pozicija ne dobija novu
kvačicu (0 od 51.321). Pravi problem je bio obrnut — plan je pisao „gotovo" po zastavici
„Kraj rada", nezavisno od količine.

**Odluka Nenada (05.08.), poklopila se sa Strahinjinim odgovorom nezavisno:**
```
gotovo = ručna presuda planera  ILI  DOBRIH komada >= plan
```
Škart i dorada se NE broje — isti kanon koji praćenje i tech-processes već primenjuju
(`QUALITY_GOOD` / `PART_QUALITY.GOOD`). Plan je bio jedini modul koji je odstupao, pa **ovim se
zatvara pola nalaza „dva kanona kumulativa" iz B2** (čitanje je poravnato; upis je i dalje po
svim kvalitetima — v. C17). Zastavica kioska preživljava samo gde količina nije merljiva
(mašine `without_process`, 1.390 operacija). **Bez datumske granice** (odluka Nenada): menja
1 red na gantu, granica bi bila trajna ružnoća u samom pravilu.

**Izmereno pred izmenu** (51.321 operacija kroz predmet-gate):

| | |
|---|---|
| kvačicu GUBI | **1.525** (306 bez ijednog otkucanog komada, 451 na zatvorenom RN-u, 79 sa škartom) |
| kvačicu DOBIJA | **0** |
| na gantu (32 planirane pozicije) | menja se **1 red** |
| lista „Po mašini" | **0** — filtrira po SIROVOJ zastavici `is_done_in_bigtehn`, koja je netaknuta |

**Isporučeno** (grana `feat/plan-gotovost-dobri-komadi-069`): bedž **ŠKART** u levoj koloni ganta
dok škart nije nadoknađen (nestaje sam kad neko otkuca dovoljno dobrih); dijalog stavke pokazuje
„Urađeno (dobri)" + „Otkucano (svi kvaliteti)" kad se razlikuju; picker „Dodaj na plan" meri
dobre komade, pa se pozicija sa škartom MOŽE vratiti na plan radi nadoknade.

🔴 **Pouka (2 verifikatora, nezavisno isti nalaz):** prva verzija je stavila oznaku u bar — a bar
je na produkciji **median 10px širok** (28 od 32 ispod 20px). Doslovan zahtev „da PIŠE škart" bio
bi isporučen kao tekst koji se ne vidi. Kad se traži da nešto **piše**, izmeri koliko mesta
zaista ima.

**Rizik pri potvrdi:** Strahinjin doslovni primer („prihvat 2 obrada", RN `9400/6/74` op. 20) je
**ručno štikliran** i posle izmene se ne menja; njegov gant dobija **0 novih kvačica i 0 ŠKART
oznaka**, a gubi **1** kvačicu (RN `9400/2/492` op. 20 „Dorada 400", plan 4 kom, **0 otkucanih**).
Očekuj „ništa se nije promenilo" ili „nestala mi je kvačica" — v. D odeljak.

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

### ~~P1. Kartica artikla — vraćanje pod pravo za robno~~ ✅ ODLUKA: OSTAJE KAKO JESTE

**Odluka Nenad, 05.08.2026:** *„OK, može da se vidi kartica artikala, to nek ostane uz moju
dozvolu."* — dakle **ne vraća se** brana; kartica ostaje vidljiva svima sa pravom imenika.

**Šta je vlasnik time prihvatio** (ostaje zapisano, jer je odluka svesna a ne previd): kroz isto
pravo kojim se gledaju artikli i lager lista (`directory.read`) otvara se i kartica artikla, koja
**po svakom dokumentu** prikazuje nabavnu cenu, ime dobavljača, ime kupca i odobreni rabat — uz
dugme za izvoz u Excel.

**Izmereno (05.08.2026):** 67 od 69 aktivnih naloga (svi osim kiosk terminala u pogonu i servisnog
naloga diktafona). 20.416 redova ulaza/izlaza · 228 dobavljača · 1,36 mlrd RSD nabavne vrednosti ·
164.574 reda profaktura na 2.361 komitentu · **marža vidljiva na 9.845 redova = 429,5 mil. RSD**.

**Kako je do toga došlo:** brana je postojala (taj deo je tražio pravo za robno, 24 osobe), a
**PR #90 ju je skinuo** i krug se proširio na 67. Dakle stanje nije nastalo odlukom nego
regresijom — ali je 05.08. **naknadno odobreno**, pa se ne vraća.

⚠️ Ako se ikad predomisliš, popravka je sitna i opisana je gore: kartica ide pod pravo za robno,
lager lista i spisak artikala se NE diraju.

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

**✅ EKRAN IZVEDEN 05.08.2026** (grana `feat/erp-prava-allowlist`). Podešavanja → **Vrste usluge**:
spisak (i ugašene vrste), dodavanje, izmena, prekidač „aktivno", uz trag izmene. Rute
`/v1/admin/knjigovodstvo/vrste-usluge` (`KnjigovodstvoController`). Uz njega je izveden i
**Podešavanja → Brojači dokumenata** (odluka O-F11) — v. novu stavku P11 ispod.

Kako su zatvorene tri tačke koje su ovde stajale kao „fali":

- **pravo:** novo `settings.accounting_rules`, koje ima SAMO rola `admin` (kroz ALL); knjigovođa
  ga dobija **imenom** kroz `user_permission_overrides` — SQL je
  `backend/prisma/seed/knjigovodstveni-sifarnici-imenovani.sql` (Jelena Stanišić, Duško Kostić).
  🔴 **SQL još NIJE primenjen na produkciju** — pokreće se ručno, pre deploy-a. Brane: ključ je
  dopisan u `erp-knjige-samo-imenovanima.spec.ts` i ima svoj
  `knjigovodstvena-pravila-imenovanima.spec.ts` (proverava GOL STRING ključa, jer
  `user_permission_overrides.key` drži baš njega).
- **trag izmene:** ide u `audit_log` sa `before`/`after` i spiskom polja koja su se promenila, i to
  **u istoj transakciji** sa izmenom. Nove kolone na tabeli nisu dodavane namerno — globalni
  `AuditInterceptor` je fire-and-forget i ne zna prethodnu vrednost, pa bi na „sa čega na šta"
  odgovorio pola.
- **brane na unosu:** poreski tretman je padajuća lista (vrednosti sa servera, ne prekucane), a
  konto prihoda se proverava prema `accounts` — nepostojeći se odbija uz objašnjenje, jer je
  kolona meki ref (bez FK) pa bi „6104" umesto „6140" inače izašao tek kad knjiženje padne.

**Šta OSTAJE:** ništa od gornjeg. Šifra vrste se **ne preimenuje** (program `USL` poznaje po imenu,
v. `DEFAULT_SERVICE_REVENUE_TYPE_CODE`) — pogrešna šifra se rešava novom vrstom + gašenjem stare;
to je svesna odluka, ne propust.

**Nije rešeno ni ovo (uže, tehničko):** avansni račun (`AVR`) za promet po vrsti `OTPAD` /
`USL-INO`. Danas AVR uvek računa porez iz bruta i ne gleda vrstu usluge; avans na promet gde PDV
obračunava kupac po zakonu ni ne nosi porez, pa bi ga trebalo ili zabraniti ili obraditi posebno.
Nije mereno da li se takav avans u praksi izdaje (u knjizi 2026 — nijedan).

### P11. Brojači dokumenata — ekran IZVEDEN, startni broj se upisuje ručno (05.08.2026)

**Šta je urađeno.** Podešavanja → **Brojači dokumenata** (odluka O-F11): red po seriji i godini sa
poslednjim izdatim brojem i **kako će izgledati sledeći broj** (`PROF-12/26`). Izmena kroz dijalog;
**dupli klik na broj** ga otvara (navika iz BigBita, doslovan zahtev vlasnika). Prazan registar se
prikazuje kao „još nije izdat nijedan broj" — na produkciji `document_number_sequences` ima **0
redova**, pa bi ekran građen iz baze bio prazna strana baš tamo gde se broj upisuje. Isto pravo kao
šifarnik vrsta usluge (`settings.accounting_rules`), isti trag izmene.

**Brana „broj već postoji u knjizi" je postavljena na OBA kraja:**

- **pri upisu startnog broja** — vrednost niža od najvećeg broja te serije u knjizi se odbija
  (hvata grešku u kucanju dok čovek gleda u ekran koji mu kaže tačan broj);
- **pri izdavanju broja** (`numbering.service.ts`, u istoj transakciji i pod istom bravom) —
  zauzet broj se **preskače** do granice od 50 koraka, pa se staje glasno. Odbijanje umesto
  preskoka bi bilo trajna blokada: rezervacija broja se poništava sa transakcijom, pa bi svaki
  sledeći pokušaj računao isti zauzet broj i ponovo padao.

🔴 **NALAZ IZ MERENJA (važno, umalo je promaklo):** `ledger_entries.document_number` NE drži samo
naše brojeve — na ulaznoj fakturi tu stoji **dobavljačev** broj. Izmereno na produkciji 05.08.2026
(22.258 stavki), brojevi oblika `N/26`: konto 435 (dobavljači) → najveći **14.630**, konto 270 (PDV
u ulaznim fakturama) → **138.030**, a konto 204 (kupci) → **261**, što je tačno naš niz. Da je brana
merila celu knjigu, ekran bi tražio startni broj 138.030 i **odbijao tačnu vrednost 261**. Zato se
meri samo klasa konta **20** („Potraživanja od kupaca"); sudar preko klasa je nemoguć jer se
otvorene stavke grupišu po `(konto, komitent, broj)`.

**Šta OSTAJE:** sam **upis startnih brojeva** za 2027. Ekran postoji, ali vrednosti unosi čovek pri
preuzimanju posla (01.04.2027) — to nije posao koji se može odraditi unapred, jer BigBit do tada
nastavlja da troši brojeve (tempo 23–49 mesečno).

---

### P12. ✅ IZVEDENO 06.08.2026 — `@Body()` DTO kao `import type` je ubijao tri rute

Ostavljeno u registru kao **zapis o razredu greške**, ne kao otvorena stavka.

Vlasnik je 05.08. prijavio da ne može da snimi podatke firme — `PUT /admin/firma` je vraćao
422 „Nijedno polje nije prosleđeno." Uzrok se iz izvora **nije video**: DTO je imao svih 19
polja, servis ih je sve obrađivao, ekran ih je sve slao. Kvar je bio u PREVODU — klasa uvezena
kroz `import type` u runtime-u ne postoji, pa `design:paramtypes` dobije `Function`,
`ValidationPipe` pozove `plainToInstance(Function, telo)` i vrati funkciju sa svim poljima
`undefined`.

Pogođene rute (sve tri izmerene u deployiranom izdanju): `PUT /admin/firma`,
`PUT /admin/firma/racuni/:id`, `PATCH /robno/documents/:id/shipping`. Ekran Firma je time bio
mrtav s kraja na kraj.

🔴 **Zašto nijedan test ovo nije uhvatio:** `ts-jest` za isti kod upiše `Object`, koji
`ValidationPipe` PRESKAČE — telo prođe netaknuto i sve „radi". Kvar postoji isključivo u
`tsc -p tsconfig.build.json`. Zato je brana **statička analiza izvora** (TS AST,
`backend/src/common/controller-body-dto.spec.ts`), a ne runtime test.

**OSTAJE (blaži, širi nalaz iz iste analize) — IZMERENO 06.08.2026:** `@Body()` čiji tip nije
klasa (interfejs, `unknown`, inline `{…}`) dobija `Object`, pa `ValidationPipe` proveru
**preskoči u celosti** — telo prolazi nevalidirano, i bez `whitelist`-a, tako da i nepoznata
polja stižu do servisa. Nije kvar u radu (telo prolazi), jeste rupa u proveri ulaza.

| ukupno `@Body()` parametara | telo se proverava (klasa) | telo NEVALIDIRANO |
|---|---|---|
| **523** | 359 | **164** (≈31 %) |

Najviše ih nose `zahtevi` (17), `robno` (12), `tech-processes` (12), `sales` (11),
`saldakonti` (9). 🔴 Najosetljiviji su u `auth`: **`LoginBody`, `SsoBody`,
`ChangePasswordBody`** — prijava i promena lozinke primaju telo koje niko ne proverava.

⚠️ **Zamka pri merenju, da se ne ponovi:** prva verzija je dala **264**, jer su tipovi uvezeni
kroz prostor imena (`D.OptIdempotentDto`, `import * as D`) prepoznati kao „nepoznati" iako su
klase — sam kadrovski kontroler je time lažno nosio 100 nalaza. Ime tipa se mora razrešiti i
posle tačke. Merenje: `backend/reports/meri-body.ts` (gitignorisano, ponovljivo).

**Predlog redosleda:** prvo `auth` (3 rute, spolja dostupne), pa moduli koji primaju iznose
(`saldakonti`, `sales`, `robno`); ostalo po potrebi.

---

### P13. ✅ IZVEDENO 06.08.2026 — devizni račun se unosi sa ekrana (bio ćorsokak)

Ekran Podešavanja → Firma je nudio **izmenu** deviznog računa, a `payment_accounts` na
produkciji ima **0 redova** i BigBit ne donosi nijedan; POST rute nije bilo. Poruka je upućivala
na „administratora baze". Istovremeno štampa izvozne fakture bez IBAN-a i SWIFT-a **odbija** da
se napravi. Papir se dakle nije mogao odštampati dok se račun ne unese, a račun se nije mogao
uneti.

Zabrana unosa je bila osnovana (nov red bi udario u BigBit-ov `id`), ali je rešenje u repou već
postojalo: tabela je sada u `NATIVE_ID_RANGE_TABLES`, nov red dobija `id >= 900.000.000` — isti
obrazac kao `items` i `customers`; full refresh briše samo `id < NATIVE_ID_BASE`.

**OSTAJE:** unos nije proban nad živim podacima — tabela je na produkciji i dalje prazna dok
vlasnik ne unese prvi račun.

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

### B4. ✅ ISPORUČENO 06.08.2026 — šest zahteva, svi verifikovani na produkciji

| zahtev | ko | šta | stanje |
|---|---|---|---|
| **073/26** | Duško | Servisni plan vozila prima **samo kilometražu** (`0`/prazno = ne vodi se po tome), i izmena može da skine već upisan interval — ranije je `undefined` ispadao iz `JSON.stringify` pa je dijalog lagao „Sačuvano". Tabela je u **sy15**. | READY_FOR_TEST |
| **074/26** | Miljan | Mejl nadoknade nosi **oba datuma** i ne zove više rad vikendom „izostankom"; uklonjena zabrana da nadoknada bude PRE odsustva (podnosilac potvrdio da se sati ponekad odrađuju unapred). sy15 fn primenjena, fajl za povratak uz nju. | READY_FOR_TEST |
| **076/26** | Strahinja | Trajanje operacije se kuca u **satima** (2 → 120 min), prima decimalni zarez. Baza ostaje u minutima. | READY_FOR_TEST |
| **077/26** | Jovica | „Otkucaj TP" više ne otvara tuđi nalog — v. C20 za pun opis i merenje. | READY_FOR_TEST |
| **079/26** | Strahinja | Broj crteža u kartici pozicije otvara PDF; gde ga nema (111 od 218), ostaje običan tekst. | **DONE** (potvrdio podnosilac) |
| **075/26** | Strahinja | Kaskadno pomeranje vezanih pozicija (F2 iz 046/26) — v. C22 za latentne rizike. Prevlačenjem se ceo lanac pomera za ISTI broj dana, razmaci se čuvaju, dug potez traži potvrdu uz pregled, posle upisa stoji „Poništi" 30 s. Završene pozicije se preskaču pri upisu ali se kroz njih PROLAZI. Tasteri strelica namerno ostaju bez kaskade. | READY_FOR_TEST |

🔴 **Pouke dana** (detalji u commit porukama):
- Kad korisnik traži da nešto **„piše"** — izmeri koliko mesta zaista ima. Prva verzija 069 stavila
  je reč u gant bar, a bar je na produkciji **median 10px** širok (28 od 32 ispod 20px).
- `post-deploy-verify.sh` pušten iz **primarnog direktorijuma** daje LAŽNO CRVENO (kopija je od pre
  gašenja 1.0) i traži `tr -d '\r'` jer worktree čekira CRLF.
- **Pročitaj komentare na zahtevu pre izrade, i ponovi upit ako padne.** Kod 074 je podnosilac
  odgovorio na sva pitanja, a upit nad `change_request_comments` pao je na nepostojećoj koloni
  (`created_by_user_id` NE POSTOJI u toj tabeli) — pa je prvi paket i dalje odbijao ono što je tražio.
- Tekst mejla dokaži tako što ga **proizvedeš**: poziv sy15 funkcije unutar `BEGIN … ROLLBACK` i
  čitanje reda iz `kadr_notification_log` — nijedan mejl ne ode, a tekst je dokazan.
- **`npm run lint` u backendu je `eslint --fix`** i prepiše ~250 nepovezanih fajlova.
- ✅ **Frontend konačno ima testove koji se pokreću** (`npm test`, `node --test` + alias hook, bez
  ijedne nove zavisnosti): 65 testova. Time pada deo nalaza iz C9 („nijedan FE test se ne pokreće").

### C17. Kiosk i plan mere „punu količinu" različito — druga polovina nalaza iz B2

Upisni kanon kioska broji **sve kvalitete**, a plan od 069/26 sudi po **dobrim**. Posledica:
radnik koji napravi 100 komada od kojih je 5 škart **neće biti pitan** da li je operacija gotova
(kiosk vidi punu količinu), operacija se zatvori, a plan istu poziciju prikaže kao **ŠKART**.

**Izmereno 05.08.2026:** **63 operacije** su danas u tom procepu (0 na gantu, 4 na otvorenim
RN-ovima) — mala živa izloženost, ali svaki budući škart pada u istu klasu.

**Odluka koja se traži od Nenada:** da li i kiosk da meri punu količinu po DOBRIM komadima. Ako
da, radnik bi u ovom slučaju dobio pitanje „Otkucao si 95 od 100. Da li je operacija gotova?" i
imao priliku da kaže „ne". Ako ne, plan ostaje jedini koji vidi manjak, a planer zakazuje
nadoknadu. **Kanon upisa je svesno odlučen 05.08. (B2), zato se NE menja bez reči.**

### C18. Groblje radnih naloga koji nikad nisu formalno zatvoreni

Usput izmereno pri radu na 069: od pozicija koje su stajale kao „gotovo" ispod plana,
**3.184 nije dirano više od godinu dana**, najstarija prijava je **08.09.2016.**, **2.199 nema
nijedan otkucan dobar komad**, a pogađaju **2.903 radna naloga** koji su formalno otvoreni.

To nije zaostali posao nego nasleđe — treba ga jednom zatvoriti kao **zasebnu čistku**
(SQL mutacija ide u zaseban fajl od pregleda, pravilo iz Napomena). Ne dirati usput.

### C19. „Urađeno" znači dve različite stvari na različitim ekranima

Posle 069/26 gant dijalog piše „Urađeno (dobri)" (samo `quality_type_id = 0`), dok
`ops-table.tsx` („Po mašini", „Po crtežu"), `tp-procedure-modal.tsx` i `why-bottleneck-modal.tsx`
i dalje zbrajaju SVE kvalitete pod istim imenom. **Izmereno: 88 operacija** gde se zbirovi
razlikuju (npr. `9000/84` op 40: 100/100 po starom, 66/100 dobrih, 34 škarta).

Gant dijalog sada prikazuje OBA broja jedan pored drugog, pa tamo nema zabune. Ostaje da se
ostali ekrani preimenuju u „Otkucano" ili prikažu `dobri/ukupno`. **Prioritet:**
`why-bottleneck-modal.tsx:165` — taj broj ide u AI prompt kao kontekst, pa AI objašnjava
kašnjenje pogrešnim brojem.

### C20. ✅ REŠENO 07.08.2026 — deep-link iz zvonca sada vodi negde

**Isporučeno** (grana `fix/deep-link-obavestenja-c20`, verify 🟢, rute potvrđene u CF chunk-u):
dodate rute za `quality_events` → `/kvalitet?tab=skart-dorada` i `app_switches` →
`/podesavanja?tab=integracije` (do sada klik nije radio ništa — 12 ljudi); `/montaza` i
`/odrzavanje` primili 077/26 obrazac; skok na Sastanke nosi `akcija` id; gard na modifikovan
klik u sidebaru; poruka kad rute nema. **CI sada pokreće frontend testove** pre build-a.

🔴 **Pouka 1 — kad popravka počne da vuče nove ekrane, suzi obim.** Grana je usput prebacila
`/zahtevi/detalj` na `useIdParam`, čime je dodala `popstate` tamo gde ga nije bilo. Sa linkom na
duplikat to znači da **dugme Nazad menja identitet zahteva U MESTU**, a dijalozi („Isporučeno",
„Odluka", nacrt) drže stanje prethodnog i šalju ŽIVI `detail.id` — dakle *polja jednog zahteva
upisuju se na drugi*, uz priloge i mejl pogrešnom podnosiocu. Ekran je **izbačen iz grane**
(dokaz: `git rev-parse HEAD:frontend/src/app/zahtevi` = isti hash kao main). Isti obrazac kao
vraćanje strelica u 075/26: jedna odluka o obimu obriše celu klasu nalaza jeftinije od pet popravki.

🔴 **Pouka 2 — frontend testove NIJE pokretao nijedan workflow.** `ci-backend` vrti `npx jest`, ali
za frontend je postojao samo deploy. Sve brane pisane u `frontend/src/lib/*.spec.ts` bile su
dekorativne. Korak je dodat u `deploy-frontend.yml` PRE build-a i **pao je dvaput**:
(a) runner **nema `npm` na hostu** — zato i build ide kroz `docker run node:22-bookworm-slim`;
(b) u kontejner treba montirati **`$GITHUB_WORKSPACE`**, ne `frontend/` — brana čita `backend/src`
preko `import.meta.dirname/../../..`. Dok je bio pokvaren, **blokirao je sve frontend deploye na
main-u**; kapija je pritom radila ispravno (staje PRE build-a, produkcija netaknuta).

**Ostaje otvoreno kao zaseban posao** (audit ih je našao, nisu deo C20 jer su van zvonca):
- `/zahtevi/detalj` — klik na „mogući duplikat" menja adresu a ostavlja stari zahtev. **Ispravan
  redosled je obrnut od očiglednog:** prvo dijalozi tog ekrana moraju da vežu stanje za identitet,
  pa tek onda reaktivan čitač `?id=`. Tu je i jedini preostali `?id=` ekran sa golim `Number()`
  (prima `0x10`, `1e3`, `+5`).
- `/robno/detalj` — „Otvori drugu stranu" i storno prenosa (sanirano u ovoj grani, ali vredi test).
- `/pracenje-proizvodnje` — `?akcija=` ulaz **nema čitaoca** na `/sastanci`.
- `DESIGN_SYSTEM.md` pravilo o `emitNavEvent` ne pominje svestan izuzetak na `/zahtevi/detalj`.

<details><summary>Merenje i uzrok (za istoriju)</summary>

Otkriveno pri radu na 077/26. Klik na obaveštenje gradi adresu tipa `/ekran?open=N`, ali
**Next App Router NAMERNO izostavlja query iz ključa za remount** — pa ako korisnik već stoji na
tom ekranu, parametar se tiho ignoriše. Zvonce se renderuje na **svakoj** strani, pa okida taj
slučaj redovno, a ne slučajno.

**Izmereno 06.08.2026** (`app_notifications`, poslednjih 30 dana):

| ruta | obaveštenja | ljudi | otvoreno | stanje |
|---|---|---|---|---|
| `work_orders` → `/work-orders?open=N` | 411 | 12 | **352** | ✅ POPRAVLJENO (077/26) |
| `montage_nonconformities` → `/montaza?id=N` | 12 | 12 | 10 | 🔴 isti kvar, NIJE dirano |
| `maint_machines` → `/odrzavanje?tab=masine` | 8 | 4 | 4 | 🔴 tab se ne prebaci ako si već tamo |
| `quality_events` | 12 | 12 | 9 | 🔴 **NEMA rute u mapi** — klik ne radi NIŠTA |
| `app_switches` | 1 | 1 | 0 | 🔴 nema rute |
| `handover_drafts` → `/nacrti` | 942 | 15 | 714 | ✓ nema parametra, nije pogođeno |
| `drawing_handovers` → `/handovers` | 12 | 4 | 12 | ✓ nema parametra |

Najgore je poslednje: `onActivate` (`components/ui-kit/app-shell.tsx:292-297`) kad nema rute samo
označi pročitanim i zatvori panel — **korisnik klikne i ne desi se ništa**. Pogađa 12 ljudi.

**Popravka je poznata i mala** — obrazac je već primenjen u 077/26 (`work-orders/page.tsx`):
čitač parametra koji reaguje na promenu adrese + „trošenje" parametra preko `history.replaceState`
(uzor `montaza/page.tsx:69-76`). Za `quality_events` i `app_switches` treba samo dopuniti
`NOTIFICATION_ROUTE`.

Isti obrazac (mount-only, bez `popstate`) potvrđen još u: `mob/sastanci/page.tsx:41` (bez ikakve
validacije ida), `zahtevi/detalj/page.tsx:70`, `mob/kadrovska/page.tsx:87`,
`handovers/_components/drafts-tab.tsx:1403`.

</details>

### C21. Primopredaja sa doradom uvek otvara ORIGINALNI nalog

Drugi, nezavisan put do „otvara mi drugi nalog" (nađen uz 077/26, NIJE popravljen):
`handovers.service.ts` `findHandoverWorkOrder` radi `findFirst(where: { drawingHandoverId },
orderBy: { id: 'asc' })`, a docstring to i priznaje („'original' = najmanji id"). Deca za
doradu/škart **nasleđuju** `drawingHandoverId` (`work-orders.service.ts:1762`; bulk-clone i
clone-variant ga izričito nuluju, dorada ne). Dakle primopredaja koja je ikad imala doradu uvek
razrešava na prvi, originalni nalog. Odluka: da li je to namerno (docstring kaže da jeste) ili
treba da vodi na najnoviji.

### C22. Kaskadno pomeranje (075/26) — tri latentna rizika koja NISU regresija

Zapisano iz završne verifikacije 06.08.2026; nijedno nije dostižno na današnjim podacima, ali
svako čeka prvog ko dirne modul.

**A. Bezbednost kaskadnog `UPDATE`-a je EMERGENTNA, ne strukturna.** Set-based `UPDATE` u
`shiftChain` **ne** zaključava po `(work_order_id, line_id)`; bezbedan je samo zato što
`lockOverlays` prethodno zaključa **nadskup**, a `chainHash` pokriva i `moved` i `skipped` pa
svaka promena članstva ide na 409. Ko god suzi pre-lock na `moved` ili izbaci `skipped` iz
hash-a — **tiho otvara deadlock.**

**B. `plan_proizvodnje_reassign_audit` je drugi cilj upisa UNUTAR petlje** `bulkReassign`-a
(O₁,A₁,O₂,A₂…), i nije pomenut u kanonu zaključavanja. Bez zastoja je danas samo zato što je
`cev` per-request `randomUUID()` **i** što su parovi sortirani. Nema test.

**C. `lockOverlays` se oslanja na to da PostgreSQL stavi `LockRows` iznad `Sort`** — to je
svojstvo PLANA, ne jezika. Tim je već jednom pao na toj klasi (`FOR UPDATE` nad rekurzivnim
CTE-om koji tiho ne zaključava ništa).

🔴 **Pouka o kanonu zaključavanja koja je koštala jedan pun krug:** prva popravka je dodala
`lockOverlays` (`SELECT … FOR UPDATE`) i izgledala je tačno — a bila je **bez dejstva za 217.490
od 217.732 parova**, jer zaključava samo redove KOJI POSTOJE, a ti pisci rade `upsert` koji je
najčešće INSERT. Pravo rešenje je **sortiranje parova po ključu pre petlje** (INSERT-i tada uzimaju
brave kanonskim redosledom). Test to nije uhvatio jer je mock uvek vraćao redove — **mock koji
uvek vraća podatke ne testira put upisa.**

### C23. 🔴 Ispad GitHub Actions-a ume da RAZIĐE frontend i backend na produkciji

06.08.2026 je Actions bio u `major_outage`. Posledica na isporuci 075/26: **frontend deploy je
prošao, backend je posle 51 minuta čekanja OTKAZAN.** Nastalo je stanje u kom je na produkciji
živ ekran koji zove rutu kojoj u kontejneru nema ni traga (mereno: `shift-chain` 1× u CF chunk-u,
**0×** u `dist`-u backenda) — svako prevlačenje vezanog bara vraćalo bi grešku.

**Zašto je važno:** dva deploy-a su nezavisna (Cloudflare vs. self-hosted runner), pa svaki
poremećaj koji pogodi samo jedan pravi razilaženje. Danas je razrešeno ponovnim pokretanjem
backend deploy-a preko API-ja (`POST /actions/runs/{id}/rerun`) čim se runner vratio na `online`.

🔴 **Pouka o dijagnozi:** runner se GitHub-u prijavljivao kao **`offline` I `busy` istovremeno** —
savršeno liči na zaglavljen servis i očigledan potez je restart. Restart bi bio POGREŠAN: dnevnik
(`_diag/Runner_*.log`) je pokazao da runner uredno radi i da **GitHub vraća HTTP 503**
(`upstream connect error … reset reason: overflow`), a `githubstatus.com` je to potvrdio.
**Pre restarta bilo čega — pročitaj dnevnik i proveri spoljni status.**

**Otvoreno:** vredi razmisliti o proveri koja posle svakog deploy-a uporedi da li su FE i BE sa
ISTOG commita, pa javi ako nisu.

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
- **Strahinja (069/26), pri potvrdi mu reći KONKRETNO — inače će reći „ništa se nije promenilo":**
  (1) njegov primer „prihvat 2 obrada" (RN `9400/6/74` op. 20) je **ručno štikliran**; klikom na
  „vrati na automatski" kvačica ostaje, a sistem je od sada sam drži (u celoj bazi ima samo 7
  ručnih override-a, oba DA se slažu sa novom automatikom — potez je bezbedan);
  (2) jedina vidljiva promena na njegovom gantu je **nestala kvačica** na RN `9400/2/492` op. 20
  („Dorada 400", plan 4 kom, **0 otkucanih komada**) — treba proveriti sa pogonom da li je
  urađena pa količina nije uneta; **306 pozicija** u bazi ima „Kraj rada" bez ijednog otkucanog
  komada, pa očekuj još ovakvih pitanja.
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

## K. KADROVSKA — ZAMRZNUTA do pune seobe na 3.0 (osnovano 06.08.2026)

### 🔴 K0. PRE BILO KOG RADA IZ OVOG ODELJKA: PROVERI STANJE NA `origin/main`

Sve niže je izmereno **06.08.2026 nad `origin/main`**. Kadrovska se menja gotovo svakodnevno
(samo u poslednjih nedelju dana: 063 zbirovi u gridu, 068 statusi zahteva, 074 nadoknada sa dva
datuma) — **ovi nalazi zastarevaju i moraju se ponovo izmeriti pre izvođenja.**

```bash
git fetch origin
git ls-tree -r --name-only origin/main -- frontend/src/app/kadrovska backend/src/modules/kadrovska
git show origin/main:<putanja>        # NIKAD čitati iz primarnog stabla — nosi tuđu granu
```

**Dve zamke koje su se već desile pri ovoj analizi:**

1. **Odsustvo u radnoj kopiji NIJE dokaz da nešto ne postoji.** Primarno stablo je 06.08. stajalo
   **393 commita iza** `origin/main` i bez 47 migracija. Svako „toga nema" mora biti provereno
   kroz `git show origin/main:`.
2. 🔴 **Ni komentar u kodu nije dokaz.** Prva verzija ove analize je tvrdila da backend pretražuje
   zaposlene **samo po `full_name`** — to je pisalo u komentaru u `zaposleni-tab.tsx`.
   **Komentar je zastareo:** `kadrovska.service.ts` (`employees()`) odavno pretražuje po **osam
   polja** (`full_name, position, email, phone_work, department, sub_department_name, team, note`).
   Da nije provereno, naručio bi se posao koji je već urađen. **Tvrdnja iz komentara se proverava
   u implementaciji.**

---

### K1. ODLUKA (Nenad, 06.08.2026): prvo puna seoba na 3.0, pa tek onda sve ostalo 🔴

**Ništa se na Kadrovskoj ne radi dok modul ne bude u celini na 3.0 bazi** — ni dorade, ni
popravke. Cilj je da posao ne ode u sy15, jer sve što ode tamo mora da se piše dvaput.

**Razlog:** Kadrovska danas **ne živi u glavnoj bazi**. `KadrovskaService` čita i piše u sy15
kroz `@prisma-sy15/client`; sopstvena doktrina servisa to kaže izričito: *„Podaci žive u sy15 (1.0)
bazi (doktrina §A.1)"*. Glavna (3.0) baza se u tom servisu koristi **isključivo** za odluku o
permisiji pozivaoca, nikad za HR podatke. Prava presuđuje sy15 RLS kroz `withUserRls`.

Znači: svaka izmena napisana danas piše se nad **sy15 objektima** (SECURITY DEFINER funkcije, RLS
politike, kanonski view-ovi), i pri seobi se prevodi ponovo. **To je dupli posao i ne radimo ga.**

**Šta ovo NIJE:** nije otkazivanje. Ništa iz K3/K4 se ne briše — sve čeka red. Ovo je odluka o
**redosledu**, ne o obimu.

**Šta ovo obuhvata:** sve UX i funkcionalne dorade (karton zaposlenog, lanac razvoja, statusi
meseca sati, verzionisanje ugovora, virtuelizacija grida, reorganizacija navigacije, filter
nepravilnosti, klikabilne brojke, lažne nule, latinica…).

🔴 **NEMA IZUZETAKA — ni za greške tačnosti.** Na izričito pitanje da li C12–C14 (mesta gde
sistem daje pogrešan rezultat) smeju ranije, odgovor Nenada 06.08.2026. je: **sve čeka 3.0, da
ne bude sy15.** Vidi K5.

**Jedino što se sme raditi:** unos poslovnog sadržaja koji **ne traži nijedan red koda** —
K4.7 (onboarding/offboarding šabloni). To rade HR i rukovodioci kroz postojeći ekran.

---

### K2. Gde Kadrovska stoji u redu za seobu (izmereno 03.–06.08.2026)

Izvor: [PLAN_GASENJA_SY15_2026-08-03.md](PLAN_GASENJA_SY15_2026-08-03.md), revizija 2 od 05.08.

| Korak | Domen | Stanje na 06.08.2026 |
|---|---|---|
| 0 | mapa identiteta (60 naloga, 67 FK ka `auth.users`) | preduslov SVAKOG koraka; „sat posla", nije urađeno |
| 1 | sastanci (74 fn / 27 tabela / 1.120 redova) | u toku — grana `feat/sy15-seoba-sastanci-pb`; ostaje ~61 DEFINER fn (4–6 dana) + enqueue (1–2 dana) |
| 2 | održavanje (41 fn, 34 tabele + 34 trigera, 2,4 MB + 469 MB fajlova) | počelo — grana `feat/sy15-seoba-odrzavanje` (lokalni worktree, još nije na remote-u) |
| 3 | reversi + lokacije zajedno (~49 fn) | pripremljeno — grana `feat/sy15-seoba-reversi`; dopisuje se `loc` deo |
| **4** | **KADROVSKA (58 fn, „najosetljivije")** | **nije počelo — plan izričito kaže „Tek posle tri uvežbana kruga"** |
| 4b | projektni biro (32 fn) | **blokiran korakom 4** — `pb_current_employee_id()` traži `employees`/`departments`/`job_positions` u 3.0 bazi |
| 5 | SCADA + bridge preusmeravanje | poslednji pisac; kad on pređe, sy15 se gasi |
| 6 | „ostalo" (`ai_chat_*`, `assessment_*`, arhive, GoTrue) | uključuje `assessment_*` (~15 fn) — **to je 360° ocenjivanje, deo Kadrovske po korisničkom osećaju, a po planu ide tek u koraku 6** |

**Obim koraka 4:** 58 funkcija + `employee-docs` (24 MB, poverljivo) + `attendance_events`
(140 MB — pre seobe utvrditi šta te kolone stvarno nose). Domen u sy15 = 18 tabela / 8,0 MB.
Za širinu korisničke površine v. [MODULE_SPEC_kadrovska_30.md](../backend/docs/design/MODULE_SPEC_kadrovska_30.md)
(snimak 13.07: ~49 tabela, 119 fn, 141 RLS politika, ~20 trigera, 9 pg_cron poslova, 4 edge fn,
1 privatni storage bucket, 15 tabova u 5 hub-grupa).

⚠️ **Kadrovska nosi i ograničenje iz incidenta 06.08:** *„JEDAN PREKIDAČ = JEDAN DOMEN."*
Zajednički prekidač `SASTANCI_PB_IZVOR` je oborio ceo Projektni biro u 503. Pre uvođenja prekidača
za kadrovsku **izmeriti šta sve taj prekidač dodiruje** — npr. `rev_api_idempotency` je registar
cele aplikacije i **476 od 643 reda su kadrovska**.

**Rok:** plan **nema kalendar** za korake 2–4. Postoje procene u danima samo za ostatak koraka 1 i
za deo koraka 3. **Ne izmišljati datum** — govoriti „tri uvežbana kruga daleko".

---

### K3. NIJE nedostatak — VEĆ POSTOJI na `main` (da se ne naruči dvaput)

Spoljna UX analiza (ChatGPT, 06.08.) je označila niz stvari kao „nedostaje". Provera nad
`origin/main` je pokazala da **postoje i rade**. Zapisano da niko ne potroši dan na već urađeno.

| Tvrdnja „nedostaje" | Stvarno stanje na `main` |
|---|---|
| Radni sati: zamrznuti ime i zaglavlje | **postoji** — `grid-table.tsx` ima `sticky` zaglavlje + #, ime, Vrsta i Σ kolonu (uvedeno zahtevom 063/26) |
| Radni sati: zaključavanje meseca | **postoji** — `grid-tab.tsx`, `locked` + traka „Mesec je zaključan — obračun zarada je isplaćen" |
| Radni sati: uvoz sa kapije gazi ručne izmene | **ne gazi** — „Popuni iz kapije" preskače popunjene dane i vraća broj `skipped` |
| Radni sati: jedna izmena osvežava celu tabelu | **ne osvežava** — `GridTable` i `EmployeeBlock` su `memo`, izmene žive u `useRef` sa revizionim brojačem **po zaposlenom** |
| Prisustvo je sirov listing događaja | **nije** — podrazumevani prikaz je **po zaposlenom** (imenik ⨝ `v_attendance_now`, status badž, filteri Prisutan/Pauza/Odsutan); sirovi feed je sekundaran, ispod |
| Prisustvo: nema poređenja sa gridom | **postoji** — pogledi „Poređenje sa gridom" (shadow) i „Za potvrdu" (kontrola) |
| Onboarding nema šablone | **ima ceo mehanizam** — `useOnboardingTemplates`, `NewTemplateModal`, pokretanje toka iz šablona, zadaci `done/skipped`, progres %. **Fali SADRŽAJ, ne kod** (v. K4.7) |
| Zarade nemaju tok statusa | **imaju** — `draft → advance_paid → finalized → paid`, otključavanje uz potvrdu i audit trag, + triger nepromenljivosti na bazi |
| Nema kartona zaposlenog | **postoji dvoje:** `dossier.tsx` (modal: osnovno, PII sekcije, ugovori, lekarski, sertifikati, dokumenta, audit) i **`/profil` sa 20 sekcija** |
| Nema menadžerskog uvida u tuđe zaposlene | **postoji** — `/profil` → **„Moj tim"** radi drill-down po članu: GO linija, trenutno/sledeće odsustvo, zaduženja alata, karnet PDF, korekcija kucanja, opis pozicije. Iza prava `profile.team`, endpoint `GET /v1/profile/team` |
| Klik na red u listi zaposlenih ne otvara karton | **otvara** — red otvara `DosijeDialog` |
| Pregled nema prioritizaciju obaveza | **ima** — „Šta čeka mene" nosi rok-pilule (Isteklo / Danas / Sutra / za N d) sa tonovima i deep-link na tab |
| Pregled prikazuje nule dok učitava | **ne prikazuje** — `pregled-tab.tsx` ima skeleton (`Skel`) i `—` za `null`. **Ostatak modula prikazuje** (v. K4.1) |
| Backend pretražuje samo `full_name` | **osam polja** — v. K0 zamku 2 |
| Pretraga po JMBG-u ne postoji | **filter „Bez JMBG" postoji** i bezbedan je; puna pretraga po JMBG-u je izvodljiva ali nosi zamku — v. K6.1 |

**Zaključak K3:** dijagnoza „modul deluje kao 15 ekrana, ne kao sistem" je tačna. **Inventar
nedostataka nije** — otprilike trećina tvrdnji opisuje postojeće funkcije. Spoljne UX analize
Kadrovske se **ne smeju uzimati kao radni nalog bez provere nad `main`.**

---

### K4. STVARNI nedostaci — backlog POSLE seobe (K1)

Redosled je predlog, ne obaveza. Prve tri su najjeftinije i nezavisne od šeme, pa mogu u jedan
paket čim seoba prođe.

**K4.1. Lažne nule u celom modulu (osim Pregleda).** `SummaryChips` (`_components/common.tsx`)
nema stanje učitavanja — vrednosti se računaju iz `?? 0`, pa svaki tab na trenutak pokaže nule
kao da su podatak. **Jedna izmena u jednom fajlu pokriva ceo modul** (uvesti `loading`/`error`
stanje, skeleton umesto `0`).

**K4.2. Brojke na Pregledu nisu klikabilne.** `KpiCard` je `<article>`, ne dugme. Pravilo već
postoji u modulu — zahtev 068/26 je uveo `onClick` na `SummaryChips` sa obrazloženjem *„brojka
koja se vidi mora i da se otvori"*. Pregled je jedino mesto koje je van tog pravila. Mapiranje:
aktivni → zaposleni · odsutni danas → odsutni · GO/nadoknada/plaćeno → odgovarajući inbox ·
**grid popunjenost → K4.4 (zavisnost: bez K4.4 ta jedna kartica nema cilj).**

**K4.3. Ćirilica na ekranu.** `common.tsx` → `CYR_MONTHS` / `cyrMonthLabel()` daje „август", i
`grid-tab.tsx` to prikazuje pored birača meseca. ⚠️ **Nije prosta zamena:** isti `monthLabel` ide
i u Karnet PDF, Istoriju meseca i Primedbe, a HR dokumenta su **namerno ćirilična** (MODULE_SPEC:
„HR generatori PDF, puna ćirilica"). Rešenje = razdvojiti `screenMonthLabel` (latinica) od
`documentMonthLabel` (ćirilica).

**K4.4. „Prikaži samo nepravilnosti" u radnim satima.** Funkcionalno najvrednija stavka cele
analize i jedina za koju grid nema nikakav pandan. Prva verzija se može napraviti **bez novih
polja**, iz onoga što grid već ima: prazan regularan dan, odstupanje kapija↔grid (shadow već to
računa), nema izlaza, ručna korekcija, neuobičajeno velik/mali broj sati, rad vikendom/praznikom,
teren bez predmeta (grid to već boji trouglom). **Najkorisnije dugme na tom ekranu nije „Osveži"
nego „Prikaži nepravilnosti".**

**K4.5. Performanse grida — MERITI PRE NEGO ŠTO SE IŠTA PIŠE.** Procena (nije mereno u
pregledaču): ~150 zaposlenih × **5 redova po zaposlenom** (Redovni / Prekov. / Teren / 2 maš. /
Σ isplata) × 31 dan ≈ **23.000 ćelija, većina sa `<input>`**.
- Skupa strana kucanja je **već rešena** (memo + rev po zaposlenom, v. K3) → ostaje samo cena
  montiranja i skrola.
- ⚠️ **Blok zaposlenog nosi `rowSpan={5}`** → **nijedan gotov virtualizer redova to ne ume**;
  mora se pisati prozorenje po bloku zaposlenog, ručno. To je prepisivanje tabele, ne dodavanje
  biblioteke.
- Jeftinija provera prva: grid već filtrira po odeljenju. Ako HR ionako radi jedno po jedno
  odeljenje, DOM je desetina i virtuelizacija možda uopšte ne treba.
- **Ne spajati sa drugim UX izmenama u isti PR** (rizik regresije unosa/fokusa/prečica).

**K4.6. Sitni nedostaci liste zaposlenih i odmora.** Nema izbora kolona (`DataTable` nema picker)
ni sačuvanih pogleda. Saldo odmora koristi ikonice `⚙ 🛫 📜 📄` umesto `⋯` menija — a `DataTable`
**već ima `rowActions` sa `⋯`**, samo se tu ne koristi. Odmori se otvaraju na „Stanje (saldo)"
umesto na inbox — badževi `Zahtevi (N)` / `Za odobravanje (N)` već postoje; ⚠️ prebacivanje sme
**samo pri prvom učitavanju**, jer brojke stižu asinhrono iz skriveno montiranih podtabova i
kasnije prebacivanje bi menjalo ekran korisniku pod rukom.

**K4.7. Onboarding/offboarding šabloni — SADRŽAJ, ne kod. Izvan zamrzavanja.** Mehanizam radi,
ali `templates.length === 0` → prazno stanje. Unose HR i rukovodioci, bez programera:
- *Standardni onboarding:* ugovor i prijava · lekarski pregled · nalog i email · pristupi
  aplikacijama · zaštitna i radna oprema · zaduženja · upoznavanje sa procedurama · mentor ·
  obuka za radno mesto · kontrola posle 7, 30 i 90 dana.
- *Standardni offboarding:* dokumentacija o prestanku · odjava pristupa · povraćaj opreme ·
  razduženje · neiskorišćen godišnji odmor · završni obračun · izlazni razgovor.

**K4.8. Menadžerski karton zaposlenog — proširenje `/profil`, NE nova gradnja.** Cilj: HR/šef
otvori jednog čoveka i vidi sve. Mehanizam postoji (K3: „Moj tim"), fali **opseg i širina**:
danas vidi samo rukovodilac za svoj tim i samo deo sekcija. Opseg po sloju: vlasnik/admin sve ·
HR dozvoljene zaposlene i sekcije (**bez PII i bez zarada — to je pravilo firme, ne propust**) ·
rukovodilac svoje ljude · zaposleni sebe. Svaka sekcija nosi svoj scope.
⚠️ **Ovo je jedina stavka za koju vredi proveriti da li joj treba CELA seoba** — možda joj je
dovoljno da `employees` / `departments` / `job_positions` pređu u 3.0 (isti uslov koji čeka
Projektni biro, korak 4b). Proveriti pri planiranju koraka 4, ne sada.

**K4.9. Lanac razvoja.** `360° procena → razgovor → cilj → razvojni plan → kontrolni datum →
rezultat`. Delovi postoje (`razvoj-tab` sa procenama/planovima/razgovorima; `/profil` ima ocene i
razgovore), veza ne postoji. Traži nova polja → **strogo posle seobe.** ⚠️ `assessment_*` po planu
gašenja ide tek u **koraku 6**, ne sa kadrovskom — dakle ovo čeka duže od ostatka modula.
Jedina sitnica koja ne čeka ništa: **obavezan naziv 360° kampanje** (danas mogu bez naziva).

**K4.10. Navigacija — NE dirati na osnovu utiska.** Stanje: sidebar nosi 5 podstavki (`?grupa=`),
a strana crta **istu** traku od 5 grupa — realna duplikacija. Ali hub + grupe su **presuđena
odluka** (paritet 1.0 `KADR_GROUPS`, PODMENIJI F2 §6.4), a 13 tabova ne staje u jednu traku.
⚠️ **Predlog „meriti korišćenje pa odlučiti" nije izvodljiv** — u aplikaciji **ne postoji
telemetrija korišćenja**; `/session-analytics` meri proizvodne radne sesije operatera, ne UI.
Za firmu ove veličine odluka se donosi **razgovorom sa ljudima koji Kadrovsku koriste svaki dan**,
ne merenjem. Najjeftiniji potez ako se ide: ukloniti HUB kao podrazumevani ulaz (da `/kadrovska`
otvara Pregled), grupnu traku zadržati → 5 nivoa postaje 3.

**K4.11. Ugovori — „čeka potpis" NIJE moguće danas.** Chips (Ukupno / Aktivni / Ističu <30d /
Istekli / Neaktivni) i arhiva postoje. Ali `contract-generate.tsx` izričito kaže:
*„Potpisivanje je svojeručno, van sistema"* — dakle nema stanja potpisa koje bi se pratilo, ni
osnove za verzionisanje potpisanog dokumenta. **Pre koda treba poslovna i pravna odluka:
prati li se potpis uopšte.** Trivijalno i bez odluke: pragovi 7/30/60 dana umesto samo <30.

---

### K5. Greške tačnosti C12–C14 — ODLUKA: i one čekaju 3.0 🔴

C12, C13, C14 (v. odeljak C) i dalje stoje. To **nisu dorade** — to su mesta gde sistem daje
pogrešan rezultat, pa je 06.08.2026. izričito pitano da li smeju ranije.

> **ODLUKA (Nenad, 06.08.2026): NE. Sve čeka 3.0, da ne bude sy15.** Bez izuzetka, i za greške.

**Cena te odluke, da bude zapisana i da niko ne bude iznenađen:**
- **C12** — do koraka 4 šef i dalje može da odbije zahtev koji je sam prosledio. Od 04.08. je to
  na jedan klik, jer se zahtev konačno vidi u listi.
- **C13** — brojka na badžu i sadržaj tabele ostaju u neskladu. Danas se ne pali (svi zahtevi su
  2026), pali se prvim zahtevom iz druge godine.
- **C14** — uzrok se **neće ni dijagnostikovati** dok se ne uvede trag. Ako se ponovi, jedini
  izvor ostaje log backenda u tom minutu.

| | Šta je | Gde živi | Zašto nije obično „popravi" |
|---|---|---|---|
**Zatečeno stanje, da se pri koraku 4 ne istražuje iznova:**

| | Šta je | Gde živi | Napomena za izvođenje |
|---|---|---|---|
| C12 | šef može da odbije zahtev koji je sam prosledio | **sy15 RPC** `makeup_reject` (poziva ga `kadrovska-mutations.service.ts`) | **Nije samo bug nego i otvorena odluka** — registar ga vodi kao *„Odluka Nenadu: zaključati i odbijanje kao odobravanje?"*. **To pitanje ostaje otvoreno i mora se odgovoriti pre nego što se piše kod**, nezavisno od seobe. `makeup_approve` već ima proveru „prvi nivo nisam ja" — obrazac postoji, samo nije primenjen na odbijanje |
| C13 | badž broji sve godine, tabela prikazuje jednu | FE (kadrovske liste zahteva) | Jedina od tri koja **ne dira sy15** — kad brana padne, ide prva jer se sigurno ne radi dvaput. Glasno upozorenje kad godina skriva zahteve je već dodato; trajno rešenje nije |
| C14 | prelaz „šef odobrio" 31.07. nema trag obaveštenja | `queueBestEffort` guta greške | **Uzrok NIJE dokazan** — vodi se kao merenje, ne kao kvar. Ispravna akcija je *instrumentacija* (evidentirati primaoca, vreme i ishod slanja), ne „popravka". Obeležiti kao dijagnostiku da niko ne prijavi „rešeno" kad se samo upalilo svetlo |

---

### K6. Zamke za izvođenje (kad dođe red)

**K6.1. JMBG u pretrazi je bezbedan SAMO kroz `v_employees_safe`.** U tom view-u je `personal_id`
za ne-PII pozivaoca **uvek `NULL`** (maskiran) — zato `ILIKE` prosto ne pogađa i nema curenja.
To je isti razlog zbog kog čip „Bez JMBG" bezbedno preteruje umesto da curi.
🔴 **Zabrana:** ako neko kasnije „popravi" to što HR-u pretraga po JMBG-u ne radi tako što spoji
osnovnu tabelu `employees` — **probija PII masku koju cela arhitektura čuva** (HR NAMERNO nema
PII; PII = admin ∨ poslovni_admin).

**K6.2. Nikad `this.sy15.db` za HR čitanje.** Konekciona rola `servosync2_app` je **BYPASSRLS**.
Svaki HR read mora kroz `Sy15Service.withUserRls` — inače pada PII maska i zarade. Ovo piše u
doktrini servisa; ponavlja se ovde jer je najskuplja moguća greška u modulu.

**K6.3. Zarade i PII ostaju zatvoreni i posle seobe.** `kadrovska.salary` = allowlist (Nenad +
Nevena); HR nema ni zarade ni PII. Pri seobi se **preslikava**, ne „pojednostavljuje".
Presedan: 30.07. je popravka curenja plata bila **nepotpuna** — plate su i dalje curile kroz
6 `SECURITY DEFINER` RPC-ova i kroz ugovor-PDF u storage-u; zatvoreno tek 04.08. Pri seobi
proveriti **svaki** put do plate, ne samo tabelu.

**K6.4. Sadržaj analize koja je pokrenula ovaj odeljak** je u istoriji razgovora od 06.08.2026.
Ako zatreba ponovo, **ne pokretati je iznova nad ekranom** — počinje od `main`, kako kaže K0.

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
