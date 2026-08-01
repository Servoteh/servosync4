# ServoSync — preostale faze (stanje 2026-07-13)

> Šta je urađeno zaključno sa danas i **šta konkretno ostaje** do 4.0. Autoritativni
> plan verzija ostaje [ROADMAP.md](ROADMAP.md); ovaj dokument je „operativni TODO" —
> radne linije koje su u toku, sa jasnim gate-ovima. Detalji BigBit sync-a:
> [migration/BB_T_26_ANALIZA_I_PLAN.md](migration/BB_T_26_ANALIZA_I_PLAN.md).

---

# 🔶 OTVORENO NA DAN 01.08.2026

> Sve što je te sesije **započeto a nije dovršeno**, ili čeka nečiju odluku. Deo ispod je
> noviji od svega u nastavku dokumenta. Stavke sa 🔴 **blokiraju** dalji rad na svojoj liniji.

## A. Čeka odluku vlasnika

| # | pitanje | zašto ne može bez odluke |
|---|---|---|
| 🔴 A1 | **Avansni račun se sudara sa avansima dobavljača.** Ulazni avansi dobavljača upisuju se u **istu** tabelu `invoices`, sa istom vrstom `AVR` i **ručno kucanim** brojem (`pdv/advance-vat.service.ts:531-588`). Pošto naš AVR po odluci O-F1 sada izgleda `1/26` — tačno kao broj koji srpski dobavljači kucaju — moguć je sudar. | Ishod je ili 409 legitimnom dobavljačevom dokumentu, ili neuhvaćen P2002 koji obara izdavanje našeg avansa. Rešenje traži izmenu šeme (zasebna vrsta dokumenta ili stvaran `companyId`). |
| 🔴 A2 | **„Preuzeo za prevoz" nosi `MB: 20748346`** na IFR/IFGP, a to je matični broj **kupca** (naš je 17400169). | Ili je BigBit bag, ili greška u prepisu papira. Mi zasad štampamo naš broj. Traži pogled u originalni papir. |
| 🔴 A3 | **Ino faktura ima dva različita podatka o plaćanju** — gore `Payment terms: virmanom`, dole `Način plaćanja: avansno`. BigBit je imao dve kolone, 4.0 ima jedno polje `Invoice.paymentMethod`. | Dok se druga kolona ne uvede, oba mesta na papiru nose istu vrednost — jedino mesto gde naš izlaz sadržinski odstupa od originala. |
| A4 | **1.0 ekran „Podešavanja → Predmeti" prelazi u režim „samo za gledanje"** kad aktivacija bude živela u app bazi (Faza 2). | Bez toga bi dva sistema pisala isti podatak. |

## B. Štampa faktura — otvoreno iz gap-analize

Puna lista je u [STAMPA_FAKTURA_GAP.md](STAMPA_FAKTURA_GAP.md) §5; presuđeno je u
[STAMPA_FAKTURA_ODLUKE.md](STAMPA_FAKTURA_ODLUKE.md) (O-F1…O-F5). Ostaje nerešeno:

* **Mesto istovara** — na papiru je isto kao adresa kupca. Pravilo (izvodi se) ili zaseban
  šifarnik adresa isporuke? Zasad slobodan tekst.
* **Kilaža i dimenzije** — ručni unos po fakturi ili obračun iz `Item.weightKg`? Ako obračun —
  odakle težina palete (brutto − netto = 20 kg na 060/26)?
* **Špediter** — slobodan tekst ili šifarnik (isti se ponavljaju)?
* **Devizni račun za valute osim EUR** — biramo po valuti pa fallback na prvi račun sa IBAN-om;
  postoji li više deviznih računa?
* **`web::` sa dve dvotačke** i **„Trgovinski sud u Beogradu"** (zastareo naziv) — prepisuje se
  doslovno sa papira dok se ne odluči drugačije.
* **Otpremnica bez cena** — obrazac nije donet; zasad se štampa isti šablon bez novčanih kolona.
* **Prelom domaćeg računa preko jedne strane** — nijedan doneti primer nema drugu stranu, pa se
  ne vidi gde ide blok potpisa. **NEPOZNATO.**
* **Adresa u bloku „Robu izdao"** je adresa sedišta, ne magacina — `Warehouse.street/city`
  postoje, ali `PrintCtx` nosi samo naziv. Vidi se tek kad magacin nije na adresi sedišta.
* **QR kod** u podnožju vodi na `https://goo.gl/w9bnHq` (dekodovano sa papira) — Google je
  ugasio `goo.gl` skraćivač, pa link treba proveriti i verovatno zameniti.
* **Fajlovi logotipa** (TÜV/ISO znak, partnerska traka) izvučeni su iz samih PDF-ova; vredi
  potvrditi da je spisak partnera i dalje tačan.
