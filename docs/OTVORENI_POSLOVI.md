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

### B2. Kanon „kraj procesa na delu količine" 🔴 NAJVAŽNIJE
**Status: čeka odluku Nenada + potvrdu Strahinje/Negovana (pitanje postavljeno u zahtevu 046,
komentar od 04.08.).** Zahtevi: **064/26** (Strahinja), **046/26** (isto pitanje).

**Problem u jednoj rečenici.** Kiosk dugme **„Kraj rada"** upisuje se kao *„operacija je
završena"*, a radnici ga koriste kao *„gotov sam za danas"*.

**Trenutno pravilo (kanon):** operacija je završena ako **bilo koji** red u `tech_processes`
ima `is_process_finished = true` — `bool_or(is_process_finished)`, bez obzira na broj komada.

**Dokaz (izmereno 04.08., Strahinjin primer):** WO **45246**, RN **9400/6/74**, crtež
**1119578**, plan **1 komad**, operacija **20** (OBRADA NA ZAVRŠNE MERE, mašina 3.33).
Radnik **Jakov Neđić** (worker 113) zatvorio je operaciju **dva puta sa 0 komada** kroz kiosk
(POST STOP-WORK, audit 28408 i 30698): 03.08. 12:32→**14:00** i 04.08. 05:19→**14:00** —
oba puta kraj smene. Sutradan ujutru je **istu operaciju ponovo startovao**.

🔴 **Sistem sam sebi protivreči:** upisna strana (FIX A, odluka Nenad 15.07.,
`backend/src/modules/tech-processes/tech-processes.service.ts:4427-4460`) *namerno dozvoljava*
ponovno otvaranje zatvorene operacije — dakle pisanje kaže „nastavlja se", a čitanje kaže „gotovo".

**Razmere (prod, 04.08.):**
| | Operacija | Naloga |
|---|---|---|
| „Završeno" a količina nepotpuna | 1.475 | 781 |
| od toga očigledno u radu (RN otvoren, nije kroz završnu kontrolu) | **1.039** | **420** |
| od toga sa **0** otkucanih komada | 311 | — |
| operacija sa radom NASTAVLJENIM posle „kraja procesa" (otvoreni RN) | 597 od 1.084 | — |
| aktivne u poslednjih 14 dana | 92 | — |
| trenutno otvoreno (za poređenje) | 16.006 | 4.192 |

**Šta je VEĆ urađeno (04.08., odluka Nenad — zaobilaznica „opcija A"):** picker „Dodaj stavke na
plan" **pušta** delimično-završene uz oznaku „završeno na X/Y kom — dodaje se svejedno"
(`frontend/src/app/plan-proizvodnje/_components/gant-dodaj-dialog.tsx`, funkcija `stanjeStavke`).
FE-only, kanon netaknut. **Ograničenje:** te operacije i dalje **ne postoje u listi „Po mašini"**.

**Preporučeni redosled izvođenja (3 koraka):**

**Korak 1 — kiosk: razdvojiti dugmad (PRVO ovo).**
„Prekid — nastavljam kasnije" (ne diže `is_process_finished`) i „Gotovo — operacija završena"
(diže). Bez ovoga promena pravila samo prevodi problem u drugu kolonu. Traži i objašnjenje
radnicima (pogonska mera). Fajl: kiosk tok u `backend/src/modules/tech-processes/` (POST
stop-work) + kiosk FE.

**Korak 2 — promena kanona.** „Završena" = kraj procesa **I** kumulativ otkucanih ≥ plan
(poravnanje sa upisnom stranom / FIX A).
Cena, izmereno: **1.039 operacija** se vraća u sve otvorene liste (16.006 → ~17.045, **+6,5%**);
**206 od 4.519** danas „spremnih" operacija **gubi spremnost** (prethodna operacija zapravo nije
gotova) → menja sortiranje i bucket-e planerima i pogonu.
**Potrošači koje treba poravnati u istom potezu:**
- `backend/src/modules/plan-proizvodnje/plan-proizvodnje-read.service.ts` — `OPEN_OPS` (:53),
  `tr` (:841), `rc` (:830), `prev_blk` (:860)
- `backend/src/modules/cnc-programs/cnc-programs.service.ts:152` (CAM-done — verovatno neutralno)
- `loc-tp-feed` šalje sirove redove u sy15 keš → **1.0 ekrani divergiraju** dok se i tamo ne
  poravna (planirati zajedno)
- `pracenje-read.service.ts` — **NIJE pogođen** (koristi piece-sum agregate)

**Korak 3 — „Odustani" (dismiss) truje kanon.** Dugme uvedeno 17.07. zatvara red sa
`is_process_finished = true` **bez komada** → `bool_or` proglasi celu operaciju završenom.
Danas: 3 operacije „završene" isključivo dismiss redovima (1 sa 0 kom). Popravlja se istom
izmenom kao korak 2.

**Preporuka:** ići sva tri koraka, redom 1 → 2 → 3. Korak 2 dira ekrane koje koriste i planeri i
pogon, pa ne kretati bez izričitog „kreni" i bez potvrde Strahinje/Negovana da razdvajanje
dugmadi odgovara načinu rada.

---

## C. TEHNIČKI FOLLOW-UP (nalazi verifikatora, po prioritetu)

### C1. Nišan gejt se ne pali u Chrome-u na Androidu ⚠️
Popravka „promašaj ~2 cm" (04.08., `frontend/src/lib/barcode-decoder.ts`,
`shouldLimitScanToReticle()`) gejtovana je na UA `SM-A16x/SM-A17x`. **Chrome na Androidu od v110
šalje redukovan UA** (`Linux; Android 10; K`) → model se ne vidi → gejt se tiho ne aktivira i
bag ostaje. Radi u **Samsung Internetu** (UA zadržava model) i verovatno u APK WebView-u.
**Uraditi:** dopuniti profil kroz `navigator.userAgentData.getHighEntropyValues(['model'])`
(lokacije `scan-overlay.tsx:139` već čita `userAgentData`), async rezultat keširati **pre**
`attach`-a. Do tada teren pokriva prekidač `sessionStorage.ss3_scan_roi_gate = 'on'` (i `'off'`
kao kill-switch). **A26/S26/iPhone moraju ostati van gejta** (Nenadov tvrd uslov, 04.08.).

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

---

## D. ČEKA KORISNIKE (ne blokira razvoj)

- **Nenad:** proba nišana na **A16 sutra** (05.08.) — obavezno u **Samsung Internetu** (vidi C1);
  proba stonog (wedge) čitača u „Premesti stavku" — 04.08. je isporučeno rastavljanje skena
  u obe aplikacije; proba štampe barkoda 62.65 × 13 mm.
- **Strahinja + Negovan:** odgovor na pitanje o „kraju procesa na delu količine" (B2).
- **Podnosioci:** potvrde na zahtevima u statusu „Spreman za test" (dugme „✔ Potvrđujem — radi").

---

## Napomene za rad (naučeno 04.08.)

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
