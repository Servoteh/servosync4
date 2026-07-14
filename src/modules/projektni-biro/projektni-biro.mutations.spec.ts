import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ProjektniBiroService } from "./projektni-biro.service";
import type { Sy15Service, Sy15Tx } from "../../common/sy15/sy15.service";
import type { Sy15StorageService } from "../../common/sy15/sy15-storage.service";

/**
 * R2 mutacije PB — jedinični testovi (bez žive baze). Pinuju: (1) write kroz
 * withUserRls/runIdempotentRls (RLS paritet + idempotency ključ+akcija), (2) jsonb ključevi
 * RPC-ova (pb_save_eng_tip / pb_upsert_eng_tip_category) 1:1 sa §C, (3) enum labele → `::pb_*`
 * cast (bez Prisma enum-member prevoda), (4) RLS-INSERT reference auth.uid()/pb_current_employee_id(),
 * (5) assertAffected 0-red → 403 (postoji)/404 (ne postoji), (6) deps ciklus/dup → 409, meta PRE
 * storage upload-a. Row-ISHOD dokazuje živi smoke (R4).
 */
const CID = "3b241101-e2bb-4255-8caf-4136c566a962";
const ID = "11111111-2222-3333-4444-555555555555";
const ID2 = "22222222-3333-4444-5555-666666666666";

type SqlLike = { strings: string[]; values: unknown[] };
/** Tekst n-tog $queryRaw poziva (raw fragmenti + placeholderi kao „?"). */
const qText = (m: jest.Mock, n = 0): string =>
  (m.mock.calls[n]?.[0] as SqlLike).strings.join("?");
/** Vrednosti n-tog $queryRaw poziva (parametri). */
const qVals = (m: jest.Mock, n = 0): unknown[] =>
  (m.mock.calls[n]?.[0] as SqlLike).values;
/** JSON payload (jedini string value) iz $queryRaw poziva. */
const jsonOf = (m: jest.Mock, n = 0): Record<string, unknown> =>
  JSON.parse(qVals(m, n).find((v) => typeof v === "string") as string);

