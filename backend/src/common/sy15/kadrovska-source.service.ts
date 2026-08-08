import { Injectable, Logger } from "@nestjs/common";
import { IzvorPrekidac, type Izvor } from "./izvor-prekidac";

/** Dozvoljene vrednosti prekidača `KADROVSKA_IZVOR`. */
export type KadrovskaIzvor = Izvor;

/**
 * Prekidač izvora podataka za KADROVSKU (HR) — `KADROVSKA_IZVOR` — i ništa drugo.
 *
 *   KADROVSKA_IZVOR=sy15  (PODRAZUMEVANO) — sve ide u sy15, ponašanje kao i do sad.
 *   KADROVSKA_IZVOR=3.0                   — prenete putanje idu u 3.0 bazu.
 *
 * Korak 4 iz docs/PLAN_GASENJA_SY15_2026-08-03.md — NAJVEĆI preostali domen:
 * 64 tabele / 510.455 redova / 152 MB / 167 RLS politika (najviše u celoj bazi).
 * Merenje i runbook: docs/SEOBA_KADROVSKE_2026-08-07.md.
 *
 * ⚠️ MODUL JE ZAMRZNUT ZA DORADE (docs/OTVORENI_POSLOVI.md §K). Zamrznute su
 * FUNKCIONALNE izmene; SEOBA je ono što zamrzavanje ukida. Ovaj prekidač ne menja
 * nijedno ponašanje dok stoji na `sy15` — a `sy15` je podrazumevano.
 *
 * ── 🔴 KOJE SVE POZIVAOCE POKRIVA (mereno pre uvođenja, ne pretpostavljeno) ───
 * Pouka incidenta 06.08.2026 (`SASTANCI_PB_IZVOR` je oborio Projektni biro, jer je
 * naziv prekidača izveden iz DOMENA umesto iz POZIVALACA): prekidač prati STVARNE
 * POZIVAOCE podataka. `grep` nad CELIM `backend/src` za 64 imena tabela domena
 * (07–08.08.2026) daje OSAM mesta, i sva čitaju/pišu isti skup podataka:
 *
 *   1. `modules/kadrovska/*`                      — 80 `withUserMapped` u
 *                                                   `kadrovska.service.ts` + 16 u
 *                                                   `kadrovska-mutations.service.ts`
 *                                                   + `grid-autofill.service.ts`
 *   2. 🔴 `modules/moj-profil/*`                  — 121 dodir domena. Samousluga
 *                                                   (GO, odsustva, nadoknade,
 *                                                   plaćeno odsustvo, razgovori,
 *                                                   procene, sati, kapija) PIŠE u
 *                                                   iste tabele kao i kadrovska
 *   3. `modules/podesavanja/*`                    — organizaciona struktura
 *                                                   (`kadr_departments`,
 *                                                   `sub_departments`,
 *                                                   `job_positions`), okvir
 *                                                   kompetencija, `kadr_holidays`,
 *                                                   i 🔴 DVE allowlist tabele iz
 *                                                   kojih se izvode PRAVA
 *                                                   (`kadrovska.grid_edit`,
 *                                                   `kadrovska.vacation_edit`)
 *   4. `modules/scheduler/sy15-cron-jobs.ts`      — 6 poslova: `kadr-hr-reminders`,
 *                                                   `kadr-corrective-reminders`,
 *                                                   `kadr-onboarding-reminders`,
 *                                                   `kadr-attendance-alerts`,
 *                                                   `kadr-attendance-digest`,
 *                                                   `kadr-weekly-risk`
 *   5. `modules/scheduler/dispatch/notify-dispatch.service.ts`
 *                                                 — SAMO `dispatchKadr()` grana
 *   6. `modules/scheduler/daily-brief.service.ts` — `absences` + `work_hours` +
 *                                                   `v_employees_safe` (ko je
 *                                                   danas odsutan)
 *   7. 🔴 `modules/tech-processes/session-auto-close.service.ts`
 *                                                 — čita `attendance_events`
 *                                                   (KAPIJA), `employees`,
 *                                                   `job_positions` i
 *                                                   `worker_employee_map` da bi
 *                                                   zatvorio viseće sesije i
 *                                                   obavestio šefa iz sistematizacije
 *   8. `modules/ai-chat/ai-chat.service.ts` + `tools/sy15-tools.ts`
 *                                                 — 12 `ai_chat_*` alata nad
 *                                                   domenom (GO saldo, odsustva,
 *                                                   sati, moj tim, opis pozicije,
 *                                                   pretraga zaposlenog)
 *
 * ── ŠTA OVAJ PREKIDAČ NAMERNO NE DODIRUJE ────────────────────────────────────
 * `notify-dispatch.service.ts` drži TRI outbox-a: `kadr`, `maint` i `pb`. Pod ovaj
 * prekidač ide ISKLJUČIVO `dispatchKadr()`. `dispatchMaint()` je pod
 * `ODRZAVANJE_IZVOR`, `dispatchPb()` pod `PB_IZVOR` — nijedan se ne dira. Isto u
 * `sy15-cron-jobs.ts`: od 22 posla samo gorenavedenih 6 je ovaj domen.
 *
 * ── 🔴 TUĐI MODULI KOJI ČITAJU `employees`, A NISU POD OVIM PREKIDAČEM ───────
 * `employees` je JEDINA tabela u sy15 koju čita pola aplikacije, pa bi stavljanje
 * SVIH čitalaca pod ovaj prekidač oborilo tri tuđa modula istog trenutka — tačno
 * ono što je bio incident 06.08. Zato su namerno IZVAN:
 *
 *   • `modules/projektni-biro/*` — `pb_current_employee_id()` je ulaz u SVA PB
 *     prava i traži sy15 `employees`. PB je već pod svojim `PB_IZVOR` i pod `3.0`
 *     ionako pada sa 503 (v. `PbSourceService`). Kad kadrovska pređe, PB dobija
 *     TABELU koju čeka — ali to je preklop PB-a, ne ovog domena.
 *   • `modules/reversi/*` — čita `employees` (pretraga po imenu, barkod kartice,
 *     odeljenje primaoca) i ima 3 INBOUND FK-a ka `employees` (korak 3).
 *   • `modules/sastanci/*` — čita `kadr_holidays` (kalendar praznika) i to radi
 *     I POD `SASTANCI_IZVOR=3.0`, namerno i read-only (v. `sastanci.service.ts`).
 *   • `modules/odrzavanje/*` — jedan uski `SELECT` nad `employees` (auto-detekcija
 *     vozača u modalu). Održavanje je već preseljeno i NE ZAVISI od kadrovske
 *     (izmereno: nijedna `maint*` funkcija ne pominje `employees`).
 *
 * Ta četiri mesta su ŠAV, ne propust — popisana su u runbook-u §4 i §7 sa
 * planom zatvaranja. Prekidač ih ne pokriva jer bi ih pod `3.0` oborio bez
 * potrebe: oni čitaju sy15 kopiju koja ostaje netaknuta dok sy15 živi.
 *
 * ── 🔴 KATZE MOST (`attendance_events`) NIJE POD OVIM PREKIDAČEM ─────────────
 * `bridge/src/jobs/syncKatze.js` (systemd `servoteh-bridge`, `ENABLE_JOB_KATZE=true`,
 * cron „svakih 10 minuta") čita Katze MSSQL `192.168.64.10` i UPSERT-uje u sy15
 * `attendance_events` preko Supabase REST-a. To je ODVOJEN proces, van ovog
 * repo-a i van ovog prekidača. Pod `KADROVSKA_IZVOR=3.0` most bi i dalje pisao u
 * sy15, a aplikacija čitala 3.0 — kapija bi se TIHO zaledila na dan preklopa.
 * Zato most mora da se preusmeri ISTOG DANA, zasebnim potezom (runbook §5.3).
 *
 * ── STANJE 08.08.2026 ─────────────────────────────────────────────────────────
 * Podaci SU spremni za prenos (63 tabele nastaju, `worker_employee_map` se spaja u
 * postojeću 3.0 tabelu; prenos dokazan na probnoj bazi), ali LOGIKA nije prepisana:
 * pod `3.0` domen namerno vraća 503 na svim putanjama. Preostali spisak: runbook §7.
 */
@Injectable()
export class KadrovskaSourceService extends IzvorPrekidac {
  constructor() {
    super({
      envName: "KADROVSKA_IZVOR",
      domen: "Kadrovska (HR)",
      logger: new Logger(KadrovskaSourceService.name),
      // Bez `zastareliAlias`: nijedan raniji prekidač nije pokrivao ovaj domen,
      // a `SASTANCI_PB_IZVOR` ga NE SME pomeriti (incident 06.08.2026).
      porukaZaTriNula:
        "kadrovska čita/piše 3.0 bazu. Pod ovim prekidačem su i modul „Moj profil\", " +
        "organizaciona struktura i praznici iz Podešavanja, 6 kadrovskih cron poslova, " +
        "`kadr-notify-dispatch`, dnevni brief (odsutni), auto-zatvaranje sesija sa kapije " +
        "i kadrovski alati AI-asistenta. 🔴 Katze most (bridge) NIJE pod ovim prekidačem " +
        "i mora se preusmeriti zasebno — inače kapija tiho staje. Putanje koje još nisu " +
        "prenete vraćaju 503 sa imenom putanje — to je brana, ne kvar.",
    });
  }
}
