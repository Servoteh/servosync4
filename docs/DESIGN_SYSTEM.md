# ServoSync dizajn sistem — v0.1

> **Autoritativna pravila izgleda i ponašanja frontenda.** Važi za ServoSync 2.0 i sve buduće module
> (uključujući seobu 1.0 modula u verziji 3.0). Svaki ekran — pisao ga čovek ili AI — mora proći po ovim pravilima.
>
> **Odluka o pravcu (2026-07-04, Nenad):** sopstveni ServoSync dizajn sistem ("pravac C") — kontinuitet sa
> ServoSync 1.0, moderni alati. Od SAP Fiori-ja i Pantheona preuzimamo *obrasce* (gustina, tastatura-prvo,
> KPI pločice, filter bar, master–detalj), **ne izgled**.
> Vizuelno poređenje pravaca: https://claude.ai/code/artifact/27e2df4d-5082-4dee-92f2-ee51a88360c8
>
> **Kako se menja ovaj dokument:** pravilo se menja izmenom ovog fajla + tokena, nikad "izuzetkom u kodu".
> Dok izmena nije ovde, ne postoji.

---

## 1. Principi

1. **Kontinuitet sa 1.0** — korisnici su isti ljudi koji već rade u ServoSync 1.0 i QBigTehn-u.
   Nazivi, rasporedi i tokovi ne smeju bez razloga da odstupe od onoga što već znaju.
2. **Gustina bez zagušenja** — ovo je MES/ERP za proizvodnju: tabele su guste (34–36 px red),
   ali tipografski čitke. Beli prostor se troši na hijerarhiju, ne na dekoraciju.
3. **Tastatura-prvo** — svaki tok unosa mora biti izvodljiv bez miša (nasleđe Access/Pantheon kulture).
4. **Status se vidi iz aviona** — stanje naloga/operacije se čita na prvi pogled: pilule sa tačkom,
   semantičke boje, progres. Boja statusa ≠ boja akcenta.
5. **Jedan izvor istine za stil** — sve boje, razmaci, veličine žive u tokenima
   ([tokens.css](../src/styles/tokens.css)). Hex vrednost ili "magični px" direktno u komponenti = bug.

## 2. Stack (zakucano)

| Sloj | Izbor | Napomena |
|---|---|---|
| Framework | **Next.js** (App Router) + **TypeScript** | dogovoreno roadmap-om (3.0: "Postgres + NestJS + Next") |
| Stilovi | **Tailwind CSS** koji čita naše tokene | nikakav inline `style` osim dinamičkih vrednosti (npr. širina progres bara) |
| Komponente | **shadcn/ui** kao baza → naš kit u `src/components/ui-kit/` | shadcn se ne koristi "sirov" po ekranima, samo kroz kit |
| Tabele | **TanStack Table** (headless) kroz našu `DataTable` | server-side paginacija/sort |
| Server state | **TanStack Query** | jedini sloj koji priča sa NestJS API-jem |
| Forme | **react-hook-form + zod** | šeme validacije dele tipove sa API DTO-ima |
| Ikone | **lucide-react** | jedna familija ikona; bez emoji-ja u UI |

## 3. Tokeni (sažetak — izvor je `tokens.css`)

* **Akcenat:** teal `#0d9488` (hover `#0b7d73`, aktivno `#0a6b62`). Koristi se za: primarna dugmad,
  aktivnu navigaciju, selekciju, fokus. *Nigde drugde.*
* **Semantičke boje** (statusi, nikad dekoracija):
  info/u-toku `#1971c2` · upozorenje/čekanje `#e8890c` · uspeh/završeno `#2f9e44` · greška/kašnjenje `#d6453d`.
* **Neutrale:** hladno-sive sa blagim teal tonom (`#f4f6f8` pozadina — kalibrisano prema 1.0 svetloj temi,
  `#22282c` tekst, `#79878e` sekundarni tekst, `#e3e8e8` linije). Sidebar: tamni petrolej `#1a2b33`
  (v0.2: svetliji od prvobitnog `#16232a` da se petrolej ton vidi, a ne čita kao crn).
