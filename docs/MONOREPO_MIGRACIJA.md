# Migracija u monorepo (servosync4)

Dnevnik spajanja `servosync/backend` + `servosync/frontend` u jedinstven repo **servosync4**,
uz očuvanu git istoriju oba. Cilj: jedan čist repo, bez prekida proda.

## Princip: nula downtime

Stara dva repoa **nastavljaju da deployuju** dok se nov monorepo pipeline ne dokaže test-deploj-em.
Tek kad prođe → prebacimo Cloudflare + runner na servosync4 → arhiviramo stare repoe.

## Kako je monorepo napravljen (Faza 1 — urađeno lokalno)

- `git init -b main` u `servosync4/`.
- Root skelet: `.gitignore` (ignoriše `/_legacy/`), `README.md`, `CLAUDE.md`, ovaj dok,
  `.github/workflows/deploy-backend.yml`.
- Backend istorija ubačena pod `backend/` **read-tree receptom** (očuvana istorija):
  `git merge -s ours --allow-unrelated-histories be/main` + `git read-tree --prefix=backend/ -u be/main`.
- Frontend istorija ubačena pod `frontend/` istim receptom.
- `e2e/` (do sada nevezan folder) uveden u verziju.
- `_legacy/` ostaje na disku ali van gita.

Istorija se čita normalno: `git log -- backend/...` / `git log --follow backend/src/...`.

## Šta se promenilo u deploy-u

| | Pre (dva repoa) | Posle (servosync4) |
|--|--|--|
| backend | `servosync/backend` deploy.yml, push→main | `servosync4` deploy-backend.yml, push→main paths `backend/**` |
| frontend bake za `:3000` | zaseban checkout `servosync/frontend` + `FRONTEND_REPO_TOKEN` | `../frontend` u istom checkout-u — **token više ne treba** |
| frontend (glavni prod) | Cloudflare Git-integracija na `servosync/frontend` | Cloudflare Git-integracija na `servosync4`, **root dir `frontend/`** |
| runner | registrovan na `servosync/backend` | mora na `servosync4` (ili org-level) |

## Faza 2 — napraviti GitHub repo (RADI NENAD/LUKA)

1. Napravi prazan **privatan** repo `servosync/servosync4` (bez README/gitignore — push-uje se sve).
2. Daj Luki pristup (write/maintain), isto kao na backend/frontend repoima.
3. Javi — ja dodam `origin` i `git push -u origin main` (+ push `feat/montaza-fe` grane ako je zadržavamo).

## Faza 3 — prebacivanje deploya (RADI NENAD/LUKA, uz mene)

Sve dole je u dashboard-u / na serveru — ja to ne mogu odavde:

1. **Self-hosted runner** → registruj ga na `servosync4` (ili prebaci na org-level da važi za sve repoe).
   Labela ostaje `self-hosted, servosync`.
2. **Cloudflare** → u Git-integraciji front projekta: promeni repo na `servosync4`, postavi
   **root/build direktorijum = `frontend/`** (da CF bilduje podfolder). Build/deploy komande ostaju iste.
3. **Secrets** → na servosync4 nisu potrebni `FRONTEND_REPO_TOKEN` (izbačen). Provera da li deploy-backend
   traži još neki secret koji je bio na backend repou.
4. **Test-deploj**: gurni sitnu izmenu u `backend/**` i `frontend/**` → potvrdi da oba dižu
   (backend health-check + CF build zeleni; `:3000/login` = 200 znači front baked).

## Faza 4 — zatvaranje (posle uspešnog test-deploja)

1. Arhiviraj (read-only) `servosync/backend` i `servosync/frontend` na GitHub-u.
2. Očisti mrtve lokalne grane (40+ po repou) — kreni čist od `main` na servosync4.
3. Fizički prebaci ~2 GB legacy materijala u `servosync4/_legacy/` (ostaje van gita).
4. `servosync4/` postaje glavni radni checkout; stari `Servosync 2.0/` folder ostaje kao backup dok se
   sve ne potvrdi, pa se briše.

## Sačuvano iz starog checkout-a (Faza 0)

- `_legacy/_patches/backend-wave3-uncommitted-*.patch` — neuknjižene izmene starog `feat/wave-3` (delom CRLF šum).
- `_legacy/_patches/frontend-montazafe-uncommitted-*.patch` + `_legacy/plan-docs-frontend/*` — FE WIP + plan doci.
- Git stash-evi u starim repoima (`git stash list`) — dodatna sigurnosna mreža.
- **`feat/montaza-fe`** (Plan montaže modul + PDF Gantt, commit `bcfb923`) — **nije na main / nije deployovan**;
  živi na `origin/feat/montaza-fe`. Odluka: merge u main ili cherry-pick u servosync4 kasnije.
