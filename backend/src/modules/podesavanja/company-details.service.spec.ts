import { UnprocessableEntityException } from "@nestjs/common";
import type { PrismaService } from "../../prisma/prisma.service";
import { CompanyDetailsService } from "./company-details.service";

/**
 * MATIČNI PODACI FIRME — poštanski broj kao ZASEBNO polje (odluka O-F10, 03.08.2026).
 *
 * Zašto baš ovo: dok je poštanski broj bio deo `companies.city` („11272 Dobanovci"),
 * knjigovođa ga nije mogao razdvojiti ni da hoće — a štampa je onda morala da ga nosi i
 * tamo gde ga original nema (potpisni blok fakture, adresa magacina). Kolona bez ekrana
 * bi bila isto što i ranije: podatak koji niko ne može da unese.
 */
describe("CompanyDetailsService — poštanski broj (O-F10)", () => {
  const ROW = {
    id: 1,
    companyName: "Servoteh d.o.o.",
    address: "Ugrinovačka 163",
    city: "Dobanovci",
    postalCode: "11272",
    municipality: null,
    phone: null,
    fax: null,
    email: null,
    webAddress: null,
    taxId: "101017443",
    registrationNumber: "17400169",
    businessActivity: null,
    businessActivityCode: null,
    bankAccount: null,
    iban: null,
    swift: null,
    owner: null,
    invoiceIssuingPlace: "Beograd",
    footerText: null,
  };

  function makeService(update = jest.fn(() => Promise.resolve(ROW))) {
    const prisma = {
      company: {
        findFirst: jest.fn(() => Promise.resolve(ROW)),
        findUnique: jest.fn(() => Promise.resolve(ROW)),
        update,
      },
    };
    return {
      service: new CompanyDetailsService(prisma as unknown as PrismaService),
      prisma,
    };
  }

  it("ekran čita poštanski broj kao svoje polje, odvojeno od mesta", async () => {
    const { service, prisma } = makeService();
    const res = await service.get();
    expect(res.data.postalCode).toBe("11272");
    expect(res.data.city).toBe("Dobanovci");
    // Ne veruje se lažnom redu: kolona mora biti i u `select`-u, inače bi ekran
    // prikazivao prazno polje i tiho ga brisao pri prvom snimanju.
    const [args] = prisma.company.findFirst.mock.calls[0] as unknown as [
      { select: Record<string, boolean> },
    ];
    expect(args.select.postalCode).toBe(true);
  });

  it("upisuje poštanski broj (bez njega bi kolona ostala bez ijednog pisca)", async () => {
    const update = jest.fn(() => Promise.resolve(ROW));
    const { service, prisma } = makeService(update);
    await service.update(null, { postalCode: " 11272 " });
    expect(prisma.company.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        // Razmaci se skidaju; mesto se NE dira uz izmenu poštanskog broja.
        data: { postalCode: "11272" },
      }),
    );
  });

  it("prazan unos briše poštanski broj umesto da upiše prazan string", async () => {
    const update = jest.fn(() => Promise.resolve(ROW));
    const { service, prisma } = makeService(update);
    await service.update(null, { postalCode: "" });
    expect(prisma.company.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { postalCode: null } }),
    );
  });

  it("predugačak unos vraća srpsku poruku sa natpisom sa EKRANA, ne sa imenom polja", async () => {
    const { service } = makeService();
    await expect(
      service.update(null, { postalCode: "11272-12345" }),
    ).rejects.toThrow(UnprocessableEntityException);
    await expect(
      service.update(null, { postalCode: "11272-12345" }),
    ).rejects.toThrow(/Poštanski broj/);
  });
});
