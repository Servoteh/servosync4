import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { Sy15Service } from "./sy15.service";

/** Maksimalan broj strana koje `listUsers` fallback prolazi (brana od beskonačne petlje). */
const MAX_LIST_PAGES = 50;
/** Tražena veličina strane; GoTrue je sme sklopiti na manju (kod to podnosi). */
const LIST_PER_PAGE = 1000;

/** Sirov GoTrue korisnik iz admin liste — treba nam samo id + email. */
interface GoTrueUser {
  id?: string;
  email?: string;
}

/** Normalizacija email-a za poređenje (GoTrue emailove čuva malim slovima). */
function normEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

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
 *
 * 🔴 P0 31.07.2026 — rezolucija naloga po email-u: `GET /admin/users?email=` NIJE filter na živom
 * GoTrue-u (v2.189.0) i vraćao je prvu stranu SVIH naloga → lozinka je odlazila tuđem nalogu.
 * Otud invarijanta ovog fajla: nijedan upis lozinke ne sme krenuti bez potvrđenog poklapanja
 * email ↔ `auth.users.id` (vidi `findUserIdByEmail` i `resetPassword`).
 */
@Injectable()
export class Sy15AuthAdminService {
  private readonly logger = new Logger(Sy15AuthAdminService.name);

  constructor(private readonly sy15: Sy15Service) {}

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

  /**
   * Nađi GoTrue `auth.users.id` po email-u; `null` ako ne postoji.
   *
   * 🔴 P0 (31.07.2026): raniji kod je zvao `GET /admin/users?email=<mejl>` i uzimao `users[0].id`.
   * Živi GoTrue (v2.189.0) **IGNORIŠE `?email=`** i vraća prvu stranu SVIH naloga sortiranu po
   * `created_at DESC` — pa je funkcija vraćala NAJSKORIJE KREIRAN nalog, ne traženi. Posledica:
   * upis lozinke je išao TUĐEM korisniku (dogodilo se u produkciji). NIKAD `users[0]` bez provere.
   *
   * Rezolucija sada, redom:
   *   1) sy15 baza — `SELECT id FROM auth.users WHERE lower(email)=lower($1)` kroz `Sy15Service`
   *      (konekciona rola je BYPASSRLS; isti upit koji `setClaims` već radi za `sub`). Merodavno.
   *   2) fallback GoTrue REST — paginira admin listu i traži TAČNO poklapanje email-a
   *      (case-insensitive). Bez poklapanja → `null`.
   */
  async findUserIdByEmail(email: string): Promise<string | null> {
    const wanted = normEmail(email);
    if (!wanted) return null;
    const viaDb = await this.resolveViaSy15Db(wanted);
    if (viaDb) return viaDb.id;
    return this.resolveViaGoTrueList(wanted);
  }

