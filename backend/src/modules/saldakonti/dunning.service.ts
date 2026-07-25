import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { MailService } from "../../common/mail/mail.service";
import { OpenItemsService, type OpenItem } from "./open-items.service";
import { DunningPdfService } from "./dunning-pdf.service";

/**
 * DUNNING SERVICE — automatske opomene (Talas 3 B6).
 * =========================================================================
 * Nivo opomene se izvodi iz aging-a otvorenih potraživanja (isti izveden pogled
 * `OpenItemsService` kao `agingByPartner`/dashboard) po NAJSTARIJEM kašnjenju
 * dospele stavke komitenta:
 *   nivo 1 = 15–30 dana docnje, nivo 2 = 31–60, nivo 3 = 61+.
 * Dunning je nad POTRAŽIVANJIMA (side=receivable, dugovni saldo) — kupci koji
 * nama duguju; stavke bez dospeća ili sa potražnim saldom se ne opominju.
 *
 * SLANJE upisuje `DunningNotice` red (evidencija) i šalje PDF pregled dospelih
 * stavki kroz `MailService` (DRY-RUN kad Resend ključ fali → sentOk=false, red
 * se ipak upisuje). ANTI-DUPLO: isti komitent + isti nivo već upisan ISTOG DANA
 * daje 409 (sa vremenom prethodnog slanja) — sprečava dvostruku opomenu.
 *
 * NOVAC: Prisma.Decimal (NIKAD Float). Envelope { data } radi kontroler.
 */

const D = Prisma.Decimal;

// Pragovi nivoa u danima kašnjenja (najstarija dospela stavka komitenta).
const LEVEL1_MIN_DAYS = 15;
const LEVEL2_MIN_DAYS = 31;
const LEVEL3_MIN_DAYS = 61;
const MAX_LEVEL = 3;
// Masovno slanje: najviše komitenata po pozivu (ostatak se šalje sledećim pozivom).
const BATCH_LIMIT = 50;

/** Kandidat za opomenu (READ) — izveden iz aging-a + istorije opomena. */
export interface DunningCandidate {
  partnerId: number;
  partnerName: string | null;
  /** Mejl komitenta iz šifarnika (prefill primaoca); null ako ga nema. */
  email: string | null;
  /** Dospelo (Σ dugovnih salda dospelih stavki) — Decimal (JSON string). */
  overdueAmount: Prisma.Decimal;
  /** Najstarije kašnjenje u danima. */
  daysOverdue: number;
  /** Izvedeni nivo 1|2|3. */
  level: number;
  /** Poslednja opomena bilo kog nivoa (ISO) ili null. */
  lastSentAt: string | null;
  lastSentLevel: number | null;
  /** Da li je opomena OVOG nivoa već upisana danas (batch/pojedinačno preskače). */
  alreadySentToday: boolean;
}

/** Rezultat pojedinačnog slanja. */
export interface DunningSendResult {
  noticeId: number;
  partnerId: number;
  level: number;
  to: string;
  /** false = DRY-RUN (Resend nije podešen) ili neuspeh slanja; red je ipak upisan. */
  sentOk: boolean;
  fileName: string;
  daysOverdue: number;
  overdueAmount: Prisma.Decimal;
}

/** Rezultat masovnog slanja. */
export interface DunningBatchResult {
  sent: number;
  skipped: number;
  failed: number;
}