function makeSvc() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    pbTaskComment: {
      count: jest.fn().mockResolvedValue(1),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ id: "c1" }),
    },
    pbTaskDep: {
      count: jest.fn().mockResolvedValue(1),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    pbWorkReport: {
      count: jest.fn().mockResolvedValue(1),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    pbTaskFile: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: "f1", storagePath: "p", deletedAt: null }),
      findFirst: jest.fn().mockResolvedValue({ id: "f1", storagePath: "p" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    pbNotificationConfig: {
      update: jest.fn().mockResolvedValue({ id: 1 }),
      findUnique: jest.fn().mockResolvedValue({ id: 1 }),
    },
    pbEngTipFile: { findUnique: jest.fn().mockResolvedValue({ storagePath: "p" }) },
  };
  const sy15 = {
    withUserRls: jest.fn((_e: string, fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
    runIdempotentRls: jest.fn(
      async (
        _e: string,
        _cid: string,
        _action: string,
        fn: (t: unknown) => Promise<unknown>,
      ) => ({ idempotent: false, result: await fn(tx) }),
    ),
  };
  const storage = {
    upload: jest.fn().mockResolvedValue(undefined),
    signUrl: jest.fn().mockResolvedValue({ url: "u", expiresIn: 300 }),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new ProjektniBiroService(
    sy15 as unknown as Sy15Service,
    storage as unknown as Sy15StorageService,
  );
  return { svc, sy15, tx, storage };
}

describe("ProjektniBiroService R2 mutacije", () => {
  it("createTask: runIdempotentRls(cid,'pb.create-task') + enum labela → ::pb_task_status", async () => {
    const { svc, sy15, tx } = makeSvc();
    await svc.createTask("u@x", {
      clientEventId: CID,
      naziv: "Zadatak",
      status: "U toku",
      prioritet: "Visok",
      vrsta: "Projektovanje 3D",
    });
    expect(sy15.runIdempotentRls).toHaveBeenCalledWith(
      "u@x",
      CID,
      "pb.create-task",
      expect.any(Function),
    );
    const text = qText(tx.$queryRaw);
    expect(text).toContain("INSERT INTO pb_tasks");
    expect(text).toContain("::pb_task_status");
    expect(text).toContain("::pb_prioritet");
    expect(text).toContain("::pb_task_vrsta");
    // labela se prosleđuje kao PARAMETAR (ne enum-member) — §C paritet.
    expect(qVals(tx.$queryRaw)).toEqual(
      expect.arrayContaining(["U toku", "Visok", "Projektovanje 3D"]),
    );
  });

  it("updateTask: optimistic-lock mismatch (0 red, red postoji) → 409", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: ID }]) // exists SELECT
      .mockResolvedValueOnce([]); // UPDATE 0 redova
    await expect(
      svc.updateTask("u@x", ID, { naziv: "x", expectedUpdatedAt: "2026-07-13T00:00:00Z" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("updateTask: 0 red i NE postoji → 404", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(
      svc.updateTask("u@x", ID, { naziv: "x" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("updateTask: 0 red bez lock-a a red postoji → 403 (RLS)", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([{ id: ID }]).mockResolvedValueOnce([]);
    await expect(
      svc.updateTask("u@x", ID, { naziv: "x" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("bulkUpdateTasks: id=ANY + vraća stvarno izmenjen broj", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([{ id: ID }, { id: ID2 }]);
    const out = await svc.bulkUpdateTasks("u@x", {
      ids: [ID, ID2],
      status: "Završeno",
    });
    expect(out.data).toEqual({ updated: 2, requested: 2 });
    expect(qText(tx.$queryRaw)).toContain("id = ANY(");
  });

  it("softDeleteTask/bulk: zovu pb_soft_delete_task(s)", async () => {
    const { svc, tx } = makeSvc();
    await svc.softDeleteTask("u@x", ID);
    expect(qText(tx.$executeRaw)).toContain("pb_soft_delete_task(");
    tx.$queryRaw.mockResolvedValueOnce([{ n: 2 }]);
    const out = await svc.bulkSoftDeleteTasks("u@x", { ids: [ID, ID2] });
    expect(qText(tx.$queryRaw)).toContain("pb_soft_delete_tasks(");
    expect(out.data).toEqual({ deleted: 2, requested: 2 });
  });

  it("updateProgress: poziva pb_update_task_progress (inzenjer restriktovani edit)", async () => {
    const { svc, tx } = makeSvc();
    await svc.updateProgress("u@x", ID, { status: "U toku", procenat: 40 });
    expect(qText(tx.$queryRaw)).toContain("pb_update_task_progress(");
  });

  it("createComment: INSERT referiše auth.uid() (RLS WITH CHECK) + created_by_user_id", async () => {
    const { svc, sy15, tx } = makeSvc();
    await svc.createComment("u@x", ID, {
      clientEventId: CID,
      body: "cc @pera i @mika",
    });
    expect(sy15.runIdempotentRls).toHaveBeenCalledWith(
      "u@x",
      CID,
      "pb.create-comment",
      expect.any(Function),
    );
    const text = qText(tx.$queryRaw);
    expect(text).toContain("INSERT INTO pb_task_comments");
    expect(text).toContain("created_by_user_id");
    expect(text).toContain("auth.uid()");
    // mentions parsirani iz @-tokena
    expect(qVals(tx.$queryRaw)).toEqual(
      expect.arrayContaining([expect.arrayContaining(["pera", "mika"])]),
    );
  });

  it("updateComment: 0 red a postoji → 403; ne postoji → 404 (1h prozor u RLS)", async () => {
    const { svc, tx } = makeSvc();
    tx.pbTaskComment.count.mockResolvedValueOnce(1);
    tx.pbTaskComment.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      svc.updateComment("u@x", ID, { body: "x" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    tx.pbTaskComment.count.mockResolvedValueOnce(0);
    tx.pbTaskComment.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      svc.updateComment("u@x", ID, { body: "x" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("addDep: ciklus (23514) → 409, dup (23505) → 409, self → 409", async () => {
    const { svc, tx } = makeSvc();
    await expect(
      svc.addDep("u@x", ID, { dependsOnTaskId: ID }),
    ).rejects.toBeInstanceOf(ConflictException); // self
    tx.$queryRaw.mockRejectedValueOnce({ meta: { code: "23514" } });
    await expect(
      svc.addDep("u@x", ID, { dependsOnTaskId: ID2 }),
    ).rejects.toBeInstanceOf(ConflictException); // ciklus
    tx.$queryRaw.mockRejectedValueOnce({ meta: { code: "23505" } });
    await expect(
      svc.addDep("u@x", ID, { dependsOnTaskId: ID2 }),
    ).rejects.toBeInstanceOf(ConflictException); // dup
  });

  it("createWorkReport: sati van [0.5,24] → 422; INSERT default pb_current_employee_id()", async () => {
    const { svc, tx } = makeSvc();
    await expect(
      svc.createWorkReport("u@x", { clientEventId: CID, datum: "2026-07-13", sati: 30 }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    tx.$queryRaw.mockResolvedValueOnce([{ id: "w", sati: "4" }]);
    await svc.createWorkReport("u@x", {
      clientEventId: CID,
      datum: "2026-07-13",
      sati: 4,
    });
    expect(qText(tx.$queryRaw)).toContain("pb_current_employee_id()");
  });

  it("saveTip: jsonb ključevi 1:1 (id/naslov/telo/category_id/tags/vendor/url/project_id/status)", async () => {
    const { svc, sy15, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([{ result: { id: "t" } }]);
    await svc.saveTip("u@x", {
      clientEventId: CID,
      naslov: "Naslov",
      telo: "Telo bar 10 znakova",
      categoryId: ID,
      tags: [" cnc ", ""],
      status: "published",
    });
    expect(sy15.runIdempotentRls).toHaveBeenCalledWith(
      "u@x",
      CID,
      "pb.save-tip",
      expect.any(Function),
    );
    const p = jsonOf(tx.$queryRaw);
    expect(Object.keys(p).sort()).toEqual(
      [
        "category_id",
        "id",
        "naslov",
        "project_id",
        "status",
        "tags",
        "telo",
        "url",
        "vendor",
      ].sort(),
    );
    expect(p.category_id).toBe(ID);
    expect(p.tags).toEqual(["cnc"]); // trim + drop praznih
    expect(p).not.toHaveProperty("categoryId");
  });

  it("upsertTipCategory: jsonb ključevi 1:1 (naziv/slug/ikona/boja/redosled/je_aktivna)", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([{ id: "cat" }]);
    await svc.upsertTipCategory("u@x", {
      naziv: "CNC",
      redosled: 3,
      jeAktivna: false,
    });
    const p = jsonOf(tx.$queryRaw);
    expect(p.naziv).toBe("CNC");
    expect(p.redosled).toBe(3);
    expect(p.je_aktivna).toBe(false);
    expect(p).not.toHaveProperty("jeAktivna");
  });

  it("uploadTaskFile: meta INSERT (auth.uid()) PRE storage.upload; bucket pb-task-files", async () => {
    const { svc, tx, storage } = makeSvc();
    const order: string[] = [];
    tx.$queryRaw.mockImplementationOnce(() => {
      order.push("meta");
      return Promise.resolve([{ id: "f1" }]);
    });
    storage.upload.mockImplementationOnce(() => {
      order.push("upload");
      return Promise.resolve(undefined);
    });
    await svc.uploadTaskFile("u@x", ID, { clientEventId: CID }, {
      buffer: Buffer.from("x"),
      originalname: "a b.pdf",
      mimetype: "application/pdf",
      size: 1,
    } as unknown as Express.Multer.File);
    expect(order).toEqual(["meta", "upload"]);
    expect(qText(tx.$queryRaw)).toContain("auth.uid()");
    expect(storage.upload.mock.calls[0][0]).toBe("pb-task-files");
  });

  it("uploadTipFile: meta RPC pb_add_eng_tip_file PRE upload; storagePath `{tipId}/{uuid}__{name}`", async () => {
    const { svc, tx, storage } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([{ result: { id: "tf1" } }]);
    const out = await svc.uploadTipFile("u@x", ID, CID, {
      buffer: Buffer.from("x"),
      originalname: "crtez.png",
      mimetype: "image/png",
      size: 1,
    } as unknown as Express.Multer.File);
    expect(qText(tx.$queryRaw)).toContain("pb_add_eng_tip_file(");
    expect(storage.upload.mock.calls[0][0]).toBe("pb-eng-tip-files");
    expect((out.data as { storagePath: string }).storagePath).toMatch(
      new RegExp(`^${ID}/.*__crtez\\.png$`),
    );
  });

  it("updateNotificationConfig: PATCH id=1 (pb.admin) + updatedBy", async () => {
    const { svc, tx } = makeSvc();
    await svc.updateNotificationConfig("u@x", { enabled: false });
    const arg = tx.pbNotificationConfig.update.mock.calls[0][0] as {
      where: { id: number };
      data: { enabled: boolean; updatedBy: string };
    };
    expect(arg.where).toEqual({ id: 1 });
    expect(arg.data.enabled).toBe(false);
    expect(arg.data.updatedBy).toBe("u@x");
  });

  it("updateNotificationConfig: quiet_hours persist (raw UPDATE ::time, paritet 1.0)", async () => {
    const { svc, tx } = makeSvc();
    await svc.updateNotificationConfig("u@x", {
      quietHoursStart: "22:00",
      quietHoursEnd: "06:00",
    });
    const text = qText(tx.$executeRaw);
    expect(text).toContain("UPDATE pb_notification_config");
    expect(text).toContain("quiet_hours_start = ");
    expect(text).toContain("::time");
    expect(text).toContain("quiet_hours_end = ");
    expect(qVals(tx.$executeRaw)).toEqual(
      expect.arrayContaining(["22:00", "06:00"]),
    );
  });

  it("updateNotificationConfig: bez quiet_hours polja → NEMA raw UPDATE-a", async () => {
    const { svc, tx } = makeSvc();
    await svc.updateNotificationConfig("u@x", { enabled: true });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});
