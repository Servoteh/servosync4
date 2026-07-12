import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { SastanciService } from "./sastanci.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";

/**
 * R2 mutacije — jedinični testovi (bez žive baze): pinuju da se write-ovi voze
 * kroz `withUserRls`/`runIdempotentRls` (RLS paritet), da idempotentne akcije nose
 * clientEventId + naziv akcije, i da `assertAffected` mapira RLS-filtrovan 0-red
 * na 403 (postoji) / 404 (ne postoji). Row-ISHOD (koji red RLS pušta) dokazuje
 * živi smoke u R4 — ovde je mehanika mosta i grešaka.
 */
const CID = "3b241101-e2bb-4255-8caf-4136c566a962";
const ID = "11111111-2222-3333-4444-555555555555";

type Rec = Record<string, unknown>;
/** `data` argument prvog poziva Prisma create/createMany mocka. */
const argData = (m: jest.Mock): Rec => {
  const calls = m.mock.calls as unknown as { data: Rec }[][];
  return calls[0][0].data;
};
/** SQL tekst prvog $queryRaw poziva (Prisma.sql `strings` segmenti). */
const sqlText = (m: jest.Mock): string => {
  const calls = m.mock.calls as unknown as { strings: string[] }[][];
  return calls[0][0].strings.join("?");
};
/** N-ti argument prvog poziva mocka (izbegava no-unsafe-member-access). */
const callArg = (m: jest.Mock, arg = 0): unknown => {
  const calls = m.mock.calls as unknown as unknown[][];
  return calls[0][arg];
};

function makeSvc() {
  const tx = {
    sastanak: {
      create: jest.fn().mockResolvedValue({ id: ID }),
      count: jest.fn().mockResolvedValue(1),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ id: ID }),
    },
    sastanakUcesnik: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(1),
      create: jest.fn().mockResolvedValue({}),
    },
    presekAktivnost: {
      aggregate: jest.fn().mockResolvedValue({ _max: { rb: 2 } }),
      create: jest.fn().mockResolvedValue({ id: "a1" }),
      count: jest.fn().mockResolvedValue(1),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ id: "a1" }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    pmTema: {
      create: jest.fn().mockResolvedValue({ id: "t1" }),
      count: jest.fn().mockResolvedValue(1),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ id: "t1" }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    akcioniPlan: {
      create: jest.fn().mockResolvedValue({ id: "ak1" }),
      count: jest.fn().mockResolvedValue(1),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ id: "ak1" }),
    },
    presekSlika: {
      count: jest.fn().mockResolvedValue(0),
      create: jest
        .fn()
        .mockResolvedValue({ id: "sl1", storagePath: "p", sizeBytes: null }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ storagePath: "x/y.jpg" }),
    },
    sastanakArhiva: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest
        .fn()
        .mockResolvedValue({ zapisnikStoragePath: "id/z.pdf" }),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ result: "ok", n: 3, ok: true }]),
  };
  const sy15 = {
    withUser: jest.fn(),
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
  const ai = { summarize: jest.fn().mockResolvedValue({ summary: "s" }) };
  const svc = new SastanciService(
    sy15 as unknown as Sy15Service,
    storage as never,
    ai as never,
  );
  return { svc, sy15, tx, storage, ai };
}

