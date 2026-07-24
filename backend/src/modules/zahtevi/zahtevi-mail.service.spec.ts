import { Test, TestingModule } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { MailService } from "../../common/mail/mail.service";
import { ZahteviMailService } from "./zahtevi-mail.service";

interface PrismaMock {
  changeRequest: { findUnique: jest.Mock; findMany: jest.Mock };
  user: { findUnique: jest.Mock; findMany: jest.Mock };
}

function prismaMock(): PrismaMock {
  return {
    changeRequest: {
      findUnique: jest.fn().mockResolvedValue({
        reqNo: "001/26",
        title: "Bug u nabavci",
        description: "Detaljan opis problema u nabavci.",
        createdByUserId: 42,
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        email: "podnosilac@servoteh.com",
        fullName: "Pera Perić",
      }),
      findMany: jest
        .fn()
        .mockResolvedValue([{ email: "admin@servoteh.com" }]),
    },
  };
}

function mailMock(): jest.Mocked<Pick<MailService, "send">> {
  return { send: jest.fn().mockResolvedValue(true) };
}

describe("ZahteviMailService", () => {
  let service: ZahteviMailService;
  let prisma: PrismaMock;
  let mail: ReturnType<typeof mailMock>;
  const origEnv = process.env.ZAHTEVI_MAIL_NOTIFY;
  const origAdminMails = process.env.ZAHTEVI_ADMIN_MAILS;
  const origAdminCc = process.env.ZAHTEVI_ADMIN_CC;

  beforeEach(async () => {
    prisma = prismaMock();
    mail = mailMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZahteviMailService,
        { provide: PrismaService, useValue: prisma },
        { provide: MailService, useValue: mail },
      ],
    }).compile();
    service = module.get(ZahteviMailService);
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.ZAHTEVI_MAIL_NOTIFY;
    else process.env.ZAHTEVI_MAIL_NOTIFY = origEnv;
    if (origAdminMails === undefined) delete process.env.ZAHTEVI_ADMIN_MAILS;
    else process.env.ZAHTEVI_ADMIN_MAILS = origAdminMails;
    if (origAdminCc === undefined) delete process.env.ZAHTEVI_ADMIN_CC;
    else process.env.ZAHTEVI_ADMIN_CC = origAdminCc;
  });

  // Čist start za primaoce admin obaveštenja (nezavisno od okruženja koje pokreće test).
  beforeEach(() => {
    delete process.env.ZAHTEVI_ADMIN_MAILS;
    delete process.env.ZAHTEVI_ADMIN_CC;
  });

  it("default (bez env) → obaveštava (§13.4 default true) sa pravim subject/telom", async () => {
    delete process.env.ZAHTEVI_MAIL_NOTIFY;
    await service.notifySubmitter({
      requestId: 10,
      outcome: "reject",
      note: "duplikat",
    });
    expect(mail.send).toHaveBeenCalledTimes(1);
    const arg = mail.send.mock.calls[0][0] as {
      to: string;
      subject: string;
      html: string;
    };
    expect(arg.to).toBe("podnosilac@servoteh.com");
    expect(arg.subject).toContain("001/26");
    expect(arg.subject).toContain("odbijen");
    expect(arg.html).toContain("Bug u nabavci");
    expect(arg.html).toContain("duplikat");
  });

  it("ZAHTEVI_MAIL_NOTIFY=false → ne šalje", async () => {
    process.env.ZAHTEVI_MAIL_NOTIFY = "false";
    const sent = await service.notifySubmitter({
      requestId: 10,
      outcome: "done",
    });
    expect(sent).toBe(false);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("podnosilac bez emaila → preskoči (false), ne baca", async () => {
    prisma.user.findUnique.mockResolvedValue({ email: null, fullName: "X" });
    await expect(
      service.notifySubmitter({ requestId: 10, outcome: "approve" }),
    ).resolves.toBe(false);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("pad MailService NE baca (best-effort §10.4) — vraća false", async () => {
    mail.send.mockRejectedValue(new Error("resend down"));
    await expect(
      service.notifySubmitter({ requestId: 10, outcome: "done" }),
    ).resolves.toBe(false);
  });

  it("DRY-RUN (MailService vraća false bez ključa) → notify vraća false, ne baca", async () => {
    mail.send.mockResolvedValue(false);
    await expect(
      service.notifySubmitter({ requestId: 10, outcome: "approve" }),
    ).resolves.toBe(false);
    expect(mail.send).toHaveBeenCalled();
  });

  // ── notifyAdminsNewRequest (§9 — mejl adminima na svaku novu ideju) ──────────
  describe("notifyAdminsNewRequest", () => {
    it("šalje adminima: subject Nova ideja Z-… + telo sa opisom/podnosiocem/linkom", async () => {
      delete process.env.ZAHTEVI_MAIL_NOTIFY;
      await service.notifyAdminsNewRequest(10);
      expect(mail.send).toHaveBeenCalledTimes(1);
      const arg = mail.send.mock.calls[0][0] as {
        to: string | string[];
        subject: string;
        html: string;
      };
      expect(arg.to).toEqual(["admin@servoteh.com"]);
      expect(arg.subject).toBe("Nova ideja Z-001/26: Bug u nabavci");
      expect(arg.html).toContain("Detaljan opis problema");
      expect(arg.html).toContain("Pera Perić");
      expect(arg.html).toContain("/zahtevi/detalj?id=10");
    });

    it("ZAHTEVI_MAIL_NOTIFY=false → ne šalje", async () => {
      process.env.ZAHTEVI_MAIL_NOTIFY = "false";
      const sent = await service.notifyAdminsNewRequest(10);
      expect(sent).toBe(false);
      expect(mail.send).not.toHaveBeenCalled();
    });

    it("resubmit (isResubmit=true) → subject Dopunjen zahtev + telo o odgovoru na dopunu", async () => {
      delete process.env.ZAHTEVI_MAIL_NOTIFY;
      await service.notifyAdminsNewRequest(10, true);
      const arg = mail.send.mock.calls[0][0] as { subject: string; html: string };
      expect(arg.subject).toBe("Dopunjen zahtev Z-001/26: Bug u nabavci");
      expect(arg.html).toContain("odgovorio na dopunu");
    });

    it("presuda 24.07: ZAHTEVI_ADMIN_MAILS postavljen → AUTORITATIVNA to lista (override, ne DB)", async () => {
      // DB IMA admina, ali env override presuđuje ko prima (Luka/Nevena isključeni).
      prisma.user.findMany.mockResolvedValue([
        { email: "luka@servoteh.com" },
        { email: "nevena@servoteh.com" },
      ]);
      process.env.ZAHTEVI_ADMIN_MAILS = "nenad@servoteh.com, igor@servoteh.com";
      await service.notifyAdminsNewRequest(10);
      const arg = mail.send.mock.calls[0][0] as { to: string[]; cc?: string[] };
      expect(arg.to).toEqual(["nenad@servoteh.com", "igor@servoteh.com"]);
      expect(arg.cc).toBeUndefined();
      // DB se NE koristi kad je override postavljen.
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it("presuda 24.07: ZAHTEVI_ADMIN_CC → ide kao CC uz override to listu", async () => {
      process.env.ZAHTEVI_ADMIN_MAILS = "nenad@servoteh.com";
      process.env.ZAHTEVI_ADMIN_CC = "sef@servoteh.com, arhiva@servoteh.com";
      await service.notifyAdminsNewRequest(10);
      const arg = mail.send.mock.calls[0][0] as { to: string[]; cc?: string[] };
      expect(arg.to).toEqual(["nenad@servoteh.com"]);
      expect(arg.cc).toEqual(["sef@servoteh.com", "arhiva@servoteh.com"]);
    });

    it("env prazan → DB fallback (svi aktivni admini iz baze)", async () => {
      // ZAHTEVI_ADMIN_MAILS nije postavljen (beforeEach ga briše) → čita se baza.
      prisma.user.findMany.mockResolvedValue([
        { email: "admin@servoteh.com" },
      ]);
      await service.notifyAdminsNewRequest(10);
      const arg = mail.send.mock.calls[0][0] as { to: string[] };
      expect(arg.to).toEqual(["admin@servoteh.com"]);
    });

    it("bez ijednog admina (baza prazna + prazan env) → ne šalje, ne baca", async () => {
      prisma.user.findMany.mockResolvedValue([]);
      delete process.env.ZAHTEVI_ADMIN_MAILS;
      await expect(service.notifyAdminsNewRequest(10)).resolves.toBe(false);
      expect(mail.send).not.toHaveBeenCalled();
    });

    it("pad MailService NE baca (best-effort §10.4)", async () => {
      mail.send.mockRejectedValue(new Error("resend down"));
      await expect(service.notifyAdminsNewRequest(10)).resolves.toBe(false);
    });
  });

  // ── notifyMonthlySummary (DOPUNA 24.07 — zbirni mesečni pregled korisnicima) ──
  describe("notifyMonthlySummary", () => {
    it("jedan zbirni mejl po korisniku: stavke (reqNo+naslov) + ukupan iznos, BEZ ocena", async () => {
      delete process.env.ZAHTEVI_MAIL_NOTIFY;
      // Dva korisnika, jedan sa dve nagrade — očekuje se po JEDAN mejl svakom.
      prisma.changeRequest.findMany.mockResolvedValue([
        { reqNo: "001/26", title: "Prva ideja", rewardAmount: new Prisma.Decimal(1500), createdByUserId: 42 },
        { reqNo: "003/26", title: "Treća ideja", rewardAmount: new Prisma.Decimal(3000), createdByUserId: 42 },
        { reqNo: "002/26", title: "Druga ideja", rewardAmount: new Prisma.Decimal(1000), createdByUserId: 43 },
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: 42, email: "ana@servoteh.com", fullName: "Ana" },
        { id: 43, email: "bora@servoteh.com", fullName: "Bora" },
      ]);
      const sent = await service.notifyMonthlySummary("2026-08");
      expect(sent).toBe(2);
      expect(mail.send).toHaveBeenCalledTimes(2);
      const anaMail = mail.send.mock.calls
        .map((c) => c[0] as { to: string; subject: string; html: string })
        .find((m) => m.to === "ana@servoteh.com")!;
      expect(anaMail.subject).toBe("Vaše nagrade za 2026-08");
      expect(anaMail.html).toContain("001/26");
      expect(anaMail.html).toContain("Prva ideja");
      expect(anaMail.html).toContain("003/26");
      // Ukupan iznos (1500+3000 = 4.500), bez pojedinačnih ocena/★.
      expect(anaMail.html).toContain("4.500 RSD");
      expect(anaMail.html).not.toContain("★");
    });

    it("nema PAID nagrada za mesec → ne šalje ništa (0)", async () => {
      prisma.changeRequest.findMany.mockResolvedValue([]);
      const sent = await service.notifyMonthlySummary("2026-08");
      expect(sent).toBe(0);
      expect(mail.send).not.toHaveBeenCalled();
    });

    it("ZAHTEVI_MAIL_NOTIFY=false → ne šalje (0)", async () => {
      process.env.ZAHTEVI_MAIL_NOTIFY = "false";
      const sent = await service.notifyMonthlySummary("2026-08");
      expect(sent).toBe(0);
      expect(mail.send).not.toHaveBeenCalled();
    });

    it("korisnik bez emaila se preskače, ne baca", async () => {
      prisma.changeRequest.findMany.mockResolvedValue([
        { reqNo: "001/26", title: "A", rewardAmount: new Prisma.Decimal(500), createdByUserId: 42 },
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: 42, email: null, fullName: "Ana" },
      ]);
      await expect(service.notifyMonthlySummary("2026-08")).resolves.toBe(0);
      expect(mail.send).not.toHaveBeenCalled();
    });
  });
});
