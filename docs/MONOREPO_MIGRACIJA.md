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
| frontend (glavni prod) | Cloudflare Git-integracija na `servosync/frontend` | **GitHub Actions `deploy-frontend.yml` + `wrangler deploy`** iz servosync4 (bez CF Git-integracije) |
| runner | registrovan na `servosync/backend` | drugi runner `servosync4-onprem` na .28 (paralelno) |

## Faza 2 — GitHub repo ✅ URAĐENO 18.07

Repo: **`Servoteh/servosync4`** (org `Servoteh`, ne `servosync`). `git push -u origin main` prošao —
635 commit-a, `main` = `041b60c`.

> ⚠️ ZAMKA: `Servoteh/servosync` (bez „4") je **ServoSync 1.0** (`plan-montaze`, 152 grane, živa iframe kapija) —
> NE gurati ništa tamo. Monorepo je `Servoteh/servosync4`.

Preostalo iz Faze 2: **Lukin pristup** (write/maintain) na `Servoteh/servosync4` — Nenad daje naknadno.
Napomena: backend/frontend izvorni repoi su pod `servosync` org, monorepo i 1.0 pod `Servoteh` org (dva orga).

## Faza 3 — prebacivanje deploya ✅ URAĐENO 18.07

**3A — Backend runner + deploj.** Drugi self-hosted runner `servosync4-onprem` na `.28`
(`/home/admluka/actions-runner-servosync4`, radi kao admluka, labela `servosync`), **paralelno** sa
starim `servosync-backend` runnerom → nula downtime. Test-deploj backend iz servosync4 = **Succeeded**
(health `api:200 login:200`). Adaptiran `deploy-backend.yml` radi (bake iz `../frontend`, bez `FRONTEND_REPO_TOKEN`).
- Setup runnera: skripta `/tmp/setup-runner-servosync4.sh <token>` (jer paste dugačke komande u PowerShell
  puca na `&&` i seče linije; admnenad nema passwordless sudo → korisnik kuca lozinku u SVOM terminalu).

**3B — Frontend deploj (bez CF Git-integracije).** Umesto re-pointa Cloudflare Git-integracije (koja je
zapinjala na GitHub App pristupu `Servoteh` org-u), front se deployuje iz monorepoa preko
`.github/workflows/deploy-frontend.yml` → `npm ci && next build && wrangler deploy` u node containeru na
istom runneru. Deployuje isti Worker **`servosync2`** (isti domeni). Test-deploj = **Succeeded**, sajt živ.
- Zahteva repo secret **`CLOUDFLARE_API_TOKEN`** (Account > Workers Scripts > Edit). Account ID
  `e2f616e00cb68d6485f93a6be4dfb14b` je u workflow-u (nije tajna).
- **Dugoročno bolje** od CF Git-integracije: sve u jednom repou, bez zavisnosti od CF↔GitHub app pristupa.

> Napomena: stara CF Git-integracija na `servosync/frontend` je i dalje povezana (deployovala bi `servosync2`
> na push tamo). Od sad se front gura na **servosync4**; staru vezu diskonektovati u Fazi 4.

## Faza 4 — zatvaranje (posle uspešnog test-deploja)

1. **Diskonektuj CF Git-integraciju** na `servosync/frontend` (Worker `servosync2` → Settings → Build →
   Disconnect) da ne bi imali dva izvora deploya za isti worker.
2. Ugasi stari runner `servosync-backend` na `.28` (`sudo ./svc.sh stop && uninstall`) kad backend ide samo iz servosync4.
3. Arhiviraj (read-only) `servosync/backend` i `servosync/frontend` na GitHub-u.
4. Očisti mrtve lokalne grane (40+ po repou) — kreni čist od `main` na servosync4.
5. Fizički prebaci ~2 GB legacy materijala u `servosync4/_legacy/` (ostaje van gita).
6. `servosync4/` postaje glavni radni checkout; stari `Servosync 2.0/` folder ostaje kao backup dok se
   sve ne potvrdi, pa se briše.

## Sačuvano iz starog checkout-a (Faza 0)

- `_legacy/_patches/backend-wave3-uncommitted-*.patch` — neuknjižene izmene starog `feat/wave-3` (delom CRLF šum).
- `_legacy/_patches/frontend-montazafe-uncommitted-*.patch` + `_legacy/plan-docs-frontend/*` — FE WIP + plan doci.
- Git stash-evi u starim repoima (`git stash list`) — dodatna sigurnosna mreža.
- **`feat/montaza-fe`** (Plan montaže modul + PDF Gantt, commit `bcfb923`) — **nije na main / nije deployovan**;
  živi na `origin/feat/montaza-fe`. Odluka: merge u main ili cherry-pick u servosync4 kasnije.