describe("SastanciService R2 mutacije", () => {
  it("createSastanak: ide kroz runIdempotentRls sa clientEventId + akcijom; datum→Date", async () => {
    const { svc, sy15, tx } = makeSvc();
    await svc.createSastanak("u@servoteh.com", {
      clientEventId: CID,
      naslov: "Test",
      datum: "2026-07-15",
      vreme: "09:30",
    });
    expect(sy15.runIdempotentRls).toHaveBeenCalledWith(
      "u@servoteh.com",
      CID,
      "sastanci.create-sastanak",
      expect.any(Function),
    );
    const arg = argData(tx.sastanak.create);
    expect(arg.datum).toBeInstanceOf(Date);
    expect(arg.vreme).toBeInstanceOf(Date);
    expect(arg.createdByEmail).toBe("u@servoteh.com");
  });

  it("updateSastanak: 0 pogodaka a red postoji → 403", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanak.count.mockResolvedValueOnce(1);
    tx.sastanak.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      svc.updateSastanak("u@servoteh.com", ID, { naslov: "x" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("updateSastanak: 0 pogodaka i red NE postoji → 404", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanak.count.mockResolvedValueOnce(0);
    tx.sastanak.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      svc.updateSastanak("u@servoteh.com", ID, { naslov: "x" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("lock: idempotentno + poziva sast_zakljucaj_sastanak sa pdf path-om", async () => {
    const { svc, sy15, tx } = makeSvc();
    await svc.lock("u@servoteh.com", ID, {
      clientEventId: CID,
      pdfStoragePath: `${ID}/2026_zapisnik.pdf`,
    });
    expect(sy15.runIdempotentRls).toHaveBeenCalledWith(
      "u@servoteh.com",
      CID,
      "sastanci.lock",
      expect.any(Function),
    );
    expect(sqlText(tx.$queryRaw)).toContain("sast_zakljucaj_sastanak");
  });

  it("bulkUcesnici: DELETE pa INSERT (regeneracija tokena/RSVP — §2 p.6)", async () => {
    const { svc, tx } = makeSvc();
    await svc.bulkUcesnici("u@servoteh.com", ID, {
      clientEventId: CID,
      ucesnici: [{ email: "A@servoteh.com", label: "A" }],
    });
    expect(tx.sastanakUcesnik.deleteMany).toHaveBeenCalledWith({
      where: { sastanakId: ID },
    });
    const created = argData(tx.sastanakUcesnik.createMany) as unknown as {
      email: string;
    }[];
    expect(created[0].email).toBe("a@servoteh.com"); // lowercased
  });

  it("weeklyPomeri: poziva sast_weekly_pomeri kroz withUserRls", async () => {
    const { svc, sy15, tx } = makeSvc();
    await svc.weeklyPomeri("u@servoteh.com", { datum: "2026-07-20" });
    expect(sy15.withUserRls).toHaveBeenCalled();
    expect(sqlText(tx.$queryRaw)).toContain("sast_weekly_pomeri");
  });

  it("setAiModel: poziva set_sastanci_ai_model (admin gate u DB fn)", async () => {
    const { svc, tx } = makeSvc();
    await svc.setAiModel("u@servoteh.com", { model: "claude-opus-4-8" });
    expect(sqlText(tx.$queryRaw)).toContain("set_sastanci_ai_model");
  });

  it("bulkStatus: vraća STVARNO izmenjen broj (RLS može odbiti deo)", async () => {
    const { svc, tx } = makeSvc();
    tx.akcioniPlan.updateMany.mockResolvedValueOnce({ count: 2 });
    const out = await svc.bulkStatus("u@servoteh.com", {
      ids: [ID, CID],
      status: "zavrsen",
    });
    expect(out.data).toEqual({ updated: 2 });
  });

  // ── R2.2 Storage ──
  it("uploadSlika: meta INSERT PRE upload-a (RLS write-scope, bez orphan fajla)", async () => {
    const { svc, storage, tx } = makeSvc();
    const order: string[] = [];
    tx.presekSlika.create.mockImplementationOnce(() => {
      order.push("meta");
      return Promise.resolve({ id: "sl1", storagePath: "p", sizeBytes: null });
    });
    storage.upload.mockImplementationOnce(() => {
      order.push("upload");
      return Promise.resolve(undefined);
    });
    await svc.uploadSlika("u@servoteh.com", ID, { caption: "c" }, {
      buffer: Buffer.from("x"),
      originalname: "a b.jpg",
      mimetype: "image/jpeg",
    } as unknown as Express.Multer.File);
    expect(order).toEqual(["meta", "upload"]);
    expect(callArg(storage.upload)).toBe("sastanak-slike");
  });

  it("getArhivaPdfUrl: nije učesnik ni mgmt → 403 (bez potpisivanja)", async () => {
    const { svc, tx, storage } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([{ ok: false }]);
    await expect(
      svc.getArhivaPdfUrl("u@servoteh.com", ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(storage.signUrl).not.toHaveBeenCalled();
  });

  it("uploadArhivaPdf: putanja `{id}/{ts}_zapisnik.pdf` u sastanci-arhiva", async () => {
    const { svc, storage } = makeSvc();
    const out = await svc.uploadArhivaPdf("u@servoteh.com", ID, {
      buffer: Buffer.from("%PDF-1.4"),
      mimetype: "application/pdf",
    } as unknown as Express.Multer.File);
    expect(callArg(storage.upload)).toBe("sastanci-arhiva");
    expect(out.data.storagePath).toMatch(
      new RegExp(`^${ID}/.*_zapisnik\\.pdf$`),
    );
  });
});