@Injectable()
export class DunningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly openItems: OpenItemsService,
    private readonly dunningPdf: DunningPdfService,
  ) {}

  // --------------------------------------------------------------- kandidati

  /**
   * Kandidati za opomenu na dan preseka (`asOf` default danas). Grupiše otvorene
   * potraživane stavke po komitentu, izvodi nivo iz najstarijeg kašnjenja i
   * obogaćuje istorijom (poslednja opomena, da li je isti nivo već slat danas).
   * Sortirano po ozbiljnosti (dani kašnjenja opadajuće, pa iznos).
   */
  async candidates(asOf?: Date): Promise<DunningCandidate[]> {
    const cutoff = asOf ?? new Date();
    const items = await this.openItems.listOpenItems(undefined, undefined, cutoff);

    // Grupiši receivable stavke po komitentu (analitička = customers.id).
    const groups = new Map<number, OpenItem[]>();
    for (const it of items) {
      if (it.side !== "receivable") continue;
      if (it.analyticalCode == null) continue;
      const arr = groups.get(it.analyticalCode);
      if (arr) arr.push(it);
      else groups.set(it.analyticalCode, [it]);
    }

    const draft: Array<{
      partnerId: number;
      overdueAmount: Prisma.Decimal;
      daysOverdue: number;
      level: number;
    }> = [];
    for (const [partnerId, grpItems] of groups) {
      const { overdueAmount, maxDays } = aggregateOverdue(grpItems);
      const level = levelForDays(maxDays);
      if (level === 0) continue; // ispod praga nivoa 1 (nije kandidat)
      draft.push({ partnerId, overdueAmount, daysOverdue: maxDays, level });
    }

    if (draft.length === 0) return [];

    const partnerIds = draft.map((d) => d.partnerId);
    const [profiles, history] = await Promise.all([
      this.loadProfiles(partnerIds),
      this.loadHistory(partnerIds),
    ]);

    const candidates: DunningCandidate[] = draft.map((d) => {
      const last = history.last.get(d.partnerId) ?? null;
      const profile = profiles.get(d.partnerId);
      return {
        partnerId: d.partnerId,
        partnerName: profile?.name ?? null,
        email: profile?.email ?? null,
        overdueAmount: d.overdueAmount,
        daysOverdue: d.daysOverdue,
        level: d.level,
        lastSentAt: last ? last.createdAt.toISOString() : null,
        lastSentLevel: last ? last.level : null,
        alreadySentToday: history.sentTodayKeys.has(dayKey(d.partnerId, d.level)),
      };
    });

    candidates.sort(
      (a, b) =>
        b.daysOverdue - a.daysOverdue ||
        (a.overdueAmount.greaterThan(b.overdueAmount)
          ? -1
          : a.overdueAmount.lessThan(b.overdueAmount)
            ? 1
            : a.partnerId - b.partnerId),
    );
    return candidates;
  }

  // ----------------------------------------------------------------- slanje

  /**
   * Pošalji opomenu jednom komitentu. `level` opciono (default izvedeni iz
   * aging-a); `to` opciono (default mejl komitenta, inače 422). 409 ako je isti
   * nivo već poslat danas.
   */
  async send(
    dto: { partnerId: number; level?: number; to?: string },
    userId?: number,
  ): Promise<DunningSendResult> {
    return this.sendOne(
      { partnerId: dto.partnerId, level: dto.level, to: dto.to },
      userId,
      new Date(),
    );
  }

  /**
   * Masovno slanje: svim kandidatima koji danas nisu dobili opomenu tog nivoa,
   * do `maxLevel` (default 3), najviše {@link BATCH_LIMIT} po pozivu. Ne prekida
   * se na grešci jednog komitenta (bez mejla → failed). Vraća { sent, skipped, failed }.
   */
  async sendBatch(
    dto: { asOf?: Date; maxLevel?: number },
    userId?: number,
  ): Promise<DunningBatchResult> {
    const cutoff = dto.asOf ?? new Date();
    const maxLevel = clampLevel(dto.maxLevel) ?? MAX_LEVEL;
    const cands = (await this.candidates(cutoff)).filter((c) => c.level <= maxLevel);

    const eligible = cands.filter((c) => !c.alreadySentToday);
    // Već poslato danas + preko limita → skipped (biće obrađeni sledećim pozivom).
    let skipped = cands.length - eligible.length;
    const toProcess = eligible.slice(0, BATCH_LIMIT);
    skipped += eligible.length - toProcess.length;

    let sent = 0;
    let failed = 0;
    for (const c of toProcess) {
      try {
        await this.sendOne(
          {
            partnerId: c.partnerId,
            level: c.level,
            precomputed: { overdueAmount: c.overdueAmount, daysOverdue: c.daysOverdue },
          },
          userId,
          cutoff,
        );
        sent += 1;
      } catch (e) {
        // Trka (isti nivo upisan u međuvremenu) → preskoči; ostalo (nema mejla,
        // greška PDF-a) → failed. Batch se NE ruši zbog jednog komitenta.
        if (e instanceof ConflictException) skipped += 1;
        else failed += 1;
      }
    }

    return { sent, skipped, failed };
  }

  // ------------------------------------------------------------ interno slanje

  private async sendOne(
    args: {
      partnerId: number;
      level?: number;
      to?: string;
      precomputed?: { overdueAmount: Prisma.Decimal; daysOverdue: number };
    },
    userId: number | undefined,
    cutoff: Date,
  ): Promise<DunningSendResult> {
    const { partnerId } = args;

    // Dospelo + najstarije kašnjenje (iz snapshot-a ili sveži upit za komitenta).
    let overdueAmount: Prisma.Decimal;
    let maxDays: number;
    if (args.precomputed) {
      overdueAmount = args.precomputed.overdueAmount;
      maxDays = args.precomputed.daysOverdue;
    } else {
      const items = await this.openItems.listOpenItems(undefined, partnerId, cutoff);
      const agg = aggregateOverdue(items);
      overdueAmount = agg.overdueAmount;
      maxDays = agg.maxDays;
    }

    if (!overdueAmount.greaterThan(0)) {
      throw new UnprocessableEntityException(
        "Komitent nema dospelih otvorenih potraživanja — opomena se ne šalje.",
      );
    }

    if (args.level != null) {
      if (!Number.isInteger(args.level) || args.level < 1 || args.level > MAX_LEVEL) {
        throw new BadRequestException(
          `Nivo opomene mora biti 1, 2 ili 3 (dobijeno: ${args.level}).`,
        );
      }
    }
    const level = args.level ?? levelForDays(maxDays);
    if (level < 1) {
      throw new UnprocessableEntityException(
        `Kašnjenje je ispod praga za opomenu (nivo 1 počinje od ${LEVEL1_MIN_DAYS} dana docnje).`,
      );
    }

    // ANTI-DUPLO: isti komitent + nivo već upisan danas (kalendarski dan slanja).
    const { start, end } = dayRange(new Date());
    const existing = await this.prisma.dunningNotice.findFirst({
      where: { partnerId, level, createdAt: { gte: start, lt: end } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (existing) {
      throw new ConflictException(
        `Opomena nivoa ${level} za komitenta ${partnerId} je već poslata danas u ${fmtTime(existing.createdAt)}.`,
      );
    }

    // Primalac: eksplicitni `to` ili mejl komitenta; bez ijednog → 422.
    const customer = await this.prisma.customer.findUnique({
      where: { id: partnerId },
      select: { name: true, email: true },
    });
    const explicit = args.to?.trim();
    const fromCustomer = customer?.email?.trim();
    const to =
      explicit && explicit.length > 0
        ? explicit
        : fromCustomer && fromCustomer.includes("@")
          ? fromCustomer
          : null;
    if (!to) {
      throw new UnprocessableEntityException(
        "Komitent nema e-adresu — navedite primaoca opomene.",
      );
    }

    // PDF pregleda dospelih stavki + mejl (DRY-RUN vraća false, ne baca).
    const { buffer, fileName } = await this.dunningPdf.buildDunningPdf(
      partnerId,
      level,
      cutoff,
    );
    const subject =
      level >= 3
        ? `OPOMENA PRED UTUŽENJE - komitent ${partnerId}`
        : `Opomena za neizmirena dugovanja - komitent ${partnerId}`;
    const html = buildEmailHtml(level, customer?.name ?? null, overdueAmount, maxDays);
    const sentOk = await this.mail.send({
      to,
      subject,
      html,
      attachments: [{ filename: fileName, content: buffer }],
    });

    const notice = await this.prisma.dunningNotice.create({
      data: {
        partnerId,
        level,
        asOf: cutoff,
        overdueAmount,
        daysOverdue: maxDays,
        sentTo: to,
        sentOk,
        note: levelNote(level),
        sentByUserId: userId ?? null,
      },
      select: { id: true },
    });

    return {
      noticeId: notice.id,
      partnerId,
      level,
      to,
      sentOk,
      fileName,
      daysOverdue: maxDays,
      overdueAmount,
    };
  }

  // ------------------------------------------------------------ učitavanje

  /** Nazivi + mejlovi komitenata (meki ref — nepoznati izostaju iz mape). */
  private async loadProfiles(
    ids: number[],
  ): Promise<Map<number, { name: string; email: string | null }>> {
    const map = new Map<number, { name: string; email: string | null }>();
    if (ids.length === 0) return map;
    const customers = await this.prisma.customer.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, email: true },
    });
    for (const c of customers) map.set(c.id, { name: c.name, email: c.email });
    return map;
  }

  /**
   * Istorija opomena za date komitente: poslednja opomena po komitentu (bilo koji
   * nivo) i skup ključeva (komitent:nivo) poslatih DANAS (za alreadySentToday).
   */
  private async loadHistory(ids: number[]): Promise<{
    last: Map<number, { level: number; createdAt: Date }>;
    sentTodayKeys: Set<string>;
  }> {
    const last = new Map<number, { level: number; createdAt: Date }>();
    const sentTodayKeys = new Set<string>();
    if (ids.length === 0) return { last, sentTodayKeys };

    const { start, end } = dayRange(new Date());
    const rows = await this.prisma.dunningNotice.findMany({
      where: { partnerId: { in: ids } },
      orderBy: { createdAt: "desc" },
      select: { partnerId: true, level: true, createdAt: true },
    });
    for (const r of rows) {
      if (!last.has(r.partnerId)) last.set(r.partnerId, { level: r.level, createdAt: r.createdAt });
      if (r.createdAt >= start && r.createdAt < end) {
        sentTodayKeys.add(dayKey(r.partnerId, r.level));
      }
    }
    return { last, sentTodayKeys };
  }
}

