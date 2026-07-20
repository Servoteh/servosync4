# Modul Nabavka (frontend) — NACRT (Traka B §B)

> **Status:** skele spremne, **NIJE aktivirano.** Fajlovi imaju ekstenziju `*.nacrt` →
> van Next/TypeScript build-a (App Router indeksira samo `page.tsx`, ne `page.tsx.nacrt`),
> da referentna skela ne obori tipecheck dok permisija `NABAVKA_READ` i backend modul
> nisu aktivirani. Prati backend nacrt: `backend/src/modules/nabavka/*.nacrt`.

## Šta je ovde

| Fajl | Uloga |
|---|---|
| `../../api/nabavka.ts.nacrt` | TanStack Query hook-ovi + tipovi (envelope `{data,meta}`, status-mašina) |
| `page.tsx.nacrt` | Ekran „Lista" (DESIGN_SYSTEM §4.1) — radna lista zahteva, server-side paginacija |
| `README.nacrt.md` | ovaj fajl — aktivacioni checklist |

### Hook-ovi (`@/api/nabavka`)

| Hook | Ruta (backend nacrt) | Napomena |
|---|---|---|
| `useNabavkaRequests(filters)` | `GET /v1/nabavka/requests` | filter `status`/`projectId`, paginacija `skip`/`take`, envelope `{ data, meta: { total } }` |
| `useCreateRequest()` | `POST /v1/nabavka/requests` | zaglavlje + stavke; broj „NNNN/god" server; `NABAVKA_WRITE` |
| `useSubmitRequest()` | `POST /v1/nabavka/requests/:id/submit` | DRAFT → SUBMITTED; `NABAVKA_WRITE` |
| `useApproveRequest()` | `POST /v1/nabavka/requests/:id/approve` | SUBMITTED → APPROVED; `NABAVKA_APPROVE` |
| `useSendRfq()` | `POST /v1/nabavka/requests/:id/send-rfq` | upit + auto-mail; slanje ne obara radnju; `NABAVKA_WRITE` |

> **Envelope napomena:** za razliku od `tech-processes`/`handovers` (`meta.pagination`
> sa `page`), backend `nabavka` nacrt paginira preko `skip`/`take` i vraća samo
> `meta.total`. Hook prevodi 1-baznu `page` u `skip`; UI računa strane iz `total`+`take`.
> Kad se backend envelope uskladi sa ostatkom (ako se odluči tako), promeniti oba mesta.

## Kanonska mapa statusa (DESIGN_SYSTEM §7) — DODATI PRE AKTIVACIJE

`StatusBadge` i §7 još **nemaju NABAVKA domen.** `page.tsx.nacrt` privremeno koristi
lokalni `statusMeta()` koji mapira NABAVKA status na **postojeće** tonove (bez novih
boja/tokena — tvrdo pravilo kita se poštuje). Pre aktivacije dodati u §7 tabelu ove
redove (nova vrsta statusa ulazi u mapu PRE upotrebe u kodu):

| Domen | Status | Boja | Token |
|---|---|---|---|
| Nabavka / zahtev | U pripremi (`DRAFT`) | neutralna | `--status-neutral` |
| Nabavka / zahtev | Predat (`SUBMITTED`) | narandžasta | `--status-warn` |
| Nabavka / zahtev | Odobren (`APPROVED`) | zelena | `--status-success` |
| Nabavka / upit | Upit poslat (`SENT`) | info plava | `--status-info` |
| Nabavka / narudžbenica | Primljeno (`RECEIVED`) | zelena | `--status-success` |

Posle unosa u §7 — po želji preseliti mapiranje iz `statusMeta()` (page) u zajednički
helper ili u `StatusBadge` (ako se uvede „nabavka" string mod), pa obrisati lokalni
`statusMeta`.

## UI kit — potrebno JE sve već u kitu

Ekran koristi isključivo postojeće kit komponente — **ništa novo se ne dodaje u kit:**
`AppShell` · `PageHeader` · `DataTable` · `StatusBadge` · `EmptyState` · `Pager` · `Select`.
(Kad stigne forma za kreiranje/odobravanje zahteva — `Dialog`/`FormField`/`ComboBox`/
`Textarea`/`Button` iz kita, i dalje bez novih komponenti.)

## Aktivacija (checklist)

1. **Backend prvo:** aktiviraj `backend/src/modules/nabavka` po njegovom
   `README.nacrt.md` (Prisma modeli, migracija, preimenovanje `*.ts.nacrt` → `*.ts`,
   registracija modula). FE bez backenda nema šta da zove.
2. **Permisije (mirror):** u `backend/src/common/authz/permissions.ts` dodaj
   `NABAVKA_READ`/`NABAVKA_WRITE`/`NABAVKA_APPROVE` (+ role mapiranje), pa **mirror**
   u `frontend/src/lib/permissions.ts`:
   ```ts
   NABAVKA_READ: 'nabavka.read',
   NABAVKA_WRITE: 'nabavka.write',
   NABAVKA_APPROVE: 'nabavka.approve',
   ```
3. **Statusi §7:** dodaj NABAVKA redove iz gornje tabele u `DESIGN_SYSTEM.md §7`
   (i po želji u `StatusBadge`).
4. **Preimenuj `.nacrt` → prava ekstenzija:**
   - `src/api/nabavka.ts.nacrt` → `src/api/nabavka.ts`
   - `src/app/nabavka/page.tsx.nacrt` → `src/app/nabavka/page.tsx`
   - `src/app/nabavka/README.nacrt.md` → `src/app/nabavka/README.md`
5. **Gate strane (opciono, preporučeno):** kad `PERMISSIONS.NABAVKA_READ` postoji,
   zaštiti stranu kao ostali moduli (npr. `<Can permission={PERMISSIONS.NABAVKA_READ}>`
   ili redirekcija pri nedostatku prava; obrazac vidi u drugim ekranima).
6. **Otključaj modul u navigaciji:** u `src/lib/navigation.ts`, domen
   `prodaja-nabavka`, otkomentariši stavku „Nabavka":
   ```ts
   { label: 'Nabavka', href: '/nabavka', icon: PackageCheck, requires: PERMISSIONS.NABAVKA_READ, keywords: ['nabavka', 'upit', 'narudzbenica', 'dobavljac'] },
   ```
   (`PackageCheck` je već u import-u `navigation.ts`.)
7. **Tipecheck/lint** (`npm run typecheck` / `lint` u `frontend/`) i responsive
   provera (§11: 360/768/1024/1440 px).

## Sledeći koraci (van ove skele)

- Forma „Novi zahtev" (Dialog + FormField/ComboBox za predmet+stavke, `useCreateRequest`).
- Akcije po redu / detalj panel: Predaj (`useSubmitRequest`), Odobri (`useApproveRequest`,
  iza `<Can NABAVKA_APPROVE>`), Pošalji upit (`useSendRfq`) — svaka iza svoje permisije.
- Enrich reda predmetom (broj/naziv komitent) kad backend vrati `project` u redu —
  zameniti prikaz gole `projectId` šifre.
