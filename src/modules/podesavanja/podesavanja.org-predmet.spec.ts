import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { PodesavanjaService } from "./podesavanja.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";

/**
 * Drop 2 WRITE Podešavanja (P9 org_profile + P11 predmet) — jedinični testovi (bez žive baze).
 * Pinuju: (1) company_profile PATCH id=1 + updated_by, 0 redova→403; (2) očekivanja INSERT/bulk/
 * PATCH (status='ispunjeno'→auto completed_at), DELETE 0→404; (3) set_predmet_aktivacija named-arg
 * (napomena undefined ne šalje param), prioritet get/set RPC-ovi + normalizacija. RPC tela NETAKNUTA.
 */
const ID = "11111111-2222-3333-4444-555555555555";
const EMP1 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const EMP2 = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";

type SqlLike = { strings: string[]; values: unknown[] };
const eText = (m: jest.Mock, n = 0): string =>
  (m.mock.calls[n]?.[0] as SqlLike).strings.join("?");
const eVals = (m: jest.Mock, n = 0): unknown[] =>
  (m.mock.calls[n]?.[0] as SqlLike).values;

function makeSvc() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    companyProfile: {
      findUnique: jest.fn().mockResolvedValue({ id: 1 }),
    },
    employeeExpectation: {
      create: jest.fn().mockResolvedValue({ id: "e1" }),
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
      findUnique: jest.fn().mockResolvedValue({ id: ID }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const sy15 = {
    withUserRls: jest.fn((_e: string, fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const svc = new PodesavanjaService(sy15 as unknown as Sy15Service);
  return { svc, sy15, tx };
}

describe("PodesavanjaService P9 — vrednosti firme + očekivanja admin", () => {
  it("updateCompanyProfile: PATCH company_profile id=1 + updated_by", async () => {
    const { svc, tx } = makeSvc();
    tx.$executeRaw.mockResolvedValueOnce(1);
    await svc.updateCompanyProfile("a@x", { missionMd: "M", visionMd: "V" });
    const text = eText(tx.$executeRaw);
    expect(text).toContain("UPDATE company_profile");
    expect(text).toContain("updated_by");
    expect(text).toContain("WHERE id = 1");
  });

  it("updateCompanyProfile: 0 redova → 403", async () => {
    const { svc, tx } = makeSvc();
    tx.$executeRaw.mockResolvedValueOnce(0);
    await expect(
      svc.updateCompanyProfile("a@x", { missionMd: "M" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("createExpectation: create sa created_by + default priority/status/category", async () => {
    const { svc, tx } = makeSvc();
    await svc.createExpectation("a@x", { employeeId: EMP1, title: "Cilj" });
    const arg = tx.employeeExpectation.create.mock.calls[0][0];
    expect(arg.data.employeeId).toBe(EMP1);
    expect(arg.data.priority).toBe("srednja");
    expect(arg.data.status).toBe("aktivno");
    expect(arg.data.category).toBe("ostalo");
    expect(arg.data.createdBy).toBe("a@x");
  });

  it("bulkCreateExpectations: createMany za sve (dedup) → {ok,requested}", async () => {
    const { svc, tx } = makeSvc();
    tx.employeeExpectation.createMany.mockResolvedValueOnce({ count: 2 });
    const out = await svc.bulkCreateExpectations("a@x", {
      employeeIds: [EMP1, EMP2, EMP1],
      title: "Zajednički",
    });
    const arg = tx.employeeExpectation.createMany.mock.calls[0][0];
    expect(arg.data).toHaveLength(2); // dedup
    expect((out.data as { ok: number; requested: number })).toEqual({
      ok: 2,
      requested: 2,
    });
  });

  it("updateExpectation: status 'ispunjeno' bez completedAt → auto completed_at=now", async () => {
    const { svc, tx } = makeSvc();
    tx.$executeRaw.mockResolvedValueOnce(1);
    await svc.updateExpectation("a@x", ID, { status: "ispunjeno" });
    const text = eText(tx.$executeRaw);
    expect(text).toContain("UPDATE employee_expectations");
    expect(text).toContain("completed_at = now()");
  });

  it("updateExpectation: samo prosleđena polja u SET (title izostavljen)", async () => {
    const { svc, tx } = makeSvc();
    tx.$executeRaw.mockResolvedValueOnce(1);
    await svc.updateExpectation("a@x", ID, { priority: "visoka" });
    const text = eText(tx.$executeRaw);
    expect(text).toContain("priority = ");
    expect(text).not.toContain("title = ");
  });

  it("updateExpectation: 0 redova → 404", async () => {
    const { svc, tx } = makeSvc();
    tx.$executeRaw.mockResolvedValueOnce(0);
    await expect(
      svc.updateExpectation("a@x", ID, { priority: "visoka" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("deleteExpectation: deleteMany, 0 → 404", async () => {
    const { svc, tx } = makeSvc();
    tx.employeeExpectation.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(svc.deleteExpectation("a@x", ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("PodesavanjaService P11 — predmet aktivacija + prioritet", () => {
  it("setPredmetAktivacija: napomena undefined → NE šalje p_napomena", async () => {
    const { svc, tx } = makeSvc();
    await svc.setPredmetAktivacija("a@x", 42, { aktivan: true });
    const text = eText(tx.$executeRaw);
    expect(text).toContain("set_predmet_aktivacija(");
    expect(text).toContain("p_item_id");
    expect(text).toContain("p_aktivan");
    expect(text).not.toContain("p_napomena");
    expect(text).not.toContain("p_projektovanje_montaza");
  });

  it("setPredmetAktivacija: napomena='' → šalje p_napomena (clear)", async () => {
    const { svc, tx } = makeSvc();
    await svc.setPredmetAktivacija("a@x", 42, { aktivan: false, napomena: "" });
    const text = eText(tx.$executeRaw);
    expect(text).toContain("p_napomena");
    expect(eVals(tx.$executeRaw)).toContain("");
  });

  it("setPredmetAktivacija: projektovanjeMontaza dat → šalje p_projektovanje_montaza", async () => {
    const { svc, tx } = makeSvc();
    await svc.setPredmetAktivacija("a@x", 7, {
      aktivan: true,
      projektovanjeMontaza: true,
    });
    expect(eText(tx.$executeRaw)).toContain("p_projektovanje_montaza");
  });

  it("predmetPrioritet: get_ids + get_max, normalizuje", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw
      .mockResolvedValueOnce([{ v: [3, 1, 2] }]) // ids
      .mockResolvedValueOnce([{ v: 10 }]); // max
    const out = await svc.predmetPrioritet("a@x");
    expect(out.data).toEqual({ itemIds: [3, 1, 2], max: 10 });
  });

  it("setPredmetPrioritet: set_predmet_plan_prioritet + čist niz", async () => {
    const { svc, tx } = makeSvc();
    await svc.setPredmetPrioritet("a@x", [5, -1, 0, 8]);
    const text = eText(tx.$executeRaw);
    expect(text).toContain("set_predmet_plan_prioritet(");
    // -1/0 izbačeni normalizeIds
    expect(eVals(tx.$executeRaw)[0]).toEqual([5, 8]);
  });

  it("setPredmetPrioritetMax: clamp 1..50 + set_..._max", async () => {
    const { svc, tx } = makeSvc();
    await svc.setPredmetPrioritetMax("a@x", 999);
    const text = eText(tx.$executeRaw);
    expect(text).toContain("set_predmet_plan_prioritet_max(");
    expect(eVals(tx.$executeRaw)[0]).toBe(50);
  });

  it("predmetPrioritetPrev: get_predmet_plan_prioritet_prev", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([{ v: [1, 2] }]);
    const out = await svc.predmetPrioritetPrev("a@x");
    expect(out.data).toEqual({ itemIds: [1, 2] });
  });
});
