# MIGRACIONA DOKTRINA 3.0 — obavezna pravila za seobu SVAKOG 1.0 modula

**Verzija:** v1, 2026-07-12 · **Status:** USVOJENO (Nenad)
**Važi za:** sve buduće seobe 1.0 → 2.0 stack (Lokacije, Sastanci, … Kadrovska).
**Dokazano na:** Reversi pilot (uživo 11.07). **Izvršne sesije (Opus) OVO ČITAJU PRVO.**

---

## A. Arhitektonska pravila (dokazana pilotom — NE preispituju se po modulu)

1. **Podaci se NE sele.** Tabele modula ostaju u sy15 bazi; 2.0 backend ih čita/piše kroz
   drugi Prisma datasource (`prisma/sy15.prisma`, klijent `@prisma-sy15/client`).
   Konsolidacija baza = tek finalni 3.0 cutover, ne per-modul.
2. **GUC most čuva DB logiku netaknutu.** `Sy15Service.withUser/runIdempotent` postavlja
   `request.jwt.claims` (obavezno SA `sub` = `auth.users.id` po email-u — bez sub-a pada
   `auth.uid()`). Postojeće SECURITY DEFINER funkcije, RLS predikati i „moji/tim" view-ovi
   rade bez prepisivanja → **paritet po konstrukciji**. Tela funkcija se portuju u TS tek
   posle cutover-a (Faza B), nikad tokom seobe.
2a. **⚠️ BYPASSRLS istina + SET-ROLE most (nalaz review-a Talasa B, 12.07).** Rola
   `servosync2_app` ima `BYPASSRLS` → RLS politike se NE evaluiraju za direktne
   Prisma/queryRaw upite kroz `withUser`. To je bezbedno SAMO za module gde su čitanja
   `SELECT true` a mutacije idu kroz DEFINER RPC (Reversi, Lokacije). **Za svaku tabelu sa
   row-scoped SELECT/DML politikom (učesnik/svoje/mgmt scope) OBAVEZAN je
   `Sy15Service.withUserRls`**: GUC claims + `SET LOCAL ROLE authenticated` u istoj tx —
   politike i table privilegije tada važe identično kao kroz PostgREST (1.0 paritet po
   konstrukciji; `servosync2_app` je član `authenticated` od 12.07,
   1.0 migracija `20260712_talas_b_r0_set_role_bridge.sql`). Posledica za R0: talasi čija
   cela front površina ide kroz `withUserRls` NE traže direktne table/fn grantove —
   nasleđuju ih od `authenticated`. Zabranjeno je „emulirati" RLS WHERE klauzulama u TS-u
   (duplira policy logiku — krši §C). SECURITY INVOKER fn (npr. `ai_chat_sql`) smeju se
   izvršavati ISKLJUČIVO pod `withUserRls`, nikad kao BYPASSRLS rola.
2b. **⚠️ withUserRls NIJE univerzalni štit — non-invoker view zaobilazi RLS (nalaz review-a
   Talasa G, 13.07).** `withUserRls` (SET LOCAL ROLE authenticated) čini da RLS radi SAMO za
   direktno upitane tabele i **`security_invoker=true`** view-ove. **View koji NIJE
   security_invoker (reloptions=NULL, vlasništvo `postgres`/BYPASSRLS) izvršava se kao
   VLASNIK → RLS bazne tabele se NE primenjuje ČAK ni pod `withUserRls`.** Zato: (a) za
   SVAKI view koji modul čita PROVERI `security_invoker` status na živoj bazi
   (`pg_class.reloptions` / `docs/db/snapshot/05_view.md`) — NE veruj spec tvrdnji „svi su
   invoker" (u G specu tvrđeno 14, a `v_kadr_audit_log`/`v_kadr_medical_exam_status`/
   `v_kadr_certificate_status` NISU); (b) za svaki NON-invoker view guard MORA potpuno
   replicirati baznu SELECT politiku (RLS ne pomaže) — npr. audit→admin, medical/certs→manage,
   PII→pii; nedovoljan klasni `read` guard = leak (JMBG/zarade). Ovo je flip-strana pravila 2a.
3. **Paralelni rad = ista baza.** 1.0 UI i 2.0 UI rade nad ISTIM podacima istovremeno.
   „Cutover" modula je čist UI preklop (hub kartica → 2.0 ruta) sa 1.0 kao instant fallback.
   Nema feature flag-ova, nema resync-a, nema duplih baza.
4. **Idempotencija na svim mutacijama.** Ako modul već ima svoj mehanizam
   (`client_event_uuid` u loc_*, `bulk_import_legacy_key` u rev_*) — koristi NJEGA.
   Ako nema → `rev_api_idempotency` obrazac (`clientEventId` + registar u istoj tx).
5. **Authz snapshot sa ŽIVE baze, nikad iz dokumentacije.** Pre R1: `pg_policies` +
   `pg_get_functiondef` svih fn modula → `authz-snapshots/<modul>-fn-defs-<datum>.sql`;
   re-verifikacija na živoj sy15 (cloud snapshot važi samo kao polazna tačka).
