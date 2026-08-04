import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  type CreateCustomerRfqDto,
  validateCreateCustomerRfq,
  type UpdateCustomerRfqDto,
  validateUpdateCustomerRfq,
} from "./dto/customer-rfq.dto";

/**
 * CustomerRfq — zahtev kupca za ponudu. App-owned tabela (`customer_rfqs`) koja na
 * predmet i komitenta visi MEKIM ref-om (bez DB FK).
 *
 * ODLUKA VLASNIKA 26.07.2026: predmeti se otvaraju samo u BigBit-u, pa je tok
 * „Napravi predmet iz zahteva" (BigBit :234, `createProjectFromRfq`) OBRISAN zajedno
 * sa `ProjectNumberingService`. Zamenjuje ga vezivanje POSTOJEĆEG predmeta:
 * `PATCH /rfqs/:id` sa `{ projectId }` — predmet mora već da postoji (stigao uvozom iz
 * BigBit-a), servis ga samo PROVERAVA čitanjem i nikad ne kreira.
 *
 * Poslovne greške = NestJS ugrađeni exception-i (404/409/422); poruke srpski.
 * `AuthUser` polje je `userId` (ne `id`).
 */
@Injectable()
export class CustomerRfqService {
  constructor(private readonly prisma: PrismaService) {}

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
    if (dto.projectId !== undefined && dto.projectId !== null)
      await this.assertProjectLinkable(dto.projectId, id);

    return this.prisma.customerRfq.update({
      where: { id },
      data: {
        ...(dto.projectId !== undefined ? { projectId: dto.projectId } : {}),
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

  // ── helpers ─────────────────────────────────────────────────────────────────

  /**
   * Predmet na koji se zahtev vezuje mora VEĆ da postoji (uvezen iz BigBit-a) i ne sme
   * biti zauzet drugim zahtevom (`uq_customer_rfqs_project` je 1:1). Ovde se predmet
   * SAMO ČITA — kreiranje predmeta u 3.0 ne postoji (odluka 26.07.2026).
   */
  private async assertProjectLinkable(
    projectId: number,
    rfqId: number,
  ): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project)
      throw new NotFoundException(
        `Predmet ${projectId} ne postoji u ServoSync-u. Otvorite ga u BigBit-u i ` +
          `sačekajte sledeći uvoz, pa ga onda vežite na zahtev.`,
      );

    const taken = await this.prisma.customerRfq.findFirst({
      where: { projectId, id: { not: rfqId } },
      select: { id: true },
    });
    if (taken)
      throw new ConflictException(
        `Predmet ${projectId} je već vezan za zahtev ${taken.id}.`,
      );
  }

  private async getOrThrow(id: number) {
    const rfq = await this.prisma.customerRfq.findUnique({ where: { id } });
    if (!rfq) throw new NotFoundException(`Zahtev za ponudu ${id} ne postoji.`);
    return rfq;
  }

  /** Komitent se SAMO ČITA — u ServoSync-u se ne otvara (odluka 26.07.2026). */
  private async assertCustomerExists(customerId: number): Promise<void> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer)
      throw new NotFoundException(
        `Komitent ${customerId} ne postoji u ServoSync-u. Unesite ga u BigBit — ovde ` +
          `stiže automatski noćnim uvozom i vidljiv je sutra ujutru; tek onda može ` +
          `na zahtev.`,
      );
  }
}
