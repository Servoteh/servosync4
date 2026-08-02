import { businessYear } from "../../common/business-date";
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  BankStatementParserService,
  type ParsedStatementLine,
} from "./bank-statement-parser.service";
// FX kursni servis PRAVI drugi agent (E6a) po dogovorenom kontraktu:
//   class ExchangeRateService, resolve(currency, on, "sell"|"middle"|"buy")
//   → { rate: Prisma.Decimal, rateDate: Date } | throws NotFoundException.
// Registracija providera u izvodi.module.ts radi integrator (moduleRegistrations).
import { ExchangeRateService } from "./exchange-rate.service";
import {
  type ImportStatementDto,
  validateImportStatement,
} from "./dto/import-statement.dto";
import {
  type PostStatementDto,
  validatePostStatement,
} from "./dto/post-statement.dto";
import {
  type CreateStatementLineDto,
  type UpdateStatementLineDto,
  validateCreateStatementLine,
  validateUpdateStatementLine,
} from "./dto/statement-line.dto";
import { parseReference } from "./reference-parser.util";

const D = Prisma.Decimal;
const ZERO = new D(0);
// Kontrola prometa/salda (B3): dozvoljeno odstupanje pola pare (Decimal je egzaktan,
// tolerancija samo apsorbuje zaokruživanje deviznog preračuna na 2 decimale).
const CONTROL_TOLERANCE = new D("0.005");

/**
 * BANK STATEMENT SERVICE — uvoz + uparivanje + auto-knjiženje izvoda (Faza 4 §B).
 * =============================================================================
 * Tok (doc 21 §A): import TXT (parser fiksne kolone) → BankStatement(IMPORTED) + linije →
 *   matchLines (žiro komitenta → analitika; otvorena stavka po PNB/iznosu) →
 *   postStatement (dvojno knjiženje banka↔analitika pod JEDNIM nalogom) → status POSTED.
 *
 * Izvod se NE knjiži kroz "Šemu za kontiranje" (to je za fakture) — direktno banka↔analitika
 * (doc 21 §A). Zato ovaj servis kreira JournalEntry+LedgerEntry direktno (ne preko
 * PostingEngineService.postFromStockDocument, koji je vezan za robni dokument).
 *
 * Poslovne greške = NestJS ugrađeni exception-i (404/409/422), kao ostatak repoa.
 */
@Injectable()
export class BankStatementService {
  private readonly logger = new Logger(BankStatementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly parser: BankStatementParserService,
    private readonly exchangeRates: ExchangeRateService,
  ) {}

  // ── UVOZ ────────────────────────────────────────────────────────────────

