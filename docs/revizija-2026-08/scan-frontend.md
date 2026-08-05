# Skener frontenda — inventar anti-obrazaca

**Baza koda:** `C:\Users\nenad.jarakovic\wt\robno-quality\frontend\src` (svež `main`)
**Merilo:** `frontend/CLAUDE.md` (12 tvrdih pravila) + `frontend/docs/DESIGN_SYSTEM.md`
**Obim:** 707 `.ts`/`.tsx` fajlova · 157 `<DataTable>` upotreba · 185 fajlova sa `<Dialog>` · 54 modula pod `app/`

Svaki nalaz je pročitan u kodu. Ozbiljnost:
🔴 = korisnik dobija **pogrešan ili nepotpun podatak** · 🟠 = rizik pri rastu podataka · 🟡 = doslednost/održavanje.

## Rezime

| # | Obrazac | 🔴 | 🟠 | 🟡 | Ukupno |
|---|---|---|---|---|---|
| 1 | Klijentsko filtriranje server-paginiranih podataka | 1 | 3 | 1 | **5** |
| 2 | Tabela bez server-side paginacije | 0 | 9 | 6 | **15** |
| 3 | Direktan API poziv iz komponente | 0 | 1 | 6 | **7** |
| 4 | Tvrde vrednosti umesto tokena | 0 | 1 | 43+72+41 | **156** (44 fajla) |
| 5 | Ekran bez tastature | 0 | 2 | 154 | **156** |
| 6 | Nedostaje stanje greške ili praznog skupa | 3 | 12 | 16 | **31** |
| 7 | Fajlovi preko 500 linija | 0 | 10 | 100 | **110** |

---

## 1. Klijentsko filtriranje server-paginiranih podataka

Komponenta dobije **jednu stranu** od API-ja pa filtrira u JS-u. Posledica: filter/pretraga „ne nalazi" ono što postoji van te strane, dok brojači i dalje govore o punom skupu.

| fajl:linija | ekran | ozb. | šta korisnik konkretno oseti |
|---|---|---|---|
| `app/zahtevi/page.tsx:306` (+ `:516`) | Zahtevi → **Inbox** (admin) | 🔴 | `useZahtevi({page, pageSize: 50})` se zove **bez** `status` filtera, pa se strana klijentski suzi na `INBOX_STATUSES` (`SUBMITTED/ANALYZED/TESTING`). Uz to je `<Pager>` na tom tabu **isključen** uslovom `tab !== 'inbox'` (`:516`). Tab nosi tačan serverski broj iz `useInboxMeta` — dakle piše „Inbox (63)", a tabela može pokazati najviše ono što je preživelo filtriranje prvih 50 redova, **bez ijednog načina da se dođe do ostatka**. Zahtev koji čeka odluku a nije u prvih 50 po sortu jednostavno ne postoji za admina. |
| `app/odrzavanje/_components/dokumenta-tab.tsx:70-82` | Održavanje → Dokumenta | 🟠 | `useDocuments({entityType, page, pageSize:100})`, pa se **Kategorija** i **Rok važenja** (`istekli`/`uskoro`/`važeći`) filtriraju klijentski nad tom stranom. Filter „istekli" na registru atesta i sertifikata promašuje istekle dokumente od 101. reda naniže. Ublaženo: linija `:136` pošteno piše „Filteri kategorije/roka primenjeni su na tekuću stranu (N od M)" — jedini ekran u aplikaciji koji to priznaje. |
| `app/odrzavanje/_components/dokumenta-tab.tsx:232-243` | Održavanje → Dokumenta vozila | 🟠 | Tvrde kape `pageSize: 200` (vozači) i `pageSize: 500` (sredstva), pa se spajaju i filtriraju klijentski (`vehicleIds.has(...)`). Nema ni pagera ni napomene. Preko 500 dokumenata sredstava — dokumenta vozila počinju tiho da nestaju iz zbirnog pregleda. |
| `app/robno/lager-panel.tsx:131` ↔ `api/robno.ts:428-438` | Robno → Lager lista | 🟠 | FE **jeste** ispravan: `q` i `onlyInStock` idu na server. Defekt je na drugoj strani istog ugovora — backend filtrira posle `LIMIT`-a (kalibracioni primer iz naloga), pa pretraga po nazivu/šifri vraća samo ono što je slučajno upalo u prvi isečak. FE nema ni `page` parametar (v. obrazac 2), pa ni ne može da traži ostatak. **Popravka je backend + dodavanje paginacije, ne izmena panela.** |
| `app/reversi/_components/alat-oprema-tab.tsx:262-281` → `:489-500` | Reversi → Alat i oprema (KPI pločice) | 🟡 | Pločice „Slobodno u magacinu" / „Na reversu" računaju se klijentski nad **uzorkom od 2000 redova** (`STAT_SAMPLE`), ne nad punim skupom. Kod to zna (`moreThanSample`) i lepi „+" na broj, pa je zabluda ograničena — ali prikazani broj nije tačan čim aktivnih jedinica bude preko 2000. Sama lista je uzorno server-paginirana i server-filtrirana. |

**Provereno i očišćeno (nije nalaz):** `app/handovers/_components/drafts-tab.tsx:269` (`draftItemMatches` filtrira stavke **u formi**, lokalni niz u state-u — komentar to i kaže) · `app/kadrovska/_components/zaposleni-tab.tsx:131` (svi filteri, sort i strana idu na server) · `app/artikli/page.tsx:105`, `app/komitenti/page.tsx:95`, `app/customers/page.tsx:102` (ispravna server paginacija sa `q`) · `.filter(Boolean).join(...)` idiom (~150 pogodaka, formatiranje).

---

## 2. Tabela bez server-side paginacije

Pravilo 8: *„Tabele su server-side paginirane od prvog dana."* DESIGN_SYSTEM §5 dodaje razlog: *„tabele će imati desetine hiljada redova iz legacy-ja."*

**Merenje:** 118 fajlova koristi `<DataTable>`, samo **51** koristi `<Pager>`. Od 69 fajlova bez pagera većina su ograničene pod-tabele dokumenta (stavke jedne fakture, redovi jednog naloga) i s pravom nisu paginirane. Dole su one koje gađaju **rastuću tabelu baze**.

