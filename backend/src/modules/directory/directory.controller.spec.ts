import { ConflictException } from "@nestjs/common";
import { DirectoryController } from "./directory.controller";
import type { DirectoryService } from "./directory.service";

/**
 * ODLUKA VLASNIKA 26.07.2026 — komitenti i predmeti se čitaju samo iz BigBit-a.
 *
 * Test dokazuje oba smera:
 *   • svaki pokušaj upisa je odbijen porukom koja kaže GDE se podatak unosi,
 *   • čitanje i pretraga i dalje rade (regresija — gašenje ne sme da obori liste).
 */
describe("DirectoryController — BigBit je vlasnik komitenata i predmeta", () => {
  function setup() {
    const service = {
      listCustomers: jest.fn().mockResolvedValue({ data: [], meta: {} }),
      findCustomer: jest.fn().mockResolvedValue({ data: { id: 1 } }),
      listProjects: jest.fn().mockResolvedValue({ data: [], meta: {} }),
      findProject: jest.fn().mockResolvedValue({ data: { id: 2 } }),
    } as unknown as DirectoryService;
    return { service, controller: new DirectoryController(service) };
  }

  /** Vrati telo odgovora poslovne greške (isto ono što filter prosleđuje klijentu). */
  function bodyOf(fn: () => unknown): Record<string, unknown> {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      return (e as ConflictException).getResponse() as Record<string, unknown>;
    }
    throw new Error("Očekivana greška nije bačena — upis NIJE zatvoren!");
  }

  const writeRoutes: Array<
    [string, (c: DirectoryController) => unknown, RegExp]
  > = [
    ["POST customers", (c) => c.createCustomer(), /Komitente vodi BigBit/],
    ["PATCH customers/:id", (c) => c.updateCustomer(), /Komitente vodi BigBit/],
    [
      "POST projects",
      (c) => c.createProject(),
      /Predmete i brojeve predmeta vodi BigBit/,
    ],
    [
      "PATCH projects/:id",
      (c) => c.updateProject(),
      /Predmete i brojeve predmeta vodi BigBit/,
    ],
  ];

  it.each(writeRoutes)(
    "%s je odbijen sa 409 i uputstvom",
    (_name, call, expected) => {
      const { controller } = setup();
      const body = bodyOf(() => call(controller));

      expect(body.statusCode).toBe(409);
      expect(body.code).toBe("BIGBIT_OWNED_READ_ONLY");
      expect(String(body.message)).toMatch(expected);
      // Poruka mora reći ŠTA DA RADI, ne samo „ne može".
      expect(String(body.message)).toMatch(
        /unesite u BigBit|Otvorite predmet u BigBit-u/,
      );
      // Poruka mora imenovati KO pokreće uvoz — šifarnički sync NIJE zakazan,
      // pa „stiže sledećim uvozom" ostavlja korisnika da čeka proces koji ne postoji.
      expect(String(body.message)).toMatch(/administratoru da pokrene uvoz/);
    },
  );

  it("nijedan pokušaj upisa ne dodiruje servis (nema tihog upisa)", () => {
    const { controller, service } = setup();
    for (const [, call] of writeRoutes) {
      expect(() => call(controller)).toThrow(ConflictException);
    }
    for (const fn of Object.values(
      service as unknown as Record<string, jest.Mock>,
    )) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("čitanje i pretraga i dalje rade", async () => {
    const { controller, service } = setup();
    const mocks = service as unknown as Record<string, jest.Mock>;

    await controller.listCustomers({ q: "servo" });
    await controller.findCustomer(1);
    await controller.listProjects({ q: "123" });
    await controller.findProject(2);

    expect(mocks.listCustomers).toHaveBeenCalledWith({ q: "servo" });
    expect(mocks.findCustomer).toHaveBeenCalledWith(1);
    expect(mocks.listProjects).toHaveBeenCalledWith({ q: "123" });
    expect(mocks.findProject).toHaveBeenCalledWith(2);
  });
});
