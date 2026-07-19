import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ProjectNumberingService } from "./project-numbering.service";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  type CreateCustomerRfqDto,
  validateCreateCustomerRfq,
  type UpdateCustomerRfqDto,
  validateUpdateCustomerRfq,
} from "./dto/customer-rfq.dto";

/**
 * NACRT — CustomerRfq (zahtev kupca za ponudu) + „Napravi predmet iz zahteva".
 * App-owned tabela (`customer_rfqs`) visi na projects mekim ref-om (Traka B §A).
 *
 * createProjectFromRfq (BigBit „Napravi predmet iz zahteva", :234):
 *   • samo ako projectId == null && description postoji (inače 422)
 *   • u JEDNOJ $transaction: projects.create (kopira customerId, generiše broj,
 *     workTypeId=1 TRGOVINA, prenese description) → write-back rfq.projectId
 *   • IDEMPOTENTNO: ako rfq već ima projectId, vraća postojeći predmet (bez duplog kreiranja)
 *
 * .nacrt = van build-a. Poslovne greške = NestJS ugrađeni exception-i (404/422).
 * `AuthUser` polje je `userId` (ne `id`).
 */
@Injectable()
export class CustomerRfqService {
  /** Vrsta posla „TRGOVINA" — predmet iz zahteva kupca podrazumevano je trgovina (BigBit). */
  private static readonly WORK_TYPE_TRGOVINA = 1;

  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: ProjectNumberingService,
  ) {}

  // ── CRUD ────────────────────────────────────────────────────────────────────

  async create(dto: CreateCustomerRfqDto, actor: AuthUser) {
    validateCreateCustomerRfq(dto);
    await this.assertCustomerExists(dto.customerId);

    return this.prisma.customerRfq.create({
      data: {
        customerId: dto.customerId,
        requestDate: dto.requestDate ? new Date(dto.requestDate) : new Date(),
        quoteDeadline: dto.quoteDeadline ? new Date(dto.quoteDeadline) : null,
        origin: dto.origin ?? null,
        salespersonId: dto.salespersonId ?? actor.userId, // default = onaj ko unosi
        proformaDocId: dto.proformaDocId ?? null,
        description: dto.description ?? null,
        note: dto.note ?? null,
        status: "DRAFT",
        createdByUserId: actor.userId,
      },
    });
  }

  async update(id: number, dto: UpdateCustomerRfqDto, actor: AuthUser) {
    validateUpdateCustomerRfq(dto);
    await this.getOrThrow(id);

    return this.prisma.customerRfq.update({
      where: { id },
      data: {
        ...(dto.quoteDeadline !== undefined
          ? {
              quoteDeadline: dto.quoteDeadline
                ? new Date(dto.quoteDeadline)
                : null,
            }
          : {}),
        ...(dto.origin !== undefined ? { origin: dto.origin } : {}),
        ...(dto.salespersonId !== undefined
          ? { salespersonId: dto.salespersonId }
          : {}),
        ...(dto.proformaDocId !== undefined
          ? { proformaDocId: dto.proformaDocId }
          : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
        updatedByUserId: actor.userId,
      },
    });
  }

  async get(id: number) {
    return this.getOrThrow(id);
  }

  async list(query: {
    status?: string;
    customerId?: number;
    unlinkedOnly?: boolean; // samo zahtevi bez predmeta (projectId == null)
    skip?: number;
    take?: number;
  }) {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.unlinkedOnly ? { projectId: null } : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.customerRfq.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: query.skip ?? 0,
        take: query.take ?? 50,
      }),
      this.prisma.customerRfq.count({ where }),
    ]);
    return { data, meta: { total } };
  }

  // ── NAPRAVI PREDMET IZ ZAHTEVA ──────────────────────────────────────────────

  /**
   * BigBit „Napravi predmet iz zahteva" (:234). Kreira predmet iz RFQ-a i vezuje ga
   * (write-back rfq.projectId) u JEDNOJ transakciji. Idempotentno: ako je predmet već
   * napravljen, vraća ga bez ponovnog kreiranja.
   */
  async createProjectFromRfq(rfqId: number, actor: AuthUser) {
    const rfq = await this.getOrThrow(rfqId);

    // Idempotencija: već napravljen predmet → vrati postojeći.
    if (rfq.projectId != null) {
      const existing = await this.prisma.project.findUnique({
        where: { id: rfq.projectId },
      });
      if (existing) return { project: existing, rfq, created: false };
      // rfq pokazuje na nepostojeći predmet (očišćen ručno) → dozvoli ponovno kreiranje.
    }

    // Preduslovi (BigBit): mora imati opis; predmet se pravi samo iz nespojenog zahteva.
    if (!rfq.description || rfq.description.trim().length === 0)
      throw new UnprocessableEntityException(
        "Zahtev nema opis — nije moguće napraviti predmet.",
      );

    await this.assertCustomerExists(rfq.customerId);

    const result = await this.prisma.$transaction(async (tx) => {
      const projectNumber = await this.numbering.next(tx);
      const project = await tx.project.create({
        data: {
          projectNumber,
          customerId: rfq.customerId, // kopira komitenta iz zahteva
          workTypeId: CustomerRfqService.WORK_TYPE_TRGOVINA, // 1 = TRGOVINA (BigBit)
          salespersonId: rfq.salespersonId ?? actor.userId,
          status: "UNKNOWN",
          description: rfq.description,
          // openedAt / createdAt: DB default (CURRENT_DATE / now())
        },
      });

      // write-back: veži zahtev na novonapravljeni predmet + status QUOTED
      const linkedRfq = await tx.customerRfq.update({
        where: { id: rfq.id },
        data: {
          projectId: project.id,
          status: "QUOTED",
          updatedByUserId: actor.userId,
        },
      });

      return { project, rfq: linkedRfq, created: true };
    });

    return result;
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private async getOrThrow(id: number) {
    const rfq = await this.prisma.customerRfq.findUnique({ where: { id } });
    if (!rfq) throw new NotFoundException(`Zahtev za ponudu ${id} ne postoji.`);
    return rfq;
  }

  private async assertCustomerExists(customerId: number): Promise<void> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer)
      throw new NotFoundException(`Komitent ${customerId} ne postoji.`);
  }
}
