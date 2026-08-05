import {
  Injectable,
  Logger,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import {
  DOCUMENT_SERIES_REGISTRY,
  seriesByKey,
  type DocumentSeriesInfo,
} from "../sales/numbering.service";
import {
  assertStartNumberAboveBook,
  bookUsageKey,
  documentNumberOf,
  EMPTY_BOOK_USAGE,
  measureBookUsage,
  measureBookUsageAll,
  twoDigitYear,
  type BookUsage,
} from "../sales/document-number-conflict";
import type { SetLastNumberDto } from "./dto/podesavanja-brojaci.dto";

/**
 * BROJAČI DOKUMENATA — ekran „od kog broja krećemo" (odluka O-F11, 05.08.2026).
 * =============================================================================
 *
 * Vlasnik, doslovno: *„Startni broj moramo da možemo da unesemo negde u podešavanju. U
 * BigBitu sada npr. dupli klik na broj i nosiš podešavanje zadnjeg broja — i IFR i
 * profaktura i ponuda itd."*
 *
 * ── ZAŠTO EKRAN UOPŠTE POSTOJI ────────────────────────────────────────────────
 * Preuzimanje je 01.04.2027 — USRED godine. Izmereno nad uvezenom knjigom 2026: BigBit
 * je već izdao izlazne fakture u TAČNO našem obliku `N/GG` bez vodeće nule (IFR 95
 * različitih brojeva `100/26`–`261/26`, IFUSL 32, IFGP 21; od 2.453 reda oblika `N/26`
 * njih 1.404 bez vodeće nule), tempom 23–49 mesečno. Da 4.0 krene od 1, izdavao bi
 * brojeve koje BigBit u istoj godini već ima — a otvorene stavke se grupišu po
 * `(konto, komitent, broj)` BEZ vrste dokumenta, pa bi se dve različite obaveze tiho
 * spojile u jednu.
 *
 * ── ZAŠTO SE PRIKAZUJU I SERIJE KOJE NEMAJU RED U BAZI ────────────────────────
 * Na produkciji `document_number_sequences` ima **0 redova** — nijedna migracija je ne
 * puni, red nastaje tek pri prvom knjiženju. Da se spisak gradio iz baze, ekran bi bio
 * PRAZNA STRANA baš u trenutku kad startni broj treba upisati, i O-F11 ne bi imala gde
 * da se sprovede. Zato spisak dolazi iz registra u kodu (`DOCUMENT_SERIES_REGISTRY`), a
 * baza samo popunjava vrednosti; serija bez reda se prikazuje kao „još nije izdat
 * nijedan broj" i svejedno prima upis.
 *
 * ── ŠTA ZNAČI „ŠTA KNJIGA VEĆ IMA" ────────────────────────────────────────────
 * Meri se SAMO kupčeva strana knjige (klasa konta 20 — „Potraživanja od kupaca").
 * `ledger_entries.document_number` na ulaznoj fakturi drži DOBAVLJAČEV broj, pa bi
 * merenje nad celom knjigom dalo besmislen rezultat: izmereno na produkciji 05.08.2026,
 * najveći broj oblika `N/26` u celoj knjizi je 138.030 (dobavljačev, konto 270), a na
 * kupčevim kontima 261 — što je tačno naš niz. Puno obrazloženje (i zašto sudar preko
 * klasa konta nije moguć) je u `sales/document-number-conflict.ts`.
 *
 * ── ODAKLE DOLAZI „TRAG IZMENE" ───────────────────────────────────────────────
 * `document_number_sequences.updated_at` NE MOŽE da služi kao trag: numeracija ga menja
 * pri SVAKOM knjiženju, pa bi svaka faktura izgledala kao da je neko dirao podešavanje.
 * Zato se izmena upisuje u `audit_log` (before/after), i to U ISTOJ TRANSAKCIJI sa samom
 * izmenom — globalni `AuditInterceptor` je fire-and-forget i ne zna prethodnu vrednost,
 * pa bi na „sa čega na šta" odgovorio samo pola.
 */

/** `audit_log.entity_type` za izmene brojača — po njemu se čita trag na ekranu. */
export const SEQUENCE_AUDIT_ENTITY = "document_number_sequences";

/** Koliko izmena se vraća uz pregled (trag izmene po redu + zbirna istorija). */
const TRAIL_LIMIT = 50;

/**
 * Podrazumevana firma. Fakturisanje uzima `dto.companyId ?? 0`
 * (`fakturisanje.service.ts`), a `document_number_sequences.company_id` ima default 0 —
 * pa je 0 stvarni niz na kome sistem radi. Ekran to NE sme da „popravi" na najmanji
 * `companies.id`: podesio bi brojač koji niko ne čita, a knjiženje bi i dalje krenulo od 1.
 */
const DEFAULT_COMPANY_ID = 0;

/** Koliko godina unazad ekran nudi (uz tekuću i sledeću). */
const YEARS_BACK = 1;

interface Actor {
  userId?: number | null;
  email?: string | null;
}

/** Jedan red ekrana: serija × godina. */
export interface SequenceRow {
  seriesKey: string;
  seriesLabel: string;
  prefix: string;
  documentTypes: string[];
  year: number;
  companyId: number;
  /** `null` = red u bazi ne postoji (još nije izdat nijedan broj). */
  lastNumber: number | null;
  neverIssued: boolean;
  /** Kako će izgledati SLEDEĆI izdat broj — ono što čovek zapravo proverava. */
  nextNumber: string;
  /** Šta o ovoj seriji već zna glavna knjiga (BigBit istorija + naša knjiženja). */
  book: BookUsage;
  /** Upozorenje kad je brojač ispod knjige (srpski tekst za ekran); `null` = uredno. */
  warning: string | null;
  /** Poslednja izmena OVOG reda kroz ekran (ne kroz knjiženje). */
  lastChange: TrailEntry | null;
}

export interface TrailEntry {
  at: string;
  byEmail: string | null;
  byUserId: number | null;
  from: number | null;
  to: number | null;
  note: string | null;
  seriesKey: string | null;
  year: number | null;
}

@Injectable()
export class DocumentSequencesService {
  private readonly logger = new Logger(DocumentSequencesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Pregled: svaka serija × svaka relevantna godina, sa sledećim brojem i stanjem knjige.
   */
  async overview(companyId?: number | null, year?: number | null) {
    const company = normaliseCompanyId(companyId);
    const [existing, bookAll] = await Promise.all([
      this.prisma.documentNumberSequence.findMany({
        where: { companyId: company },
        select: { documentType: true, year: true, lastNumber: true },
      }),
      // JEDAN prolaz kroz knjigu za ceo ekran (v. `measureBookUsageAll`).
      measureBookUsageAll(this.prisma),
    ]);

    const years = resolveYears(
      existing.map((r) => r.year),
      year,
    );
    const trail = await this.readTrail(company);
    const lastByRow = new Map<string, TrailEntry>();
    for (const t of trail) {
      const key = `${t.seriesKey}|${t.year}`;
      if (!lastByRow.has(key)) lastByRow.set(key, t); // trail je već DESC
    }

    const byKey = new Map(
      existing.map((r) => [`${r.documentType}|${r.year}`, r.lastNumber]),
    );

    const rows: SequenceRow[] = [];
    for (const series of DOCUMENT_SERIES_REGISTRY) {
      for (const y of years) {
        const lastNumber = byKey.get(`${series.key}|${y}`) ?? null;
        const book =
          bookAll.get(bookUsageKey(series.prefix, twoDigitYear(y))) ??
          EMPTY_BOOK_USAGE;
        rows.push({
          seriesKey: series.key,
          seriesLabel: series.label,
          prefix: series.prefix,
          documentTypes: series.documentTypes,
          year: y,
          companyId: company,
          lastNumber,
          neverIssued: lastNumber == null,
          nextNumber: documentNumberOf(series.prefix, (lastNumber ?? 0) + 1, y),
          book,
          warning: buildWarning(lastNumber, book, series, y),
          lastChange: lastByRow.get(`${series.key}|${y}`) ?? null,
        });
      }
    }

    return {
      data: { companyId: company, years, rows, trail },
      meta: {
        /** Ekran nudi ovu vrednost kao predlog kad je brojač ispod knjige. */
        defaultCompanyId: DEFAULT_COMPANY_ID,
        trailLimit: TRAIL_LIMIT,
      },
    };
  }

  /**
   * Upis POSLEDNJEG IZDATOG broja („startni broj"): sledeći dokument dobija +1.
   *
   * Brana pri upisu (v. `assertStartNumberAboveBook`) odbija vrednost nižu od onoga što
   * knjiga već sadrži. Namerno se meri PONOVO, tačnim regexom za tu seriju, a ne uzima
   * vrednost sa ekrana: ekran je star onoliko koliko je prošlo od učitavanja, a noćni
   * BigBit uvoz u međuvremenu dosipa nove stavke.
   */
  async setLastNumber(actor: Actor, dto: SetLastNumberDto) {
    const seriesKey = (dto.seriesKey ?? "").trim();
    const series = seriesByKey(seriesKey);
    if (!series) {
      throw new UnprocessableEntityException(
        `Serija „${seriesKey}" ne postoji u registru numeracije. Dozvoljene su: ` +
          `${DOCUMENT_SERIES_REGISTRY.map((s) => `${s.key} (${s.label})`).join(", ")}. ` +
          `Nova serija se prvo upisuje u DOCUMENT_SERIES (sales/numbering.service.ts).`,
      );
    }

    const year = dto.year;
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new UnprocessableEntityException(
        `Godina „${dto.year}" nije ispravna — očekuje se puna godina (npr. 2027).`,
      );
    }

    const lastNumber = dto.lastNumber;
    if (!Number.isInteger(lastNumber) || lastNumber < 0) {
      throw new UnprocessableEntityException(
        "Poslednji izdati broj mora biti ceo broj, 0 ili veći " +
          "(0 znači da još nijedan broj nije izdat — sledeći je 1).",
      );
    }
    // Gornja granica prati regex brane (7 cifara): veći broj se u knjizi više ne bi
    // prepoznao kao broj te serije, pa bi brana tiho prestala da radi.
    if (lastNumber > 9_999_999) {
      throw new UnprocessableEntityException(
        "Poslednji izdati broj sme imati najviše 7 cifara (do 9.999.999).",
      );
    }

    const company = normaliseCompanyId(dto.companyId);

    // 🔴 BRANA (O-F11): broj koji bi se izdao ne sme već postojati u knjizi.
    const usage = await measureBookUsage(this.prisma, series.prefix, year);
    assertStartNumberAboveBook(lastNumber, usage, series.label, year);

    const note = typeof dto.note === "string" ? dto.note.trim() || null : null;

    // Izmena i njen trag idu u ISTOJ transakciji: podešavanje bez traga (ili trag bez
    // podešavanja) je gore od oba, jer se posle ne zna šta je zaista važilo.
    const result = await this.prisma.$transaction(async (tx) => {
      const before = await tx.documentNumberSequence.findUnique({
        where: {
          documentType_year_companyId: {
            documentType: series.key,
            year,
            companyId: company,
          },
        },
        select: { id: true, lastNumber: true },
      });

      const row = await tx.documentNumberSequence.upsert({
        where: {
          documentType_year_companyId: {
            documentType: series.key,
            year,
            companyId: company,
          },
        },
        create: {
          documentType: series.key,
          year,
          companyId: company,
          lastNumber,
        },
        update: { lastNumber },
        select: {
          id: true,
          documentType: true,
          year: true,
          companyId: true,
          lastNumber: true,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: actor.userId ?? null,
          actorUsername: actor.email ?? null,
          action: "SET_LAST_NUMBER",
          entityType: SEQUENCE_AUDIT_ENTITY,
          entityId: `${series.key}|${year}|${company}`,
          beforeData: { lastNumber: before?.lastNumber ?? null },
          afterData: { lastNumber },
          metadata: {
            seriesKey: series.key,
            seriesLabel: series.label,
            year,
            companyId: company,
            note,
            // Šta je knjiga pokazivala u trenutku odluke — bez ovoga se kasnije ne može
            // proceniti da li je vrednost tada bila tačna.
            bookMaxNumber: usage.maxNumber,
            nextNumber: documentNumberOf(series.prefix, lastNumber + 1, year),
          },
        },
      });

      return row;
    });

    this.logger.log(
      `Brojač „${series.key}" ${year} (firma ${company}) → poslednji izdati ${lastNumber}; ` +
        `sledeći dokument dobija ${documentNumberOf(series.prefix, lastNumber + 1, year)} ` +
        `(${actor.email ?? "nepoznat korisnik"}).`,
    );

    return {
      data: {
        seriesKey: result.documentType,
        seriesLabel: series.label,
        year: result.year,
        companyId: result.companyId,
        lastNumber: result.lastNumber,
        nextNumber: documentNumberOf(
          series.prefix,
          result.lastNumber + 1,
          year,
        ),
        book: usage,
      },
    };
  }

  /** Trag izmene (ko, kad, sa čega na šta) — poslednjih `TRAIL_LIMIT` upisa. */
  private async readTrail(companyId: number): Promise<TrailEntry[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { entityType: SEQUENCE_AUDIT_ENTITY },
      orderBy: { createdAt: "desc" },
      take: TRAIL_LIMIT,
      select: {
        actorUserId: true,
        actorUsername: true,
        beforeData: true,
        afterData: true,
        metadata: true,
        createdAt: true,
        entityId: true,
      },
    });

    return (
      rows
        .map((r) => {
          const meta = asRecord(r.metadata);
          // `entityId` je `serija|godina|firma` — rezerva kad `metadata` nedostaje
          // (stariji red ili ručno ubačen zapis).
          const [idKey, idYear, idCompany] = (r.entityId ?? "").split("|");
          return {
            at: r.createdAt.toISOString(),
            byEmail: r.actorUsername,
            byUserId: r.actorUserId,
            from: numOrNull(asRecord(r.beforeData)?.lastNumber),
            to: numOrNull(asRecord(r.afterData)?.lastNumber),
            note: typeof meta?.note === "string" ? meta.note : null,
            seriesKey:
              typeof meta?.seriesKey === "string"
                ? meta.seriesKey
                : (idKey ?? null),
            year: numOrNull(meta?.year) ?? numOrNull(idYear),
            companyId: numOrNull(meta?.companyId) ?? numOrNull(idCompany),
          };
        })
        // `companyId` služi samo za filtriranje (trag se čita po firmi koju ekran gleda) i
        // ne izlazi napolje — svaki red već pripada toj firmi, pa bi kolona bila šum.
        .filter((t) => t.companyId == null || t.companyId === companyId)
        .map((t): TrailEntry => {
          const { companyId: _ignored, ...rest } = t;
          void _ignored;
          return rest;
        })
    );
  }
}

