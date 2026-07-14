import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";

/**
 * GoTrue admin klijent za sy15 (1.0) auth stack — Talas D / D1 (dvostrano upravljanje nalozima).
 * 2.0 admin konzola nosi `SY15_SERVICE_KEY` (service_role sy15 stacka) i radi create/reset u ime
 * admina. PRAVO se proverava PRE poziva (guard `settings.users` + DB `current_user_is_admin()` kroz
 * `withUserRls`) — kao Reversi/storage obrazac; service ključ zaobilazi GoTrue interne provere.
 *
 * Portovana logika je iz 1.0 edge `admin-invite-user` (GoTrue admin API + welcome outbox), jer 2.0
 * ima SVOJ auth/users pa se telo piše u TS (MODULE_SPEC §3.3/§7 P1). 1.0 edge ostaje živ za 1.0
 * fallback do cutover-a taba.
 *
 * Boot-safe: bez `SY15_SERVICE_KEY` (+ auth/rest baze) → 503 (aplikacija se diže normalno; tek
 * upotreba admin-write endpointa vraća 503). GoTrue/format IDENTIČNI 1.0 — NE menjati (doktrina §C).
 */
@Injectable()
export class Sy15AuthAdminService {
  private readonly logger = new Logger(Sy15AuthAdminService.name);

  /** Da li je GoTrue admin konfigurisan (bez bacanja) — za grananje u servisu. */
  isConfigured(): boolean {
    return Boolean(process.env.SY15_SERVICE_KEY && this.authBase());
  }

  /** GoTrue admin baza: `SY15_AUTH_URL`, ili izvedeno iz `SY15_REST_URL` (`/rest/v1`→`/auth/v1`). */
  private authBase(): string | null {
    const explicit = (process.env.SY15_AUTH_URL || "").trim();
    if (explicit) return explicit.replace(/\/+$/, "");
    const rest = (process.env.SY15_REST_URL || "").trim();
    if (!rest) return null;
    return rest.replace(/\/+$/, "").replace(/\/rest\/v1$/, "/auth/v1");
  }

  /** REST (PostgREST) baza — za `kadr_notification_log` outbox (welcome/reset mejl). */
  private restBase(): string | null {
    const rest = (process.env.SY15_REST_URL || "").trim();
    return rest ? rest.replace(/\/+$/, "") : null;
  }

  private cfg(): { auth: string; key: string } {
    const auth = this.authBase();
    const key = process.env.SY15_SERVICE_KEY;
    if (!auth || !key) {
      throw new ServiceUnavailableException(
        "sy15 GoTrue admin nije konfigurisan (SY15_SERVICE_KEY / SY15_AUTH_URL|SY15_REST_URL)",
      );
    }
    return { auth, key };
  }

  private headers(key: string): Record<string, string> {
    return {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };
  }

