import { Injectable, Logger } from "@nestjs/common";

/**
 * Transakcioni mejl preko Resend HTTP API-ja (isti servis i verifikovan domen
 * kao ServoSync 1.0: `from: obavestenja@servoteh.com`, api.resend.com/emails).
 *
 * 1.0 šalje kroz Supabase edge funkcije; 2.0 (NestJS on-prem) zove Resend
 * DIREKTNO preko `fetch` — nema nove zavisnosti. Ključ i „from" iz env-a:
 *   RESEND_API_KEY   (bez njega → DRY-RUN: loguje, ne šalje, vraća false)
 *   RESEND_FROM      (default "Servoteh <obavestenja@servoteh.com>")
 *
 * Pravilo (kao za notifikacije, PLAN_dorade §D8): slanje NE sme da obori
 * poslovnu radnju — pozivaoci ga zovu u try/catch, a i sam servis nikad ne baca
 * (vraća boolean uspeha). DRY-RUN kad ključ nedostaje je nameran (dev/pre-config
 * prod) — identično 1.0 ponašanju `resend_not_configured`.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly apiKey = process.env.RESEND_API_KEY ?? "";
  private readonly from =
    process.env.RESEND_FROM ?? "Servoteh <obavestenja@servoteh.com>";

  /** Da li je pravi slanje konfigurisano (za /health i uslovne poruke). */
  get configured(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Pošalji jedan mejl. Vraća `true` na uspeh, `false` na DRY-RUN ili grešku
   * (nikad ne baca). `to` može biti jedan ili više primalaca.
   */
  async send(params: {
    to: string | string[];
    subject: string;
    html: string;
    /** Opcioni prilozi (npr. PDF računa). `content` je Buffer — kodira se u base64 za Resend. */
    attachments?: Array<{ filename: string; content: Buffer }>;
  }): Promise<boolean> {
    const to = Array.isArray(params.to) ? params.to : [params.to];
    if (!to.length) return false;

    if (!this.configured) {
      this.logger.warn(
        `DRY-RUN (RESEND_API_KEY nije podešen): mejl "${params.subject}" → ${to.join(", ")} NIJE poslat.`,
      );
      return false;
    }

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          from: this.from,
          to,
          subject: params.subject,
          html: params.html,
          ...(params.attachments?.length
            ? {
                attachments: params.attachments.map((a) => ({
                  filename: a.filename,
                  content: a.content.toString("base64"),
                })),
              }
            : {}),
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return true;
      const body = (await res.text()).slice(0, 400);
      this.logger.error(`Resend ${res.status} za "${params.subject}": ${body}`);
      return false;
    } catch (e) {
      this.logger.error(
        `Resend slanje palo za "${params.subject}": ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }
}
