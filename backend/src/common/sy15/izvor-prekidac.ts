import { Logger, ServiceUnavailableException } from "@nestjs/common";

/** Dozvoljene vrednosti prekidača izvora (`SASTANCI_IZVOR`, `PB_IZVOR`). */
export type Izvor = "sy15" | "3.0";

/**
 * Zastareo ZAJEDNIČKI prekidač za sastanke i projektni biro. Ostaje samo kao
 * rezerva za `SASTANCI_IZVOR` (v. `SastanciSourceService`); `PB_IZVOR` ga
 * NAMERNO ne čita — razlog je incident 06.08.2026 opisan tamo.
 */
export const ZASTARELI_ZAJEDNICKI_PREKIDAC = "SASTANCI_PB_IZVOR";

/**
 * Zajedničko telo prekidača izvora podataka (`sy15` ↔ `3.0`) za JEDAN domen.
 *
 * ZAŠTO POSTOJI OVAJ SLOJ: gašenje sy15 (docs/PLAN_GASENJA_SY15_2026-08-03.md)
 * seli domen po domen, i SVAKI domen dobija svoj prekidač. Obrazac je isti kao
 * `REVERSI_IZVOR` i `PROXY_1_0_AKTIVAN` — promena izvora i povratak su promena
 * promenljive okruženja + restart (~2 min), BEZ novog deploy-a koda.
 *
 * 🔴 PRAVILO KOJE JE OVAJ SLOJ IZNUDIO (incident 06.08.2026, v. §7h runbook-a):
 * jedan prekidač sme da pokriva TAČNO JEDAN domen. Zajednički prekidač za dva
 * domena znači da domen koji JESTE spreman ne može da pređe dok drugi ne bude —
 * a ako se ipak prebaci, nespreman domen istog trenutka pada sa 503. Isto važi i
 * za preostale korake seobe (održavanje, reversi): pre uvođenja prekidača
 * proveriti da NE dodiruje nepovezan domen.
 *
 * Ponašanje (isto za svaki domen):
 *   `<ENV>=sy15` (PODRAZUMEVANO, i za svaku NEPREPOZNATU vrednost) — kao i do sad.
 *   `<ENV>=3.0`                                                     — prenete putanje idu u 3.0 bazu.
 *
 * Nepoznata vrednost NIKAD ne sme da se protumači kao `3.0`: preklop u pogrešnom
 * smeru razilazi dve baze, a to se ne vidi dok se brojevi ne raziđu.
 */
export abstract class IzvorPrekidac {
  protected readonly logger: Logger;
  private readonly value: Izvor;
  private readonly domen: string;
  /** Env koji je STVARNO dao vrednost (može biti zastareli alias) — ide u poruku povratka. */
  private readonly aktivniEnv: string;

  protected constructor(opts: {
    /** Ime env promenljive ovog domena (`SASTANCI_IZVOR` / `PB_IZVOR`). */
    envName: string;
    /** Ime domena u porukama (`Sastanci` / `Projektni biro`). */
    domen: string;
    logger: Logger;
    /** Zastareo naziv koji se čita SAMO ako `envName` nije postavljen. */
    zastareliAlias?: string;
    /** Šta se tačno menja kad prekidač stane na `3.0` (log na startu). */
    porukaZaTriNula: string;
  }) {
    this.logger = opts.logger;
    this.domen = opts.domen;
    this.aktivniEnv = opts.envName;

    let raw = (process.env[opts.envName] ?? "").trim();

    // Zastareli alias: čita se TEK ako svoj env nije postavljen — nikad ne gazi
    // izričitu vrednost novog imena.
    if (!raw && opts.zastareliAlias) {
      const alias = (process.env[opts.zastareliAlias] ?? "").trim();
      if (alias) {
        this.aktivniEnv = opts.zastareliAlias;
        raw = alias;
        this.logger.warn(
          `${opts.zastareliAlias}="${alias}" je ZASTAREO naziv (jedan prekidač za dva domena) — ` +
            `koristim ga kao rezervu za ${opts.envName}. Prekidač je razdvojen na SASTANCI_IZVOR ` +
            `i PB_IZVOR; postavi ${opts.envName} i obriši ${opts.zastareliAlias} iz okruženja.`,
        );
      }
    }

    if (!raw) {
      this.value = "sy15";
    } else if (raw !== "sy15" && raw !== "3.0") {
      // Nepoznata vrednost NE sme da se protumači kao „3.0" — pada na bezbedan default.
      this.logger.warn(
        `${this.aktivniEnv}="${raw}" nije prepoznat (očekivano "sy15" ili "3.0") — koristim "sy15".`,
      );
      this.value = "sy15";
    } else {
      this.value = raw;
    }

    if (this.value === "3.0") {
      this.logger.warn(
        `${this.aktivniEnv}=3.0 — ${opts.porukaZaTriNula} ` +
          `Povratak: ${this.aktivniEnv}=sy15 + restart.`,
      );
    }
  }

  get izvor(): Izvor {
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
   *
   * Poruka nosi ime env-a koji je STVARNO dao vrednost (i kad je to zastareli
   * alias), da uputstvo za povratak radi doslovno onako kako je prekidač podešen.
   */
  assertPorted(feature: string): void {
    if (!this.isThreeZero) return;
    throw new ServiceUnavailableException(
      `${this.domen}: "${feature}" još nije preneto na 3.0 izvor (zavisi od sy15 ` +
        `view-ova/DEFINER funkcija/employees/RLS). Vrati ${this.aktivniEnv}=sy15 i restartuj backend.`,
    );
  }
}
