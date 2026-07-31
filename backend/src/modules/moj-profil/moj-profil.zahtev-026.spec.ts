import {
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { MojProfilService } from "./moj-profil.service";

/**
 * ZAHTEV 026/26 — review 31.07, dve popravke u „Mom profilu":
 *
 * 1. DEPLOY-PROZOR: `ZAHTEV_026_GO_IZMENA_OTKAZ.sql` se na sy15 primenjuje RUČNO, a merge
 *    deployuje backend+frontend odjednom. FE istog trena sklanja radniku direktnu izmenu/
 *    otkaz/brisanje nad POTVRĐENIM terminom i nudi samo „Zatraži izmenu/otkazivanje" — a taj
 *    poziv je do sada padao kao sirov 500 („Slanje nije uspelo.") dok fn ne postoji. Sada:
 *    SAMO 42883/42P01 → 503 sa jasnom porukom; svaka druga greška ide dalje kao prava.
 *
 * 2. `myVacationChanges` je imao prazan `catch {}` — posle primene SQL-a realna greška bi
 *    vratila praznu listu, pa bi radniku ponovo iskočila dugmad „Zatraži…" iako molba već
 *    postoji (dupli submit bi zaustavio tek unique indeks).
 */
describe("Moj profil — ZAHTEV 026/26 (deploy-prozor + sužen catch)", () => {
  const EMAIL = "radnik@servoteh.com";
  const CID = "3b241101-e2bb-4255-8caf-4136c566a962";
  const REQ = "11111111-2222-3333-4444-555555555555";
  const EMP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  type SqlLike = { strings?: readonly string[]; values?: unknown[] };
  const txt = (s: SqlLike): string =>
    Array.isArray(s?.strings) ? s.strings.join("?") : "";

  /** Prisma raw grešku iz Postgresa isporučuje kao P2010 sa `meta.code` = SQLSTATE. */
  const pgError = (sqlstate: string, message = "db error") =>
    Object.assign(new Error(message), {
      code: "P2010",
      meta: { code: sqlstate, message },
    });

  /** @param onChangeSql greška koju baca upit nad 026 objektima (fn ili tabela) */
  const mkSvc = (onChangeSql?: Error) => {
    const tx = {
      $queryRaw: jest.fn((sql: SqlLike): Promise<unknown[]> => {
        const t = txt(sql);
        if (
          t.includes("kadr_vacreq_change_submit") ||
          t.includes("vacation_change_requests")
        ) {
          if (onChangeSql) throw onChangeSql;
          return Promise.resolve([{ result: { status: "pending" } }]);
        }
        if (t.includes("v_employees_safe"))
          return Promise.resolve([{ id: EMP }]);
        if (t.includes("generate_series"))
          return Promise.resolve([{ n: BigInt(5), weekdays: BigInt(5) }]);
        if (t.includes("go_ledger")) return Promise.resolve([{ v: [] }]);
        return Promise.resolve([]);
      }),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    const sy15 = {
      withUserRls: jest.fn((_e: string, fn: (t: unknown) => Promise<unknown>) =>
        fn(tx),
      ),
      runIdempotentRls: jest.fn(
        async (
          _e: string,
          _cid: string,
          _a: string,
          fn: (t: unknown) => Promise<unknown>,
        ) => ({ idempotent: false, result: await fn(tx) }),
      ),
    };
    const svc = new MojProfilService(
      sy15 as never,
      {
        enabled: false,
        dispatchKadr: jest.fn(),
      } as never,
    );
    return { svc, tx };
  };

  const CANCEL = {
    clientEventId: CID,
    kind: "cancel" as const,
    reason: "Selidba",
  };

  // ---------- 1) submitVacationChange: deploy-prozor ----------

  it("42883 (fn ne postoji — SQL još nije primenjen) → 503 sa razumljivom porukom, ne 500", async () => {
    const { svc } = mkSvc(pgError("42883"));
    const p = svc.submitVacationChange(EMAIL, REQ, CANCEL);
    await expect(p).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(p).rejects.toThrow(/nije aktiviran na glavnoj bazi/i);
  });

  it("42P01 (tabela ne postoji) → isto 503", async () => {
    const { svc } = mkSvc(pgError("42P01"));
    await expect(
      svc.submitVacationChange(EMAIL, REQ, CANCEL),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("42501 (RLS/DEFINER guard) NE sme da postane 503 (ceka SQL) → ostaje 403", async () => {
    const { svc } = mkSvc(pgError("42501", "permission_denied"));
    await expect(
      svc.submitVacationChange(EMAIL, REQ, CANCEL),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("neočekivana greška (pad konekcije) propada dalje, ne maskira se u 503", async () => {
    const boom = new Error("Server has closed the connection.");
    const { svc } = mkSvc(boom);
    await expect(svc.submitVacationChange(EMAIL, REQ, CANCEL)).rejects.toBe(
      boom,
    );
  });

  it("uspeh: i dalje zove kadr_vacreq_change_submit i vraća status molbe", async () => {
    const { svc, tx } = mkSvc();
    const out = await svc.submitVacationChange(EMAIL, REQ, CANCEL);
    expect(
      tx.$queryRaw.mock.calls.some((c) =>
        txt(c[0]).includes("kadr_vacreq_change_submit("),
      ),
    ).toBe(true);
    expect((out as { data: { status: string } }).data.status).toBe("pending");
  });

  // ---------- 2) myVacationChanges (kroz vacation()) ----------

  it("vacation(): 42P01 nad vacation_change_requests → changeRequests: [] (graciozno)", async () => {
    const { svc } = mkSvc(pgError("42P01"));
    const out = (await svc.vacation(EMAIL)) as {
      data: { changeRequests: unknown[] };
    };
    expect(out.data.changeRequests).toEqual([]);
  });

  it("vacation(): prava greška nad vacation_change_requests NE sme da se pojede", async () => {
    const boom = new Error("connection reset");
    const { svc } = mkSvc(boom);
    await expect(svc.vacation(EMAIL)).rejects.toBe(boom);
  });
});
