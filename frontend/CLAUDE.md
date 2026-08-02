# ServoSync 2.0 — frontend (instrukcije za AI-asistiran razvoj)

Ovaj folder je frontend ServoSync 2.0 (Next.js + TypeScript). **Pre bilo kakvog UI posla pročitaj
[docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md)** — to je autoritativni pravilnik dizajna. Ova pravila
važe za svaku sesiju i svaki ekran, bez izuzetka.

## Tvrda pravila (kratka verzija pravilnika)

1. **Boje i veličine samo iz tokena** (`src/styles/tokens.css` / Tailwind klase izvedene iz njih).
   Hex vrednost, rgb() ili "magični px" direktno u komponenti/klasi = greška koju treba ispraviti, ne ponoviti.
2. **Ekrani se sklapaju isključivo od kit komponenti** (`src/components/ui-kit/`). Ako komponenta ne postoji:
   prvo je dodaj u kit + `/dev/ui` katalog + spisak u DESIGN_SYSTEM.md §10, pa je koristi.
3. **Svaki ekran je jedan od tri obrasca** (Lista / Master–detalj / Forma — DESIGN_SYSTEM.md §4).
   Novi obrazac zahteva izmenu pravilnika, ne improvizaciju.
4. **UI tekst na srpskom (latinica)**, terminologija iz QBigTehn/1.0 rečnika: radni nalog (RN),
   tehnološki postupak (TP), primopredaja, komitent, predmet, nacrt, pozicija, operacija.
5. **Formati:** datum `dd.MM.yyyy.` · decimalni zarez (`1.234,56`) · količine sa jedinicom (`24 kom`) ·
   šifre i brojevi u tabelama sa `tabular-nums`.
6. **Statusi samo kroz `StatusBadge`** i kanonsku mapu statusa (DESIGN_SYSTEM.md §7). Nova vrsta statusa
   prvo ulazi u mapu.
7. **Tastatura je deo definicije gotovog:** Enter-navigacija u formama, `Ctrl+S` snimi, `Esc` otkaži,
   `↑/↓` + `Enter` u tabelama. F-tasteri se ne koriste. Ekran bez tastature nije završen.
8. **Data sloj:** komponente ne zovu API direktno — sve ide kroz TanStack Query hook-ove u `src/api/`.
   Tabele su server-side paginirane od prvog dana.
9. **Bez novih zavisnosti** za UI (ikone: lucide-react; komponente: shadcn/ui kroz kit) bez izričitog
   odobrenja korisnika.
10. **NIKAD `[id]` ruta — aplikacija je `output: "export"`.** Detalj dokumenta je uvek statička ruta
    `/<modul>/detalj?id=N` uz `useIdParam()` iz `src/lib/use-id-param.ts`. Dinamički segment bez
    stvarnih `generateStaticParams` izveze samo placeholder fajl `_`, pa `/modul/12` u objavljenoj
    aplikaciji vraća **404** — backend mapira samo `/put` → `/put.html` i nema SPA fallback.
    Ovako je 5 finansijskih modula (~20 vrsta dokumenata) bilo neotvorivo do 27.07.2026, a i
    typecheck i build i deploy su pri tom bili zeleni. Provera: `find frontend/src/app -type d -name '[*'`
    mora biti prazno, a u `frontend/out` ne sme postojati nijedan fajl `_` / `_.html`.
11. **`/mob` je SCOPE instalirane aplikacije.** `public/mob.webmanifest` i service worker
    `public/mob-sw.js` drže scope `/mob`; instalirana PWA svaku navigaciju van scope-a otvara
    SPOLJA (iOS: Safari, koji od 16.4 ima odvojen storage → beskonačna petlja prijave). Zato
    `/mob` ekrani na istek sesije idu na **`/mob/prijava`, nikad na `/login`**, a svaki nov
    vanredni tok (prinudna promena lozinke i sl.) dobija svoju `/mob/*` rutu. Root prostor
    (`/sw.js`, `/m`, `/m/*`, `/assets/*`, `/icons/*`, `/manifest.webmanifest`) pripada
    ServoSync **1.0** — ni SW, ni keš, ni manifest 3.0 ga ne smeju dodirnuti.
12. **Filteri, strana i tab radne liste žive u URL-u** (`useListQueryState`), a „Nazad" sa detalja ide
    na `listHref('/modul')`. Bez toga povratak sa detalja remontira listu i briše filter i stranu —
    nad knjigom od 625 faktura to je stotine izgubljenih klikova po jednom PDV periodu.

## Kontekst projekta

- Backend: NestJS + Prisma + PostgreSQL u [../backend/](../backend/); roadmap u
  [../backend/docs/ROADMAP.md](../backend/docs/ROADMAP.md).
- Korisnici su proizvodnja/tehnologija u Servoteh-u — isti ljudi koriste ServoSync 1.0 i QBigTehn (Access).
  Kontinuitet i gustina su bitniji od "modernog izgleda".
- U verziji 3.0 se ~19 modula iz ServoSync 1.0 seli u ovaj frontend — sve što gradiš mora biti
  spremno da primi te module (zato je disciplina kita i tokena kritična).