6. **Server-side zamke (naučene, ne ponavljati):**
   - sy15 `postgres` NIJE superuser → grants ISKLJUČIVO kao `supabase_admin` (inače tihi
     no-op uz WARNING).
   - `sy15-db` ima network alias **`db`** → svaki kontejner koji se priključi na
     `servosync15_default` mora imati jednoznačne DB hostove (`servosync-pg`, ne `db`).
   - v_* view-ovi su `security_invoker` → rola treba SELECT i na osnovnim tabelama.
   - Nove tabele u sy15 public šemi MORAJU biti RLS-zaključane (PostgREST ih izlaže).
   - SSH ka ubuntusrv: štedi pozive (fail2ban ban ~10 min na brze serije).
   - Boot-safe: bez SY15_* env-a modul vraća 503, aplikacija se diže normalno.

## B. Parity matrica (usvojeno iz ChatGPT predloga — obavezan deo svakog MODULE_SPEC-a)

Svaki spec sadrži **tabelu funkcija** (ekrani, akcije, filteri, dozvole, mobilno, edge
slučajevi, izveštaji/PDF, skener…) sa statusom po stavci:

`NOT_STARTED → IMPLEMENTED → TESTED (unit/e2e ili live smoke) → ACCEPTED (Nenad)`

Matrica se puni iz DVA izvora: (1) inventar živog 1.0 koda (Explore agent), (2) živi DB
objekti. Bez kompletne matrice ne počinje implementacija. Status se ažurira u spec-u
tokom rada — to je jedini izvor istine „šta je preneto".

## C. Zabrana usputnih izmena (izvršna instrukcija — VAŽI ZA SVAKU IMPLEMENTACIONU SESIJU)

Tokom seobe modula:
- **NE redizajniraj** poslovne tokove; UI ide na 2.0 dizajn-sistem (ui-kit), ali tok,
  polja, redosled koraka i poruke prate 1.0.
- **NE preimenuj poslovne pojmove** (revers, TP, predmet, nalog, polica, kavez…).
- **NE uklanjaj „naizgled mrtvo" ponašanje** — pravilo firme dok se ne dokaže suprotno
  (primer: `loc_can_create_movement` pušta i aktivnog zaposlenog po email-u, ne samo
  manage role — to NIJE bug).
- **NE menjaj semantiku baze** (statusi, enumi, formati putanja — npr. `pdf_storage_path`
  mora ostati 1.0-kompatibilan zbog paralelnog rada).
- **NE zamenjuj biblioteke** bez potrebe; **NE „pojednostavljuj" RLS/politike**.
- Svako odstupanje = eksplicitna stavka u spec-u sa razlogom, ne tiha izmena.

## D. Parity gate — Definition of Done po modulu (modul NE menja 1.0 dok sve ne prođe)

```
[ ] Parity matrica: sve stavke ≥ TESTED, kritične ACCEPTED
[ ] Živi authz snapshot re-verifikovan na sy15 (0 drift ili objašnjen)
[ ] e2e permission matrica (rola × endpoint × 200/403, AUTHZ_ENFORCE=true) prolazi
[ ] Bar 1 pun životni ciklus izvršen na ŽIVOJ bazi kroz novi API (kao REV-TOOL-2026-0027)
[ ] Desktop + mobilni prikaz проверени (2.0 responsive)
[ ] Playwright happy-path za 2.0 modul (login → glavna akcija → provera) — od Lokacija nadalje
[ ] Rollback trivijalan (1.0 UI netaknut, ista baza — vratiti link)
[ ] Deploy: BE main (runner, boot-safe) + FE wrangler; grants primenjeni kao supabase_admin
[ ] Runbook/spec ažuriran (status, caveati), memorija sesije ažurirana
```

## E. Grupisanje modula u talase (odluka Nenad 12.07 — radi se PO TALASIMA, ne po modulu)

Moduli koji dele infrastrukturu/domen sele se ZAJEDNO — jedan spec, jedan talas:

| Talas | Moduli (grupa) | Zašto zajedno |
|---|---|---|
| A ✅→🟡 | Reversi ✅ + **Lokacije + Štampa nalepnica** | dele `loc_create_movement`, placements, skener, TSPL2 print; Štampa je već tab Lokacija |
| B | Sastanci + AI asistent | oba „Saradnja", mali+srednji, nezavisni |
| C | Plan montaže + Plan proizvodnje + Praćenje | svi „Proizvodnja", dele predmete/TP/RN kontekst |
| D | Projektni biro + Moj profil + Podešavanja (RBAC) | PB override-i ↔ RBAC admin ↔ profil |
| E | Energetika/SCADA | samostalan (safety) |
| F | Održavanje (CMMS) | najveći authz, svoj role sistem |
| G | Kadrovska | poslednja (PII+zarade), apsorbuje Moj profil veze |

Unutar talasa: jedan zajednički spec (deljeni delovi jednom), R-faze idu za ceo talas.
