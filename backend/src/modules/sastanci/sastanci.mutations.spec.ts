import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { SastanciService } from "./sastanci.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import {
  ArhivaPdfDto,
  CreateSastanakDto,
  UpdateSastanakDto,
} from "./dto/sastanci-mutation.dto";

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
      findFirst: jest.fn().mockResolvedValue(null),
    },
    sastanakUcesnik: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(1),
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    presekAktivnost: {
      aggregate: jest.fn().mockResolvedValue({ _max: { rb: 2 } }),
      create: jest.fn().mockResolvedValue({ id: "a1" }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
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

  /* S2 — otkazivanje ide kroz DEFINER RPC (mejlovi 'meeting_cancel' se ne smeju
   * slati iz BE-a) i mora biti idempotentno da dupli klik ne pošalje dva mejla. */
  it("cancel: idempotentno + poziva sastanci_cancel_sastanak (ne UPDATE status)", async () => {
    const { svc, sy15, tx } = makeSvc();
    await svc.cancel("u@servoteh.com", ID, { clientEventId: CID });
    expect(sy15.runIdempotentRls).toHaveBeenCalledWith(
      "u@servoteh.com",
      CID,
      "sastanci.cancel",
      expect.any(Function),
    );
    expect(sqlText(tx.$queryRaw)).toContain("sastanci_cancel_sastanak");
    expect(tx.sastanak.updateMany).not.toHaveBeenCalled();
  });

  it("cancel: RPC {ok:false, reason} prolazi kao podatak (nije greška)", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([
      { result: { ok: false, reason: "already_cancelled", sastanak_id: ID } },
    ]);
    const out = await svc.cancel("u@servoteh.com", ID, { clientEventId: CID });
    expect(out).toEqual({
      data: { ok: false, reason: "already_cancelled", sastanak_id: ID },
      meta: { idempotent: false },
    });
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

  // ── Review fixes #4/#5/#6 ──
  it("createAktivnost: default status 'planiran' (1.0 gazi DB default 'u_toku')", async () => {
    const { svc, tx } = makeSvc();
    await svc.createAktivnost("u@servoteh.com", ID, { clientEventId: CID });
    expect(argData(tx.presekAktivnost.create).status).toBe("planiran");
  });

  it("seedFromTeme: status 'planiran' + podRn iz koda projekta + orderBy prioritet", async () => {
    const { svc, tx } = makeSvc();
    tx.pmTema.findMany.mockResolvedValueOnce([
      { id: "t1", naslov: "Tema A", projekatId: "p1" },
    ]);
    tx.presekAktivnost.findMany.mockResolvedValueOnce([]); // postojeće tačke
    tx.$queryRaw.mockResolvedValueOnce([{ id: "p1", project_code: "9400/7" }]); // projekti
    await svc.seedFromTeme("u@servoteh.com", ID);
    const rows = argData(tx.presekAktivnost.createMany) as unknown as {
      status: string;
      podRn: string | null;
    }[];
    expect(rows[0].status).toBe("planiran");
    expect(rows[0].podRn).toBe("9400/7");
    const findArg = callArg(tx.pmTema.findMany) as {
      orderBy: { prioritet?: string }[];
    };
    expect(findArg.orderBy[0].prioritet).toBe("desc");
  });

  it("updateTema: ČUVA postojeću resio_* atribuciju (B menja naslov, ne preotima A)", async () => {
    const { svc, tx } = makeSvc();
    tx.pmTema.findUnique.mockResolvedValueOnce({
      resioEmail: "a@servoteh.com",
      resioLabel: "A. Rešić",
      resioAt: new Date("2026-01-01T00:00:00Z"),
      resioNapomena: "prvo rešenje",
    });
    await svc.updateTema("b@servoteh.com", ID, {
      naslov: "novi naslov",
      status: "usvojeno",
    });
    const data = (
      callArg(tx.pmTema.updateMany) as { data: Record<string, unknown> }
    ).data;
    expect(data.resioEmail).toBe("a@servoteh.com"); // NE b@
    expect(data.resioLabel).toBe("A. Rešić");
    expect(data.resioNapomena).toBe("prvo rešenje");
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

  // ── Review nalaz: updateMany 0 pogodaka ≠ tihi 200 (regen bi ostavio STARI PDF) ──

  it("uploadArhivaPdf LOCK tok (bez requireArhiva): arhiva red ne postoji → 200 + arhivaUpdated=false", async () => {
    const { svc, storage } = makeSvc(); // default sastanakArhiva.updateMany → count 0
    const out = await svc.uploadArhivaPdf("u@servoteh.com", ID, {
      buffer: Buffer.from("%PDF-1.4"),
      mimetype: "application/pdf",
    } as unknown as Express.Multer.File);
    // Red nastaje tek u RPC sast_zakljucaj_sastanak — 0 je legitimno, bez izuzetka.
    expect(out.data.arhivaUpdated).toBe(false);
    expect(out.data.storagePath).toMatch(
      new RegExp(`^${ID}/.*_zapisnik\\.pdf$`),
    );
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("uploadArhivaPdf REGEN tok (requireArhiva=true): 0 pogodaka → 403 + orphan cleanup", async () => {
    const { svc, tx, storage } = makeSvc(); // default updateMany → count 0
    await expect(
      svc.uploadArhivaPdf(
        "u@servoteh.com",
        ID,
        {
          buffer: Buffer.from("%PDF-1.4"),
          mimetype: "application/pdf",
        } as unknown as Express.Multer.File,
        true,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.sastanakArhiva.updateMany).toHaveBeenCalledTimes(1);
    // Best-effort brisanje upravo upload-ovanog fajla (path se ne vraća FE-u).
    expect(storage.remove).toHaveBeenCalledWith(
      "sastanci-arhiva",
      expect.stringMatching(new RegExp(`^${ID}/.*_zapisnik\\.pdf$`)),
    );
  });

  it("uploadArhivaPdf REGEN tok (requireArhiva=true): red pogođen → 200 + arhivaUpdated=true", async () => {
    const { svc, tx, storage } = makeSvc();
    tx.sastanakArhiva.updateMany.mockResolvedValueOnce({ count: 1 });
    const out = await svc.uploadArhivaPdf(
      "u@servoteh.com",
      ID,
      {
        buffer: Buffer.from("%PDF-1.4"),
        mimetype: "application/pdf",
      } as unknown as Express.Multer.File,
      true,
    );
    expect(out.data.arhivaUpdated).toBe(true);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("ArhivaPdfDto: multipart string 'true' → boolean requireArhiva (koercija pre @IsBoolean)", async () => {
    // Žica multipart-a nosi SVE kao string — bez @Transform bi 'true' pao na 400.
    const dto = plainToInstance(ArhivaPdfDto, { requireArhiva: "true" });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.requireArhiva).toBe(true);
    const off = plainToInstance(ArhivaPdfDto, { requireArhiva: "false" });
    expect(await validate(off)).toHaveLength(0);
    expect(off.requireArhiva).toBe(false);
    const none = plainToInstance(ArhivaPdfDto, {});
    expect(await validate(none)).toHaveLength(0);
    expect(none.requireArhiva).toBeUndefined();
  });

  // ── S-P0 paket 1: backdoor lock kroz status ──

  it("updateSastanak: status='zakljucan' → 400 BEZ odlaska u bazu (lock samo /lock)", async () => {
    const { svc, sy15 } = makeSvc();
    await expect(
      svc.updateSastanak("u@servoteh.com", ID, { status: "zakljucan" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sy15.withUserRls).not.toHaveBeenCalled();
  });

  it("createSastanak: status='zakljucan' → 400 BEZ idempotentnog upisa", async () => {
    const { svc, sy15 } = makeSvc();
    await expect(
      svc.createSastanak("u@servoteh.com", {
        clientEventId: CID,
        naslov: "X",
        datum: "2026-07-20",
        status: "zakljucan",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sy15.runIdempotentRls).not.toHaveBeenCalled();
  });

  // ── S-P0 paket 4: POST /:id/prenos (Sedmični + prenos) ──

  const SRC = "99999999-8888-7777-6666-555555555555";

  it("prenos: replace učesnika izvora (pozvan=true, prisutan=false) + premešta SAMO otvoren/u_toku", async () => {
    const { svc, sy15, tx } = makeSvc();
    tx.sastanak.findUnique
      .mockResolvedValueOnce({ datum: new Date("2026-07-20"), tip: "sedmicni" }) // novi (ciljni)
      .mockResolvedValueOnce({ id: SRC, naslov: "Sedmični 13.07." }); // eksplicitni izvor
    tx.sastanakUcesnik.findMany.mockResolvedValueOnce([
      { email: "A@servoteh.com", label: "A" },
    ]);
    tx.akcioniPlan.updateMany.mockResolvedValueOnce({ count: 4 });
    const out = await svc.prenos("u@servoteh.com", ID, {
      clientEventId: CID,
      fromSastanakId: SRC,
    });
    expect(sy15.runIdempotentRls).toHaveBeenCalledWith(
      "u@servoteh.com",
      CID,
      "sastanci.prenos",
      expect.any(Function),
    );
    // Eksplicitni izvor i dalje radi; odgovor nosi i source {id, naslov}.
    expect(out.data).toEqual({
      ucesnici: 1,
      akcije: 4,
      source: { id: SRC, naslov: "Sedmični 13.07." },
    });
    // Eksplicitan izvor → BEZ auto-pick upita.
    expect(tx.sastanak.findFirst).not.toHaveBeenCalled();
    // 1.0 saveUcesnici = bulk REPLACE na NOVOM (ciljnom) sastanku.
    expect(tx.sastanakUcesnik.deleteMany).toHaveBeenCalledWith({
      where: { sastanakId: ID },
    });
    const created = argData(tx.sastanakUcesnik.createMany) as unknown as {
      email: string;
      pozvan: boolean;
      prisutan: boolean;
    }[];
    expect(created[0]).toMatchObject({
      email: "a@servoteh.com",
      pozvan: true,
      prisutan: false,
    });
    // TAČAN 1.0 filter: status=in.(otvoren,u_toku) — NE "!= zavrsen".
    const upd = callArg(tx.akcioniPlan.updateMany) as {
      where: { sastanakId: string; status: { in: string[] } };
      data: { sastanakId: string };
    };
    expect(upd.where.status).toEqual({ in: ["otvoren", "u_toku"] });
    expect(upd.where.sastanakId).toBe(SRC);
    expect(upd.data.sastanakId).toBe(ID);
  });

  it("prenos: izvor bez učesnika → postojeći na novom OSTAJU (bez delete/insert)", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanak.findUnique
      .mockResolvedValueOnce({ datum: new Date("2026-07-20"), tip: "sedmicni" })
      .mockResolvedValueOnce({ id: SRC, naslov: null });
    tx.sastanakUcesnik.findMany.mockResolvedValueOnce([]);
    const out = await svc.prenos("u@servoteh.com", ID, {
      clientEventId: CID,
      fromSastanakId: SRC,
    });
    expect(tx.sastanakUcesnik.deleteMany).not.toHaveBeenCalled();
    expect(tx.sastanakUcesnik.createMany).not.toHaveBeenCalled();
    expect(out.data).toMatchObject({ ucesnici: 0 });
  });

  it("prenos BEZ fromSastanakId: auto-pick 1.0 filterom (isti tip, datum < novi, bez :id, datum desc + created_at desc)", async () => {
    const { svc, tx } = makeSvc();
    const datumNovog = new Date("2026-07-20");
    tx.sastanak.findUnique.mockResolvedValueOnce({
      datum: datumNovog,
      tip: "sedmicni",
    }); // novi (ciljni)
    tx.sastanak.findFirst.mockResolvedValueOnce({
      id: SRC,
      naslov: "Sedmični 13.07.",
    });
    tx.sastanakUcesnik.findMany.mockResolvedValueOnce([
      { email: "A@servoteh.com", label: "A" },
    ]);
    tx.akcioniPlan.updateMany.mockResolvedValueOnce({ count: 2 });
    const out = await svc.prenos("u@servoteh.com", ID, { clientEventId: CID });
    // 1.0 prenesiUNoviSastanak (sastanci.js:258-290): id != novi, tip = tip
    // novog, datum STROGO < datum novog, order datum desc + created_at desc.
    const pick = callArg(tx.sastanak.findFirst) as {
      where: { id: { not: string }; tip: string; datum: { lt: Date } };
      orderBy: Record<string, unknown>[];
    };
    expect(pick.where.id).toEqual({ not: ID });
    expect(pick.where.tip).toBe("sedmicni");
    expect(pick.where.datum).toEqual({ lt: datumNovog });
    expect(pick.orderBy).toEqual([{ datum: "desc" }, { createdAt: "desc" }]);
    // Prenos ide sa auto-izabranog izvora.
    const upd = callArg(tx.akcioniPlan.updateMany) as {
      where: { sastanakId: string };
      data: { sastanakId: string };
    };
    expect(upd.where.sastanakId).toBe(SRC);
    expect(upd.data.sastanakId).toBe(ID);
    expect(out.data).toEqual({
      ucesnici: 1,
      akcije: 2,
      source: { id: SRC, naslov: "Sedmični 13.07." },
    });
  });

  it("prenos BEZ fromSastanakId: nema kandidata → {ucesnici:0, akcije:0, source:null} BEZ greške i BEZ write-ova", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanak.findUnique.mockResolvedValueOnce({
      datum: new Date("2026-07-20"),
      tip: "sedmicni",
    });
    tx.sastanak.findFirst.mockResolvedValueOnce(null);
    const out = await svc.prenos("u@servoteh.com", ID, { clientEventId: CID });
    expect(out.data).toEqual({ ucesnici: 0, akcije: 0, source: null });
    expect(tx.sastanakUcesnik.findMany).not.toHaveBeenCalled();
    expect(tx.sastanakUcesnik.deleteMany).not.toHaveBeenCalled();
    expect(tx.sastanakUcesnik.createMany).not.toHaveBeenCalled();
    expect(tx.akcioniPlan.updateMany).not.toHaveBeenCalled();
  });

  it("prenos: izvor == cilj → 400 (nema šta da se premesti)", async () => {
    const { svc, sy15 } = makeSvc();
    await expect(
      svc.prenos("u@servoteh.com", ID, {
        clientEventId: CID,
        fromSastanakId: ID,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sy15.runIdempotentRls).not.toHaveBeenCalled();
  });

  it("prenos: izvorni sastanak ne postoji → 404", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanak.findUnique
      .mockResolvedValueOnce({ datum: new Date("2026-07-20"), tip: "sedmicni" }) // novi (ciljni) postoji
      .mockResolvedValueOnce(null); // eksplicitni izvor ne postoji
    await expect(
      svc.prenos("u@servoteh.com", ID, {
        clientEventId: CID,
        fromSastanakId: SRC,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("prenos: ciljni sastanak ne postoji → 404", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanak.findUnique.mockResolvedValueOnce(null); // novi (ciljni) ne postoji
    await expect(
      svc.prenos("u@servoteh.com", ID, { clientEventId: CID }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

/**
 * S-P0 paket 1 — DTO whitelist: 'zakljucan' je IZBAČEN iz status @IsIn na
 * Create/Update (zaključavanje isključivo kroz POST /:id/lock → RPC
 * sast_zakljucaj_sastanak sa arhivom/PDF/notifikacijama).
 */
describe("Sastanci DTO — status backdoor lock (validacija)", () => {
  it("UpdateSastanakDto: status='zakljucan' pada na validaciji", async () => {
    const errors = await validate(
      plainToInstance(UpdateSastanakDto, { status: "zakljucan" }),
    );
    expect(errors.some((e) => e.property === "status")).toBe(true);
  });

  it("CreateSastanakDto: status='zakljucan' pada na validaciji", async () => {
    const errors = await validate(
      plainToInstance(CreateSastanakDto, {
        clientEventId: CID,
        naslov: "X",
        datum: "2026-07-20",
        status: "zakljucan",
      }),
    );
    expect(errors.some((e) => e.property === "status")).toBe(true);
  });

  it("legitimni statusi (planiran/u_toku/zavrsen/otkazan) i dalje prolaze", async () => {
    for (const status of ["planiran", "u_toku", "zavrsen", "otkazan"]) {
      const errors = await validate(
        plainToInstance(UpdateSastanakDto, { status }),
      );
      expect(errors).toHaveLength(0);
    }
  });
});
