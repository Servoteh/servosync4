import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../../prisma/prisma.service";
import type { MailService } from "../../common/mail/mail.service";
import type { DunningPdfService } from "./dunning-pdf.service";
import type { OpenItem, OpenItemsService } from "./open-items.service";
import { DunningService } from "./dunning.service";

/**
 * OPOMENA IDE SAMO KUPCU (D1, 04.08.2026).
 * ============================================================================
 * ŠTA SE DEŠAVALO PRE POPRAVKE: kandidati i osnovica su se birali samo po
 * `side === "receivable"`, a „receivable" je STRANA SALDA, ne vrsta partnera —
 * dati avans dobavljaču (konto 1520) je aktiva sa dugovnim saldom, dakle
 * `side = "receivable"`. Dobavljač kome smo MI platili avans od 500.000 je zato
 * postajao kandidat za opomenu i, sa 154 dana „docnje", dobijao mejl
 * „OPOMENA PRED UTUŽENJE" sa najavom prinudne naplate.
 *
 * Uslov je sada `side === "receivable" && partnerScope === "customer"`
 * (`isCustomerReceivable`), a `partnerScope = NULL` NE ULAZI — za konto bez
 * upisane vrste partnera se ne može dokazati da je kupčev, a opomena je akt
 * koji ide partneru.
 */

const D = Prisma.Decimal;
const AS_OF = new Date("2026-08-02T00:00:00.000Z");

function item(over: Partial<OpenItem> = {}): OpenItem {
  return {
    accountCode: "2040",
    analyticalCode: 5,
    documentNumber: "7/26",
    balance: new D("12000"),
    totalDebit: new D("12000"),
    totalCredit: new D("0"),
    dueDate: new Date("2026-06-01T00:00:00.000Z"),
    daysOverdue: 62,
    currency: "RSD",
    side: "receivable",
    partnerScope: "customer",
    fxAmount: null,
    fxCurrency: null,
    ledgerEntryIds: [1],
    ...over,
  };
}

/** Avans koji smo MI platili DOBAVLJAČU: konto 1520, aktiva → dugovni saldo. */
const DATI_AVANS_DOBAVLJACU = item({
  accountCode: "1520",
  analyticalCode: 77,
  documentNumber: "AV-3/26",
  balance: new D("500000"),
  totalDebit: new D("500000"),
  dueDate: new Date("2026-03-01T00:00:00.000Z"),
  daysOverdue: 154,
  side: "receivable", // strana SALDA — zato je stari filter i propuštao ovu stavku
  partnerScope: "supplier",
  ledgerEntryIds: [9],
});

/** Kupčeva neplaćena faktura — ovo se opominje. */
const KUPCEVA_FAKTURA = item();

/** Konto bez upisane vrste partnera (registar nedopunjen) — namerno se NE opominje. */
const BEZ_SCOPE = item({
  accountCode: "2049",
  analyticalCode: 88,
  documentNumber: "9/26",
  partnerScope: null,
  ledgerEntryIds: [7],
});

function makeService(items: OpenItem[]) {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    customer: {
      findMany: jest.fn().mockResolvedValue([
        { id: 5, name: "Kupac d.o.o.", email: "kupac@example.com" },
        { id: 77, name: "Dobavljač d.o.o.", email: "dobavljac@example.com" },
        { id: 88, name: "Bez scope-a d.o.o.", email: "bez@example.com" },
      ]),
      findUnique: jest.fn(({ where }: { where: { id: number } }) =>
        Promise.resolve({
          name: `Komitent ${where.id}`,
          email: `komitent${where.id}@example.com`,
        }),
      ),
    },
    dunningNotice: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({ id: created.length });
      }),
    },
  };
  const mail = { send: jest.fn().mockResolvedValue(true) };
  const openItems = {
    listOpenItems: jest.fn((_account?: string, partnerId?: number) =>
      Promise.resolve(
        partnerId == null
          ? items
          : items.filter((i) => i.analyticalCode === partnerId),
      ),
    ),
  };
  const pdfResult = { buffer: Buffer.from("%PDF-1.4"), fileName: "O.pdf" };
  const dunningPdf = {
    buildDunningPdf: jest.fn().mockResolvedValue(pdfResult),
  };

  const service = new DunningService(
    prisma as unknown as PrismaService,
    mail as unknown as MailService,
    openItems as unknown as OpenItemsService,
    dunningPdf as unknown as DunningPdfService,
  );
  return { service, prisma, mail, dunningPdf, created };
}

