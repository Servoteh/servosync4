import {
  resolvePermissionDecision,
  type EffectivePermissionDb,
} from "../../common/authz/effective-permission";
import { PERMISSIONS } from "../../common/authz/permissions";

/**
 * DVOSLOJNI PRISTUP MATIČNIM PODACIMA (odluka Nenad 29.07.2026).
 *
 * Ulazna kapija ruta `/artikli` i `/komitenti` je `directory.read` (širok read —
 * praktično svaka SSO uloga, `VIEWER_READ_BASELINE`). Unutar tog pristupa postoje
 * DVA SLOJA odgovora:
 *
 *   bazni (samo `directory.read`)  — identitet, klasifikacija, adresa/kontakt,
 *                                    dimenzije, opisi, linkovi, aktivan;
 *   komercijalni (+ `masters.read`) — cene, marže, rabati, provizije, žiro računi,
 *                                    kreditni limit, GK konta, dobavljač, carine.
 *
 * REDAKCIJA JE NA BACKEND-u, ne na FE-u: korisnik bez `masters.read` ne dobija te
 * kolone u JSON-u uopšte (ne „dobije pa se sakriju"). Zato je ovo servisni sloj —
 * `PermissionsGuard` zna samo da propusti/odbije celu rutu.
 *
 * Odluka se ne izvodi iz JWT-a nego kroz POSTOJEĆI `resolvePermissionDecision`
 * (isti helper koji koristi guard): rola + sveži `user_permission_overrides` iz
 * baze, u redosledu deny > grant > rola. Time grant/deny dat posle izdavanja
 * tokena važi na sledeći zahtev, bez re-logina, i FE `can()` i backend ne mogu da
 * se raziđu. Cena je jedan indeksirani point-select po zahtevu.
 */
export interface MastersActor {
  userId: number;
  role: string;
  email?: string;
}

/**
 * Sme li akter da vidi komercijalni sloj? FAIL-CLOSED: bez identiteta (teoretski
 * zahtev bez `req.user`) vraća se bazni sloj, nikad pun karton.
 */
export async function canReadCommercial(
  db: EffectivePermissionDb,
  actor: MastersActor | undefined | null,
): Promise<boolean> {
  if (!actor) return false;
  const decision = await resolvePermissionDecision(
    db,
    actor.userId,
    actor.role,
    PERMISSIONS.MASTERS_READ,
    actor.email,
  );
  return decision === "allow";
}
