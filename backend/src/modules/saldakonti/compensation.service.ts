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
 *     Ako je dto.post=true, knjiži preko PostingEngine (KMP nalog) — v. TODO hook.
 *   validateBalanced(lines) — bilateralno Σ receivable == Σ payable.
 *
 * KNJIŽENJE: kompenzacioni nalog vrste KMP ide preko PostingEngineService.
 * Postojeći PostingEngine ima samo `postFromStockDocument` (robni izvor);
 * knjiženje kompenzacije (proizvoljne GK linije) traži novi ulaz koji taj
 * servis (tuđi modul — ne diramo ga) još ne izlaže. Zato je ovde jasno
 * definisan TODO hook sa potpisom koji integrator treba da poveže.
 */

import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
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

  // ── knjiženje (TODO hook) ───────────────────────────────────────────────────

  /**
   * TODO(integrator): proknjiži kompenzaciju kao GK nalog vrste KMP i zatvori
   * uparene otvorene stavke.
   *
   * PostingEngineService (tuđi modul, ne diramo) trenutno izlaže samo
   * `postFromStockDocument(docId)` — knjiženje iz robnog dokumenta. Kompenzacija
   * traži knjiženje proizvoljnih GK linija (dug: obaveza-konto, pot:
   * potraživanje-konto po partneru), što taj servis još ne nudi. Kad dobije
   * generički ulaz (npr. `postManualEntry(lines, meta)`), ovde:
   *
   *   1) sastavi LedgerLineDraft[] iz CompensationOrderLine (dug/pot po strani);
   *   2) pozovi PostingEngine da napravi JournalEntry(vrsta=KMP, status posted);
   *   3) ReconciliationService.manualReconcile(entryIds) nad uparenim redovima
   *      + poveži writeOff/residual ako postoji;
   *   4) postavi CompensationOrder.status = 'POSTED'.
   *
   * Do tada `post=true` samo označava nameru i NE knjiži (ostaje DRAFT), da se
   * ne kreira nekonzistentno stanje. Potpis koji integrator treba da poveže:
   *
   *   postCompensation(tx, compensationId: number, partnerId: number): Promise<void>
   */
  private async postCompensation(
    _tx: Prisma.TransactionClient,
    _compensationId: number,
    _partnerId: number,
  ): Promise<void> {
    // Namerno bez implementacije — v. TODO iznad. Ne bacamo grešku da kreiranje
    // (DRAFT) prođe; knjiženje se aktivira kad PostingEngine dobije generički ulaz.
    return;
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
        ledgerEntryId: null, // grupisano po dokumentu; per-red ID nije jednoznačan
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
