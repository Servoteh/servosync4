/**
 * Fiksni skup „odobravača primopredaje" (odluka Nenad 13.07.2026): tačno ovih
 * 6 ljudi biraju se sa padajuće liste na nacrtu kao adresat notifikacije i oni
 * su jedini koji smeju da kreiraju primopredaju (approve). 5 od njih dobija
 * `primopredaje.approve` preko `user_permission_overrides` (grant); igor.vostic
 * ga ima preko `menadzment` role. Guard je taj koji stvarno odlučuje o pravu —
 * ova lista je NAMENSKI skup za notifikaciju i „da li je projektant sam
 * odobravač" logiku, po eksplicitnoj odluci „tvrdo tih 6".
 *
 * Ključ je `workers.id` (in-app notifikacija se šalje po worker id-u), a ovde je
 * i email (za Resend). Ako se ekipa promeni — menja se OVDE (jedan izvor).
 * Prod worker_id/email potvrđeni 13.07 (users JOIN workers).
 */
export interface PrimopredajaApprover {
  workerId: number;
  email: string;
  fullName: string;
}

export const PRIMOPREDAJA_APPROVERS: readonly PrimopredajaApprover[] = [
  { workerId: 197, email: "igor.vostic@servoteh.com", fullName: "Igor Voštić" },
  {
    workerId: 2206,
    email: "milan.milovanovic@servoteh.com",
    fullName: "Milan Milovanović",
  },
  {
    workerId: 2207,
    email: "milan.stojadinovic@servoteh.com",
    fullName: "Milan Stojadinović",
  },
  {
    workerId: 2208,
    email: "milorad.jerotic@servoteh.com",
    fullName: "Milorad Jerotić",
  },
  {
    workerId: 2221,
    email: "nenad.nikolic@servoteh.com",
    fullName: "Nenad Nikolić",
  },
  {
    workerId: 2211,
    email: "slavisa.radosavljevic@servoteh.com",
    fullName: "Slaviša Radosavljević",
  },
] as const;

const APPROVER_WORKER_IDS = new Set(
  PRIMOPREDAJA_APPROVERS.map((a) => a.workerId),
);

/** Da li je dati radnik jedan od 6 odobravača (sam projektant → ne treba notif). */
export function isPrimopredajaApprover(workerId: number | null): boolean {
  return workerId != null && APPROVER_WORKER_IDS.has(workerId);
}

/** Odobravač po worker id-u, ili `undefined` (za validaciju izbora + email). */
export function findApproverByWorkerId(
  workerId: number,
): PrimopredajaApprover | undefined {
  return PRIMOPREDAJA_APPROVERS.find((a) => a.workerId === workerId);
}