| fajl:linija | ekran | ozb. | nad kojom tabelom / procena redova · šta korisnik oseti |
|---|---|---|---|
| `app/robno/lager-panel.tsx:181` ← `api/robno.ts:428` | Robno → Lager lista | 🟠 | `StockLevel` (artikal × magacin). BigBit nosi ~92.500 artikala; hook nema `page` ni `pageSize`. Ceo lager stiže u jednom odgovoru i renderuje se u jedan DOM `<table>` — strana se ledi, a `ExportCsvButton` (`:155`) izvozi tačno ono što je stiglo, ne pun lager. |
| `app/saldakonti/page.tsx:117` ← `api/saldakonti.ts:136` | Saldakonti → Otvorene stavke | 🟠 | Docstring hooka doslovno kaže: *„Bez filtera vraća **sve** otvorene stavke svih saldakonto konta."* Bez pagera. Otvorene stavke se gomilaju kroz godine; uz to strana radi `sumBalances` i `flatMap(ledgerEntryIds)` nad celim skupom pri svakom kliku na checkbox. |
| `app/pdv/page.tsx:340-343` ← `api/pdv.ts:178-227` | PDV → KIF / KUF / KEPU | 🟠 | Tri poreske knjige, sve tri bez paginacije (`?year=&month=` i ništa više). CLAUDE.md §12 kao referentnu veličinu navodi *„knjigu od 625 faktura"* po PDV periodu; KEPU je red po stavci robnog dokumenta, dakle red veličine više. Uz to sve četiri knjige (+ `useVatReturns`) žive u istoj komponenti, pa otvaranje KEPU-a drži KIF/KUF u memoriji. |
| `app/saldakonti/kartica/page.tsx:68` ← `api/saldakonti.ts:517` | Saldakonti → Kartica komitenta | 🟠 | Sve knjigovodstvene stavke jednog komitenta u opsegu datuma, bez paginacije. Za velikog kupca sa nekoliko godina prometa to je hiljade redova u jednom pozivu. |
| `app/reversi/_components/magacin-tab.tsx:194` ← `api/reversi.ts:842` | Reversi → Magacin alata | 🟠 | `useWarehouse()` povlači ceo pogled magacina; komentar na `:197` to priznaje — *„Filteri (**KLIJENTSKI** nad odgovorom view-a…)"*. Grupa, klasa, nulta stanja i pretraga se svi računaju u pregledaču, nema pagera. Sve dok je magacin mali radi; svaka nova klasa alata pomera taj prag. |
| `app/robno/popis/count-detail.tsx:381` | Robno → Popis → detalj | 🟠 | Sve stavke popisa u jednoj tabeli. Popis celog magacina daje jedan red po artiklu — isti red veličine kao lager (desetine hiljada). Magacioner koji unosi izmerene količine radi u tabeli koja se cela re-renderuje. |
| `app/sef/incoming-tab.tsx:121` ← `api/sef.ts:333` | SEF → Ulazne fakture | 🟠 | Filter samo po statusu, nema paginacije. Registar ulaznih e-faktura raste svakog meseca i nikad se ne prazni. |
| `app/blagajna/page.tsx:96` ← `api/blagajna.ts:52` | Blagajna → Stavke | 🟠 | `GET /blagajna/journals/:id/entries` bez opsega — sve uplatnice i isplatnice jedne blagajne od otvaranja. Append-only. |
| `app/reversi/_components/otpisano-tab.tsx:38` ← `api/reversi.ts:852` | Reversi → Otpisano | 🟠 | `/reports/scrapped` bez parametara + klijentska pretraga (`:47`). Otpis je append-only evidencija — raste zauvek, nikad se ne skraćuje. |
| `app/lokacije/_components/lokacije-tab.tsx` ← `api/lokacije.ts:445` | Lokacije → Lokacije | 🟡 | `useAllLocations` je **petlja od do 20 uzastopnih zahteva** po 1000 redova; komentar kaže „živih lokacija je ~1561". Radi, ali je to zaobilaženje paginacije, ne paginacija — plus klijentsko filtriranje stabla (`:53`, `:79`, `:95`). |
| `app/kadrovska/_components/imenik-tab.tsx:70` ← `api/kadrovska.ts:1236` | Kadrovska → Imenik | 🟡 | Isti obrazac: do 10 uzastopnih zahteva po 200 (kapa 2000, danas ~157 zaposlenih) pa klijentska pretraga. Bezbedno danas, ali kapa je tiha — na 2001. zaposlenom imenik prosto prestane da ga prikazuje. |
| `app/robno/item-card-panel.tsx:214` ← `api/robno.ts:808` | Robno → Kartica artikla | 🟡 | Sva kretanja jednog artikla u opsegu. Datumski opseg je prirodna kočnica, ali podrazumevani opseg je prazan = sve. |
| `app/izvodi/detalj/page.tsx:213` | Izvodi → detalj izvoda | 🟡 | Sve stavke jednog bankovnog izvoda. Ograničeno prirodom dokumenta (~50-300), ali izvod velikog dana zna da bude i preko toga. |
| `app/syncs/page.tsx:71` ← `api/sync.ts:30` | Sinhronizacije | 🟡 | `GET /sync/log` bez parametara — append-only dnevnik. |
| `app/zavrsni-racun/page.tsx:266` | Završni račun → Bruto bilans | 🟡 | Ograničen kontnim planom (stotine redova), pa je rizik nizak; navedeno radi potpunosti. |

**Provereno i očišćeno:** `app/glavna-knjiga/detalj/page.tsx:103`, `app/pdv/stope/page.tsx:53`, `app/kamata/page.tsx:112`, `app/reversi/_components/masine-tab.tsx:20` i sve pod-tabele stavki jednog dokumenta — prirodno ograničene, paginacija bi im smetala.

---

## 3. Direktan API poziv iz komponente

Pravilo 8: *„komponente ne zovu API direktno — sve ide kroz TanStack Query hook-ove u `src/api/`."*

