import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { MasterCustomersService } from "./customers.service";
import { MasterCustomersController } from "./customers.controller";
import { DirectoryController } from "../directory/directory.controller";
import { PERMISSION_KEY_METADATA } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { ROLES } from "../../common/authz/roles";

/**
 * BAZNI SLOJ kartona komitenta — tačno ono što vraća i `directory.service.ts`
 * (CUSTOMER_BUSINESS_SELECT), plus razrešen prodavac. Lista je prepisana ovde
 * namerno: ona je UGOVOR („ovo sme svako sa directory.read"), pa svako širenje
 * baznog sloja mora da obori test i da bude svesna odluka.
 */
const BASE_KEYS = [
  "id",
  "name",
  "shortName",
  "branch",
  "city",
  "address",
  "postalCode",
  "country",
  "taxId",
  "registrationNumber",
  "phone",
  "mobile",
  "fax",
  "email",
  "webAddress",
  "contact",
  "note",
  "salespersonId",
  "salesperson",
  // Talas B — child kolekcije su OPERATIVNE (ko je kontakt, gde se roba vozi),
  // pa su svesno u baznom sloju, uz adresu i telefon.
  "contacts",
  "deliveryLocations",
];

/** Komercijalna/interna polja — ne smeju da postoje u odgovoru bez `masters.read`. */
const COMMERCIAL_KEYS = [
  "bankAccount1",
  "bankAccount2",
  "bankAccount3",
  "paymentAccount",
  "paymentAccountId",
  "customerDiscount",
  "fictitiousDiscount",
  "commissionPercent",
  "manualMarkupPercent",
  "creditLimit",
  "priceListCode",
  "paymentTermDays",
  "paymentMethod",
  "checkDebt",
  "balanceNote",
  "buyerProtectionCode",
  "pantheonId",
  "externalCode",
  "routeId",
  "driverId",
  "gln",
  "publicSectorId",
  "vatStatus",
  "centralInvoiceRegistry",
  "einvoiceXmlPerItemDiscount",
  "createdBy",
  "updatedBy",
  "signature",
] as const;

/** Pun red iz baze — mock ga seče po `select`-u, kao pravi Prisma. */
const CUSTOMER_ROW: Record<string, unknown> = {
  id: 42,
  name: "Servoteh",
  shortName: "SRV",
  branch: "Centrala",
  city: "Kragujevac",
  address: "Kneza Miloša 1",
  postalCode: "34000",
  country: "Srbija",
  taxId: "100123456",
  registrationNumber: "07123456",
  phone: "034/123-456",
  mobile: "064/123-456",
  fax: "034/123-457",
  email: "office@servoteh.com",
  webAddress: "www.servoteh.com",
  contact: "Nenad",
  note: "Interni komitent",
  salespersonId: 5,
  codeTypeCode: "KUPDOB",
  // komercijalne / interne
  bankAccount1: "160-1234-56",
  bankAccount2: null,
  bankAccount3: null,
  paymentAccountId: 3,
  customerDiscount: 5,
  fictitiousDiscount: 0,
  commissionPercent: 2,
  manualMarkupPercent: new Prisma.Decimal("0.0000"),
  creditLimit: new Prisma.Decimal("250000.0000"),
  priceListCode: "VP1",
  paymentTermDays: 45,
  paymentMethod: "virman",
  checkDebt: true,
  balanceNote: "kasni sa plaćanjem",
  buyerProtectionCode: "X",
  pantheonId: "P-42",
  externalCode: "E-42",
  routeId: 0,
  driverId: 0,
  gln: "1234567890123",
  publicSectorId: null,
  vatStatus: 1,
  centralInvoiceRegistry: false,
  einvoiceXmlPerItemDiscount: false,
  createdBy: "nenad",
  updatedBy: "nenad",
  signature: "sig",
};

/** Prisma `select` semantika u mock-u: vrati SAMO tražene ključeve. */
function pickBySelect(
  row: Record<string, unknown>,
  select?: Record<string, boolean>,
): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) if (key in row) out[key] = row[key];
  return out;
}

