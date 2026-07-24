import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma, type SefIncomingInvoice } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { SefClientService } from "./sef-client.service";

/**
 * SEF ULAZNE (purchase) FAKTURE — životni ciklus (doc 07 §5, MODULE_SPEC_sef §5).
 * =============================================================================
 * Tok: pull (ids → xml → parse → dedup → upsert) → list (rok 15 dana) →
 * accept/reject (SEF poziv PRE lokalnog commita). Zamenjuje BigBit
 * `SEF_API_Common` ulazni sloj (`T_ER_UF`, `eFaktureNabavke`).
 *
 * DEDUP (BigBit logika, O3 presuda): „da li je fakturu VEĆ imamo u evidenciji",
 * bez obzira na tuđe potvrde. Provera nad KUF-om (vat_ledger_entries,
 * direction=input): isti komitent (customers.tax_id == supplier PIB) + isti
 * broj dokumenta (documentNumber == invoiceNumber) → alreadyExists=true.
 *
 * PARSIRANJE UBL-a: minimalni izvlakač (regex; bez pune UBL lib zavisnosti) —
 * PIB, naziv, broj, datumi, PayableAmount, TaxAmount. Ceo XML se čuva u rawXml
 * (audit + kasnije detaljno parsiranje stavki).
 *
 * MREŽA: SefClientService nikad ne baca na mrežnu grešku. Za pull/akciju servis
 * mapira neuspeh u tipizirani izuzetak (ServiceUnavailable) — accept/reject NE
 * menja lokalni status ako SEF odbije (SEF poziv je PRE commit-a).
 */

/** Zakonski rok za odgovor na ulaznu fakturu (doc 07 §5). */
const ACCEPT_DEADLINE_DAYS = 15;
/** Prag za `deadlineSoon` alarm (koliko dana pre isteka je „uskoro"). */
const DEADLINE_SOON_DAYS = 3;
/** Statusi iz kojih je dozvoljeno prihvatanje/odbijanje (CAS guard). */
const ACTIONABLE_STATUSES = ["NEW", "SEEN"] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Rezime jednog pull-a (za odgovor POST /sef/incoming/pull). */
export interface PullSummary {
  dryRun: boolean;
  totalIds: number; // ukupno ID-jeva vraćeno sa SEF-a
  created: number; // novih redova upisano
  skipped: number; // već postojali u bazi (idempotencija)
  failed: number; // XML/parse nije uspeo (preskočeno, ne obara pull)
  note?: string;
}

/** Red liste sa izračunatim brojem preostalih dana do isteka roka. */
export type SefIncomingListItem = SefIncomingInvoice & { daysLeft: number | null };

/** Rezultat accept/reject akcije (entitet + DRY-RUN napomena). */
export interface SefIncomingActionResult {
  invoice: SefIncomingInvoice;
  dryRun: boolean;
  note?: string;
}

/** Minimalno parsirana polja iz UBL-a ulazne fakture. */
interface ParsedUblInvoice {
  supplierPib: string;
  supplierName: string | null;
  invoiceNumber: string;
  issueDate: Date | null;
  dueDate: Date | null;
  totalAmount: Prisma.Decimal;
  vatAmount: Prisma.Decimal;
  currency: string;
}

@Injectable()
export class SefIncomingService {
  private readonly logger = new Logger(SefIncomingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: SefClientService,
  ) {}

