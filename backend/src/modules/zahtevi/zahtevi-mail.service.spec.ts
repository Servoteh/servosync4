import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { MailService } from "../../common/mail/mail.service";
import { ZahteviMailService } from "./zahtevi-mail.service";

interface PrismaMock {
  changeRequest: { findUnique: jest.Mock };
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

    it("bez admina u bazi → fallback ZAHTEVI_ADMIN_MAILS (CSV)", async () => {
      prisma.user.findMany.mockResolvedValue([]);
      process.env.ZAHTEVI_ADMIN_MAILS = "a@servoteh.com, b@servoteh.com";
      await service.notifyAdminsNewRequest(10);
      const arg = mail.send.mock.calls[0][0] as { to: string[] };
      expect(arg.to).toEqual(["a@servoteh.com", "b@servoteh.com"]);
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
});
