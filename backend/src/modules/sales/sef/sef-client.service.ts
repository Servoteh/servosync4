import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";

/**
 * SEF API KLIJENT — REST komunikacija sa MFIN portalom (doc 07 §8.1/§8.2).
 * =========================================================================
 * Ekvivalent BigBit `ER_API_Class` (`MSXML2.XMLHTTP`). Ovde: `fetch` sa
 * `ApiKey` headerom, THROTTLE 3 req/s (MFIN limit), demo/prod env prekidač.
 *
 * PRAVILO (kao MailService, PLAN §D8): mrežna greška NE SME da obori poslovnu
 * radnju. Klijent NIKAD ne baca na network/HTTP grešku — vraća
 * `{ ok: false, ... }` i pušta pozivaoca (SefService) da upiše status na
 * SefOutbox. Baca SAMO na programsku grešku (npr. nepostojeći outbox red).
 *
 * ENV:
 *   SEF_API_URL   base URL (demo `https://demoefaktura.mfin.gov.rs`,
 *                 prod `https://faktura.mfin.gov.rs`). Prazno → demo default.
 *   SEF_API_KEY   ApiKey header. PRAZNO → DRY-RUN: loguje, ne šalje, ne baca
 *                 (identično MailService DRY-RUN-u; bezbedno u dev/pre-config).
 *
 * IDEMPOTENCIJA: slanje ide na `POST /sales-invoice/ubl?requestId=<uuid>` —
 * SEF deduplira po requestId (ponovni POST istog requestId ne pravi duplikat).
 */

const DEMO_BASE_URL = "https://demoefaktura.mfin.gov.rs";
const PUBLIC_API = "/api/publicApi";

// ── Ulazne (purchase) fakture — SEF public API (doc 07 §5) ────────────────────
// Endpointi za ulazni tok (SEF_API_Common). Držani kao konstante jer je oblik
// demo API-ja i mora se potvrditi na prod ključu (doc 07 §5, MODULE_SPEC_sef §5).
// NAPOMENA: migracioni doc navodi POST za /ids; ovde je GET po zadatoj specifikaciji
// (status filter kroz query). Ako prod ključ traži POST — promeni samo `method`.
const PURCHASE_IDS_PATH = `${PUBLIC_API}/purchase-invoice/ids`;
const PURCHASE_XML_PATH = `${PUBLIC_API}/purchase-invoice/xml`;
const PURCHASE_ACCEPT_REJECT_PATH = `${PUBLIC_API}/purchase-invoice/acceptRejectPurchaseInvoice`;
/** MFIN limit: max 3 komande u sekundi. */
const THROTTLE_MAX_PER_SEC = 3;
const THROTTLE_WINDOW_MS = 1000;
const REQUEST_TIMEOUT_MS = 15000;

/** Rezultat jednog SEF poziva (nikad ne baca — greška je u ok/error). */
export interface SefCallResult {
  ok: boolean;
  httpStatus: number; // -1 = nema komunikacije sa serverom (doc 07 §8.1)
  /** Sirovo telo odgovora (za log/parse). */
  body?: string;
  /** SalesInvoiceId koji SEF vrati pri slanju. */
  sefInvoiceId?: string;
  /** SEF status stringa iz /changes (New/Sent/Approved/Rejected/…). */
  sefStatus?: string;
  errorMessage?: string;
  /** true = DRY-RUN (ključ nije podešen) — poziv nije upućen. */
  dryRun?: boolean;
}

/** Rezultat povlačenja ID-jeva ulaznih faktura (SefCallResult + lista ID-jeva). */
export interface SefIdsResult extends SefCallResult {
  /** SEF PurchaseInvoiceId-jevi; prazno u DRY-RUN i na grešci. */
  ids: string[];
}

@Injectable()
export class SefClientService {
  private readonly logger = new Logger(SefClientService.name);
  private readonly baseUrl = (
    process.env.SEF_API_URL || DEMO_BASE_URL
  ).replace(/\/+$/, "");
  private readonly apiKey = process.env.SEF_API_KEY ?? "";

  // Throttle: klizni prozor timestamp-ova poslednjih poziva.
  private callTimestamps: number[] = [];

  constructor(private readonly prisma: PrismaService) {}

