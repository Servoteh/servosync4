import { MailService } from "./mail.service";

describe("MailService", () => {
  const OLD_KEY = process.env.RESEND_API_KEY;
  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = OLD_KEY;
    jest.restoreAllMocks();
  });

  it("bez RESEND_API_KEY → DRY-RUN (configured=false, send vraća false, ne zove fetch)", async () => {
    delete process.env.RESEND_API_KEY;
    const fetchSpy = jest.spyOn(global, "fetch");
    const svc = new MailService();
    expect(svc.configured).toBe(false);
    const ok = await svc.send({ to: "a@x", subject: "s", html: "<p>h</p>" });
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("prazan `to` → false bez slanja", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const fetchSpy = jest.spyOn(global, "fetch");
    const svc = new MailService();
    expect(await svc.send({ to: [], subject: "s", html: "h" })).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sa ključem i 200 → true (poziva Resend sa Bearer + from)", async () => {
    process.env.RESEND_API_KEY = "re_test";
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const svc = new MailService();
    const ok = await svc.send({ to: "a@x", subject: "s", html: "<p>h</p>" });
    expect(ok).toBe(true);
    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(call[0]).toBe("https://api.resend.com/emails");
    expect(call[1].headers.Authorization).toBe("Bearer re_test");
  });

  it("Resend vrati grešku (422) → false, ne baca", async () => {
    process.env.RESEND_API_KEY = "re_test";
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("bad", { status: 422 }));
    const svc = new MailService();
    await expect(
      svc.send({ to: "a@x", subject: "s", html: "h" }),
    ).resolves.toBe(false);
  });

  it("fetch baci (mreža) → false, ne propagira izuzetak", async () => {
    process.env.RESEND_API_KEY = "re_test";
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("network"));
    const svc = new MailService();
    await expect(
      svc.send({ to: "a@x", subject: "s", html: "h" }),
    ).resolves.toBe(false);
  });
});
