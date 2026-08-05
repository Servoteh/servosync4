import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";

/** Dozvoljene vrednosti prekidača `SASTANCI_PB_IZVOR`. */
export type SastanciPbIzvor = "sy15" | "3.0";

/**
 * Prekidač izvora podataka za Sastanke i Projektni biro (`SASTANCI_PB_IZVOR`).
 *
 * ZAŠTO POSTOJI: gašenje sy15 (docs/PLAN_GASENJA_SY15_2026-08-03.md) seli domen po
 * domen. Isti obrazac kao `REVERSI_IZVOR` i `PROXY_1_0_AKTIVAN` — promena izvora i
 * povratak su promena promenljive okruženja + restart (~2 min), BEZ novog deploy-a
 * koda. Bez toga bi povratak tražio revert + build + deploy.
 *
 *   SASTANCI_PB_IZVOR=sy15  (PODRAZUMEVANO) — sve ide u sy15, ponašanje kao i do sad.
 *   SASTANCI_PB_IZVOR=3.0                   — prenete putanje idu u 3.0 bazu.
 *
 * Jedan prekidač za OBA modula namerno: `akcioni_plan` i `pm_teme` su tabele
 * sastanaka, a `pb_tasks`/`pb_eng_tips` vise o istim `projects` i `employees`
 * vezama; razdvojeni prekidači bi dozvolili stanje u kom pola domena čita jednu a
 * pola drugu bazu.
 *
 * ⚠️ STANJE 06.08.2026.
 *
 * PRENETO (radi pod `3.0`):
 *   - ŠEMA i PODACI (27 tabela, 1.120 redova — dokazano na probnoj bazi),
 *   - view-ovi `v_akcioni_plan` i `v_pm_teme_pregled`,
 *   - 4 samouslužne fn (`SastanciSamouslugaService`) + 17 pozvanih DEFINER fn i
 *     6 logičkih trigera (`SastanciFnService`) — među njima `sast_zakljucaj_sastanak`
 *     (zaključavanje + arhiva + zapisnik mejl), `sast_auto_create_weekly`,
 *     `sastanci_enqueue_*` i dispatch (dakle CEO mejl kanal sastanaka),
 *   - gejtovi prava koje je ranije sprovodio RLS (`SastanciAuthzService`),
 *   - 3 scheduler posla sastanaka + dispečer sastanaka,
 *   - READ-SCOPE tri row-scoped SELECT politike (`pm_teme`,
 *     `sastanci_notification_log`, `sastanci_notification_prefs`) +
 *     lista obaveštenja koja ga koristi.
 *
 * JOŠ NIJE PRENETO — zato pod `3.0` i dalje pada sa 503:
 *   - tabelarni CRUD (liste, detalj, učesnici, tačke, odluke, akcije, teme,
 *     šabloni, arhiva, slike) — ide kroz `withUserMapped`, koji je brana,
 *   - RLS WRITE-scope za DECU sastanka (`su_*`, `pa_*`, `ap_*`…) — ide ZAJEDNO
 *     sa CRUD-om i ne sme da kasni za njim,
 *   - registar idempotencije `rev_api_idempotency` (ostaje u sy15) — zato
 *     `create` / `bulk-ucesnici` / `prenos` / `instantiate` i dalje padaju,
 *   - `projekat_id` je promenio tip (uuid -> Int) — traži usklađen FE,
 *   - CEO PROJEKTNI BIRO: `employees` / `departments` / `sub_departments` /
 *     `job_positions` (kadrovska — korak 4; bez njih `pb_current_employee_id`
 *     ne postoji, a on je ulaz u SVA prava modula) i
 *     `production.predmet_aktivacija` (koju zove `pb_list_projects`).
 *
 * Zato pod `SASTANCI_PB_IZVOR=3.0` NEPRENETE putanje NAMERNO padaju sa 503 i
 * jasnom porukom, umesto da tiho vrate prazan ili pogrešan odgovor — upis koji bi
 * ipak otišao u sy15 razišao bi dve baze, a to se ne vidi odmah.
 * Merenje i redosled preostalog posla: docs/SEOBA_SASTANCI_PB_2026-08-05.md §7b/§7c.
 */
@Injectable()
export class SastanciPbSourceService {
  private readonly logger = new Logger(SastanciPbSourceService.name);
  private readonly value: SastanciPbIzvor;

  constructor() {
    const raw = (process.env.SASTANCI_PB_IZVOR ?? "sy15").trim();
    if (raw !== "sy15" && raw !== "3.0") {
      // Nepoznata vrednost NE sme da se protumači kao „3.0" — pada na bezbedan default.
      this.logger.warn(
        `SASTANCI_PB_IZVOR="${raw}" nije prepoznat (očekivano "sy15" ili "3.0") — koristim "sy15".`,
      );
      this.value = "sy15";
    } else {
      this.value = raw;
    }
    if (this.value === "3.0") {
      this.logger.warn(
        "SASTANCI_PB_IZVOR=3.0 — sastanci čitaju/pišu 3.0 bazu: samousluga, zaključavanje i " +
          "arhiva, pozivnice i podsetnici, sedmični kolegijum, mejl kanal i dispatch. " +
          "Tabelarni CRUD (liste/detalj/učesnici/tačke/teme/šabloni), rute koje traže registar " +
          "idempotencije (create/bulk/prenos/instantiate) i CEO projektni biro i dalje vraćaju " +
          "503. Povratak: SASTANCI_PB_IZVOR=sy15 + restart.",
      );
    }
  }

  get izvor(): SastanciPbIzvor {
    return this.value;
  }

  /** `true` kad podatke treba čitati/pisati u 3.0 bazi. */
  get isThreeZero(): boolean {
    return this.value === "3.0";
  }

  /**
   * Brana za putanje koje JOŠ NISU prenete. Poziva se na početku metode koja i
   * dalje zavisi od sy15 objekata (view, DEFINER funkcija, `employees`, RLS).
   * Pod `sy15` ne radi ništa; pod `3.0` baca 503 sa imenom putanje, da se u logu
   * odmah vidi ŠTA je zapelo.
   */
  assertPorted(feature: string): void {
    if (!this.isThreeZero) return;
    throw new ServiceUnavailableException(
      `Sastanci/PB: "${feature}" još nije preneto na 3.0 izvor (zavisi od sy15 ` +
        `view-ova/DEFINER funkcija/employees/RLS). Vrati SASTANCI_PB_IZVOR=sy15 i restartuj backend.`,
    );
  }
}
