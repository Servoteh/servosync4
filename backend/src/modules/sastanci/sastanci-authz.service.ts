import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Prepis sy15 gejtova prava koje je domen sastanaka koristio kroz RLS i kroz
 * `SECURITY DEFINER` funkcije — sada nad 3.0 `users` / `user_roles`.
 *
 * ZAŠTO POSTOJI: u sy15 su sva prava reda išla kroz tri funkcije koje čitaju
 * `auth.jwt() ->> 'email'` i sy15 tabelu `user_roles`:
 *
 *   sy15                              ->  ovde
 *   ---------------------------------------------------------------
 *   current_user_is_management()      ->  isManagement(email)
 *   current_user_is_admin()           ->  isAdmin(email)
 *   has_edit_role()                   ->  hasEditRole(email)
 *   is_sastanak_ucesnik(sastanak_id)  ->  isUcesnik(email, sastanakId)
 *   sast_user_can_move_weekly()       ->  canMoveWeekly(email)
 *
 * PARITET KOJI SE MORA ZADRŽATI (izmereno `pg_get_functiondef` na živoj sy15,
 * 06.08.2026):
 *   - poređenje mejla je `lower(...)` sa OBE strane; prazan mejl = false
 *     (nikad „true jer nije nađen red"),
 *   - `current_user_is_management` traži rolu `admin` ILI `menadzment` i
 *     `project_id IS NULL` (globalni domet) i `is_active = TRUE`,
 *   - `has_edit_role` je ŠIRI skup: `admin, hr, menadzment, pm, leadpm,
 *     poslovni_admin` (takođe globalni domet),
 *   - `sast_user_can_move_weekly` NE gleda rolu nego ISKLJUČIVO allowlist
 *     tabelu `sast_weekly_movers` (koja putuje sa domenom).
 *
 * RAZLIKA sy15 -> 3.0 KOJU TREBA ZNATI: sy15 je imao JEDNU tabelu `user_roles`
 * (mejl + rola + project_id). 3.0 ima DVA mesta: `users.role` (primarna rola) i
 * `user_roles` (dodatne, sa `scope_type`). Zato se gleda unija oba — inače bi
 * korisnik čija je jedina rola primarna (`users.role='menadzment'`, bez reda u
 * `user_roles`) izgubio pravo koje je u sy15 imao. `scope_type='global'` je
 * parnjak sy15 uslovu `project_id IS NULL`.
 */

/** `current_user_is_management()` — role sa punim pravom nad sastancima. */
const MANAGEMENT_ROLES = new Set(["admin", "menadzment"]);

/** `has_edit_role()` — role kojima je dozvoljen upis (bez project-scoped grane). */
const EDIT_ROLES = new Set([
  "admin",
  "hr",
  "menadzment",
  "pm",
  "leadpm",
  "poslovni_admin",
]);

@Injectable()
export class SastanciAuthzService {
  constructor(private readonly prisma: PrismaService) {}

  /** Sve aktivne role korisnika (primarna + globalne dodatne), lowercase. */
  private async roles(email: string | null | undefined): Promise<Set<string>> {
    const key = (email ?? "").trim().toLowerCase();
    if (key === "") return new Set();
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: key, mode: "insensitive" }, active: true },
      select: { id: true, role: true },
    });
    if (!user) return new Set();
    const extra = await this.prisma.userRole.findMany({
      where: { userId: user.id, isActive: true, scopeType: "global" },
      select: { role: true },
    });
    const out = new Set<string>([user.role.toLowerCase()]);
    for (const r of extra) out.add(r.role.toLowerCase());
    return out;
  }

  /** Paritet `current_user_is_management()`. */
  async isManagement(email: string | null | undefined): Promise<boolean> {
    const rs = await this.roles(email);
    for (const r of rs) if (MANAGEMENT_ROLES.has(r)) return true;
    return false;
  }

  /** Paritet `current_user_is_admin()` (gejt `set_sastanci_ai_model`). */
  async isAdmin(email: string | null | undefined): Promise<boolean> {
    return (await this.roles(email)).has("admin");
  }

  /** Paritet `has_edit_role()` bez project-scoped grane (domen je ne koristi:
   *  sve politike sastanaka zovu `has_edit_role()` BEZ argumenta). */
  async hasEditRole(email: string | null | undefined): Promise<boolean> {
    const rs = await this.roles(email);
    for (const r of rs) if (EDIT_ROLES.has(r)) return true;
    return false;
  }

  /** Paritet `is_sastanak_ucesnik(uuid)` — poklapanje po `lower(email)`. */
  async isUcesnik(
    email: string | null | undefined,
    sastanakId: string | null | undefined,
  ): Promise<boolean> {
    const key = (email ?? "").trim().toLowerCase();
    if (key === "" || !sastanakId) return false;
    const n = await this.prisma.sastanakUcesnik.count({
      where: { sastanakId, email: { equals: key, mode: "insensitive" } },
    });
    return n > 0;
  }

  /**
   * Paritet `sast_user_can_move_weekly()` — ALLOWLIST tabela, ne rola.
   * (Namerno: pomeranje kolegijuma je poimenično pravo, ne posledica role.)
   */
  async canMoveWeekly(email: string | null | undefined): Promise<boolean> {
    const key = (email ?? "").trim().toLowerCase();
    if (key === "") return false;
    const n = await this.prisma.sastWeeklyMover.count({
      where: { email: { equals: key, mode: "insensitive" } },
    });
    return n > 0;
  }
}
