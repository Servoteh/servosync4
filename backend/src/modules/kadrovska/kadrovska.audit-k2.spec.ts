import { ForbiddenException } from "@nestjs/common";
import { KadrovskaMutationsService } from "./kadrovska-mutations.service";
import { KadrovskaService } from "./kadrovska.service";
import { MojProfilService } from "../moj-profil/moj-profil.service";

/**
 * AUDIT-K2 (26.07) — regresioni testovi za sigurnosne nalaze.
 *
 * Zajednička nit svih: RLS ovde NIJE scope. Politike puštaju sve redove svakome
 * ko prođe rolu (`current_user_can_manage_vacreq`, `can_manage_org_profile`), a
 * `submitted_by = auth.jwt()->>'email'` je uvek ispunjen jer BE upisuje pozivaoca.
 * Zato serverska provera (`current_user_manages_employee` / `manages_dev_plan`)
 * mora postojati u kodu — FE gejt nije brana.
 */
describe("Kadrovska AUDIT-K2 — sigurnost", () => {
  const EMAIL = "sef@servoteh.com";
  const SELF = "11111111-1111-4111-8111-111111111111";
  const TUDJI = "22222222-2222-4222-8222-222222222222";

  type SqlLike = { strings?: readonly string[]; values?: unknown[] };
  const sqlText = (s: SqlLike) =>
    Array.isArray(s?.strings) ? s.strings.join("?") : String(s);

  /** tx u kome `current_user_manages_employee(...)` vraća `manages`. */
  const mkTx = (manages: boolean) => {
    const calls: SqlLike[] = [];
    return {
      calls,
      tx: {
        $queryRaw: jest.fn(async (sql: SqlLike) => {
          calls.push(sql);
          const t = sqlText(sql);
          if (t.includes("current_user_manages_employee"))
            return [{ ok: manages }];
          if (t.includes("FROM employees") && t.includes("email"))
            return [{ id: SELF }];
          return [{ v: null }];
        }),
        $executeRaw: jest.fn().mockResolvedValue(1),
        employee: { findFirst: jest.fn().mockResolvedValue({ id: SELF }) },
      },
    };
  };

  const mkProfil = (tx: unknown) => {
    const sy15 = {
      withUserRls: jest.fn(async (_e: string, fn: (t: unknown) => unknown) => fn(tx)),
      runIdempotentRls: jest.fn(
        async (_e: unknown, _c: unknown, _a: unknown, fn: (t: unknown) => unknown) => ({
          idempotent: false,
          result: await fn(tx),
        }),
      ),
      withUser: jest.fn(),
      runIdempotent: jest.fn(),
    };
    return new MojProfilService(sy15 as never, { send: jest.fn() } as never);
  };

  // ── IDOR: podnošenje zahteva u tuđe ime ──────────────────────────────────

  it("submitMakeup za TUĐEG zaposlenog pada na 403 kad ga ne vodim", async () => {
    const { tx } = mkTx(false);
    await expect(
      mkProfil(tx).submitMakeup(EMAIL, {
        clientEventId: "c1",
        employeeId: TUDJI,
        absenceDate: "2026-07-10",
        absenceHours: 8,
        compensationType: "nadoknada",
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("submitPaidLeave za TUĐEG zaposlenog pada na 403 kad ga ne vodim", async () => {
    const { tx } = mkTx(false);
    await expect(
      mkProfil(tx).submitPaidLeave(EMAIL, {
        clientEventId: "c2",
        employeeId: TUDJI,
        leaveType: "smrt_clana_porodice",
        dateFrom: "2026-07-10",
        dateTo: "2026-07-11",
        daysCount: 2,
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("submitMakeup za zaposlenog KOJEG vodim prolazi", async () => {
    const { tx, calls } = mkTx(true);
    await mkProfil(tx).submitMakeup(EMAIL, {
      clientEventId: "c3",
      employeeId: TUDJI,
      absenceDate: "2026-07-10",
      absenceHours: 8,
      compensationType: "nadoknada",
    } as never);
    // Brana je zaista pozvana (a ne preskočena).
    expect(
      calls.some((c) => sqlText(c).includes("current_user_manages_employee")),
    ).toBe(true);
  });

  // ── Inbox scope: /requests mora da filtrira po opsegu ────────────────────

  it("GET /requests filtrira po opsegu i ne dozvoljava da ?employeeId= zaobiđe opseg", async () => {
    const scopeIds = [SELF];
    const seen: Record<string, unknown>[] = [];
    const model = {
      findMany: jest.fn(async (args: Record<string, unknown>) => {
        seen.push(args);
        return [];
      }),
    };
    const tx = {
      $queryRaw: jest.fn(async () => scopeIds.map((id) => ({ id }))),
      vacationRequest: model,
      makeupRequest: model,
      paidLeaveRequest: model,
      nopRequest: model,
    };
    const sy15 = {
      withUserRls: jest.fn(async (_e: string, fn: (t: unknown) => unknown) => fn(tx)),
    };
    const svc = new KadrovskaService(sy15 as never);

    // Bez filtera → samo opseg.
    await svc.requests(EMAIL, {} as never);
    expect((seen[0].where as Record<string, unknown>).employeeId).toEqual({
      in: scopeIds,
    });

    // Sa tuđim employeeId → PRESEK je prazan (ne prolazi van opsega).
    seen.length = 0;
    await svc.requests(EMAIL, { employeeId: TUDJI } as never);
    expect((seen[0].where as Record<string, unknown>).employeeId).toEqual({
      in: [],
    });
  });

  // ── GO: /approve više ne sme na jednostepeni RPC ─────────────────────────

  it("requests/vacation/:id/approve ide na dvostepeni hr_vacreq_approve", async () => {
    const calls: SqlLike[] = [];
    const tx = {
      $queryRaw: jest.fn(async (sql: SqlLike) => {
        calls.push(sql);
        return [{ v: { status: "sef_approved" } }];
      }),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const sy15 = {
      withUserRls: jest.fn(async (_e: string, fn: (t: unknown) => unknown) => fn(tx)),
      runIdempotentRls: jest.fn(
        async (_e: unknown, _c: unknown, _a: unknown, fn: (t: unknown) => unknown) => ({
          idempotent: false,
          result: await fn(tx),
        }),
      ),
      withUser: jest.fn(),
      runIdempotent: jest.fn(),
    };
    const svc = new KadrovskaMutationsService(
      sy15 as never,
      { upload: jest.fn(), signUrl: jest.fn(), remove: jest.fn() } as never,
      { configured: true, send: jest.fn() } as never,
    );

    await svc.vacationApprove(EMAIL, SELF, {} as never);
    const texts = calls.map(sqlText).join(" | ");
    expect(texts).toContain("hr_vacreq_approve");
    // Jednostepeni legat (bez opsega/dvostepenosti/brane salda) se više ne zove.
    expect(texts).not.toContain("hr_approve_vacation_request");
  });

  // ── 360 kampanja: opseg po zaposlenom ────────────────────────────────────

  it("assessmentOpenCampaign odbija zaposlene van opsega", async () => {
    const tx = {
      // Nijedan od traženih id-jeva nije u opsegu.
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(),
    };
    const sy15 = {
      withUserRls: jest.fn(async (_e: string, fn: (t: unknown) => unknown) => fn(tx)),
      runIdempotentRls: jest.fn(
        async (_e: unknown, _c: unknown, _a: unknown, fn: (t: unknown) => unknown) => ({
          idempotent: false,
          result: await fn(tx),
        }),
      ),
      withUser: jest.fn(),
      runIdempotent: jest.fn(),
    };
    const svc = new KadrovskaMutationsService(
      sy15 as never,
      { upload: jest.fn(), signUrl: jest.fn(), remove: jest.fn() } as never,
      { configured: true, send: jest.fn() } as never,
    );

    await expect(
      svc.assessmentOpenCampaign(EMAIL, {
        clientEventId: "c9",
        title: "360 2026",
        period: "2026",
        employeeIds: [TUDJI],
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
