import { Prisma } from "@prisma/client";

/**
 * ZAJEDNIČKO razrešenje IMENOVANIH primalaca obaveštenja (tabela mejlova →
 * mejl + `workers.id` most za zvonce). Izdvojeno iz `otpis-primaoci.ts` (037/26)
 * kad je 034/26 uveo drugu imenovanu listu (`montaza_nm_primaoci`) — logika
 * dedup-a i mosta ka `users` mora biti JEDNA (pouka 030/26: kopija deljene
 * logike se popravi na jednom mestu, a bag ostane na drugom).
 *
 * Ugovor (isti za sve imenovane liste):
 *   • red tabele = ručno kurirana odluka; mejl ide svakom validnom redu, imao
 *     nalog u aplikaciji ili ne;
 *   • zvonce ide samo AKTIVNOM nalogu sa vezanim radnikom (`users.worker_id`);
 *     primalac bez toga dobija samo mejl — to nije greška, zvonce je
 *     worker-scoped po dizajnu;
 *   • dedup po mejlu case-insensitive, prvi viđeni red pobedjuje.
 */

/** Jedan razrešen primalac; `workerId = null` znači „samo mejl, bez zvonca". */
export interface NamedPrimalac {
  email: string;
  fullName: string | null;
  workerId: number | null;
}

/** Red imenovane liste kakav resolver očekuje (select {email, fullName}). */
export interface NamedPrimalacRow {
  email: string | null;
  fullName: string | null;
}

/** Minimalna Prisma površina koju most ka nalozima dira — PrismaService i `tx` oba pristaju. */
export type NamedPrimaociUserDb = Pick<Prisma.TransactionClient, "user">;

type UserRow = {
  email: string;
  fullName: string | null;
  workerId: number | null;
  active: boolean;
};

/**
 * Razreši redove imenovane liste u primaoce (mejl + workerId most). Prazan niz =
 * lista nije podešena — pozivalac loguje warn i preskače slanje (bez tihog
 * fallback-a na rolu; prazna lista je greška podešavanja koja mora da se vidi).
 */
export async function resolveNamedPrimaoci(
  db: NamedPrimaociUserDb,
  rows: NamedPrimalacRow[],
): Promise<NamedPrimalac[]> {
  // DB CHECK već drži mejlove malim slovima i bez razmaka, ali dedup/normalizacija
  // ostaju i ovde: resolver ne sme da zavisi od toga da li je constraint zatečen na
  // svakoj bazi (dev/test baze se prave i iz starijih dump-ova).
  const byEmail = new Map<string, { email: string; fullName: string | null }>();
  for (const r of rows) {
    const email = (r.email ?? "").trim();
    if (!email.includes("@")) continue;
    const key = email.toLowerCase();
    // Zadrži PRVI viđeni red (najniži id) — kasniji duplikat ne pregazuje oznaku.
    if (!byEmail.has(key)) byEmail.set(key, { email, fullName: r.fullName });
  }
  if (byEmail.size === 0) return [];

  // Nalozi se traže case-insensitive: `in` filter je u Postgresu osetljiv na velika
  // slova, pa bi red upisan drugačijim zapisom tiho ostao bez zvonca.
  const users = (await db.user.findMany({
    where: {
      OR: [...byEmail.keys()].map((email) => ({
        email: { equals: email, mode: "insensitive" as const },
      })),
    },
    select: { email: true, fullName: true, workerId: true, active: true },
  })) as UserRow[];

  const userByEmail = new Map<string, UserRow>();
  for (const u of users) {
    const key = (u.email ?? "").trim().toLowerCase();
    if (key && !userByEmail.has(key)) userByEmail.set(key, u);
  }

  return [...byEmail.entries()].map(([key, row]) => {
    const user = userByEmail.get(key);
    // Zvonce ide samo aktivnom nalogu sa vezanim radnikom; mejl ide svejedno, jer je
    // red u tabeli ručno kurirana odluka, a ne izvedena iz stanja naloga.
    const workerId =
      user && user.active && user.workerId != null && user.workerId > 0
        ? user.workerId
        : null;
    return {
      email: row.email,
      fullName: row.fullName ?? user?.fullName ?? null,
      workerId,
    };
  });
}

/** Distinct `workers.id` iz razrešenih primalaca (in-app fan-out). */
export function namedPrimaociWorkerIds(primaoci: NamedPrimalac[]): number[] {
  return [
    ...new Set(
      primaoci.map((p) => p.workerId).filter((id): id is number => id != null),
    ),
  ];
}
