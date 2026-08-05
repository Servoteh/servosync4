import { Prisma } from "@prisma/client";
import { resolveNamedPrimaoci, type NamedPrimalac } from "./named-primaoci";

/**
 * Primaoci obaveštenja o NEUSAGLAŠENOSTI NA MONTAŽI (zahtev 034/26 — komentar
 * Zorana Jarakovića 29.07: „Lista primalaca obaveštenja o neusaglašenosti nije
 * dobra. Primaoci treba da budu: zoran.jarakovic, nenad.jarakovic, nenad.nikolic,
 * milorad.jerotic, milan.stojadinovic, strahinja.petrovic, miljan.nikodijevic.").
 *
 * ZAŠTO IMENOVANA LISTA, A NE ROLA: prvo izdanje (004/26 §2) je razrešavalo iz
 * role `users.role = 'menadzment'` (`management-criteria.ts` — i dalje važi za
 * modul kvalitet). Na produ ta rola broji 19 naloga uključujući spoljne i test
 * adrese (hapfluid.rs, test@servoteh.com, jarakovic@gmail.com), a NE pokriva
 * Zorana i Nenada (rola `admin`) ni Milana Stojadinovića (`leadpm`) — izmereno
 * 04.08.2026. Presuda 037/26 (isti obrazac): primaoci su imenovani ljudi, role
 * korisnicima se ne diraju.
 *
 * IZVOR = tabela `montaza_nm_primaoci` (glavna baza, app-owned), seed = Zoranova
 * sedmorka. „Nenad Jaraković može da koriguje" → lista se uređuje u Podešavanja →
 * Notifikacije (admin, `MontazaNmPrimaociService`), a može i SQL-om (`active =
 * FALSE` gasi primaoca). Nema keša — čita se pri svakom slanju, promena važi od
 * sledeće prijave.
 *
 * Razrešenje (mejl svima + zvonce samo uz `users.worker_id` most) je zajedničko
 * za sve imenovane liste — `named-primaoci.ts`.
 */

/** Jedan razrešen primalac; `workerId = null` znači „samo mejl, bez zvonca". */
export type MontazaNmPrimalac = NamedPrimalac;

/** Minimalna Prisma površina koju helper dira — PrismaService i `tx` oba pristaju. */
export type MontazaNmPrimaociDb = Pick<
  Prisma.TransactionClient,
  "user" | "montazaNmPrimalac"
>;

/**
 * Aktivni primaoci obaveštenja o neusaglašenosti, dedup po mejlu (case-insensitive).
 * Prazan niz = lista nije podešena — pozivalac loguje warn i preskače slanje
 * (namerno BEZ tihog fallback-a na rolu — prazna lista mora da se vidi).
 */
export async function resolveMontazaNmPrimaoci(
  db: MontazaNmPrimaociDb,
): Promise<MontazaNmPrimalac[]> {
  const rows = await db.montazaNmPrimalac.findMany({
    where: { active: true },
    orderBy: { id: "asc" },
    select: { email: true, fullName: true },
  });
  return resolveNamedPrimaoci(db, rows);
}
