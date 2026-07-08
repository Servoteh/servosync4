import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";

/**
 * Poslovna polja komitenta (BigBit cache `customers`). NAMERNO izostavljeno:
 * bankovni računi (bankAccount1-3) i interne finansijske kolone (creditLimit,
 * customerDiscount, commissionPercent, fictitiousDiscount, manualMarkupPercent,
 * paymentTermDays, paymentMethod, checkDebt, balanceNote, priceListCode...).
 */
const CUSTOMER_BUSINESS_SELECT = {
  id: true,
  name: true,
  shortName: true,
  branch: true,
  city: true,
  address: true,
  postalCode: true,
  country: true,
  taxId: true,
  registrationNumber: true,
  phone: true,
  mobile: true,
  fax: true,
  email: true,
  webAddress: true,
  contact: true,
  note: true,
  salespersonId: true,
} as const;

/** Poslovna polja predmeta za listu (bez internih finansijskih kolona). */
const PROJECT_LIST_SELECT = {
  id: true,
  projectNumber: true,
  projectName: true,
  description: true,
  status: true,
  openedAt: true,
  closedAt: true,
  deadline: true,
  customerId: true,
  salespersonId: true,
} as const;

/**
 * Detalj predmeta = lista + kontakti/ugovor. NAMERNO izostavljeno:
 * procurementValue, customs, forwarding, transport, other, exchangeRate,
 * currency, foreignSupplierId (interne finansijske kolone).
 */
const PROJECT_DETAIL_SELECT = {
  ...PROJECT_LIST_SELECT,
  nextAction: true,
  memo: true,
  ourRef: true,
  ourContact1: true,
  ourContact2: true,
  ourPhone1: true,
  ourPhone2: true,
  theirRef: true,
  theirContact1: true,
  theirContact2: true,
  theirPhone1: true,
  theirPhone2: true,
  contractNumber: true,
  contractDate: true,
  orderNumber: true,
  orderDate: true,
  workUnitCode: true,
  workTypeId: true,
  createdAt: true,
} as const;

export interface ListCustomersQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga: naziv / PIB / mesto. */
  q?: string;
}

export interface ListProjectsQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga: broj predmeta / naziv predmeta / opis. */
  q?: string;
  /** Komitent. */
  customerId?: string;
  /** Status predmeta (String kolona, tačno poklapanje). */
  status?: string;
  /** Otvoren od (ISO). */
  from?: string;
  /** Otvoren do (ISO). */
  to?: string;
}

/**
 * Read-only pregled BigBit cache šifarnika (customers/projects/salespeople).
 * BACKEND_RULES §3: ove tabele piše samo bigbit-sync — OVDE NEMA MUTACIJA.
 */
@Injectable()
export class DirectoryService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- CUSTOMERS

  async listCustomers(query: ListCustomersQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.CustomerWhereInput = {};
    if (query.q) {
      where.OR = [
        { name: { contains: query.q, mode: "insensitive" } },
        { taxId: { contains: query.q, mode: "insensitive" } },
        { city: { contains: query.q, mode: "insensitive" } },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        orderBy: [{ name: "asc" }, { id: "asc" }],
        skip,
        take,
        select: CUSTOMER_BUSINESS_SELECT,
      }),
      this.prisma.customer.count({ where }),
    ]);

    const salespeople = await this.resolveSalespeople(
      rows.map((r) => r.salespersonId),
    );
    const data = rows.map((r) => ({
      ...r,
      salesperson: salespeople.get(r.salespersonId ?? 0) ?? null,
    }));

    return { data, meta: pageMeta(page, pageSize, total) };
  }

  async findCustomer(id: number) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      select: CUSTOMER_BUSINESS_SELECT,
    });
    if (!customer) throw new NotFoundException(`Komitent ${id} ne postoji`);

    const salespeople = await this.resolveSalespeople([customer.salespersonId]);
    const data = {
      ...customer,
      salesperson: salespeople.get(customer.salespersonId ?? 0) ?? null,
    };
    return { data };
  }

  // ---------------------------------------------------------------- PROJECTS

  async listProjects(query: ListProjectsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.ProjectWhereInput = {};
    if (query.q) {
      where.OR = [
        { projectNumber: { contains: query.q, mode: "insensitive" } },
        { projectName: { contains: query.q, mode: "insensitive" } },
        { description: { contains: query.q, mode: "insensitive" } },
      ];
    }
    const intEq = (v: string | undefined) => {
      const n = Number.parseInt(v ?? "", 10);
      return Number.isNaN(n) ? undefined : n;
    };
    where.customerId = intEq(query.customerId);
    if (query.status) where.status = query.status;
    if (query.from || query.to) {
      const range: Prisma.DateTimeFilter = {};
      if (query.from) range.gte = new Date(query.from);
      if (query.to) range.lte = new Date(query.to);
      where.openedAt = range;
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.project.findMany({
        where,
        orderBy: [{ openedAt: "desc" }, { id: "desc" }],
        skip,
        take,
        select: PROJECT_LIST_SELECT,
      }),
      this.prisma.project.count({ where }),
    ]);

    const [customers, salespeople] = await Promise.all([
      this.resolveCustomers(rows.map((r) => r.customerId)),
      this.resolveSalespeople(rows.map((r) => r.salespersonId)),
    ]);

    const data = rows.map((r) => ({
      ...r,
      customer: customers.get(r.customerId) ?? null,
      salesperson: salespeople.get(r.salespersonId) ?? null,
    }));

    return { data, meta: pageMeta(page, pageSize, total) };
  }

  async findProject(id: number) {
    const project = await this.prisma.project.findUnique({
      where: { id },
      select: PROJECT_DETAIL_SELECT,
    });
    if (!project) throw new NotFoundException(`Predmet ${id} ne postoji`);

    const [customers, salespeople, workOrdersCount] = await Promise.all([
      this.resolveCustomers([project.customerId]),
      this.resolveSalespeople([project.salespersonId]),
      this.prisma.workOrder.count({ where: { projectId: id } }),
    ]);

    const data = {
      ...project,
      customer: customers.get(project.customerId) ?? null,
      salesperson: salespeople.get(project.salespersonId) ?? null,
      workOrdersCount,
    };
    return { data };
  }

  // --- batch resolveri (izbegavaju required-relation JOIN koji puca na orphan FK) ---

  private async resolveCustomers(ids: (number | null | undefined)[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.customer.findMany({
        where: { id: { in: uniq } },
        select: { id: true, name: true, city: true },
      }),
    );
  }

  /** NIKAD ne vraćati salespeople.password / loginAccount / idNumber. */
  private async resolveSalespeople(ids: (number | null | undefined)[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.salesperson.findMany({
        where: { id: { in: uniq } },
        select: { id: true, name: true, firstName: true },
      }),
    );
  }
}
