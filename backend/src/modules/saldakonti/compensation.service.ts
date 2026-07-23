/**
 * COMPENSATION SERVICE — kompenzacija (prebijanje) sa partnerom (Faza 4 §A t.5).
 * =========================================================================
 * Prebijanje potraživanja i obaveza prema istom partneru. Bilateralno:
 * Σ(receivable prebijeno) == Σ(payable prebijeno) (bilans = 0).
 *
 *   buildFromOpenItems(partnerId) — predlog: uzme otvorene stavke obe strane
 *     (potraživanja + obaveze) za partnera i predloži prebijanje do min(Σ obe
 *     strane). Vraća predlog stavki (ne upisuje ništa).
 *   create(dto) — kreira CompensationOrder + linije; validira bilateralni bilans.
 *     Ako je dto.post=true, odmah knjiži preko PostingEngine (KMP nalog).
 *   validateBalanced(lines) — bilateralno Σ receivable == Σ payable.
 *
 * KNJIŽENJE: kompenzacioni nalog vrste KMP ide preko PostingEngineService.
 * `postManualEntry` (generički ručni nalog GK) knjiži proizvoljne dug/pot linije;
 * kompenzaciona protivstavka nosi konto+komitent+broj dokumenta reprezentativne
 * otvorene stavke pa pada u ISTU open-items grupu (GROUP BY konto+komitent+broj)
 * i time umanjuje prikazani saldo. Pun offset zatvara celu grupu (reconciledAt),
 * delimičan je ostavlja otvorenu sa ostatkom (v. postCompensation).
 */

import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { PostingEngineService } from "../gl/posting/posting.service";
import { OpenItemsService, type OpenItem } from "./open-items.service";
import { ReconciliationService } from "./reconciliation.service";
import {
  type CreateCompensationDto,
  type CompensationLineInput,
  validateCreateCompensationDto,
} from "./dto/saldakonti.dto";

const D = Prisma.Decimal;

export interface CompensationProposalLine {
  ledgerEntryId: number | null; // otvorena stavka (može biti null ako grupisano po dokumentu)
  accountCode: string;
  documentNumber: string | null;
  side: "receivable" | "payable";
  openAmount: Prisma.Decimal; // otvoreni saldo stavke
  suggestedOffset: Prisma.Decimal; // predloženi iznos prebijanja (≤ openAmount)
}

export interface CompensationProposal {
  partnerId: number;
  totalReceivable: Prisma.Decimal;
  totalPayable: Prisma.Decimal;
  offsetAmount: Prisma.Decimal; // min(Σ receivable, Σ payable) — bilateralni prebijeni iznos
  lines: CompensationProposalLine[];
}

