import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { LocationsService } from "./locations.service";
import type { Sy15Service, Sy15Tx } from "../../common/sy15/sy15.service";
import type { LabelPrintService } from "../../common/printing/label-print.service";
import type {
  CageMoveDto,
  CreateLocationDto,
  CreateMovementDto,
  UpdateLocationDto,
} from "./dto/locations-tx.dto";

/**
 * Unit — Lokacije R2 mutacije (MODULE_SPEC_lokacije_30.md §3/§5).
 * Fokus: (1) payload PARITET 1.0 (camelCase DTO → snake_case jsonb ključevi),
 * (2) NATIVNA idempotencija (`client_event_uuid`; replay → meta.idempotent),
 * (3) jsonb envelope `{ok,error}` → HTTP mapiranje, (4) Prisma/PG greška iz CRUD-a
 * → HTTP (unique→409, not_found→404, triger→422). Bez sy15 baze — tx je mokovan.
 */
describe("LocationsService — R2 mutacije", () => {
  const EMAIL = "test@servoteh.com";
  const UUID = "3b241101-e2bb-4255-8caf-4136c566a962";
  const UUID2 = "16fd2706-8baf-433b-82eb-8c7fada847da";

  let tx: {
    $queryRawUnsafe: jest.Mock;
    $queryRaw: jest.Mock;
    locLocation: { create: jest.Mock; update: jest.Mock };
  };
  let sy15: { withUser: jest.Mock };
  let labelPrint: { printRawTspl: jest.Mock };
  let service: LocationsService;

  beforeEach(() => {
    tx = {
      $queryRawUnsafe: jest.fn(),
      $queryRaw: jest.fn(),
      locLocation: { create: jest.fn(), update: jest.fn() },
    };
    sy15 = {
      withUser: jest.fn((_email: string, fn: (t: Sy15Tx) => Promise<unknown>) =>
        fn(tx as unknown as Sy15Tx),
      ),
    };
    labelPrint = { printRawTspl: jest.fn() };
    service = new LocationsService(
      sy15 as unknown as Sy15Service,
      labelPrint as unknown as LabelPrintService,
    );
  });

  // ---------- createMovement: payload paritet + idempotency ----------

  const fullMovementDto = (): CreateMovementDto => ({
    clientEventUuid: UUID,
    itemRefTable: "bigtehn_rn",
    itemRefId: "9400/165",
    movementType: "TRANSFER",
    orderNo: "9400",
    drawingNo: "1091063",
    quantity: 5,
    toLocationId: UUID2,
    fromLocationId: UUID,
    movementReason: "premeštaj na policu",
    note: "napomena",
    movedAt: "2026-07-13T08:00:00.000Z",
  });

  it("createMovement: gradi snake_case jsonb payload 1:1 (paritet 1.0) i zove loc_create_movement($1)", async () => {
    tx.$queryRawUnsafe.mockResolvedValue([{ result: { ok: true, id: "m1" } }]);
    await service.createMovement(EMAIL, fullMovementDto());

    expect(sy15.withUser).toHaveBeenCalledWith(EMAIL, expect.any(Function));
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const args = tx.$queryRawUnsafe.mock.calls[0] as [string, string];
    expect(args[0]).toBe("SELECT loc_create_movement($1::jsonb) AS result");
    const payload = JSON.parse(args[1]) as Record<string, unknown>;
    expect(payload).toEqual({
      client_event_uuid: UUID,
      item_ref_table: "bigtehn_rn",
      item_ref_id: "9400/165",
      movement_type: "TRANSFER",
      order_no: "9400",
      drawing_no: "1091063",
      quantity: 5,
      to_location_id: UUID2,
      from_location_id: UUID,
      movement_reason: "premeštaj na policu",
      note: "napomena",
      moved_at: "2026-07-13T08:00:00.000Z",
    });
  });

  it("createMovement: izostavlja opciona polja koja nisu poslata (bez null-flood-a)", async () => {
    tx.$queryRawUnsafe.mockResolvedValue([{ result: { ok: true, id: "m1" } }]);
    await service.createMovement(EMAIL, {
      clientEventUuid: UUID,
      itemRefTable: "bigtehn_rn",
      itemRefId: "9400/165",
      movementType: "INITIAL_PLACEMENT",
      toLocationId: UUID2,
    });
    const args = tx.$queryRawUnsafe.mock.calls[0] as [string, string];
    const payload = JSON.parse(args[1]) as Record<string, unknown>;
    expect(payload).toEqual({
      client_event_uuid: UUID,
      item_ref_table: "bigtehn_rn",
      item_ref_id: "9400/165",
      movement_type: "INITIAL_PLACEMENT",
      to_location_id: UUID2,
    });
    expect("order_no" in payload).toBe(false);
    expect("from_location_id" in payload).toBe(false);
  });

  it("createMovement: replay (isti client_event_uuid) → meta.idempotent=true, prosleđuje envelope", async () => {
    tx.$queryRawUnsafe.mockResolvedValue([
      { result: { ok: true, id: "m1", idempotent: true } },
    ]);
    const res = await service.createMovement(EMAIL, fullMovementDto());
    expect(res.meta.idempotent).toBe(true);
    expect(res.data).toEqual({ ok: true, id: "m1", idempotent: true });
  });

  it("createMovement: prvi upis → meta.idempotent=false", async () => {
    tx.$queryRawUnsafe.mockResolvedValue([{ result: { ok: true, id: "m1" } }]);
    const res = await service.createMovement(EMAIL, fullMovementDto());
    expect(res.meta.idempotent).toBe(false);
  });

  it("createMovement: envelope not_authorized → 403", async () => {
    tx.$queryRawUnsafe.mockResolvedValue([
      { result: { ok: false, error: "not_authorized" } },
    ]);
    await expect(
      service.createMovement(EMAIL, fullMovementDto()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("createMovement: envelope insufficient_quantity → 422 (sa dostupno/traženo u poruci)", async () => {
    tx.$queryRawUnsafe.mockResolvedValue([
      {
        result: {
          ok: false,
          error: "insufficient_quantity",
          available: 2,
          requested: 5,
        },
      },
    ]);
    await expect(
      service.createMovement(EMAIL, fullMovementDto()),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      service.createMovement(EMAIL, fullMovementDto()),
    ).rejects.toThrow(/dostupno 2, traženo 5/);
  });

  it("createMovement: envelope not_authenticated → 401", async () => {
    tx.$queryRawUnsafe.mockResolvedValue([
      { result: { ok: false, error: "not_authenticated" } },
    ]);
    await expect(
      service.createMovement(EMAIL, fullMovementDto()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // ---------- moveCage ----------

  it("moveCage: prosleđuje cageId/newHallId/reason kao bind parametre", async () => {
    tx.$queryRaw.mockResolvedValue([{ result: { ok: true, id: UUID } }]);
    const dto: CageMoveDto = {
      cageId: UUID,
      newHallId: UUID2,
      reason: "reorg",
    };
    await service.moveCage(EMAIL, dto);
    const call = tx.$queryRaw.mock.calls[0] as unknown[];
    expect(call[1]).toBe(UUID);
    expect(call[2]).toBe(UUID2);
    expect(call[3]).toBe("reorg");
  });

  it("moveCage: bez reason → null bind", async () => {
    tx.$queryRaw.mockResolvedValue([{ result: { ok: true, id: UUID } }]);
    await service.moveCage(EMAIL, { cageId: UUID, newHallId: UUID2 });
    expect((tx.$queryRaw.mock.calls[0] as unknown[])[3]).toBeNull();
  });

  it("moveCage: cage_not_found → 404", async () => {
    tx.$queryRaw.mockResolvedValue([
      { result: { ok: false, error: "cage_not_found" } },
    ]);
    await expect(
      service.moveCage(EMAIL, { cageId: UUID, newHallId: UUID2 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("moveCage: not_a_cage → 422 (poslovna, ne 404)", async () => {
    tx.$queryRaw.mockResolvedValue([
      { result: { ok: false, error: "not_a_cage" } },
    ]);
    await expect(
      service.moveCage(EMAIL, { cageId: UUID, newHallId: UUID2 }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  // ---------- createLocation / updateLocation (Prisma + SQLSTATE→HTTP) ----------

  it("createLocation: INSERT sa is_active=true + trim (paritet 1.0 createLocation)", async () => {
    tx.locLocation.create.mockResolvedValue({ id: UUID });
    const dto: CreateLocationDto = {
      locationCode: "  H1-P05  ",
      name: "  Polica 5  ",
      locationType: "SHELF",
      parentId: UUID2,
    };
    const res = await service.createLocation(EMAIL, dto);
    expect(res.data).toEqual({ id: UUID });
    expect(tx.locLocation.create).toHaveBeenCalledWith({
      data: {
        locationCode: "H1-P05",
        name: "Polica 5",
        locationType: "SHELF",
        parentId: UUID2,
        capacityNote: null,
        notes: null,
        isActive: true,
      },
    });
  });

  it("createLocation: P2002 (unique location_code) → 409", async () => {
    tx.locLocation.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "6.19.3",
      }),
    );
    await expect(
      service.createLocation(EMAIL, {
        locationCode: "H1",
        name: "Hala 1",
        locationType: "WAREHOUSE",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("updateLocation: menja SAMO poslata polja (parent_id sme null = koren)", async () => {
    tx.locLocation.update.mockResolvedValue({ id: UUID });
    const dto: UpdateLocationDto = {
      name: " Nova ",
      parentId: null,
      isActive: false,
    };
    await service.updateLocation(EMAIL, UUID, dto);
    expect(tx.locLocation.update).toHaveBeenCalledWith({
      where: { id: UUID },
      data: { name: "Nova", parentId: null, isActive: false },
    });
  });

  it("updateLocation: prazan PATCH → 400", async () => {
    await expect(
      service.updateLocation(EMAIL, UUID, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.locLocation.update).not.toHaveBeenCalled();
  });

  it("updateLocation: P2025 (nema reda) → 404", async () => {
    tx.locLocation.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("missing", {
        code: "P2025",
        clientVersion: "6.19.3",
      }),
    );
    await expect(
      service.updateLocation(EMAIL, UUID, { name: "X" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("updateLocation: triger RAISE (Unknown request) → 422", async () => {
    tx.locLocation.update.mockRejectedValue(
      new Prisma.PrismaClientUnknownRequestError(
        "raw query failed\nPolica mora imati nadređenu halu",
        { clientVersion: "6.19.3" },
      ),
    );
    await expect(
      service.updateLocation(EMAIL, UUID, { locationType: "SHELF" }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  // ---------- sync arm/run-now ----------

  it("syncArm: not_admin envelope → 403", async () => {
    tx.$queryRaw.mockResolvedValue([
      { result: { ok: false, error: "not_admin" } },
    ]);
    await expect(service.syncArm(EMAIL, true)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("syncArm: ok envelope → data prosleđen", async () => {
    tx.$queryRaw.mockResolvedValue([{ result: { ok: true, armed: true } }]);
    const res = await service.syncArm(EMAIL, true);
    expect(res.data).toEqual({ ok: true, armed: true });
    expect((tx.$queryRaw.mock.calls[0] as unknown[])[1]).toBe(true);
  });

  it("syncRunNow: not_admin envelope → 403", async () => {
    tx.$queryRaw.mockResolvedValue([
      { result: { ok: false, error: "not_admin" } },
    ]);
    await expect(service.syncRunNow(EMAIL)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  // ---------- labels/print (reuse deljenog TSPL2 transporta) ----------

  it("printLabel: delegira na LabelPrintService.printRawTspl (reuse)", async () => {
    labelPrint.printRawTspl.mockResolvedValue({
      ok: true,
      bytes: 42,
      printer: "192.168.70.20:9100",
    });
    const dto = { tspl2: "CLS\nPRINT 1,1\n" };
    const res = await service.printLabel(dto);
    expect(labelPrint.printRawTspl).toHaveBeenCalledWith(dto);
    expect(res.data).toEqual({
      ok: true,
      bytes: 42,
      printer: "192.168.70.20:9100",
    });
  });
});