describe("DunningService — opomena ide samo kupcu", () => {
  it("dati avans dobavljaču NIJE kandidat za opomenu (kupac jeste)", async () => {
    const { service } = makeService([DATI_AVANS_DOBAVLJACU, KUPCEVA_FAKTURA]);

    const cands = await service.candidates(AS_OF);

    expect(cands.map((c) => c.partnerId)).toEqual([5]);
    // 154 dana „docnje" po avansu bi dalo nivo 3 = OPOMENA PRED UTUŽENJE.
    expect(cands.some((c) => c.partnerId === 77)).toBe(false);
  });

  it("kupac i dalje ulazi u opomenu sa punim iznosom i nivoom iz kašnjenja", async () => {
    const { service } = makeService([DATI_AVANS_DOBAVLJACU, KUPCEVA_FAKTURA]);

    const [kupac] = await service.candidates(AS_OF);

    expect(kupac.partnerId).toBe(5);
    expect(kupac.overdueAmount.toFixed(2)).toBe("12000.00");
    expect(kupac.daysOverdue).toBe(62);
    expect(kupac.level).toBe(3);
    // Dobavljačev avans se NE sabira u kupčev dug (bio bi 512.000).
    expect(kupac.overdueAmount.toFixed(2)).not.toBe("512000.00");
  });

  it("konto bez partner_scope (NULL) se ne opominje — kupac se ne pretpostavlja", async () => {
    const { service } = makeService([BEZ_SCOPE]);
    await expect(service.candidates(AS_OF)).resolves.toEqual([]);
  });

  it("slanje dobavljaču pada na 422 — bez mejla i bez evidencije opomene", async () => {
    const { service, mail, prisma, dunningPdf } = makeService([
      DATI_AVANS_DOBAVLJACU,
      KUPCEVA_FAKTURA,
    ]);

    await expect(service.send({ partnerId: 77 })).rejects.toThrow(
      UnprocessableEntityException,
    );
    expect(mail.send).not.toHaveBeenCalled();
    expect(dunningPdf.buildDunningPdf).not.toHaveBeenCalled();
    expect(prisma.dunningNotice.create).not.toHaveBeenCalled();
  });

  it("slanje kupcu radi kao pre (mejl + upisana opomena)", async () => {
    const { service, mail, created } = makeService([
      DATI_AVANS_DOBAVLJACU,
      KUPCEVA_FAKTURA,
    ]);

    const res = await service.send({ partnerId: 5 });

    expect(res.level).toBe(3);
    expect(res.overdueAmount.toFixed(2)).toBe("12000.00");
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect((created[0].overdueAmount as Prisma.Decimal).toFixed(2)).toBe(
      "12000.00",
    );
  });

  it("masovno slanje preskače dobavljača (nijedan kandidat nije 77)", async () => {
    const { service, mail } = makeService([
      DATI_AVANS_DOBAVLJACU,
      KUPCEVA_FAKTURA,
    ]);

    const res = await service.sendBatch({ asOf: AS_OF });

    expect(res.sent).toBe(1);
    expect(mail.send).toHaveBeenCalledTimes(1);
    const recipients = mail.send.mock.calls.map(
      (c: [{ to: string }]) => c[0].to,
    );
    expect(recipients).toEqual(["komitent5@example.com"]);
  });
});
