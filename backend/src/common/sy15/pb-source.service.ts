import { Injectable, Logger } from "@nestjs/common";
import {
  IzvorPrekidac,
  ZASTARELI_ZAJEDNICKI_PREKIDAC,
  type Izvor,
} from "./izvor-prekidac";

/** Dozvoljene vrednosti prekidača `PB_IZVOR`. */
export type PbIzvor = Izvor;

/**
 * Prekidač izvora podataka za PROJEKTNI BIRO (`PB_IZVOR`) — i ništa drugo.
 *
 * Pokriva `pb_*` tabele (zadaci, komentari, prilozi, inženjerski saveti,
 * radni izveštaji, notifikacije). Sastanci imaju SVOJ prekidač
 * (`SastanciSourceService`, `SASTANCI_IZVOR`) i ovaj ga NE dodiruje.
 *
 *   PB_IZVOR=sy15  (PODRAZUMEVANO) — sve ide u sy15, ponašanje kao i do sad.
 *   PB_IZVOR=3.0                   — prenete putanje idu u 3.0 bazu.
 *
 * ── STANJE 06.08.2026: PB OSTAJE NA `sy15` ────────────────────────────────────
 * Podaci PB-a JESU preneti u 3.0 (docs/SEOBA_SASTANCI_PB_2026-08-05.md §6), ali
 * LOGIKA nije i ne može pre koraka 4 (kadrovska): `pb_current_employee_id()`
 * (jwt mejl → `employees.id`) je ulaz u SVA prava modula
 * (`pb_can_edit_tasks`, `pb_eng_tip_visible`, `pb_current_user_can_see_all_reports`),
 * a funkcije opterećenja džoinuju i `departments` / `sub_departments` /
 * `job_positions`. Uz to `pb_list_projects` zove `production.predmet_aktivacija`.
 * Zato pod `PB_IZVOR=3.0` CEO modul namerno vraća 503 — to je stanje kvara, ne
 * radno stanje. **Prekidač se ne pomera dok kadrovska ne pređe (korak 4b plana).**
 *
 * ── 🔴 ZAŠTO PB IMA SVOJ PREKIDAČ (incident 06.08.2026) ───────────────────────
 * Do 06.08. su sastanci i PB delili prekidač `SASTANCI_PB_IZVOR`. Kad je on na
 * produkciji stao na `3.0` (sastanci su bili spremni), PROJEKTNI BIRO je istog
 * trena počeo da vraća 503, a scheduler posao `pb-notify-dispatch` da pada na
 * svaka 2 minuta — modul koji sa seobom sastanaka nema nikakve veze bio je
 * TALAC tuđeg preklopa. Prekidač je vraćen na `sy15` i razdvojen na dva.
 *
 * ⚠️ ZASTARELI `SASTANCI_PB_IZVOR` SE OVDE NAMERNO NE ČITA. Da se čita, stari
 * naziv bi i dalje mogao da obori PB — tj. incident bi ostao ponovljiv. Ako je
 * postavljen na `3.0`, konstruktor to samo PRIJAVI (da se u logu vidi zašto PB
 * nije pomeren) i ostaje na `sy15`, jer je to bezbedan smer: PB nastavlja da
 * radi nad svojim izvorom istine.
 */
@Injectable()
export class PbSourceService extends IzvorPrekidac {
  constructor() {
    super({
      envName: "PB_IZVOR",
      domen: "Projektni biro",
      logger: new Logger(PbSourceService.name),
      // Bez `zastareliAlias` — v. zaglavlje: to je sama poenta razdvajanja.
      porukaZaTriNula:
        "CEO PROJEKTNI BIRO vraća 503: prava modula izvode se iz " +
        "pb_current_employee_id() → employees/departments/sub_departments/job_positions, " +
        "a to je kadrovska (korak 4). Ovo NIJE radno stanje — PB se pomera tek posle kadrovske.",
    });

    const zastareo = (process.env[ZASTARELI_ZAJEDNICKI_PREKIDAC] ?? "").trim();
    if (zastareo === "3.0") {
      this.logger.warn(
        `${ZASTARELI_ZAJEDNICKI_PREKIDAC}=3.0 je zatečen u okruženju, ali PROJEKTNI BIRO ` +
          `taj (zastareo, zajednički) naziv NAMERNO ne čita — ostaje na PB_IZVOR=${this.izvor}. ` +
          "Razlog: 06.08.2026 je zajednički prekidač oborio ceo PB (503 + pad pb-notify-dispatch) " +
          "iako se selio samo domen sastanaka. Ako PB stvarno treba na 3.0, postavi PB_IZVOR " +
          "izričito — ali tek posle seobe kadrovske (korak 4b).",
      );
    }
  }
}