  /** Da li je pravi slanje konfigurisano (za /health i uslovne poruke). */
  get configured(): boolean {
    return this.apiKey.length > 0;
  }

  get isProd(): boolean {
    return /faktura\.mfin\.gov\.rs$/i.test(this.baseUrl) && !/demo/i.test(this.baseUrl);
  }

  /**
   * Pošalji fakturu na SEF. Čita SefOutbox (ublXml + requestId), POST-uje UBL.
   * `POST /sales-invoice/ubl?requestId=<uuid>&date=Auto` (doc 07 §8.2).
   * Ne baca na mrežnu grešku — vraća SefCallResult.
   */
  async sendInvoice(sefOutboxId: number): Promise<SefCallResult> {
    const outbox = await this.prisma.sefOutbox.findUnique({
      where: { id: sefOutboxId },
    });
    if (!outbox) {
      // Programska greška (ne mrežna) — sme da baca.
      throw new Error(`SefOutbox ${sefOutboxId} ne postoji.`);
    }
    if (!outbox.ublXml) {
      return {
        ok: false,
        httpStatus: -1,
        errorMessage: "SefOutbox nema UBL XML (nije generisan).",
      };
    }

    if (!this.configured) {
      this.logger.warn(
        `DRY-RUN (SEF_API_KEY nije podešen): faktura outbox ${sefOutboxId} (requestId=${outbox.requestId}) NIJE poslata na SEF.`,
      );
      return { ok: false, httpStatus: 0, dryRun: true };
    }

    const url =
      `${this.baseUrl}${PUBLIC_API}/sales-invoice/ubl` +
      `?requestId=${encodeURIComponent(outbox.requestId)}&date=Auto`;

    const res = await this.request(url, {
      method: "POST",
      headers: {
        accept: "text/plain",
        "Content-Type": "application/xml",
        ApiKey: this.apiKey,
      },
      body: outbox.ublXml,
    });

    if (res.ok) {
      // SEF vrati SalesInvoiceId (JSON ili plain broj) — pokušaj parse.
      res.sefInvoiceId = this.extractInvoiceId(res.body);
    }
    return res;
  }

  /**
   * Povuci status fakture. `POST /sales-invoice/changes?date=<d>` (doc 07 §8.2).
   * Vraća poslednji poznati SEF status; mapiranje u SefOutbox.status radi SefService.
   */
  async pollStatus(sefOutboxId: number): Promise<SefCallResult> {
    const outbox = await this.prisma.sefOutbox.findUnique({
      where: { id: sefOutboxId },
    });
    if (!outbox) throw new Error(`SefOutbox ${sefOutboxId} ne postoji.`);

    if (!this.configured) {
      return { ok: false, httpStatus: 0, dryRun: true };
    }
    if (!outbox.sefInvoiceId) {
      return {
        ok: false,
        httpStatus: -1,
        errorMessage: "Faktura još nije poslata (nema sefInvoiceId).",
      };
    }

    const url =
      `${this.baseUrl}${PUBLIC_API}/sales-invoice` +
      `?invoiceId=${encodeURIComponent(outbox.sefInvoiceId)}`;

    const res = await this.request(url, {
      method: "GET",
      headers: { accept: "text/plain", ApiKey: this.apiKey },
    });
    if (res.ok) res.sefStatus = this.extractStatus(res.body);
    return res;
  }

