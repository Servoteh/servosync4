import { Injectable, Logger } from "@nestjs/common";
import { IzvorPrekidac, type Izvor } from "./izvor-prekidac";

/** Dozvoljene vrednosti prekidača `SCADA_IZVOR`. */
export type ScadaIzvor = Izvor;

/**
 * Prekidač izvora podataka za ENERGETIKU / SCADA (`SCADA_IZVOR`) — i ništa drugo.
 *
 *   SCADA_IZVOR=sy15  (PODRAZUMEVANO) — sve ide u sy15, ponašanje kao i do sad.
 *   SCADA_IZVOR=3.0                   — energetika čita 3.0 bazu.
 *
 * Korak 5 iz docs/PLAN_GASENJA_SY15_2026-08-03.md; merenje i runbook u
 * docs/SEOBA_SCADA_2026-08-07.md.
 *
 * ── 🔴 KOJE SVE POZIVAOCE POKRIVA (mereno pre uvođenja, ne pretpostavljeno) ───
 * Pouka incidenta 06.08.2026 (`SASTANCI_PB_IZVOR` je oborio Projektni biro):
 * prekidač prati STVARNE POZIVAOCE podataka, ne naziv domena. Mereno 07.08.2026,
 * tri nezavisna preseka — i sva tri daju ISTI, uzak odgovor:
 *
 *   1. `grep -rl scada backend/src` → 11 fajlova, ali samo `modules/energetika/*`
 *      stvarno DODIRUJE podatke. Ostalo je tekst, ne poziv:
 *        · `ai-chat/ai-tools.ts`  — pominje „Energetika/SCADA" u opisu za model
 *        · `common/authz/permissions.ts` + `role-permissions.ts` — dodela prava
 *        · `app.module.ts` / `energetika.module.ts` — ožičenje
 *      AI-asistent NEMA nijedan `scada_*` alat (za razliku od održavanja, gde
 *      `ai_chat_prijavi_kvar` PIŠE u domen — zato je tamo morao pod prekidač).
 *   2. `pg_depend` nad view-ovima sy15: **0 view-ova** čita `scada_*`. (Baš ovaj
 *      presek je kod održavanja otkrio `v_rev_machines`, šav koji FK graf ne vidi.)
 *   3. `pg_proc.prosrc ILIKE '%scada_%'`: **4 funkcije**, i sve četiri su SCADA
 *      sopstvene (`scada_watchdog`, `scada_claim_commands`, `scada_cancel_command`,
 *      `scada_alarm_push_trg`). Nijedan tuđi domen ne ulazi u ove tabele.
 *
 * Zaključak merenja: SCADA je zatvoren domen — jedini potrošač u aplikaciji je
 * `modules/energetika/*`, jedini pisac je relej (`bridge`, zaseban proces).
 *
 * ── PREKIDAČ POSTOJI NA DVA MESTA, I OBA MORAJU DA SE PREKLOPE ───────────────
 * Podatke NE piše backend nego `servoteh-bridge-scada` (systemd na ubuntusrv), koji
 * ima SVOJ `SCADA_IZVOR` u `~/bridge-scada/.env` (bridge/src/config.js). Ovaj ovde
 * presuđuje SAMO ČITANJE. Redosled preklopa (runbook §4) je zato: prvo relej na 3.0
 * (da tabele prestanu da budu prazne), pa tek onda backend. Obrnut redosled znači
 * prazan ekran; oba u sy15 ili oba u 3.0 su ispravna stanja.
 *
 * ── ŠTA POD `3.0` NIJE ISTO ──────────────────────────────────────────────────
 * 1. ISTORIJA NE POSTOJI na startu (odluka vlasnika 07.08.2026 — ne prenosi se).
 *    Trend-ekrani su prazni dok relej ne napuni prozor; alarmi kreću od nule.
 *    To je OČEKIVANO, ne kvar — i jedina stavka koju treba reći korisniku unapred.
 * 2. RLS ne postoji u 3.0 (sy15 je imao `scada_is_admin_or_management()` politike),
 *    pa pravo presuđuje ISKLJUČIVO `energetika.read`/`energetika.control` na HTTP
 *    sloju. Dodela prava se NE menja — ista dva ključa, iste role.
 * 3. Web-push na alarm (`scada_alarm_push_trg` → `push-dispatch`) se NE prenosi:
 *    push u 3.0 ionako ne radi (tri mrtve pretplate, v. cutover 1.0). Alarmi se i
 *    dalje vide na ekranu; `scada_notify_prefs` ostaje prazna tabela.
 */
@Injectable()
export class ScadaSourceService extends IzvorPrekidac {
  constructor() {
    super({
      envName: "SCADA_IZVOR",
      domen: "Energetika (SCADA)",
      logger: new Logger(ScadaSourceService.name),
      // Bez `zastareliAlias`: `SASTANCI_PB_IZVOR` nema veze sa ovim domenom
      // i ne sme da ga pomeri (v. incident 06.08.2026).
      porukaZaTriNula:
        "energetika čita 3.0 bazu. Relej (servoteh-bridge-scada) ima SVOJ " +
        "SCADA_IZVOR i mora biti preklopljen PRE ovoga, inače su ekrani prazni. " +
        "Istorija se NE prenosi (odluka vlasnika 07.08.2026) — trendovi kreću od " +
        "nule i pune se od trenutka preklopa.",
    });
  }
}
