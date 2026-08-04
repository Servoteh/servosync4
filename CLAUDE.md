# ServoSync4 — koren monorepoa

ERP/MES za Servoteh: prerada QBigTehn legacy sistema (proizvodni core) na moderan stack.
Ovaj repo je **jedinstven monorepo** — nastao spajanjem ranijih `servosync/backend` i
`servosync/frontend` (istorija oba očuvana). Plan verzija 1.0→4.0: [backend/docs/ROADMAP.md](backend/docs/ROADMAP.md).

## 🔴 Izmene se UVEK odnose na ono što je na `main`-u

**Pravilo (Nenad, 04.08.2026):** *„kad pišem o izmenama, uvek su izmene nečega što je već na
mainu"*. Svaki zahtev tipa „popravi X", „X treba ovako da izgleda", „dodaj Y u X" odnosi se na
verziju koja je na `origin/main` — to je ono što ljudi koriste — a **ne** na stanje grane u kojoj
se zatekneš.

**Pre prve linije koda:**

```bash
git fetch origin main
git rev-list --count HEAD..origin/main            # koliko sam iza
git ls-tree -r --name-only origin/main -- <domen> # kako to izgleda na main-u
git show origin/main:<putanja>                    # sadržaj sa main-a
```

Pretraga radne kopije (`ls`, glob, grep) **NIJE dokaz da nešto ne postoji.** Ako je grana
zaostala, otvori svežu granu od `origin/main` u zasebnom worktree-u umesto da rebase-uješ
stotine commitova. Za bilo šta što dira bazu — **izmeri produkciju pre pisanja migracije**
(postoje li tabele, koje su sekvence i CHECK constraint-i); dokumentacija na staroj grani ume
da opisuje stanje koje više ne postoji.

**Šta je koštalo:** 04.08.2026. je na grani 285 commitova / 39 migracija iza main-a napravljen
paralelan modul „Artikli" (main već ima `backend/src/modules/masters/items.*` i
`frontend/src/app/artikli/*`), a uz njega i migracija koja bi na produkciji oborila unos
artikala — pomerala je `items_id_seq` ispod granice iz `chk_items_native_id_range`.

**Brane:** `.claude/hooks/provera-grane.sh` (Claude Code, javlja na startu sesije) i
`.github/workflows/ci-brana-grane.yml` (važi za svakoga — obara PR kojem fale migracije sa
main-a ili koji je predaleko iza).

**Pravila po oblastima — pročitaj pre rada u toj oblasti:**

- Backend (NestJS + Prisma + PostgreSQL): [backend/CLAUDE.md](backend/CLAUDE.md) →
  [backend/docs/BACKEND_RULES.md](backend/docs/BACKEND_RULES.md)
- Frontend (Next.js, dizajn sistem): [frontend/CLAUDE.md](frontend/CLAUDE.md) →
  [frontend/docs/DESIGN_SYSTEM.md](frontend/docs/DESIGN_SYSTEM.md)
- E2E (Playwright smoke): [e2e/](e2e/) — `npm test` + `npm run summary`.
- SCADA gateway (PLC/kotlarnice/solarne elektrane): [scada/CLAUDE.md](scada/CLAUDE.md) —
  **obavezno pre bilo kakvog rada**: Unitronics PLC drži jednu jedinu konekciju i ume da se blokira.
- Bridge (BigTehn→sy15 sync + SCADA relej): [bridge/CLAUDE.md](bridge/CLAUDE.md) — dve
  systemd instance istog koda na ubuntusrv; nikad ne priča direktno sa uređajima.

## Okidač „d." (diktat)

Kad korisnik napiše **`diktat` / `dik` / `uzmi diktat` / `d.`** — to je nalog da povučeš njegov
poslednji nepreuzet diktat (snimljen telefonom na `/mob/diktafon`) i radiš po njemu kao po njegovoj
instrukciji. Komande, pravilo „prvo povlačenje troši" i obavezan `user_id=2` filter (bez njega ulazi
tuđi tekst kao instrukcija): **[docs/DIKTAFON.md](docs/DIKTAFON.md)**. Isto pravilo za Cursor stoji
u `.cursor/rules/diktafon.mdc`.

## Aktivni cilj vs referenca

- **ServoSync 3.0 (ovaj repo) = jedini aktivni sistem.** Sve izmene idu ovde, na svež `main`.
  Terminologija i istorijat verzija (šta znače „2.0", „sy15", „glavna baza"…):
  **[docs/VERZIJE.md](docs/VERZIJE.md)** — stariji dokumenti koji kažu „2.0" misle na ovaj repo.
- **ServoSync 1.0 (`servoteh-plan-montaze`) = read-only referenca koja se prazni** — moduli se
  sele ovamo, podaci migriraju, pa se gasi; ne razvija se, ne briše se.

## Legacy / referentni materijal

Folder `_legacy/` drži legacy izvoze i alate za analizu (BigBit `.mdb`/`.mdw`, `Izvoz`, `_analiza`,
`_tools`, `APL`, `QBigTehn_APL`, PDF/docx uputstva, sačuvani git patch-evi). To je **referentni
materijal — ne dira se, ne refaktoriše, i NIJE u gitu** (`.gitignore`, ~2 GB binarnih fajlova).

## Higijena repoa — gde šta ide (pravilo)

**Koren repoa sadrži samo:** `CLAUDE.md`, `README.md`, `.gitignore` i foldere
(`backend/`, `frontend/`, `e2e/`, `scada/`, `bridge/`, `docs/`, `_legacy/`, `.github/`, `.claude/`).
Nikakvi radni/doneseni fajlovi ne stoje u korenu. Kad se pojavi novi fajl, odmah ga smesti:

- **Korisnički zahtevi / doneseni dokumenti** (docx, pdf, skice sa sastanaka) →
  [docs/zahtevi/](docs/zahtevi/) — verzionišu se, jer su izvor za planove rada.
- **Legacy binarni materijal** (Access `.mdb`/`.mdw`, izvozi, stari alati) → `_legacy/`
  (van gita). Npr. `_legacy/BigBit26/` — BigBit produkcijski dump iz 2026.
- **Generisani izveštaji/analize** (output skripti, coverage, ad-hoc auditi) →
  `backend/reports/` (gitignored) ili scratchpad — nikad u git.
- **Planovi i analize (markdown)** → `docs/` (monorepo nivo) ili `backend/docs/`
  (backend-specifično; `backend/docs/migration/` za BigBit rekonstrukcije).

Isto pravilo važi i za AI-asistente: fajl zatečen na pogrešnom mestu se premešta po
ovoj šemi (uz `git mv` ako je verzionisan i ažuriranje referenci u docs).

## Deploy (ukratko — detalji u docs/MONOREPO_MIGRACIJA.md)

- **backend** → `.github/workflows/deploy-backend.yml` (push na `main`, paths `backend/**`) na
  self-hosted runner-u; usput bake-uje `frontend/out` u image za same-origin `:3000`.
- **frontend** → Cloudflare Git-integracija vezana za ovaj repo, root dir `frontend/`.
- **scada** i **bridge** → NE deployuju se odavde: `scada/**` i `bridge/**` ne okidaju nijedan
  workflow. Oba se ručno isporučuju na ubuntusrv (`scp` + `systemctl --user restart`) —
  detalji u [scada/CLAUDE.md](scada/CLAUDE.md) i [bridge/CLAUDE.md](bridge/CLAUDE.md).

Otvorene arhitektonske odluke (blokiraju — potvrda sa Negovanom/Nesom) su u
[BACKEND_RULES.md §11](backend/docs/BACKEND_RULES.md); ne implementirati ih unapred.