  /**
   * Otkaži/storniraj fakturu. `POST /sales-invoice/cancel` JSON (doc 07 §8.2).
   * GUARD (`ER_FakturaMozeDaSeOtkaze`) proverava SefService pre poziva — ovde
   * se samo šalje. Ne baca na mrežnu grešku.
   */
  async cancelInvoice(sefOutboxId: number): Promise<SefCallResult> {
    const outbox = await this.prisma.sefOutbox.findUnique({
      where: { id: sefOutboxId },
    });
    if (!outbox) throw new Error(`SefOutbox ${sefOutboxId} ne postoji.`);

    if (!this.configured) {
      this.logger.warn(
        `DRY-RUN (SEF_API_KEY nije podešen): cancel outbox ${sefOutboxId} NIJE poslat na SEF.`,
      );
      return { ok: false, httpStatus: 0, dryRun: true };
    }
    if (!outbox.sefInvoiceId) {
      return {
        ok: false,
        httpStatus: -1,
        errorMessage: "Faktura nije na SEF-u (nema sefInvoiceId) — nema šta da se otkaže.",
      };
    }

    const url = `${this.baseUrl}${PUBLIC_API}/sales-invoice/cancel`;
    return this.request(url, {
      method: "POST",
      headers: {
        accept: "text/plain",
        "Content-Type": "application/json",
        ApiKey: this.apiKey,
      },
      body: JSON.stringify({ invoiceId: outbox.sefInvoiceId }),
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Ulazne (purchase) fakture — SEF_API_Common (doc 07 §5). Nikad ne baca na
  // mrežnu grešku (isti ugovor kao izlazni tok) — greška je u ok/errorMessage.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Povuci ID-jeve novih ulaznih faktura sa SEF-a (status=New).
   * `GET /purchase-invoice/ids?status=New[&dateFrom=<d>]` (doc 07 §5).
   * DRY-RUN (nema ključa) → prazna lista uz `dryRun`. Ne baca na mrežnu grešku.
   */
  async pullPurchaseInvoiceIds(dateFrom?: string): Promise<SefIdsResult> {
    if (!this.configured) {
      this.logger.warn(
        "DRY-RUN (SEF_API_KEY nije podešen): ulazne fakture NISU povučene sa SEF-a.",
      );
      return { ok: false, httpStatus: 0, ids: [], dryRun: true };
    }

    const params = new URLSearchParams({ status: "New" });
    if (dateFrom) params.set("dateFrom", dateFrom);
    const url = `${this.baseUrl}${PURCHASE_IDS_PATH}?${params.toString()}`;

    const res = await this.request(url, {
      method: "GET",
      headers: { accept: "application/json", ApiKey: this.apiKey },
    });
    return { ...res, ids: res.ok ? this.extractIds(res.body) : [] };
  }

  /**
   * Preuzmi UBL XML jedne ulazne fakture. `GET /purchase-invoice/xml?invoiceId=<id>`
   * (doc 07 §5). Na uspeh `body` = sirovi UBL. DRY-RUN → dryRun. Ne baca.
   */
  async getPurchaseInvoiceXml(invoiceId: string): Promise<SefCallResult> {
    if (!this.configured) {
      return { ok: false, httpStatus: 0, dryRun: true };
    }
    const url = `${this.baseUrl}${PURCHASE_XML_PATH}?invoiceId=${encodeURIComponent(invoiceId)}`;
    return this.request(url, {
      method: "GET",
      headers: { accept: "application/xml", ApiKey: this.apiKey },
    });
  }

  /**
   * Prihvati/odbij ulaznu fakturu na SEF-u. `POST /purchase-invoice/acceptRejectPurchaseInvoice`
   * JSON telom (doc 07 §5, rok 15 dana). DRY-RUN (nema ključa) → dryRun, ne šalje.
   * Ne baca na mrežnu grešku — pozivalac (SefIncomingService) odlučuje o commit-u.
   */
  async acceptRejectPurchaseInvoice(
    invoiceId: string,
    accepted: boolean,
    comment?: string,
  ): Promise<SefCallResult> {
    if (!this.configured) {
      this.logger.warn(
        `DRY-RUN (SEF_API_KEY nije podešen): ${accepted ? "prihvatanje" : "odbijanje"} ` +
          `ulazne fakture ${invoiceId} NIJE poslato na SEF.`,
      );
      return { ok: false, httpStatus: 0, dryRun: true };
    }
    const url = `${this.baseUrl}${PURCHASE_ACCEPT_REJECT_PATH}`;
    return this.request(url, {
      method: "POST",
      headers: {
        accept: "text/plain",
        "Content-Type": "application/json",
        ApiKey: this.apiKey,
      },
      body: JSON.stringify({ invoiceId, accepted, comment: comment ?? null }),
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Interni: throttle + fetch omotač (nikad ne baca na mrežnu grešku)
  // ───────────────────────────────────────────────────────────────────────────

  private async request(
    url: string,
    init: RequestInit,
  ): Promise<SefCallResult> {
    await this.throttle();
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = await res.text();
      // 200/304 = OK (doc 07 §8.1), inače greška sa ResponseText.
      if (res.status === 200 || res.status === 304) {
        return { ok: true, httpStatus: res.status, body };
      }
      this.logger.error(
        `SEF ${init.method} ${res.status} za ${url}: ${body.slice(0, 400)}`,
      );
      return {
        ok: false,
        httpStatus: res.status,
        body,
        errorMessage: `SEF HTTP ${res.status}: ${body.slice(0, 300)}`,
      };
    } catch (e) {
      // Mrežna greška: ResponseStatus=-1 „NE POSTOJI KOMUNIKACIJA SA SERVEROM".
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`SEF poziv pao za ${url}: ${msg}`);
      return {
        ok: false,
        httpStatus: -1,
        errorMessage: `Nema komunikacije sa SEF serverom: ${msg}`,
      };
    }
  }

  /**
   * Throttle na 3 req/s (MFIN limit, doc 07 §8.1). Klizni prozor: ako je u
   * poslednjih 1s već bilo 3 poziva, čeka do isteka najstarijeg.
   */
  private async throttle(): Promise<void> {
    // Prošireno serijalno; instanca je singleton (NestJS provider) pa je red poziva serijalizovan.
    for (;;) {
      const now = Date.now();
      this.callTimestamps = this.callTimestamps.filter(
        (t) => now - t < THROTTLE_WINDOW_MS,
      );
      if (this.callTimestamps.length < THROTTLE_MAX_PER_SEC) {
        this.callTimestamps.push(now);
        return;
      }
      const oldest = this.callTimestamps[0];
      const waitMs = THROTTLE_WINDOW_MS - (now - oldest) + 5;
      await sleep(waitMs);
    }
  }

  /**
   * Izvuci listu ulaznih PurchaseInvoiceId-jeva iz `/purchase-invoice/ids` tela.
   * SEF vraća JSON niz ili omotač (`PurchaseInvoiceIds`/`Ids`); tolerantno i za
   * goli whitespace/CSV spisak brojeva.
   */
  private extractIds(body?: string): string[] {
    if (!body) return [];
    const trimmed = body.trim();
    if (!trimmed) return [];
    try {
      const json = JSON.parse(trimmed) as unknown;
      const arr = Array.isArray(json)
        ? json
        : (() => {
            const o = json as Record<string, unknown>;
            const cand =
              o.PurchaseInvoiceIds ?? o.purchaseInvoiceIds ?? o.Ids ?? o.ids;
            return Array.isArray(cand) ? cand : null;
          })();
      if (Array.isArray(arr)) {
        return arr
          .map((v) => (v === null || v === undefined ? "" : String(v).trim()))
          .filter((s) => s.length > 0);
      }
    } catch {
      // nije JSON — probaj goli spisak brojeva
      const parts = trimmed.split(/[\s,]+/).filter((s) => /^\d+$/.test(s));
      if (parts.length) return parts;
    }
    return [];
  }

  /** SEF pri slanju vrati SalesInvoiceId — može biti JSON ili goli broj. */
  private extractInvoiceId(body?: string): string | undefined {
    if (!body) return undefined;
    const trimmed = body.trim();
    // Pokušaj JSON: { "SalesInvoiceId": 123, ... } ili { "invoiceId": ... }.
    try {
      const json = JSON.parse(trimmed) as Record<string, unknown>;
      const raw =
        json.SalesInvoiceId ?? json.salesInvoiceId ?? json.InvoiceId ?? json.invoiceId;
      if (raw !== undefined && raw !== null) return String(raw);
    } catch {
      // nije JSON
    }
    // Goli broj u telu?
    if (/^\d+$/.test(trimmed)) return trimmed;
    return undefined;
  }

  /** Iz /sales-invoice odgovora izvuci Status string. */
  private extractStatus(body?: string): string | undefined {
    if (!body) return undefined;
    try {
      const json = JSON.parse(body.trim()) as Record<string, unknown>;
      const raw = json.Status ?? json.status ?? json.InvoiceStatus;
      if (raw !== undefined && raw !== null) return String(raw);
    } catch {
      // nije JSON — vrati plain
      const t = body.trim();
      if (t.length > 0 && t.length < 40) return t;
    }
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
