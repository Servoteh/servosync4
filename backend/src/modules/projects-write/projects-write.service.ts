import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ProjectNumberingService } from "./project-numbering.service";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  type CreateProjectDto,
  validateCreateProject,
} from "./dto/create-project.dto";
import {
  type UpdateProjectDto,
  validateUpdateProject,
} from "./dto/update-project.dto";

/**
 * NACRT — write-path nad predmetima (Traka B §A). ODVOJEN modul od read-only
 * `directory` (listProjects/findProject netaknut). Piše DIREKTNO u `Project`
 * (2.0 = MASTER, odluka N3) — BEZ izmene modela u schema.prisma.
 *
 * Ključne poslovne odluke (PLAN_TRAKA_B §A / BigBit):
 *   • projectNumber = MAX(project_number::int)+1 u $transaction uz advisory lock (BigBit DMax+1)
 *   • openedAt = danas (koristi se DB default CURRENT_DATE; ne šaljemo iz koda)
 *   • salespersonId = JWT (vlasnik predmeta je onaj ko ga otvara)
 *   • status = "UNKNOWN" na kreiranju (BigBit početni status)
 *   • workTypeId OBAVEZNO ≠ 0 → UnprocessableEntityException „Niste definisali vrstu posla!!!"
 *   • customerId mora postojati (meki ref — validacija u servisu, nema DB FK)
 *
 * .nacrt = van build-a. Poslovne greške = NestJS ugrađeni exception-i (404/422),
 * kao ostatak repoa (nema još BusinessException — BACKEND_RULES §7).
 *
 * VAŽNO: `AuthUser` polje je `userId` (ne `id`) — vidi auth/jwt.strategy.ts.
 */
@Injectable()
export class ProjectsWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: ProjectNumberingService,
  ) {}

  /**
   * Kreiraj predmet. Broj se generiše serverski (advisory lock), openedAt preko DB
   * default-a (CURRENT_DATE), salespersonId iz JWT-a, status "UNKNOWN".
   */
  async createProject(dto: CreateProjectDto, actor: AuthUser) {
    validateCreateProject(dto);
    this.assertWorkTypeDefined(dto.workTypeId);
    await this.assertCustomerExists(dto.customerId);

    return this.prisma.$transaction(async (tx) => {
      const projectNumber = await this.numbering.next(tx);
      return tx.project.create({
        data: {
          projectNumber,
          customerId: dto.customerId,
          workTypeId: dto.workTypeId,
          salespersonId: actor.userId, // vlasnik = onaj ko otvara predmet
          status: "UNKNOWN", // BigBit početni status
          description: dto.description ?? null,
          projectName: dto.projectName ?? null,
          deadline: dto.deadline ? new Date(dto.deadline) : null,
          memo: dto.memo ?? null,
          // openedAt / createdAt: DB default (CURRENT_DATE / now()) — ne postavljamo iz koda
        },
      });
    });
  }

  /**
   * Izmeni predmet (PATCH). workTypeId ako se šalje mora ostati ≠ 0.
   *
   * `actor` je namerno zadržan u potpisu: `Project` je legacy keš bez
   * updatedByUserId/updatedAt, pa audit izmene ide u 2.0 `audit_log` (append-only)
   * pri aktivaciji — tada se ovde upisuje `actor.userId`. Do tada nema write u audit
   * (prefiks `_` da lint ne prijavi neiskorišćen parametar).
   */
  async updateProject(id: number, _actor: AuthUser, dto: UpdateProjectDto) {
    validateUpdateProject(dto);

    const existing = await this.prisma.project.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing)
      throw new NotFoundException(`Predmet ${id} ne postoji.`);

    if (dto.workTypeId !== undefined) this.assertWorkTypeDefined(dto.workTypeId);
    if (dto.customerId !== undefined)
      await this.assertCustomerExists(dto.customerId);

    return this.prisma.project.update({
      where: { id },
      data: {
        ...(dto.customerId !== undefined ? { customerId: dto.customerId } : {}),
        ...(dto.workTypeId !== undefined ? { workTypeId: dto.workTypeId } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.projectName !== undefined
          ? { projectName: dto.projectName }
          : {}),
        ...(dto.memo !== undefined ? { memo: dto.memo } : {}),
        ...(dto.nextAction !== undefined ? { nextAction: dto.nextAction } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.deadline !== undefined
          ? { deadline: dto.deadline ? new Date(dto.deadline) : null }
          : {}),
        ...(dto.closedAt !== undefined
          ? { closedAt: dto.closedAt ? new Date(dto.closedAt) : null }
          : {}),
      },
    });
  }

  // ── guards / helpers ────────────────────────────────────────────────────────

  /** BigBit pravilo: vrsta posla mora biti definisana (≠ 0). Domenski 422 sa BigBit porukom. */
  private assertWorkTypeDefined(workTypeId: number): void {
    if (workTypeId === 0)
      throw new UnprocessableEntityException("Niste definisali vrstu posla!!!");
  }

  /** Komitent mora postojati (meki ref, bez DB FK — validacija ovde). */
  private async assertCustomerExists(customerId: number): Promise<void> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer)
      throw new NotFoundException(`Komitent ${customerId} ne postoji.`);
  }
}
