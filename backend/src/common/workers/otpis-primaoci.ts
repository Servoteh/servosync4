import { Prisma } from "@prisma/client";
import { resolveNamedPrimaoci, type NamedPrimalac } from "./named-primaoci";

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
 * Razrešenje (mejl svima + zvonce samo uz `users.worker_id` most) je ZAJEDNIČKO za sve
 * imenovane liste — živi u `named-primaoci.ts` (od 034/26 ga deli i lista primalaca
 * neusaglašenosti na montaži, `montaza-nm-primaoci.ts`).
 */

/** Jedan razrešen primalac; `workerId = null` znači „samo mejl, bez zvonca". */
export type OtpisPrimalac = NamedPrimalac;

/** Minimalna Prisma površina koju helper dira — PrismaService i `tx` oba pristaju. */
export type OtpisPrimaociDb = Pick<
  Prisma.TransactionClient,
  "user" | "masinaOtpisPrimalac"
>;

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
  return resolveNamedPrimaoci(db, rows);
}
