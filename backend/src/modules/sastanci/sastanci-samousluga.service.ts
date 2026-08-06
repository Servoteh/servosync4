import {
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Samouslužne radnje sastanaka nad 3.0 bazom — prepis sy15 `SECURITY DEFINER`
 * funkcija u NestJS (korak 1 seobe, docs/SEOBA_SASTANCI_PB_2026-08-05.md §4).
 *
 * Prepisane su TAČNO četiri, i to one koje su samouslužne: korisnik menja
 * ISKLJUČIVO svoj red, pravilo je „poklapanje po mejlu iz sesije", i nema
 * zavisnosti ni od `employees`, ni od view-ova, ni od RLS-a.
 *
 *   sy15 DEFINER fn                   ->  metoda ovde
 *   ------------------------------------------------------------------
 *   sastanci_set_my_rsvp              ->  setMyRsvp
 *   sastanci_set_my_priprema          ->  setMyPriprema
 *   sastanci_set_my_akcija_status     ->  setMyAkcijaStatus
 *   sastanci_get_or_create_my_prefs   ->  getOrCreateMyPrefs
 *
 * ZAŠTO SU BAŠ TE PRENETE: u sy15 su bile `SECURITY DEFINER` samo zato što RLS
 * politika ne bi dozvolila korisniku UPDATE nad `sastanak_ucesnici` / `akcioni_plan`.
 * Sama poslovna provera je jedan `WHERE lower(email) = jwt.email`. U 3.0 nema RLS-a
 * (ODLUKE.md — guardovi + query-scoping), pa taj `WHERE` postaje obično sužavanje
 * upita: pravilo je isto, samo ga sad sprovodi servis umesto baze.
 *
 * PARITET KOJI SE MORA ZADRŽATI (1:1 sa PL/pgSQL izvorom):
 *   - mejl se poredi `lower(...)` sa obe strane; prazan mejl u sesiji = greška,
 *   - `set_my_rsvp` prima samo 'dolazim' | 'ne_dolazim' | null (null = brisanje),
 *   - `set_my_akcija_status` prima samo 'otvoren' | 'u_toku' | 'zavrsen'
 *     (uži skup od CHECK-a na tabeli — namerno: samouslužno se ne sme staviti
 *     'otkazan'/'odlozen'/'kasni'),
 *   - `zavrsen` puni `zatvoren_at`/`zatvoren_by_email`, svaki drugi status ih BRIŠE
 *     (vraćanje akcije u rad mora obrisati potpis zatvaranja),
 *   - kad nijedan red ne odgovara, vraća se `not_participant` / `not_owner`
 *     (a NE 404) — pozivalac (kontroler) na to reaguje isto kao i do sada.
 */
@Injectable()
export class SastanciSamouslugaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Paritet `auth.jwt() ->> 'email'` + provera praznog iz PL/pgSQL izvora. */
  private normEmail(email: string | null | undefined, what: string): string {
    const v = (email ?? "").trim().toLowerCase();
    if (v === "") {
      throw new UnprocessableEntityException(`${what}: nedostaje email u sesiji`);
    }
    return v;
  }

  /**
   * Prepis `sastanci_set_my_rsvp(p_sastanak_id, p_status)`.
   * Vraća uneti status, `'cleared'` kad se briše, ili `'not_participant'`.
   */
  async setMyRsvp(
    email: string | null | undefined,
    sastanakId: string,
    status: string | null,
  ): Promise<string> {
    const v = this.normEmail(email, "RSVP");
    if (status !== null && status !== "dolazim" && status !== "ne_dolazim") {
      throw new UnprocessableEntityException(`RSVP: nevažeći status ${status}`);
    }
    // `updateMany` + poklapanje po lower(email): isti opseg kao `WHERE
    // sastanak_id = $1 AND lower(email) = $2` u DEFINER funkciji.
    const ids = await this.prisma.sastanakUcesnik.findMany({
      where: { sastanakId, email: { equals: v, mode: "insensitive" } },
      select: { email: true },
    });
    if (ids.length === 0) return "not_participant";
    await this.prisma.sastanakUcesnik.updateMany({
      where: { sastanakId, email: { in: ids.map((r) => r.email) } },
      data: { rsvpStatus: status, rsvpAt: new Date() },
    });
    return status ?? "cleared";
  }

  /**
   * Prepis `sastanci_set_my_priprema(p_sastanak_id, p_pripremljen, p_priprema)`.
   * `null` argument znači „ne diraj to polje"; prazan tekst pripreme -> NULL.
   * Vraća `'ok'` ili `'not_participant'`.
   */
  async setMyPriprema(
    email: string | null | undefined,
    sastanakId: string,
    pripremljen: boolean | null,
    priprema: string | null,
  ): Promise<string> {
    const v = this.normEmail(email, "Priprema");
    const rows = await this.prisma.sastanakUcesnik.findMany({
      where: { sastanakId, email: { equals: v, mode: "insensitive" } },
      select: { email: true },
    });
    if (rows.length === 0) return "not_participant";

    const data: { pripremljen?: boolean; priprema?: string | null } = {};
    if (pripremljen !== null) data.pripremljen = pripremljen;
    if (priprema !== null) {
      const trimmed = priprema.trim();
      data.priprema = trimmed === "" ? null : trimmed;
    }
    if (Object.keys(data).length > 0) {
      await this.prisma.sastanakUcesnik.updateMany({
        where: { sastanakId, email: { in: rows.map((r) => r.email) } },
        data,
      });
    }
    return "ok";
  }

  /**
   * Prepis `sastanci_set_my_akcija_status(p_akcija_id, p_status)` — status sme da
   * menja SAMO odgovorni za akciju. Vraća uneti status ili `'not_owner'`.
   */
  async setMyAkcijaStatus(
    email: string | null | undefined,
    akcijaId: string,
    status: string,
  ): Promise<string> {
    const v = this.normEmail(email, "Akcija");
    if (status !== "otvoren" && status !== "u_toku" && status !== "zavrsen") {
      throw new UnprocessableEntityException(`Akcija: nevažeći status ${status}`);
    }
    const rows = await this.prisma.akcionaTacka.findMany({
      where: { id: akcijaId, odgovoranEmail: { equals: v, mode: "insensitive" } },
      select: { id: true },
    });
    if (rows.length === 0) return "not_owner";

    const zavrsen = status === "zavrsen";
    await this.prisma.akcionaTacka.update({
      where: { id: akcijaId },
      data: {
        status,
        // Paritet CASE-a iz PL/pgSQL-a: svaki status koji NIJE 'zavrsen' briše
        // potpis zatvaranja — inače bi ponovo otvorena akcija ostala „zatvorena".
        zatvorenAt: zavrsen ? new Date() : null,
        zatvorenByEmail: zavrsen ? v : null,
        updatedAt: new Date(),
      },
    });
    return status;
  }

  /**
   * Prepis `sastanci_get_or_create_my_prefs()` — upsert reda podešavanja po mejlu
   * (ključ tabele je mejl, ne nalog). Podrazumevane vrednosti dolaze iz šeme.
   */
  async getOrCreateMyPrefs(email: string | null | undefined) {
    const v = this.normEmail(email, "Podešavanja obaveštenja");
    return this.prisma.sastanciNotificationPrefs.upsert({
      where: { email: v },
      create: { email: v },
      update: {},
    });
  }
}