* **Tipografija:** sistemski stack `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`
  (aplikacija živi na Windows desktopima + tabletima). Skala: 12 / 12.5 / 14 / 16 / 20 / 24 px.
  Brojevi u tabelama i šifre: `font-variant-numeric: tabular-nums`.
* **Razmaci:** 4 px mreža (4/8/12/16/24/32). **Radijusi:** 7 px (kontrole), 9 px (kartice/paneli).
  **Senke:** minimalne — hijerarhija se pravi linijama i pozadinama, ne senkama.
* **Tamna tema:** tokeni su pripremljeni za nju, ali se ne isporučuje u 2.0 V1 (odluka se donosi u 3.0).

> ✅ v0.2 (2026-07-06): neutrale **kalibrisane prema 1.0 svetloj temi** (`legacy.css`): pozadina preuzeta
> 1:1 (`#F4F6F8`), sidebar posvetljen. **Akcenat ostaje teal** — odluka "pravac C": 1.0 se postepeno
> preborava ka 2.0 paleti (vidi `plan-montaze/docs/CURSOR_UI_USKLADJIVANJE_2.0.md`), ne obrnuto;
> narandžasti akcenat 1.0 (`#E8523A`) se NE preuzima. Promena tokena ovde = obavezan prenos u 1.0 port.

## 4. Raspored ekrana

* **AppShell** (uvek): levi sidebar 188–240 px sa modulima (Radni nalozi, Tehnološki postupci, PDM/Crteži,
  Nacrti, Primopredaje, Lokacije delova, MRP/Nabavka, Komitenti) + komandna traka gore
  (naslov, broj zapisa, globalna pretraga `Ctrl+K`, primarna akcija desno).
* **Tri obrasca ekrana** — svaki novi ekran je jedan od ovih, ništa četvrto bez izmene ovog dokumenta:
  1. **Lista** — filter bar + gusta tabela (+ opcioni KPI red iznad, max 4 pločice);
  2. **Master–detalj** — lista levo, detalj panel desno (288–320 px); selekcija reda puni panel;
  3. **Forma** — kratke forme (≤ 8 polja) u dijalogu, duge kao stranica sa sekcijama.
* Detaljniji pregled entiteta (RN sa operacijama, materijalom, dokumentima) = **object-page**:
  zaglavlje sa šifrom/statusom + tabovi sekcija (obrazac pozajmljen od Fiori-ja).

## 5. Tabele

* Red 34–36 px; zaglavlje 10.5 px uppercase, letter-spacing 0.08em, sekundarna boja teksta.
* Šifre (RN broj, šifra artikla) — `tabular-nums`, polu-bold, prva kolona.
* Status **uvek** kao `StatusBadge` pilula (tačka + tekst), nikad goli tekst u boji.
* Sortiranje klikom na zaglavlje; filter u filter baru iznad tabele, ne u zaglavlju kolona.
* Server-side paginacija i sort od prvog dana (tabele će imati desetine hiljada redova iz legacy-ja).
* Selekcija reda: pozadina `--selection` + 3 px akcentna traka levo. Dupli klik / Enter = otvori.
* Akcije po redu: max 2 ikonice na kraju reda, ostalo u `⋯` meni.

## 6. Forme

* Label **iznad** polja; obavezno polje označeno `*`; pomoćni tekst ispod polja, 12 px.
* Validacija: zod šema, poruke **na srpskom**, konkretne ("Rok ne može biti pre datuma otvaranja",
  ne "Nevalidna vrednost"). Greška se pokazuje uz polje, posle prvog blur-a.
* **Enter navigacija:** Enter vodi na sledeće polje (Access navika), `Ctrl+S` snima, `Esc` otkazuje
  (uz potvrdu ako ima izmena). Fokus posle otvaranja forme na prvom polju.
* Datumi: unos i prikaz `dd.MM.yyyy.` · brojevi: decimalni **zarez**, hiljade tačka (`1.234,56`) ·
  valuta: `1.234,56 RSD` · količine uvek sa jedinicom (`24 kom`, `12,5 kg`).
