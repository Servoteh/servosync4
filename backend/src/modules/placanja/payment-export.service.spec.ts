import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../../prisma/prisma.service";
import { PaymentExportService } from "./payment-export.service";
import { kBroj97 } from "./mod97.util";

/**
 * D2 i D3 — FAJL ZA BANKU (FX fiksni TXT), nalazi 04.08.2026.
 * ============================================================================
 * D2: zaglavlje je sabiralo `amount` preko SVIH naloga bez obzira na valutu i tvrdo
 *     pisalo „YUM", pa je paket 100.000 RSD + 1.000 EUR prijavljivao „101.000 YUM" —
 *     kontrolni zbir koji ne postoji ni u jednoj valuti.
 * D3: `supplierName()` je vraćao "", pa je polje naziva primaoca (35) u svakom
 *     detaljnom slogu bilo 35 praznih znakova — banka je dobijala nalog bez imena
 *     primaoca, samo sa računom.
 *
 * Testovi gledaju TAČNO sadržaj slogova (fiksne pozicije) i to da se pri odbijanju
 * NIJEDAN nalog ne označi kao izvezen/plaćen.
 */

const D = Prisma.Decimal;

/** Validan žiro račun (DobarTR): KK = kBroj97("160" + "0000000000123") = "95". */
const VALID_TR = `160-0000000000123-${kBroj97("1600000000000123")}`;

/** Fiksne pozicije u slogu — iz zaglavlja servisa (legacy `PrebaciUFX`). */
const NAME_FROM = 18; // banka(3) + racun(15)
const NAME_TO = 53; // + naziv(35)
const CURRENCY_FROM = 93; // banka(3)+racun(15)+naziv(35)+mesto(20)+ukupno(15)+brSlogova(5)
const CURRENCY_TO = 96;
const RECORD_LEN = 180; // ukupna širina sloga (i vodećeg i detaljnog)

function order(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    orderNumber: "V-1",
    supplierId: 555,
    supplierAccount: VALID_TR,
    amount: new D("100000"),
    currency: "RSD",
    purpose: "UPLATA ZA ROBU",
    referenceNumberCredit: "10126",
    status: "SIGNED",
    isLocked: false,
    ...over,
  };
}

const LEADER = {
  debitAccount: VALID_TR,
  debitName: "Servoteh d.o.o.",
  debitPlace: "Šabac",
  orderDate: new Date("2026-07-25T00:00:00.000Z"),
};

function makeService(
  orders: ReturnType<typeof order>[],
  customers: { id: number; name: string }[],
) {
  const updateMany = jest.fn().mockResolvedValue({ count: orders.length });
  const customerFindMany = jest.fn(
    async (args: { where: { id: { in: number[] } } }) =>
      customers.filter((c) => args.where.id.in.includes(c.id)),
  );
  const prisma = {
    paymentOrder: {
      findMany: jest.fn().mockResolvedValue(orders),
      updateMany,
    },
    customer: { findMany: customerFindMany },
  } as unknown as PrismaService;
  return {
    service: new PaymentExportService(prisma),
    updateMany,
    customerFindMany,
  };
}

