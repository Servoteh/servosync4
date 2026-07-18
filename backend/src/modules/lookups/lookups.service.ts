import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Lagani lookup-ovi za biranje iz liste (forme/filteri) — predmeti i komitenti.
 * Read-only nad BigBit cache / ServoSync tabelama; ograničeno na ~25 rezultata.
 */
@Injectable()
export class LookupsService {
  constructor(private readonly prisma: PrismaService) {}

  async projects(q?: string) {
    const where: Prisma.ProjectWhereInput = {};
    if (q) {
      where.OR = [
        { projectNumber: { contains: q, mode: "insensitive" } },
        { projectName: { contains: q, mode: "insensitive" } },
      ];
    }
    const rows = await this.prisma.project.findMany({
      where,
      take: 25,
      orderBy: { id: "desc" },
      select: {
        id: true,
        projectNumber: true,
        projectName: true,
        customerId: true,
        description: true,
      },
    });

    // Komitent uz predmet (D9: vidljiv prefill u „Novi RN") — batch-resolve
    // umesto required-JOIN-a (orphan customerId ne sme da obori lookup).
    // id=0 = Servoteh d.o.o. (interni komitent, legacy IDKomitent=0) — VALIDAN
    // komitent za interne predmete (npr. Repro), NE „nema komitenta"; zato se
    // uključuje (17.07: ~3900 postojećih RN-ova ima komitent 0).
    const customerIds = [
      ...new Set(rows.map((r) => r.customerId).filter((id) => id >= 0)),
    ];
    const customers = customerIds.length
      ? await this.prisma.customer.findMany({
          where: { id: { in: customerIds } },
          select: { id: true, name: true },
        })
      : [];
    const byId = new Map(customers.map((c) => [c.id, c]));
    const data = rows.map((r) => ({
      ...r,
      customer: byId.get(r.customerId) ?? null,
    }));
    return { data };
  }

  async customers(q?: string) {
    const where: Prisma.CustomerWhereInput = {};
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { taxId: { contains: q, mode: "insensitive" } },
      ];
    }
    const data = await this.prisma.customer.findMany({
      where,
      take: 25,
      orderBy: { name: "asc" },
      select: { id: true, name: true, city: true, taxId: true },
    });
    return { data };
  }
}