@Injectable()
export class CompensationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly openItems: OpenItemsService,
    private readonly reconciliation: ReconciliationService,
    private readonly posting: PostingEngineService,
  ) {}

  /**
   * Predlog kompenzacije iz otvorenih stavki partnera (obe strane). Raspoređuje
   * prebijeni iznos do min(Σ receivable, Σ payable) FIFO po dueDate (najranije
   * dospele prve). Ne upisuje — služi kao osnova za `create`.
   */
  async buildFromOpenItems(partnerId: number): Promise<CompensationProposal> {
    const items = await this.openItems.listOpenItems(undefined, partnerId);

    // Strana iz registra (receivable = potraživanje / dugovni saldo; payable =
    // obaveza / potražni saldo). Uzimamo saldo u apsolutnoj vrednosti po strani.
    const receivables = items.filter((i) => i.side === "receivable");
    const payables = items.filter((i) => i.side === "payable");

    const totalReceivable = this.sumAbs(receivables);
    const totalPayable = this.sumAbs(payables);
    const offsetAmount = totalReceivable.lessThan(totalPayable)
      ? totalReceivable
      : totalPayable;

    const lines: CompensationProposalLine[] = [
      ...this.allocate(receivables, offsetAmount, "receivable"),
      ...this.allocate(payables, offsetAmount, "payable"),
    ];

    return {
      partnerId,
      totalReceivable,
      totalPayable,
      offsetAmount,
      lines,
    };
  }

  /**
   * Kreira kompenzaciju (CompensationOrder + linije). Validira bilateralni
   * bilans (Σ receivable == Σ payable). Ako dto.post=true → knjiži (TODO hook).
   */
  async create(dto: CreateCompensationDto, userId?: number) {
    validateCreateCompensationDto(dto);

    const partner = await this.prisma.customer.findUnique({
      where: { id: dto.partnerId },
      select: { id: true },
    });
    if (!partner) {
      throw new NotFoundException(`Komitent ${dto.partnerId} ne postoji.`);
    }

    // Bilateralni bilans nad prosleđenim iznosima.
    const balance = this.validateBalanced(dto.lines);
    if (!balance.balanced) {
      throw new UnprocessableEntityException(
        `Kompenzacija ne balansira: Σ potraživanja=${balance.totalReceivable.toFixed(2)} ` +
          `≠ Σ obaveza=${balance.totalPayable.toFixed(2)}.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const compensationNumber =
        dto.compensationNumber ?? (await this.nextNumber(tx));
      const date = dto.date ? new Date(dto.date) : new Date();

      const order = await tx.compensationOrder.create({
        data: {
          partnerId: dto.partnerId,
          compensationNumber,
          date,
          status: "DRAFT",
          totalAmount: balance.totalReceivable, // == totalPayable (balansirano)
          createdByUserId: userId ?? null,
          lines: {
            create: dto.lines.map((l, i) => ({
              ledgerEntryId: l.ledgerEntryId,
              side: l.side,
              amount: new D(l.amount),
              lineNo: i + 1,
            })),
          },
        },
        include: { lines: true },
      });

      if (dto.post) {
        await this.postCompensation(tx, order.id, dto.partnerId);
        // Re-fetch: postCompensation je ažurirao status=POSTED + journalEntryId.
        return tx.compensationOrder.findUniqueOrThrow({
          where: { id: order.id },
          include: { lines: true },
        });
      }

      return order;
    });
  }

  /**
   * Bilateralni bilans: Σ(receivable amount) == Σ(payable amount). Vraća i
   * podzbirove za poruku greške.
   */
  validateBalanced(lines: CompensationLineInput[]): {
    balanced: boolean;
    totalReceivable: Prisma.Decimal;
    totalPayable: Prisma.Decimal;
  } {
    let totalReceivable = new D(0);
    let totalPayable = new D(0);
    for (const l of lines) {
      const amt = new D(l.amount);
      if (l.side === "receivable") totalReceivable = totalReceivable.add(amt);
      else totalPayable = totalPayable.add(amt);
    }
    return {
      balanced: totalReceivable.equals(totalPayable),
      totalReceivable,
      totalPayable,
    };
  }

  // ── knjiženje (KMP nalog) ───────────────────────────────────────────────────

  /**
   * Proknjiži kompenzaciju kao GK nalog vrste KMP i zatvori uparene otvorene
   * stavke. Zove se UNUTAR `create` transakcije (prima `tx`).
   *
   * Za svaku liniju naloga reprezentativna otvorena stavka (`ledgerEntryId`) daje
   * konto + komitent + broj dokumenta. Protivstavka (dug za payable, pot za
   * receivable) nosi te iste ključeve pa pada u ISTU open-items grupu
   * (GROUP BY konto+komitent+broj) i time umanjuje prikazani saldo grupe.
   *
   * Zatvaranje ide PO LINIJI, prema pokriću otvorenog salda GRUPE (svi članovi,
   * ne samo reprezentativna stavka — open-items grupiše po dokumentu):
   *   • PUN offset (line.amount ≥ |Σ dug−pot| grupe): reconciledAt na SVE članove
   *     grupe + na KMP protivstavku tog dokumenta → grupa potpuno zatvorena
   *     (nestaje iz saldakonta, aginga i kamate).
   *   • DELIMIČAN offset: NE zatvara se niko — protivstavka u istoj grupi već
   *     umanjuje saldo, a stavka ostaje otvorena sa ostatkom.
   * (Staro ponašanje je bezuslovno zatvaralo celu reprezentativnu stavku i pri
   * delimičnom prebijanju → ostatak salda bi nestao; review VISOK/SREDNJI.)
   */
  private async postCompensation(
    tx: Prisma.TransactionClient,
    compensationId: number,
    partnerId: number,
  ): Promise<void> {
    const order = await tx.compensationOrder.findUniqueOrThrow({
      where: { id: compensationId },
      include: { lines: true },
    });

    // Kompenzacioni nalog (vrsta KMP): prebijamo potraživanje protiv obaveze.
    // receivable strana (npr. 2040 kupac) se ZATVARA → potražuje (credit);
    // payable strana (npr. 4350 dobavljač) se ZATVARA → duguje (debit).
    // Iz reprezentativne stavke čitamo konto + komitent + broj dokumenta da
    // protivstavka padne u ISTU open-items grupu (GROUP BY konto+komitent+broj).
    interface PostLine {
      accountCode: string;
      analyticalCode: number | null;
      documentNumber: string | null;
      amount: Prisma.Decimal;
    }
    const postLines: PostLine[] = [];
    const glLines: Array<{
      accountCode: string;
      analyticalCode: number | null;
      documentNumber: string | null;
      debit: number;
      credit: number;
      description: string;
    }> = [];
    for (const line of order.lines) {
      if (line.ledgerEntryId == null) continue; // grupisane stavke bez per-red ID-a se preskaču
      const le = await tx.ledgerEntry.findUnique({
        where: { id: line.ledgerEntryId },
        select: {
          accountCode: true,
          analyticalCode: true,
          documentNumber: true,
        },
      });
      if (!le) continue;
      const amount = Number(line.amount);
      postLines.push({
        accountCode: le.accountCode,
        analyticalCode: le.analyticalCode,
        documentNumber: le.documentNumber,
        amount: line.amount,
      });
      glLines.push({
        accountCode: le.accountCode,
        analyticalCode: le.analyticalCode,
        documentNumber: le.documentNumber,
        debit: line.side === "payable" ? amount : 0,
        credit: line.side === "receivable" ? amount : 0,
        description: `Kompenzacija ${order.compensationNumber}`,
      });
    }

    if (glLines.length === 0) return; // nema knjiživih linija (npr. grupisane stavke)

    const posted = await this.posting.postManualEntry(tx, {
      orderType: "KMP",
      documentDate: order.date ?? new Date(),
      description: `Kompenzacija ${order.compensationNumber} (komitent ${partnerId})`,
      lines: glLines,
    });

    // Zatvaranje PO LINIJI: pun offset zatvara celu grupu, delimičan ništa.
    // Tolerancija pola pare (zaokruženje) da egzaktan pun offset ne promakne.
    const HALF_CENT = new D("0.005");
    const now = new Date();
    for (const pl of postLines) {
      // Pre-postojeći otvoreni članovi grupe — SVI, ne samo reprezentativna
      // stavka (open-items grupiše po dokumentu; defekt B). Isključujemo upravo
      // kreiranu KMP protivstavku (isti journalEntryId) da openBalanceAbs ostane
      // saldo PRE prebijanja — inače bi se pun/delimičan pogrešno klasifikovao.
      const members = await tx.ledgerEntry.findMany({
        where: {
          accountCode: pl.accountCode,
          analyticalCode: pl.analyticalCode,
          documentNumber: pl.documentNumber,
          reconciledAt: null,
          journalEntryId: { not: posted.journalEntryId },
        },
        select: { id: true, debit: true, credit: true },
      });
      let bal = new D(0);
      for (const m of members) bal = bal.add(m.debit).sub(m.credit);
      const openBalanceAbs = bal.abs();

      // Pun offset: prebijeni iznos pokriva ceo otvoreni saldo grupe (± pola pare).
      // Delimičan: NE zatvaraj ništa — protivstavka u istoj grupi već umanjuje
      // saldo, pa stavka ostaje otvorena sa ostatkom (defekt A).
      if (pl.amount.greaterThanOrEqualTo(openBalanceAbs.sub(HALF_CENT))) {
        if (members.length > 0) {
          await tx.ledgerEntry.updateMany({
            where: { id: { in: members.map((m) => m.id) } },
            data: { reconciledAt: now },
          });
        }
        // Zatvori i KMP protivstavku tog dokumenta (aging/kamata je ne vide više).
        await tx.ledgerEntry.updateMany({
          where: {
            journalEntryId: posted.journalEntryId,
            accountCode: pl.accountCode,
            analyticalCode: pl.analyticalCode,
            documentNumber: pl.documentNumber,
          },
          data: { reconciledAt: now },
        });
      }
    }

    await tx.compensationOrder.update({
      where: { id: compensationId },
      data: { status: "POSTED", journalEntryId: posted.journalEntryId },
    });
  }

  // ── privatni helperi ────────────────────────────────────────────────────────

  private sumAbs(items: OpenItem[]): Prisma.Decimal {
    return items.reduce((acc, i) => acc.add(i.balance.abs()), new D(0));
  }

  /** FIFO alokacija prebijenog iznosa po dueDate (najranije dospele prve). */
  private allocate(
    items: OpenItem[],
    total: Prisma.Decimal,
    side: "receivable" | "payable",
  ): CompensationProposalLine[] {
    const sorted = [...items].sort((a, b) => {
      const da = a.dueDate ? a.dueDate.getTime() : 0;
      const db = b.dueDate ? b.dueDate.getTime() : 0;
      return da - db;
    });
    let remaining = total;
    const out: CompensationProposalLine[] = [];
    for (const it of sorted) {
      if (remaining.lessThanOrEqualTo(0)) break;
      const open = it.balance.abs();
      const offset = open.lessThan(remaining) ? open : remaining;
      remaining = remaining.sub(offset);
      out.push({
        // Reprezentativna stavka grupe (svi članovi dele konto+komitent+broj).
        // postCompensation iz nje čita konto+komitent+broj: protivstavka pada u
        // istu open-items grupu, a pun offset zatvara SVE članove grupe (ne samo
        // ovaj ID). Bez ID-a (null) linija se preskače (nema šta da se knjiži).
        ledgerEntryId: it.ledgerEntryIds[0] ?? null,
        accountCode: it.accountCode,
        documentNumber: it.documentNumber,
        side,
        openAmount: open,
        suggestedOffset: offset,
      });
    }
    return out;
  }

  /** Broj kompenzacije: NNNN/god (max+1 po godini). */
  private async nextNumber(tx: Prisma.TransactionClient): Promise<string> {
    const year = new Date().getFullYear();
    const suffix = `/${year}`;
    const last = await tx.compensationOrder.findFirst({
      where: { compensationNumber: { endsWith: suffix } },
      orderBy: { compensationNumber: "desc" },
      select: { compensationNumber: true },
    });
    const lastSeq = last
      ? parseInt(last.compensationNumber.split("/")[0], 10) || 0
      : 0;
    return `${String(lastSeq + 1).padStart(4, "0")}${suffix}`;
  }
}
