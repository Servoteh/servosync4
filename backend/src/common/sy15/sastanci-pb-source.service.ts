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
 * ⚠️ STANJE 05.08.2026: prenete su ŠEMA i PODACI (27 tabela, 1.120 redova —
 * dokazano na probnoj bazi), i prepisana je samouslužna logika
 * (`SastanciSamouslugaService`). NIJE preneto, i zato pod `3.0` pada sa 503:
 *
 *   - 65 `SECURITY DEFINER` funkcija (od 74 ukupno) — među njima
 *     `sast_zakljucaj_sastanak` (zaključavanje + arhiva + PDF),
 *     `sast_auto_create_weekly` / `sast_create_weekly_at` (automat sedmičnog),
 *     `sastanci_enqueue_*` i `pb_enqueue_notifications` (ceo mejl kanal),
 *     `pb_get_load_stats` / `pb_get_team_load_stats` (opterećenje inženjera),
 *     `pb_list_eng_tips` / `pb_save_eng_tip` (baza znanja),
 *   - view-ovi `v_akcioni_plan` i `v_pm_teme_pregled`,
 *   - `employees` / `departments` / `sub_departments` / `job_positions`
 *     (kadrovska — korak 4; bez njih `pb_current_employee_id` ne postoji, a on je
 *     ulaz u SVA prava projektnog biroa),
 *   - `auth.uid()` / `auth.jwt()` identitet iz GUC-a (`Sy15Service.setClaims`) i
 *     74 RLS politike koje presuđuju vidljivost reda,
 *   - `production.predmet_aktivacija` (koju zove `pb_list_projects`).
 *
 * Zato pod `SASTANCI_PB_IZVOR=3.0` NEPRENETE putanje NAMERNO padaju sa 503 i
 * jasnom porukom, umesto da tiho vrate prazan ili pogrešan odgovor — upis koji bi
 * ipak otišao u sy15 razišao bi dve baze, a to se ne vidi odmah.
 * Merenje i redosled preostalog posla: docs/SEOBA_SASTANCI_PB_2026-08-05.md.
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
        "SASTANCI_PB_IZVOR=3.0 — samouslužne putanje (RSVP, priprema, status moje akcije, " +
          "podešavanja obaveštenja) čitaju/pišu 3.0 bazu; ostale rute sastanaka i projektnog " +
          "biroa vraćaju 503 dok se seoba ne dovrši. Povratak: SASTANCI_PB_IZVOR=sy15 + restart.",
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
