import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { CreateDictationDelegateDto } from "./dto/dictation-delegate.dto";
import { USER_REF_NOT_FOUND, resolveUserRef } from "./user-ref";

/** Ko poziva admin rutu (iz JWT-a) — upisuje se u `created_by_user_id`. */
export interface DelegateAdminActor {
  userId: number;
  email?: string | null;
}

/**
 * Upravljanje delegacijom diktafon „sandučeta" (`dictation_delegates`).
 *
 * Dozvola je par (vlasnik, delegat): delegat sme da pozove
 * `POST /v1/dictation-inbox/claim` sa vlasnikovim `ownerUserId`/`ownerEmail` i time
 * POTROŠI vlasnikov diktat. Zato je ovo admin posao — rute nose POSTOJEĆU permisiju
 * `settings.users` (ista kao konzola korisnika u Podešavanjima); NOVA permisija se
 * namerno NE uvodi.
 *
 * Tabela je mala (nekoliko redova), pa `list()` vraća sve — bez paginacije i filtera.
 * Nema soft-delete: dozvola se ili ima ili nema.
 */
@Injectable()
export class DictationDelegatesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Sve dozvole, najnovija prva, sa razrešenim e-mailovima obe strane. */
  async list() {
    const rows = await this.prisma.dictationDelegate.findMany({
      orderBy: { createdAt: "desc" },
    });
    const ids = new Set<number>();
    for (const r of rows) {
      ids.add(r.ownerUserId);
      ids.add(r.delegateUserId);
      if (r.createdByUserId) ids.add(r.createdByUserId);
    }
    const users = ids.size
      ? await this.prisma.user.findMany({
          where: { id: { in: Array.from(ids) } },
          select: { id: true, email: true, fullName: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));

    return {
      data: rows.map((r) => ({
        id: r.id,
        ownerUserId: r.ownerUserId,
        ownerEmail: byId.get(r.ownerUserId)?.email ?? null,
        ownerName: byId.get(r.ownerUserId)?.fullName ?? null,
        delegateUserId: r.delegateUserId,
        delegateEmail: byId.get(r.delegateUserId)?.email ?? null,
        delegateName: byId.get(r.delegateUserId)?.fullName ?? null,
        createdByUserId: r.createdByUserId,
        createdByEmail: r.createdByUserId
          ? (byId.get(r.createdByUserId)?.email ?? null)
          : null,
        note: r.note,
        createdAt: r.createdAt,
      })),
      meta: { count: rows.length },
    };
  }

  /**
   * Dodaj dozvolu. Idempotentno: isti par (vlasnik, delegat) vraća postojeći red
   * (unique `uq_dictation_delegates_owner_delegate`), ne pravi duplikat i ne puca.
   */
  async add(actor: DelegateAdminActor, dto: CreateDictationDelegateDto) {
    const ownerUserId = await this.requireUser(
      { userId: dto.ownerUserId, email: dto.ownerEmail },
      "owner",
      "vlasnika sandučeta",
    );
    const delegateUserId = await this.requireUser(
      { userId: dto.delegateUserId, email: dto.delegateEmail },
      "delegate",
      "delegata",
    );
    if (ownerUserId === delegateUserId) {
      throw new BadRequestException(
        "Vlasnik i delegat su isti nalog — svoje sanduče se povlači i bez dozvole.",
      );
    }

    const note = (dto.note ?? "").trim() || null;
    const existing = await this.prisma.dictationDelegate.findFirst({
      where: { ownerUserId, delegateUserId },
    });
    if (existing) return { data: existing, meta: { created: false } };

    const row = await this.prisma.dictationDelegate.create({
      data: {
        ownerUserId,
        delegateUserId,
        createdByUserId: actor.userId,
        note,
      },
    });
    return { data: row, meta: { created: true } };
  }

  /** Ukloni dozvolu po `id`. Nepostojeći id → 404 (da admin vidi da nije obrisao ništa). */
  async remove(id: number) {
    const row = await this.prisma.dictationDelegate.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException(`Delegacija #${id} ne postoji.`);
    await this.prisma.dictationDelegate.delete({ where: { id } });
    return { data: { id, removed: true } };
  }

  /** `…UserId` ILI `…Email` → `users.id`; nedostaje/ne postoji → 400/404 sa jasnom porukom. */
  private async requireUser(
    ref: { userId?: number; email?: string },
    label: string,
    human: string,
  ): Promise<number> {
    const resolved = await resolveUserRef(this.prisma, ref, label);
    if (resolved === null) {
      throw new BadRequestException(
        `Nedostaje ${human}: prosledi ${label}UserId ili ${label}Email.`,
      );
    }
    if (resolved === USER_REF_NOT_FOUND) {
      throw new NotFoundException(
        `Nema korisnika za ${human} (${ref.userId ?? ref.email}).`,
      );
    }
    return resolved;
  }
}
