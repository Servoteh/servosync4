import { ForbiddenException } from "@nestjs/common";
import { KadrovskaService } from "./kadrovska.service";

/**
 * ZAHTEV 026/26 — review 31.07: `vacationChangeRequests` je imao PRAZAN `catch {}` koji je
 * SVAKU grešku prevodio u `{ data: [], meta: { pending_sql: true } }`. FE (zahtevi-tab
 * `ChangeRequestsPanel`) na `meta.pending_sql` renderuje trajni baner „modul čeka primenu
 * SQL-a" — pa bi posle STVARNE primene skripte bilo koji realan kvar (RLS/GRANT regresija,
 * pad konekcije, drift kolona) HR-u prikazao obmanjujuću poruku, a molbe zaposlenih bi tiho
 * nestale sa ekrana i niko ih ne bi odlučio (HTTP 200 → nevidljivo i za monitoring).
 *
 * Ovi testovi pinuju SUŽEN catch: `pending_sql` samo za „objekat ne postoji" (42883/42P01),
 * sve ostalo propada dalje kao prava greška.
 */
describe("Kadrovska — ZAHTEV 026/26 (vacationChangeRequests: pending_sql samo za 42P01/42883)", () => {
  const EMAIL = "hr@servoteh.com";

  /** Prisma raw grešku iz Postgresa isporučuje kao P2010 sa `meta.code` = SQLSTATE. */
  const pgError = (sqlstate: string, message = "db error") =>
    Object.assign(new Error(message), {
      code: "P2010",
      meta: { code: sqlstate, message },
    });

  const mkSvc = (err?: Error) => {
    const tx = {
      $queryRaw: jest.fn((): Promise<unknown[]> => {
        if (err) throw err;
        return Promise.resolve([{ id: "x" }]);
      }),
    };
    const withUserRls = jest.fn(
      (_e: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
    const sy15 = { withUserRls } as Record<string, unknown>;
    return new KadrovskaService(sy15 as never, {} as never);
  };

  it("42P01 (tabela ne postoji) → prazna lista + meta.pending_sql", async () => {
    const svc = mkSvc(pgError("42P01"));
    await expect(svc.vacationChangeRequests(EMAIL)).resolves.toEqual({
      data: [],
      meta: { pending_sql: true },
    });
  });

  it("42883 (funkcija ne postoji) → prazna lista + meta.pending_sql", async () => {
    const svc = mkSvc(pgError("42883"));
    const out = await svc.vacationChangeRequests(EMAIL, "pending");
    expect(out.meta).toEqual({ pending_sql: true });
  });

  it("42501 (RLS/GRANT) NE sme da se predstavi kao pending_sql → 403", async () => {
    const svc = mkSvc(pgError("42501", "permission_denied"));
    await expect(svc.vacationChangeRequests(EMAIL)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("pad konekcije NE sme da se predstavi kao pending_sql → greška propada dalje", async () => {
    const boom = new Error("Server has closed the connection.");
    const svc = mkSvc(boom);
    await expect(svc.vacationChangeRequests(EMAIL)).rejects.toBe(boom);
  });

  it("uspešan upit → podaci bez meta.pending_sql", async () => {
    const svc = mkSvc();
    const out = await svc.vacationChangeRequests(EMAIL);
    expect(out).toEqual({ data: [{ id: "x" }] });
  });
});
