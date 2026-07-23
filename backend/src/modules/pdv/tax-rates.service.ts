import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma, type TaxRate } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  RATE_FIELDS,
  validateCreateTaxRate,
  validateUpdateTaxRate,
  type CreateTaxRateDto,
  type UpdateTaxRateDto,
} from "./dto/tax-rates.dto";

const D = Prisma.Decimal;

/**
 * TAX RATES — registar poreskih tarifa (R_Tarife → `tax_rates`) sa datumskim
 * resolverom efektivne stope.
 * ============================================================================
 * Efektivna stopa za `code` na dan `on`:
 *   validFrom (null = od uvek) ≤ on ≤ validTo (null = otvoreno), najnoviji validFrom
 *   pobeđuje kad ima više redova. Stopa = ZBIR svih pet komponenti (base + railway +
 *   city + war + special). ISTI algoritam kao robno `calculation.service.taxRateOf`
 *   (doc 39 §A / 43 §4) — drži se konzistentnim.
 *
 * Float→Decimal: kolone stopa su `Float?` u šemi (NE menjamo šemu). U servisu se
 * aritmetika (zbir/prikaz) radi kroz `Prisma.Decimal`, izlaz je string sa 2 decimale;
 * upis ostaje `number` (Prisma Float polje).
 *
 * NAPOMENA (šema): `code` je `@unique` → praktično jedna stopa po šifri. Provera
 * preklapanja intervala je pisana opšte (radi i ako se ograničenje kasnije ukine),
 * a jedinstvenost šifre se hvata kao 422 sa jasnom porukom.
 */