  /**
   * Povuci nove ulazne fakture sa SEF-a: ids (status=New) → za nepoznate
   * sefPurchaseId povuci XML, parsiraj minimalno, dedup nad KUF-om, upsert
   * (idempotentan re-pull). Skip-ne-abort po redu: greška na jednoj fakturi ne
   * obara ceo pull. Vraća rezime.
   */
  async pull(dateFrom?: string): Promise<PullSummary> {
    const idsRes = await this.client.pullPurchaseInvoiceIds(dateFrom);

    if (idsRes.dryRun) {
      return {
        dryRun: true,
        totalIds: 0,
        created: 0,
        skipped: 0,
        failed: 0,
        note: "DRY-RUN: SEF_API_KEY nije podešen — nije povučeno sa SEF-a.",
      };
    }
    if (!idsRes.ok) {
      throw new ServiceUnavailableException(
        idsRes.errorMessage ??
          "Preuzimanje ulaznih faktura sa SEF-a nije uspelo.",
      );
    }

    const ids = idsRes.ids;
    if (ids.length === 0) {
      return { dryRun: false, totalIds: 0, created: 0, skipped: 0, failed: 0 };
    }

    // Već poznati ID-jevi → preskoči (ne diramo obrađene; ne povlačimo XML ponovo).
    const existing = await this.prisma.sefIncomingInvoice.findMany({
      where: { sefPurchaseId: { in: ids } },
      select: { sefPurchaseId: true },
    });
    const known = new Set(existing.map((e) => e.sefPurchaseId));
    const newIds = ids.filter((id) => !known.has(id));

    let created = 0;
    let failed = 0;

    for (const sefPurchaseId of newIds) {
      try {
        const xmlRes = await this.client.getPurchaseInvoiceXml(sefPurchaseId);
        if (!xmlRes.ok || !xmlRes.body) {
          failed++;
          this.logger.warn(
            `Ulazna faktura ${sefPurchaseId}: XML nije preuzet (${
              xmlRes.errorMessage ?? "prazno telo"
            }) — preskačem.`,
          );
          continue;
        }

        const parsed = this.parseUbl(xmlRes.body);
        const dedup = await this.findKufMatch(
          parsed.supplierPib,
          parsed.invoiceNumber,
        );

        // ROK (15 dana) zakonski teče od PRIJEMA fakture na SEF. Pravo SEF polje
        // prijema još nemamo na dev ključu, pa je osnov KONZERVATIVNA aproksimacija =
        // cbc:IssueDate (datum izdavanja): izdavanje je uvek ≤ prijem na SEF, pa je
        // ovako izračunat rok NIKAD duži od zakonskog (može biti par dana stroži —
        // bezbedno). Ranije se uzimao cbc:ActualDeliveryDate (datum PROMETA robe) uz
        // fallback now-pri-pull → pogrešan (istekao/predug) rok. Fallback ostaje samo
        // ako ni IssueDate nema: now (uz WARN) — tada je rok predug (now ≥ prijem), ali
        // bez ijednog datuma nema boljeg osnova.
        // TODO: kad se na prod ključu potvrdi SEF polje datuma prijema, popuni njime
        //       deliveryDate (šema = „datum prijema na SEF") i preračunaj acceptDeadline.
        let deadlineBasis = parsed.issueDate;
        if (!deadlineBasis) {
          this.logger.warn(
            `Ulazna faktura ${sefPurchaseId}: nema cbc:IssueDate — rok računam od sada (može biti duži od zakonskog).`,
          );
          deadlineBasis = new Date();
        }
        const acceptDeadline = addDays(deadlineBasis, ACCEPT_DEADLINE_DAYS);

        // Upsert (a ne create) štiti od paralelnog dupliranja na @@unique(sefPurchaseId);
        // update je no-op — idempotentan re-pull ne dira postojeći (možda obrađen) red.
        await this.prisma.sefIncomingInvoice.upsert({
          where: { sefPurchaseId },
          create: {
            sefPurchaseId,
            supplierPib: parsed.supplierPib,
            supplierName: parsed.supplierName,
            invoiceNumber: parsed.invoiceNumber,
            issueDate: parsed.issueDate,
            // deliveryDate = „datum prijema na SEF" (šema), NE datum prometa robe
            // (cbc:ActualDeliveryDate). Pravo SEF polje prijema nemamo na dev ključu →
            // ostavi null (ceo UBL je u rawXml); popuniti kad se potvrdi na prod ključu.
            deliveryDate: null,
            dueDate: parsed.dueDate,
            totalAmount: parsed.totalAmount,
            vatAmount: parsed.vatAmount,
            currency: parsed.currency,
            status: "NEW",
            acceptDeadline,
            alreadyExists: dedup.alreadyExists,
            matchedKufEntryId: dedup.matchedKufEntryId,
            rawXml: xmlRes.body,
          },
          update: {},
        });
        created++;
      } catch (err) {
        failed++;
        this.logger.warn(
          `Ulazna faktura ${sefPurchaseId}: obrada nije uspela — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return {
      dryRun: false,
      totalIds: ids.length,
      created,
      skipped: ids.length - newIds.length,
      failed,
    };
  }

  /**
   * Lista ulaznih faktura, sortirana po roku (acceptDeadline asc). `daysLeft` je
   * izračunat broj preostalih dana (može biti negativan = rok istekao).
   * `deadlineSoon` → samo neobrađene kojima rok ističe u narednih {DEADLINE_SOON_DAYS} dana.
   */
  async list(q: {
    status?: string;
    deadlineSoon?: boolean;
  }): Promise<SefIncomingListItem[]> {
    const where: Prisma.SefIncomingInvoiceWhereInput = {};
    if (q.status) where.status = q.status;
    if (q.deadlineSoon) {
      where.acceptDeadline = { lte: addDays(new Date(), DEADLINE_SOON_DAYS) };
      // Rok je bitan samo dok nije odgovoreno — filtriraj neobrađene (osim ako je
      // korisnik eksplicitno tražio drugi status).
      where.status = q.status ?? { in: [...ACTIONABLE_STATUSES] };
    }

    const rows = await this.prisma.sefIncomingInvoice.findMany({
      where,
      orderBy: [{ acceptDeadline: "asc" }, { id: "asc" }],
    });

    const now = Date.now();
    return rows.map((r) => ({ ...r, daysLeft: daysLeft(r.acceptDeadline, now) }));
  }

  /**
   * Prihvati ulaznu fakturu. SEF poziv (accept) ide PRE lokalnog commit-a:
   * ako SEF odbije → status se ne menja. DRY-RUN preskače SEF poziv (status se
   * menja lokalno) uz napomenu u odgovoru.
   */
  async accept(id: number, userId: number): Promise<SefIncomingActionResult> {
    const entry = await this.getActionable(id);
    const res = await this.client.acceptRejectPurchaseInvoice(
      entry.sefPurchaseId,
      true,
    );
    return this.commitAction(entry, "ACCEPTED", null, userId, res);
  }

  /**
   * Odbij ulaznu fakturu (razlog obavezan). SEF poziv (reject + comment) ide
   * PRE lokalnog commit-a; DRY-RUN preskače poziv uz napomenu.
   */
  async reject(
    id: number,
    comment: string,
    userId: number,
  ): Promise<SefIncomingActionResult> {
    const entry = await this.getActionable(id);
    const res = await this.client.acceptRejectPurchaseInvoice(
      entry.sefPurchaseId,
      false,
      comment,
    );
    return this.commitAction(entry, "REJECTED", comment, userId, res);
  }

  /**
   * Označi fakturu kao pregledanu (NEW → SEEN). Opciono (doc 07 §5). Ne dira
   * već obrađene (ACCEPTED/REJECTED) ni već pregledane.
   */
  async markSeen(id: number): Promise<SefIncomingInvoice> {
    await this.prisma.sefIncomingInvoice.updateMany({
      where: { id, status: "NEW" },
      data: { status: "SEEN" },
    });
    const entry = await this.prisma.sefIncomingInvoice.findUnique({
      where: { id },
    });
    if (!entry) {
      throw new NotFoundException(`Ulazna faktura ${id} ne postoji.`);
    }
    return entry;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Interno
  // ───────────────────────────────────────────────────────────────────────────

  /** Učitaj fakturu i potvrdi da je u statusu iz kog je akcija dozvoljena. */
  private async getActionable(id: number): Promise<SefIncomingInvoice> {
    const entry = await this.prisma.sefIncomingInvoice.findUnique({
      where: { id },
    });
    if (!entry) {
      throw new NotFoundException(`Ulazna faktura ${id} ne postoji.`);
    }
    if (!ACTIONABLE_STATUSES.includes(entry.status as "NEW" | "SEEN")) {
      throw new ConflictException(
        `Ulazna faktura je u statusu "${entry.status}" — prihvatanje/odbijanje nije moguće.`,
      );
    }
    return entry;
  }

  /**
   * CAS commit statusnog prelaza posle SEF poziva. Ako SEF poziv nije DRY-RUN i
   * nije uspeo — baca (status ostaje). updateMany sa status-guard-om sprečava
   * dvostruku obradu (paralelna akcija → count 0 → Conflict).
   */
  private async commitAction(
    entry: SefIncomingInvoice,
    newStatus: "ACCEPTED" | "REJECTED",
    comment: string | null,
    userId: number,
    res: { ok: boolean; dryRun?: boolean; errorMessage?: string },
  ): Promise<SefIncomingActionResult> {
    if (!res.dryRun && !res.ok) {
      throw new ServiceUnavailableException(
        res.errorMessage ?? "SEF nije prihvatio odgovor na ulaznu fakturu.",
      );
    }

    const cas = await this.prisma.sefIncomingInvoice.updateMany({
      where: { id: entry.id, status: { in: [...ACTIONABLE_STATUSES] } },
      data: {
        status: newStatus,
        rejectComment: comment,
        actionByUserId: userId,
        actionAt: new Date(),
      },
    });
    if (cas.count !== 1) {
      throw new ConflictException(
        "Ulazna faktura je u međuvremenu već obrađena (paralelna akcija).",
      );
    }

    const invoice = await this.prisma.sefIncomingInvoice.findUniqueOrThrow({
      where: { id: entry.id },
    });
    return {
      invoice,
      dryRun: res.dryRun === true,
      note: res.dryRun
        ? "DRY-RUN: SEF_API_KEY nije podešen — status je promenjen lokalno, ali odgovor NIJE poslat na SEF."
        : undefined,
    };
  }

  /**
   * DEDUP: da li već imamo fakturu u KUF evidenciji. PIB → komitent
   * (customers.tax_id) → KUF red (vat_ledger_entries, direction=input) sa istim
   * partnerId i documentNumber == invoiceNumber. Vraća meki ref na KUF red.
   */
  private async findKufMatch(
    supplierPib: string,
    invoiceNumber: string,
  ): Promise<{ alreadyExists: boolean; matchedKufEntryId: number | null }> {
    if (!supplierPib || !invoiceNumber) {
      return { alreadyExists: false, matchedKufEntryId: null };
    }

    const customer = await this.prisma.customer.findFirst({
      where: { taxId: supplierPib },
      select: { id: true },
    });
    if (!customer) {
      return { alreadyExists: false, matchedKufEntryId: null };
    }

    const kuf = await this.prisma.vatLedgerEntry.findFirst({
      where: {
        direction: "input",
        partnerId: customer.id,
        documentNumber: invoiceNumber,
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    return kuf
      ? { alreadyExists: true, matchedKufEntryId: kuf.id }
      : { alreadyExists: false, matchedKufEntryId: null };
  }

  /**
   * Minimalni izvlakač iz UBL-a (regex; bez UBL lib zavisnosti). Uzima podatke
   * DOBAVLJAČA iz cac:AccountingSupplierParty bloka, a iznose/datume/broj sa
   * nivoa dokumenta. Nedostajuća polja → null / 0 / "" (ceo XML je u rawXml).
   */
  private parseUbl(xml: string): ParsedUblInvoice {
    const supplierBlock = extractTag(xml, "cac:AccountingSupplierParty") ?? xml;

    // PIB: prvo EndpointID schemeID=9948 (Srbija), pa prvi cbc:CompanyID u bloku.
    const supplierPib = normalizePib(
      attrTagValue(supplierBlock, "cbc:EndpointID", "schemeID", "9948") ??
        firstTag(supplierBlock, "cbc:CompanyID") ??
        "",
    );
    const supplierName =
      firstTag(supplierBlock, "cbc:RegistrationName") ??
      firstTag(supplierBlock, "cbc:Name") ??
      null;

    // Broj fakture: prvi cbc:ID na nivou dokumenta (UBL redosled: posle
    // UBLVersionID/CustomizationID, pre strana).
    const invoiceNumber = firstTag(xml, "cbc:ID") ?? "";

    const issueDate = parseDate(firstTag(xml, "cbc:IssueDate"));
    const dueDate = parseDate(firstTag(xml, "cbc:DueDate"));
    // cbc:ActualDeliveryDate (datum prometa robe) se NAMERNO ne parsira: nije osnov
    // roka (rok teče od prijema na SEF, v. pull) niti „datum prijema na SEF" iz šeme.

    const totalAmount = toDecimal(firstTag(xml, "cbc:PayableAmount"));
    const currency =
      attrOfFirst(xml, "cbc:PayableAmount", "currencyID") ??
      firstTag(xml, "cbc:DocumentCurrencyCode") ??
      "RSD";

    // PDV: cac:TaxTotal/cbc:TaxAmount (ukupan, ne po stavci).
    const taxTotalBlock = extractTag(xml, "cac:TaxTotal");
    const vatAmount = toDecimal(
      taxTotalBlock ? firstTag(taxTotalBlock, "cbc:TaxAmount") : undefined,
    );

    return {
      supplierPib,
      supplierName,
      invoiceNumber,
      issueDate,
      dueDate,
      totalAmount,
      vatAmount,
      currency: currency.trim().slice(0, 3).toUpperCase() || "RSD",
    };
  }
}

// ── Čiste pomoćne funkcije (bez stanja) ──────────────────────────────────────

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * MS_PER_DAY);
}

function daysLeft(deadline: Date | null, nowMs: number): number | null {
  if (!deadline) return null;
  return Math.ceil((deadline.getTime() - nowMs) / MS_PER_DAY);
}

/** Regex-escape za imena tagova (cbc:/cac: nemaju metaznakove, ali za svaki slučaj). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Unutrašnjost prvog `<tag ...>...</tag>` (bez tagova), ne-dekodirano. */
function extractTag(xml: string, tag: string): string | undefined {
  const t = escapeRe(tag);
  const re = new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`, "i");
  return re.exec(xml)?.[1];
}

/** Tekst prvog pojavljivanja leaf-taga, trimovan i XML-dekodiran. */
function firstTag(xml: string, tag: string): string | undefined {
  const inner = extractTag(xml, tag);
  if (inner === undefined) return undefined;
  const v = decodeXml(inner.trim());
  return v.length > 0 ? v : undefined;
}

/** Tekst taga koji ima traženi atribut sa tačnom vrednošću (npr. schemeID="9948"). */
function attrTagValue(
  xml: string,
  tag: string,
  attr: string,
  attrValue: string,
): string | undefined {
  const t = escapeRe(tag);
  const a = escapeRe(attr);
  const v = escapeRe(attrValue);
  const re = new RegExp(
    `<${t}\\b[^>]*\\b${a}="${v}"[^>]*>([\\s\\S]*?)</${t}>`,
    "i",
  );
  const m = re.exec(xml);
  if (!m) return undefined;
  const decoded = decodeXml(m[1].trim());
  return decoded.length > 0 ? decoded : undefined;
}

/** Vrednost atributa prvog pojavljivanja taga (npr. currencyID na PayableAmount). */
function attrOfFirst(xml: string, tag: string, attr: string): string | undefined {
  const t = escapeRe(tag);
  const a = escapeRe(attr);
  const re = new RegExp(`<${t}\\b[^>]*\\b${a}="([^"]*)"`, "i");
  return re.exec(xml)?.[1];
}

function parseDate(v?: string): Date | null {
  if (!v) return null;
  const ms = Date.parse(v.trim());
  return Number.isNaN(ms) ? null : new Date(ms);
}

function toDecimal(v?: string): Prisma.Decimal {
  if (!v) return new Prisma.Decimal(0);
  const cleaned = v.trim().replace(/\s/g, "");
  try {
    return new Prisma.Decimal(cleaned);
  } catch {
    return new Prisma.Decimal(0);
  }
}

/** Normalizuj PIB: skini vodeći "9948:"/"RS" prefiks i beline. */
function normalizePib(raw: string): string {
  return raw
    .trim()
    .replace(/^(9948:|RS)[:\s]*/i, "")
    .trim();
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