* **Font** je Roboto (jedini u `PdfService`), original je Arial-oid — širine kolona su
  procenjene, ne izmerene. Pikselno poređenje nije bilo moguće (nema `pdftoppm` na mašini).
* **50 zatečenih prettier grešaka** u `sales/print/templates/*` iz ranijih commitova; CI lint je
  neblokirajući, ali dug stoji.

## C. BigBit noćni kanal (.mdb) — posle isporuke na prod

* **Prekidač `bigbit_mdb_sync` na produkciji** — tabela `app_switches` je stigla tek sa ovim
  deploy-om i **prazna je**, a odsustvo reda znači UKLJUČENO. Posao ide u 03:45; dok prod nema
  svoj drop, svaki termin bi pao. Pre nego što se pusti: ili upisati red `enabled=false`, ili
  prebaciti izvoz da puni prod.
* **Tajmer izvoza i dalje puni DEV** (`~/bigbit-mdb/env` na ubuntusrv). Prebacivanje na prod je
  svesna radnja, ne usputna.
* **„Rađa se ugašen"** — nov predmet iz BigBita treba da dobije red u `predmet_aktivacije` sa
  `is_active=false` (migracija: kolona default `true` → `false`). Bez toga svaki nov predmet
  odmah upada u plan proizvodnje.
* **Četiri test-naloga na DEV bazi** (`IFR/2026/260203`, `IFGP/2026/260709`, `TREB1/2026/260709`,
  `ULGP/2026/260709`) sudaraju se sa BigBit brojevima i obaraju korak knjiženja. Na produkciji ne
  prete — tamo je glavna knjiga prazna.
* **Razlika po vodenom žigu + sedmično usaglašavanje** — 58,7 % artikala u BigBitu nema datum
  izmene, pa se „šta se promenilo" ne može čitati iz njega; treba periodično puno poređenje.
* **Raster** (dimenzije lima + kg/kom) i **prateće tabele artikala** (barkod, multifaktor,
  kvalitet, mesta izdavanja, ino nazivi, dobavljači) — posle prvih proba unosa.

## D. Gašenje sy15 — nije „ostatak 1.0" nego seoba naših modula

Mapa i put su u [docs/](../../docs/) i u razgovoru 01.08; ukratko:

1. **Prvi korak (lako):** `bigtehn_*_cache` (predmeti, komitenti, radnici, mašine, radna mesta,
   sektori) okrenuti da se **pune iz proda** umesto iz mrtvog QBigTehn-a. 1.0 ih samo čita, a
   obrazac već postoji — `loc-tp-feed.service.ts` to radi za radne naloge.
2. **Zamrznuti rast** — svaki nov modul ide u prod (već se poštuje).
3. **Jedan ceo modul kao šablon** — predlog **Projektni biro**: najmanji je, a ima sve elemente
   (podaci, bazne funkcije, prava, fajlovi). Tek kad on prođe, zna se prava cena kadrovske.
4. **Poslednje:** identitet/SSO i kadrovska/sastanci — 1.0 ih još piše, a pravila im žive u
   ~60 SQL funkcija **unutar same baze**, kojih u repou nema.

⚠️ Pravilo: modul se ne može preseliti dok **1.0 ekran još piše** u njegove tabele.

## E. Čeka knjigovođu

* Šeme knjiženja **30/31** i **37/38**.
* Konta grupe **49** → AOP pozicije 0428/0430/0454.
* **27200 vs 2720** — koje konto je pravo.
* **KEP** za maloprodaju i veleprodaju.

## F. Sitno, ali zapisano

* Dve zatečene TypeScript greške u `kadrovska.zahtev-026.spec.ts` i `moj-profil.zahtev-026.spec.ts`
  (union tip povratne vrednosti sy15 servisa) — postoje i na čistom stablu, CI ih ne hvata jer
  proverava samo produkcioni kod.