  /** Nasumična lozinka (paritet 1.0 edge randomPassword; koristi se kad admin ne prosledi). */
  randomPassword(len = 24): string {
    const chars =
      "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
    const arr = randomBytes(len);
    let out = "";
    for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length];
    return out;
  }

  /** Nađi GoTrue auth.users id po email-u; null ako ne postoji. */
  async findUserIdByEmail(email: string): Promise<string | null> {
    const { auth, key } = this.cfg();
    const res = await fetch(
      `${auth}/admin/users?email=${encodeURIComponent(email)}`,
      { headers: this.headers(key), signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const list = (await res.json()) as
      | { users?: Array<{ id?: string }> }
      | Array<{ id?: string }>;
    const users = Array.isArray(list) ? list : (list?.users ?? []);
    return users[0]?.id ?? null;
  }

  /**
   * Kreiraj GoTrue nalog — IDEMPOTENTNO: 422/"already" → pronađi postojeći id (paritet 1.0 edge).
   * Vraća `{ id, created }`. `created=false` znači nalog je već postojao (retry-bezbedno).
   */
  async createUser(input: {
    email: string;
    password: string;
    fullName?: string;
  }): Promise<{ id: string; created: boolean }> {
    const { auth, key } = this.cfg();
    const res = await fetch(`${auth}/admin/users`, {
      method: "POST",
      headers: this.headers(key),
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        email_confirm: true,
        user_metadata: { full_name: input.fullName ?? "" },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const created = (await res.json()) as { id?: string };
      if (!created?.id) {
        throw new BadGatewayException("GoTrue nije vratio id kreiranog naloga");
      }
      return { id: created.id, created: true };
    }
    const errText = (await res.text()).slice(0, 400);
    if (res.status === 422 || errText.toLowerCase().includes("already")) {
      const existing = await this.findUserIdByEmail(input.email);
      if (existing) return { id: existing, created: false };
    }
    throw new BadGatewayException(
      `GoTrue create nije uspeo (${res.status}: ${errText})`,
    );
  }

  /** Postavi novu lozinku postojećem GoTrue nalogu (reset tok, paritet 1.0 edge reset_password). */
  async resetPassword(userId: string, newPassword: string): Promise<void> {
    const { auth, key } = this.cfg();
    const res = await fetch(`${auth}/admin/users/${userId}`, {
      method: "PUT",
      headers: this.headers(key),
      body: JSON.stringify({ password: newPassword }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      throw new BadGatewayException(
        `GoTrue reset lozinke nije uspeo (${res.status}: ${(await res.text()).slice(0, 200)})`,
      );
    }
  }

  /**
   * Welcome/reset mejl u sy15 `kadr_notification_log` outbox (best-effort — greška se GUTA, ne sme
   * da obori kreiranje naloga; paritet 1.0 edge queueWelcomeEmail). Privremena lozinka se NE upisuje
   * (perzistira kao plaintext) — korisnik je postavlja sam kroz „Zaboravljena lozinka".
   */
  async queueWelcomeEmail(
    email: string,
    fullName: string,
    isReset = false,
  ): Promise<void> {
    try {
      const rest = this.restBase();
      const key = process.env.SY15_SERVICE_KEY;
      if (!rest || !key) return;
      const appUrl = (
        process.env.SY15_APP_URL || "https://servosync.servoteh.com/"
      ).replace(/\/+$/, "/");
      const esc = (s: string) =>
        s
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      const subject = isReset
        ? "Nova lozinka — Servoteh aplikacija"
        : "Pristup aplikaciji Servoteh";
      const heading = isReset
        ? "🔑 Resetovana lozinka"
        : "👋 Dobrodošli u Servoteh aplikaciju";
      const intro = isReset
        ? "<p>Administrator je zatražio reset Vaše lozinke. Iz bezbednosnih razloga lozinku podešavate sami:</p>"
        : "<p>Kreiran je Vaš nalog. Iz bezbednosnih razloga lozinku podešavate sami:</p>";
      const body =
        '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">' +
        `<h2 style="color:#2563eb;margin-bottom:4px;">${heading}</h2>` +
        `<p>Poštovani/a <strong>${esc(fullName || email)}</strong>,</p>` +
        intro +
        `<p style="font-size:.95em;color:#334155;">Otvorite aplikaciju, izaberite <strong>„Zaboravljena lozinka"</strong> i unesite <strong>${esc(email)}</strong> — dobićete link za postavljanje sopstvene lozinke.</p>` +
        `<p><a href="${appUrl}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">Otvori aplikaciju</a></p>` +
        '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">' +
        '<p style="font-size:.85em;color:#64748b;"><em>Servoteh — automatsko obaveštenje</em></p>' +
        "</div>";
      await fetch(`${rest}/kadr_notification_log`, {
        method: "POST",
        headers: { ...this.headers(key), Prefer: "return=minimal" },
        body: JSON.stringify({
          channel: "email",
          recipient: email,
          subject,
          body,
          related_entity_type: "user_invite",
          notification_type: "account_invite",
          status: "queued",
        }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      this.logger.warn(`welcome/reset mejl enqueue nije uspeo: ${String(e)}`);
    }
  }
}
