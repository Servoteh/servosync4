import { UnprocessableEntityException } from "@nestjs/common";

/**
 * Grupno odobravanje/odbijanje primopredaja (živa proba 13.07.2026, Miljan:
 * „odobrava se cela primopredaja — sve pozicije istog broja nacrta"). Legacy
 * paritet: `spPromeniStatusPrimopredaje` radi statuse 0/1/2 GRUPNO po nacrtu.
 *
 * Namerno EKSPLICITNA lista `handoverIds` (ne draftNumber): `drawing_handovers`
 * nema FK ka nacrtu — veza je heuristika (`resolveDraftContext`), pa autoritativan
 * skup bira klijent koji grupiše po `draftContext.draftNumber` iz enrich-a.
 */
export interface ApproveHandoverBatchDto {
  handoverIds: number[];
  /** Tehnolog koji piše TP — isti za ceo nacrt (kao per-red approve). */
  technologistId: number;
  dueDate?: string;
  isUrgent?: boolean;
  comment?: string;
}

export interface RejectHandoverBatchDto {
  handoverIds: number[];
  /** Razlog odbijanja — OBAVEZAN (kao per-red reject). */
  reason: string;
}

const MAX_BATCH = 500;

/** Zajednička validacija liste id-jeva: neprazna, ≤500, pozitivni int, dedup. */
export function validateHandoverIds(ids: unknown): number[] {
  if (!Array.isArray(ids) || ids.length === 0)
    throw new UnprocessableEntityException(
      "Lista primopredaja (handoverIds) je obavezna i ne sme biti prazna.",
    );
  if (ids.length > MAX_BATCH)
    throw new UnprocessableEntityException(
      `Najviše ${MAX_BATCH} primopredaja po grupnoj akciji.`,
    );
  const clean = new Set<number>();
  for (const id of ids) {
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0)
      throw new UnprocessableEntityException(
        "Svaki handoverId mora biti pozitivan ceo broj.",
      );
    clean.add(id);
  }
  return [...clean];
}