  /**
   * Uvezi izvod iz TXT sadržaja: parsiraj → kreiraj BankStatement(IMPORTED) + linije.
   * Idempotencija: (bankAccount, statementNumber) je unique — ponovni uvoz istog izvoda → 409.
   */
  async importStatement(dto: ImportStatementDto, actor?: AuthUser) {
    validateImportStatement(dto);

    // TXT je opcion: bez njega se kreira PRAZAN izvod za ručni unos (E6 devizni izvod —
    // parser je RSD-only, pa se devizne stavke kucaju ručno). Ako TXT postoji, mora dati
    // bar jednu parsabilnu stavku (nepromenjeno ponašanje uvoza).
    const hasTxt =
      typeof dto.txtContent === "string" && dto.txtContent.trim().length > 0;
    const parsed = hasTxt ? this.parser.parse(dto.txtContent as string) : [];
    if (hasTxt && parsed.length === 0) {
      throw new UnprocessableEntityException(
        "Izvod ne sadrži nijednu parsabilnu stavku (proverite format/kolone).",
      );
    }

    const existing = await this.prisma.bankStatement.findUnique({
      where: {
        bankAccount_statementNumber: {
          bankAccount: dto.bankAccount,
          statementNumber: dto.statementNumber,
        },
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        `Izvod ${dto.statementNumber} za račun ${dto.bankAccount} je već uvezen (id ${existing.id}).`,
      );
    }

    return this.prisma.bankStatement.create({
      data: {
        bankAccount: dto.bankAccount,
        statementNumber: dto.statementNumber,
        statementDate: new Date(dto.statementDate),
        importedFileName: dto.fileName ?? null,
        status: "IMPORTED",
        openingBalance:
          dto.openingBalance !== undefined ? new D(dto.openingBalance) : ZERO,
        closingBalance:
          dto.closingBalance !== undefined ? new D(dto.closingBalance) : ZERO,
        currency: dto.currency ?? "RSD",
        createdByUserId: actor?.userId ?? null,
        lines:
          parsed.length > 0
            ? {
                create: parsed.map((l: ParsedStatementLine) => ({
                  lineNo: l.lineNo,
                  partnerAccount: l.partnerAccount,
                  partnerName: l.partnerName,
                  amount: l.amount,
                  direction: l.direction,
                  referenceNumber: l.referenceNumber,
                  documentDate: l.documentDate,
                  status: "UNMATCHED",
                })),
              }
            : undefined,
      },
      include: { lines: { where: { deletedAt: null }, orderBy: { lineNo: "asc" } } },
    });
  }

  /**
   * Preview: parsiraj TXT bez upisa (dry-run) — za ekran pregleda pre uvoza.
   * Vraća stavke sa iznosom kao string (Decimal u JSON-u = string, BACKEND_RULES §6).
   */
  previewParse(txtContent: string) {
    const parsed = this.parser.parse(txtContent);
    return {
      count: parsed.length,
      lines: parsed.map((l) => ({
        lineNo: l.lineNo,
        partnerAccount: l.partnerAccount,
        partnerName: l.partnerName,
        amount: l.amount.toFixed(2),
        direction: l.direction,
        referenceNumber: l.referenceNumber,
        model: l.model, // Model PNB-a (97/11/99) — vidljiv u pregledu; ne persistuje se
        documentDate: l.documentDate,
      })),
    };
  }

  // ── UPARIVANJE ────────────────────────────────────────────────────────────

  /**
   * Za svaku UNMATCHED liniju: (1) upari komitenta po žiro računu (Customer.bankAccount1/2/3),
   * meki fallback po nazivu; (2) upari otvorenu stavku (LedgerEntry, reconciledAt IS NULL) po
   * (komitent, referenceNumber == documentNumber) → fallback po iznosu. Update matchedCustomerId
   * / matchedLedgerEntryId / status=MATCHED.
   *
   * `matchedLedgerEntryId` NIJE ukras: od nalaza N1 (03.08.2026) to je izvor broja dokumenta
   * koji `postStatement` upisuje u glavnu knjigu (v. `resolvePostingDocumentNumbers`).
   */
  async matchLines(statementId: number) {
    const statement = await this.getStatementOrThrow(statementId);
    if (statement.status === "POSTED") {
      throw new ConflictException(
        `Izvod ${statementId} je već proknjižen — uparivanje nije dozvoljeno.`,
      );
    }

    let matched = 0;
    for (const line of statement.lines) {
      if (line.status === "POSTED") continue;

      const customerId = await this.matchCustomer(
        line.partnerAccount,
        line.partnerName,
      );
      const ledgerEntryId =
        customerId != null
          ? await this.matchOpenItem(customerId, line.referenceNumber, line.amount)
          : null;

      const newStatus = customerId != null ? "MATCHED" : "UNMATCHED";
      if (customerId != null) matched += 1;

      await this.prisma.bankStatementLine.update({
        where: { id: line.id },
        data: {
          matchedCustomerId: customerId,
          matchedLedgerEntryId: ledgerEntryId,
          status: newStatus,
        },
      });
    }

    return this.getStatement(statementId).then((s) => ({
      ...s,
      matchedCount: matched,
    }));
  }

  /**
   * Uparivanje komitenta po žiro računu. Customer nema jednu "žiro" kolonu nego TRI:
   * `bankAccount1`, `bankAccount2`, `bankAccount3` (mapirano na bank_account_1/2/3).
   * Poredimo po ciframa (izbacimo razmake/crte). Ako nema pogotka → meki fallback po nazivu
   * (case-insensitive contains) uz TODO (naziv nije pouzdan ključ).
   */
  private async matchCustomer(
    partnerAccount: string | null,
    partnerName: string | null,
  ): Promise<number | null> {
    if (partnerAccount) {
      const normalized = partnerAccount.replace(/\D/gu, "");
      if (normalized.length > 0) {
        // Prisma nema "normalizovan po ciframa" upit → povučemo kandidate po sirovom
        // prefiksu i uporedimo u aplikaciji. Sirovi zapisi u BigBit-u imaju crte/razmake.
        const candidates = await this.prisma.customer.findMany({
          where: {
            OR: [
              { bankAccount1: { contains: normalized.slice(0, 6) } },
              { bankAccount2: { contains: normalized.slice(0, 6) } },
              { bankAccount3: { contains: normalized.slice(0, 6) } },
            ],
          },
          select: {
            id: true,
            bankAccount1: true,
            bankAccount2: true,
            bankAccount3: true,
          },
          take: 50,
        });
        const hit = candidates.find((c) =>
          [c.bankAccount1, c.bankAccount2, c.bankAccount3].some(
            (a) => a != null && a.replace(/\D/gu, "") === normalized,
          ),
        );
        if (hit) return hit.id;
      }
    }

    // TODO(uparivanje): naziv nije pouzdan ključ (duplikati/skraćenice) — meki fallback,
    // uparuje samo kad je JEDINSTVEN pogodak.
    if (partnerName && partnerName.trim().length >= 3) {
      const byName = await this.prisma.customer.findMany({
        where: { name: { contains: partnerName.trim(), mode: "insensitive" } },
        select: { id: true },
        take: 2,
      });
      if (byName.length === 1) return byName[0].id;
    }

    return null;
  }

  /**
   * Uparivanje otvorene stavke (LedgerEntry): analitika = komitent, reconciledAt IS NULL,
   * nalog proknjižen (journalEntry.status posted/locked). Prvo po broju dokumenta iz
   * poziva na broj (uplata nosi broj fakture, doc 21 §A / PLAN §A) — više NIJE egzaktno
   * poređenje nego FX_OdrediBrojDokumenta port: `parseReference` iz PNB-a izvuče uređene
   * kandidate (sirov trim, bez modela 97 kontrolnog broja, segmenti po crticama/kosim
   * crtama, bez vodećih nula, broj/godina), pa biramo pogodak po prioritetu kandidata
   * (prvi = sirov trim = egzaktan → nema regresije). Fallback po iznosu ostaje.
   *
   * MODEL: BankStatementLine nema kolonu za model (ne persistuje se), pa se model-97
   * skidanje oslanja na inline „97"+KK detekciju iz sirovog PNB-a; `model` param je
   * opcion za pozivaoce koji ga imaju (npr. iz parse toka).
   */
  private async matchOpenItem(
    customerId: number,
    referenceNumber: string | null,
    amount: Prisma.Decimal,
    model?: string | null,
  ): Promise<number | null> {
    const baseWhere: Prisma.LedgerEntryWhereInput = {
      analyticalCode: customerId,
      reconciledAt: null,
      journalEntry: { is: { status: { in: ["POSTED", "LOCKED"] } } },
    };

    const { candidates } = parseReference(referenceNumber, model);
    if (candidates.length > 0) {
      // ⚠️ POGODAK JE SAMO PO BROJU — vrste dokumenta u `ledger_entries` nema. Da
      // uplata ne bi zatvorila POGREŠAN dokument istog kupca, brojevi moraju biti
      // razdvojeni već u numeraciji: izlazne fakture dele jedan niz, a svaka druga
      // vrsta ima svoju seriju u samom broju — `A-N/GG` avans, `PROF-N/GG` predračun,
      // `PON-`, `REV-` (O-F5/O-F6/O-F7). Bez toga bi PNB `7/26` mogao da padne na avans
      // umesto na fakturu — koji od ta dva, zavisilo bi od redosleda redova u bazi.
      // Razdvajanje u numeraciji drži samo dok ga parser poštuje: PNB `A-7/26` je do
      // 02.08.2026. proizvodio i kandidata `7/26`, pa je uplata na avans mogla da sedne
      // na fakturu čim se avansna stavka zatvori. Sada svaki izveden kandidat NOSI
      // prefiks serije (`reference-parser.util.ts` → `SERIES`), a oznaka serije se
      // traži po ZNAČENJU i bilo gde u PNB-u: i `AVANS 1/26`, `AVR 1/26`, `A) 1/26` i
      // `po avansu A-1/26` su do istog datuma davali goli `1/26` (izmereno), pa je
      // uplata na avans zatvarala fakturu istog kupca.
      //
      // TREĆI izvor lažnog pogotka je ZATEČENI BIGBIT BROJ (nalaz V1, 02.08.2026).
      // BigBit i 4.0 rade paralelno do cutovera (april 2027) i kupci plaćaju i stare
      // dokumente, a parser je stari broj NORMALIZOVAO u naš: `0012-26` → `12/26`,
      // `AVR-00001/2026` → `A-1/26`, `AR-00001/2025` → `1/25`, `PON-00285/2026` →
      // `PON-285/26`. Vodeće nule i šifra vrste uz crticu su potpis STAROG broja, pa
      // izveden kandidat više ne sme da se izjednači sa našim novim brojem.
      //
      // Drugi izvor lažnog pogotka je bio sam PNB: kad platilac umesto broja fakture
      // upiše DATUM (`12-08-26`), `parseReference` je od njega pravio kandidat `8/26`
      // i uplata je sletala na tuđu fakturu. To se sada odbija u parseru
      // (`reference-parser.util.ts` → `isDateTriplet`), pa takva uplata pošteno padne
      // na fallback po iznosu ispod.
      //
      // Jedan upit po SVIM kandidatima; pogodak biramo po prioritetu (prvi kandidat prvi).
      const rows = await this.prisma.ledgerEntry.findMany({
        where: { ...baseWhere, documentNumber: { in: candidates } },
        select: { id: true, documentNumber: true },
      });
      if (rows.length > 0) {
        for (const candidate of candidates) {
          const hit = rows.find((r) => r.documentNumber === candidate);
          if (hit) return hit.id;
        }
      }
    }

    // Fallback: otvorena stavka sa tačno jednakim iznosom (dug ili pot).
    const byAmount = await this.prisma.ledgerEntry.findFirst({
      where: {
        ...baseWhere,
        OR: [{ debit: amount }, { credit: amount }],
      },
      select: { id: true },
    });
    return byAmount?.id ?? null;
  }

  // ── RUČNI UNOS / KOREKCIJA STAVKE (BigBit paritet) ────────────────────────

  /**
   * Ručno dodaj stavku izvoda (BigBit „Unos naloga glavne knjige" — kucanje pored TXT importa).
   * Dozvoljeno samo dok izvod NIJE proknjižen (POSTED je zaključan). lineNo = MAX+1.
   * Ako je matchedCustomerId zadat → status MATCHED, inače UNMATCHED.
   */
  async addLine(statementId: number, dto: CreateStatementLineDto) {
    validateCreateStatementLine(dto);
    const statement = await this.getStatementOrThrow(statementId);
    this.assertNotPosted(statement.status, statementId);

    const maxLineNo = statement.lines.reduce(
      (m, l) => (l.lineNo > m ? l.lineNo : m),
      0,
    );

    // Devizni izvod (E6): amount se IZVODI iz foreignAmount × prodajni kurs; dinarski
    // izvod → amount direktan, FX polja null (ponašanje nepromenjeno).
    const fx = await this.resolveLineAmount(
      statement.currency,
      statement.statementDate,
      dto.amount ?? null,
      dto.foreignAmount ?? null,
    );

    await this.prisma.bankStatementLine.create({
      data: {
        statementId,
        lineNo: maxLineNo + 1,
        partnerAccount: dto.partnerAccount ?? null,
        partnerName: dto.partnerName ?? null,
        amount: fx.amount,
        currency: fx.currency,
        foreignAmount: fx.foreignAmount,
        exchangeRate: fx.exchangeRate,
        direction: dto.direction,
        referenceNumber: dto.referenceNumber ?? null,
        documentDate: dto.documentDate ? new Date(dto.documentDate) : null,
        matchedCustomerId: dto.matchedCustomerId ?? null,
        status: dto.matchedCustomerId != null ? "MATCHED" : "UNMATCHED",
      },
    });

    return this.getStatement(statementId);
  }

  /**
   * Izmeni postojeću stavku (korekcija posle TXT importa: analitika, PNB, iznos, smer).
   * Dozvoljeno samo dok izvod nije proknjižen. Setovanje matchedCustomerId ručno = MATCHED;
   * čišćenje (null) vraća na UNMATCHED (osim ako je već imao ledger match).
   */
  async updateLine(
    statementId: number,
    lineId: number,
    dto: UpdateStatementLineDto,
  ) {
    validateUpdateStatementLine(dto);
    const statement = await this.getStatementOrThrow(statementId);
    this.assertNotPosted(statement.status, statementId);

    const line = statement.lines.find((l) => l.id === lineId);
    if (!line)
      throw new NotFoundException(
        `Stavka ${lineId} ne pripada izvodu ${statementId}.`,
      );

    const isForeign = this.isForeignCurrency(statement.currency);

    const data: Prisma.BankStatementLineUpdateInput = {};
    if (dto.partnerAccount !== undefined) data.partnerAccount = dto.partnerAccount;
    if (dto.partnerName !== undefined) data.partnerName = dto.partnerName;
    if (isForeign) {
      // Devizni izvod: amount je izvedeni RSD preračun — menja se SAMO kroz foreignAmount.
      // Nova devizna vrednost → povuci prodajni kurs na dan izvoda i re-računaj amount.
      if (dto.foreignAmount !== undefined && dto.foreignAmount !== null) {
        const fx = await this.resolveLineAmount(
          statement.currency,
          statement.statementDate,
          null,
          dto.foreignAmount,
        );
        data.amount = fx.amount;
        data.currency = fx.currency;
        data.foreignAmount = fx.foreignAmount;
        data.exchangeRate = fx.exchangeRate;
      }
      // Direktan `amount` se na deviznom izvodu IGNORIŠE (protivvrednost je izvedena).
    } else if (dto.amount !== undefined) {
      data.amount = new D(dto.amount);
    }
    if (dto.direction !== undefined) data.direction = dto.direction;
    if (dto.referenceNumber !== undefined)
      data.referenceNumber = dto.referenceNumber;
    if (dto.documentDate !== undefined)
      data.documentDate = dto.documentDate ? new Date(dto.documentDate) : null;
    if (dto.matchedCustomerId !== undefined) {
      data.matchedCustomerId = dto.matchedCustomerId;
      // Ručno postavljen komitent → MATCHED; skinut → UNMATCHED (ledger match otpada).
      data.status = dto.matchedCustomerId != null ? "MATCHED" : "UNMATCHED";
      if (dto.matchedCustomerId == null) data.matchedLedgerEntryId = null;
    }

    await this.prisma.bankStatementLine.update({
      where: { id: lineId },
      data,
    });

    return this.getStatement(statementId);
  }

  /**
   * Obriši ručno/pogrešno unetu stavku. Zabranjeno na proknjiženom izvodu.
   * SOFT-DELETE (Batch B / DB-059): red ostaje sa deletedAt+deletedByUserId
   * (revizorski trag ko je sklonio stavku izvoda); svi čitaoci filtriraju
   * deletedAt IS NULL kroz getStatementOrThrow/getStatement include.
   */
  async deleteLine(statementId: number, lineId: number, actorUserId?: number) {
    const statement = await this.getStatementOrThrow(statementId);
    this.assertNotPosted(statement.status, statementId);

    const line = statement.lines.find((l) => l.id === lineId);
    if (!line)
      throw new NotFoundException(
        `Stavka ${lineId} ne pripada izvodu ${statementId}.`,
      );

    await this.prisma.bankStatementLine.update({
      where: { id: lineId },
      data: { deletedAt: new Date(), deletedByUserId: actorUserId ?? null },
    });
    return this.getStatement(statementId);
  }

  /**
   * Ručno per-stavka uparivanje („Poveži po BrDok" fallback dugme, doc 21): korisnik bira
   * konkretnu otvorenu stavku (LedgerEntry) za datu liniju. Postavlja matchedCustomerId
   * (iz ledger analitike) + matchedLedgerEntryId + referenceNumber (documentNumber) → MATCHED.
   */
  async linkLineToLedger(
    statementId: number,
    lineId: number,
    ledgerEntryId: number,
  ) {
    const statement = await this.getStatementOrThrow(statementId);
    this.assertNotPosted(statement.status, statementId);

    const line = statement.lines.find((l) => l.id === lineId);
    if (!line)
      throw new NotFoundException(
        `Stavka ${lineId} ne pripada izvodu ${statementId}.`,
      );

    const ledger = await this.prisma.ledgerEntry.findUnique({
      where: { id: ledgerEntryId },
      select: { id: true, analyticalCode: true, documentNumber: true },
    });
    if (!ledger)
      throw new NotFoundException(
        `Otvorena stavka (nalog) ${ledgerEntryId} ne postoji.`,
      );

    await this.prisma.bankStatementLine.update({
      where: { id: lineId },
      data: {
        matchedCustomerId: ledger.analyticalCode,
        matchedLedgerEntryId: ledger.id,
        referenceNumber: ledger.documentNumber ?? line.referenceNumber,
        status: "MATCHED",
      },
    });

    return this.getStatement(statementId);
  }

  /** Guard: mutacija stavke nije dozvoljena na proknjiženom izvodu. */
  private assertNotPosted(status: string, statementId: number): void {
    if (status === "POSTED")
      throw new ConflictException(
        `Izvod ${statementId} je proknjižen — izmena stavki nije dozvoljena.`,
      );
  }

  // ── DEVIZNI PRERAČUN (E6) ─────────────────────────────────────────────────

  /** Devizni izvod = valuta izvoda nije RSD (null/prazno/RSD = dinarski). */
  private isForeignCurrency(currency: string | null | undefined): boolean {
    return (
      currency != null &&
      currency.trim().length > 0 &&
      currency.trim().toUpperCase() !== "RSD"
    );
  }

  /**
   * Odredi RSD `amount` + FX polja stavke po valuti izvoda (E6, O2 presuda).
   *   • DINARSKI izvod (RSD): `amount` = uneti RSD iznos; currency/foreignAmount/exchangeRate = null
   *     (ponašanje NEPROMENJENO). Bez RSD iznosa → 422.
   *   • DEVIZNI izvod (EUR/USD/CHF): traži `foreignAmount` (> 0); povuci PRODAJNI kurs na dan
   *     izvoda (BigBit `KursnaListaNaDanZaNaloge` — doc 09 §banking: izvodi/nalozi = prodajni;
   *     vikend/praznik = poslednji raniji datum, rešava resolver) i izračunaj
   *     amount = foreignAmount × kurs, zaokruženo na 2 decimale. Bez kursne liste → 422 sa
   *     porukom resolvera (korisnik zna da unese kurs).
   */
  private async resolveLineAmount(
    statementCurrency: string,
    statementDate: Date,
    amount: number | null,
    foreignAmount: number | null,
  ): Promise<{
    amount: Prisma.Decimal;
    currency: string | null;
    foreignAmount: Prisma.Decimal | null;
    exchangeRate: Prisma.Decimal | null;
  }> {
    if (!this.isForeignCurrency(statementCurrency)) {
      if (amount == null)
        throw new UnprocessableEntityException(
          "Dinarski izvod — unesite RSD iznos stavke.",
        );
      return {
        amount: new D(amount),
        currency: null,
        foreignAmount: null,
        exchangeRate: null,
      };
    }

    const currency = statementCurrency.trim().toUpperCase();
    if (foreignAmount == null || !(foreignAmount > 0))
      throw new UnprocessableEntityException(
        `Devizni izvod (${currency}) — unesite devizni iznos veći od nule.`,
      );

    // Resolver baca NotFoundException kad nema kursa; pretvori u 422 sa istom porukom
    // (jasno korisniku da unese kursnu listu za ${currency} na dan izvoda). `await` je
    // bezbedan i za sinhroni i za asinhroni resolver.
    let resolved: { rate: Prisma.Decimal; rateDate: Date };
    try {
      resolved = await this.exchangeRates.resolve(currency, statementDate, "sell");
    } catch (err) {
      if (err instanceof NotFoundException)
        throw new UnprocessableEntityException(err.message);
      throw err;
    }

    const fa = new D(foreignAmount);
    const rsd = fa.mul(resolved.rate).toDecimalPlaces(2);
    return {
      amount: rsd,
      currency,
      foreignAmount: fa,
      exchangeRate: resolved.rate,
    };
  }

  // ── AUTO-KNJIŽENJE ──────────────────────────────────────────────────────

  /**
   * Auto-knjiženje izvoda (doc 21 §A): jedan JournalEntry sa dvojnim stavkama —
   *   (1) komitentska strana (analitika po matchedCustomerId), i
   *   (2) protivstavka na kontu banke (Σ svih stavki).
   * Priliv (CREDIT smer izvoda) zatvara potraživanje: banka DUGUJE, komitent POTRAŽUJE.
   * Odliv (DEBIT): banka POTRAŽUJE, komitent DUGUJE. Sve pod jednim nalogom, balans ΣDug=ΣPot.
   *
   * `document_number` komitentske stavke se IZVODI iz nađene otvorene stavke, a ne iz sirovog
   * poziva na broj — v. `resolvePostingDocumentNumbers` (nalaz N1, 03.08.2026).
   *
   * Posle knjiženja → hook za uparivanje uplate sa fakturom (ReconciliationService cross-modul,
   * PLAN §A) — ostavljen kao TODO jer taj servis nije dostupan iz ovog modula.
   */
  async postStatement(
    statementId: number,
    dto: PostStatementDto,
    actor?: AuthUser,
  ) {
    validatePostStatement(dto);
    const statement = await this.getStatementOrThrow(statementId);

    if (statement.status === "POSTED") {
      throw new ConflictException(`Izvod ${statementId} je već proknjižen.`);
    }

    // Ne knjiži izvod dok ima NEUPARENIH stavki: knjiženje bez komitenta na 2040/4350
    // pravi saldakonto zapis koji se ne može zatvoriti (review VISOK). Priliv MORA imati
    // uparenog komitenta (matchedCustomerId); odliv na 4350 isto. Odbij dok nije upareno.
    const unmatched = statement.lines.filter(
      (l) => l.status !== "POSTED" && l.matchedCustomerId == null,
    );
    if (unmatched.length > 0) {
      throw new UnprocessableEntityException(
        `Izvod ima ${unmatched.length} neuparenih stavki (bez komitenta). Prvo „Upari" ili ručno poveži svaku stavku pre knjiženja.`,
      );
    }

    const bankAccountCode = await this.resolveBankAccount(
      statement.bankAccount,
      dto.bankAccountCode,
    );

    // Konto komitentske strane (analitika saldakonta). ⏳ Konačan izvor konta kupca/dobavljača
    // = SaldakontoAccount registar po smeru; do potvrde (doc 21 §D t.3) koristimo default 2040
    // (kupci) za priliv i 4350 (dobavljači) za odliv. TODO(saldakonti): izvesti iz registra.
    const RECEIVABLE_ACCOUNT = "2040"; // kupci u zemlji
    const PAYABLE_ACCOUNT = "4350"; // dobavljači u zemlji

    return this.prisma.$transaction(async (tx) => {
      // Compare-and-swap: zaključaj izvod na POSTED PRE kreiranja naloga. Ako je druga
      // transakcija stigla prva (count===0), prekini — sprečava dupli GL nalog (review VISOK).
      const claimed = await tx.bankStatement.updateMany({
        where: { id: statementId, status: { not: "POSTED" } },
        data: { status: "POSTED" },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          `Izvod ${statementId} je već proknjižen (paralelno knjiženje).`,
        );
      }

      const lines = statement.lines;

      // Broj dokumenta po stavci — iz NAĐENE otvorene stavke, ne iz sirovog PNB-a
      // (nalaz N1, v. `resolvePostingDocumentNumbers`).
      const documentNumbers = await this.resolvePostingDocumentNumbers(tx, lines);

      let bankDebitTotal = ZERO; // Σ priliva (banka duguje)
      let bankCreditTotal = ZERO; // Σ odliva (banka potražuje)

      // Draft linije glavne knjige (isti oblik kao posting.service nested create):
      // accountCode je FK-skalar dostupan u nested JournalEntry.lines.create.
      interface LedgerLineDraft {
        accountCode: string;
        analyticalCode: number | null;
        debit: Prisma.Decimal;
        credit: Prisma.Decimal;
        description: string;
        documentNumber: string | null;
      }
      const ledgerLines: LedgerLineDraft[] = [];

      for (const line of lines) {
        const isInflow = line.direction === "CREDIT"; // priliv
        const partnerAccount = isInflow ? RECEIVABLE_ACCOUNT : PAYABLE_ACCOUNT;
        const documentNumber = documentNumbers.get(line.id) ?? null;
        const description = this.buildLedgerDescription(
          statement.statementNumber,
          line,
          documentNumber,
        );

        if (isInflow) {
          bankDebitTotal = bankDebitTotal.add(line.amount);
          // Priliv zatvara potraživanje: komitent POTRAŽUJE (credit).
          ledgerLines.push({
            accountCode: partnerAccount,
            analyticalCode: line.matchedCustomerId ?? null,
            debit: ZERO,
            credit: line.amount,
            description,
            documentNumber,
          });
        } else {
          bankCreditTotal = bankCreditTotal.add(line.amount);
          // Odliv: komitent DUGUJE (debit).
          ledgerLines.push({
            accountCode: partnerAccount,
            analyticalCode: line.matchedCustomerId ?? null,
            debit: line.amount,
            credit: ZERO,
            description,
            documentNumber,
          });
        }
      }

      // Protivstavka konto banke: DUGUJE za Σ priliva, POTRAŽUJE za Σ odliva.
      ledgerLines.push({
        accountCode: bankAccountCode,
        analyticalCode: null,
        debit: bankDebitTotal,
        credit: bankCreditTotal,
        description: `Izvod ${statement.statementNumber} — promet banke`,
        documentNumber: statement.statementNumber,
      });

      // Balans-kontrola (Decimal egzaktan → tolerancija 0).
      let totalDebit = ZERO;
      let totalCredit = ZERO;
      for (const l of ledgerLines) {
        totalDebit = totalDebit.add(l.debit);
        totalCredit = totalCredit.add(l.credit);
      }
      if (!totalDebit.equals(totalCredit)) {
        throw new UnprocessableEntityException(
          `Nalog ne balansira: ΣDug=${totalDebit.toFixed(4)} ≠ ΣPot=${totalCredit.toFixed(4)}.`,
        );
      }

      const year = businessYear(statement.statementDate);
      const number = await this.nextJournalNumber(tx, 0, "IZV", year);

      const entry = await tx.journalEntry.create({
        data: {
          number,
          orderTypeCode: "IZV",
          year,
          companyId: 0,
          documentDate: statement.statementDate,
          postingDate: statement.statementDate,
          // POSTED (ne draft): izvod-nalog MORA ući u karticu konta/bilans/saldakonti,
          // koji čitaju samo status IN ('POSTED','LOCKED') (review VISOK — inače promet
          // banke tiho ostaje van GK). Isti obrazac kao PostingEngine.postManualEntry.
          status: "POSTED",
          createdByUserId: actor?.userId ?? null,
          lines: { create: ledgerLines },
        },
        include: { lines: true },
      });

      // Izvod je već zaključan na POSTED (CAS gore); linije prevedi na POSTED.
      await tx.bankStatementLine.updateMany({
        where: { statementId },
        data: { status: "POSTED" },
      });

      // TODO(reconcile): posle knjiženja pozvati ReconciliationService da upari uplatu sa
      // fakturom (LedgerEntry.reconciledAt/reconciliationGroupId). Servis je u modulu
      // saldakonti (cross-modul) — integrator ga uvezuje; ovde ostavljamo hook.

      return {
        journalEntryId: entry.id,
        journalNumber: entry.number,
        lineCount: entry.lines.length,
        totalDebit: totalDebit.toFixed(2),
        totalCredit: totalCredit.toFixed(2),
      };
    });
  }

  // ── BROJ DOKUMENTA ZA GLAVNU KNJIGU (nalaz N1) ────────────────────────────

  /**
   * 🔴 KOJI BROJ IDE U `ledger_entries.document_number` ZA UPLATU SA IZVODA (nalaz N1, 03.08.2026).
   * ═══════════════════════════════════════════════════════════════════════════════
   * KVAR: `postStatement` je upisivao SIROV poziv na broj (`line.referenceNumber`) i onda
   * kad je `matchOpenItem` tačno pogodio otvorenu stavku — polje `matchedLedgerEntryId`
   * nije imalo NIJEDNOG čitaoca (grep 03.08.2026). Da je namera bila druga, vidi se na
   * ručnoj ruti „Poveži po BrDok" (`linkLineToLedger`), koja `referenceNumber` baš
   * NORMALIZUJE na `ledger.documentNumber`. Automatski tok to nije radio.
   *
   * IZMERENO (faktura `657/25`, kupac 4711, 120.000,00 RSD):
   *   • `computeReferenceNumber("97", "657/25")` → `6572527` (to banka i donese u PNB-u);
   *   • `parseReference("6572527")` nema separatora ni „97"+KK prefiksa → jedini kandidat je
   *     `6572527`, koji ne pogađa nijednu stavku, pa `matchOpenItem` padne na FALLBACK PO
   *     IZNOSU i **nađe tačnu fakturu** (jednak iznos 120.000);
   *   • knjiženje je taj pogodak bacilo i upisalo `6572527`.
   * Posledica u glavnoj knjizi su DVE grupe otvorenih stavki istog kupca umesto nule:
   *   `657/25` +120.000,00  ·  `6572527` −120.000,00
   * `kamata.service.ts` (grupa = broj dokumenta) preskače negativnu grupu (`principal ≤ 0`)
   * i računa zateznu na PUNIH 120.000, a `dunning.service.ts` čita iste otvorene stavke —
   * plaćen kupac dobija opomenu pred utuženje. Nijedan od ta dva servisa nije pokvaren:
   * kvar je isključivo na UPISU.
   *
   * ⚠️ Uparivanje po broju NIJE generalno slomljeno — `parseReference("657-25")` i
   * `parseReference("97 657-25")` uredno daju `657/25`. Kvar pogađa tačno onaj PNB koji
   * SAMI generišemo za naloge za plaćanje (model 97 sa kontrolnim brojem zalepljenim uz
   * osnovu bez separatora), a to je najčešći oblik koji se vraća iz banke.
   *
   * PRAVILO (3 koraka, redom):
   *   (1) POTVRĐENA STAVKA — `matchedLedgerEntryId` (postavlja ga `matchLines` ili ručno
   *       „Poveži po BrDok") → upisuje se `documentNumber` TE stavke. To je broj koji
   *       glavna knjiga stvarno poznaje, pa se uplata i faktura nađu u ISTOJ grupi i
   *       međusobno netuju (saldo 0 → nema ni kamate ni opomene).
   *       Veza se odbacuje ako pokazuje na stavku DRUGOG komitenta: `updateLine` menja
   *       `matchedCustomerId`, a `matchedLedgerEntryId` briše samo kad se komitent skida
   *       na null — prepravka komitenta zato ostavlja zastarelu vezu, i po njoj bi uplata
   *       zatvorila tuđi dug.
   *   (2) SIROV PNB SME SAMO AKO JE DOKAZANO BROJ OTVORENE STAVKE TOG KOMITENTA. Ovo NIJE
   *       novo ponašanje nego očuvanje jedinog slučaja u kom je stari kod bio tačan: kad
   *       platilac otkuca baš naš broj (`657/25`), netiranje je radilo i bez uparivanja.
   *       Provera je EGZAKTNA (bez `parseReference` kandidata) — izvedene varijante su
   *       posao `matchLines`, a njihov rezultat već stiže kroz korak (1).
   *   (3) INAČE `NULL` — neraspoređena uplata. Sirov PNB je ono što je platilac OTKUCAO;
   *       dok se ne dokaže da je to broj dokumenta, upisivanje pravi fantomski dokument
   *       koji: pravi lažnu otvorenu stavku u IOS-u/starosnoj strukturi, i može da tiho
   *       zatvori BUDUĆI dokument koji slučajno dobije taj broj (platilac koji upiše
   *       `658/25` pre nego što je ta faktura izdata). `NULL` je pošteno stanje „novac je
   *       stigao, ne znamo šta zatvara": kupčev saldo je tačan (uplata i dalje potražuje
   *       na njegovom kontu), a knjigovođa uplatu vidi i raspoređuje ručno.
   *       Otkucani PNB se NE GUBI — ostaje na stavci izvoda (`reference_number`) i ide u
   *       opis GK stavke (v. `buildLedgerDescription`), pa je revizorski trag potpun.
   *
   * ZAŠTO SE OVDE NE ZOVE `matchOpenItem`: knjiženje mora biti deterministično nad onim
   * što je korisnik video i potvrdio na ekranu. `matchOpenItem` ima fallback po iznosu,
   * koji ume da zatvori pogrešnu stavku; on sme da radi u „Upari" koraku (rezultat se
   * prikaže i može se prepraviti), ne tiho u trenutku knjiženja.
   *
   * Vraća mapu `line.id → documentNumber | null`. Dva upita za ceo izvod (ne po stavci).
   */
  private async resolvePostingDocumentNumbers(
    tx: Prisma.TransactionClient,
    lines: {
      id: number;
      referenceNumber: string | null;
      matchedCustomerId: number | null;
      matchedLedgerEntryId: number | null;
    }[],
  ): Promise<Map<number, string | null>> {
    const out = new Map<number, string | null>();

    // (1) POTVRĐENA STAVKA — jedan upit za sve veze izvoda.
    const linkIds = [
      ...new Set(
        lines
          .map((l) => l.matchedLedgerEntryId)
          .filter((v): v is number => v != null),
      ),
    ];
    const linked =
      linkIds.length > 0
        ? await tx.ledgerEntry.findMany({
            where: { id: { in: linkIds } },
            select: { id: true, documentNumber: true, analyticalCode: true },
          })
        : [];
    const linkedById = new Map(linked.map((l) => [l.id, l]));

    const pending: typeof lines = [];
    for (const line of lines) {
      const hit =
        line.matchedLedgerEntryId != null
          ? linkedById.get(line.matchedLedgerEntryId)
          : undefined;
      // Zastarela veza (drugi komitent) se odbacuje — v. korak (1) u doku iznad.
      if (
        hit?.documentNumber &&
        hit.analyticalCode === line.matchedCustomerId
      ) {
        out.set(line.id, hit.documentNumber);
        continue;
      }
      pending.push(line);
    }

    // (2) SIROV PNB — samo ako je EGZAKTNO broj otvorene stavke tog komitenta.
    const refs = [
      ...new Set(
        pending
          .map((l) => (l.referenceNumber ?? "").trim())
          .filter((v) => v.length > 0),
      ),
    ];
    const partners = [
      ...new Set(
        pending
          .map((l) => l.matchedCustomerId)
          .filter((v): v is number => v != null),
      ),
    ];
    const proven = new Map<number, Set<string>>();
    if (refs.length > 0 && partners.length > 0) {
      const rows = await tx.ledgerEntry.findMany({
        where: {
          analyticalCode: { in: partners },
          documentNumber: { in: refs },
          reconciledAt: null,
          journalEntry: { is: { status: { in: ["POSTED", "LOCKED"] } } },
        },
        select: { analyticalCode: true, documentNumber: true },
      });
      for (const r of rows) {
        if (r.analyticalCode == null || r.documentNumber == null) continue;
        const forPartner = proven.get(r.analyticalCode) ?? new Set<string>();
        forPartner.add(r.documentNumber);
        proven.set(r.analyticalCode, forPartner);
      }
    }

    for (const line of pending) {
      const ref = (line.referenceNumber ?? "").trim();
      const isProven =
        ref.length > 0 &&
        line.matchedCustomerId != null &&
        (proven.get(line.matchedCustomerId)?.has(ref) ?? false);
      out.set(line.id, isProven ? ref : null); // (3) inače neraspoređeno
    }

    return out;
  }

  /**
   * Opis GK stavke. Kad broj dokumenta NIJE utvrđen (korak 3 gore), u opis ide otkucani
   * poziv na broj i reč „NERASPOREĐENO" — knjigovođa iz kartice konta vidi zašto uplata
   * ne zatvara ništa i po čemu da je rasporedi, bez otvaranja izvoda. Bez toga bi jedini
   * trag ostao na stavci izvoda, a upravo se GK gleda pri usaglašavanju.
   * `description` je VarChar(255) — sečemo da dugačak naziv komitenta ne obori upis.
   */
  private buildLedgerDescription(
    statementNumber: string,
    line: {
      direction: string;
      partnerName: string | null;
      referenceNumber: string | null;
    },
    documentNumber: string | null,
  ): string {
    const kind = line.direction === "CREDIT" ? "priliv" : "odliv";
    const base =
      `Izvod ${statementNumber} — ${kind} ${line.partnerName ?? ""}`.trim();
    const ref = (line.referenceNumber ?? "").trim();
    const suffix =
      documentNumber == null && ref.length > 0
        ? ` · NERASPOREĐENO (poziv na broj: ${ref})`
        : "";
    return `${base}${suffix}`.slice(0, 255);
  }

  /**
   * Konto banke za protivstavku. Prioritet: eksplicitni override → PaymentAccount.bankCode
   * (naš žiro → konto banke). ⏳ Konačan izvor (doc 21 §D t.3: UplatniRacuni/parametar) čeka Nesu.
   */
  private async resolveBankAccount(
    bankAccount: string,
    override?: string,
  ): Promise<string> {
    if (override && override.trim().length > 0) return override.trim();

    const normalized = bankAccount.replace(/\D/gu, "");
    const pa = await this.prisma.paymentAccount.findFirst({
      where: { accountNumber: bankAccount },
      select: { bankCode: true },
    });
    if (pa?.bankCode && pa.bankCode.trim().length > 0) return pa.bankCode.trim();

    // Fallback: probaj po normalizovanom broju (crte/razmaci).
    if (normalized.length > 0) {
      const all = await this.prisma.paymentAccount.findMany({
        select: { accountNumber: true, bankCode: true },
      });
      const hit = all.find(
        (a) => a.accountNumber.replace(/\D/gu, "") === normalized,
      );
      if (hit?.bankCode && hit.bankCode.trim().length > 0)
        return hit.bankCode.trim();
    }

    throw new UnprocessableEntityException(
      `Konto banke za žiro račun ${bankAccount} nije definisan (PaymentAccount.bankCode prazan) — prosledite bankAccountCode.`,
    );
  }

  // ── PREGLED ───────────────────────────────────────────────────────────────

  async listStatements(params: {
    status?: string;
    bankAccount?: string;
    skip?: number;
    take?: number;
  }) {
    const where: Prisma.BankStatementWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.bankAccount) where.bankAccount = params.bankAccount;

    const take = Math.min(params.take ?? 50, 200);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.bankStatement.findMany({
        where,
        orderBy: { statementDate: "desc" },
        skip: params.skip ?? 0,
        take,
        include: { _count: { select: { lines: { where: { deletedAt: null } } } } },
      }),
      this.prisma.bankStatement.count({ where }),
    ]);

    return { data, meta: { total, skip: params.skip ?? 0, take } };
  }

  async getStatement(id: number) {
    const statement = await this.getStatementOrThrow(id);
    return { ...statement, control: this.computeControl(statement) };
  }

  /**
   * KONTROLA PROMETA I SALDA BANKE (B3, BigBit „Kontrola izvoda"): očekivano krajnje
   * stanje = openingBalance + Σ priliva (CREDIT) − Σ odliva (DEBIT); poredi se sa
   * unetim closingBalance. Vraća expected/actual/difference + `ok`.
   *
   * Ovo je SAMO upozorenje na formi (FE traka zeleno/crveno) — NE blokira knjiženje:
   * dinarski izvod se knjiži po stavkama bez obzira na saldo, a razlika najčešće znači
   * da nedostaje/prekobrojna stavka ili je pogrešno uneto stanje (korisnik ispravlja).
   * Decimal → string (BACKEND_RULES §6). Tolerancija = pola pare (deviznii preračun se
   * zaokružuje na 2 decimale, pa se sitno zaokruživanje ne prijavljuje kao neslaganje).
   */
  private computeControl(statement: {
    openingBalance: Prisma.Decimal;
    closingBalance: Prisma.Decimal;
    lines: { amount: Prisma.Decimal; direction: string }[];
  }): {
    openingBalance: string;
    totalInflow: string;
    totalOutflow: string;
    expectedClosing: string;
    actualClosing: string;
    difference: string;
    ok: boolean;
    available: boolean;
  } {
    let inflow = ZERO;
    let outflow = ZERO;
    for (const l of statement.lines) {
      if (l.direction === "CREDIT") inflow = inflow.add(l.amount);
      else outflow = outflow.add(l.amount);
    }
    const expected = statement.openingBalance.add(inflow).sub(outflow);
    const actual = statement.closingBalance;
    const difference = expected.sub(actual);
    // Kontrola ima smisla SAMO ako su stanja uneta (review Batch B): oba su Decimal sa
    // default 0, a uvoz ih trenutno ne popunjava — bez ovog gejta traka bi za SVAKI
    // izvod sa stavkama vikala „saldo se ne slaže" (0 + promet ≠ 0) i korisnik bi je
    // naučio da ignoriše. Kad su oba nula → kontrola nedostupna, ne „neslaganje".
    const available = !(
      statement.openingBalance.isZero() && statement.closingBalance.isZero()
    );
    return {
      openingBalance: statement.openingBalance.toFixed(2),
      totalInflow: inflow.toFixed(2),
      totalOutflow: outflow.toFixed(2),
      expectedClosing: expected.toFixed(2),
      actualClosing: actual.toFixed(2),
      difference: difference.toFixed(2),
      ok: !available || difference.abs().lessThanOrEqualTo(CONTROL_TOLERANCE),
      available,
    };
  }

  /**
   * Reset/brisanje uvezenog izvoda (BigBit paritet — pogrešan uvoz se poništava).
   * Dozvoljeno SAMO dok izvod NIJE proknjižen (POSTED → 409, jer bi brisanje ostavilo
   * GL nalog bez izvora). Stavke se brišu kaskadno (FK onDelete: Cascade). Vraća `{ id }`.
   */
  async deleteStatement(statementId: number) {
    const statement = await this.getStatementOrThrow(statementId);
    if (statement.status === "POSTED") {
      throw new ConflictException(
        `Izvod ${statementId} je proknjižen — brisanje nije dozvoljeno (stornirajte nalog u glavnoj knjizi).`,
      );
    }
    await this.prisma.bankStatement.delete({ where: { id: statementId } });
    return { id: statementId };
  }

  private async getStatementOrThrow(id: number) {
    const statement = await this.prisma.bankStatement.findUnique({
      where: { id },
      include: { lines: { where: { deletedAt: null }, orderBy: { lineNo: "asc" } } },
    });
    if (!statement) throw new NotFoundException(`Izvod ${id} ne postoji.`);
    return statement;
  }

  // ── NUMERACIJA NALOGA (banka↔analitika, vrsta "IZV") ──────────────────────

  /** 1 + MAX po (company, vrsta, godina), zero-pad 4; advisory lock protiv trke. */
  private async nextJournalNumber(
    tx: Prisma.TransactionClient,
    companyId: number,
    orderType: string,
    year: number,
  ): Promise<string> {
    const lockKey = `${companyId}:${orderType}:${year}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const last = await tx.journalEntry.findFirst({
      where: { companyId, orderTypeCode: orderType, year },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const next = (last ? parseInt(last.number, 10) : 0) + 1;
    return String(next).padStart(4, "0");
  }
}
