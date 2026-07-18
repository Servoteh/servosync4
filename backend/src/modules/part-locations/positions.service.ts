import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import {
  CreatePositionDto,
  UpdatePositionDto,
  validateCreatePosition,
  validateUpdatePosition,
} from "./dto/position.dto";

export interface ListPositionsQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga po šifri pozicije / opisu. */
  q?: string;
}

/**
 * Advisory-lock ključ za serijalizaciju ručne dodele `positions.id`. Kolona nema
 * DB sekvencu (legacy plain-INTEGER PK, `tPozicije` — vidi migration.sql), pa je
 * generisanje sledećeg id-ja pod `pg_advisory_xact_lock` zamena za sekvencu
 * (MODULE_SPEC_lokacije §6: legacy `DMax('IDPozicije')+1` je zamka koja race-uje —
 * NE portovati je bez zaštite).
 */
const POSITIONS_ID_LOCK_KEY = 913_700_001;

/**
 * Pozicije/police (MODULE_SPEC_lokacije §1/§5, Was: tPozicije) — matični CRUD šifarnik.
 * Samo polja koja stvarno postoje u Prisma modelu (`positionCode`, `description`) —
 * X/Y/Z koordinate pomenute u spec-u NISU deo trenutne šeme i ne izmišljaju se ovde.
 */
@Injectable()
export class PositionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListPositionsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const where: Prisma.PositionWhereInput = {};
    if (query.q) {
      where.OR = [
        { positionCode: { contains: query.q, mode: "insensitive" } },
        { description: { contains: query.q, mode: "insensitive" } },
      ];
    }
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.position.findMany({
        where,
        orderBy: [{ positionCode: "asc" }],
        skip,
        take,
      }),
      this.prisma.position.count({ where }),
    ]);
    return { data: rows, meta: pageMeta(page, pageSize, total) };
  }

  async create(dto: CreatePositionDto) {
    validateCreatePosition(dto);
    const created = await this.prisma.$transaction(async (tx) => {
      // Serijalizuj dodelu id-ja do kraja transakcije (nema DB sekvence na ovoj koloni).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${POSITIONS_ID_LOCK_KEY})`;
      const max = await tx.position.aggregate({ _max: { id: true } });
      const nextId = (max._max.id ?? 0) + 1;
      return tx.position.create({
        data: {
          id: nextId,
          positionCode: dto.positionCode.trim(),
          description: dto.description?.trim() || null,
        },
      });
    });
    return { data: created };
  }

  async update(id: number, dto: UpdatePositionDto) {
    validateUpdatePosition(dto);
    const existing = await this.prisma.position.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(`Pozicija ${id} ne postoji.`);
    const data: Prisma.PositionUpdateInput = {};
    if (dto.positionCode !== undefined)
      data.positionCode = dto.positionCode.trim();
    if (dto.description !== undefined)
      data.description = dto.description?.trim() || null;
    const updated = await this.prisma.position.update({ where: { id }, data });
    return { data: updated };
  }
}
