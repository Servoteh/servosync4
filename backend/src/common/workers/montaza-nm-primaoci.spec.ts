import {
  resolveMontazaNmPrimaoci,
  type MontazaNmPrimaociDb,
} from "./montaza-nm-primaoci";
import { namedPrimaociWorkerIds } from "./named-primaoci";

/**
 * Imenovana lista primalaca neusaglašenosti na montaži (034/26 — Zoranova
 * sedmorka umesto role `menadzment`). Pokriva i zajednički resolver
 * `named-primaoci.ts` (dedup, most ka `users`, worker-id fan-out) — otpis
 * mašine (037/26) isti resolver vežba kroz `masina-otpis-notify.service.spec`.
 */
function dbMock() {
  return {
    montazaNmPrimalac: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  };
}
const asDb = (m: ReturnType<typeof dbMock>) =>
  m as unknown as MontazaNmPrimaociDb;

describe("montaza-nm-primaoci (zahtev 034/26, komentar 29.07)", () => {
  it("čita SAMO aktivne redove tabele (rola se ne gleda)", async () => {
    const db = dbMock();
    await resolveMontazaNmPrimaoci(asDb(db));
    expect(db.montazaNmPrimalac.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true } }),
    );
    // Regresiona brana: nijedan upit ne sme da filtrira po roli — stara rola
    // `menadzment` je slala i test/spoljnim nalozima, a preskakala admin/leadpm.
    for (const call of db.user.findMany.mock.calls as Array<
      [{ where?: Record<string, unknown> }]
    >) {
      expect(JSON.stringify(call[0]?.where ?? {})).not.toContain("role");
    }
  });

  it("mejl ide svakom validnom redu; zvonce samo uz aktivan nalog sa worker_id", async () => {
    const db = dbMock();
    db.montazaNmPrimalac.findMany.mockResolvedValue([
      { email: "zoran.jarakovic@servoteh.com", fullName: "Zoran Jaraković" },
      { email: "nenad.jarakovic@servoteh.com", fullName: "Nenad Jaraković" },
      { email: "bivsi.radnik@servoteh.com", fullName: "Bivši" },
    ]);
    db.user.findMany.mockResolvedValue([
      {
        email: "zoran.jarakovic@servoteh.com",
        fullName: "Zoran Jaraković",
        workerId: 1203,
        active: true,
      },
      // Nenad NEMA worker_id (izmereno na produ) → samo mejl, bez zvonca.
      {
        email: "nenad.jarakovic@servoteh.com",
        fullName: "Nenad Jaraković",
        workerId: null,
        active: true,
      },
      // Ugašen nalog → zvonce ne, mejl da (red tabele je kurirana odluka).
      {
        email: "bivsi.radnik@servoteh.com",
        fullName: "Bivši",
        workerId: 77,
        active: false,
      },
    ]);

    const primaoci = await resolveMontazaNmPrimaoci(asDb(db));

    expect(primaoci.map((p) => p.email)).toEqual([
      "zoran.jarakovic@servoteh.com",
      "nenad.jarakovic@servoteh.com",
      "bivsi.radnik@servoteh.com",
    ]);
    expect(namedPrimaociWorkerIds(primaoci)).toEqual([1203]);
  });

  it("dedup po mejlu case-insensitive; redovi bez @ se odbacuju", async () => {
    const db = dbMock();
    db.montazaNmPrimalac.findMany.mockResolvedValue([
      { email: "x@servoteh.com", fullName: "Prvi" },
      { email: "X@Servoteh.com", fullName: "Duplikat" },
      { email: "", fullName: "Prazan" },
      { email: "nije-mejl", fullName: "Loš" },
    ]);

    const primaoci = await resolveMontazaNmPrimaoci(asDb(db));

    expect(primaoci).toHaveLength(1);
    expect(primaoci[0]).toMatchObject({ email: "x@servoteh.com", fullName: "Prvi" });
    // Prazna očišćena lista ne sme ni da pita `users` (OR: [] bi vratio sve).
  });

  it("prazna tabela → [] bez upita ka users (pozivalac loguje warn)", async () => {
    const db = dbMock();
    expect(await resolveMontazaNmPrimaoci(asDb(db))).toEqual([]);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it("nalog upisan drugačijim velikim slovima svejedno daje zvonce (insensitive most)", async () => {
    const db = dbMock();
    db.montazaNmPrimalac.findMany.mockResolvedValue([
      { email: "miljan.nikodijevic@servoteh.com", fullName: null },
    ]);
    db.user.findMany.mockResolvedValue([
      {
        email: "Miljan.Nikodijevic@Servoteh.com",
        fullName: "Miljan Nikodijević",
        workerId: 13,
        active: true,
      },
    ]);

    const primaoci = await resolveMontazaNmPrimaoci(asDb(db));

    expect(primaoci[0].workerId).toBe(13);
    // Ime iz `users` popunjava rupu kad red tabele nema fullName.
    expect(primaoci[0].fullName).toBe("Miljan Nikodijević");
  });
});
