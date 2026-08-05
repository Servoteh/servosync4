import { UnprocessableEntityException } from "@nestjs/common";
import { SastanciSamouslugaService } from "./sastanci-samousluga.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * Prepis sy15 DEFINER funkcija u NestJS — pin za PARITET sa PL/pgSQL izvorom.
 * Ovi testovi štite pravila koja su u sy15 bila u telu funkcije, a sad su u kodu:
 * poklapanje po mejlu, uži skup statusa, i brisanje potpisa zatvaranja.
 */
describe("SastanciSamouslugaService (prepis DEFINER logike)", () => {
  const makePrisma = () => {
    const sastanakUcesnik = {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const akcionaTacka = {
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    };
    const sastanciNotificationPrefs = {
      upsert: jest.fn().mockResolvedValue({ email: "a@b.c" }),
    };
    const prisma = {
      sastanakUcesnik,
      akcionaTacka,
      sastanciNotificationPrefs,
    } as unknown as PrismaService;
    return { prisma, sastanakUcesnik, akcionaTacka, sastanciNotificationPrefs };
  };

  // --- sastanci_set_my_rsvp -------------------------------------------------

  it("RSVP: prazan mejl u sesiji je greška (paritet 'nedostaje email u sesiji')", async () => {
    const { prisma } = makePrisma();
    const svc = new SastanciSamouslugaService(prisma);
    await expect(svc.setMyRsvp("   ", "s1", "dolazim")).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it("RSVP: nevažeći status pada pre ijednog upisa", async () => {
    const { prisma, sastanakUcesnik } = makePrisma();
    const svc = new SastanciSamouslugaService(prisma);
    await expect(
      svc.setMyRsvp("a@b.c", "s1", "mozda"),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(sastanakUcesnik.updateMany).not.toHaveBeenCalled();
  });

  it("RSVP: kad korisnik nije učesnik vraća 'not_participant' (ne baca)", async () => {
    const { prisma, sastanakUcesnik } = makePrisma();
    sastanakUcesnik.findMany.mockResolvedValue([]);
    const svc = new SastanciSamouslugaService(prisma);
    await expect(svc.setMyRsvp("a@b.c", "s1", "dolazim")).resolves.toBe(
      "not_participant",
    );
    expect(sastanakUcesnik.updateMany).not.toHaveBeenCalled();
  });

  it("RSVP: mejl se poredi case-insensitive (paritet lower(email))", async () => {
    const { prisma, sastanakUcesnik } = makePrisma();
    sastanakUcesnik.findMany.mockResolvedValue([{ email: "A@B.C" }]);
    const svc = new SastanciSamouslugaService(prisma);
    await svc.setMyRsvp("  A@B.C  ", "s1", "dolazim");
    expect(sastanakUcesnik.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          email: { equals: "a@b.c", mode: "insensitive" },
        }),
      }),
    );
  });

  it("RSVP: null briše odgovor i vraća 'cleared'", async () => {
    const { prisma, sastanakUcesnik } = makePrisma();
    sastanakUcesnik.findMany.mockResolvedValue([{ email: "a@b.c" }]);
    const svc = new SastanciSamouslugaService(prisma);
    await expect(svc.setMyRsvp("a@b.c", "s1", null)).resolves.toBe("cleared");
    expect(sastanakUcesnik.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ rsvpStatus: null }),
      }),
    );
  });

  // --- sastanci_set_my_priprema --------------------------------------------

  it("Priprema: null argument NE dira polje (paritet coalesce/case)", async () => {
    const { prisma, sastanakUcesnik } = makePrisma();
    sastanakUcesnik.findMany.mockResolvedValue([{ email: "a@b.c" }]);
    const svc = new SastanciSamouslugaService(prisma);
    await svc.setMyPriprema("a@b.c", "s1", true, null);
    const arg = sastanakUcesnik.updateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data).toEqual({ pripremljen: true });
    expect(arg.data).not.toHaveProperty("priprema");
  });

  it("Priprema: prazan tekst čisti polje na NULL (paritet nullif(btrim(...),''))", async () => {
    const { prisma, sastanakUcesnik } = makePrisma();
    sastanakUcesnik.findMany.mockResolvedValue([{ email: "a@b.c" }]);
    const svc = new SastanciSamouslugaService(prisma);
    await svc.setMyPriprema("a@b.c", "s1", null, "   ");
    const arg = sastanakUcesnik.updateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data).toEqual({ priprema: null });
  });

  it("Priprema: ne-učesnik dobija 'not_participant'", async () => {
    const { prisma, sastanakUcesnik } = makePrisma();
    sastanakUcesnik.findMany.mockResolvedValue([]);
    const svc = new SastanciSamouslugaService(prisma);
    await expect(svc.setMyPriprema("a@b.c", "s1", true, "x")).resolves.toBe(
      "not_participant",
    );
  });

  // --- sastanci_set_my_akcija_status ---------------------------------------

  it("Akcija: samouslužno NE sme 'otkazan'/'odlozen'/'kasni' (uži skup od CHECK-a)", async () => {
    const { prisma } = makePrisma();
    const svc = new SastanciSamouslugaService(prisma);
    for (const s of ["otkazan", "odlozen", "kasni", ""]) {
      await expect(
        svc.setMyAkcijaStatus("a@b.c", "a1", s),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    }
  });

  it("Akcija: menja je SAMO odgovorni — inače 'not_owner'", async () => {
    const { prisma, akcionaTacka } = makePrisma();
    akcionaTacka.findMany.mockResolvedValue([]);
    const svc = new SastanciSamouslugaService(prisma);
    await expect(
      svc.setMyAkcijaStatus("neko@drugi.rs", "a1", "zavrsen"),
    ).resolves.toBe("not_owner");
    expect(akcionaTacka.update).not.toHaveBeenCalled();
  });

  it("Akcija: 'zavrsen' upisuje potpis zatvaranja", async () => {
    const { prisma, akcionaTacka } = makePrisma();
    akcionaTacka.findMany.mockResolvedValue([{ id: "a1" }]);
    const svc = new SastanciSamouslugaService(prisma);
    await svc.setMyAkcijaStatus("A@B.C", "a1", "zavrsen");
    const arg = akcionaTacka.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.status).toBe("zavrsen");
    expect(arg.data.zatvorenByEmail).toBe("a@b.c");
    expect(arg.data.zatvorenAt).toBeInstanceOf(Date);
  });

  it("🔴 Akcija: vraćanje u rad BRIŠE potpis zatvaranja (paritet CASE ... ELSE null)", async () => {
    const { prisma, akcionaTacka } = makePrisma();
    akcionaTacka.findMany.mockResolvedValue([{ id: "a1" }]);
    const svc = new SastanciSamouslugaService(prisma);
    for (const s of ["otvoren", "u_toku"]) {
      akcionaTacka.update.mockClear();
      await svc.setMyAkcijaStatus("a@b.c", "a1", s);
      const arg = akcionaTacka.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(arg.data.zatvorenAt).toBeNull();
      expect(arg.data.zatvorenByEmail).toBeNull();
    }
  });

  // --- sastanci_get_or_create_my_prefs -------------------------------------

  it("Prefs: upsert po mejlu iz sesije (ključ tabele je mejl, ne nalog)", async () => {
    const { prisma, sastanciNotificationPrefs } = makePrisma();
    const svc = new SastanciSamouslugaService(prisma);
    await svc.getOrCreateMyPrefs("  A@B.C ");
    expect(sastanciNotificationPrefs.upsert).toHaveBeenCalledWith({
      where: { email: "a@b.c" },
      create: { email: "a@b.c" },
      update: {},
    });
  });

  it("Prefs: prazan mejl je greška", async () => {
    const { prisma } = makePrisma();
    const svc = new SastanciSamouslugaService(prisma);
    await expect(svc.getOrCreateMyPrefs(null)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});
