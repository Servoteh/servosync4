# Deploy smoke — monorepo (servosync4)

Beleške o test-deplojevima iz monorepoa `Servoteh/servosync4`.

- **2026-07-18** — Faza 3A4: prvi test-deploj backend-a iz servosync4 monorepoa. Isti kod (`f852a75`),
  cilj = potvrda da adaptiran `.github/workflows/deploy-backend.yml` prolazi na `servosync4-onprem` runner-u
  (nova `backend/**` putanja, `working-directory: backend`, frontend bake iz `../frontend`, rsync, compose).
