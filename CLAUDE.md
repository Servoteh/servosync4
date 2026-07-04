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

## Kontekst projekta

- Backend: NestJS + Prisma + PostgreSQL u [../backend/](../backend/); roadmap u
  [../backend/docs/ROADMAP.md](../backend/docs/ROADMAP.md).
- Korisnici su proizvodnja/tehnologija u Servoteh-u — isti ljudi koriste ServoSync 1.0 i QBigTehn (Access).
  Kontinuitet i gustina su bitniji od "modernog izgleda".
- U verziji 3.0 se ~19 modula iz ServoSync 1.0 seli u ovaj frontend — sve što gradiš mora biti
  spremno da primi te module (zato je disciplina kita i tokena kritična).