| fajl:linija | ekran | ozb. | šta korisnik konkretno oseti |
|---|---|---|---|
| `app/lokacije/_components/predmet-tab.tsx:89` | Lokacije → Predmet (otvori crtež) | 🟠 | `apiFetch('/v1/pdm/drawings?q=…&pageSize=5')` u slobodnoj `async` funkciji van hook sloja. Nema keša (svaki klik = nov zahtev), nema retry-ja, a greška se javlja kroz **native `alert()`** (`:92`, `:95`) umesto kroz `Toast` iz kita — jedini blokirajući sistemski dijalog u aplikaciji. Uz to `pageSize=5` znači da crtež čiji broj deli prefiks sa pet drugih možda neće biti pronađen. |
| `app/odrzavanje/_components/prijava-kvara-dialog.tsx:120` | Održavanje → Prijava kvara | 🟡 | `apiFetch('/v1/maintenance/incidents/:id')` unutar `onSuccess` mutacije, da bi se pročitao auto-kreiran radni nalog. Rezultat ne ulazi u Query keš, pa ekran naloga koji se posle otvori ponovo puca po istom podatku. |
| `app/pracenje-proizvodnje/_components/predmet-override.ts:88` | Praćenje → Predmet (override) | 🟡 | Ceo hook sloj (`useOverrideUpsert` + `apiFetch` + `useQueryClient`) živi pod `app/**/_components/` umesto u `src/api/`. Kod je ispravan, mesto nije — ista logika je nevidljiva svakome ko traži rute praćenja u `src/api/pracenje.ts`. |
| `components/drawing-preview.tsx:152` | Deljena komponenta — pregled crteža | 🟡 | `apiBlob('/v1/pdm/drawings/:id/pdf/content')` direktno iz komponente. |
| `components/annotate/pdf-annotator.tsx:73` | Deljena komponenta — anotacija PDF-a | 🟡 | `apiBlob(path)` direktno iz komponente. |
| `app/sastanci/_components/detalj-zapisnik.tsx:625` | Sastanci → Zapisnik (prilozi) | 🟡 | `useQuery({queryFn: () => fetchSlikaUrl(...)})` definisan **u komponenti**. Fetcher jeste u `api/sastanci.ts:688`, ali `queryKey`, `staleTime` i keš politika žive u ekranu — druga komponenta koja prikaže istu sliku dobija drugi keš. |
| `app/energetika/_components/scada-bridge.ts:60` | Energetika → SCADA HMI | 🟡 | Sirov `fetch('/scada-hmi/kot1-tags.json')` sa `catch {}` koji tiho vraća prazan spisak tagova — ako fajl fali, HMI se iscrta bez ijednog merenja i bez poruke. |

**Provereno i očišćeno (legitimno, nije nalaz):** `lib/kiosk-punch.ts:67` (drugi servis, `x-kiosk-key`, namerno van `apiFetch`-a) · `lib/label-print.ts:72` (rezerva na lokalni štampački proxy tek pošto `apiFetch` put padne, `:58`) · `components/update-notifier.tsx:35` (`/version.json`) · font/logo `fetch`-evi u `lib/*-pdf.ts` · 72 `import { ApiError }` (samo tip greške, ne poziv).

---

## 4. Tvrde vrednosti umesto tokena

Pravilo 1 / DESIGN_SYSTEM §3.5: *„Hex vrednost ili 'magični px' direktno u komponenti = bug."*
**156 pogodaka u 44 fajla.** Puna lista je predugačka za izveštaj; ovde su nosioci.

### 4a. Hex/rgb u živom UI-ju (43 pogotka, 11 fajlova)

