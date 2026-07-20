# Recept M12 — preusmerenje 1.0 ekrana Praćenja na 3.0 (za cutover sesiju)

> **Za koga:** sesija koja drži granu `cutover/front-repoint` u repou `servoteh-plan-montaze` (1.0).
> **Odluka:** M12, 20.07.2026 (Nenad) — „ja dizajniram, cutover sesija izvodi".
> **Zašto:** 3.0 praćenje od 19.07. radi na glavnoj bazi i NE piše u sy15 → 1.0 ekran praćenja
> (desktop modul + mobilni `/m/pracenje`) prikazuje zamrznute podatke, a unosi u njemu idu u
> tabele koje niko ne čita. Sve reference dole su PROVERENE na živom kodu 20.07.2026
> (ranije reference iz `PLAN_F5_GASENJE_MOSTA.md` §3.2 bile su nevažeće — sekcija poništena).

## Obrazac koji se klonira (živ na produ od 10.07)

**Tehnologija pločica** = iframe celog 3.0 fronta + postMessage SSO handoff. Autoritativni opis:
3.0 repo `backend/docs/SSO_TEHNOLOGIJA.md`. Ključno:

- 1.0 strana: `src/ui/tehnologija/index.js` — render iframe-a ka `https://servosync2.servoteh.com`
  + parent listener (`ss2-sso-ready` → šalje `ss2-sso-token` sa 1.0 GoTrue JWT-om; listener se
  skida u teardown-u).
- 3.0 strana: NIŠTA se ne menja — `AuthProvider` handshake i `POST /api/auth/sso` već rade za
  ceo front (origin allowlist `SSO_PARENT_ORIGINS` već sadrži 1.0 origin-e).
- Uslov za korisnika: aktivan 3.0 nalog sa istim ličnim email-om (zajednički nalozi nemaju SSO).

## Izmene (1.0 repo)

1. **Desktop modul praćenja → iframe klon Tehnologije.**
   - Napravi `src/ui/pracenjeProizvodnje/iframe.js` po uzoru na `src/ui/tehnologija/index.js`,
     sa iframe `src = SS2 + '/pracenje-proizvodnje'` (+ prosleđivanje postojećih query
     parametara `?predmet=` / `?rn=` ako ih 1.0 ruta nosi — 3.0 ruta ih razume).
   - U `src/ui/router.js` granu koja montira postojeći desktop modul `pracenjeProizvodnje`
     preusmeri na novi iframe render; postojeći teardown lanac ostaje
     (`router.js:145-147` — `teardownPracenjeProizvodnjeModule` zameni teardown-om iframe-a).
   - Stari modul fajlovi (`src/ui/pracenjeProizvodnje/*`) se NE brišu (konvencija cutover-a).
2. **Mobilni `/m/pracenje` → isti iframe obrazac** (NE goli redirect — postMessage SSO radi
   samo u iframe-u; redirect bi korisnika izbacio na 3.0 login).
   - `src/ui/router.js:914-915` — grana `screen === 'pracenje'`
     (`result = renderMyPracenje(mountEl, navCtx)`) zameni renderom mobilnog iframe-a ka
     `SS2 + '/m/pracenje'`; ukloni import `renderMyPracenje` (`router.js:77`).
   - Pločica u `src/ui/mobile/mobileAppShell.js` ostaje (router presreće); opciono „v2" oznaka.
3. **`SHELL_SCREENS`** (`router.js:1209`) — `'pracenje'` ostaje u listi (ekran i dalje postoji,
   samo mu je sadržaj iframe).

## Verifikacija (pre merge-a u 1.0 main)

- Desktop: HUB → Praćenje proizvodnje → učitava 3.0 ekran ULOGOVAN (bez kucanja lozinke);
  podaci su SVEŽI (uporedi neki RN kucan posle 14.07 — u zamrznutoj verziji ga nema).
- Mobilni: telefon → `/m/pracenje` → 3.0 mobilni ekran ulogovan; sken/undo tok radi.
- Korisnik BEZ 3.0 naloga: iframe pokazuje 3.0 login (očekivano, kao Tehnologija) — po
  potrebi kreirati naloge pre deploy-a.
- Ostali 1.0 ekrani netaknuti (posebno Lokacije — kucanje polica mora raditi identično).

## Posle sletanja (javiti pracenje sesiji)

Kad ovo legne na 1.0 prod i prođe par dana bez žalbi → stiče se uslov za
`PLAN_F5_GASENJE_MOSTA.md` §3.3 (DROP sy15 `pracenje_*` tabela i RPC-ova, uz prethodni
pg_dump) — to izvodi pracenje sesija, ne cutover.
