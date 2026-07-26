import {
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { assertRpcOk } from "../../common/sy15/rpc-ok";
import { KadrovskaMutationsService } from "./kadrovska-mutations.service";

/**
 * AUDIT-K3 (26.07) — „tihi neuspesi": radnja se ne desi, a korisnik dobije potvrdu.
 */
describe("Kadrovska AUDIT-K3 — tihi neuspesi", () => {
  const EMAIL = "u@servoteh.com";
  const ID = "3b241101-e2bb-4255-8caf-4136c566a962";

  const mkService = (tx: Record<string, unknown>, dispatcher?: unknown) => {
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
    return new KadrovskaMutationsService(
      sy15 as never,
      { upload: jest.fn(), signUrl: jest.fn(), remove: jest.fn() } as never,
      { configured: true, send: jest.fn().mockResolvedValue(true) } as never,
      (dispatcher ?? { enabled: false, dispatchKadr: jest.fn() }) as never,
    );
  };

  // ── assertRpcOk: {ok:false} mora da postane greška, ne 2xx ────────────────

  it("propušta uspeh i rezultate bez `ok` polja", () => {
    expect(assertRpcOk({ ok: true, id: 1 })).toEqual({ ok: true, id: 1 });
    expect(assertRpcOk({ status: "approved" })).toEqual({ status: "approved" });
    expect(assertRpcOk(null)).toBeNull();
  });

  it("mapira kodove odbijenice u tipizirane greške", () => {
    expect(() => assertRpcOk({ ok: false, error: "nema_prava" })).toThrow(
      ForbiddenException,
    );
    expect(() => assertRpcOk({ ok: false, error: "vec_korigovano" })).toThrow(
      ConflictException,
    );
    expect(() => assertRpcOk({ ok: false, error: "prekasno" })).toThrow(
      UnprocessableEntityException,
    );
    // Nepoznat kod ne sme da prođe kao uspeh.
    expect(() => assertRpcOk({ ok: false, error: "nesto_novo" })).toThrow(
      UnprocessableEntityException,
    );
  });

  it("korekcija prisustva koju baza odbije NE prolazi kao uspeh", async () => {
    const tx = {
      $queryRaw: jest.fn(async () => [
        { v: { ok: false, error: "prekasno" } },
      ]),
      $executeRaw: jest.fn(),
    };
    await expect(
      mkService(tx).submitCorrection(EMAIL, {
        employeeId: ID,
        day: "2026-07-01",
        in: "07:00",
        reason: "zaboravio",
      } as never),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  // ── Dispečer: 3.0 nativni, bez 1.0 edge HTTP poziva ──────────────────────

  it("„Pošalji čekaće” zove 3.0 dispečer (ne 1.0 edge preko fetch-a)", async () => {
    const dispatchKadr = jest
      .fn()
      .mockResolvedValue({ processed: 3, sent: 3, failed: 0 });
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    const svc = mkService({}, { enabled: true, dispatchKadr });

    const out = await svc.dispatchNotifications();

    expect(dispatchKadr).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled(); // nema HTTP skoka na hr-notify-dispatch
    expect(out.data).toMatchObject({ processed: 3, sent: 3, failed: 0 });
    fetchSpy.mockRestore();
  });

  it("„Pošalji čekaće” uz isključen DISPATCH_ENABLED vraća 503, ne lažni uspeh", async () => {
    const svc = mkService({}, { enabled: false, dispatchKadr: jest.fn() });
    await expect(svc.dispatchNotifications()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  // ── 360 pozivnice: bez baze linka ne šaljemo mrtve linkove ───────────────

  it("assessmentInvite bez ASSESSMENT_PUBLIC_BASE ne šalje mejlove sa 404 linkom", async () => {
    const prev = process.env.ASSESSMENT_PUBLIC_BASE;
    delete process.env.ASSESSMENT_PUBLIC_BASE;
    const send = jest.fn().mockResolvedValue(true);
    const tx = {
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(),
      assessmentCycle: { findUnique: jest.fn().mockResolvedValue(null) },
      assessment: {
        findMany: jest.fn().mockResolvedValue([{ id: ID, employeeId: ID }]),
      },
      assessmentRater: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              id: "r1",
              assessmentId: ID,
              raterKind: "peer",
              raterEmail: "kolega@servoteh.com",
              token: "tok",
              invitedAt: null,
            },
          ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      employee: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: ID, fullName: "Test Radnik" }]),
      },
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
      { configured: true, send } as never,
      { enabled: false, dispatchKadr: jest.fn() } as never,
    );

    await expect(
      svc.assessmentInvite(EMAIL, { assessmentId: ID }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(send).not.toHaveBeenCalled();

    if (prev !== undefined) process.env.ASSESSMENT_PUBLIC_BASE = prev;
  });
});
