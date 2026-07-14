# HANDOFF — stanje 3.0 migracije (14.07.2026) za nastavak u novoj sesiji

> Ovaj dokument je pun kontekst za agenta koji preuzima. Čitaj ga CEO pre prve akcije.
> Prati i: `MIGRACIONA_DOKTRINA_3.0.md` (A.2a/A.2b/§C — OBAVEZNO), `MODULE_SPEC_*_30.md`
> (svaki §7 PRESUĐEN), memorija `plan-modula-mes-30`, `OTVORENA_PITANJA_TALASI_B-F` + G §7.

## 1. Gde smo (svaki modul)

| Talas | Backend | Frontend | Grana(e) + HEAD |
|---|---|---|---|
| A Lokacije | ✅ R1+R2 (review+fix) | ✅ R3 (review+fix) | be `wave-a/lokacije`@7cb7bd0 · fe `wave-a-fe/lokacije`@2f32c12 |
| B Sastanci+AI | ✅ R1+R2 (2 review) | ✅ R3 (review+fix) | be `wave-b/sastanci-ai`@32b9b8a · fe `wave-b-fe/sastanci-ai`@77a5516 |
| C Planovi+Praćenje | ✅ R1+R2 | R3 TODO | `wave-c/planovi-pracenje`@a0d3011 · **R2 REVIEW U TOKU** |
| D PB+Profil | ✅ R1+R2 (PB+profil) | R3 TODO | `wave-d/pb-profil-podesavanja`@3b7709f · **R2 REVIEW U TOKU** |
| D Podešavanja RBAC-write (D1) | ✅ (review+fix) | R3 TODO (matrica/legacy blok) | `wave-d-rbac/podesavanja-write`@955fd01 |
| E SCADA | ✅ R1+R2 komande | ✅ R3 (review ČIST) | be `wave-e/energetika`@8d3d3bc · fe `wave-e-fe/energetika`@9e98e19 · **R2 REVIEW U TOKU** |
| F Održavanje/CMMS | R1 ✅ · **R2 se DOVRŠAVA** | R3 TODO | `wave-f/odrzavanje`@831249c (R2 još NIJE commitovan — agent aa5e6b0e završava e2e) |
| G Kadrovska | ✅ R1+R2 (payroll, review+fix) | R3 TODO (PDF ćirilica + QR bedževi) | `wave-g/kadrovska`@c490c5a |

2.0 main: backend `4b9f837`, frontend `83ca92c` (Tehnologija sesija gura tu — deljen!).
Reversi + Tehnologija su UŽIVO (jedino stvarno mergovano). Sve gore je NA GRANAMA, ništa na main.

## 2. Worktree mapa
- Backend: C:/bemain (main) · C:/berev (wave-a) · C:/beb (wave-b) · C:/bec (wave-c) · C:/bed (wave-d) · C:/bdr (wave-d-rbac) · C:/bee (wave-e) · C:/bef (wave-f) · C:/beg (wave-g) · C:/bint (integration/waves-bcdef — stari dry-run) · C:/wsb (detached)
- Frontend: C:/fa (wave-a-fe) · C:/fb (wave-b-fe) · C:/fe (wave-e-fe)
- 1.0 repo: c:\Users\nenad.jarakovic\Documents\GitHub\servoteh-plan-montaze (Management API `node scripts/sb-exec-sql.mjs --sql "..."` READ-ONLY; NIKAD ssh — fail2ban)

## 3. Doktrina koja se MORA poštovati (naučeno kroz review-ove)
- **A.2a**: rola `servosync2_app` je BYPASSRLS → row-scoped čitanja OBAVEZNO kroz `Sy15Service.withUserRls` (GUC claims sub+email + SET LOCAL ROLE authenticated). `withUser` samo za SELECT-true/DEFINER. `runIdempotentRls` za ne-idempotentne POST.
- **A.2b**: NON-security_invoker view (postgres-owned, `reloptions=NULL`) zaobilazi RLS ČAK i pod withUserRls → guard MORA replicirati baznu politiku. NON-invoker view-ovi (izmereno): `v_kadr_audit_log`, `v_kadr_medical_exam_status`, `v_kadr_certificate_status`, `v_settings_audit_log` (svi pokriveni admin/manage guardom — provereno). SVI v_maint_*, bigtehn bridge, v_employees_safe, v_vacation_balance = invoker (sigurni).
- **§C**: paritet 1.0, bez „poboljšanja"/preimenovanja; nepoznato = TODO ne pretpostavka.
- **Obavezno u svakom review-u**: SVAKO ime kolone/view/RPC-potpisa protiv žive šeme (bug klasa: pogrešna kolona→500, integer=text→42883, BigInt→500, jsonb pogrešni ključevi→no-op, non-invoker view→leak). Payroll/PII/identitet = CRITICAL.

