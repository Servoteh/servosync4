import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";

/**
 * SQLSTATE iz sy15 DB fn/RLS → HTTP semantika (paritet Reversi §5 / Sastanci):
 *   42501 → 403 (RLS/DEFINER `forbidden`)
 *   P0001/P0002/23514 → 422 (RAISE EXCEPTION / check, npr. nepoznat model, nevalidan smer)
 *   23505 → 409 (unique)
 *   P2002 (Prisma: unique violation na TYPED `.create()/.upsert()` — top-level `e.code`,
 *          BEZ `meta.code`) → 409 (isto kao 23505 iz raw SQL puta; re-integracija merge-klasa)
 *   P2025 (Prisma: RLS-filtrovan UPDATE/DELETE = 0 redova) → 403 (pozivalac je već razrešio postojanje)
 * Već-mapirane Nest izuzetke prosleđuje netaknute.
 */
export function mapSy15Error(e: unknown): never {
  if (
    e instanceof NotFoundException ||
    e instanceof ForbiddenException ||
    e instanceof UnprocessableEntityException ||
    e instanceof ConflictException
  ) {
    throw e;
  }
  const meta = (e as { meta?: { code?: string; message?: string } }).meta;
  const code = meta?.code ?? (e as { code?: string }).code;
  const message = meta?.message ?? (e as Error).message;
  if (code === "42501") throw new ForbiddenException(message);
  if (code === "P0001" || code === "P0002" || code === "23514")
    throw new UnprocessableEntityException(message);
  if (code === "23505" || code === "P2002")
    throw new ConflictException(message);
  if (code === "P2025") throw new ForbiddenException(message);
  throw e as Error;
}
