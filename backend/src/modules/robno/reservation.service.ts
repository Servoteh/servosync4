import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { parseDateParam } from "../../common/date-params";
import { toDec, ZERO } from "./decimal.util";
import {
  EXPIRY_RELEASE_REASON,
  PROFORMA_DOCUMENT_TYPES,
  PROFORMA_LEVEL,
  RESERVATION_SOURCE_TYPES,
  RESERVATION_STATUS,
  RESERVATION_STATUSES,
  type AvailabilityRow,
  type ConsumeReservationDto,
  type CreateReservationDto,
  type ListReservationsQuery,
  type ReleaseReservationDto,
  type ReservationRow,
  type ReservationShortage,
  type ReservationSourceType,
  type ReserveForProformaDto,
  type StockKey,
} from "./dto/reservation.dto";

/** Jedna stavka za upis (interno) — količina je već `Prisma.Decimal`. */
interface ReservationLineInput {
  itemId: number;
  warehouseId: number;
  quantity: Prisma.Decimal;
  sourceLine: number | null;
}

/**
 * Rezervacija zaliha (C3) — predračun/porudžbina „drži" robu dok se ne izda ili otkaže,
 * da se ista roba ne obeća dvaput.
 *
 * IZVOR ISTINE za „rezervisano" je AGREGAT OTVORENIH redova `stock_reservations`
 * (`status='OPEN'`), NE denormalizovana kolona `StockLevel.reserved` — ta kolona je mrtav
 * legacy snapshot koji niko ne upisuje i namerno se NE dira (nema drifta koji bi trebalo
 * mirisati sa agregatom).
 *
 *   raspoloživo (available) = StockLevel.onHand − Σ quantity WHERE status='OPEN'
 *
 * Tok:
 *   predračun (PON/PROF, level 250) → `reserveForProforma` (OPEN po stavci)
 *     → otkazan/istekao  → `release`  (OPEN → RELEASED, `releasedAt` + `releaseReason`)
 *     → izdatnica razduži → `consume` (OPEN → CONSUMED — roba je otišla, ne vraća se u raspoloživo)
 *
 * Konkurentnost: provera raspoloživog i upis idu u JEDNOJ transakciji, serijalizovanoj
 * `pg_advisory_xact_lock` po (artikal, magacin) — inače bi dva paralelna predračuna oba
 * videla isto raspoloživo i prerezervisala zalihu. Prelazi statusa su CAS (`updateMany` sa
 * `status: 'OPEN'` u `where`), pa je dvostruko oslobađanje bezopasno (drugi put `count = 0`).
 *
 * Idempotencija: unique `uq_stock_reservations_source_line` na (source_type, source_id,
 * source_line). Bulk rezervacija predračuna postojeće redove PRESKAČE (ponovni klik / retry
 * ne sme da padne ni da duplira), a eksplicitna ručna rezervacija istog reda je 409.
 */