// ---------------------------------------------------------------- pomoćne

/** Dospelo (Σ dugovnih salda dospelih receivable stavki) + najstarije kašnjenje. */
function aggregateOverdue(items: OpenItem[]): {
  overdueAmount: Prisma.Decimal;
  maxDays: number;
} {
  let overdueAmount = new D(0);
  let maxDays = 0;
  for (const it of items) {
    if (it.side !== "receivable") continue;
    if (!it.balance.greaterThan(0)) continue; // potražni saldo / preplata se ne opominje
    const days = it.daysOverdue;
    if (days == null || days < 1) continue; // nedospelo / bez dospeća
    overdueAmount = overdueAmount.add(it.balance);
    if (days > maxDays) maxDays = days;
  }
  return { overdueAmount, maxDays };
}

/** Nivo iz najstarijeg kašnjenja; 0 = ispod praga (nije kandidat). */
function levelForDays(days: number): number {
  if (days >= LEVEL3_MIN_DAYS) return 3;
  if (days >= LEVEL2_MIN_DAYS) return 2;
  if (days >= LEVEL1_MIN_DAYS) return 1;
  return 0;
}

/** Normalizuj eksplicitni maxLevel na 1..3; undefined ostaje undefined. */
function clampLevel(level?: number): number | undefined {
  if (level == null || !Number.isFinite(level)) return undefined;
  const n = Math.trunc(level);
  if (n < 1) return 1;
  if (n > MAX_LEVEL) return MAX_LEVEL;
  return n;
}

