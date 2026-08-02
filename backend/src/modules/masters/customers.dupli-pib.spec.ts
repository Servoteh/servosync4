import { MasterCustomersService } from "./customers.service";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * O-7 (odluka vlasnika 30.07.2026): dupli PIB se TOLERIŠE (BigBit ga toleriše,
 * tvrda brana bi obarala uvoz), ali uz TRAJAN SPISAK — da broj pada, a ne da
 * „rešićemo kasnije" ostane zauvek. Na nuli sme tvrda brana.
 */
describe("MasterCustomersService.duplicateTaxIds (O-7)", () => {
  function makeSvc(rows: unknown[]) {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue(rows),
    } as unknown as PrismaService;
    return new MasterCustomersService(prisma);
  }

  it("grupise po PIB-u i drži najveće grupe na vrhu (redosled iz SQL-a se čuva)", async () => {
    const svc = makeSvc([
      { tax_id: "100001378", id: 11, name: "EPS distribucija", city: "Beograd", source: "BIGBIT" },
      { tax_id: "100001378", id: 12, name: "Elektrodistribucija Srbije", city: "Beograd", source: "BIGBIT" },
      { tax_id: "101339568", id: 21, name: "Trelleborg", city: "Ruma", source: "BIGBIT" },
      { tax_id: "101339568", id: 22, name: "Yokohama TWS", city: "Ruma", source: "BIGBIT" },
    ]);
    const res = await svc.duplicateTaxIds();
    expect(res.meta.groups).toBe(2);
    expect(res.meta.customers).toBe(4);
    expect(res.data[0].taxId).toBe("100001378");
    expect(res.data[0].customers.map((c) => c.id)).toEqual([11, 12]);
    // Poruka drži ugovor sa vlasnikom: dok ima duplikata, kaže gde se rešavaju.
    expect(res.meta.note).toContain("BigBit");
  });

  it("prazan spisak eksplicitno kaže da je brana sada bezbedna", async () => {
    const svc = makeSvc([]);
    const res = await svc.duplicateTaxIds();
    expect(res.meta.groups).toBe(0);
    expect(res.meta.note).toContain("tvrda brana");
  });
});