  /**
   * DB rezolucija (merodavna). Vraća `{ id }` kad je odgovor pouzdan (`id` može biti `null` =
   * nalog ne postoji), ili `null` kad sy15 baza nije upotrebljiva → pozivalac pada na REST.
   */
  private async resolveViaSy15Db(
    wanted: string,
  ): Promise<{ id: string | null } | null> {
    if (!this.sy15?.isConfigured) return null;
    let rows: Array<{ id: string }>;
    try {
      rows = await this.sy15.db.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id
        FROM auth.users
        WHERE lower(email) = lower(${wanted}) AND deleted_at IS NULL
        LIMIT 2`;
    } catch (e) {
      this.logger.warn(
        `sy15 DB rezolucija naloga nije uspela, padam na GoTrue REST: ${String(e)}`,
      );
      return null;
    }
    if (rows.length > 1) {
      // Ne nagađamo kad baza ima više redova za isti mejl — bolje „nema naloga" nego pogrešan.
      this.logger.error(
        `auth.users ima ${rows.length} reda za ${wanted} — odbijam da izaberem nalog.`,
      );
      return { id: null };
    }
    return { id: rows[0]?.id ?? null };
  }

  /**
   * GoTrue REST fallback: paginira `/admin/users` i vraća id SAMO uz tačno poklapanje email-a.
   * `per_page` GoTrue sme da sklopi na manju vrednost, zato se petlja vodi po „prazna strana =
   * kraj", a ne po `length < per_page`. Ako server ignoriše i `page` (isti prvi id kao na strani
   * 1), petlja se prekida — nema smisla vrteti isti odgovor.
   */
  private async resolveViaGoTrueList(wanted: string): Promise<string | null> {
    const { auth, key } = this.cfg();
    let firstPageHeadId: string | undefined;
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const res = await fetch(
        `${auth}/admin/users?page=${page}&per_page=${LIST_PER_PAGE}`,
        { headers: this.headers(key), signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as
        | { users?: GoTrueUser[] }
        | GoTrueUser[];
      const users = Array.isArray(body) ? body : (body?.users ?? []);
      if (users.length === 0) return null;
      const hit = users.find((u) => normEmail(u?.email) === wanted);
      if (hit?.id) return hit.id;
      if (page === 1) firstPageHeadId = users[0]?.id;
      else if (users[0]?.id && users[0].id === firstPageHeadId) return null;
    }
    this.logger.warn(
      `GoTrue lista prešla ${MAX_LIST_PAGES} strana bez poklapanja za ${wanted}.`,
    );
    return null;
  }

  /**
   * Email koji GoTrue nalog STVARNO nosi (`GET /admin/users/{id}`), normalizovan; `null` kad
   * nalog nije čitljiv. Ovo je „tregeri" provera pred svaki upis lozinke.
   */
  private async fetchAccountEmail(userId: string): Promise<string | null> {
    const { auth, key } = this.cfg();
    const res = await fetch(
      `${auth}/admin/users/${encodeURIComponent(userId)}`,
      { headers: this.headers(key), signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const user = (await res.json()) as GoTrueUser;
    const email = normEmail(user?.email);
    return email || null;
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
      // P0 brana: id iz rezolucije se DODATNO potvrđuje protiv živog naloga — idempotentna
      // grana sme da vrati postojeći nalog samo ako on stvarno nosi traženi mejl.
      const existing = await this.findUserIdByEmail(input.email);
      if (existing) {
        const actual = await this.fetchAccountEmail(existing);
        if (actual === normEmail(input.email)) {
          return { id: existing, created: false };
        }
        throw new BadGatewayException(
          `Bezbednosna brana: GoTrue nalog ${existing} ne nosi email ${input.email} — nalog NIJE preuzet.`,
        );
      }
    }
    throw new BadGatewayException(
      `GoTrue create nije uspeo (${res.status}: ${errText})`,
    );
  }

  /**
   * Postavi novu lozinku postojećem GoTrue nalogu (reset tok, paritet 1.0 edge reset_password).
   *
   * `expectedEmail` je OBAVEZAN (P0, 31.07.2026): pre PUT-a se čita `GET /admin/users/{id}` i
   * potvrđuje da nalog stvarno nosi taj mejl (case-insensitive). Neusklađenost → izuzetak i
   * NIKAKAV upis. Pojas uz tregere: i kad bi rezolucija id-a opet promašila, lozinka ne može
   * otići tuđem nalogu.
   */
  async resetPassword(
    userId: string,
    newPassword: string,
    expectedEmail: string,
  ): Promise<void> {
    const { auth, key } = this.cfg();
    const wanted = normEmail(expectedEmail);
    if (!wanted) {
      throw new BadGatewayException(
        "resetPassword: expectedEmail je obavezan (brana od upisa lozinke tuđem nalogu).",
      );
    }
    const actual = await this.fetchAccountEmail(userId);
    if (actual === null) {
      throw new BadGatewayException(
        `GoTrue nalog ${userId} nije čitljiv — lozinka NIJE promenjena.`,
      );
    }
    if (actual !== wanted) {
      this.logger.error(
        `BLOKIRAN reset: GoTrue nalog ${userId} nosi "${actual}", traženo "${wanted}" — lozinka NIJE upisana.`,
      );
      throw new BadGatewayException(
        `Bezbednosna brana: GoTrue nalog ne odgovara email-u ${expectedEmail} — lozinka NIJE promenjena.`,
      );
    }
    const res = await fetch(
      `${auth}/admin/users/${encodeURIComponent(userId)}`,
      {
        method: "PUT",
        headers: this.headers(key),
        body: JSON.stringify({ password: newPassword }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!res.ok) {
      throw new BadGatewayException(
        `GoTrue reset lozinke nije uspeo (${res.status}: ${(await res.text()).slice(0, 200)})`,
      );
    }
  }

  /**
   * Welcome/reset mejl u sy15 `kadr_notification_log` outbox (best-effort — greška se GUTA, ne sme
   * da obori kreiranje naloga; paritet 1.0 edge queueWelcomeEmail). Privremena lozinka se NE upisuje
   * (perzistira kao plaintext) — nema self-service „zaboravljena lozinka" toka (ne postoji nigde u
   * 3.0), pa je admin taj koji lozinku prosleđuje korisniku direktno (van ovog mejla). Ovaj mejl je
   * samo obaveštenje; stvarna lozinka je u API odgovoru poziva koji ga je pokrenuo (§ D1 doc).
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
        ? "<p>Administrator je zatražio reset Vaše lozinke.</p>"
        : "<p>Kreiran je Vaš nalog.</p>";
      const body =
        '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">' +
        `<h2 style="color:#2563eb;margin-bottom:4px;">${heading}</h2>` +
        `<p>Poštovani/a <strong>${esc(fullName || email)}</strong>,</p>` +
        intro +
        `<p style="font-size:.95em;color:#334155;">Administrator će Vam poslati privremenu lozinku posebnim putem (mejl/poruka). Prijavite se sa email-om <strong>${esc(email)}</strong> i tom lozinkom — aplikacija će odmah tražiti da postavite sopstvenu.</p>` +
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