@Injectable()
export class TaxRatesService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Lista ─────────────────────────────────────────────────────────────────

  async list() {
    const rows = await this.prisma.taxRate.findMany({
      orderBy: [{ code: "asc" }, { validFrom: "desc" }],
    });
    return { data: rows.map((r) => this.serialize(r)) };
  }

  // ── Resolver efektivne stope na dan ─────────────────────────────────────────

  /** Efektivna stopa za `code` na dan `on` (default danas). 404 ako nema važećeg reda. */
  async resolve(code?: string, on?: string) {
    if (typeof code !== "string" || code.trim() === "")
      throw new BadRequestException("Parametar code je obavezan.");
    const asOf = on ? new Date(on) : new Date();
    if (Number.isNaN(asOf.getTime()))
      throw new BadRequestException(
        "Parametar on mora biti validan datum (YYYY-MM-DD).",
      );

    // Isti WHERE kao robno taxRateOf: validFrom null/≤asOf, validTo null/≥asOf, najnoviji validFrom.
    const row = await this.prisma.taxRate.findFirst({
      where: {
        code: code.trim(),
        OR: [{ validFrom: null }, { validFrom: { lte: asOf } }],
        AND: [{ OR: [{ validTo: null }, { validTo: { gte: asOf } }] }],
      },
      orderBy: [{ validFrom: "desc" }],
    });
    if (!row)
      throw new NotFoundException(
        `Nema važeće poreske stope za šifru ${code.trim()} na dan ${asOf
          .toISOString()
          .slice(0, 10)}.`,
      );

    return {
      data: { ...this.serialize(row), on: asOf.toISOString().slice(0, 10) },
    };
  }

  // ── Unos / izmena ───────────────────────────────────────────────────────────

  async create(dto: CreateTaxRateDto) {
    validateCreateTaxRate(dto);
    const code = dto.code.trim();
    const validFrom = new Date(dto.validFrom);
    const validTo = dto.validTo ? new Date(dto.validTo) : null;
    if (validTo && validTo < validFrom)
      throw new UnprocessableEntityException(
        "Datum kraja važenja ne sme biti pre datuma početka.",
      );

    await this.assertNoOverlap(code, validFrom, validTo, null);

    try {
      const row = await this.prisma.taxRate.create({
        data: {
          code,
          description: dto.description ?? null,
          baseRate: dto.baseRate ?? 0,
          railwayRate: dto.railwayRate ?? 0,
          cityRate: dto.cityRate ?? 0,
          warRate: dto.warRate ?? 0,
          specialRate: dto.specialRate ?? 0,
          vatGroup: dto.vatGroup ?? undefined,
          validFrom,
          validTo,
        },
      });
      return { data: this.serialize(row) };
    } catch (e) {
      this.rethrowUnique(e, code);
    }
  }

  async update(id: number, dto: UpdateTaxRateDto) {
    validateUpdateTaxRate(dto);
    const current = await this.prisma.taxRate.findUnique({ where: { id } });
    if (!current)
      throw new NotFoundException(`Poreska tarifa ${id} ne postoji.`);

    const validFrom =
      dto.validFrom !== undefined ? new Date(dto.validFrom) : current.validFrom;
    const validTo =
      dto.validTo !== undefined
        ? dto.validTo
          ? new Date(dto.validTo)
          : null
        : current.validTo;
    if (validFrom && validTo && validTo < validFrom)
      throw new UnprocessableEntityException(
        "Datum kraja važenja ne sme biti pre datuma početka.",
      );

    // Preklapanje samo protiv DRUGIH redova iste šifre (šifra se ne menja).
    if (validFrom)
      await this.assertNoOverlap(current.code, validFrom, validTo, id);

    const data: Prisma.TaxRateUpdateInput = {};
    if (dto.description !== undefined) data.description = dto.description;
    for (const f of RATE_FIELDS)
      if (dto[f] !== undefined) data[f] = dto[f];
    if (dto.vatGroup !== undefined) data.vatGroup = dto.vatGroup;
    if (dto.validFrom !== undefined) data.validFrom = validFrom;
    if (dto.validTo !== undefined) data.validTo = validTo;

    const row = await this.prisma.taxRate.update({ where: { id }, data });
    return { data: this.serialize(row) };
  }

  // ── Interni helpers ─────────────────────────────────────────────────────────

  /** Baca 422 ako novi/izmenjeni interval [from,to] preklapa neki drugi red iste šifre. */
  private async assertNoOverlap(
    code: string,
    from: Date,
    to: Date | null,
    excludeId: number | null,
  ): Promise<void> {
    const where: Prisma.TaxRateWhereInput = { code };
    if (excludeId != null) where.id = { not: excludeId };
    const others = await this.prisma.taxRate.findMany({ where });
    for (const o of others) {
      if (this.intervalsOverlap(from, to, o.validFrom, o.validTo))
        throw new UnprocessableEntityException(
          `Interval važenja se preklapa sa postojećom stopom šifre ${code} ` +
            `(id ${o.id}, važi ${o.validFrom ? this.fmt(o.validFrom) : "od uvek"}–${
              o.validTo ? this.fmt(o.validTo) : "otvoreno"
            }). Izmeni postojeću stopu ili suzi interval.`,
        );
    }
  }

  /** Preklapanje dva intervala; null = ±beskonačno (validFrom −∞, validTo +∞). */
  private intervalsOverlap(
    aFrom: Date,
    aTo: Date | null,
    bFrom: Date | null,
    bTo: Date | null,
  ): boolean {
    const aStart = aFrom.getTime();
    const aEnd = aTo ? aTo.getTime() : Infinity;
    const bStart = bFrom ? bFrom.getTime() : -Infinity;
    const bEnd = bTo ? bTo.getTime() : Infinity;
    return aStart <= bEnd && bStart <= aEnd;
  }

  /** P2002 (unique code) → 422 sa jasnom porukom; ostale greške propuštamo. */
  private rethrowUnique(e: unknown, code: string): never {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    )
      throw new UnprocessableEntityException(
        `Šifra tarife ${code} već postoji (jedna šifra = jedna stopa). Izmeni postojeću stopu.`,
      );
    throw e;
  }

  private fmt(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  private serialize(r: TaxRate) {
    const d = (v: number | null) => new D(v ?? 0);
    const total = d(r.baseRate)
      .add(d(r.railwayRate))
      .add(d(r.cityRate))
      .add(d(r.warRate))
      .add(d(r.specialRate));
    return {
      id: r.id,
      code: r.code,
      description: r.description,
      baseRate: d(r.baseRate).toFixed(2),
      railwayRate: d(r.railwayRate).toFixed(2),
      cityRate: d(r.cityRate).toFixed(2),
      warRate: d(r.warRate).toFixed(2),
      specialRate: d(r.specialRate).toFixed(2),
      // Efektivna stopa na dan = zbir svih komponenti (procenat, npr. 20).
      ratePct: total.toFixed(2),
      vatGroup: r.vatGroup,
      validFrom: r.validFrom,
      validTo: r.validTo,
    };
  }
}