## 4. Merge recept (VALIDIRAN dry-run-om — `integration/waves-bcdef`)
Redosled: **wave-b → C → D → F → E → A → wave-g → wave-d-rbac** (+ fe grane odvojeno). Po fajlu:
- `permissions.ts`/`app.module.ts` = čist union (aditivno).
- `sy15.service.ts` = DEDUP `withUserRls` (B/E/A/G imaju kopije → zadržati JEDNU kanonsku; +runIdempotentRls).
- `role-permissions.ts` = slojevita kompozicija; +**reconcile exact-set testove** za finalni katalog (F aktivira tehnicar_odrzavanja → C montaza.read/D pb.read ga korektno obuhvate).
- `prisma/sy15.prisma` = ⚠️ NE union-strip (ispremešta model-blokove!) → BLOK-KONKATENACIJA: wave-b baza + intaktni blokovi po imenu (disjunktni: C=Pm/Pp, D=Pb/Competence, E=Scada, F=Maint, G=~40 kadr).
- ⚠️ **Reconcile override ključeve** (H1/H2): grep sve grane za `plan_montaze.write`/`kadrovska.access` → kanon `montaza.edit`/`kadrovska.read`.
- **Merge na main = Nenadova kapija** (deljen sa Tehnologija sesijom).

## 5. SLEDEĆI KORACI (redosled)
1. **Dovrši F R2** (agent aa5e6b0e u C:/bef — završava e2e; ako umre, novi agent nastavi iz C:/bef necommitovanog stanja).
2. **Dovrši 4 R2 review-a** (C/D/E u toku; F kad commituje) → fix-runde po nalazima (isti protokol: adversarni Workflow review → SendMessage fix agentu → verify tsc+testovi).
3. **Re-integracija** svih grana po §4 receptu (scratch grana, validiraj build+testovi) → **merge plan Nenadu**.
4. **R3 frontend-i**: C (Planovi+Praćenje), D (PB+Profil+Podešavanja matrica+editori), F (CMMS), G (Kadrovska — PDF ćirilica generatori + QR bedževi). Kodiraju protiv BE ugovora, review kao B-FE/A-FE/E-FE.
5. **R4 živi smoke** po modulu (traži deploy na sy15 + SY15_* env) — vidi scratchpad CHECKPOINT_MERGE_R4 §B.

## 6. Disciplina (kritično — naučeno bolno)
- **PROVERAVAJ ŽIVOST AGENATA**: ne veruj tišini. Posle svakog javljanja: `stat` mtime task-output + `git status` necommitovan rad u worktree-u. Ako agent >30-40min bez pisanja = verovatno mrtav (memorija/pauza/API greška) → recovery (SendMessage resume; ako „won't resume" → nov agent iz necommitovanog worktree stanja). 4 R2 agenta su bila mrtva ~15h neprimećeno.
- Agenti NE komituju u main, NE deploy, NE ssh, NE pišu u živu bazu; sve na granama.

## 7. Čeka NENADA (domenske odluke — ne može agent)
1. Rezni alat (Reversi): cutting source-location (MACHINE lokacija) — treba realni rezni.
2. Project-UUID picker (Sastanci FE): sy15 UUID vs BigBit numerički ID — treba `projects-by-uuid` lookup.
3. Merge na main (svaka grana) + R4 deploy odobrenje.

Vidi i scratchpad `CHECKPOINT_MERGE_R4.md` (sesija) za pun merge/R4/follow-up detalj.
