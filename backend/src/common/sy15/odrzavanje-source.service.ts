import { Injectable, Logger } from "@nestjs/common";
import { IzvorPrekidac, type Izvor } from "./izvor-prekidac";

/** Dozvoljene vrednosti prekidača `ODRZAVANJE_IZVOR`. */
export type OdrzavanjeIzvor = Izvor;

/**
 * Prekidač izvora podataka za ODRŽAVANJE / CMMS (`ODRZAVANJE_IZVOR`) — i ništa drugo.
 *
 *   ODRZAVANJE_IZVOR=sy15  (PODRAZUMEVANO) — sve ide u sy15, ponašanje kao i do sad.
 *   ODRZAVANJE_IZVOR=3.0                   — prenete putanje idu u 3.0 bazu.
 *
 * Korak 2 iz docs/PLAN_GASENJA_SY15_2026-08-03.md; merenje i runbook u
 * docs/SEOBA_ODRZAVANJA_2026-08-06.md.
 *
 * ── 🔴 KOJE SVE POZIVAOCE POKRIVA (mereno pre uvođenja, ne pretpostavljeno) ───
 * Pouka incidenta 06.08.2026 (`SASTANCI_PB_IZVOR` je oborio Projektni biro):
 * prekidač prati STVARNE POZIVAOCE podataka, ne naziv domena. `grep` za
 * `maint_*` nad celim `backend/src` (06.08.2026) daje PET mesta, i sva su
 * potrošači istog skupa podataka, pa sva idu pod OVAJ prekidač:
 *
 *   1. `modules/odrzavanje/*`                     — 121 `withUserMapped` + 24 `runIdem`
 *   2. `modules/scheduler/sy15-cron-jobs.ts`      — posao `maint-deadlines`
 *                                                    (`maint_check_all_deadlines(30)`)
 *   3. `modules/scheduler/dispatch/notify-dispatch.service.ts`
 *                                                 — SAMO `dispatchMaint()` grana
 *   4. `modules/ai-chat/tools/sy15-tools.ts`      — 4 `ai_chat_*` alata nad `maint_*`
 *                                                    + alat `trosak_sredstva` (sirovi SQL)
 *   5. `modules/reversi/reversi.service.ts`       — čita `v_rev_machines`
 *
 * ── ŠTA OVAJ PREKIDAČ NAMERNO NE DODIRUJE ────────────────────────────────────
 * `notify-dispatch.service.ts` drži TRI outbox-a: `kadr`, `maint` i `pb`. Pod ovaj
 * prekidač ide ISKLJUČIVO `dispatchMaint()`. `dispatchKadr()` je kadrovska (korak 4),
 * `dispatchPb()` je pod `PB_IZVOR` — nijedan se ne dira. Isto važi za
 * `sy15-cron-jobs.ts`: od poslova tamo, samo `maint-deadlines` je ovaj domen.
 *
 * ── 🔴 (4) AI-CHAT: ZAŠTO JESTE POD OVIM PREKIDAČEM ──────────────────────────
 * `ai_chat_prijavi_kvar` radi `INSERT INTO maint_incidents` — dakle AI-chat PIŠE u
 * ovaj domen iz drugog modula. Da nije pod prekidačem, pod `3.0` bi prijave kvara
 * kroz asistenta i dalje odlazile u sy15, a ostatak modula u 3.0: dve baze bi se
 * razišle, i to se NE BI VIDELO dok se brojevi ne raziđu. Zato ti alati pod `3.0`
 * padaju sa 503 (`assertPorted`) — glasno, umesto tiho pogrešno.
 *
 * ── 🔴 (5) REVERSI: ZAŠTO TUĐI MODUL IPAK ZAVISI OD OVOG PREKIDAČA ───────────
 * `v_rev_machines` je u sy15 doslovno `SELECT … FROM maint_machines`. Reversi
 * (korak 3, još nisu preseljeni) čitaju mašine KROZ NJEGA. Čim mašine pređu u 3.0,
 * sy15 kopija prestaje da se menja — pa bi Reversi tiho prikazivali ZASTARELE
 * mašine (preimenovana mašina, novoarhivirana mašina, nova mašina koje nema).
 * To nije „reversi domen": to je POTROŠAČ maint podataka, pa prati izvor maint
 * podataka. FK graf ovaj šav NE POKAZUJE (nema nijednog inbound FK-a ka `maint_*`) —
 * našao ga je tek `pg_depend` nad view-ovima.
 *
 * ── STANJE 06.08.2026 ─────────────────────────────────────────────────────────
 * Podaci SU spremni za prenos (34 tabele / 764 reda, prenos dokazan i idempotentan),
 * ali LOGIKA još nije prepisana: pod `3.0` modul namerno vraća 503 na svim putanjama
 * osim onih koje su izričito prenete. Tačan preostali spisak je u runbook-u §7.
 * Za razliku od Projektnog biroa, održavanje NE ČEKA kadrovsku — izmereno je da
 * nijedna `maint*` funkcija ne pominje `employees`/`departments`/`profiles`.
 */
@Injectable()
export class OdrzavanjeSourceService extends IzvorPrekidac {
  constructor() {
    super({
      envName: "ODRZAVANJE_IZVOR",
      domen: "Održavanje (CMMS)",
      logger: new Logger(OdrzavanjeSourceService.name),
      // Bez `zastareliAlias`: `SASTANCI_PB_IZVOR` nema nikakve veze sa ovim
      // domenom i ne sme da ga pomeri (v. incident 06.08.2026).
      porukaZaTriNula:
        "održavanje čita/piše 3.0 bazu. Pod ovim prekidačem su i posao " +
        "`maint-deadlines`, `maint-notify-dispatch`, maint alati AI-asistenta i " +
        "čitanje mašina iz Reversa (v_rev_machines). Putanje koje još nisu prenete " +
        "vraćaju 503 sa imenom putanje — to je brana, ne kvar.",
    });
  }
}