describe("D2 — jedna valuta po paketu, oznaka izvedena iz nje", () => {
  it("paket sa DVE valute se odbija (spisak valuta u poruci), ništa se ne označi", async () => {
    const { service, updateMany } = makeService(
      [
        order(),
        order({
          id: 2,
          orderNumber: "V-2",
          currency: "EUR",
          amount: new D("1000"),
        }),
      ],
      [{ id: 555, name: "Metalprodukt d.o.o." }],
    );

    await expect(service.exportFx([1, 2], LEADER)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.exportFx([1, 2], LEADER)).rejects.toThrow(/EUR/);
    await expect(service.exportFx([1, 2], LEADER)).rejects.toThrow(/RSD/);
    // Nijedan nalog ne sme ostati označen kao izvezen/plaćen.
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("valuta bez poznate oznake u obrascu se ne pretpostavlja — izvoz pada", async () => {
    const { service, updateMany } = makeService(
      [order({ currency: "EUR", amount: new D("1000") })],
      [{ id: 555, name: "Metalprodukt d.o.o." }],
    );

    await expect(service.exportFx([1], LEADER)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.exportFx([1], LEADER)).rejects.toThrow(/EUR/);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('dinarski paket nosi legacy oznaku „YUM" i zbir svih naloga u parama', async () => {
    const { service } = makeService(
      [order(), order({ id: 2, orderNumber: "V-2", amount: new D("1000.50") })],
      [{ id: 555, name: "Metalprodukt d.o.o." }],
    );

    const { txt, exportedCount } = await service.exportFx([1, 2], LEADER);
    const [leaderRec] = txt.split("\r\n");

    expect(exportedCount).toBe(2);
    expect(leaderRec.slice(CURRENCY_FROM, CURRENCY_TO)).toBe("YUM");
    expect(leaderRec).toHaveLength(RECORD_LEN);
    // ukupno = (100.000,00 + 1.000,50) * 100 = 10.100.050 para, širina 15 sa vodećim nulama
    expect(leaderRec.slice(73, 88)).toBe("000000010100050");
  });

  it("prazna/nedostajuća valuta naloga je dinar (schema default RSD)", async () => {
    const { service } = makeService(
      [
        order({ currency: "" }),
        order({ id: 2, orderNumber: "V-2", currency: "rsd" }),
      ],
      [{ id: 555, name: "Metalprodukt d.o.o." }],
    );

    const { txt } = await service.exportFx([1, 2], LEADER);
    expect(txt.split("\r\n")[0].slice(CURRENCY_FROM, CURRENCY_TO)).toBe("YUM");
  });
});

describe("D3 — naziv primaoca mora biti u fajlu za banku", () => {
  it("primalac bez naziva u šifarniku obara izvoz (spisak komitenata u poruci)", async () => {
    const { service, updateMany } = makeService(
      [order(), order({ id: 2, orderNumber: "V-2", supplierId: 777 })],
      [{ id: 555, name: "Metalprodukt d.o.o." }], // komitent 777 ne postoji
    );

    await expect(service.exportFx([1, 2], LEADER)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.exportFx([1, 2], LEADER)).rejects.toThrow(/777/);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("naziv od samih praznina se tretira kao da ga nema", async () => {
    const { service, updateMany } = makeService(
      [order()],
      [{ id: 555, name: "   " }],
    );

    await expect(service.exportFx([1], LEADER)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.exportFx([1], LEADER)).rejects.toThrow(/555/);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("naziv se upisuje u slog na tačnu širinu (35, dopuna prazninama desno)", async () => {
    const name = "Metalprodukt d.o.o.";
    const { service, customerFindMany } = makeService(
      [order(), order({ id: 2, orderNumber: "V-2" })],
      [{ id: 555, name }],
    );

    const { txt } = await service.exportFx([1, 2], LEADER);
    const [, first, second] = txt.split("\r\n");

    expect(first.slice(NAME_FROM, NAME_TO)).toBe(name.padEnd(35, " "));
    expect(first.slice(NAME_FROM, NAME_TO)).toHaveLength(35);
    expect(first).toHaveLength(RECORD_LEN); // širina sloga nepromenjena
    expect(second.slice(NAME_FROM, NAME_TO)).toBe(name.padEnd(35, " "));
    // JEDAN upit za ceo paket (dva naloga, istog komitenta) — ne upit po nalogu.
    expect(customerFindMany).toHaveBeenCalledTimes(1);
  });

  it("naziv duži od 35 se seče na prvih 35 znakova (postojeća semantika polja)", async () => {
    const name = "Preduzeće za proizvodnju i promet METAL doo";
    const { service } = makeService([order()], [{ id: 555, name }]);

    const { txt } = await service.exportFx([1], LEADER);
    const detail = txt.split("\r\n")[1];

    expect(detail.slice(NAME_FROM, NAME_TO)).toBe(name.slice(0, 35));
    expect(detail).toHaveLength(RECORD_LEN);
  });
});
