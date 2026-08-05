import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../../prisma/prisma.service";
import { ServiceRevenueTypeService } from "./service-revenue-type.service";
import { TAX_TREATMENTS } from "./service-revenue-type";

/**
 * UREĐIVANJE ŠIFARNIKA VRSTA USLUGE (nalaz P10, ekran u Podešavanjima).
 * =============================================================================
 * Do 05.08.2026. se šifarnik menjao ISKLJUČIVO SQL-om nad produkcijom. Otvaranje ekrana
 * znači da vrednosti od sada unosi čovek — pa dve tvrdnje koje jedan red nosi moraju da
 * budu branjene na ulazu, a ne da se otkriju kad knjiženje padne:
 *
 *  1. PORESKI TRETMAN je izbor sa liste. Greška u kucanju („REVERSE-CHARGE") bi tiho
 *     pala na `TAXED` da nema brane, pa bi faktura za otpad izašla sa 20 % PDV-a koji
 *     po zakonu obračunava KUPAC (čl. 10 st. 2 t. 1) — dokument koji uredno balansira i
 *     koji nijedna kontrola ne bi prijavila.
 *  2. KONTO PRIHODA mora da postoji. Kolona je meki ref (bez FK — kontni plan sme da se
 *     pregrupiše), pa bi „6104" umesto „6140" prošlo, a izašlo tek pri knjiženju fakture
 *     — dakle kod komercijale, a ne kod onoga ko je grešku napravio.
 *
 * Uz to: trag izmene (ko, kad, sa čega na šta) i to da se ŠIFRA ne preimenuje.
 */

const POSTOJECA = {
  id: 3,
  code: "OTPAD",
  name: "Prodaja otpada",
  revenueAccountCode: "6796",
  vatTreatment: "REVERSE_CHARGE",
  paperNote: "Poreski dužnik je primalac (čl. 10 st. 2 t. 1 ZPDV).",
  isActive: true,
  sortOrder: 30,
  createdAt: new Date("2026-08-05T19:00:00Z"),
  updatedAt: new Date("2026-08-05T19:00:00Z"),
};

/** Kontni plan koji „postoji" u testu — sve van ovoga se odbija. */
const KONTA: Record<string, string> = {
  "6140": "Prihodi od usluga na domaćem tržištu",
  "6151": "Prihodi od usluga inostranstvu",
  "6796": "Ostali nepomenuti prihodi",
  "6501": "Prihodi od zakupnina",
};

function makePrisma(
  seed: { row?: typeof POSTOJECA | null; createThrows?: Error } = {},
) {
  const audit: Array<Record<string, unknown>> = [];
  const row = seed.row === undefined ? POSTOJECA : seed.row;

  const tx = {
    serviceRevenueType: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        if (seed.createThrows) return Promise.reject(seed.createThrows);
        return Promise.resolve({ id: 9, ...args.data });
      }),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...row, ...args.data }),
      ),
    },
    auditLog: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        audit.push(args.data);
        return Promise.resolve(args.data);
      }),
    },
  };

  const prisma = {
    serviceRevenueType: {
      // Argument se prima (i samo zabeleži) da bi test mogao da PROVERI da `listAll`
      // ne šalje `where` — razlika između „ceo šifarnik" i „samo aktivne".
      findMany: jest.fn((args?: Record<string, unknown>) => {
        void args;
        return Promise.resolve(row ? [row] : []);
      }),
      findUnique: jest.fn(() => Promise.resolve(row)),
    },
    account: {
      findMany: jest.fn(() =>
        Promise.resolve(
          Object.entries(KONTA).map(([code, name]) => ({ code, name })),
        ),
      ),
      findUnique: jest.fn((args: { where: { code: string } }) =>
        Promise.resolve(
          KONTA[args.where.code]
            ? { code: args.where.code, name: KONTA[args.where.code] }
            : null,
        ),
      ),
    },
    // `groupBy` je tipizovan eksplicitno: bez toga bi `jest.fn(() => Promise.resolve([]))`
    // dao `any[]` i test koji mu kasnije podmeće brojač računa ne bi bio proveren tipom.
    invoice: {
      groupBy: jest.fn(
        (): Promise<
          Array<{
            serviceRevenueTypeId: number | null;
            _count: { _all: number };
          }>
        > => Promise.resolve([]),
      ),
    },
    auditLog: { findMany: jest.fn(() => Promise.resolve([])) },
    $transaction: jest.fn(
      async (fn: (t: typeof tx) => Promise<unknown>) => await fn(tx),
    ),
  };

  return { prisma, tx, audit };
}

function makeService(prisma: ReturnType<typeof makePrisma>["prisma"]) {
  return new ServiceRevenueTypeService(prisma as unknown as PrismaService);
}

const ADMIN = { userId: 1, email: "admin@servoteh.com" };
const VALIDNA = {
  code: "PREVOZ",
  name: "Usluge prevoza",
  revenueAccountCode: "6140",
  vatTreatment: "TAXED",
};

