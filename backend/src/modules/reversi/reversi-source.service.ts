import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";

/** Dozvoljene vrednosti prekidača `REVERSI_IZVOR`. */
export type ReversiIzvor = "sy15" | "3.0";

/**
 * Prekidač izvora podataka za Reverse (`REVERSI_IZVOR`).
 *
 * ZAŠTO POSTOJI: gašenje sy15 (docs/PLAN_GASENJA_SY15_2026-08-03.md) seli domen po
 * domen. Isti obrazac kao `PROXY_1_0_AKTIVAN` u `frontend/worker/index.ts` — promena
 * izvora i povratak su promena promenljive okruženja + restart (~2 min), BEZ novog
 * deploy-a koda. Bez toga bi povratak tražio revert + build + deploy.
 *
 *   REVERSI_IZVOR=sy15   (PODRAZUMEVANO) — sve ide u sy15 bazu, ponašanje kao i do sad.
 *   REVERSI_IZVOR=3.0                    — prenete putanje idu u 3.0 bazu.
 *
 * ⚠️ STANJE 05.08.2026: prebačen je SAMO deo koji je zaista prenosiv bez ostatka
 * sy15-a — klasifikacija inventara (`inventory-tree`, `inventory-classification-usage`).
 * Ostatak modula (63 od 66 ruta) i dalje zavisi od objekata koji NISU u 3.0 bazi:
 *
 *   - 12 `v_rev_*` view-ova (nose „moje/tim" opsege i zbirove),
 *   - 12 `SECURITY DEFINER` funkcija — među njima `rev_issue_reversal`,
 *     `rev_confirm_return`, `rev_issue_cutting_reversal`, `rev_confirm_cutting_return`,
 *     koje nose CELU logiku izdavanja i povraćaja (nije je bilo u TypeScript-u),
 *   - `employees` (kadrovska), `loc_locations` / `loc_item_placements` /
 *     `loc_create_movement` (Lokacije), `maint_machines` (Održavanje),
 *   - `auth.uid()` / `auth.jwt()` identitet iz GUC-a (`Sy15Service.setClaims`).
 *
 * Zato pod `REVERSI_IZVOR=3.0` NEPRENETE putanje NAMERNO padaju sa 503 i jasnom
 * porukom, umesto da tiho vrate prazan ili pogrešan odgovor. Merenje i redosled
 * preostalog posla: docs/SEOBA_REVERSA_2026-08-05.md.
 */
@Injectable()
export class ReversiSourceService {
  private readonly logger = new Logger(ReversiSourceService.name);
  private readonly value: ReversiIzvor;

  constructor() {
    const raw = (process.env.REVERSI_IZVOR ?? "sy15").trim();
    if (raw !== "sy15" && raw !== "3.0") {
      // Nepoznata vrednost NE sme da se protumači kao „3.0" — pada na bezbedan default.
      this.logger.warn(
        `REVERSI_IZVOR="${raw}" nije prepoznat (očekivano "sy15" ili "3.0") — koristim "sy15".`,
      );
      this.value = "sy15";
    } else {
      this.value = raw;
    }
    if (this.value === "3.0") {
      this.logger.warn(
        "REVERSI_IZVOR=3.0 — samo klasifikacija inventara čita 3.0 bazu; " +
          "ostale rute reversa vraćaju 503 dok se seoba ne dovrši. Povratak: REVERSI_IZVOR=sy15 + restart.",
      );
    }
  }

  get izvor(): ReversiIzvor {
    return this.value;
  }

  /** `true` kad podatke treba čitati iz 3.0 baze. */
  get isThreeZero(): boolean {
    return this.value === "3.0";
  }

  /**
   * Brana za putanje koje JOŠ NISU prenete. Poziva se na početku metode koja i dalje
   * zavisi od sy15 objekata (view, DEFINER funkcija, `employees`, `loc_*`).
   * Pod `sy15` ne radi ništa; pod `3.0` baca 503 sa imenom putanje, da se u logu
   * odmah vidi ŠTA je zapelo.
   */
  assertPorted(feature: string): void {
    if (!this.isThreeZero) return;
    throw new ServiceUnavailableException(
      `Reversi: "${feature}" još nije prenet na 3.0 izvor (zavisi od sy15 view-ova/funkcija/` +
        `employees/loc_*). Vrati REVERSI_IZVOR=sy15 i restartuj backend.`,
    );
  }
}