function levelNote(level: number): string {
  if (level >= 3) return "Opomena pred utuženje (nivo 3)";
  return `Opomena (nivo ${level})`;
}

function dayKey(partnerId: number, level: number): string {
  return `${partnerId}:${level}`;
}

/** [start, end) kalendarskog dana u lokalnoj zoni servera. */
function dayRange(d: Date): { start: Date; end: Date } {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function fmtTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtMoney(value: Prisma.Decimal): string {
  return value.toFixed(2).replace(".", ",");
}

/** HTML tela mejla po nivou (srpski; bez pretvaranja u Float). */
function buildEmailHtml(
  level: number,
  partnerName: string | null,
  overdueAmount: Prisma.Decimal,
  maxDays: number,
): string {
  const greeting = partnerName ? `<p>Poštovani (${partnerName}),</p>` : `<p>Poštovani,</p>`;
  const amount = `${fmtMoney(overdueAmount)} RSD`;
  const kasnjenje = maxDays > 0 ? ` Najstarije kašnjenje je ${maxDays} dana.` : "";

  let body: string;
  if (level >= 3) {
    body =
      `<p><strong>OPOMENA PRED UTUŽENJE.</strong></p>` +
      `<p>I pored ranijih opomena, dospeli dug u iznosu od <strong>${amount}</strong> do danas nije izmiren.${kasnjenje}</p>` +
      `<p>Ovo je poslednja opomena pre pokretanja postupka prinudne naplate. Ukoliko dug ne bude izmiren u ` +
      `ostavljenom roku, potraživanje ćemo ostvariti sudskim putem, uz obračun zakonske zatezne kamate i ` +
      `troškova postupka. Detaljan pregled dospelih stavki je u prilogu (PDF).</p>`;
  } else if (level === 2) {
    body =
      `<p>Ponovo Vas obaveštavamo da dospele obaveze u iznosu od <strong>${amount}</strong> do danas nisu ` +
      `izmirene.${kasnjenje}</p>` +
      `<p>Molimo Vas da dugovanje izmirite bez odlaganja. Detaljan pregled dospelih stavki je u prilogu (PDF).</p>`;
  } else {
    body =
      `<p>Podsećamo Vas na dospele, a neizmirene obaveze u iznosu od <strong>${amount}</strong>.${kasnjenje}</p>` +
      `<p>Ukoliko ste u međuvremenu izvršili plaćanje, molimo Vas da ovu opomenu zanemarite. U suprotnom, ` +
      `molimo za izmirenje duga u najkraćem roku. Detaljan pregled dospelih stavki je u prilogu (PDF).</p>`;
  }

  return `${greeting}${body}<p>Srdačan pozdrav,<br/>Servoteh</p>`;
}
