import { Injectable, Logger } from "@nestjs/common";
import {
  IzvorPrekidac,
  ZASTARELI_ZAJEDNICKI_PREKIDAC,
  type Izvor,
} from "./izvor-prekidac";

/** Dozvoljene vrednosti prekidača `SASTANCI_IZVOR`. */
export type SastanciIzvor = Izvor;

/**
 * Prekidač izvora podataka za SASTANKE (`SASTANCI_IZVOR`) — i ništa drugo.
 *
 * Pokriva tabele `sastanci*`, `akcioni_plan*`, `pm_teme*`, `presek_*`,
 * `sast_weekly_*` i sve što na njima visi (samousluga, mejl kanal, dispatch,
 * scheduler poslovi domena). Projektni biro ima SVOJ prekidač (`PbSourceService`,
 * `PB_IZVOR`) i ovaj ga NE dodiruje.
 *
 *   SASTANCI_IZVOR=sy15  (PODRAZUMEVANO) — sve ide u sy15, ponašanje kao i do sad.
 *   SASTANCI_IZVOR=3.0                   — prenete putanje idu u 3.0 bazu.
 *
 * ── 🔴 ZAŠTO JE PREKIDAČ RAZDVOJEN (incident 06.08.2026) ──────────────────────
 * Do 06.08. je postojao JEDAN zajednički prekidač `SASTANCI_PB_IZVOR` za oba
 * modula, uz obrazloženje da su im tabele „isprepletane". Merenje seobe
 * (docs/SEOBA_SASTANCI_PB_2026-08-05.md §4) je to oborilo: domeni nemaju
 * transakcioni šav — sastanci su spremni, a PB visi o `employees` (kadrovska,
 * korak 4). Kad je prekidač na produkciji stao na `3.0`, sastanci su proradili,
 * ali je CEO projektni biro istog trena počeo da vraća 503 i posao
 * `pb-notify-dispatch` je padao na svaka 2 minuta. Zato: jedan prekidač = jedan
 * domen. Isto pravilo važi za korake 2–5 (održavanje, reversi).
 *
 * ⚠️ Zastareli naziv `SASTANCI_PB_IZVOR` se i dalje čita — ali SAMO ako
 * `SASTANCI_IZVOR` nije postavljen, SAMO za sastanke i uz glasno upozorenje.
 * `PB_IZVOR` ga ne gleda, pa stari naziv više NE MOŽE da obori projektni biro.
 *
 * ⚠️ STANJE 06.08.2026 (posle blokada 2+3+5-backend).
 *
 * PRENETO (radi pod `3.0`):
 *   - ŠEMA i PODACI (27 tabela, 1.120 redova — dokazano na probnoj bazi),
 *   - view-ovi `v_akcioni_plan` i `v_pm_teme_pregled`,
 *   - 4 samouslužne fn (`SastanciSamouslugaService`) + 17 pozvanih DEFINER fn i
 *     6 logičkih trigera (`SastanciFnService`) — među njima `sast_zakljucaj_sastanak`
 *     (zaključavanje + arhiva + zapisnik mejl), `sast_auto_create_weekly`,
 *     `sastanci_enqueue_*` i dispatch (dakle CEO mejl kanal sastanaka),
 *   - gejtovi prava koje je ranije sprovodio RLS (`SastanciAuthzService`) —
 *     READ-scope tri row-scoped SELECT politike I WRITE-scope svih 20 write
 *     politika domena sastanaka,
 *   - 3 scheduler posla sastanaka + dispečer sastanaka,
 *   - REGISTAR IDEMPOTENCIJE u 3.0 bazi (`api_idempotency` +
 *     `IdempotencyService`, generički za celu aplikaciju),
 *   - **CEO TABELARNI CRUD**: liste i pretraga, detalj, učesnici, tačke
 *     zapisnika, odluke, akcioni plan (uz revizioni trag), teme i draft tok,
 *     šabloni, arhiva, slike i potpisani URL-ovi,
 *   - **PREDMET (`projekat_id`) u OBA oblika** (`SastanciPredmetService`): DTO
 *     prima i sy15 uuid i 3.0 `Int`, a odgovor vraća oba
 *     (`projekatId` + `projekatUuid`) dok se FE ne uskladi.
 *
 * JOŠ NIJE PRENETO — zato pod `3.0` i dalje pada sa 503:
 *   - ⭐ lista prioritetnih predmeta (`get_predmet_plan_prioritet_ids` čita
 *     `production.predmet_plan_prioritet`) — NIJE domen sastanaka, stiže sa
 *     svojim modulom.
 *
 * Dve preostale READ-ONLY zavisnosti od sy15 (ni jedna nije upis, pa dve baze
 * ne mogu da se raziđu): `kadr_holidays` (pomeranje sedmičnog sa praznika,
 * fail-soft) i STORAGE bucket-i (fajlovi se u koraku 1 ne sele — putanje su
 * prenete i stari URL-ovi ostaju važeći).
 *
 * Zato pod `SASTANCI_IZVOR=3.0` NEPRENETE putanje NAMERNO padaju sa 503 i
 * jasnom porukom, umesto da tiho vrate prazan ili pogrešan odgovor — upis koji bi
 * ipak otišao u sy15 razišao bi dve baze, a to se ne vidi odmah.
 * Merenje i redosled preostalog posla: docs/SEOBA_SASTANCI_PB_2026-08-05.md §7b/§7c.
 */
@Injectable()
export class SastanciSourceService extends IzvorPrekidac {
  constructor() {
    super({
      envName: "SASTANCI_IZVOR",
      domen: "Sastanci",
      logger: new Logger(SastanciSourceService.name),
      zastareliAlias: ZASTARELI_ZAJEDNICKI_PREKIDAC,
      porukaZaTriNula:
        "CELI SASTANCI čitaju/pišu 3.0 bazu: tabelarni CRUD " +
        "(liste, detalj, učesnici, tačke, odluke, akcije + revizioni trag, teme, šabloni, " +
        "arhiva, slike), samousluga, zaključavanje i arhiva, pozivnice i podsetnici, " +
        "sedmični kolegijum, mejl kanal i dispatch, registar idempotencije. Predmet " +
        "(projekat_id) prima OBA oblika (sy15 uuid i 3.0 Int) i vraća oba " +
        "(projekatId + projekatUuid) — dok se FE ne uskladi. Iz sy15 se JOŠ ČITAJU " +
        "(read-only): kadr_holidays i storage bucket-i. Sa 503 i dalje pada ⭐ lista " +
        "prioritetnih predmeta (nije domen sastanaka). PROJEKTNI BIRO NIJE DIRNUT — " +
        "on ima svoj prekidač PB_IZVOR.",
    });
  }
}
