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
    $executeRawUnsafe: jest.Mock;
    locLocation: { create: jest.Mock; update: jest.Mock };
    locItemPlacement: { findMany: jest.Mock; count: jest.Mock };
  };
  let sy15: {
    withUser: jest.Mock;
    withUserRls: jest.Mock;
    db: {
      locItemPlacement: { findMany: jest.Mock; count: jest.Mock };
      locLocationMovement: { findMany: jest.Mock; count: jest.Mock };
      userRoleSy15: { findMany: jest.Mock };
      $queryRaw: jest.Mock;
    };
  };
  let labelPrint: { printRawTspl: jest.Mock };
  let service: LocationsService;

  beforeEach(() => {
    tx = {
      $queryRawUnsafe: jest.fn(),
      $queryRaw: jest.fn(),
      $executeRawUnsafe: jest.fn(),
      locLocation: { create: jest.fn(), update: jest.fn() },
      locItemPlacement: { findMany: jest.fn(), count: jest.fn() },
    };
    const runTx = (_email: string, fn: (t: Sy15Tx) => Promise<unknown>) =>
      fn(tx as unknown as Sy15Tx);
    sy15 = {
      withUser: jest.fn(runTx),
      withUserRls: jest.fn(runTx),
      // sy15.db = BYPASSRLS put; placements reads NE smeju ovuda (leak).
      db: {
        locItemPlacement: { findMany: jest.fn(), count: jest.fn() },
        locLocationMovement: { findMany: jest.fn(), count: jest.fn() },
        userRoleSy15: { findMany: jest.fn() },
        $queryRaw: jest.fn(),
      },
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

  // ---------- R1 read leak fix: placements row-scoped → withUserRls ----------
  // Dokaz: listPlacements/lookupBarcode čitaju loc_item_placements (RLS
  // loc_placements_select krije rev_tools od ne-manage) kroz withUserRls, NE kroz
  // sy15.db (BYPASSRLS bi vratio skrivene rev_tools redove bilo kome sa read).

  it("listPlacements: čita kroz withUserRls (RLS scope), NIKAD kroz sy15.db (BYPASSRLS)", async () => {
    tx.locItemPlacement.findMany.mockResolvedValue([{ id: "p1" }]);
    tx.locItemPlacement.count.mockResolvedValue(1);
    const res = await service.listPlacements(
      { itemRefTable: "rev_tools" },
      EMAIL,
    );
    expect(sy15.withUserRls).toHaveBeenCalledWith(EMAIL, expect.any(Function));
    expect(sy15.db.locItemPlacement.findMany).not.toHaveBeenCalled();
    expect(sy15.db.locItemPlacement.count).not.toHaveBeenCalled();
    expect(res.data).toEqual([{ id: "p1" }]);
    const call = tx.locItemPlacement.findMany.mock.calls[0] as [
      { where: { itemRefTable: string } },
    ];
    expect(call[0].where.itemRefTable).toBe("rev_tools");
  });

  it("listPlacements: default bigtehn_rn ide kroz withUserRls", async () => {
    tx.locItemPlacement.findMany.mockResolvedValue([]);
    tx.locItemPlacement.count.mockResolvedValue(0);
    await service.listPlacements({}, EMAIL);
    expect(sy15.withUserRls).toHaveBeenCalledTimes(1);
  });

  it("listPlacements: nedozvoljen item_ref_table → 400, NE dira bazu", async () => {
    await expect(
      service.listPlacements({ itemRefTable: "employees" }, EMAIL),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sy15.withUserRls).not.toHaveBeenCalled();
    expect(sy15.db.locItemPlacement.findMany).not.toHaveBeenCalled();
  });

  it("lookupBarcode: ITEM razrešenje čita placements kroz withUserRls (ne sy15.db)", async () => {
    tx.locItemPlacement.findMany.mockResolvedValue([]);
    const out = await service.lookupBarcode(
      EMAIL,
      "RNZ:8693:7351/1088:0:39757",
    );
    expect((out.data as { kind: string }).kind).toBe("ITEM");
    expect(sy15.withUserRls).toHaveBeenCalledWith(EMAIL, expect.any(Function));
    expect(sy15.db.locItemPlacement.findMany).not.toHaveBeenCalled();
  });

  // ---------- R1 read dopune: „Korisnik" ime + Početna KPI (paritet FE) ----------

  it("listMovements: dodaje movedByName (ime iz user_roles po user_id), UUID movedBy ostaje", async () => {
    sy15.db.locLocationMovement.findMany.mockResolvedValue([
      { id: "m1", movedBy: UUID, itemRefId: "9400/1" },
      { id: "m2", movedBy: UUID2, itemRefId: "9400/2" },
    ]);
    sy15.db.locLocationMovement.count.mockResolvedValue(2);
    sy15.db.userRoleSy15.findMany.mockResolvedValue([
      { userId: UUID, fullName: "Marko Cvetić", email: "marko@x.com" },
    ]);
    sy15.db.$queryRaw.mockResolvedValue([]); // auth.users fallback za UUID2 → prazno

    const res = await service.listMovements({});
    const data = res.data as { movedBy: string; movedByName: string | null }[];
    expect(data[0]).toMatchObject({ movedBy: UUID, movedByName: "Marko Cvetić" });
    // UUID2 nema ni user_roles ni auth.users → null (FE zadrži UUID prefiks).
    expect(data[1]).toMatchObject({ movedBy: UUID2, movedByName: null });
    // Movements NISU row-scoped → čitaju se kroz sy15.db (BYPASSRLS), ne withUserRls.
    expect(sy15.db.locLocationMovement.findMany).toHaveBeenCalledTimes(1);
  });

  it("listMovements: full_name prazan → padne na email (user_roles), pa auth.users email", async () => {
    sy15.db.locLocationMovement.findMany.mockResolvedValue([
      { id: "m1", movedBy: UUID },
      { id: "m2", movedBy: UUID2 },
    ]);
    sy15.db.locLocationMovement.count.mockResolvedValue(2);
    sy15.db.userRoleSy15.findMany.mockResolvedValue([
      { userId: UUID, fullName: "   ", email: "kontrola@x.com" },
    ]);
    sy15.db.$queryRaw.mockResolvedValue([{ id: UUID2, email: "legacy@x.com" }]);

    const res = await service.listMovements({});
    const data = res.data as { movedByName: string | null }[];
    expect(data[0].movedByName).toBe("kontrola@x.com");
    expect(data[1].movedByName).toBe("legacy@x.com");
  });

  it("summary: vraća movements24h i movements7d (KALENDARSKI prozor, Belgrade ponoć)", async () => {
    sy15.db.locLocationMovement.count
      .mockResolvedValueOnce(3) // danas (od lokalne ponoći)
      .mockResolvedValueOnce(11); // 7 kalendarskih dana
    const res = await service.summary();
    expect(res.data).toEqual({ movements24h: 3, movements7d: 11 });
    const calls = sy15.db.locLocationMovement.count.mock.calls as [
      { where: { movedAt: { gte: Date } } },
    ][];
    const startToday = calls[0][0].where.movedAt.gte;
    const start7d = calls[1][0].where.movedAt.gte;
    expect(startToday).toBeInstanceOf(Date);
    // 7d prozor je RANIJI od današnjeg (ne rolling; kalendarski pre 6 dana).
    expect(start7d.getTime()).toBeLessThan(startToday.getTime());
    // Oba su Belgrade lokalna ponoć (00:00:00 u Belgrade zoni) — DST-bezbedna provera.
    const wall = (d: Date) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Belgrade",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(d);
    expect(wall(startToday)).toBe("00:00:00");
    expect(wall(start7d)).toBe("00:00:00");
    // Razmak = tačno 6 kalendarskih dana (Belgrade datum) — DST-bezbedno (bez ×24h).
    const bgDate = (d: Date) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Belgrade",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d);
    const diffDays = Math.round(
      (Date.parse(bgDate(startToday)) - Date.parse(bgDate(start7d))) /
        (24 * 3600_000),
    );
    expect(diffDays).toBe(6);
  });

  // ---------- #2: SVI RN po predmetu (batch nalepnice) — v_bigtehn_work_orders_with_mes_active ----------

  it("predmetWorkOrders: mapira view red u camelCase PIN oblik (BEZ is_mes_active filtera)", async () => {
    const raw = {
      id: 8693,
      item_id: 123,
      ident_broj: "9400/165",
      broj_crteza: "1091063",
      naziv_dela: "Nosač",
      materijal: "Č.4732",
      dimenzija_materijala: "Ø50",
      jedinica_mere: "kom",
      komada: 4,
      tezina_obr: 2.5,
      status_rn: false,
      revizija: "A",
      rok_izrade: new Date("2026-07-20T00:00:00.000Z"),
      is_mes_active: false, // MES-neaktivan RN je I DALJE u rezultatu (paritet 1.0)
    };
    sy15.db.$queryRaw
      .mockResolvedValueOnce([raw]) // rows
      .mockResolvedValueOnce([{ count: 1 }]); // count
    const res = await service.predmetWorkOrders("123", {});
    expect(res.data).toEqual([
      {
        workOrderId: 8693,
        itemId: 123,
        identBroj: "9400/165",
        crtez: "1091063",
        nazivDela: "Nosač",
        materijal: "Č.4732",
        dimenzijaMaterijala: "Ø50",
        jedinicaMere: "kom",
        komada: 4,
        tezinaObr: 2.5,
        statusRn: false,
        revizija: "A",
        rokIzrade: "2026-07-20T00:00:00.000Z",
        isMesActive: false,
      },
    ]);
    expect(res.meta.pagination.total).toBe(1);
    // Bez onlyOpen → NEMA status_rn PREDIKATA (svi RN, ne samo otvoreni); kolona
    // w.status_rn u SELECT listi je očekivana, ali WHERE ne sme imati filter.
    const sqlArg = sy15.db.$queryRaw.mock.calls[0][0] as { strings: string[] };
    expect(sqlArg.strings.join(" ")).not.toContain("status_rn IS FALSE");
  });

  it("predmetWorkOrders: onlyOpen=1 → dodaje status_rn IS FALSE predikat", async () => {
    sy15.db.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }]);
    await service.predmetWorkOrders("123", { onlyOpen: "1" });
    const sqlArg = sy15.db.$queryRaw.mock.calls[0][0] as { strings: string[] };
    expect(sqlArg.strings.join(" ")).toContain("status_rn IS FALSE");
  });

  it("predmetWorkOrders: nevažeći itemId → prazno, NE dira bazu", async () => {
    const res = await service.predmetWorkOrders("0", {});
    expect(res.data).toEqual([]);
    expect(res.meta.pagination.total).toBe(0);
    expect(sy15.db.$queryRaw).not.toHaveBeenCalled();
  });

  // ---------- #6: puna lista movera za „Korisnik" filter (DISTINCT moved_by + ime) ----------

  it("movementMovers: DISTINCT moved_by → {id,name}, sort po imenu; svi razrešeni preko user_roles (1 upit)", async () => {
    sy15.db.$queryRaw.mockResolvedValueOnce([
      { moved_by: UUID2 },
      { moved_by: UUID },
    ]);
    sy15.db.userRoleSy15.findMany.mockResolvedValue([
      { userId: UUID, fullName: "Ana Anić", email: "ana@x.com" },
      { userId: UUID2, fullName: "Zoran Zorić", email: "zoran@x.com" },
    ]);
    const res = await service.movementMovers();
    expect(res.data).toEqual([
      { id: UUID, name: "Ana Anić" },
      { id: UUID2, name: "Zoran Zorić" },
    ]);
    // Nema nerazrešenih → NEMA auth.users fallback $queryRaw (samo DISTINCT upit).
    expect(sy15.db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("movementMovers: nerazrešiv uid → name null (FE zadrži UUID fallback)", async () => {
    sy15.db.$queryRaw
      .mockResolvedValueOnce([{ moved_by: UUID }, { moved_by: UUID2 }]) // DISTINCT
      .mockResolvedValueOnce([]); // auth.users fallback prazan
    sy15.db.userRoleSy15.findMany.mockResolvedValue([
      { userId: UUID, fullName: "Marko Cvetić", email: "marko@x.com" },
    ]);
    const res = await service.movementMovers();
    expect(res.data.find((x) => x.id === UUID)?.name).toBe("Marko Cvetić");
    expect(res.data).toContainEqual({ id: UUID2, name: null });
  });

  it("definitionsAudit: dodaje actor_name (actor_uid → ime; fallback actor_email)", async () => {
    tx.$queryRaw.mockResolvedValue([
      { record_id: "L1", action: "UPDATE", actor_uid: UUID, actor_email: "a@x.com" },
      { record_id: "L2", action: "INSERT", actor_uid: UUID2, actor_email: "b@x.com" },
    ]);
    sy15.db.userRoleSy15.findMany.mockResolvedValue([
      { userId: UUID, fullName: "Nenad Jaraković", email: "n@x.com" },
    ]);
    sy15.db.$queryRaw.mockResolvedValue([]); // auth.users fallback prazan
    const res = await service.definitionsAudit("100", EMAIL);
    const data = res.data as { actor_name: string | null; actor_email: string }[];
    expect(data[0].actor_name).toBe("Nenad Jaraković");
    // Nema u user_roles/auth.users → poslednji fallback = actor_email iz fn-a.
    expect(data[1].actor_name).toBe("b@x.com");
  });
});
