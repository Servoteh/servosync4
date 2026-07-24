import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { MailService } from "../../common/mail/mail.service";

/** Ishodi koji generišu mejl podnosiocu (MODULE_SPEC §9). */
export type ZahteviMailOutcome =
  | "approve"
  | "reject"
  | "needs-info"
  | "done";

/** RSD iznos (Decimal) → celobrojni string sa tačkom kao separatorom hiljada („4.500"). */
function formatRsd(dec: Prisma.Decimal): string {
  return dec.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

const OUTCOME_META: Record<
  ZahteviMailOutcome,
  { label: string; verb: string }
> = {
  approve: {
    label: "odobren za realizaciju",
    verb: "Vaš zahtev je odobren za realizaciju",
  },
  reject: { label: "odbijen", verb: "Vaš zahtev je odbijen" },
  "needs-info": {
    label: "vraćen na dopunu",
    verb: "Vaš zahtev je vraćen na dopunu",
  },
  done: { label: "završen", verb: "Vaš zahtev je završen" },
};

/**
 * Obaveštenja podnosiocu (MODULE_SPEC §9) — mejl na odluku (approve/reject/needs-info)
 * i na završetak (DONE). Env `ZAHTEVI_MAIL_NOTIFY` default `true` (presuda §13.4);
 * bez RESEND ključa MailService je u DRY-RUN (loguje, ne šalje). DOKTRINA §10.4:
 * slanje NIKAD ne obara radnju — cela metoda je best-effort, pozivalac je ne await-uje
 * kritično (i sam servis ne baca — sve u try/catch).
 */
@Injectable()
export class ZahteviMailService {
  private readonly logger = new Logger(ZahteviMailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  /** Da li je obaveštavanje uključeno (default TRUE; isključi samo eksplicitnim "false"/"0"). */
  private get enabled(): boolean {
    const v = (process.env.ZAHTEVI_MAIL_NOTIFY ?? "true")
      .trim()
      .toLowerCase();
    return v !== "false" && v !== "0" && v !== "off" && v !== "no";
  }

  /**
   * Pošalji obaveštenje podnosiocu za dati ishod. Vraća boolean uspeha (nikad ne baca).
   * `note` je obrazloženje (razlog odbijanja / pitanja / napomena) — prikazuje se u telu.
   */
  async notifySubmitter(params: {
    requestId: number;
    outcome: ZahteviMailOutcome;
    note?: string | null;
  }): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const req = await this.prisma.changeRequest.findUnique({
        where: { id: params.requestId },
        select: {
          reqNo: true,
          title: true,
          createdByUserId: true,
        },
      });
      if (!req) return false;
      const user = await this.prisma.user.findUnique({
        where: { id: req.createdByUserId },
        select: { email: true, fullName: true },
      });
      if (!user?.email) {
        this.logger.warn(
          `Zahtev ${req.reqNo}: podnosilac #${req.createdByUserId} nema email — mejl preskočen.`,
        );
        return false;
      }

      const meta = OUTCOME_META[params.outcome];
      const subject = `Zahtev ${req.reqNo} — ${meta.label}`;
      const html = this.buildHtml({
        greeting: user.fullName || "poštovani",
        reqNo: req.reqNo,
        title: req.title,
        verb: meta.verb,
        note: params.note ?? null,
      });
      return await this.mail.send({ to: user.email, subject, html });
    } catch (err) {
      this.logger.warn(
        `Obaveštenje za zahtev ${params.requestId} (${params.outcome}) nije poslato: ${
          (err as Error).message
        }`,
      );
      return false;
    }
  }

  /**
   * Obaveštenje administratorima (MODULE_SPEC §9) — na svaki submit (submitInternal,
   * posle commita, fire-and-forget). `isResubmit` (dopuna vraćena) menja subject/telo:
   * „Dopunjen zahtev Z-…" (podnosilac odgovorio na dopunu) umesto „Nova ideja Z-…".
   * Primaoci (PRESUDA 24.07): ako je `ZAHTEVI_ADMIN_MAILS` (CSV) postavljen — to je
   * AUTORITATIVNA „to" lista (neki admini, npr. Luka/Nevena, NE žele ove mejlove), a
   * `ZAHTEVI_ADMIN_CC` (CSV, opciono) ide kao CC; ako env NIJE postavljen — fallback na
   * sve aktivne admine iz baze (`users.role='admin'`). Poštuje `ZAHTEVI_MAIL_NOTIFY`; nikad ne baca.
   */
  async notifyAdminsNewRequest(
    requestId: number,
    isResubmit = false,
  ): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const req = await this.prisma.changeRequest.findUnique({
        where: { id: requestId },
        select: {
          reqNo: true,
          title: true,
          description: true,
          createdByUserId: true,
        },
      });
      if (!req) return false;

      const { to, cc } = await this.adminRecipients();
      if (to.length === 0) {
        this.logger.warn(
          `Zahtev ${req.reqNo}: nema administratorskih email-ova — obaveštenje preskočeno.`,
        );
        return false;
      }

      const submitter = await this.prisma.user.findUnique({
        where: { id: req.createdByUserId },
        select: { fullName: true, email: true },
      });
      const submitterName =
        submitter?.fullName ||
        submitter?.email ||
        `korisnik #${req.createdByUserId}`;

      const subject = isResubmit
        ? `Dopunjen zahtev Z-${req.reqNo}: ${req.title}`
        : `Nova ideja Z-${req.reqNo}: ${req.title}`;
      const html = this.buildAdminHtml({
        reqNo: req.reqNo,
        title: req.title,
        description: req.description,
        submitterName,
        link: this.detailLink(requestId),
        isResubmit,
      });
      return await this.mail.send({
        to,
        subject,
        html,
        ...(cc.length ? { cc } : {}),
      });
    } catch (err) {
      this.logger.warn(
        `Obaveštenje administratorima za zahtev ${requestId} nije poslato: ${
          (err as Error).message
        }`,
      );
      return false;
    }
  }

  /**
   * Primaoci admin obaveštenja (§9, presuda 24.07). `ZAHTEVI_ADMIN_MAILS` (CSV), kad je
   * postavljen, je AUTORITATIVNA „to" lista (override, NE fallback) — bira ko prima ove
   * mejlove jer neki admini (Luka, Nevena) ne žele; `ZAHTEVI_ADMIN_CC` (CSV, opciono) → CC.
   * Ako `ZAHTEVI_ADMIN_MAILS` NIJE postavljen → svi aktivni admini iz baze (users.role='admin').
   */
  private async adminRecipients(): Promise<{ to: string[]; cc: string[] }> {
    const parseCsv = (v: string | undefined): string[] =>
      Array.from(
        new Set(
          (v ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.includes("@")),
        ),
      );
    const cc = parseCsv(process.env.ZAHTEVI_ADMIN_CC);
    const override = parseCsv(process.env.ZAHTEVI_ADMIN_MAILS);
    if (override.length > 0) return { to: override, cc };
    // Env nije postavljen → svi aktivni admini iz baze (postojeći fallback).
    const admins = await this.prisma.user.findMany({
      where: { role: "admin", active: true, email: { not: "" } },
      select: { email: true },
    });
    const fromDb = Array.from(
      new Set(
        admins
          .map((a) => a.email)
          .filter((e): e is string => !!e && e.includes("@")),
      ),
    );
    return { to: fromDb, cc };
  }

  /**
   * Zbirni mesečni pregled korisnicima (DOPUNA presude 24.07) — OPCIONO, na admin izbor pri
   * „Zaključi mesec". Šalje JEDAN mejl po korisniku: spisak njegovih nagrađenih (PAID) zahteva
   * tog meseca (reqNo + naslov) + UKUPAN iznos — BEZ pojedinačnih ocena (tihi režim). Poštuje
   * `ZAHTEVI_MAIL_NOTIFY`; best-effort — nikad ne baca (pojedinačni pad se loguje, ide dalje).
   * Vraća broj poslatih mejlova. Zove se posle zaključenja meseca (CONFIRMED→PAID).
   */
  async notifyMonthlySummary(month: string): Promise<number> {
    if (!this.enabled) return 0;
    try {
      const rows = await this.prisma.changeRequest.findMany({
        where: { rewardMonth: month, rewardStatus: "PAID" },
        select: {
          reqNo: true,
          title: true,
          rewardAmount: true,
          createdByUserId: true,
        },
        orderBy: { reqNo: "asc" },
      });
      if (rows.length === 0) return 0;

      // Grupiši po korisniku: stavke (reqNo+naslov) + ukupan iznos (Decimal, ne Float).
      const byUser = new Map<
        number,
        { items: { reqNo: string; title: string }[]; total: Prisma.Decimal }
      >();
      for (const r of rows) {
        let g = byUser.get(r.createdByUserId);
        if (!g) {
          g = { items: [], total: new Prisma.Decimal(0) };
          byUser.set(r.createdByUserId, g);
        }
        g.items.push({ reqNo: r.reqNo, title: r.title });
        g.total = g.total.plus(r.rewardAmount ?? new Prisma.Decimal(0));
      }

      const users = await this.prisma.user.findMany({
        where: { id: { in: Array.from(byUser.keys()) } },
        select: { id: true, email: true, fullName: true },
      });
      const userById = new Map(users.map((u) => [u.id, u]));

      let sent = 0;
      for (const [userId, g] of byUser) {
        const u = userById.get(userId);
        if (!u?.email) {
          this.logger.warn(
            `Zbirni pregled ${month}: korisnik #${userId} nema email — preskočen.`,
          );
          continue;
        }
        const subject = `Vaše nagrade za ${month}`;
        const html = this.buildMonthlySummaryHtml({
          greeting: u.fullName || "poštovani",
          month,
          items: g.items,
          total: formatRsd(g.total),
        });
        if (await this.mail.send({ to: u.email, subject, html })) sent++;
      }
      return sent;
    } catch (err) {
      this.logger.warn(
        `Zbirni mesečni pregled za ${month} nije poslat: ${(err as Error).message}`,
      );
      return 0;
    }
  }

  /** Prod link ka detalju zahteva (statička ruta `?id=` — §8). Baza iz SY15_APP_URL. */
  private detailLink(requestId: number): string {
    const base = (
      process.env.SY15_APP_URL || "https://servosync.servoteh.com"
    ).replace(/\/+$/, "");
    return `${base}/zahtevi/detalj?id=${requestId}`;
  }

  private buildAdminHtml(p: {
    reqNo: string;
    title: string;
    description: string;
    submitterName: string;
    link: string;
    isResubmit: boolean;
  }): string {
    const esc = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const desc = p.description.slice(0, 600);
    const truncated = p.description.length > 600 ? "…" : "";
    const lead = p.isResubmit
      ? "Podnosilac je odgovorio na dopunu — zahtev je ponovo podnet. Odgovori su u tabu Pitanja:"
      : "Nova ideja / zahtev je podnet u modulu Zahtevi:";
    return `
      <p>${esc(lead)}</p>
      <p style="margin:12px 0"><strong>Z-${esc(p.reqNo)}</strong> — ${esc(
        p.title,
      )}</p>
      <p style="margin:8px 0;color:#444"><strong>Podnosilac:</strong> ${esc(
        p.submitterName,
      )}</p>
      <p style="margin:12px 0;white-space:pre-wrap">${esc(desc)}${truncated}</p>
      <p style="margin:16px 0"><a href="${esc(
        p.link,
      )}">Otvori zahtev u aplikaciji</a></p>
      <p style="color:#666;font-size:13px;margin-top:16px">Ovo je automatska poruka sistema ServoSync (modul Zahtevi).</p>`;
  }

  private buildHtml(p: {
    greeting: string;
    reqNo: string;
    title: string;
    verb: string;
    note: string | null;
  }): string {
    const esc = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const noteBlock = p.note
      ? `<p style="margin:12px 0"><strong>Napomena:</strong><br/>${esc(
          p.note,
        ).replace(/\n/g, "<br/>")}</p>`
      : "";
    return `
      <p>Poštovani ${esc(p.greeting)},</p>
      <p>${esc(p.verb)}:</p>
      <p style="margin:12px 0"><strong>${esc(p.reqNo)}</strong> — ${esc(
        p.title,
      )}</p>
      ${noteBlock}
      <p style="color:#666;font-size:13px;margin-top:16px">Ovo je automatska poruka sistema ServoSync (modul Zahtevi).</p>`;
  }

  /** Telo zbirnog mesečnog pregleda korisniku — stavke (reqNo + naslov) + ukupan iznos (bez ocena). */
  private buildMonthlySummaryHtml(p: {
    greeting: string;
    month: string;
    items: { reqNo: string; title: string }[];
    total: string;
  }): string {
    const esc = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const list = p.items
      .map(
        (it) =>
          `<li><strong>${esc(it.reqNo)}</strong> — ${esc(it.title)}</li>`,
      )
      .join("");
    return `
      <p>Poštovani ${esc(p.greeting)},</p>
      <p>Pregled vaših prihvaćenih predloga za ${esc(p.month)}:</p>
      <ul style="margin:12px 0;padding-left:20px">${list}</ul>
      <p style="margin:12px 0"><strong>Ukupno: ${esc(p.total)} RSD</strong></p>
      <p style="color:#666;font-size:13px;margin-top:16px">Ovo je automatska poruka sistema ServoSync (modul Zahtevi).</p>`;
  }
}
