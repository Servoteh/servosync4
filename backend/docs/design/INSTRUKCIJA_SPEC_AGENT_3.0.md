# INSTRUKCIJA ZA SPEC-AGENTE (Fable, paralelno) — izrada migracionih planova 3.0

**Verzija:** v1, 2026-07-12 · **Usvojio:** Nenad
**Svrha:** više paralelnih Fable agenata istovremeno izrađuje MODULE_SPEC za preostale
talase (B–G). Svaki spec mora biti dovoljno kompletan da ga **Opus 4.8 multiagenti izvrše
bez dodatne analize** — samo R-faze po spec-u + doktrini.

---

## 1. Talasi i redosled

**Analiza (specovi): svih 6 talasa PARALELNO odmah** — read-only posao, nema međuzavisnosti.
**Izvršavanje (Opus): B → C → D → E → F → G** (posle Talasa A/Lokacije; authz težina raste).

| Talas | Moduli (JEDAN spec po talasu) | Poznate činjenice / upozorenja za agenta |
|---|---|---|
| **B** | Sastanci + AI asistent | Sastanci: 7.7k UI, 32 RPC, 29 pol, participant-scope (`is_sastanak_ucesnik`), storage PDF arhiva, RSVP magic-link edge, pg_cron auto-kreiranje (petkom), AI sažmi edge. AI asistent: 0.5k UI, edge `ai-chat` (limit 50/dan), RLS svako-svoje, upis SAMO kroz edge. |
| **C** | Plan montaže + Plan proizvodnje + Praćenje proizvodnje | Plan montaže: 5.5k UI, project-scope `has_edit_role`, `tim_lider`≠`sef`, gantogrami, spremnost/TP-sidra, AI izveštaji montera (edge+storage). Plan proizvodnje: 5.7k UI, overlay nad `bigtehn_*` cache (⚠️ umire sa QBigTehn → repoint na 2.0 `tech_processes` je MOST, ne deo seobe). ⚠️ Praćenje: 3k UI ali **dinamičke `format()` politike + non-public šeme (`production`/`core`/`pdm`) + realtime** — politike se NE mapiraju mehanički, izvući ih ručno sa žive baze i POPISATI svaku. |
| **D** | Projektni biro + Moj profil + Podešavanja (RBAC admin) | PB: 5.9k UI, 37 RPC, 37 pol, per-user override `finalni_potpisnik`, uloge `inzenjer`/`projektant_vodja`. Moj profil: 4.3k UI, self-service (GO saldo/zahtevi/prisustvo/razgovori/pravilnik) — DELOVI zavise od Kadrovske (G): popisati tačno koje RPC dele i šta može pre G. Podešavanja: 5.3k UI — korisnici/role/per-user dozvole/matični/audit; ⚠️ ovo je RBAC admin konzola → mora biti usklađena sa 2.0 `roles.ts`/`role-permissions.ts`/`user_permission_overrides`. |
| **E** | Energetika/SCADA | 0.5k UI + originalni HP-HMI ekrani kroz IFRAME + fetch-shim (⚠️ shim `*/` zamka). `scada_*` tabele, service_role bridge na SCADA VM (⚠️ posle 1.5 cutover-a bridge repoint JOŠ NIJE urađen — proveriti živo stanje!). Komande imaju safety sloj (cancel-on-timeout, claimed recovery) — NE dirati semantiku. UI se NE prepisuje (iframe ostaje), seli se ljuska + komande + push alarmi. |
| **F** | Održavanje (CMMS) | NAJTEŽI authz: 14.9k UI, 34 tabele, 40 RPC, **102 politike**, **ODVOJEN role sistem `maint_user_profiles` po `auth.uid()` (NE email!)** — GUC most mora slati ispravan `sub`; machine-scope; chief/admin/tehničar/floor_read nivoi; ⚠️ auto-RBAC_MATRIX ovaj modul preskače → SVE sa žive baze. Podmoduli: mašine/vozila (vozači!)/objekti/IT, preventiva, kalendar, nalozi, zalihe, dokumenta. |
| **G** | Kadrovska (apsorbuje veze Moj profil) | NAJVEĆI: 25.8k UI (60 fajlova, 5 hub-grupa), ~28 tabela, ~48 RPC, ~74 pol. ⚠️ PII (`v_employees_safe` maska, `current_user_can_manage_employee_pii`), zarade (salary — admin-only + immutability), GO grid-kanon (v_vacation_balance grid-only!), work_hours grid vs absences dualizam, mejl outbox + 20+ pg_cron poslova, HR generatori PDF (ćirilica). `employees` = izvor istine za CELU firmu (worker_employee_map most ka 2.0). Spec podeliti na 5 pod-celina po hub-grupama (Pregled/Odmori/Sati/Zaposleni/Zarade). |

## 2. Obavezna pravila za svakog agenta

1. **PRVO pročitaj** (u 2.0 repou `Servosync 2.0/backend/docs/design/`):
   `MIGRACIONA_DOKTRINA_3.0.md` (važи u celosti), `MODULE_SPEC_lokacije_30.md` +
   `MODULE_SPEC_reversi.md` (uzor strukture i dubine).
