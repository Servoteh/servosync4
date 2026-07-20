# Analiza i predlog: F4 — Kooperacija (praćenje proizvodnje)

> **STATUS (19.07.2026, Nenad): IZVOĐENJE ODLOŽENO ZA 4.0** — modul se gradi zajedno sa 4.0
> talasom (koji ide paralelno na `feat/4.0-faza1`); ova analiza je pripremljena podloga.
> **Presuđeno odmah:** K1 = tri nivoa vezivanja stavke (RN + operacija opciono + sklop-koren) ✅;
> K2 = auto-razlaganje sklopa u stavke + ručni override ✅; K3 = vrsta na zaglavlju dokumenta +
> `vrsta` na auto-koop RJ grupi ✅. **K4–K8 čekaju 4.0** (K4 kooperant-registar se prirodno
> rešava kad 4.0 preuzme komitente od BigBit-a). F1 tabele `koop_otpremnice`/`koop_otpremnica_stavke`
> ostaju u šemi neaktivne do tada; izmene sheme po K1–K3 uraditi na početku izvođenja.
>
> **Šta je ovaj dokument:** analiza kako se kooperacija (slanje delova napolje na galvansku,
> termičku i mašinsku uslugu) danas vodi u sistemu i **predlog** kako da izgleda F4 modul —
> tabela pored praćenja + otpremnica koja se kuca kroz aplikaciju. Vezuje se na plan
> `docs/PLAN_PRACENJE_PROIZVODNJE_2026-07.md` (zahtev korisnika §4 #13, faza **F4**, odluka **O6**).
>
> **Ključni pojmovi (da se čita bez tehničkog žargona):**
> - **RN** = radni nalog = jedna pozicija/deo u proizvodnji (jedan crtež + količina). U bazi red u tabeli `work_orders`.
> - **Operacija RN-a** = jedan korak u tehnološkom postupku tog RN-a (npr. „struganje", „galvanizacija", „međufazna kontrola"). U bazi red u `work_order_operations`.
> - **Radni centar (RC) / radna jedinica (RJ)** = mašina/odeljenje na kome se operacija radi. Kooperantska stanica (galvanika, kaljenje) je takođe RC.
> - **TP (tehnološki postupak)** = redosled operacija kroz koje deo prolazi.
> - **Sklop** = RN sastavljen od više dečjih RN-ova (komponenti), veza u `work_order_components`.
> - **Otpremnica** = papir koji ide uz robu kad se šalje kooperantu; danas se kuca u Word-u ručno.

---

## 1. Stvarno stanje (sa dokazima)

### 1.1 Kako je kooperacija „obeležena u tehnologiji"

**Nema polja „kooperacija" u šifarniku operacija.** Šifarnik `operations` (`backend/prisma/schema.prisma:1372-1389`) ima samo 4 flag polja: `withoutProcess`, `significantForFinishing`, `usesPriority`, `isSkippable` (potvrđeno i u `backend/docs/MODUL_TEHNOLOGIJA.md:2162-2163` „Četiri flag polja operacije"). **Ne postoji `is_cooperation` ni sličan marker.** Isto važi za rutu RN-a (`work_order_operations`, `schema.prisma:1670-1699`) i za tehnološki postupak (`tech_processes`, `schema.prisma:1713-1747`).

Zato se „kooperacija u tehnologiji" prepoznaje na **dva posredna načina**:

**(a) Kooperacija = obična operacija u TP-u čiji je radni centar kooperantska stanica.** Kad tehnolog na screenshot-u vidi „OPERACIJA 1 — Kooperacija — 0/6000", to je:
- „OPERACIJA 1" = redni broj operacije (`work_order_operations.operationNumber`),
- „Kooperacija" = naziv radnog centra te operacije (`operations.workCenterName`, slobodan tekst do 50 znakova),
- „0/6000" = urađeno/plan komada.

Dakle to je **jedan red u ruti RN-a** kome je radni centar galvanika/termička/mašinska usluga. **Ovo je slučaj „samo jedna operacija na kooperaciji"** — deo ode na tu operaciju, vrati se i nastavi kroz preostale operacije istog RN-a.

**(b) Auto-prepoznavanje po radnoj jedinici (jedino mesto gde kod već „zna" da je nešto kooperacija).** U lancu view-ova Plana proizvodnje (`backend/docs/design/authz-snapshots/talasC-fn-defs-2026-07-12.sql`, telo `v_production_operations`):
- operacija ima mašinu → mašina ima radnu jedinicu (`bigtehn_machines_cache.rj_code`, JOIN na `:4329`),
- ako je ta radna jedinica upisana u admin-listu `production_auto_cooperation_groups` (`JOIN … g.rj_group_code = m.rj_code`, `:4330`), operacija je **auto-kooperacija**: `is_cooperation_auto = (g.rj_group_code IS NOT NULL)` (`:4292`).

**Ključno: grupisanje je po RADNOJ JEDINICI, ne po imenu RC-a i ne po flagu.** Admin stavi celu radnu jedinicu (npr. galvaniku) na listu i sve operacije čije mašine spadaju u nju postaju kooperacija. Lista ima svega **3 reda** danas (`backend/docs/design/MODULE_SPEC_planovi_pracenje_30.md:71`). Detekcija je **po operaciji (po liniji)**, ne po celom RN-u.

**Dopunski trag — „površinska zaštita":** operacije površinske zaštite (galvanika/plastifikacija) idu na radne centre sa `no_procedure = true`; praćenje ih filtrira preko `no_procedure IS TRUE AND NOT is_final_control` (`backend/src/modules/pracenje/pracenje-read.service.ts:1550-1551`, komentar „galvanika/plastifikacija" `:713-714`). To je još jedan posredan pokazatelj eksterne obrade, ali opet nije eksplicitan koop-marker.

**Legacy QBigTehn TP takođe nema koop-oznaku.** Grep `kooperac|spolja|ekstern|podugovar` po migracionim rekonstrukcijama (`05-qbigtehn-sqlserver-logic.md`, `08-…vba-domain-map.md`, `11-bb-tehnologija-uputstvo.md`, `16-gap…`) = 0 pogodaka. U legacy-ju je kooperantska operacija samo još jedan RC u ruti; status se računa iz komada urađenih vs lansiranih.

> **Zaključak §1.1:** kooperacija u tehnologiji = **operacija (linija)** prepoznata po klasi radnog centra, ne polje na delu. Ne postoji nijedan boolean marker; jedini automatizam je po radnoj jedinici (3 reda u listi).

### 1.2 Šta Plan proizvodnje (1.0/3.0) VEĆ radi sa kooperacijom

Kooperacija danas nije dokument — nego **planerski filter**: oznaka „ova operacija se ne radi kod nas, ide napolje" → operacija **nestaje iz redova mašina** i pojavljuje se u zasebnom tabu „Kooperacija". To je jedini efekat.

Dva izvora oznake (`cooperation_source`):
1. **AUTO** — operacija čija radna jedinica je u `production_auto_cooperation_groups` (§1.1b).
2. **MANUAL** — planer ručno označi operaciju: `production_overlays.cooperation_status` po paru **(work_order_id, line_id)** = po konkretnoj operaciji RN-a. Polja overlay-a: `cooperation_status`, `cooperation_partner`, `cooperation_set_by`, `cooperation_set_at`, `cooperation_expected_return` (`talasC-…sql:4287-4291`).

Efektivni flag = `auto OR manual` (`is_cooperation_effective`, `:4294`). Statusi (`kooperacija-tab.tsx:24-32`): `external` → „Eksterno", `external_in_progress` → „U kooperaciji", `external_done` → „Vraćeno". **Bez količine, bez dokumenta, bez kilaže.**

Šta korisnik danas može (uzak skup):
- **Ručno pošalji operaciju** sa partnerom i očekivanim rokom (`plan-proizvodnje.service.ts:611-627`, modal „kooperacija (partner/rok)").
- **„Skini manual"** = skini samo ručni flag (partner je slobodan tekst; auto se ne može skinuti ovde — samo admin kroz lookup listu) (`kooperacija-tab.tsx:66-68, 144-146`).
- **Admin CRUD auto-grupa** — dodaj / soft-remove / restore, **bez pravog brisanja** (`plan-proizvodnje.service.ts:773-815`; permisija `plan_proizvodnje.koop_admin`).

Efekat na plan: kanon otvorene operacije traži `is_cooperation_effective IS FALSE` da bi operacija bila u redovima mašina (`plan-proizvodnje.service.ts:60-63`); tab „Kooperacija" invertuje na `TRUE`. Dakle flag **skida operaciju iz reda mašina** — i to je razlog zašto F4 ne sme da vodi paralelnu istinu koja se s ovim tuče (v. §3.4).

**Praćenje proizvodnje ovo danas uopšte ne dodiruje** (`MODULE_SPEC_planovi_pracenje_30.md:97-99`). Kooperacija je čisto planerska stvar.

Šta postojeći tok **NE pokriva** (a docx #13 traži): otpremnicu-dokument, 3 eksplicitne vrste kao polje, količine (poslato/vraćeno), kilažu, tip presvlake, jedinstven broj, delimično vraćanje, auto-vraćeno posle međufazne kontrole, registar kooperanata (partner je slobodan tekst).

### 1.3 Šta BigBit dokumenti kažu o otpremnici

- **Ne postoji zaseban „Otpremnica" izveštaj.** Legacy štampa otpremnicu kao **istu šemu kao fakturu, samo bez cena i sa drugim naslovom** (`backend/docs/migration/20-bigbit-stampani-dokumenti-katalog.md:37` „nema `Otpremnica - DEFAULT` → fallback: `Faktura - DEFAULT` sa naslovom `Otpremnica`"; `:122-123`).
- Realni skelet = report `OtpremnicaBezCena` (`_legacy/…/OnLine_BigBit_Design/OtpremnicaBezCena.txt`). Polja: broj = **prefiks + redni broj** (`:488`), datum (`:188`), primalac naziv/mesto/adresa/PIB/MB (`:206-503`), stavke R.br./naziv/j.m./količina/kat.br./barkod (`:401-664`), tri potpisna bloka **„Robu primio" / „Robu izdao" / „Preuzeo za prevoz"** (`:888/908/928`), „Strana X od Y" (`:735`).
- **Nijedan legacy obrazac ne nosi kilažu, tip presvlake ni jedinstven broj** — to su kooperacijske dopune korisnika (docx #13). „Word uzor" iz zahteva je **korisnikov ručno kucan Word dokument, ne sačuvani šablon** — u `docs/zahtevi/` ima samo 2 docx-a, nijedan nije šablon otpremnice; u `_legacy` nema nijednog `.dot/.dotx`.
- **BigBit kooperaciju NE vodi robno.** Robni sloj poznaje samo magacin↔magacin i prodaju (`39-robno-inventory-kalkulacija.md:7-9, 73`; kretanje robe je „carry-over" prepisivanje dokumenta, `27-prepisivanje-dokumenata-carry-over.md:8-36`). Nema tipa dokumenta „otprema na uslugu". **Zaključak: F4 otpremnica je ispravno zaseban, aplikacijski dokument van robnog ledgera** — F1 tabele su na pravom mestu.

**Postojeći 3.0 obrasci za štampu (uzor za PDF):** `backend/src/modules/work-orders/work-order-print.service.ts` — pdfmake stack (`PdfService.render`, `BarcodeService.code128Svg`, logo, A4, info-tabela, tabela stavki sa praznom „Kontrola" kolonom za potpis, „strana X/Y"). **To je tačan uzor za otpremnicu.** Postoje i 2 presedana za numeraciju (advisory-lock + numerički MAX, ne string-sort): `handovers/draft-numbering.service.ts` (`G-{yymmdd}-{seq}`) i `work-orders/work-order-numbering.service.ts` (`{predmet}/{redni}`).

### 1.4 Šta je F1 već napravio (as-built, NEUPOTREBLJENO)

Tabele postoje u šemi i migraciji, **ali nema nijednog servisa/kontrolera/DTO/frontenda** (grep `koop_otpremnic*` vraća samo `schema.prisma`, plan i `migration.sql`). Stoje prazne — **slobodno se menja shema.**

**`koop_otpremnice`** (zaglavlje, `schema.prisma:2402-2425`):

| kolona | tip | značenje |
|---|---|---|
| `customer_id` | Int (meki ref → `customers`) | kooperant |
| `vrsta` | VarChar(20) | `galvanska` \| `termicka` \| `masinska` |
| `broj` | VarChar(50) | broj otpremnice — **bez unique, bez generatora** |
| `datum_slanja` | Date | |
| `kilaza_kg` | Decimal(12,3)? | ukupna kilaža pošiljke |
| `napomena` | text? | |
| `status` | VarChar(20) | `poslato` \| `delimicno_vraceno` \| `vraceno` |

**`koop_otpremnica_stavke`** (stavka, `schema.prisma:2431-2448`):

| kolona | tip | značenje |
|---|---|---|
| `otpremnica_id` | Int FK (CASCADE) | zaglavlje |
| `work_order_id` | **Int** (meki ref → `work_orders`) | RN/pozicija — **jedini radni ref** |
| `drawing_number` | VarChar(100)? | broj crteža |
| `naziv_pozicije` | VarChar(250)? | |
| `kolicina` | Int | poslato |
| `vraceno_kolicina` | Int (def 0) | vraćeno |
| `tip_presvlake` | VarChar(100)? | |
| `jedinstven_broj` | VarChar(100)? | |
| `napomena` | text? | |
| `returned_at` | Timestamptz? | |

**Tri glavna gapa as-built šeme** (rešavaju se u §2):
1. **Stavka zna samo RN, ne i operaciju** → ne može da razlikuje „samo jedna operacija (galvanizacija) je otišla" od „ceo deo je otišao". Ovo je direktno Nenadovo pitanje.
2. **`broj` nema jedinstvenost ni generator.**
3. **`customer_id → customers`** je sumnjiv: kooperanti (galvanizeri, termičari) su **dobavljači**, možda nisu u `customers` kešu; partner u Planu proizvodnje je slobodan tekst — dve nekonzistentne evidencije.

---

## 2. Model podataka — odgovor na Nenadova pitanja

### 2.1 Šta se vezuje za RN, šta za deo, kako se razdvaja „samo jedna operacija"

Iz koda (§1) jasno sledi terminologija:
- **„Deo" = „pozicija" = RN = jedan red u `work_orders`** (poslovni identitet `project_id + ident_number + variant`, `schema.prisma:1493-1496`). Nema posebne tabele „deo".
- **„Sklop"** = RN koji u `work_order_components` ima dečje RN-ove (komponente).
- **„Operacija"** = jedan korak rute tog RN-a (`work_order_operations`, jedinstven `operationNumber` po RN-u).

Postojeća kooperacija (Plan proizvodnje) vezuje se za **operaciju** (`production_overlays` po `work_order_id + line_id`) i za **radnu jedinicu** (auto-grupe). Nikad za „deo kao celinu sa praćenom pošiljkom". F4 dokument treba da doda upravo taj nedostajući nivo, ali tako da **ne izgubi vezu na operaciju**.

### 2.2 Predlog: TRI nivoa vezivanja na jednoj stavci

Stavka otpremnice uvek nosi RN; opciono nosi i operaciju; a „ceo sklop" se izražava time što se pod jednu otpremnicu stavi više stavki (koren + komponente). Predlog konačnog oblika `koop_otpremnica_stavke`:

```
koop_otpremnica_stavke
  id
  otpremnica_id            FK → koop_otpremnice (CASCADE)          // zaglavlje
  work_order_id            Int  (meki ref → work_orders)  NOT NULL // NIVO 1: uvek — koji deo/RN
  work_order_operation_id  Int? (meki ref → work_order_operations) // NIVO 2: koja operacija (v. dole)
  operation_number         Int?                                    // ogledalo op. broja (stabilno i ako se ruta menja)
  scope                    VarChar(12)  // 'operacija' | 'ceo_deo' | 'sklop_koren'   (NIVO 3, v. 2.3)
  parent_stavka_id         Int? (self-ref)  // komponente sklopa pokazuju na koren-stavku
  -- denormalizacija za dokument (snapshot u trenutku slanja):
  drawing_number           VarChar(100)?
  naziv_pozicije           VarChar(250)?
  tip_presvlake            VarChar(100)?
  jedinstven_broj          VarChar(100)?
  kolicina                 Int          // poslato
  vraceno_kolicina         Int  def 0   // vraćeno (delimično)
  kilaza_kg                Decimal(12,3)?   // NOVO: kilaža po stavci (docx traži kilažu u tabeli)
  napomena                 text?
  returned_at              Timestamptz?
  return_trigger_operation_id  Int?     // koja MK/operacija vraća ovu stavku (za O6, v. §3.3)
```

**Tri nivoa, konkretno:**

- **NIVO 1 — `work_order_id` (uvek):** odgovara na „koji deo je otišao". Ovo je minimum; sve stavke ga imaju.

- **NIVO 2 — `work_order_operation_id` / `operation_number`:**
  - **`NULL`** = **ceo deo ide napolje** (nije vezano za jednu operaciju — npr. deo se u celini kali ili plastificira kao krajnja obrada). Status `scope = 'ceo_deo'`.
  - **popunjeno** = **samo ta jedna operacija ide na kooperaciju** (npr. samo galvanizacija; posle povratka deo nastavlja kroz preostale operacije istog RN-a). Status `scope = 'operacija'`. Ovo je tačan izraz Nenadovog slučaja „samo jedna operacija na kooperaciji" i most ka postojećem `production_overlays.line_id`.
  - `operation_number` (ogledalo) se čuva zato što je stabilan i čitljiv na papiru čak i ako se linija rute kasnije prenumeriše.

- **NIVO 3 — ceo sklop (`scope = 'sklop_koren'` + auto-širenje komponenti):** kad ceo sklop ide napolje, korisnik bira sklop-RN; sistem predloži **jednu stavku za koren** (`scope='sklop_koren'`, `work_order_id` = sklop) i **po jednu stavku za svaku komponentu** iz `work_order_components` (svaka `scope='ceo_deo'`, `parent_stavka_id` → koren-stavka). Time se „ceo sklop" izražava kao stablo stavki pod jednom otpremnicom, a povratak i količine se prate po komponenti. (Ako korisnik ne želi razlaganje, može ostati samo koren-stavka — odluka K4.)

> **Zašto ne poseban tip dokumenta za sklop:** i „deo" i „sklop" su `work_orders` redovi na različitom nivou stabla. Jedna otpremnica sa više stavki prirodno pokriva oba; ne treba drugačija tabela.

### 2.3 Odakle predlog „šta ide na koju vrstu kooperacije"

Vrsta (galvanska/termička/mašinska) se **ne kuca naslepo** — izvodi se iz tehnologije:
- za RN se pogleda ruta (`work_order_operations`); operacije čiji radni centar je (a) u auto-koop grupi ili (b) `no_procedure = true` (površinska) su **kandidati za kooperaciju**;
- radna jedinica / naziv radnog centra te operacije mapira se na vrstu: galvanika → `galvanska`, termička/kaljenje → `termicka`, mašinska usluga → `masinska`;
- taj kandidat se ponudi korisniku pri kreiranju otpremnice (§3.1), sa predlogom vrste i `work_order_operation_id`.

Da bi mapiranje bilo pouzdano (a ne „pogađanje po imenu"), preporučuje se da **auto-koop grupa nosi vrstu** (v. odluka K3): dodati `production_auto_cooperation_groups.vrsta`. Tada je predlog vrste deterministički i vezan za tehnologiju, umesto na slobodan tekst naziva RC-a.

### 2.4 Gde živi „vrsta" — dokument ili stavka?

- **Preporuka: vrsta ostaje na ZAGLAVLJU (`koop_otpremnice.vrsta`)**, jer jedan kooperant = jedna vrsta usluge = jedna pošiljka (galvanizeru se ne šalje mašinska usluga). Otpremnica je „jedna vožnja kod jednog kooperanta".
- Ako se u praksi dešava da jedna pošiljka nosi mešane vrste, alternativa je vrsta po stavci — ali to komplikuje i papir i status. **Predlog: vrsta na zaglavlju; ako zatreba mešano → napraviti dve otpremnice.** (Odluka K3.)

---

## 3. Tokovi

### 3.1 Kreiranje otpremnice

1. Korisnik u praćenju otvori „Nova otpremnica", izabere **kooperanta** i **vrstu** (galvanska/termička/mašinska).
2. **Predlog stavki iz tehnologije:** sistem ponudi RN-ove/operacije koje su kandidat za tu vrstu (§2.3) — za tekući predmet/RN prikaže operacije čiji je radni centar te vrste, sa predpopunjenim crtežom, nazivom, količinom (plan) i `work_order_operation_id`. Korisnik čekira šta zaista šalje i koriguje količine.
3. **Ručno dodavanje:** korisnik može dodati bilo koji RN ručno (slučaj „ceo deo" ili „ceo sklop"): bira RN; za sklop se ponudi auto-razlaganje na komponente (§2.2 nivo 3).
4. Popuni se kilaža (po stavci i/ili ukupno), tip presvlake, jedinstven broj, napomena.
5. Snimanjem se dodeli **broj otpremnice** (§3.2) i status `poslato`. Opciono (odluka K6) postavi se `cooperation_status` overlay na odgovarajuće operacije da izađu iz reda mašina.

Denormalizacija (crtež, naziv, tip presvlake, kilaža) se **snapshot-uje pri snimanju** — dokument mora biti nepromenljiv i kad se matični podaci kasnije promene.

### 3.2 Štampa PDF + numeracija

- **Novi servis `KoopOtpremnicaPrintService.buildPdf(id)`**, klon `work-order-print.service.ts` (pdfmake): logo + naslov „OTPREMNICA — KOOPERACIJA" + broj + **Code128 barkod broja** (za skeniranje pri prijemu/vraćanju). Info-blok: kooperant (naziv/adresa/PIB/MB — snapshot ili razrešeno iz `customers`), vrsta, datum slanja, ukupna kilaža, napomena. Tabela stavki: R.br. / RN / crtež / naziv / količina / tip presvlake / jedinstven broj / kilaža / napomena. Podnožje: **3 prazna potpisna bloka „Robu izdao / Robu primio / Preuzeo za prevoz"** (paritet legacy `OtpremnicaBezCena.txt:888-928`) + „strana X/Y". Fajl `KOOP-OTP-{broj}.pdf`.
- **Numeracija:** dodati `@@unique` na `broj` + `KoopOtpremnicaNumberingService` po obrascu `draft-numbering.service.ts` (advisory-lock u transakciji, numerički MAX). **Predlog formata: `KOOP-{yyyy}-{NNNN}`** (npr. `KOOP-2026-0007`, paritet nabavke `0007/2026` iz `24-nabavka-tok-rekonstrukcija.md:22`). Zadržati ručni override (korisnik danas kuca svoje brojeve) — odluka K7.

### 3.3 Vraćanje (O6 — auto na međufaznu kontrolu, delimično)

Odluka O6 (plan `:178-180`) je već presuđena: **prvo kucanje međufazne kontrole (MK) za taj RN posle datuma slanja** označava vraćeno + datum; količina sa kucanja puni „vraćeno kom" (delimično = delimično vraćeno); ručna korekcija uvek moguća.

**Detektor MK je zaseban** — postojeći kanon završne kontrole **namerno isključuje** MK: `_pracenje_line_is_final_control` (`talasC-…sql:313-326`) i `finalControlSql` (`pracenje-read.service.ts:1411-1418`) hvataju samo ZAVRŠNU (`significant_for_finishing` / RC „8.3" / KK). MK se prepoznaje heuristikom: naziv radnog centra sadrži „kontrol" **I** `significant_for_finishing = false` (`tech-processes.service.ts:3500-3524`, komentar bukvalno „npr. 8.4 Međufazna Kontrola"). O6 hook je **nov upit**, ne reuse završne kontrole.

**Tačan okidač po nivou vezivanja** (zato je NIVO 2 bitan):

| nivo stavke | šta okida vraćanje |
|---|---|
| `scope='operacija'` (poznat `work_order_operation_id = K`) | prvo kucanje **MK koja u ruti dolazi posle operacije K** za taj RN, posle `datum_slanja`. Najpreciznije — puni se tačno ta stavka. `return_trigger_operation_id` fiksira koja MK. |
| `scope='ceo_deo'` (operacija = NULL) | prvo kucanje **bilo koje MK tog RN-a** posle `datum_slanja` (nema konkretne operacije za pozicioniranje). |
| `scope='sklop_koren'` | ne okida se na koren direktno; okidaju se **komponente** (svaka po svom RN-u kao „ceo_deo"); status korena = rollup komponenti. |

Pri okidanju: `returned_at = now`, `vraceno_kolicina += kucana količina` (delimično!). Zatim **rollup statusa zaglavlja**: `poslato` (0 vraćeno) / `delimicno_vraceno` (0 < zbir < poslato) / `vraceno` (sve vraćeno) — trigger ili servisni izračun iz zbira stavki (danas ništa to ne radi). Ako je postavljen koop overlay (K6), po povratku se čisti.

### 3.4 Veza sa postojećim tabom „Kooperacija" u Planu proizvodnje (bez dupliranja)

To su **dve različite brige** — ne spajati u jednu tabelu, ali povezati:
- **Plan proizvodnje koop = planiranje** („ne zakazuj ovu operaciju na našim mašinama"). Ostaje na `production_overlays` / auto-grupama. Per-operacija, prolazno stanje, hrani filter mašinskog plana.
- **F4 otpremnica = logistika/dokument** (fizička pošiljka: količina, kilaža, presvlaka, povratak). Nove tabele, per RN/pozicija, u Praćenju.

**Eksplicitan predlog izvora istine:**
- **Za „da li je operacija u redu mašina": izvor je Plan proizvodnje overlay** (kao danas). F4 ne dira taj mehanizam.
- **Za „šta je fizički poslato/vraćeno i po kojoj količini": izvor je F4 otpremnica-stavka.**
- **Most (jedan smer, da se ne unosi na dva mesta):** kreiranje F4 stavke za operaciju **opciono postavi** manual koop flag na tu operaciju (`cooperation_status='external_in_progress'`, `cooperation_partner` = kooperant iz otpremnice), a O6 auto-vraćeno ga **očisti**. Auto-koop grupe (`production_auto_cooperation_groups`) ostaju izvor za predlog vrste i kandidata (§2.3). Time: planer i dalje vidi tačno stanje reda mašina, a Praćenje je autoritet za dokument i količine — **bez dva ručna unosa**. (Da/ne = odluka K6.)

---

## 4. Otvorene odluke K1–K8 (za Nenada)

> Format kao O1–O8 iz plana §6. Uz svaku — preporuka.

**K1 — Vezivanje stavke za operaciju (tri nivoa).**
Dodati `work_order_operation_id` + `operation_number` + `scope` na stavku, da se razlikuje „samo jedna operacija" od „ceo deo" od „sklop".
→ **Preporuka: DA** (bez ovoga F4 ne ume da odgovori na tvoje pitanje „samo jedna operacija vs ceo sklop", a O6 ne može precizno da vrati). Ovo je najvažnija izmena šeme.

**K2 — Razlaganje sklopa na komponente.**
Kad ceo sklop ide napolje, da li otpremnica auto-generiše stavke za sve komponente iz sastavnice, ili ostaje jedna stavka „sklop"?
→ **Preporuka: auto-razloži, ali dozvoli korisniku da obriše/spoji stavke.** Razlaganje je nužno da bi se kilaža i povratak pratili po komadu; jedna zbirna stavka gubi tu granularnost.

**K3 — Gde živi „vrsta" i odakle predlog.**
Vrsta na zaglavlju otpremnice (jedan kooperant = jedna vrsta) + dodati `vrsta` na `production_auto_cooperation_groups` da predlog bude deterministički?
→ **Preporuka: vrsta na zaglavlju; dodati vrstu na auto-grupu.** Mešane vrste u jednoj pošiljci → dve otpremnice.

**K4 — Kooperant: `customers` keš ili novi registar?**
`customer_id → customers` je sumnjiv (kooperanti su dobavljači, možda nisu u kešu); Plan proizvodnje vodi partnera kao slobodan tekst.
→ **Preporuka: proveriti da li su kooperanti u `customers`; ako nisu — mali app-owned registar `kooperanti` (naziv, adresa, PIB, MB) + snapshot na otpremnicu** radi pravne nepromenljivosti dokumenta. Ujednačiti sa slobodnim tekstom iz Plana proizvodnje (jedan registar).

**K5 — Kilaža po stavci ili samo na zaglavlju.**
Docx traži kilažu „u tabeli pored praćenja" (po stavci); as-built je ima samo na zaglavlju.
→ **Preporuka: dodati `kilaza_kg` i na stavku** (zaglavlje = zbir/override). Merenje je po poziciji.

**K6 — Most ka Planu proizvodnje (auto set/clear koop overlay).**
Da kreiranje F4 stavke za operaciju automatski skida tu operaciju iz reda mašina (postavi `cooperation_status`), a O6 vraćanje da vraća?
→ **Preporuka: DA** (inače planer vidi operaciju u redu mašina dok Praćenje kaže „poslato" — direktan sudar). Ako ne, onda jasno razgraničiti da su to dve nezavisne evidencije i prihvatiti dvostruki unos.

**K7 — Numeracija otpremnice.**
Auto-broj `KOOP-{yyyy}-{NNNN}` (advisory-lock) + ručni override, ili čisto ručni broj?
→ **Preporuka: auto-generisan + `@@unique`, uz mogućnost override-a.** Bez unique i generatora rizik od duplih/kolidirajućih brojeva.

**K8 — Snapshot kooperanta na dokument.**
Da otpremnica pri štampi „zamrzne" naziv/adresu/PIB/MB kooperanta (dokument je pravno-praktičan papir), ili uvek razrešava iz matičnog (koji se menja)?
→ **Preporuka: snapshot na zaglavlju u trenutku slanja.** Dokument koji ode kooperantu ne sme da se menja kad se matični podatak kasnije ažurira.

---

## 5. Procena faza gradnje

F4 je nezavisno od F3 (plan `:162`), zavisi samo od F1 (koji je gotov i živ na produ). Predlog razlaganja na isporučive potfaze:

| Potfaza | Sadržaj | Zavisi od | Napomena |
|---|---|---|---|
| **F4a — shema + CRUD** | Migracija šeme po §2 (operacija-ref, scope, kilaža po stavci, numeracija, unique, opciono registar kooperanata K4). Servis/kontroler/DTO za `koop_otpremnice`/`stavke` (create/read/update, RLS, audit). Bez UI. | F1 | Manje; obrazac postoji (mutacioni sloj praćenja). Presudi K1/K3/K4/K5/K7 pre početka. |
| **F4b — predlog stavki iz tehnologije** | Upit koji za predmet/RN nudi kandidat-operacije po vrsti (§2.3) + auto-razlaganje sklopa (§2.2 nivo 3). | F4a | Srce „pametnog" unosa; koristi auto-koop grupe + `no_procedure`. Presudi K2. |
| **F4c — ekran pored praćenja** | Tabela otpremnica + forma za kreiranje (predlog + ručno dodavanje), kolone iz docx #13 (kooperant, RN, crtež, datum slanja, količina, tip presvlake, naziv, jedinstven broj, napomena, kilaža, vraćeno+datum). Freeze kolona (paritet F3 #5). | F4b | Najveći FE deo. |
| **F4d — štampa PDF** | `KoopOtpremnicaPrintService` (§3.2), barkod, 3 potpisna bloka, numeracija. | F4a | Klon `work-order-print.service.ts`. |
| **F4e — auto-vraćeno (O6) + rollup statusa** | Hook na kucanje MK (§3.3), delimične količine, rollup statusa zaglavlja, ručna korekcija. Opciono most ka Planu proizvodnje (K6). | F4a + detektor MK | Zavisi od zasebnog MK-detektora; testirati na živim kucanjima. |

**Redosled preporuke:** presudi K1–K8 → F4a (shema/CRUD) → F4d (štampa, brzo daje vrednost — otpremnica se kuca i štampa) → F4b (predlog) → F4c (pun ekran) → F4e (auto-vraćeno). Štampa (F4d) pre pametnog predloga (F4b) jer korisnik odmah dobija „kucam otpremnicu kroz app umesto Word-a" — glavni zahtev iz docx-a.

---

## Sažetak ključnih nalaza

1. **Kooperacija NIJE polje u šifarniku operacija.** Prepoznaje se posredno: (a) kao operacija u ruti čiji je radni centar kooperantska stanica („samo jedna operacija na kooperaciji"), (b) auto po radnoj jedinici iz admin-liste `production_auto_cooperation_groups` (3 reda). Nema boolean markera; legacy QBigTehn ga takođe nema.
2. **Plan proizvodnje već ima kooperaciju — ali kao planerski filter, ne dokument.** Vezuje se za **operaciju** (`production_overlays` po `work_order_id + line_id`) i skida je iz reda mašina. Bez količine, kilaže, otpremnice, delimičnog vraćanja. Praćenje to danas ne dodiruje.
3. **BigBit nema zaseban otpremnica-dokument** (štampa fakturu bez cena) i **ne vodi kooperaciju robno.** Nema Word šablona kao fajla — „uzor" je korisnikov ručni Word. F1 tabele su ispravno zaseban aplikacijski dokument.
4. **F1 tabele postoje ali su prazne i nekorišćene** — slobodno se menja shema. Tri gapa: stavka zna samo RN (ne operaciju), `broj` bez jedinstvenosti/generatora, kooperant vezan za sumnjiv `customers` keš.
5. **Odgovor na Nenadovo ključno pitanje:** predlog TRI nivoa vezivanja na stavci — `work_order_id` (uvek), `work_order_operation_id`/`scope` (`NULL`+`ceo_deo` = ceo deo napolje; popunjeno+`operacija` = samo ta operacija; `sklop_koren` + auto-razložene komponente = ceo sklop). Vrsta se predlaže iz tehnologije (auto-koop grupa + površinski RC), a živi na zaglavlju.
6. **O6 auto-vraćeno traži NOV detektor međufazne kontrole** (postojeći kanon namerno hvata samo završnu). Okidač zavisi od nivoa vezivanja — najpreciznije za `scope='operacija'`.
7. **Izvor istine, bez dupliranja:** red mašina = Plan proizvodnje overlay (nedirano); poslato/vraćeno/količina = F4 otpremnica; opcioni jednosmerni most (K6) da se ne unosi na dva mesta.

## Spisak odluka za Nenada

- **K1** — vezati stavku i za operaciju (tri nivoa: RN uvek + operacija + sklop). → **DA** (najvažnije).
- **K2** — auto-razložiti sklop na komponente (uz mogućnost ručne korekcije). → **DA, sa override.**
- **K3** — vrsta na zaglavlju + dodati `vrsta` na auto-koop grupu za predlog. → **DA.**
- **K4** — kooperant: `customers` keš ili novi registar `kooperanti`? → **proveriti keš; verovatno novi registar + snapshot.**
- **K5** — kilaža i po stavci (ne samo zaglavlje). → **DA.**
- **K6** — most: F4 stavka postavlja/čisti koop overlay Plana proizvodnje. → **DA** (izbegava sudar).
- **K7** — auto-numeracija `KOOP-{yyyy}-{NNNN}` + unique + override. → **DA.**
- **K8** — snapshot kooperanta (naziv/PIB/MB) na dokument. → **DA.**

*(Sve K-odluke su otvorene i blokiraju F4a dok se ne presude — isti obrazac kao O1–O8.)*
