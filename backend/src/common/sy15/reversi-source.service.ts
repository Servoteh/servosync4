import { Injectable, Logger } from "@nestjs/common";
import { IzvorPrekidac, type Izvor } from "./izvor-prekidac";

/** Dozvoljene vrednosti prekidača `REVERSI_IZVOR`. */
export type ReversiIzvor = Izvor;

/**
 * Prekidač izvora podataka za REVERSE (`REVERSI_IZVOR`).
 *
 *   REVERSI_IZVOR=sy15  (PODRAZUMEVANO) — sve ide u sy15, ponašanje kao i do sad.
 *   REVERSI_IZVOR=3.0                   — prenete putanje idu u 3.0 bazu.
 *
 * Korak 3 iz docs/PLAN_GASENJA_SY15_2026-08-03.md; merenje i runbook u
 * docs/SEOBA_REVERSI_LOKACIJE_2026-08-07.md.
 *
 * ── 🔴 JEDAN PREKIDAČ ILI DVA? ODLUKA: DVA IMENA, JEDNA VREDNOST ────────────────
 * Pouka incidenta 06.08.2026 (`SASTANCI_PB_IZVOR` je oborio Projektni biro) kaže:
 * jedan prekidač = tačno jedan domen. Ali Reversi i Lokacije NISU dva nepovezana
 * domena kao sastanci i PB — oni su TRANSAKCIONO SPOJENI, i to je izmereno:
 *
 *   • `rev_issue_reversal` i `rev_confirm_return` u ISTOM COMMIT-u upisuju
 *     `rev_document_lines` I `loc_location_movements` (kroz `loc_create_movement`);
 *   • `rev_document_lines.issue_movement_id` -> `loc_location_movements`: 40 redova,
 *     `return_movement_id`: 1;
 *   • `rev_tools.loc_item_ref_id` <-> `loc_item_placements`: 47/47;
 *   • `rev_documents.recipient_loc_id` -> `loc_locations`: 27/27 (nijedan NULL);
 *   • `rev_cutting_tool_stock.location_id` -> `loc_locations`.
 *
 * Da su prekidači nezavisni, `REVERSI_IZVOR=3.0` + `LOKACIJE_IZVOR=sy15` bi značilo
 * da izdavanje alata upiše dokument u 3.0, a kretanje u sy15 — **jedna transakcija
 * presečena na dve baze, bez ijedne poruke o grešci**. To nije pad dostupnosti nego
 * tiho razilaženje podataka, tj. gora klasa kvara od one iz 06.08.
 *
 * Zato oba domena imaju SVOJE ime env-a (da poruke o 503 i uputstvo za povratak
 * nose ime domena koji je zapeo — to je ono što je 06.08. nedostajalo), ali je
 * NESLAGANJE VREDNOSTI zabranjeno: `assertSpojeniIzvori()` puca na startu.
 * Ako se ikad dokaže da je neki podskup zaista razdvojiv, otvara se izuzetak —
 * ali kao izričita, imenovana promenljiva, ne kao previd.
 *
 * ── KOJE SVE POZIVAOCE POKRIVA (mereno 07.08.2026, `grep` po `backend/src`) ─────
 *   1. `modules/reversi/*`   — 66 ruta, `rev_*` tabele + 15 `v_rev_*` view-ova
 *   2. `modules/locations/*` — `loc_*` tabele + `loc_create_movement`
 *   3. `common/printing/label-print.service.ts` — sam transport nalepnice (TSPL2) NE
 *      zna za izvor i ne pada pod 503. Ali PODATAK koji se štampa (`rev_tools.barcode`)
 *      čita `ReversiService` iz sy15 — taj deo JESTE iza brane, kao i sve ostalo.
 *
 * ── ŠTA OVAJ PREKIDAČ NAMERNO NE DODIRUJE ──────────────────────────────────────
 *   • `rev_api_idempotency` — uprkos prefiksu to je registar `Sy15Service.runIdempotent`
 *     CELE aplikacije (izmereno: 2/680 reda su reversi, 0 lokacije; 368 je kadrovska).
 *     Ostaje u sy15 do poslednjeg koraka gašenja i NE prati ovaj prekidač.
 *   • `v_rev_machines` — to je `SELECT … FROM maint_machines`, dakle POTROŠAČ
 *     održavanja; on prati `ODRZAVANJE_IZVOR` (v. `OdrzavanjeSourceService`).
 *   • `modules/part-locations/*` — 2.0-native QBigTehn ledger, drugi modul sa
 *     sličnim imenom. Nema nijedan `loc_*` objekat.
 *
 * ── STANJE 08.08.2026 ──────────────────────────────────────────────────────────
 * Šema i prenos SU spremni (21 tabela; prenos idempotentan i dokazan na probnoj
 * bazi), ali LOGIKA nije prepisana: `rev_issue_reversal` i `rev_confirm_return` su
 * cela poslovna logika izdavanja/povraćaja u PL/pgSQL-u, a u TypeScript-u je NEMA
 * (runbook §4 ih razlaže korak po korak; procena 5–8 dana).
 *
 * 🔴 Zato pod `3.0` DANAS pada CEO domen sa 503, ne „samo neprenete putanje" — nijedna
 * putanja još nije preneta. To je stanje kvara, a ne radno stanje; `3.0` se postavlja
 * TEK po završetku P1–P6 (runbook §6). Brana je ožičena u `ReversiService` nad svakim
 * pristupom sy15 podacima (`this.db` / `withSy15User` / `runSy15Idempotent`) —
 * ranije je bila samo provajdovana, pa je `3.0` tiho nastavljao da piše u sy15.
 */
@Injectable()
export class ReversiSourceService extends IzvorPrekidac {
  constructor() {
    super({
      envName: "REVERSI_IZVOR",
      domen: "Reversi",
      logger: new Logger(ReversiSourceService.name),
      // Bez `zastareliAlias`: `SASTANCI_PB_IZVOR` nema veze sa ovim domenom.
      porukaZaTriNula:
        "reversi čitaju/pišu 3.0 bazu. LOKACIJE_IZVOR MORA biti ista vrednost — " +
        "izdavanje alata je jedna transakcija nad oba domena. Putanje koje još nisu " +
        "prenete vraćaju 503 sa imenom putanje — to je brana, ne kvar.",
    });
  }
}