/** Mock PrismaService — samo modeli koje `MasterCustomersService` čita (+ authz override). */
function prismaMock() {
  return {
    customer: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    salesperson: { findMany: jest.fn().mockResolvedValue([]) },
    codeType: { findMany: jest.fn().mockResolvedValue([]) },
    paymentAccount: { findUnique: jest.fn().mockResolvedValue(null) },
    // Talas B child tabele — na produkciji PRAZNE dok bridge ne odradi prvi
    // prolaz, pa je prazan niz podrazumevano stanje mock-a (kao i u bazi).
    customerContact: { findMany: jest.fn().mockResolvedValue([]) },
    customerDeliveryLocation: { findMany: jest.fn().mockResolvedValue([]) },
    // `resolvePermissionDecision` čita override sveže iz baze na svaki poziv.
    userPermissionOverride: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
}

/** Akter sa `masters.read` kroz rolu (menadzment) i akter bez njega (viewer). */
const KOMERCIJALA = {
  userId: 1,
  role: ROLES.MENADZMENT,
  email: "sef@servoteh.com",
};
const OSNOVNI = { userId: 2, role: ROLES.VIEWER, email: "radnik@servoteh.com" };

describe("MasterCustomersService (matični podaci — Komitenti)", () => {
  let service: MasterCustomersService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        MasterCustomersService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(MasterCustomersService);
  });

  /** Mock koji poštuje `select` (bez njega bi redakcija bila neproverljiva). */
  function mockCustomer(row: Record<string, unknown> | null) {
    prisma.customer.findUnique.mockImplementation(
      (args: { select?: Record<string, boolean> }) =>
        Promise.resolve(row ? pickBySelect(row, args?.select) : null),
    );
  }

  it("list(): pretraga `q` gađa naziv/PIB/mesto, filter codeTypeCode je tačno poklapanje", async () => {
    await service.list({ q: " beograd ", codeTypeCode: "KUP" }, KOMERCIJALA);

    const [args] = prisma.customer.findMany.mock.calls[0] as [
      { where: Prisma.CustomerWhereInput; orderBy: unknown; take: number },
    ];
    expect(args.where.OR).toEqual([
      { name: { contains: "beograd", mode: "insensitive" } },
      { taxId: { contains: "beograd", mode: "insensitive" } },
      { city: { contains: "beograd", mode: "insensitive" } },
    ]);
    expect(args.where.codeTypeCode).toBe("KUP");
    expect(args.orderBy).toEqual([{ name: "asc" }, { id: "asc" }]);
    expect(args.take).toBe(50);
    expect(prisma.customer.count).toHaveBeenCalledWith({ where: args.where });
  });

  it("list(): prodavac i vrsta šifre se razrešavaju batch-om; orphan FK → null, ne 500", async () => {
    prisma.customer.findMany.mockResolvedValue([
      { id: 1, name: "A", salespersonId: 5, codeTypeCode: "KUPDOB" },
      { id: 2, name: "B", salespersonId: 0, codeTypeCode: "KUPDOB" },
      { id: 3, name: "C", salespersonId: 99, codeTypeCode: "XX" },
    ]);
    prisma.customer.count.mockResolvedValue(3);
    // `salesperson_id = 0` je legacy „nije zadat"; 99 je orphan (nema reda).
    prisma.salesperson.findMany.mockResolvedValue([
      { id: 5, name: "Petrović", firstName: "Ana" },
    ]);
    prisma.codeType.findMany.mockResolvedValue([
      { code: "KUPDOB", description: "Kupac i dobavljač" },
    ]);

    const res = await service.list({}, KOMERCIJALA);

    expect(prisma.salesperson.findMany).toHaveBeenCalledWith({
      where: { id: { in: [5, 99] } },
      select: { id: true, name: true, firstName: true },
    });
    expect(res.data.map((r) => r.salesperson)).toEqual([
      { id: 5, name: "Petrović", firstName: "Ana" },
      null,
      null,
    ]);
    expect(res.data.map((r) => r.codeType)).toEqual([
      { code: "KUPDOB", description: "Kupac i dobavljač" },
      { code: "KUPDOB", description: "Kupac i dobavljač" },
      { code: "XX", description: null },
    ]);
  });

  it("findOne(): nepostojeći komitent je 404, ne 500 (oba sloja)", async () => {
    mockCustomer(null);
    await expect(service.findOne(999, KOMERCIJALA)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.findOne(999, OSNOVNI)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ============================================ dvoslojni odgovor (masters.read)

  describe("dvoslojni odgovor — komercijalna polja traže masters.read", () => {
    it("findOne() SA masters.read: pun karton, Decimal kao string, uplatni račun razrešen", async () => {
      mockCustomer(CUSTOMER_ROW);
      prisma.salesperson.findMany.mockResolvedValue([
        { id: 5, name: "Petrović", firstName: "Ana" },
      ]);
      prisma.codeType.findMany.mockResolvedValue([
        { code: "KUPDOB", description: "Kupac i dobavljač" },
      ]);
      prisma.paymentAccount.findUnique.mockResolvedValue({
        id: 3,
        accountNumber: "160-1234-56",
        bankName: "Banca Intesa",
        bankCode: "160",
        countryCode: "RS",
      });

      const { data, meta } = await service.findOne(42, KOMERCIJALA);

      expect(meta.restricted).toBe(false);
      expect(data).toHaveProperty("creditLimit", "250000");
      expect(data).toHaveProperty("manualMarkupPercent", "0");
      expect(data).toHaveProperty("bankAccount1", "160-1234-56");
      expect(data).toHaveProperty("checkDebt", true);
      expect(data.salesperson).toEqual({
        id: 5,
        name: "Petrović",
        firstName: "Ana",
      });
      expect(data).toHaveProperty("codeType", {
        code: "KUPDOB",
        description: "Kupac i dobavljač",
      });
      expect(data).toHaveProperty(
        "paymentAccount.accountNumber",
        "160-1234-56",
      );
    });

    it("findOne() SA masters.read: paymentAccountId = 0 (legacy „nije zadat“) ne ide u bazu", async () => {
      mockCustomer({
        ...CUSTOMER_ROW,
        salespersonId: 0,
        codeTypeCode: null,
        paymentAccountId: 0,
        creditLimit: null,
        manualMarkupPercent: null,
      });

      const { data } = await service.findOne(42, KOMERCIJALA);

      expect(prisma.paymentAccount.findUnique).not.toHaveBeenCalled();
      expect(data).toHaveProperty("paymentAccount", null);
      expect(data).toHaveProperty("codeType", null);
      expect(data).toHaveProperty("creditLimit", null);
    });

    it("findOne() BEZ masters.read: odgovor je TAČNO bezbedan podskup (paritet directory pregleda)", async () => {
      mockCustomer(CUSTOMER_ROW);
      prisma.salesperson.findMany.mockResolvedValue([
        { id: 5, name: "Petrović", firstName: "Ana" },
      ]);

      const { data, meta } = await service.findOne(42, OSNOVNI);

      expect(meta.restricted).toBe(true);
      expect(Object.keys(data).sort()).toEqual([...BASE_KEYS].sort());
      for (const key of COMMERCIAL_KEYS) expect(data).not.toHaveProperty(key);
      // Bezbedna polja i dalje stižu, uključujući razrešeno ime prodavca.
      expect(data.name).toBe("Servoteh");
      expect(data.taxId).toBe("100123456");
      expect(data.salesperson).toEqual({
        id: 5,
        name: "Petrović",
        firstName: "Ana",
      });
    });

    it("findOne() BEZ masters.read: komercijalne kolone se i NE TRAŽE od baze, uplatni račun se ne čita", async () => {
      mockCustomer(CUSTOMER_ROW);

      await service.findOne(42, OSNOVNI);

      const [args] = prisma.customer.findUnique.mock.calls[0] as [
        { select: Record<string, boolean> },
      ];
      for (const key of COMMERCIAL_KEYS) {
        expect(Object.keys(args.select)).not.toContain(key);
      }
      expect(prisma.paymentAccount.findUnique).not.toHaveBeenCalled();
    });

    it("list(): meta.restricted prati sloj (lista sama ne nosi komercijalne kolone)", async () => {
      prisma.customer.findMany.mockResolvedValue([
        { id: 1, name: "A", salespersonId: 0, codeTypeCode: "KUPDOB" },
      ]);
      prisma.customer.count.mockResolvedValue(1);

      expect((await service.list({}, KOMERCIJALA)).meta.restricted).toBe(false);
      expect((await service.list({}, OSNOVNI)).meta.restricted).toBe(true);
    });

    it("GRANT override otvara pun karton ulozi koja ga nema po roli", async () => {
      prisma.userPermissionOverride.findUnique.mockResolvedValue({
        allow: true,
      });
      mockCustomer(CUSTOMER_ROW);

      const { data, meta } = await service.findOne(42, OSNOVNI);

      expect(prisma.userPermissionOverride.findUnique).toHaveBeenCalledWith({
        where: { userId_key: { userId: 2, key: PERMISSIONS.MASTERS_READ } },
        select: { allow: true },
      });
      expect(meta.restricted).toBe(false);
      expect(data).toHaveProperty("creditLimit", "250000");
    });

    it("DENY override vraća bazni sloj i ulozi koja ima masters.read po roli (deny > rola)", async () => {
      prisma.userPermissionOverride.findUnique.mockResolvedValue({
        allow: false,
      });
      mockCustomer(CUSTOMER_ROW);

      const { data, meta } = await service.findOne(42, KOMERCIJALA);

      expect(meta.restricted).toBe(true);
      for (const key of COMMERCIAL_KEYS) expect(data).not.toHaveProperty(key);
    });

    it("bez aktera (zahtev bez identiteta) pada na bazni sloj — fail-closed", async () => {
      mockCustomer(CUSTOMER_ROW);

      const { data, meta } = await service.findOne(42, undefined);

      expect(meta.restricted).toBe(true);
      for (const key of COMMERCIAL_KEYS) expect(data).not.toHaveProperty(key);
      expect(prisma.userPermissionOverride.findUnique).not.toHaveBeenCalled();
    });
  });

  // ================================ child kolekcije iz BigBit `.mdb`-a (Talas B)

  describe("child kolekcije — kontakt osobe i mesta isporuke", () => {
    const KONTAKTI = [
      {
        id: 2,
        contactPerson: "Marko Marković",
        phone: "011/111-111",
        mobile: null,
        fax: null,
        email: "marko@kupac.rs",
        isDefault: true,
      },
      {
        id: 7,
        contactPerson: "Jelena Jelić",
        phone: null,
        mobile: "064/222-222",
        fax: null,
        email: null,
        isDefault: false,
      },
    ];
    const LOKACIJE = [
      {
        id: 11,
        name: "Magacin 2",
        city: "Novi Sad",
        address: "Bulevar 5",
        postalCode: "21000",
        phone: null,
        fax: null,
        area: "Vojvodina",
        gln: "9876543210987",
        active: true,
        locationNumber: "MS-02",
      },
    ];

    it("prazne tabele (bridge još nije prošao) daju prazne nizove, ne izuzetak", async () => {
      mockCustomer(CUSTOMER_ROW);

      const bazni = await service.findOne(42, OSNOVNI);
      const pun = await service.findOne(42, KOMERCIJALA);

      expect(bazni.data.contacts).toEqual([]);
      expect(bazni.data.deliveryLocations).toEqual([]);
      expect(pun.data.contacts).toEqual([]);
      expect(pun.data.deliveryLocations).toEqual([]);
    });

    it("kolekcije stižu i u BAZNOM sloju (operativni podaci, ne finansijska tajna)", async () => {
      mockCustomer(CUSTOMER_ROW);
      prisma.customerContact.findMany.mockResolvedValue(KONTAKTI);
      prisma.customerDeliveryLocation.findMany.mockResolvedValue(LOKACIJE);

      const { data, meta } = await service.findOne(42, OSNOVNI);

      expect(meta.restricted).toBe(true);
      expect(data.contacts).toEqual(KONTAKTI);
      expect(data.deliveryLocations).toEqual(LOKACIJE);
      // …ali komercijalni sloj i dalje NIJE procurio uz njih.
      for (const key of COMMERCIAL_KEYS) expect(data).not.toHaveProperty(key);
    });

    it("veza je customer_id = customers.id (PK komitenta se NE remapira); podrazumevani kontakt i aktivna lokacija idu prvi", async () => {
      mockCustomer(CUSTOMER_ROW);

      await service.findOne(42, KOMERCIJALA);

      const [kontakti] = prisma.customerContact.findMany.mock.calls[0] as [
        { where: { customerId: number }; orderBy: unknown },
      ];
      expect(kontakti.where).toEqual({ customerId: 42 });
      expect(kontakti.orderBy).toEqual([{ isDefault: "desc" }, { id: "asc" }]);

      const [lokacije] = prisma.customerDeliveryLocation.findMany.mock
        .calls[0] as [{ where: { customerId: number }; orderBy: unknown }];
      expect(lokacije.where).toEqual({ customerId: 42 });
      expect(lokacije.orderBy).toEqual([
        { active: "desc" },
        { name: "asc" },
        { id: "asc" },
      ]);
    });

    it("select mesta isporuke NE nosi komercijalna zaduženja lokacije (fail-closed)", async () => {
      mockCustomer(CUSTOMER_ROW);

      await service.findOne(42, KOMERCIJALA);

      const [lokacije] = prisma.customerDeliveryLocation.findMany.mock
        .calls[0] as [{ select: Record<string, boolean> }];
      for (const key of [
        "salespersonId",
        "paymentAccountId",
        "routeId",
        "driverId",
        "contractCategory",
        "generalCategory",
        "salesChannel",
      ]) {
        expect(Object.keys(lokacije.select)).not.toContain(key);
      }
      // GLN po lokaciji JESTE tu — SEF ga traži (BIGBIT_KOMITENTI.md §2.2).
      expect(Object.keys(lokacije.select)).toContain("gln");
    });

    it("kontakt osoba ne odaje datum rođenja (lični podatak; Customer.birthDate je komercijalni sloj)", async () => {
      mockCustomer(CUSTOMER_ROW);

      await service.findOne(42, KOMERCIJALA);

      const [kontakti] = prisma.customerContact.findMany.mock.calls[0] as [
        { select: Record<string, boolean> },
      ];
      expect(Object.keys(kontakti.select)).not.toContain("birthDate");
    });
  });
});

// ================================================================ Guard

describe("MasterCustomersController — permisija", () => {
  it("klasa je iza `directory.read` — istog ključa kao DirectoryController", () => {
    expect(
      Reflect.getMetadata(PERMISSION_KEY_METADATA, MasterCustomersController),
    ).toBe(PERMISSIONS.DIRECTORY_READ);
    expect(
      Reflect.getMetadata(PERMISSION_KEY_METADATA, MasterCustomersController),
    ).toBe(Reflect.getMetadata(PERMISSION_KEY_METADATA, DirectoryController));
  });

  it("nijedna GET ruta nema svoj (širi) ključ — sve nasleđuju klasni", () => {
    for (const name of ["list", "findOne"]) {
      const handler = Object.getOwnPropertyDescriptor(
        MasterCustomersController.prototype,
        name,
      )?.value as object;
      expect(
        Reflect.getMetadata(PERMISSION_KEY_METADATA, handler),
      ).toBeUndefined();
    }
  });

  /**
   * Kapija OSTAJE široka (`directory.read`) — `masters.read` NE sme da procuri na
   * rutu, inače bi bazni sloj (koji svako sme da vidi) postao 403.
   */
  it("ruta NIJE iza `masters.read` — taj ključ bira sloj kolona, ne pristup", () => {
    expect(
      Reflect.getMetadata(PERMISSION_KEY_METADATA, MasterCustomersController),
    ).not.toBe(PERMISSIONS.MASTERS_READ);
  });
});
