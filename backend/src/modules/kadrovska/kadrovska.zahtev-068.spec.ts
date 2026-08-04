import { KadrovskaService } from "./kadrovska.service";

/**
 * ZAHTEV 068/26 (Nenad, 04.08.2026) — „zahtev mora da bude u zahtevima za
 * odobravanje". Merenje 04.08.2026 na produ: `makeup_requests` red Stamenić
 * 01.08.2026 stoji u statusu `sef_approved` od 31.07.2026 20:23 (šef Duško dao
 * 1. nivo), a nikad nije finalizovan jer se u listi NIJE VIDEO.
 *
 * Koren je bio FE (podrazumevani filter `pending` u Odsustva → Nadoknada/Plaćeno).
 * Ovaj test čuva SERVERSKU stranu tog ugovora: `GET /kadrovska/requests` NE SME
 * sam da suzi na jedan status — inbox mora da dobije i redove drugog stepena,
 * inače nikakva FE popravka ne pomaže. Ako neko sutra doda „podrazumevani
 * status" u servis, test pada.
 */
describe("Kadrovska 068/26 — inbox ne sme da gubi drugi stepen (sef_approved)", () => {
  const EMAIL = "nenad.jarakovic@servoteh.com";
  const EMP = "6641a729-55a6-4a2e-901c-b4b0ca788042";

  /** Hvata `where` svakog findMany-ja da bismo videli da li je status sužen. */
  function mkTx(rows: Record<string, unknown>[]) {
    const seen: Record<string, unknown>[] = [];
    const findMany = jest.fn(async (args: { where?: Record<string, unknown> }) => {
      seen.push(args?.where ?? {});
      return rows;
    });
    return {
      seen,
      findMany,
      tx: {
        // scope upit (employees) + bonus upit (makeup_requests)
        $queryRaw: jest.fn(async (sql: unknown) => {
          const t = Array.isArray((sql as { strings?: string[] })?.strings)
            ? (sql as { strings: string[] }).strings.join("?")
            : String(sql);
          if (t.includes("FROM employees")) return [{ id: EMP }];
          return [];
        }),
        vacationRequest: { findMany: jest.fn().mockResolvedValue([]) },
        makeupRequest: { findMany },
        paidLeaveRequest: { findMany: jest.fn().mockResolvedValue([]) },
        nopRequest: { findMany: jest.fn().mockResolvedValue([]) },
      },
    };
  }

  function mkService(tx: unknown) {
    const sy15 = {
      withUserRls: jest.fn(async (_e: string, fn: (t: unknown) => unknown) => fn(tx)),
    };
    return new KadrovskaService(sy15 as never, {} as never);
  }

  const SEF_ROW = {
    id: "20f99be3-0d32-46cd-9f84-8ae4745e18d7",
    employeeId: EMP,
    status: "sef_approved",
    compensationType: "dan_odmora",
    level1By: "dusko.kostic@servoteh.com",
    weekendWorkDate: new Date("2026-08-01T00:00:00Z"),
  };

  it("bez ?status= servis NE filtrira po statusu — `sef_approved` stiže u inbox", async () => {
    const { tx, seen } = mkTx([SEF_ROW]);
    const out = await mkService(tx).requests(EMAIL, {} as never);

    // Nijedan findMany ne sme da nosi `status` u `where` kad ga pozivalac nije tražio.
    for (const where of seen) expect(where).not.toHaveProperty("status");
    expect(out.data.makeup).toHaveLength(1);
    expect(out.data.makeup[0]).toMatchObject({
      status: "sef_approved",
      source: "makeup",
    });
  });

  it("eksplicitan ?status=sef_approved se poštuje (filter ostaje mogućnost, ne podrazumevano)", async () => {
    const { tx, seen } = mkTx([SEF_ROW]);
    await mkService(tx).requests(EMAIL, { status: "sef_approved" } as never);
    expect(seen.every((w) => w.status === "sef_approved")).toBe(true);
  });

  it("`bonusGranted=false` za sef_approved dan_odmora — dan JOŠ nije upisan", async () => {
    const { tx } = mkTx([SEF_ROW]);
    const out = await mkService(tx).requests(EMAIL, {} as never);
    // $queryRaw za vacation_bonus_days vraća prazno → zahtev nema upisan dan.
    expect(out.data.makeup[0]).toMatchObject({ bonusGranted: false });
  });
});