@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------ RASPOLOŽIVO

  /** Raspoloživo za jedan (artikal, magacin). */
  async availability(key: StockKey): Promise<{ data: AvailabilityRow }> {
    assertStockKey(key);
    const [row] = await computeAvailability(this.prisma, [key]);
    return { data: row };
  }

  /**
   * Raspoloživo za više (artikal, magacin) parova — JEDAN `groupBy` nad rezervacijama +
   * jedan `findMany` nad stanjem (bez N+1). Redosled odgovora prati redosled ulaza.
   */
  async availabilityMany(
    keys: readonly StockKey[],
  ): Promise<{ data: AvailabilityRow[] }> {
    for (const k of keys) assertStockKey(k);
    return { data: await computeAvailability(this.prisma, keys) };
  }

  // ------------------------------------------------------------ REZERVISANJE

  /**
   * Rezerviši zalihu po predračunu — jedna rezervacija po stavci sa artiklom
   * (`sourceType='invoice'`, `sourceId=invoiceId`, `sourceLine=lineNo`).
   *
   * Preduslov: `Invoice.documentType` ∈ {PON, PROF} i `level = 250` (nacrt). Knjižen račun
   * (level 0) više ne rezerviše — on razdužuje kroz izdatnicu.
   * `expiresAt` = `dueDate` predračuna (rok važenja) ako postoji; inače bez isteka.
   *
   * IDEMPOTENTNO: već postojeći red za (invoice, sourceId, lineNo) se PRESKAČE (ne pravi
   * duplikat, ne baca 409) — ponovni klik „Rezerviši" ili retry posle mrežne greške ne sme
   * da obori ceo dokument niti da traži ručno čišćenje; unique indeks je ključ idempotencije,
   * a odgovor po stavci kaže `created` / `skipped`.
   */
  async reserveForProforma(
    dto: ReserveForProformaDto,
    actorUserId?: number | null,
  ) {
    const invoiceId = dto?.invoiceId;
    if (!Number.isInteger(invoiceId) || invoiceId <= 0)
      throw new UnprocessableEntityException(
        "invoiceId je obavezan — pozitivan ceo broj.",
      );

    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { items: { orderBy: [{ lineNo: "asc" }, { id: "asc" }] } },
    });
    if (!invoice)
      throw new NotFoundException(`Predračun ${invoiceId} ne postoji.`);

    if (
      !PROFORMA_DOCUMENT_TYPES.has(invoice.documentType) ||
      invoice.level !== PROFORMA_LEVEL
    )
      throw new UnprocessableEntityException(
        `Rezervacija zaliha je moguća samo iz ponude/predračuna (PON/PROF, nacrt) — ` +
          `dokument ${invoice.documentNumber} je ${invoice.documentType} (nivo ${invoice.level}).`,
      );

    const warehouseId = resolveWarehouseId(dto.warehouseId);

    // Samo robne stavke (artikal + količina > 0). Uslužne stavke (bez itemId) ne drže zalihu.
    const goodsLines = invoice.items.filter(
      (it) => it.itemId != null && it.quantity.gt(0),
    );
    if (goodsLines.length === 0)
      throw new UnprocessableEntityException(
        "Predračun nema robnih stavki za rezervaciju (samo uslužne stavke bez artikla).",
      );

    // `sourceLine` = lineNo stavke; ako lineNo nije popunjen (0) ili se ponavlja, pada na
    // redni broj u dokumentu — duplikat bi tiho „progutao" stavku kroz unique indeks.
    const rawLines = goodsLines.map((it, idx) =>
      it.lineNo && it.lineNo > 0 ? it.lineNo : idx + 1,
    );
    const sourceLines =
      new Set(rawLines).size === rawLines.length
        ? rawLines
        : goodsLines.map((_, idx) => idx + 1);

    const result = await this.reserveLines(
      {
        sourceType: "invoice",
        sourceId: invoiceId,
        expiresAt: invoice.dueDate ?? null,
        note: dto.note?.trim() || null,
        lines: goodsLines.map((it, idx) => ({
          itemId: it.itemId as number,
          warehouseId,
          quantity: it.quantity,
          sourceLine: sourceLines[idx],
        })),
      },
      actorUserId,
      "skip",
    );

    this.logger.log(
      `Rezervacija predračuna ${invoice.documentNumber} (id ${invoiceId}, magacin ${warehouseId}): ` +
        `${result.created} novih, ${result.skipped} već postojećih.`,
    );
    return {
      data: {
        invoiceId,
        warehouseId,
        created: result.created,
        skipped: result.skipped,
        reservations: result.rows,
      },
    };
  }

  /**
   * Ručna rezervacija (`sourceType='manual'` podrazumevano) — jedan red, van dokumenta.
   * Za `manual` je `sourceId` podrazumevano 0 (nema izvornog dokumenta): unique indeks NE
   * blokira više takvih redova jer je `source_line` NULL, a PostgreSQL NULL-ove u UNIQUE
   * tretira kao različite. Eksplicitan duplikat (isti sourceType+sourceId+sourceLine) = 409.
   */
  async create(dto: CreateReservationDto, actorUserId?: number | null) {
    if (!Number.isInteger(dto?.itemId) || dto.itemId <= 0)
      throw new UnprocessableEntityException(
        "itemId je obavezan — pozitivan ceo broj.",
      );
    if (!Number.isInteger(dto?.warehouseId) || dto.warehouseId <= 0)
      throw new UnprocessableEntityException(
        "warehouseId je obavezan — pozitivan ceo broj.",
      );
    const quantity = toDec(dto.quantity);
    if (quantity.lessThanOrEqualTo(0))
      throw new UnprocessableEntityException(
        "Rezervisana količina mora biti veća od nule.",
      );

    const sourceType = dto.sourceType ?? "manual";
    if (!RESERVATION_SOURCE_TYPES.includes(sourceType))
      throw new UnprocessableEntityException(
        `Nepoznat izvor rezervacije '${String(dto.sourceType)}' ` +
          `(dozvoljeno: ${RESERVATION_SOURCE_TYPES.join(", ")}).`,
      );
    const sourceId = Number.isInteger(dto.sourceId)
      ? (dto.sourceId as number)
      : 0;
    const sourceLine =
      dto.sourceLine == null || !Number.isInteger(dto.sourceLine)
        ? null
        : dto.sourceLine;

    const result = await this.reserveLines(
      {
        sourceType,
        sourceId,
        expiresAt: parseDateParam(dto.expiresAt, "expiresAt") ?? null,
        note: dto.note?.trim() || null,
        lines: [
          {
            itemId: dto.itemId,
            warehouseId: dto.warehouseId,
            quantity,
            sourceLine,
          },
        ],
      },
      actorUserId,
      "conflict",
    );
    return { data: result.rows[0] };
  }

  // ------------------------------------------------------- PRELAZI STATUSA

  /**
   * Oslobodi rezervaciju (OPEN → RELEASED) — roba se vraća u raspoloživo. Bez `sourceLine`
   * oslobađa SVE otvorene redove izvora (otkazan ceo predračun).
   *
   * CAS: `updateMany` sa `status: 'OPEN'` u `where` — dvostruki poziv nije greška, drugi put
   * samo ne pomeri ništa (`released: 0`, `alreadyReleased: true`) i NE duplira efekat.
   * Nepostojeći izvor (nijedan red, ni u jednom statusu) = 404.
   */
  async release(dto: ReleaseReservationDto, actorUserId?: number | null) {
    return this.transition(
      dto,
      RESERVATION_STATUS.RELEASED,
      dto.reason,
      actorUserId,
    );
  }

  /**
   * Potroši rezervaciju (OPEN → CONSUMED) — poziva se kad izdatnica STVARNO razduži robu.
   * Za razliku od `release`, potrošena količina se NE vraća u raspoloživo (`onHand` je već
   * umanjen izdatnicom, pa bi vraćanje bilo dvostruko oslobađanje).
   */
  async consume(dto: ConsumeReservationDto, actorUserId?: number | null) {
    return this.transition(
      dto,
      RESERVATION_STATUS.CONSUMED,
      dto.reason,
      actorUserId,
    );
  }

  /**
   * Oslobodi jedan red po `id` (dugme „Oslobodi" na listi rezervacija). Isti CAS obrazac:
   * već oslobođen/potrošen red nije greška, samo `released: 0`.
   */
  async releaseById(id: number, reason?: string, actorUserId?: number | null) {
    if (!Number.isInteger(id) || id <= 0)
      throw new UnprocessableEntityException(
        "id rezervacije je obavezan — pozitivan ceo broj.",
      );
    const res = await this.prisma.stockReservation.updateMany({
      where: { id, status: RESERVATION_STATUS.OPEN },
      data: {
        status: RESERVATION_STATUS.RELEASED,
        releasedAt: new Date(),
        releaseReason: normalizeReason(reason) ?? "ručno oslobođena",
      },
    });
    if (res.count === 0) {
      const row = await this.prisma.stockReservation.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!row) throw new NotFoundException(`Rezervacija ${id} ne postoji.`);
      return {
        data: { id, released: 0, alreadyReleased: true, status: row.status },
      };
    }
    this.logger.log(
      `Oslobođena rezervacija ${id} (korisnik ${actorUserId ?? "?"}).`,
    );
    return {
      data: {
        id,
        released: 1,
        alreadyReleased: false,
        status: RESERVATION_STATUS.RELEASED,
      },
    };
  }

  /**
   * Oslobodi istekle rezervacije (`expiresAt < asOf`, `status='OPEN'`) — predračun je
   * prošao rok važenja, roba se vraća u raspoloživo. Idempotentno (CAS na status);
   * bezbedno za cron/ručni poziv više puta.
   */
  async expireDue(asOf: Date = new Date()) {
    const res = await this.prisma.stockReservation.updateMany({
      where: {
        status: RESERVATION_STATUS.OPEN,
        expiresAt: { not: null, lt: asOf },
      },
      data: {
        status: RESERVATION_STATUS.RELEASED,
        releasedAt: new Date(),
        releaseReason: EXPIRY_RELEASE_REASON,
      },
    });
    if (res.count > 0)
      this.logger.log(
        `Isteklo i oslobođeno ${res.count} rezervacija (as-of ${asOf.toISOString()}).`,
      );
    return { data: { released: res.count, asOf: asOf.toISOString() } };
  }

  // -------------------------------------------------------------------- READ

  /** Lista rezervacija (filter artikal/magacin/status/izvor), paginirano, najnovije prvo. */
  async list(query: ListReservationsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.StockReservationWhereInput = {};
    const itemId = intParam(query.itemId);
    if (itemId !== undefined) where.itemId = itemId;
    const warehouseId = intParam(query.warehouseId);
    if (warehouseId !== undefined) where.warehouseId = warehouseId;
    const sourceId = intParam(query.sourceId);
    if (sourceId !== undefined) where.sourceId = sourceId;
    if (query.status && RESERVATION_STATUSES.includes(query.status as never))
      where.status = query.status;
    if (
      query.sourceType &&
      RESERVATION_SOURCE_TYPES.includes(query.sourceType as never)
    )
      where.sourceType = query.sourceType;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockReservation.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
      this.prisma.stockReservation.count({ where }),
    ]);

    // Naziv/šifra artikla (meki ref items.id) — jedan upit po skupu id-jeva (bez N+1).
    const itemIds = [...new Set(rows.map((r) => r.itemId))];
    const items = itemIds.length
      ? await this.prisma.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, name: true, catalogNumber: true, unit: true },
        })
      : [];
    const itemById = new Map(items.map((i) => [i.id, i]));

    const data: ReservationRow[] = rows.map((r) => {
      const it = itemById.get(r.itemId);
      return {
        id: r.id,
        itemId: r.itemId,
        warehouseId: r.warehouseId,
        itemName: it?.name ?? null,
        itemCode: it?.catalogNumber ?? null,
        unit: it?.unit ?? null,
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        sourceLine: r.sourceLine,
        quantity: r.quantity.toFixed(3),
        status: r.status,
        releasedAt: r.releasedAt ? r.releasedAt.toISOString() : null,
        releaseReason: r.releaseReason,
        expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
        note: r.note,
        createdByUserId: r.createdByUserId,
        createdAt: r.createdAt.toISOString(),
      };
    });

    return { data, meta: pageMeta(page, pageSize, total) };
  }

  // ----------------------------------------------------------------- INTERNO

  /**
   * Zajednički CAS prelaz OPEN → (RELEASED | CONSUMED) po izvoru. `count === 0` znači „nema
   * više otvorenih" — to NIJE greška (idempotentno), osim ako izvor uopšte ne postoji (404).
   */
  private async transition(
    ref: ReleaseReservationDto | ConsumeReservationDto,
    target:
      | typeof RESERVATION_STATUS.RELEASED
      | typeof RESERVATION_STATUS.CONSUMED,
    reason: string | undefined,
    actorUserId?: number | null,
  ) {
    const sourceType = ref?.sourceType;
    if (!sourceType || !RESERVATION_SOURCE_TYPES.includes(sourceType))
      throw new UnprocessableEntityException(
        `sourceType je obavezan (dozvoljeno: ${RESERVATION_SOURCE_TYPES.join(", ")}).`,
      );
    if (!Number.isInteger(ref.sourceId))
      throw new UnprocessableEntityException(
        "sourceId je obavezan — ceo broj.",
      );

    const scope: Prisma.StockReservationWhereInput = {
      sourceType,
      sourceId: ref.sourceId,
    };
    if (ref.sourceLine != null && Number.isInteger(ref.sourceLine))
      scope.sourceLine = ref.sourceLine;

    const res = await this.prisma.stockReservation.updateMany({
      where: { ...scope, status: RESERVATION_STATUS.OPEN },
      data: {
        status: target,
        releasedAt: new Date(),
        releaseReason: normalizeReason(reason),
      },
    });

    if (res.count === 0) {
      const existing = await this.prisma.stockReservation.count({
        where: scope,
      });
      if (existing === 0)
        throw new NotFoundException(
          `Nema rezervacija za izvor ${sourceType} ${ref.sourceId}` +
            (scope.sourceLine != null
              ? `, stavka ${String(ref.sourceLine)}`
              : "") +
            ".",
        );
    } else {
      this.logger.log(
        `${target === RESERVATION_STATUS.RELEASED ? "Oslobođeno" : "Potrošeno"} ` +
          `${res.count} rezervacija (${sourceType} ${ref.sourceId}, korisnik ${actorUserId ?? "?"}).`,
      );
    }

    const released = target === RESERVATION_STATUS.RELEASED ? res.count : 0;
    return {
      data: {
        sourceType,
        sourceId: ref.sourceId,
        sourceLine: ref.sourceLine ?? null,
        status: target,
        /** Broj redova vraćenih u raspoloživo. */
        released,
        /** Broj redova označenih kao potrošeni (roba izdata). */
        consumed: res.count - released,
        /** true = nije bilo otvorenih redova (ponovljen poziv) — nije greška. */
        noop: res.count === 0,
      },
    };
  }

  /**
   * Jezgro upisa: provera raspoloživog + upis u JEDNOJ transakciji, serijalizovano
   * `pg_advisory_xact_lock` po (artikal, magacin) — ključevi se zaključavaju u sortiranom
   * redosledu (bez deadlock-a između paralelnih poziva sa preklapajućim artiklima).
   *
   * Sve stavke prolaze proveru PRE upisa (all-or-nothing): raspoloživo se umanjuje redom, pa
   * dve stavke istog artikla u istom predračunu ne mogu zajedno da prekorače stanje.
   */
  private async reserveLines(
    input: {
      sourceType: ReservationSourceType;
      sourceId: number;
      expiresAt: Date | null;
      note: string | null;
      lines: readonly ReservationLineInput[];
    },
    actorUserId: number | null | undefined,
    onDuplicate: "skip" | "conflict",
  ): Promise<{ created: number; skipped: number; rows: ReservationRow[] }> {
    const keys = dedupeKeys(input.lines);

    return this.prisma.$transaction(async (tx) => {
      // 1) Serijalizacija po (artikal, magacin) — sortirano da se paralelni pozivi ne uklješte.
      for (const k of keys) {
        const lockKey = `robno:reservation:${k.itemId}:${k.warehouseId}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      }

      // 2) Meki ref-ovi: artikli i magacini moraju postojati (BACKEND_RULES §4/§6).
      const itemIds = [...new Set(keys.map((k) => k.itemId))];
      const warehouseIds = [...new Set(keys.map((k) => k.warehouseId))];
      const [items, warehouses] = await Promise.all([
        tx.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, name: true, catalogNumber: true, unit: true },
        }),
        tx.warehouse.findMany({
          where: { id: { in: warehouseIds } },
          select: { id: true },
        }),
      ]);
      const itemById = new Map(items.map((i) => [i.id, i]));
      const missingItems = itemIds.filter((id) => !itemById.has(id));
      if (missingItems.length)
        throw new UnprocessableEntityException(
          `Artikli ne postoje: ${missingItems.join(", ")}.`,
        );
      const existingWarehouses = new Set(warehouses.map((w) => w.id));
      const missingWarehouses = warehouseIds.filter(
        (id) => !existingWarehouses.has(id),
      );
      if (missingWarehouses.length)
        throw new UnprocessableEntityException(
          `Magacini ne postoje: ${missingWarehouses.join(", ")}.`,
        );

      // 3) Već postojeći redovi ovog izvora — idempotencija po unique ključu.
      const existingRows = await tx.stockReservation.findMany({
        where: { sourceType: input.sourceType, sourceId: input.sourceId },
      });
      const existingByLine = new Map(
        existingRows.map((r) => [String(r.sourceLine ?? ""), r]),
      );

      // 4) Raspoloživo (onHand − Σ OPEN) unutar iste transakcije/zaključavanja.
      const availability = await computeAvailability(tx, keys);
      const availableByKey = new Map(
        availability.map((a) => [
          stockKeyOf(a.itemId, a.warehouseId),
          new Prisma.Decimal(a.available),
        ]),
      );

      // 5) Provera SVIH stavki pre upisa (all-or-nothing) uz umanjivanje po redu.
      const shortages: ReservationShortage[] = [];
      const toCreate: ReservationLineInput[] = [];
      let skipped = 0;
      for (const line of input.lines) {
        const dupKey = String(line.sourceLine ?? "");
        if (line.sourceLine != null && existingByLine.has(dupKey)) {
          if (onDuplicate === "conflict")
            throw new ConflictException(
              `Rezervacija za izvor ${input.sourceType} ${input.sourceId}, stavka ` +
                `${line.sourceLine} već postoji.`,
            );
          skipped += 1;
          continue; // postojeći OPEN red je već uračunat u „rezervisano" — ne broji se dvaput
        }
        const key = stockKeyOf(line.itemId, line.warehouseId);
        const available = availableByKey.get(key) ?? ZERO;
        if (available.lessThan(line.quantity)) {
          const it = itemById.get(line.itemId);
          shortages.push({
            itemId: line.itemId,
            warehouseId: line.warehouseId,
            itemName: it?.name ?? null,
            itemCode: it?.catalogNumber ?? null,
            requested: fmtQty(line.quantity),
            available: fmtQty(available),
          });
          continue;
        }
        availableByKey.set(key, available.sub(line.quantity));
        toCreate.push(line);
      }

      if (shortages.length) throw insufficientAvailability(shortages);

      // 6) Upis (P2002 = trka sa paralelnim pozivom → skip/409 po politici izvora).
      const created: ReservationRow[] = [];
      for (const line of toCreate) {
        try {
          const row = await tx.stockReservation.create({
            data: {
              itemId: line.itemId,
              warehouseId: line.warehouseId,
              sourceType: input.sourceType,
              sourceId: input.sourceId,
              sourceLine: line.sourceLine,
              quantity: line.quantity,
              status: RESERVATION_STATUS.OPEN,
              expiresAt: input.expiresAt,
              note: input.note,
              createdByUserId: actorUserId ?? null,
            },
          });
          const it = itemById.get(row.itemId);
          created.push({
            id: row.id,
            itemId: row.itemId,
            warehouseId: row.warehouseId,
            itemName: it?.name ?? null,
            itemCode: it?.catalogNumber ?? null,
            unit: it?.unit ?? null,
            sourceType: row.sourceType,
            sourceId: row.sourceId,
            sourceLine: row.sourceLine,
            quantity: row.quantity.toFixed(3),
            status: row.status,
            releasedAt: null,
            releaseReason: null,
            expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
            note: row.note,
            createdByUserId: row.createdByUserId,
            createdAt: row.createdAt.toISOString(),
          });
        } catch (e) {
          if (
            e instanceof Prisma.PrismaClientKnownRequestError &&
            e.code === "P2002" &&
            onDuplicate === "skip"
          ) {
            skipped += 1;
            continue;
          }
          if (
            e instanceof Prisma.PrismaClientKnownRequestError &&
            e.code === "P2002"
          )
            throw new ConflictException(
              `Rezervacija za izvor ${input.sourceType} ${input.sourceId}, stavka ` +
                `${String(line.sourceLine)} već postoji.`,
            );
          throw e;
        }
      }

      return { created: created.length, skipped, rows: created };
    });
  }
}

// ─────────────────────────────────────────────────────── deljeni helperi

/** Minimalni Prisma klijent koji `computeAvailability` traži (radi i sa `tx`). */
export type AvailabilityDb = Pick<
  Prisma.TransactionClient,
  "stockLevel" | "stockReservation"
>;

/** Ključ mape po (artikal, magacin). */
export function stockKeyOf(itemId: number, warehouseId: number): string {
  return `${itemId}:${warehouseId}`;
}

/**
 * Σ OTVORENIH rezervacija po (artikal, magacin) — JEDAN `groupBy` (bez N+1). `exclude`
 * izostavlja rezervacije jednog izvora: dokument koji TROŠI svoju rezervaciju ne sme sam
 * sebe da blokira pri proveri raspoloživog (izdatnica iz predračuna koji drži tu robu).
 *
 * Eksportovano jer je i `RobnoService` (lager + guard negativnog stanja) potrošač — logika
 * „rezervisano = agregat OPEN redova" živi na JEDNOM mestu.
 */
export async function sumOpenReservations(
  db: Pick<Prisma.TransactionClient, "stockReservation">,
  keys: readonly StockKey[],
  exclude?: { sourceType: string; sourceId: number },
): Promise<Map<string, Prisma.Decimal>> {
  const out = new Map<string, Prisma.Decimal>();
  if (keys.length === 0) return out;

  const where: Prisma.StockReservationWhereInput = {
    status: RESERVATION_STATUS.OPEN,
    itemId: { in: [...new Set(keys.map((k) => k.itemId))] },
    warehouseId: { in: [...new Set(keys.map((k) => k.warehouseId))] },
  };
  if (exclude)
    where.NOT = { sourceType: exclude.sourceType, sourceId: exclude.sourceId };

  const rows = await db.stockReservation.groupBy({
    by: ["itemId", "warehouseId"],
    where,
    _sum: { quantity: true },
  });
  for (const r of rows)
    out.set(stockKeyOf(r.itemId, r.warehouseId), r._sum.quantity ?? ZERO);
  return out;
}

/**
 * `available = onHand − Σ(OPEN rezervacije)` za zadate parove — dva agregatna upita ukupno
 * (stanje + rezervacije), bez obzira na broj parova.
 */
export async function computeAvailability(
  db: AvailabilityDb,
  keys: readonly StockKey[],
  exclude?: { sourceType: string; sourceId: number },
): Promise<AvailabilityRow[]> {
  if (keys.length === 0) return [];

  const [levels, reserved] = await Promise.all([
    db.stockLevel.findMany({
      where: {
        itemId: { in: [...new Set(keys.map((k) => k.itemId))] },
        warehouseId: { in: [...new Set(keys.map((k) => k.warehouseId))] },
      },
      select: { itemId: true, warehouseId: true, onHand: true },
    }),
    sumOpenReservations(db, keys, exclude),
  ]);
  const onHandByKey = new Map(
    levels.map((l) => [stockKeyOf(l.itemId, l.warehouseId), l.onHand]),
  );

  return keys.map((k) => {
    const key = stockKeyOf(k.itemId, k.warehouseId);
    const onHand = onHandByKey.get(key) ?? ZERO;
    const res = reserved.get(key) ?? ZERO;
    return {
      itemId: k.itemId,
      warehouseId: k.warehouseId,
      onHand: onHand.toFixed(3),
      reserved: res.toFixed(3),
      available: onHand.sub(res).toFixed(3),
    };
  });
}

/** 422 sa srpskom porukom koja NAVODI raspoloživu količinu po artiklu. */
export function insufficientAvailability(
  shortages: readonly ReservationShortage[],
): UnprocessableEntityException {
  const human = shortages
    .map((s) => {
      const label = s.itemName
        ? `${s.itemName}${s.itemCode ? ` (${s.itemCode})` : ""}`
        : `artikal ${s.itemId}`;
      return `${label}, magacin ${s.warehouseId} — traženo ${s.requested}, raspoloživo ${s.available}`;
    })
    .join("; ");
  return new UnprocessableEntityException({
    code: "RESERVATION_EXCEEDS_AVAILABLE",
    message:
      `Rezervacija prekoračuje raspoloživo stanje: ${human}. ` +
      `Smanji količinu ili oslobodi postojeće rezervacije.`,
    shortages: [...shortages],
  });
}

/** Količina bez repova nula („2", „2,5" → „2.5") — čitljivo u poruci greške. */
function fmtQty(value: Prisma.Decimal): string {
  return value.toDecimalPlaces(3).toString();
}

function dedupeKeys(
  lines: ReadonlyArray<{ itemId: number; warehouseId: number }>,
): StockKey[] {
  const map = new Map<string, StockKey>();
  for (const l of lines)
    map.set(stockKeyOf(l.itemId, l.warehouseId), {
      itemId: l.itemId,
      warehouseId: l.warehouseId,
    });
  return [...map.values()].sort((a, b) =>
    a.itemId !== b.itemId ? a.itemId - b.itemId : a.warehouseId - b.warehouseId,
  );
}

function assertStockKey(key: StockKey): void {
  if (!Number.isInteger(key?.itemId) || key.itemId <= 0)
    throw new UnprocessableEntityException(
      "itemId je obavezan — pozitivan ceo broj.",
    );
  if (!Number.isInteger(key?.warehouseId) || key.warehouseId <= 0)
    throw new UnprocessableEntityException(
      "warehouseId je obavezan — pozitivan ceo broj.",
    );
}

function intParam(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? undefined : n;
}

function normalizeReason(reason: string | undefined): string | null {
  const r = reason?.trim();
  if (!r) return null;
  return r.length > 200 ? r.slice(0, 200) : r; // release_reason je VarChar(200)
}

/** Magacin iz opcija (pozitivan ceo broj) ili podrazumevani 1 (kao carry-over/izdatnica). */
function resolveWarehouseId(warehouseId?: number): number {
  return Number.isInteger(warehouseId) && (warehouseId as number) > 0
    ? (warehouseId as number)
    : 1;
}
