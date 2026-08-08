import { Injectable, Logger } from "@nestjs/common";
import { IzvorPrekidac, type Izvor } from "./izvor-prekidac";

/** Dozvoljene vrednosti prekidača `LOKACIJE_IZVOR`. */
export type LokacijeIzvor = Izvor;

/**
 * Prekidač izvora podataka za LOKACIJE delova (`LOKACIJE_IZVOR`).
 *
 *   LOKACIJE_IZVOR=sy15  (PODRAZUMEVANO) — sve ide u sy15, ponašanje kao i do sad.
 *   LOKACIJE_IZVOR=3.0                   — prenete putanje idu u 3.0 bazu.
 *
 * 🔴 SPREGNUT SA `REVERSI_IZVOR` — mora imati ISTU vrednost; obrazloženje i merenje
 * su u `ReversiSourceService`, a `assertSpojeniIzvori()` to sprovodi na startu.
 *
 * ── 🔴 ZAŠTO JE OVAJ DOMEN NAJHITNIJI U CELOJ SEOBI ─────────────────────────────
 * Lokacije su JEDINI domen u kome korisnici UŽIVO pišu u sy15. Izmereno 07.08.2026
 * nad `loc_location_movements` (poslednjih 14 dana): 27.07=6, 28.07=28, 29.07=21,
 * 30.07=2, 31.07=8, 03.08=20, 04.08=7, 05.08=14, 06.08=3, 07.08=13. Upisi dolaze sa
 * mobilne i sa skenera. Svaki dan odlaganja je dan sa dva izvora istine, a prenos
 * mora ići uz kratak prozor zabrane upisa (runbook §6) — ne „kad stigne".
 *
 * ── KOJE SVE POZIVAOCE POKRIVA (mereno 07.08.2026) ─────────────────────────────
 *   1. `modules/locations/locations.service.ts` — `loc_*` tabele, `loc_create_movement`,
 *      `loc_move_cage`, `loc_report_parts_by_locations`, `loc_locations_audit`.
 *      OŽIČENO 08.08.2026: svaki pristup ide kroz `this.db` / `withSy15User` /
 *      `withSy15UserRls`, a svaki od njih zove `assertPorted` (503 pod `3.0`).
 *   2. `modules/reversi/reversi.service.ts` — izdavanje/povraćaj PIŠU
 *      `loc_location_movements` u istoj transakciji (zato sprega); ožičeno isto tako
 *      kroz `REVERSI_IZVOR`.
 *
 * ── ŠTA OVAJ PREKIDAČ NAMERNO NE DODIRUJE ──────────────────────────────────────
 *   • `modules/part-locations/*` — 2.0-native QBigTehn ledger. Ime liči, domen ne;
 *     nema nijedan `loc_*` objekat. Da je pod ovim prekidačem, preklop bi oborio
 *     modul koji se uopšte ne seli — tačno greška iz 06.08.2026.
 *   • `loc_sync_outbound_events` / `loc_sync_alerts_outbox` / heartbeat / ingest —
 *     to je most ka QBigTehn MSSQL-u koji je MRTAV (1.575 događaja u `PENDING`,
 *     nijedan nikad isporučen; `bigtehn_work_orders_cache` stao 14.07). Prenose se
 *     kao istorija; NE oživljavaju se u 3.0 i nemaju radnika koji ih prazni.
 *   • `modules/locations/loc-tp-feed.service.ts` — hranilica dodiruje ISKLJUČIVO
 *     `bigtehn_*_cache` i `loc_tp_feed_state`, kojih nema među 21 prenetom tabelom;
 *     uz to je podrazumevano isključena (`LOC_TP_FEED_ENABLED`). Zato NIJE iza brane.
 *     (Do 08.08.2026 je ovde stajalo suprotno — ispravljeno merenjem.)
 *
 * ── STANJE 08.08.2026 ──────────────────────────────────────────────────────────
 * Kao i kod reversa: pod `3.0` pada CEO domen sa 503, jer nijedna putanja još nije
 * prepisana (`loc_create_movement` + trigeri, runbook §4.3). `3.0` se postavlja TEK
 * po završetku P1–P6.
 */
@Injectable()
export class LokacijeSourceService extends IzvorPrekidac {
  constructor() {
    super({
      envName: "LOKACIJE_IZVOR",
      domen: "Lokacije delova",
      logger: new Logger(LokacijeSourceService.name),
      porukaZaTriNula:
        "lokacije čitaju/pišu 3.0 bazu. REVERSI_IZVOR MORA biti ista vrednost. " +
        "Putanje koje još nisu prenete vraćaju 503 sa imenom putanje — to je brana, ne kvar.",
    });
  }
}
