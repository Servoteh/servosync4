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
    const data = await this.prisma.project.findMany({
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
