import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../../prisma/prisma.service";
import { PaymentPreparationService } from "./payment-preparation.service";

/**
 * D1 — IZNOS JE U DINARIMA, A PREDLOG JE GLASIO U VALUTI STAVKE (nalaz 04.08.2026).
 * ============================================================================
 * `selectDue` sabira saldo obaveze iz `ledger_entries.debit`/`.credit`, a to su DINARSKE
 * kolone (devizni par stoji zasebno u `fx_debit`/`fx_credit`/`fx_currency`). Grupa je pri
 * tom nosila `currency` iz stavke, pa je obaveza od 117.000,00 RSD izlazila kao
 * „117.000,00 EUR" i u tom obliku išla u nalog za plaćanje — banci bi otišao iznos
 * višestruko veći od dugovanog.
 *
 * Testovi gledaju TAČNO ono što ruta/ekran dobije: `data` (predlog) i `meta.skipped`
 * (izostavljene devizne obaveze), jer je kvar bio u sadržaju predloga.
 */

const D = Prisma.Decimal;

/** Jedna otvorena stavka glavne knjige kakvu `selectDue` čita (samo polja iz `select`-a). */
function entry(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 5001,
    accountCode: "4330",
    analyticalCode: 555,
    documentNumber: "101/26",
    debit: new D(0),
    credit: new D("117000"),
    dueDate: new Date("2026-07-10T00:00:00.000Z"),
    currency: "RSD",
    ...over,
  };
}

function makeService(entries: ReturnType<typeof entry>[]) {
  const prisma = {
    saldakontoAccount: {
      findMany: jest.fn().mockResolvedValue([{ account: "4330" }]),
    },
    ledgerEntry: { findMany: jest.fn().mockResolvedValue(entries) },
  } as unknown as PrismaService;
  return new PaymentPreparationService(prisma);
}

const CUTOFF = new Date("2026-07-25T00:00:00.000Z");

/** Dinarska obaveza (117.000) + devizna (ista dinarska cifra, stavka označena kao EUR). */
function mixedEntries() {
  return [
    entry(),
    entry({
      id: 5002,
      analyticalCode: 556,
      documentNumber: "F-77/26",
      credit: new D("117000"),
      currency: "EUR",
    }),
  ];
}

describe("D1 — devizna obaveza ne sme da se pojavi kao dinarski predlog", () => {
  it("devizna obaveza NE ulazi u predlog, a dinarska prolazi", async () => {
    const service = makeService(mixedEntries());

    const res = await service.selectDueWithWarnings(CUTOFF);

    // Predlog nosi SAMO dinarsku obavezu; 117.000 dinara više ne izlazi označeno kao EUR.
    expect(res.data).toHaveLength(1);
    expect(res.data[0].documentNumber).toBe("101/26");
    expect(res.data[0].currency).toBe("RSD");
    expect(res.data.some((r) => r.currency !== "RSD")).toBe(false);
    expect(res.meta.count).toBe(1);
  });

  it("izostavljena devizna obaveza se PRIJAVLJUJE (broj dokumenta + valuta u tekstu)", async () => {
    const service = makeService(mixedEntries());

    const res = await service.selectDueWithWarnings(CUTOFF);

    expect(res.meta.skipped).toHaveLength(1);
    const [s] = res.meta.skipped;
    expect(s.currency).toBe("EUR");
    expect(s.documentNumber).toBe("F-77/26");
    expect(s.supplierId).toBe(556);
    // Tiho preskakanje nije prihvatljivo — poruka mora imenovati dokument i valutu.
    expect(s.reason).toContain("F-77/26");
    expect(s.reason).toContain("EUR");
  });

  it("kad nema deviznih obaveza, meta.skipped je prazan (nema lažne uzbune)", async () => {
    const service = makeService([entry()]);

    const res = await service.selectDueWithWarnings(CUTOFF);
    expect(res.data).toHaveLength(1);
    expect(res.meta.skipped).toEqual([]);
  });

  it('kad je SVE dospelo devizno → 400 (prazan spisak bi značio "nema šta da se plati")', async () => {
    const service = makeService([
      entry({ documentNumber: "F-77/26", currency: "EUR" }),
    ]);

    await expect(service.selectDue(CUTOFF)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.selectDue(CUTOFF)).rejects.toThrow(/F-77\/26/);
    await expect(service.selectDue(CUTOFF)).rejects.toThrow(/EUR/);
    // Ista brana i na ruti (`GET /placanja/due` zove ovaj ulaz).
    await expect(service.selectDueWithWarnings(CUTOFF)).rejects.toThrow(
      /devizne obaveze nisu podržane/i,
    );
  });

  it("stavka bez valute (NULL) je dinarska — kolone debit/credit su RSD", async () => {
    const service = makeService([entry({ currency: null })]);

    const due = await service.selectDue(CUTOFF);
    expect(due).toHaveLength(1);
    expect(due[0].currency).toBe("RSD");
    expect(due[0].openAmount).toBe("117000.0000");
  });

  it("grupa koja MEŠA valute se izostavlja (saldo nije ni dinarski ni devizni)", async () => {
    // Grupni ključ (konto, komitent, dokument) ne sadrži valutu, pa u istoj grupi mogu
    // završiti stavke različitih valuta; takav zbir nema smisla ni u jednoj valuti.
    const service = makeService([
      entry({ id: 5003, credit: new D("50000"), currency: "RSD" }),
      entry({ id: 5004, credit: new D("1000"), currency: "EUR" }),
    ]);

    // Ništa dinarsko ne ostaje → tipizirana greška, ne tiho prazan predlog.
    await expect(service.selectDue(CUTOFF)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.selectDue(CUTOFF)).rejects.toThrow(/EUR\/RSD/);
  });
});
