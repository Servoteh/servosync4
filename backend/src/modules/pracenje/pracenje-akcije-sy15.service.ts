import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { mapSy15Error } from "../../common/sy15-error";
import { jsonSafe } from "../../common/json-safe";
import type { AkcioneTackeQueryDto } from "./dto/pracenje-query.dto";

/**
 * QUARANTINE: the ONE remaining sy15 dependency of the Praćenje module (F1). The
 * whole praćenje read/write surface now sits on the ORIGINAL 2.0 tables; only the
 * "action points" lookup still reads sy15, because the Sastanci / akcioni-plan
 * module (source of `v_akcioni_plan`) has NOT yet been ported to 2.0. Isolating it
 * here keeps `PracenjeService` (mutations) and `PracenjeReadService` (reads) 100%
 * sy15-free.
 *
 * TODO(pracenje): drop this provider and repoint `akcioneTacke` to 2.0 the moment
 * the akcioni-plan/sastanci module migrates off sy15 (then `promoteAkcionaTacka`
 * can be implemented too — see PracenjeService). Until then the `promote` bridge
 * (sy15 uuid action point → 2.0 Int activity) is not resolvable and returns 501.
 */
@Injectable()
export class PracenjeAkcijeSy15Service {
  constructor(private readonly sy15: Sy15Service) {}

  /**
   * Open action points of a project (`v_akcioni_plan`) — feeds the "promote to
   * activity" picker. Still sy15 (see class doc). `q.projekat` is a sy15 project
   * uuid; shape is unchanged from the 1.0 wire contract.
   */
  async akcioneTacke(email: string, q: AkcioneTackeQueryDto) {
    const projekat = q.projekat ?? null;
    try {
      return await this.sy15.withUserRls(email, async (tx: Sy15Tx) => {
        const data = await tx.$queryRaw(
          Prisma.sql`SELECT id, naslov, opis, projekat_id, sastanak_id, effective_status, rok, rok_text, odgovoran_label, odgovoran_text
            FROM v_akcioni_plan
            WHERE ${projekat ? Prisma.sql`projekat_id = ${projekat}::uuid` : Prisma.sql`projekat_id IS NOT NULL`}
              AND effective_status IN ('otvoren','u_toku','kasni')
            ORDER BY rok ASC NULLS LAST, created_at DESC`,
        );
        return { data: jsonSafe(data) };
      });
    } catch (e) {
      mapSy15Error(e);
    }
  }
}