* **Dupli PIB-ovi u BigBitu** — spisak od 12 grupa predat administraciji 31.07; broj pada sam kako
  ih ispravljaju (Podešavanja → Integracije → „Dupli PIB kod komitenata").

---

## 1. ServoSync 2.0 — modul „Tehnologija" (praktično završen)

Proizvodni core je **živ na produkciji** i spojen u 1.5 na `servosync.servoteh.com/tehnologija`.
Kraj-do-kraja rade: Radni nalozi, Tehnološki postupci (+ kartica po operaciji), PDM/Crteži
(rekurzivni BOM), Nacrti + Primopredaje (ceo tok odobravanja P0–P5), Lokacije delova, Proizvodne
strukture, MRP/Nabavka (uvid), Komitenti/Predmeti (pregled), barkod (RN dokument + kiosk).

**Živo od poslednjeg roadmap checkpointa (danas i prethodnih dana):**
- **Tehnolog tok (P0–P5):** dodela tehnologa pri **odobravanju** primopredaje (ne pri lansiranju),
  „Otkucaj TP" iz primopredaje, undo/vraćanje odobrenih, pretraga po tehnologu, notifikacije dorade.
- **Automatski uvoz PDM XML-a — ŽIV:** `pdm-bridge` na ubuntu serveru (systemd timer 5 min, CIFS mount
  ka PDM/BigBit share-ovima) čita XML i šalje u `POST /pdm/import`; PDF crtež se ne briše.
- **RBAC enforced na produkciji** (`AUTHZ_ENFORCE=true`); 5 kontrolora, SoD pravila.
- **Batch print** crteža sa izborom štampača (ploter/A4), zbir po operaciji, RN barkod verzioni guard.
- **Probe na produkciji + dorade 12–13.07 (ODLUKE #33–#36):**
  - `/nacrti` (gate `primopredaje.write`) i `/handovers` (gate `primopredaje.approve`) razdvojeni;
    tehnolog+menadzment dobili `primopredaje.approve` (menadzment privremeno).
  - **Paket A** (#34): tehnolozi vezani na radnike (`users.worker_id`), HITNO flag (`is_urgent` +
    badge/RN-štampa), kolone Radnik/Tehnolog u Realizaciji, „PDF crteža" u detalju, tab „Na pisanju"
    + `writing-stats`.
  - **Paket B** (#35): poreklo dorada/škart RN-a (`parent_work_order_id`, filter `?reworkOnly`),
    `locations[]` u listi RN + kolona Lokacija na `/completed-orders`, **NOVI modul `cnc-programs`**
    (tabela `cnc_programs`, lista pozicija + ček „CAM urađen", nav „CAM programiranje").
  - **Proba r1:** AUTO-BOM (sklop izlistava pozicije iz sastavnice), `designerId` opcion + projektant
    ComboBox, `GET /handovers/engineers`, labela „Predao (projektant)".
  - **Proba r2** (#36): `approve-batch`/`reject-batch` (grupno po nacrtu; lansiranje pojedinačno),
    kiosk „Moji otvoreni" (`GET /tech-processes/worker/open`, zatvaranje bez skeniranja), CAM filter
    549→271, dimenzija materijala u RN štampi, kvalitet badge.
  - **E2E tok na produ + fix `b064a96`** (id-floor: native primopredaje od 10000+); **login parnost
    1.0→2.0** (27 update + 31 insert, backup `users_pwhash_backup_20260713`) + 17 biro naloga;
    sidebar stavke Kucanje/Kontrola (pogon) uklonjene (ulaz `/kiosk` / 1.0 HUB). PDF gap:
    [design/PDF_GAP_2026-07-13.md](design/PDF_GAP_2026-07-13.md).

**Preostalo za 2.0 = uglavnom kozmetika, ne izgradnja:** UI dorade, sitni bugfix, poravnavanje
naziva sa QBigTehn-om. „Imamo aplikaciju 2.0" je ispunjeno — mada je 12–13.07 ipak isporučen i
jedan mali novi modul (`cnc-programs`/CAM programiranje), pa „kozmetika" važi od ovog checkpointa.

---

## 2. BigBit → 2.0 sync (nova radna linija, otvorena 11–12.07)

Trajni matični sync iz BigBit ERP-a (Access `.mdb`) u 2.0 PostgreSQL. **Odluka izvora (Nenad 11.07):
skripta na ubuntu serveru čita `mdb-tools`-om i piše direktno u PG** — NE XML export, NE preko NestJS
sync modula (menja stariju §11.2a odluku). Alat: [`tools/bigbit-bridge/`](../tools/bigbit-bridge/).
Mehanizam: BigBit noćni izvoz → SMB drop share `\\192.168.64.28\bigbit-incoming` (nalog `bbdrop`) →
`mdb-export` (ignoriše ULS, bez lozinke) → staging + `INSERT … ON CONFLICT DO UPDATE` (UPSERT, nikad
delete) preko lokalnog `docker exec servosync-pg psql`.

### Faza 1 — šifarnici artikala ✅ ŽIVO
`R_Grupa/R_Podgrupa/R_Poreklo` → `item_groups/item_subgroups/item_origins` (19/86/128). Artikli su
prvi put dobili nazive grupa/podgrupa/porekla. Idempotentno, dnevni ritam (timer 05:30 — ostaje uključiti).

### Faza 2 — matične tabele (pripremljeno, GATED do cutover-a)
ID-prostor rešen (Fable analiza §7.6, opcija A): `items.id` ostaje QBigTehn ključ, BigBit se veže
preko `items.external_item_id`.

| Tabela | Cilj | Stanje |
|---|---|---|
| **Magacini** | `warehouses` | ✅ **ŽIVO** (3, cilj bio prazan — nije MSSQL-sync tabela) |
| **Komitenti** | `customers` | 📝 napisano, dry-run čisto — **ISKLJUČENO do cutover-a** |
| **Predmeti** | `projects` | 📝 napisano, dry-run čisto — **ISKLJUČENO do cutover-a** |
| **R_Artikli** | `items` | 📝 napisano (UPDATE-only preko `external_item_id`) — **ISKLJUČENO do cutover-a** |
| **Cenovnik** | `price_list_entries` | ⏳ **TODO**: napisati `sql/`; treba `@@unique` poslovni ključ + remap artikla |

> ⚠️ **Zašto gated (Nenad 12.07):** ove tabele drži **živi MSSQL (QBigTehn) sync**. BigBit se ne sme
> prepisivati preko njega dok se ne uradi cutover („jedan pisac po tabeli"). U `tables.manifest` stoje
> zakomentarisane. Dry-run pokazuje da bi BigBit „ažurirao" skoro sve redove jer nosi polja koja MSSQL
> sync ostavlja prazna (`code_type_code`, `salesperson_id`) — bogatiji podatak koji stiže na cutover-u.

**Pre aktivacije Faze 2 (na cutover-u):**
1. Napisati `Cenovnik → price_list_entries` (+ migracija: `@@unique(item_id, document_type_code,
   tax_rate_code)` i parcijalni `uq_items_external_item_id WHERE external_item_id <> 0`).
2. **Field-level diff za `items`** — dry-run pokazuje 90.984 „update" bez FK razloga (verovatno
   reprezentacija: trailing space / NULL-vs-0), da gard hvata samo prave izmene, ne pun rewrite.
3. **Spot-provera 1:1 ID-a:** Komitenti (PIB), Predmeti (BrojPredmeta), Magacini (naziv).
4. Uključiti timer (`install-timer.sh`, 05:30) i BigBit noćni copy task na drop share.

### Faza 3 — ostatak KEEP-SYNC (~49 tabela, kad zatreba)
Dodavanje tabele = red u `tables.manifest` + `sql/<t>.sql`. Ide po potrebi modula koji je čita, ne
paušalno. EXCLUDE-TVRDO (55) se nikad ne kopira; ODLOŽI-4.0 (103) čeka 4.0 domene. Inventar:
[migration/BB_T_26-analiza-F3-inventar-207-tabela.md](migration/BB_T_26-analiza-F3-inventar-207-tabela.md).

---

## 3. Cutover — gašenje QBigTehn MSSQL sync-a (kritičan prelaz)

Kad proizvodnja pređe potpuno na 2.0 kao izvor istine:
1. **Aktivirati BigBit master sync** (Faza 2: customers/projects/items/Cenovnik) — BigBit postaje jedini
   pisac matičnih; `items` prelazi iz UPDATE-only u pun INSERT, park-lista novih artikala se prazni.
2. **1.0 Lokacije most** (`loc_*`) repointovati sa QBigTehn cache-a na 2.0 `tech_processes`, outbound
   `sp_ApplyLocationEvent` ugasiti/preusmeriti — vidi [ROADMAP „Sync tokom tranzicije"](ROADMAP.md).
   **Ne gasiti QBigTehn dok ovaj most nije prebačen.**
3. Ugasiti Sync A (QBigTehn MSSQL, `vasa-SQL:5765`); proizvodne tabele su već ServoSync vlasništvo.

---

## 4. Dalje — 3.0 i 4.0 (nepromenjen plan, vidi ROADMAP)

- **3.0** — prebacivanje ServoSync 1.0 (Supabase moduli) na stack 2.0 i spajanje u jednu aplikaciju.
  Najveći deo: 293 RLS + 238 SECURITY DEFINER → NestJS guardovi. Podaci već na on-prem PG (međukorak).
- **4.0** — apsorpcija BigBit ERP-a (GK/PDV/SEF/fakture/nabavka/carina). Bez roka, trigerima. Matične
  tabele iz Faze 2 tada prelaze iz cache → vlasništvo. Pun materijal spreman ([migration/09–14](migration/README.md)).

---

*Poslednji update: 2026-07-13 — probe na produkciji + paketi dorada A/B isporučeni (ODLUKE
#33–#36, uklj. novi mali modul `cnc-programs`), login parnost 1.0→2.0; BigBit sync linija
nepromenjena (Faza 1 živa, Faza 2 gated do cutover-a); 2.0 „Tehnologija" praktično završen.*
