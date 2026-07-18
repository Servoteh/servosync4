# e2e — Playwright smoke (ServoSync 2.0)

Samostalan klik-test proda: prolazi kroz sve module i proverava da nema crash/5xx/console grešaka.

## Pokretanje

```bash
npm ci
npm test          # smoke svih modula
npm run summary   # zbirni izveštaj (summarize.mjs)
```

Net-zero write probe (proverava da read-only prolazi ništa ne upisuje):

```bash
npm run summary   # posle netzero probe-ova; vidi summarize-netzero.mjs
```

## Kredencijali

Test nalog se čita iz **`../frontend/.env.test.local`** (nije u ovom folderu, nije u gitu).
Login state se kešira u `.auth/` (gitignored). Cilj: `servosync.servoteh.com` (prod) — vidi `playwright.config.ts`.

## Struktura

- `tests/` — `auth.setup.ts` (login), `modules.smoke.spec.ts`, `core-read.spec.ts`, `netzero/`, `diag/`
- `utils/` — deljeni helperi