2. **Dva izvora, oba obavezna:**
   - **Živi 1.0 kod**: `c:\Users\nenad.jarakovic\Documents\GitHub\servoteh-plan-montaze`
     (radno stablo; `src/ui/<modul>/`, `src/services/`, `src/state/auth.js` gate-ovi,
     `src/ui/mobile/`, `supabase/functions/` edge, `sql/migrations/` kanon).
   - **Živa baza kroz Management API**: iz 1.0 repoa `node scripts/sb-exec-sql.mjs --sql "..."`
     (read-only SELECT nad `pg_policies`, `pg_proc`/`pg_get_functiondef`, `information_schema`,
     `pg_stat_user_tables`, `cron.job`). ⚠️ **NIKAD ssh na ubuntusrv** (fail2ban; re-verifikacija
     na sy15 je poseban R0 korak glavne sesije). ⚠️ `pg_get_functiondef` baca na agregatima →
     filter `prokind='f'`.
3. **Snapshot fajl obavezan**: pune definicije SVIH fn modula →
   `Servosync 2.0/backend/docs/design/authz-snapshots/<talas>-fn-defs-2026-07-12.sql`
   (header kao u reversi/lokacije snapshotima).
4. **FRONT vs POZADINA podela** (najvrednija lekcija Lokacija): za svaki RPC/edge/cron
   označi da li ga zove korisnički front ili je bridge/worker/cron — pozadina se NE seli
   (ostaje u sy15), i to eksplicitno popiši. Očekuj da je front-površina znatno manja.
5. **Skrivena pravila firme**: svaku neobičnu granu u DB fn (npr. „i aktivan zaposleni po
   email-u", immutability, SoD) POPIŠI kao pravilo — doktrina §C zabranjuje da se izgubi.
6. **Ne izmišljaj**: ako nešto ne možeš da izmeriš/pročitaš, upiši u „Otvorena pitanja" —
   NE pretpostavljaj. Otvorena pitanja formatiraj kao §7 Lokacija spec-a: numerisano,
   svako sa **konkretnim predlogom** (Nenad presuđuje „važe predlozi" u jednom prolazu).
7. **Izlaz**: `Servosync 2.0/backend/docs/design/MODULE_SPEC_<slug>_30.md` — ISTA struktura
   kao `MODULE_SPEC_lokacije_30.md`: meta tabela → §0 obim (seli/ne-seli) → §1 živi podaci
   i model (tabele+redovi+Prisma odluka) → §2 žive politike + authz mapa → §3 API predlog →
   §4 FE (tabovi/modali/mobilno, nav sekcija po PLAN_MODULA_MES_3.0 domenu) → §5 parity
   matrica (SVE funkcije, status NOT_STARTED) → §6 R-faze za ceo talas → §7 otvorena pitanja.
8. **NE komituj, NE pushuj, NE menjaj kod/bazu** — samo Write spec + snapshot fajlova.
   Glavna sesija (Fable) review-uje, konsoliduje pitanja i commit-uje.
9. **Grupisani moduli = jedan spec**: deljene stvari (skener, storage, edge obrasci,
   permisije) piši jednom, per-modul samo razlike.
10. **Završna poruka agenta**: sažetak nalaza (5–10 redova) + lista otvorenih pitanja +
    procena u MN (kalibracija: Reversi=referenca, vidi `PROCENA_SEOBE_MODULA_3.0.md` u 1.0 repou).

## 3. Prompt šablon za lansiranje (glavna sesija popunjava <TALAS>)

```
Ti si spec-agent za migraciju ServoSync 1.0 → 2.0 (3.0 program), Talas <X>: <moduli>.
Pročitaj PRVO: Servosync 2.0/backend/docs/design/MIGRACIONA_DOKTRINA_3.0.md,
MODULE_SPEC_lokacije_30.md (uzor), INSTRUKCIJA_SPEC_AGENT_3.0.md (tvoja pravila, §2).
Poznate činjenice tvog talasa: <red iz tabele §1>.
Zadatak: proizvedi MODULE_SPEC_<slug>_30.md + authz snapshot po pravilima §2.
Radiš READ-ONLY nad kodom i bazom (Management API, ne ssh); pišeš SAMO ta dva fajla.
```

## 4. Posle svih specova (glavna sesija)

1. Review svih 6 specova (konzistentnost permission ključeva, sudari imena, deljeni servisi).
2. Konsolidovana lista SVIH otvorenih pitanja → Nenad presuđuje u jednom prolazu.
3. Commit svega na 2.0 main + tracker update.
4. Ažurirati `PROCENA_SEOBE_MODULA_3.0.md` (procene iz specova zamenjuju grube).
5. Izvršavanje: **Opus 4.8 multiagenti**, talas po talas (B→G), po doktrini + spec-u;
   svaki talas kroz R0 (re-verifikacija sy15 + grants) → R1 → R2 → R3 → R4 parity gate.
```
