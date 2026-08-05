/**
 * ZAJEDNIČKI helper za seobu sy15 -> 3.0: mapa identiteta i mapa predmeta.
 *
 * Korak 0 iz docs/PLAN_GASENJA_SY15_2026-08-03.md („mapa identiteta je preduslov
 * SVAKOG koraka" — 67 FK kolona po `public` šemi gađa `auth.users`). Napravljen je
 * uz korak 1 (sastanci + projektni biro) ali NAMERNO ne zna ništa o tom domenu —
 * koriste ga i naredni koraci (održavanje, reversi+lokacije, kadrovska).
 *
 * ŠTA RADI
 *   1. `buildUserMaps()`  — sy15 `auth.users.id` (uuid) i mejl -> 3.0 `users.id` (Int).
 *      Uparuje se ISKLJUČIVO po `lower(trim(email))`; SSO već tako radi.
 *   2. `buildProjectMap()` — sy15 `public.projects.id` (uuid) -> 3.0 `projects.id` (Int).
 *      Ključ je `projects.bigtehn_item_id`, koji JESTE 3.0 `projects.id`. Izmereno
 *      05.08: 22/23 sy15 reda ima `bigtehn_item_id` i svih 22 postoji u 3.0
 *      `projects` — poklapa se i nezavisna provera po šifri
 *      (`project_code` = `project_number`), 22/22. Jedini red bez parnjaka je
 *      sintetički `PRAC-PROD-TEST`.
 *
 * ZAŠTO SE KLJUČ MERI, A NE PRETPOSTAVLJA
 *   Presedan BigBit artikala: uparivanje po `items.id` dalo je 0/92.511 poklapanja,
 *   a po `external_item_id` 92.511/92.511. Zato obe mape vraćaju i `unmatched`
 *   spisak — pozivalac je dužan da ga pogleda pre `--apply`.
 *
 * ŠTA NE RADI
 *   Ne piše ništa. Ne pravi naloge koji fale. Nerazrešeno vraća kao podatak, da
 *   pozivalac odluči (preskoči red / ostavi NULL / prijavi kao blokadu).
 */

import type { PrismaClient } from "@prisma/client";

/** Normalizacija mejla — jedini dozvoljeni ključ uparivanja. */
export function normEmail(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const v = raw.trim().toLowerCase();
  return v === "" ? null : v;
}

export interface UserMaps {
  /** lower(email) -> 3.0 `users.id` */
  byEmail: Map<string, number>;
  /** sy15 `auth.users.id` (uuid, lowercase) -> 3.0 `users.id` */
  byAuthUuid: Map<string, number>;
  /** Mejlovi iz sy15 `auth.users` koji NEMAJU parnjaka u 3.0 `users`. */
  unmatchedEmails: string[];
  /** sy15 auth uuid-ovi bez parnjaka (uuid + mejl radi izveštaja). */
  unmatchedAuthUuids: { id: string; email: string | null }[];
}

/** Minimalni oblik sy15 klijenta koji nam treba — bez zavisnosti na generisani tip. */
export interface Sy15RawClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/**
 * Gradi mapu identiteta. ČITA sy15 (`auth.users`) i 3.0 (`users`) — samo SELECT.
 *
 * `auth` šema nije u `prisma/sy15.prisma` (Prisma pokriva samo `public`), pa se
 * čita sirovim upitom.
 */
export async function buildUserMaps(
  prisma: PrismaClient,
  sy15: Sy15RawClient,
): Promise<UserMaps> {
  const users = await prisma.user.findMany({ select: { id: true, email: true } });
  const byEmail = new Map<string, number>();
  for (const u of users) {
    const e = normEmail(u.email);
    if (e !== null) byEmail.set(e, u.id);
  }

  const authRows = await sy15.$queryRawUnsafe<{ id: string; email: string | null }[]>(
    `SELECT id::text AS id, email FROM auth.users`,
  );

  const byAuthUuid = new Map<string, number>();
  const unmatchedAuthUuids: { id: string; email: string | null }[] = [];
  const unmatchedEmails: string[] = [];
  for (const row of authRows) {
    const e = normEmail(row.email);
    const uid = e === null ? undefined : byEmail.get(e);
    if (uid === undefined) {
      unmatchedAuthUuids.push({ id: row.id, email: e });
      if (e !== null) unmatchedEmails.push(e);
      continue;
    }
    byAuthUuid.set(row.id.toLowerCase(), uid);
  }

  return { byEmail, byAuthUuid, unmatchedEmails, unmatchedAuthUuids };
}

export interface ProjectMap {
  /** sy15 `projects.id` (uuid, lowercase) -> 3.0 `projects.id` */
  byUuid: Map<string, number>;
  /** sy15 projekti bez parnjaka u 3.0 (uuid, šifra, razlog). */
  unmatched: { id: string; code: string | null; reason: string }[];
  /** Kontrolni broj: koliko se poklopilo i po ŠIFRI (nezavisna provera ključa). */
  matchedByCode: number;
}

/**
 * Gradi mapu predmeta sy15 uuid -> 3.0 `projects.id`.
 *
 * Primarni ključ je `bigtehn_item_id`. Uz to se NEZAVISNO broji poklapanje po
 * šifri (`project_code` = `project_number`) — ako se ta dva broja raziđu, ključ
 * nije ono što mislimo i pozivalac to mora videti pre prenosa.
 */
export async function buildProjectMap(
  prisma: PrismaClient,
  sy15: Sy15RawClient,
): Promise<ProjectMap> {
  const sy15Projects = await sy15.$queryRawUnsafe<
    { id: string; project_code: string | null; bigtehn_item_id: number | null }[]
  >(`SELECT id::text AS id, project_code, bigtehn_item_id FROM public.projects`);

  const ids = sy15Projects
    .map((p) => p.bigtehn_item_id)
    .filter((v): v is number => typeof v === "number");
  const codes = sy15Projects
    .map((p) => (p.project_code ?? "").trim())
    .filter((v) => v !== "");

  const byId = await prisma.project.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  const existingIds = new Set(byId.map((p) => p.id));

  const byCode = await prisma.project.findMany({
    where: { projectNumber: { in: codes } },
    select: { id: true, projectNumber: true },
  });
  const codeToId = new Map(byCode.map((p) => [p.projectNumber.trim(), p.id]));

  const map = new Map<string, number>();
  const unmatched: { id: string; code: string | null; reason: string }[] = [];
  let matchedByCode = 0;

  for (const p of sy15Projects) {
    const uuid = p.id.toLowerCase();
    const code = (p.project_code ?? "").trim();
    if (codeToId.has(code)) matchedByCode += 1;

    if (p.bigtehn_item_id == null) {
      unmatched.push({
        id: uuid,
        code: p.project_code,
        reason: "bigtehn_item_id je NULL (sintetički/test red)",
      });
      continue;
    }
    if (!existingIds.has(p.bigtehn_item_id)) {
      unmatched.push({
        id: uuid,
        code: p.project_code,
        reason: `3.0 projects.id=${p.bigtehn_item_id} ne postoji`,
      });
      continue;
    }
    map.set(uuid, p.bigtehn_item_id);
  }

  return { byUuid: map, unmatched, matchedByCode };
}
