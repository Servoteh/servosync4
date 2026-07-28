import { Prisma } from "@prisma/client";
import { ROLES } from "../authz/roles";

/**
 * Kriterijum za rolu SEF (šef proizvodnje — zahtev 037/26: otpis mašine mora da
 * obavesti šefa da preraspodeli poslove predviđene za nju). Obrazac je DOSLOVNO
 * `management-criteria.ts`, samo je rola druga: aktivni korisnici sa
 * `users.role = 'sef'`.
 *
 * Zašto baš `sef`: `ROLE_CATALOG` (authz/roles.ts) uz `sef` = „Šef proizvodnje"
 * stoji napomena da ta rola APSORBUJE CMMS `chief` — dakle isti krug ljudi koji je
 * u sy15 `maint_user_profiles.role='chief'`, ali razrešen iz GLAVNE baze (jedini
 * izvor koji nosi `users.email` + `workers.id`, a to su dva kanala fan-out-a).
 *
 * Dva razrešenja jer su dva kanala:
 *   • in-app zvonce → treba `workers.id` (users.worker_id most; nalog bez vezanog
 *     radnika nema inbox red — nije greška, mail ga svejedno pokriva).
 *   • mail → trebaju email-ovi.
 */
export const SEF_ROLE = ROLES.SEF;

/** Minimalna Prisma površina koju helperi diraju — PrismaService i `tx` oba pristaju. */
export type SefCriteriaDb = Pick<Prisma.TransactionClient, "user">;

/** Aktivni šefovi proizvodnje sa vezanim radnikom → distinct `workers.id` (zvonce). */
export async function resolveSefWorkerIds(
  db: SefCriteriaDb,
): Promise<number[]> {
  const users = await db.user.findMany({
    where: { role: SEF_ROLE, active: true, workerId: { not: null } },
    select: { workerId: true },
  });
  const ids = new Set<number>();
  for (const u of users)
    if (u.workerId != null && u.workerId > 0) ids.add(u.workerId);
  return [...ids];
}

/** Aktivni šefovi proizvodnje sa validnim email-om (mail fan-out). Dedup po email-u. */
export async function resolveSefRecipients(
  db: SefCriteriaDb,
): Promise<Array<{ email: string; fullName: string | null }>> {
  const users = await db.user.findMany({
    where: { role: SEF_ROLE, active: true },
    select: { email: true, fullName: true },
  });
  const byEmail = new Map<string, { email: string; fullName: string | null }>();
  for (const u of users) {
    const email = (u.email ?? "").trim();
    const key = email.toLowerCase();
    // Zadrži PRVI viđeni zapis (original casing) — dupli nalog istog mejla ne pregazuje.
    if (email.includes("@") && !byEmail.has(key))
      byEmail.set(key, { email, fullName: u.fullName });
  }
  return [...byEmail.values()];
}