| fajl:linija | ekran | ozb. | šta korisnik konkretno oseti |
|---|---|---|---|
| `app/kiosk-prisustvo/_components/kiosk-punch-scanner.tsx:41,66,67,81,83,86,88,238,271,246,296,308` | Kiosk prisustva | 🟠 | **Ceo ekran je netokenizovana tamna tema** — `bg-[#0b0f17]`, `border-[#263149]`, `bg-[#2f6bff]`, `text-[#ff8a8a]`, `rgba(...)`. Plava `#2f6bff` nije teal akcenat iz DESIGN_SYSTEM §3, a crvena/žuta poruke nisu `--status-danger`/`--status-warn`. Radnik na kapiji vidi drugačiji brend od ostatka aplikacije, a promena palete ovaj ekran neće dotaći. |
| `app/kadrovska/_components/odmori/helpers.ts:24-26,30,38-42` | Kadrovska → Odmori | 🟡 | `DEPT_COLORS` (10 hex) + `REVIEW_FLAG_BADGE` boje (`#C6534F`, `#B07A1E`, `#8a8a8a`, `#3B8C4E`) hranjene u inline `style` na ~10 mesta. „Prekoračeno" i „outlier" su **semantička stanja** i po §7 pripadaju `--status-danger`/`--status-warn`. Bonus: `REVIEW_FLAG_BADGE.icon` nosi emoji (`⚠ 🔎 ❓ ✔`), što gazi §2 („bez emoji-ja u UI", ikone samo `lucide-react`). |
| `app/podesavanja/_components/competence-editor.tsx:42-46,215` + `app/profil/_components/assessment-section.tsx:35-37,320` | Podešavanja → Kompetencije · Profil → Samoprocena | 🟡 | Ista paleta (`#0891b2`, `#2563eb`, `#7c3aed`, `#64748b`) **duplirana u dva fajla**. Kad se jedna promeni, ekran zaposlenog i ekran administratora prikažu istu kompetenciju u različitim bojama. |
| `app/kadrovska/_components/razvoj/radar.tsx:7-10` | Kadrovska → Razvoj (radar 360°) | 🟡 | `self/peer/leader/target` boje kao hex. |
| `app/montaza/_components/gantt-chart.tsx:187,298` · `app/dev/ui/page.tsx:374,376` · `components/annotate/pdf-annotator.tsx:411` | Montaža Gantt · Dev katalog · PDF anotacija | 🟡 | Pojedinačni hex u `style`/`className`. |
| `app/pdv/page.tsx:667` | PDV → KEP | 🟡 | `text-[var(--color-warning-fg,#8a5a00)]` — fallback hex na nepostojeći token (`--color-warning-fg` ne postoji u `tokens.css`), pa je **hex ono što se zaista vidi**. |

**Namerni izuzeci, potvrđeni u pravilniku:** `components/ui-kit/scan-reticle.tsx:107,109` i `help-tour.tsx:128` — DESIGN_SYSTEM §10 izričito dozvoljava fiksne boje nišana i vinjete jer stoje preko slike kamere.

### 4b. Magični px u `className` (72 pogotka, 31 fajl) — 🟡

| fajl | broj | ekran |
|---|---|---|
| `app/kadrovska/_components/grid/grid-table.tsx` (78, 89, 108, 231, 235-242, 267, 329, 335, 345, 368, 407, 430, 465, 491) | **17** | Kadrovska → Grid sati — cela geometrija ćelija (`w-[34px]`, `text-[9px]`, `p-[1px]`, `pr-[13px]`) van 4px mreže i van tipografske skale 12/12.5/14/16/20/24 |
| `app/pracenje-proizvodnje/_components/predmet-view.tsx` (646, 723, 740, 805, 914, 1096, 1471, 1472, 1831) | 9 | Praćenje → Predmet — uključujući `min-w-[1180px]` koji fiksira minimalnu širinu tabele u px i time gazi §11 (preslagivanje po širini) |
| `app/podesavanja/_components/organizacija-tab.tsx` (484, 489, 625, 650) | 4 | Podešavanja → Organizacija |
| `app/profil/_components/assessment-section.tsx` (275, 312, 334, 357) | 4 | Profil → Samoprocena |
| ostalih 27 fajlova | 38 | pretežno `min-w-[NNNNpx]` na širokim tabelama (`montaza/plan-tab.tsx:858` = `min-w-[1400px]`, `kadrovska/zarade/obracun-view.tsx:588` = `min-w-[1280px]`, `podesavanja/predmet-aktivacija-tab.tsx:443` = `min-w-[1140px]`) i `text-[9px]`/`text-[10px]` ispod najmanjeg tokena |

Odvojena grupa: **13 `text-[0.65rem]`/`[0.6rem]`/`[0.7rem]`** van skale, sve u Kadrovska → Odmori (`saldo-tab`, `history-modal`, `odobravanje-tab`, `go-periodi`, `gantt`, `zahtevi-tab`).

### 4c. Hex u generatorima štampe/PDF-a (41 pogodak, 5 fajlova) — 🟡, niži prioritet

`app/lokacije/_components/labels-print-window.ts` (14) · `app/profil/_components/pravilnik-go-content.tsx` (9) · `app/lokacije/_components/predmet-print-window.ts` (8) · `app/profil/_components/company-values-content.tsx` (8) · `app/kadrovska/_components/zarade/accountant-modal.tsx:164,169` (HTML tela mejla, 2).
Prva dva `profil` fajla se **renderuju i na ekranu** u modalu, ne samo u štampi — tu hex nije opravdan.

---

## 5. Ekran bez tastature

Pravilo 7: *„Enter-navigacija u formama, `Ctrl+S` snimi, `Esc` otkaži… Ekran bez tastature nije završen."*

### Šta postoji, a šta ne — najvažniji nalaz obrasca

| prečica | gde živi | pokrivenost |
|---|---|---|
| `Esc` | ✅ **centralno u kitu** — `components/ui-kit/dialog.tsx:90` (`useEscapeLayer`) | svi kit dijalozi, slojevito |
| `↑/↓` + `Enter` u tabeli | ✅ **centralno u kitu** — `components/ui-kit/data-table.tsx:67-94` | svaka `DataTable` |
| `Ctrl+K` / `Ctrl+B` / `Alt+N` | ✅ centralno — `command-palette.tsx:115`, `app-shell.tsx:1519` | globalno |
| **`Ctrl+S` snimi** | ❌ **nema deljenog hooka** — potvrđeno pretragom `src/lib/` i `src/components/`: postoji 7 `use-*.ts` fajlova, nijedan nije hotkey hook | **24 fajla sa kopiranim inline `onKeyDown` handlerom** |
| **Enter → sledeće polje** | ❌ nema deljenog helpera — **2 nezavisne, različite implementacije** | `kvalitet/.../skart-dorada-tab.tsx:519` (`formKeydown`, 3 upotrebe) i `artikli/_forma/polja.tsx:417` (`naTaster`, drugi algoritam preko `data-polje` redosleda). Nijedna nije eksportovana. |

**Merenje:** 155 form-dijaloga (unos + mutacija snimanja) → **22 ima `Ctrl+S`, 133 nema**. 31 form-strana → 9 ima, **21 nema**. Enter-navigacija radi na **4 od 186** mesta.

Pošto je gap sistemski, ovde su najteži pojedinačni slučajevi umesto pune liste od 154 reda:

| fajl:linija | ekran | ozb. | šta korisnik konkretno oseti |
|---|---|---|---|
| `app/artikli/_forma/polja.tsx:394` + `:543` + `:551` | Artikli → Novi / Detalj | 🟠 | **`Ctrl+S` je pokvaren, ne samo odsutan.** Handler hvata prečicu i zove `objasniBranu()` — što je samo `toast(...)`; dugme „Snimi" na `:551` ima **isti** `onClick={objasniBranu}`. Nijedno nije povezano sa mutacijom. Danas je „brana" namerno zatvorena pa se ništa i ne snima, ali footer na `:543` već piše korisniku „*Enter vodi na sledeće polje · Ctrl+S snima · Esc izlazi*" — obećanje je neistinito, i ostaće neistinito i kad se brana otvori. |
| `app/kadrovska/_components/razvoj/shared.tsx:196-203` | Kadrovska → Razvoj (6 editora) | 🟠 | `WideModal` **nije kit `Dialog`** — kači sopstveni `window.addEventListener('keydown', …Escape)` umesto `useEscapeLayer`. Time zaobilazi slojevito zatvaranje: otvoren preko kit dijaloga, jedan `Esc` zatvori **oba sloja** i uneseni tekst nestane. To je tačno regresija koju `escape-layer.ts` postoji da spreči. Nema ni `Ctrl+S`. |
| `app/work-orders/page.tsx:1519, 1408, 1241, 1066, 891` | Radni nalozi → 5 formi (Novi RN, Izmeni zaglavlje, Operacija, Dorada/Škart, Kopiraj stavke) | 🟡 | Najkorišćenija proizvodna forma u aplikaciji, bez `Ctrl+S`. Operacija (`:1241`) ima **`Ctrl+Enter`** — prečica koja nije u DESIGN_SYSTEM §8, pa je isti pokret u susednom dijalogu bez efekta. |
| `app/odrzavanje/_components/**` (22 dijaloga: `zalihe-tab.tsx:249,298,398,486` · `masine-tab.tsx:250` · `masina-karton.tsx:590` · `vozilo-karton.tsx:470,566,668,698,744,851` · …) | Održavanje (CMMS) | 🟡 | **Najgori modul — nijedan od 22 form-dijaloga nema `Ctrl+S`.** „Nova mašina" i „Uredi mašinu" su forme od 16 polja koje se završavaju obaveznim potezom miša. |
| `app/reversi/_components/issue-dialog.tsx:972` | Reversi → Izdaj alat/opremu | 🟡 | Trokoračni čarobnjak, najprometniji tok u modulu, bez `Ctrl+S` i bez Enter-navigacije. |
| `app/placanja/page.tsx:538` | Plaćanja → Novi virman (ručni unos) | 🟡 | Unos novca bez prečice za snimanje. |
| `app/profil/_components/vacation-section.tsx:471` · `attendance-section.tsx:218` | Moj profil → Zahtev za godišnji · Korekcija kucanja | 🟡 | Forme koje dodiruje **svaki** zaposleni. |
| `app/handovers/_components/drafts-tab.tsx:567` | Primopredaje → Nacrt | 🟡 | Najveća pojedinačna forma u aplikaciji (533 linije dijaloga). |
| `app/podesavanja/_components/firma-tab.tsx:124` · `app/kadrovska/_components/ugovori/contract-form.tsx:36` | Podešavanja → Firma · Kadrovska → Ugovor o radu | 🟡 | Duge forme-strane, najveća cena gubitka unosa. |
| + još 120 form-dijaloga i 19 form-strana | Sastanci (8), Kadrovska/Profil (20), Reversi (13), Praćenje/Plan (12), Finansije (12), Lokacije/Montaža (11), Podešavanja/Structures/PB/PDM/Kvalitet/Zahtevi (21), Handovers (6) | 🟡 | Isto: `Ctrl+S` propada na pregledač i otvara „Sačuvaj stranicu kao…". |

---

## 6. Nedostaje stanje greške ili praznog skupa

**31 nalaz.** Obrazac: `useQuery` čiji se `isError`/`error` nigde ne prikazuje, a `empty` stanje **tvrdi poslovnu činjenicu** („Nema zaliha", „Nema narudžbenica"). 500/403 se korisniku prikaže kao „nema podataka".

### 🔴 Korisnik dobija pogrešan ishod, ne samo praznu tabelu

| fajl:linija | ekran | ozb. | šta korisnik konkretno oseti |
|---|---|---|---|
| `app/zavrsni-racun/page.tsx:288` → `:300` → `:313` | Završni račun → Bilans stanja / uspeha | 🔴 | `useStatementControls` bez obrade greške; `const controlResults = controls.data ?? []` pa `const blocking = controlResults.filter(isBlockingControlFailure)`. **Ako upit padne, `blocking.length === 0`** → blok „Kontrolna pravila" nestane sa ekrana *i* korisnik dobije potvrdu „Finalizovati bilans?" kao da su sve kontrole prošle. Finalizuje se **neprovereni** bilans, a finalizacija se po istoj poruci ne može ponoviti. |
| `app/fakturisanje/detalj/page.tsx:307` → `:506` | Fakturisanje → detalj fakture (SEF) | 🔴 | `useSefOutboxForInvoice` bez obrade greške. Uslov za dugme je `!activeSefRow && !sefOutbox.isLoading` — na grešci upita `activeSefRow` je `null` i `isLoading` je `false`, pa se **„Pošalji na SEF" ponovo omogući** iako je faktura već u redu za slanje. Guard protiv duplog `enqueue`-a otkazuje baš kad treba. |
| `app/saldakonti/compensation-panel.tsx:30` → `:142` | Saldakonti → Kompenzacije | 🔴 | Traka greške čita `proposal.data?.meta?.error`. Na HTTP grešci `data` je `undefined`, pa je `err === null` i **ništa se ne prikaže**; tabela piše „Nema stavki za prebijanje". Knjigovođa zaključi da komitent nema šta da prebije. |

### 🟠 Finansijski registri koji tvrde nulu umesto greške

| fajl:linija | ekran | ozb. | šta korisnik konkretno oseti |
|---|---|---|---|
| `app/robno/lager-panel.tsx:131` → `:186` | Robno → Lager lista | 🟠 | „**Nema zaliha**" — magacioner zaključi da firma nema robu. |
| `app/blagajna/page.tsx:91` → `:153` | Blagajna → lista blagajni | 🟠 | „**Nema blagajni — Klikni dugme Nova blagajna gore desno**" — poziv da se napravi duplikat postojeće blagajne. |
| `app/blagajna/page.tsx:96` → `:239` | Blagajna → stavke | 🟠 | „Nema stavki" **pored ne-nultog Stanja** — blagajnik vidi saldo bez ijedne uplatnice i ponovo kuca naloge. |
| `app/placanja/payment-orders-panel.tsx:48` → `:222` | Plaćanja → Nalozi za plaćanje | 🟠 | Greške *mutacija* se prikazuju (`:204-220`), greška *liste* ne. „Nema naloga za plaćanje" krije već kreirane, nepotpisane naloge. |
| `app/nabavka/purchase-orders-panel.tsx:48` → `:231` | Nabavka → Narudžbenice | 🟠 | „Nema narudžbenica" — nabavljač ponovo naruči već naručeno. |
| `app/saldakonti/kursne-razlike/page.tsx:142` → `:587` | Saldakonti → Kursne razlike | 🟠 | „Nema obračuna kursnih razlika" — knjigovođa ponovo pokrene već proknjižen FX obračun. |
| `app/pdv/stope/page.tsx:53` → `:93` | PDV → Poreske stope | 🟠 | „Nema definisanih poreskih stopa" — sugeriše ponovni unos PDV stopa. |
| `app/kamata/page.tsx:112` → `:262` | Kamata → Stope | 🟠 | „Nema definisanih stopa — Dodaj zateznu stopu (NBS) da bi obračun radio." |
| `app/izvodi/detalj/link-line-dialog.tsx:156` → `:211` | Izvodi → povezivanje stavke | 🟠 | „Nema otvorenih stavki za izabranog komitenta" — stavka izvoda ostane neupavena. |
| `app/kadrovska/_components/prisustvo/kontrola-view.tsx:93-95` → `:343,363,391` | Kadrovska → Prisustvo → Kontrola | 🟠 | Ekran čiji je **jedini posao** da otkrije neslaganja kapije i grida na grešci tvrdi „Nema neslaganja za ovaj mesec". |
| `app/kadrovska/_components/odmori/saldo-tab.tsx:60-62` → `:411` | Kadrovska → Odmori → Saldo | 🟠 | Obrađen je samo `periodsQ.isError` (`:72`); pad `balanceQ`/`entQ` daje **svakom zaposlenom 0 dana godišnjeg**. |
| `app/reversi/_components/tool-detail-dialog.tsx:143,180` → `:692,742` | Reversi → kartica alata | 🟠 | `detail.isError` jeste obrađen, ali pad dokumenata/knjige daje „Nema zaduženja za ovaj alat" — **izdat alat izgleda slobodan**. |

### 🟡 Ostali moduli (16)

`kadrovska/zaposleni-tab.tsx:131` · `imenik-tab.tsx:70` · `notifikacije-tab.tsx:65` · `izvestaji-tab.tsx` (**7 izveštaja**: 125, 427, 459, 482, 503, 536, 662) · `grid/work-hours-tab.tsx:48` · `odmori/zahtevi-tab.tsx:66,393` · `odsustva/listing-tab.tsx:56` · `nadoknada-tab.tsx:85` · `placeno-tab.tsx:72` · `prisustvo/shadow-view.tsx:29` · `razvoj/assessments.tsx:57` · `dev-plans.tsx:60` · `talks.tsx:58` · `dosije/documents-section.tsx:44` · `lokacije/pocetna-tab.tsx:124`.

### `<DataTable>` bez `empty` propa

Samo **4 od 157** upotreba, i tri su strukturno nedostižne (roditelj već gardira prazan niz):

| fajl:linija | ekran | ozb. | šta korisnik konkretno oseti |
|---|---|---|---|
| `app/kamata/page.tsx:215` | Kamata → Kamatni list | 🟡 | Kad obračun vrati nula stavki (komitent nema dospele otvorene stavke), ispod „Σ kamata: 0,00" ostanu **gola zaglavlja kolona nad praznom belom trakom**, bez ijedne reči zašto obračun nije dao ništa. |
| `app/mrp/_components/demand-detail.tsx:117` · `app/sastanci/_components/akcioni-plan-tab.tsx:288` · `app/sastanci/_components/detalj-akcije.tsx:127` | MRP · Sastanci | — | **Nije defekt** — provereno: roditelj gardira (`:114`) odnosno `groupAkcijeByRn` gradi grupe samo iz nepraznih kanti. |

> Ovo je zdrav deo slike: `empty` disciplina je skoro savršena (153/157). Problem nije *odsustvo* praznog stanja nego to što prazno stanje **govori neistinu kad je pravi uzrok greška**. Popravka je jedna: `tableEmpty(isError, …)` helper koji već postoji u `odrzavanje/_components/common.tsx` i koristi se na 2 mesta — proširiti ga na svih 30.

---

## 7. Fajlovi preko 500 linija

**110 fajlova.** Merilo nije broj linija nego **broj odvojenih ekrana/odgovornosti** u jednom fajlu.

### Prvo — šta NIJE problem

8 najvećih `api/*.ts` fajlova (`kadrovska.ts` 2215, `reversi.ts` 1897, `odrzavanje.ts` 1379, `sastanci.ts` 1292, `handovers.ts` 1193, `lokacije.ts` 1159, `moj-profil.ts` 1061, `robno.ts` 1000) su **ravni katalozi** — nula JSX, nula state-a, npr. `kadrovska.ts` = 65 nezavisnih hookova + 84 tipa. Efektivna jedinica je ~10 linija, odgovornost je jedna. **Tu ne treba trošiti budžet refaktora.** Jedini stvarni nalazi u toj grupi: `api/moj-profil.ts:90` (`vacationRemaining()` — poslovno pravilo o godišnjem odmoru u transportnom sloju, pripada `lib/`) i `newClientEventId()`/`qs()` kopirani u 5 fajlova.

### Tier 1 — pravi „god fajlovi"

| fajl:linija | ekran | ozb. | odgovornosti · šta korisnik/održavalac konkretno oseti |
|---|---|---|---|
| `components/ui-kit/app-shell.tsx` (1749) | Ljuska aplikacije — svaka strana | 🟠 | **8 UI površina, uvezen u 68 fajlova.** Drži *dve nezavisne implementacije navigacije* (`FullBody` 685-977 i `RailBody`/`RailFlyout` 978-1382) koje se ručno drže identičnim — nova afordansa se mora napisati dvaput, a razlika se ne vidi dok korisnik ne prebaci režim. Uz to: notifikaciono zvonce sa sopstvenim upitima (216-399), 14 efekata koji kače globalne `keydown`/`mousedown`/`matchMedia` slušaoce. Greška u redosledu tih slušalaca se ispolji kao „Esc radi pogrešnu stvar" na proizvoljnoj nevezanoj strani. Najveći radijus rizika u repou. |
| `app/work-orders/page.tsx` (2046) | Radni nalozi | 🟠 | **~12 ekrana, 8 dijaloga, 41 `useState`, 0 `useMemo`.** Lista + prošireni detalj + Novi RN + Izmeni zaglavlje + Operacija + Dorada/Škart + Kopiraj stavke + Kloniraj varijantu + Bulk kloniranje projekta + upload crteža. Izmena filter-bara dodiruje isti fajl koji poseduje „kreiraj RN" i editor operacija. Svih 8 dijaloga se učitava i radniku koji sme samo da čita listu (`Can` krije dugmad, ne kod). |
| `app/pracenje-proizvodnje/_components/predmet-view.tsx` (1875) | Praćenje → Predmet | 🟠 | **~7 ekrana, jedna funkcija od 1083 linije, 29 `useState`, 13 `useMemo`.** U istom telu: geometrija zamrznutih kolona u px (`FCOL`, `:103`), 14 formatera, DA/NE override state-mašina, XLSX izvoz, PDF izvoz, 5 modala. Promena `FCOL` širina tiho lomi `colSpan={colCount - 2}` band-redove nekoliko stotina linija dalje. |
| `app/lokacije/_components/scan-overlay.tsx` (1662) | Skener — 12 poziva iz 5 modula | 🟠 | **6 režima** (živa kamera, blokirana dozvola, ručni unos, upload fajla, OCR, batch lista) + cela matrica uređaja (iOS / Android Chrome / Samsung Internet) isprepletena sa React komponentom u jednom efektu od ~600 linija. Kamera se ne može testirati bez montiranja komponente. Regresija ovde istovremeno obara skeniranje u `lokacije`, `mob/lokacije`, `mob/odrzavanje`, `montaza` i svih 5 `reversi` dijaloga. |
| `app/handovers/_components/drafts-tab.tsx` (1539) | Primopredaje → Nacrti | 🟠 | **~9 ekrana, 27 `useState`.** Ključno poslovno pravilo — auto-razlaganje sastavnice („izaberi sklop → BOM se razloži u pozicije, neodobreni crteži se preskaču i prijave") — zakopano je usred dijaloga od 533 linije koji uz to drži i state forme i uređivanje redova i slanje. Neupotrebljivo iz drugog ulaza, netestabilno izolovano. Podela je već započeta (`decision-dialog.tsx`, `draft-item-dialog.tsx`, `common.tsx`) pa napuštena. |
| `app/montaza/_components/plan-tab.tsx` (1478) | Montaža → Plan | 🟠 | **~7 ekrana.** Interaktivna planska mreža (dnevna upotreba) + XLSX/JSON uvoz (`:539-661`, migracija podataka) + bulk preimenovanje lokacija (`:420-474`) + bulk brisanje lokacija (`:475-538`, administracija podataka) u jednoj komponenti. `phases` je lokalni `useState` koji menja 6 različitih `useCallback`-ova dok autosave puca — ovo je mesto gde žive bugovi „plan se tiho nije snimio". |
| `app/pracenje-proizvodnje/_components/rn-view.tsx` (1349) | Praćenje → RN | 🟠 | **~9 ekrana**, dva funkcionalno nepovezana taba (vizualizacija proizvodne linije i tracker operativnog plana) sa **dva odvojena XLSX izvoznika**. Hak sa `pushState` + sintetički `popstate` (`:142-243`) razvlači ponašanje rutiranja na dva fajla bez ikakvog tipskog ugovora. |
| `app/pdv/page.tsx` (1337) | PDV | 🟠 | **4 pravno odvojena poreska registra** (KIF, KUF, POPDV, KEPU) koje knjigovođa koristi nezavisno — u jednoj komponenti sa jednim skupom `useState`-a i toolbarom koji je kaskada `view === 'kif' ? … : view === 'kuf' ? …`. Otvaranje KEPU-a drži KIF/KUF/returns u memoriji. PDV aritmetika (`bridgeGrossToNet`, `:1032`) sedi u page komponenti umesto u `lib/`, gde bi se testirala. |
| `app/reversi/_components/issue-dialog.tsx` (1212) | Reversi → Izdaj alat | 🟠 | **~9 ekrana, 31 `useState` u jednoj funkciji** (najveća gustina state-a u repou). Matrica 2×2 (skener \| ručno × alat \| kooperacija) plus trokoračni čarobnjak, sve kao uslovi. **Dva odvojena `submit` puta** (`:533` i `:601`) koji već drifuju — poruka „Dodaj bar jedan alat." postoji na tri mesta. `reset()` je `useCallback` od 42 linije preko svih 31 settera; jedan zaboravljen = klasičan bug „podaci prethodnog reversa procure u sledeći". |
| `app/fakturisanje/detalj/page.tsx` (1026) | Fakturisanje → detalj | 🟠 | **~5 ekrana.** 4 nezavisne banner state-mašine (SEF / mejl / storno / avans) dele isto vizuelno mesto bez ičega što nameće isključivost — posle storna koji sledi neuspeli enqueue mogu se prikazati dva odjednom. Globalni `Ctrl+S` sloj mora ručno da zna da li je dijalog otvoren, pa svaki nov dijalog u fajlu mora da se seti da učestvuje u tom guardu. |

### Tier 2 — najbliži Tier 1 uprkos manjem broju linija

| fajl (linije) | odgovornosti |
|---|---|
| `app/mob/energetika/_components/views.tsx` (908) | **5 potpuno različitih SCADA ekrana** (`Kot1View`, `Kot2View`, `Kot3View`, `SigenView`, `KacoView`) + `OverviewView` + dispečer + 6 widgeta |
| `app/odrzavanje/_components/masina-karton.tsx` (999) | **6 tabova** + `MachineAdmin` + `OverrideEditor` + 4 dijaloga + `TaskForm` — ceo podmodul u jednom fajlu |
| `app/odrzavanje/_components/vozilo-karton.tsx` (866) | **5 tabova** + 2 ulazne tačke + 6 formi + upload fotografija |
| `app/reversi/_components/tool-detail-dialog.tsx` (986) | 4 taba + `LedgerTable` + 2 form-dijaloga |
| `app/zahtevi/detalj/_components/action-bars.tsx` (881) | 3 akcione trake + mapiranje status→akcija + **6 dijaloga** |
| `app/podesavanja/_components/competence-editor.tsx` (786) | editor + **5 modala** + 3 graditelja view-modela |
| `app/kvalitet/_components/skart-dorada-tab.tsx` (783) | **3 pogleda** (Evidencija / Red / Pareto) + 3 dijaloga |
| `app/kiosk/_components/kiosk-scanner.tsx` (953) | jedna komponenta od 850 linija: skener + auto-logout + state-mašina naloga + terminal UI, gotovo bez dekompozicije |
| `app/reversi/_components/rezni-alat-tab.tsx` (1043) · `app/sastanci/_components/sastanak-detalj.tsx` (928) · `app/tech-processes/_components/tech-process-card-detail.tsx` (926) · `app/fakturisanje/avansi/advance-dialogs.tsx` (898) · `app/lokacije/_components/predmet-tab.tsx` (871) · `app/profil/_components/team-section.tsx` (827) · `app/mob/odsustva/page.tsx` (827) · `app/podesavanja/_components/predmet-aktivacija-tab.tsx` (790) · `app/montaza/_components/izvestaj-wizard.tsx` (766) · `app/kadrovska/_components/employee-form.tsx` (763) · `app/placanja/page.tsx` (750) · `app/kadrovska/_components/grid-tab.tsx` (750) | 5-16 odgovornosti svaki |

---

## TOP 15 po vrednosti popravke

Trud: **S** ≤ pola dana · **M** 1-3 dana · **L** > 3 dana.

| # | Nalaz | Trud | Dobit |
|---|---|---|---|
| 1 | `app/zahtevi/page.tsx:306,516` — Inbox: prosledi `status` na server umesto klijentskog filtera i **vrati Pager** na tom tabu | **S** | 🔴 Admin prestaje da gubi zahteve. Badge „Inbox (63)" i sadržaj tabele se poklope. Jedna izmena od ~5 linija zatvara najozbiljniji nalaz izveštaja. |
| 2 | `app/zavrsni-racun/page.tsx:288,300,313` — obradi `controls.isError` i **blokiraj finalizaciju** kad kontrole nisu učitane | **S** | 🔴 Sprečava finalizaciju neprovereog bilansa koja se ne može ponoviti. Direktan regulatorni rizik. |
| 3 | `app/fakturisanje/detalj/page.tsx:307,506` — uključi `sefOutbox.isError` u guard dugmeta „Pošalji na SEF" | **S** | 🔴 Sprečava dvostruko slanje e-fakture Poreskoj upravi kad upit padne. |
| 4 | `app/saldakonti/compensation-panel.tsx:142` — dodaj `proposal.isError` u `err` izraz | **S** | 🔴 Knjigovođa prestaje da vidi „nema šta da se prebije" umesto poruke o grešci. |
| 5 | Proširi postojeći `tableEmpty(isError, …)` (`odrzavanje/_components/common.tsx`) na svih **30 ekrana** sa neobrađenom greškom upita — počni od 12 finansijskih | **M** | 🟠 Najveći odnos dobiti i truda u izveštaju: helper i obrazac već postoje i dokazani su na 2 mesta. Uklanja celu klasu „prazna tabela laže da nema podataka" — duplirane blagajne, duple narudžbenice, ponovljeni FX obračuni. |
| 6 | Dodaj `page`/`pageSize` u `useLager`, `useOpenItems`, `useKif`/`useKuf`/`useKepu`, `usePartnerCard` + `<Pager>` u 5 ekrana (usklađeno sa backendom) | **L** | 🟠 Skida najveće tabele baze (`StockLevel` ~92k artikala, otvorene stavke, poreske knjige) sa „sve odjednom". Bez ovoga lager i saldakonti postaju neupotrebljivi rastom, ne bugom. Usput zatvara i kalibracioni slučaj filtriranja posle `LIMIT`-a. |
| 7 | Izvuci `useSaveShortcut(onSave)` hook u `src/lib/` i zameni **24 kopirana** inline handlera | **S** | 🟡 Jedno mesto istine za `Ctrl+S`. Preduslov za #8 — bez njega je 133 popravke, sa njim je 133 poziva jedne linije. |
| 8 | Primeni `useSaveShortcut` na **top 20** form-dijaloga (Radni nalozi 5, Održavanje/Zalihe 4, Reversi Izdaj, Plaćanja Virman, Kadrovska Grid/Odsustva/Zarade, Profil Godišnji/Kucanje, Primopredaje Nacrt, Sastanci 4) | **M** | 🟡 Pravilo 7 postaje istinito tamo gde se najviše kuca. Access/Pantheon navika radnika prestaje da propada na pregledačev „Sačuvaj stranicu kao…". |
| 9 | `app/artikli/_forma/polja.tsx:394,551` — poveži `Ctrl+S` i dugme „Snimi" sa stvarnom mutacijom (ili skini lažnu poruku sa `:543`) | **S** | 🟠 Uklanja **pokvarenu**, ne samo odsutnu prečicu, i tekst koji korisniku obećava ponašanje koje ne postoji. Mina koja čeka otvaranje brane. |
| 10 | `app/kadrovska/_components/razvoj/shared.tsx:196` — prebaci `WideModal` na `useEscapeLayer` (ili na kit `Dialog size="xl2"`) | **S** | 🟠 Zatvara regresiju „jedan Esc zatvori dva sloja i pojede unos" u 6 HR editora — tačno bug protiv kog `escape-layer.ts` postoji. |
| 11 | `app/kiosk-prisustvo/_components/kiosk-punch-scanner.tsx` — tokenizuj 9 hex + 3 rgba vrednosti | **S** | 🟡 Jedini potpuno netokenizovan ekran u aplikaciji; radnik na kapiji dobija isti brend kao ostatak. Jedan fajl = 12 od 43 nalaza pravila 1. |
| 12 | Tokenizuj 3 palete-konstante: `odmori/helpers.ts:24-42`, `competence-editor.tsx:42-46`, `assessment-section.tsx:35-37` (+ izbaci emoji iz `REVIEW_FLAG_BADGE`) | **S** | 🟡 Tri male datoteke hrane ~10 inline `style` poziva → zatvara **30 od 43** nalaza hex boja. Popravlja i to što ista kompetencija ima različitu boju kod zaposlenog i kod admina, i gazi §2 zabranu emoji-ja. |
| 13 | `app/odrzavanje/_components/dokumenta-tab.tsx:70,232` — pomeri filtere kategorije/roka i spajanje vozila na server | **S** | 🟠 Filter „istekli" na registru atesta počinje da nalazi sve istekle dokumente, ne samo one na tekućoj strani. Compliance ekran. |
| 14 | Razbij `components/ui-kit/app-shell.tsx` (1749) — izdvoj `NotificationBell` (216-399) i objedini dve navigacione implementacije iza jednog modela reda | **L** | 🟠 Najveći radijus rizika u repou (68 uvoza). Uklanja obavezu da se svaka nav izmena piše dvaput i skida notifikacioni sloj sa svake rute. |
| 15 | `app/lokacije/_components/predmet-tab.tsx:89` — prebaci `openDrawingByNumber` u `src/api/pdm.ts` hook i zameni `alert()` sa `Toast` | **S** | 🟠 Uklanja jedini blokirajući native `alert()` u aplikaciji, dodaje keš i retry, i vraća poziv pod pravilo 8. |

### Ne raditi

- **Deljenje `api/*.ts` fajlova** — provereno, ravni katalozi hookova; efektivna jedinica ~10 linija, tree-shaking radi. Izuzeci vredni S truda: preseli `vacationRemaining()` iz `api/moj-profil.ts:90` u `lib/`, i podeli `api/kadrovska.ts` po banerima P5/P8/P11 koji već postoje u fajlu.
- **Masovna migracija ~290 sirovih `<select>` elemenata** — DESIGN_SYSTEM §10 izričito propisuje postepen prelaz „kad se taj ekran ionako dira".
- **`tracking-[0.08em]`** (~40 pojava) — de-facto konvencija; promovisati u token, ne prijavljivati kao 40 prekršaja.
- **`ScanReticle` / `HelpTour` fiksne boje** — DESIGN_SYSTEM §10 ih izričito izuzima (stoje preko slike kamere).
