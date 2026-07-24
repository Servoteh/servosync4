import { Prisma } from "@prisma/client";
import { ROLES } from "../authz/roles";

/**
 * Kriterijum za rolu MENADZMENT (COO krug — zahtev 004/26 §2, obaveštenje o novoj
 * neusaglašenosti). Obrazac PARALELAN `technologist-criteria.ts`
 * (`resolveTechnologistWorkerIds`), ali kriterijum je ROLA, ne worker-type:
 * menadžment su AKTIVNI korisnici sa `users.role = 'menadzment'`.
 *
 * Dva razrešenja jer su dva kanala fan-out-a:
 *   • in-app zvonce → trebaju `workers.id` (users.worker_id most; nalog bez vezanog
 *     radnika nema inbox red — to nije greška, deljeni terminali nemaju worker link).
 *   • mail → trebaju email-ovi.
 *
 * Oba su batch upiti bez required JOIN-a (legacy-read pravilo). Napomena: rola se u 2.0
 * drži kao jedinstven `users.role` (SSO ga poravna sa živom 1.0 rolom); nema `user_roles`
 * sloja u ovom čitanju — isti obrazac kao `zahtevi-mail.adminEmails` (users.role='admin').
 */
export const MANAGEMENT_ROLE = ROLES.MENADZMENT;

/** Minimalna Prisma površina koju helperi diraju — PrismaService i `tx` oba pristaju. */
export type ManagementCriteriaDb = Pick<Prisma.TransactionClient, "user">;

/** Aktivni menadžment korisnici sa vezanim radnikom → distinct `workers.id` (in-app fan-out). */
export async function resolveManagementWorkerIds(
  db: ManagementCriteriaDb,
): Promise<number[]> {
  const users = await db.user.findMany({
    where: { role: MANAGEMENT_ROLE, active: true, workerId: { not: null } },
    select: { workerId: true },
  });
  const ids = new Set<number>();
  for (const u of users)
    if (u.workerId != null && u.workerId > 0) ids.add(u.workerId);
  return [...ids];
}

/** Aktivni menadžment korisnici sa validnim email-om (mail fan-out). Dedup po email-u. */
export async function resolveManagementRecipients(
  db: ManagementCriteriaDb,
): Promise<Array<{ email: string; fullName: string | null }>> {
  const users = await db.user.findMany({
    where: { role: MANAGEMENT_ROLE, active: true },
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
