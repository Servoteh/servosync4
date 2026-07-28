import { Prisma } from "@prisma/client";

/**
 * Primaoci obaveštenja o OTPISU MAŠINE (zahtev 037/26, dopuna — presuda Nenada 28.07).
 *
 * ZAŠTO IMENOVANA LISTA, A NE ROLA: prvo izdanje 037 je primaoce razrešavalo iz role
 * `users.role = 'sef'` („Šef proizvodnje" iz ROLE_CATALOG-a). Na produ tu rolu nema
 * nijedan ČOVEK — jedini nosilac je servisni nalog `pdm-bridge@servoteh.com` (bez
 * `worker_id`), pa je otpis mašine završavao kao warn u logu umesto kao obaveštenje.
 * Presuda: primaoci su imenovani ljudi. Interpretativno pravilo Nenada — kad u zahtevu
 * piše „šef proizvodnje", misle se ti ljudi, ne formalna rola. Rola se zato NE gleda
 * (unija bi mejlovala servisni sandučić pri svakom otpisu), a role korisnicima se ne
 * diraju: Zoran je `admin`, Nikola i Miljan `menadzment`, Luka i Ivan `viewer`.
 *
 * IZVOR = tabela `masina_otpis_primaoci` (glavna baza, app-owned), seed-ovana presudom.
 * To je PODEŠAVANJE, ne kod: lista se menja INSERT/UPDATE-om (`active = FALSE` gasi
 * primaoca) i važi od sledećeg otpisa — ovde nema keša, čita se pri svakom slanju.
 *
 * Dva kanala, jedno razrešenje:
 *   • mejl → svaki aktivan red (primalac ne mora imati nalog u aplikaciji);
 *   • in-app zvonce → `workers.id` preko mosta `users.email → users.worker_id`, pa
 *     primalac bez naloga ili bez vezanog radnika dobija SAMO mejl. To nije greška
 *     (npr. Luka i Ivan nemaju `worker_id`) — zvonce je worker-scoped po dizajnu.
 */

/** Jedan razrešen primalac; `workerId = null` znači „samo mejl, bez zvonca". */
export interface OtpisPrimalac {
  email: string;
  fullName: string | null;
  workerId: number | null;
}

/** Minimalna Prisma površina koju helper dira — PrismaService i `tx` oba pristaju. */
export type OtpisPrimaociDb = Pick<
  Prisma.TransactionClient,
  "user" | "masinaOtpisPrimalac"
>;

type UserRow = {
  email: string;
  fullName: string | null;
  workerId: number | null;
  active: boolean;
};

/**
 * Aktivni primaoci obaveštenja o otpisu, dedup-ovani po mejlu (case-insensitive).
 * Prazan niz = lista nije podešena — zvanje ovog helpera nikad ne baca zbog toga,
 * pozivalac loguje warn (vidi `MasinaOtpisNotifyService`).
 */
export async function resolveOtpisPrimaoci(
  db: OtpisPrimaociDb,
): Promise<OtpisPrimalac[]> {
  const rows = await db.masinaOtpisPrimalac.findMany({
    where: { active: true },
    orderBy: { id: "asc" },
    select: { email: true, fullName: true },
  });

  // DB CHECK već drži mejlove malim slovima i bez razmaka, ali dedup/normalizacija
  // ostaju i ovde: helper ne sme da zavisi od toga da li je constraint zatečen na
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