* Izvedena/read-only polja vizuelno različita (siva pozadina), nikad "disabled input" bez objašnjenja.

## 7. Statusi (kanonska mapa)

| Domen | Status | Boja | Token |
|---|---|---|---|
| RN / operacija | U pripremi | neutralna | `--status-neutral` |
| RN / operacija | U proizvodnji / U toku | info plava | `--status-info` |
| RN / operacija | Na čekanju | narandžasta | `--status-warn` |
| RN / operacija | Završen(o) | zelena | `--status-success` |
| RN | Kasni (rok probijen) | crvena | `--status-danger` |
| Sync (bb_sync) | Greška sinhronizacije | crvena | `--status-danger` |

Novi status = nova vrsta u ovoj tabeli **pre** upotrebe u kodu.

## 8. Tastatura

Globalno: `Ctrl+K` pretraga · `Alt+N` novi zapis u aktivnom modulu · `Esc` zatvori panel/dijalog.
U tabeli: `↑/↓` kretanje · `Enter` otvori · `Ctrl+F` fokus na filter.
U formi: `Enter` sledeće polje · `Ctrl+S` snimi · `Esc` otkaži.
**F-tasteri se ne koriste** (browser ih otima — F5 refresh); Access/Pantheon navike se mapiraju na Ctrl/Alt.
Svaka prečica se prikazuje u tooltip-u odgovarajuće kontrole.

## 9. Jezik, terminologija, ton

* UI jezik: **srpski, latinica**. Bez mešanja engleskog gde postoji domaći termin koji 1.0/QBigTehn već koristi.
* **Terminologija = QBigTehn/1.0 rečnik** (ljudi te reči već koriste): radni nalog (RN), tehnološki postupak (TP),
  primopredaja, komitent, predmet, nacrt, pozicija, operacija. Ne prevoditi u "work order" ni "klijent".
* Dugmad govore šta rade: "Snimi", "Otvori RN", "Štampaj nalepnicu" — ne "OK"/"Potvrdi" gde može konkretnije.
* Poruke o greškama: šta se desilo + šta korisnik može da uradi. Bez izvinjenja i bez tehničkog žargona
  (stack trace ide u log, ne korisniku).

## 10. UI kit (v1 spisak)

`AppShell` · `DataTable` · `FilterBar` · `KpiTile` · `StatusBadge` · `ProgressCell` · `DetailPanel` ·
`FormField` (+ `DateField`, `NumberField`, `SelectField`, `ComboBox`) · `Dialog` · `ConfirmDialog` ·
`Toast` · `EmptyState` · `PageHeader` · `Tabs`

**Pravilo kita:** ekrani se sklapaju **isključivo** od kit komponenti. Nova komponenta prvo ulazi u kit,
`/dev/ui` katalog i ovaj spisak — pa tek onda u ekran. "Privremeni div sa stilovima" ne postoji.

## 11. Pristupačnost i responsive

* Kontrast teksta min AA (4.5:1); fokus uvek vidljiv (akcentni prsten); sve interaktivno dostupno tabom.
* Ciljne platforme: desktop (primarno), **tablet u pogonu** (landscape, min 1024 px — master–detalj se
  slaže vertikalno), telefon (samo pregled/statusi, ne unos — puni mobilni UX se rešava u 3.0 sa iskustvom 1.0).
* `prefers-reduced-motion` se poštuje; animacije samo funkcionalne (otvaranje panela, toast), ≤ 200 ms.

## 12. Proces i kontrola

1. **`/dev/ui` katalog** — interna ruta sa svim kit komponentama u svim stanjima; obavezno se dopunjava
   uz svaku novu komponentu/stanje. Služi kao vizuelni review i smoke test.
2. **Review checklist za svaki novi ekran:** koristi samo kit? boje samo iz tokena? tastatura kompletna?
   formati datuma/brojeva? terminologija iz §9? status mapa iz §7?
3. **AI sesije** rade po [frontend/CLAUDE.md](../CLAUDE.md) koji upućuje na ovaj dokument — pravila su ista
   za ljude i za AI.
