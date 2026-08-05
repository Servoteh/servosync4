import { NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { PrismaService } from "../../prisma/prisma.service";
import { PaymentAccountsService } from "./payment-accounts.service";
import { NATIVE_COLUMN_TABLES } from "../sync/table-ownership";

/**
 * UNOS DEVIZNOG RAČUNA — jedina vrata kroz koja IBAN i SWIFT mogu da uđu u
 * `payment_accounts`, a odatle na izvoznu fakturu.
 *
 * Testira se troje: da se pišu SAMO četiri kolone koje BigBit ne zna, da neispravan IBAN
 * ne prođe (uplata koja ne stigne otkriva se tek kad kupac pozove), i da tabela stoji u
 * `NATIVE_COLUMN_TABLES` — bez toga bi noćni full refresh obrisao sve unete podatke i
 * vratio nas na isti kvar, samo sa zakašnjenjem.
 */

function makePrisma(over: Record<string, unknown> = {}) {
  const account = {
    id: 5,
    companyId: 1,
    accountNumber: "160-0050100035011-86",
    bankName: null,
    isDefault: true,
    sortOrder: 0,
    iban: null,
    swift: null,
    bankAddress: null,
    currency: null,
  };
  return {
    company: { findFirst: jest.fn(() => Promise.resolve({ id: 1 })) },
    paymentAccount: {
      findMany: jest.fn((_args: { where: { companyId: number } }) =>
        Promise.resolve([account]),
      ),
      // Tip mora da dopusti `null` — jedan test podmeće nepostojeći račun.
      findUnique: jest.fn(
        (_args?: unknown): Promise<{ id: number } | null> =>
          Promise.resolve({ id: 5 }),
      ),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...account, ...args.data }),
      ),
    },
    ...over,
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  return new PaymentAccountsService(prisma as unknown as PrismaService);
}

describe("PaymentAccountsService — unos deviznog računa", () => {
  it("upisuje IBAN, SWIFT, banku, adresu i valutu", async () => {
    const prisma = makePrisma();
    const res = await makeService(prisma).update(5, {
      iban: "RS35160005010003501186",
      swift: "DBDBRSBG",
      bankName: "Banca Intesa a.d.",
      bankAddress: "Milentija Popovića 7b, 11070 New Belgrade\nRepublic of Serbia",
      currency: "EUR",
    });

    const data = prisma.paymentAccount.update.mock.calls[0][0].data;
    expect(data).toEqual({
      iban: "RS35160005010003501186",
      swift: "DBDBRSBG",
      bankName: "Banca Intesa a.d.",
      bankAddress: "Milentija Popovića 7b, 11070 New Belgrade\nRepublic of Serbia",
      currency: "EUR",
    });
    expect(res.data.iban).toBe("RS35160005010003501186");
  });

  it("IBAN se čuva bez razmaka i velikim slovima (kanonski oblik)", async () => {
    const prisma = makePrisma();
    await makeService(prisma).update(5, {
      iban: "rs35 1600 0501 0003 5011 86",
      swift: "dbdbrsbg",
    });

    const data = prisma.paymentAccount.update.mock.calls[0][0].data;
    expect(data.iban).toBe("RS35160005010003501186");
    expect(data.swift).toBe("DBDBRSBG");
  });

  it("valuta se normalizuje na velika slova (eur i EUR su isti račun)", async () => {
    const prisma = makePrisma();
    await makeService(prisma).update(5, { currency: " eur " });
    expect(prisma.paymentAccount.update.mock.calls[0][0].data.currency).toBe(
      "EUR",
    );
  });

  it("pogrešno prepisan IBAN ne prolazi (MOD-97)", async () => {
    const prisma = makePrisma();
    // Poslednja dva znaka zamenjena mesta — oblik ispravan, kontrolni zbir nije.
    await expect(
      makeService(prisma).update(5, { iban: "RS35160005010003501168" }),
    ).rejects.toThrow(/MOD-97/);
    expect(prisma.paymentAccount.update).not.toHaveBeenCalled();
  });

  it("SWIFT pogrešne dužine ne prolazi", async () => {
    const prisma = makePrisma();
    await expect(
      makeService(prisma).update(5, { swift: "DBDB" }),
    ).rejects.toThrow(UnprocessableEntityException);
    expect(prisma.paymentAccount.update).not.toHaveBeenCalled();
  });

  it("valuta mora biti troslovna oznaka (ISO 4217)", async () => {
    const prisma = makePrisma();
    await expect(
      makeService(prisma).update(5, { currency: "EURO" }),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it("prazan string briše polje (papir tada taj red ne ispisuje)", async () => {
    const prisma = makePrisma();
    await makeService(prisma).update(5, { iban: "  " });
    expect(prisma.paymentAccount.update.mock.calls[0][0].data.iban).toBeNull();
  });

  it("izostavljeno polje se NE dira", async () => {
    const prisma = makePrisma();
    await makeService(prisma).update(5, { currency: "EUR" });
    expect(
      Object.keys(prisma.paymentAccount.update.mock.calls[0][0].data),
    ).toEqual(["currency"]);
  });

  it("prazno telo je greška, ne tihi no-op", async () => {
    const prisma = makePrisma();
    await expect(makeService(prisma).update(5, {})).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  it("nepostojeći račun daje 404, ne tihi upis", async () => {
    const prisma = makePrisma();
    prisma.paymentAccount.findUnique = jest.fn(() => Promise.resolve(null));
    await expect(
      makeService(prisma).update(99, { currency: "EUR" }),
    ).rejects.toThrow(NotFoundException);
  });

  /**
   * BigBit kolone se NE menjaju iz forme: sync ih prepisuje na sledećem prolazu, pa bi
   * izmena bila obećanje koje sistem ne može da održi. `whitelist: true` u `ValidationPipe`
   * ih odbacuje već na ulazu; ovde se pinuje da ih ni servis ne propušta.
   */
  it("BigBit kolone ne mogu da se promene ni kad se podmetnu", async () => {
    const prisma = makePrisma();
    await makeService(prisma).update(5, {
      currency: "EUR",
      accountNumber: "999-999999-99",
      isDefault: false,
    } as never);

    const data = prisma.paymentAccount.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("accountNumber");
    expect(data).not.toHaveProperty("isDefault");
  });

  it("lista bira primarnu firmu kad `companyId` nije prosleđen", async () => {
    const prisma = makePrisma();
    const res = await makeService(prisma).list();
    expect(prisma.company.findFirst).toHaveBeenCalled();
    expect(prisma.paymentAccount.findMany.mock.calls[0][0]?.where).toEqual({
      companyId: 1,
    });
    expect(res.data).toHaveLength(1);
  });

  /**
   * Brana protiv tihog gubitka: `payment_accounts` vozi FULL REFRESH (mapa `UplatniRacuni`
   * nema `watermark`), pa bi `deleteMany` + `createMany` obrisao četiri kolone koje BigBit
   * ne zna. Bez ovog upisa unos IBAN-a preživi tačno do prvog noćnog sync-a.
   */
  it("tabela je zaštićena od full refresh-a (NATIVE_COLUMN_TABLES)", () => {
    expect(NATIVE_COLUMN_TABLES.has("payment_accounts")).toBe(true);
  });
});