describe("ServiceRevenueTypeService — uređivanje šifarnika (P10)", () => {
  describe("brana: poreski tretman je izbor sa liste", () => {
    it("prihvata sva tri dozvoljena tretmana", async () => {
      for (const t of TAX_TREATMENTS) {
        const { prisma } = makePrisma();
        await expect(
          makeService(prisma).create(ADMIN, { ...VALIDNA, vatTreatment: t }),
        ).resolves.toMatchObject({ vatTreatment: t });
      }
    });

    it("🔴 odbija vrednost van liste (greška u kucanju ne sme da padne na TAXED)", async () => {
      const { prisma, tx } = makePrisma();
      await expect(
        makeService(prisma).create(ADMIN, {
          ...VALIDNA,
          vatTreatment: "REVERSE-CHARGE", // crtica umesto donje crte
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(tx.serviceRevenueType.create).not.toHaveBeenCalled();
    });

    it("poruka objašnjava sva tri tretmana, ne samo da je vrednost pogrešna", async () => {
      const { prisma } = makePrisma();
      await expect(
        makeService(prisma).create(ADMIN, {
          ...VALIDNA,
          vatTreatment: "NEPOSTOJI",
        }),
      ).rejects.toThrow(/REVERSE_CHARGE.*OUTSIDE_SCOPE/s);
    });

    it("mala slova se normalizuju (`taxed` → `TAXED`), ne odbijaju", async () => {
      const { prisma } = makePrisma();
      await expect(
        makeService(prisma).create(ADMIN, {
          ...VALIDNA,
          vatTreatment: "taxed",
        }),
      ).resolves.toMatchObject({ vatTreatment: "TAXED" });
    });
  });

  describe("brana: konto prihoda mora da postoji u kontnom planu", () => {
    it("🔴 nepostojeći konto se odbija SA OBJAŠNJENJEM, ne upisuje tiho", async () => {
      const { prisma, tx } = makePrisma();
      await expect(
        makeService(prisma).create(ADMIN, {
          ...VALIDNA,
          revenueAccountCode: "6104", // zamenjene cifre — tipična greška
        }),
      ).rejects.toThrow(/6104.*ne postoji u kontnom planu/s);
      expect(tx.serviceRevenueType.create).not.toHaveBeenCalled();
    });

    it("poruka nabraja potvrđena konta (da čovek ne mora da traži)", async () => {
      const { prisma } = makePrisma();
      await expect(
        makeService(prisma).create(ADMIN, {
          ...VALIDNA,
          revenueAccountCode: "9999",
        }),
      ).rejects.toThrow(/6140.*6151.*6796.*6501/s);
    });

    it("postojeći konto prolazi i upisuje se kanonski", async () => {
      const { prisma } = makePrisma();
      await expect(
        makeService(prisma).create(ADMIN, {
          ...VALIDNA,
          revenueAccountCode: " 6151 ",
        }),
      ).resolves.toMatchObject({ revenueAccountCode: "6151" });
    });

    it("ista brana važi i pri IZMENI, ne samo pri unosu", async () => {
      const { prisma, tx } = makePrisma();
      await expect(
        makeService(prisma).update(ADMIN, 3, { revenueAccountCode: "6104" }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(tx.serviceRevenueType.update).not.toHaveBeenCalled();
    });
  });

  describe("šifra", () => {
    it("normalizuje se na velika slova — `usl` i `USL` nisu dve vrste", async () => {
      const { prisma } = makePrisma();
      await expect(
        makeService(prisma).create(ADMIN, { ...VALIDNA, code: "prevoz" }),
      ).resolves.toMatchObject({ code: "PREVOZ" });
    });

    it("odbija nedozvoljene znakove", async () => {
      const { prisma } = makePrisma();
      await expect(
        makeService(prisma).create(ADMIN, { ...VALIDNA, code: "USL USL" }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("duplikat je 409 sa uputstvom da je vrsta možda UGAŠENA", async () => {
      // Ugašen red i dalje zauzima šifru (ne briše se — za njega su vezani računi), pa
      // je to najčešći uzrok; bez toga korisnik proba još tri puta.
      const { prisma } = makePrisma({
        createThrows: new Prisma.PrismaClientKnownRequestError("dup", {
          code: "P2002",
          clientVersion: "6.19.3",
        }),
      });
      await expect(
        makeService(prisma).create(ADMIN, VALIDNA),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(makeService(prisma).create(ADMIN, VALIDNA)).rejects.toThrow(
        /UGAŠENA/,
      );
    });

    it("🔴 postojeća šifra se NE preimenuje (program poznaje `USL` po imenu)", async () => {
      const { prisma, tx } = makePrisma();
      await expect(
        makeService(prisma).update(ADMIN, 3, { code: "OTPAD-NOVI" }),
      ).rejects.toThrow(/ne menja/);
      expect(tx.serviceRevenueType.update).not.toHaveBeenCalled();
    });

    it("ista šifra poslata uz izmenu NE smeta (ekran šalje celu formu)", async () => {
      const { prisma } = makePrisma();
      await expect(
        makeService(prisma).update(ADMIN, 3, {
          code: "OTPAD",
          name: "Prodaja sekundarnih sirovina",
        }),
      ).resolves.toMatchObject({ name: "Prodaja sekundarnih sirovina" });
    });
  });

  describe("izmena", () => {
    it("nepostojeći red je 404", async () => {
      const { prisma } = makePrisma({ row: null });
      await expect(
        makeService(prisma).update(ADMIN, 77, { name: "X" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("polje koje nije poslato se NE dira", async () => {
      const { prisma, tx } = makePrisma();
      await makeService(prisma).update(ADMIN, 3, { sortOrder: 5 });
      expect(tx.serviceRevenueType.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { sortOrder: 5 } }),
      );
    });

    it("prazna napomena se svodi na `null` (papir pada na rezervni tekst)", async () => {
      const { prisma, tx } = makePrisma();
      await makeService(prisma).update(ADMIN, 3, { paperNote: "   " });
      expect(tx.serviceRevenueType.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { paperNote: null } }),
      );
    });

    it("gašenje je izmena `isActive`, ne brisanje reda", async () => {
      const { prisma, tx } = makePrisma();
      await makeService(prisma).update(ADMIN, 3, { isActive: false });
      expect(tx.serviceRevenueType.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isActive: false } }),
      );
    });

    it(`prazno telo je 422 — bez tihog „ništa se nije desilo"`, async () => {
      const { prisma } = makePrisma();
      await expect(makeService(prisma).update(ADMIN, 3, {})).rejects.toThrow(
        /Nijedno polje/,
      );
    });
  });

  describe("trag izmene", () => {
    it("upisuje KO, KAD i SA ČEGA NA ŠTA — u istoj transakciji", async () => {
      const { prisma, audit } = makePrisma();
      await makeService(prisma).update(
        { userId: 65, email: "jelena.stanisic@servoteh.com" },
        3,
        { revenueAccountCode: "6501" },
      );

      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorUserId: 65,
        actorUsername: "jelena.stanisic@servoteh.com",
        action: "UPDATE",
        entityType: "service_revenue_types",
        entityId: "3",
      });
      expect(audit[0].beforeData).toMatchObject({ revenueAccountCode: "6796" });
      expect(audit[0].afterData).toMatchObject({ revenueAccountCode: "6501" });
      // `changes` drži SAMO ono što se stvarno promenilo — trag mora da se čita u jednom pogledu.
      expect(
        (audit[0].metadata as { changes: Record<string, unknown> }).changes,
      ).toEqual({ revenueAccountCode: { from: "6796", to: "6501" } });
    });

    it(`kreiranje ostavlja trag bez „before" strane`, async () => {
      const { prisma, audit } = makePrisma();
      await makeService(prisma).create(ADMIN, VALIDNA);
      expect(audit[0]).toMatchObject({
        action: "CREATE",
        entityType: "service_revenue_types",
      });
      expect(audit[0].beforeData).toBe(Prisma.DbNull);
    });
  });

  describe("pregled za ekran", () => {
    it("vraća i UGAŠENE vrste — inače bi ekran tvrdio da vrsta ne postoji", async () => {
      const { prisma } = makePrisma({
        row: { ...POSTOJECA, isActive: false },
      });
      const rows = await makeService(prisma).listAll();
      expect(rows).toHaveLength(1);
      expect(rows[0].isActive).toBe(false);
      // Ekran traži CEO šifarnik — bez `where`. (`listActive`, koji puni padajuću listu
      // na računu, i dalje filtrira po `isActive`: gašenje deluje unapred, ne unazad.)
      const [args] = prisma.serviceRevenueType.findMany.mock.calls[0];
      expect(args).not.toHaveProperty("where");
    });

    it("uz vrstu ide naziv konta i broj računa koji je koriste", async () => {
      const { prisma } = makePrisma();
      prisma.invoice.groupBy = jest.fn(() =>
        Promise.resolve([{ serviceRevenueTypeId: 3, _count: { _all: 10 } }]),
      );
      const rows = await makeService(prisma).listAll();
      expect(rows[0].revenueAccountName).toBe("Ostali nepomenuti prihodi");
      expect(rows[0].usedByInvoices).toBe(10);
    });

    it("nepostojeći konto na zatečenom redu se vidi kao prazan naziv, ne ruši ekran", async () => {
      // Redovi uneti SQL-om pre nego što je ekran postojao mogu imati konto van plana.
      const { prisma } = makePrisma({
        row: { ...POSTOJECA, revenueAccountCode: "9999" },
      });
      const rows = await makeService(prisma).listAll();
      expect(rows[0].revenueAccountName).toBeNull();
    });

    it("dozvoljeni tretmani se nude iz JEDNOG izvora (ne prekucani)", () => {
      const { prisma } = makePrisma();
      expect(makeService(prisma).taxTreatments().sort()).toEqual(
        [...TAX_TREATMENTS].sort(),
      );
    });
  });
});