// -------------------------------------------------------------------- pomoćno

function normaliseCompanyId(companyId?: number | null): number {
  return Number.isInteger(companyId) && (companyId as number) >= 0
    ? (companyId as number)
    : DEFAULT_COMPANY_ID;
}

/**
 * Koje godine ekran prikazuje: tekuća i sledeća (preuzimanje je 01.04.2027, pa se
 * sledeća godina podešava UNAPRED), prethodna radi uvida, plus svaka godina koja već
 * ima red u bazi. Ograničeno namerno — svaka godina je red po seriji na ekranu.
 */
function resolveYears(existing: number[], requested?: number | null): number[] {
  if (Number.isInteger(requested)) return [requested as number];
  const now = new Date().getFullYear();
  const set = new Set<number>([now - YEARS_BACK, now, now + 1, ...existing]);
  return [...set].sort((a, b) => b - a);
}

/**
 * Upozorenje na ekranu kad brojač zaostaje za knjigom. NE baca izuzetak: pregled mora da
 * se otvori i onda (naročito onda) kad je stanje loše — inače čovek koji dolazi da to
 * popravi dobije grešku umesto ekrana na kom se popravlja.
 */
function buildWarning(
  lastNumber: number | null,
  book: BookUsage,
  series: DocumentSeriesInfo,
  year: number,
): string | null {
  if (book.maxSeq == null) return null;
  const effective = lastNumber ?? 0;
  if (effective >= book.maxSeq) return null;
  return (
    `Brojač zaostaje za knjigom: sledeći dokument bi dobio broj ` +
    `„${documentNumberOf(series.prefix, effective + 1, year)}", a glavna knjiga već sadrži ` +
    `„${book.maxNumber}". Upišite ${book.maxSeq} kao poslednji izdati broj — sledeći ` +
    `dokument tada dobija prvi slobodan broj.`
  );
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))
    return Number(v);
  return null;
}
