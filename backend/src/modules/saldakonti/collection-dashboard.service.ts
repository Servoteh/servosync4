/**
 * COLLECTION DASHBOARD SERVICE — dashboard naplate (Talas 3 §A7).
 * =========================================================================
 * Agregatni pogled nad otvorenim stavkama za komercijalu/knjigovodstvo:
 *   • ukupno potraživanja (side=receivable) / obaveze (side=payable),
 *   • DSO = prosečan broj dana dospelosti ponderisan iznosom (potraživanja),
 *   • aging bucketi (0-30 / 31-60 / 61-90 / 90+) ukupno,
 *   • top 10 dužnika po saldu, svaki sa bucket raspodelom.
 *
 * IZVOR: `OpenItemsService.listOpenItems` (side + daysOverdue + saldo po redu)
 * i `OpenItemsService.agingByPartner` (per-komitent bucketi). Oba su izvedeni
 * pogledi nad `ledger_entries` (otvorene stavke se NE materijalizuju) — pa se
 * brojevi dashboard-a poklapaju sa saldakonti pregledom (aging tab). Ne upisuje
 * ništa (READ).
 *
 * NOVAC: Prisma.Decimal (NIKAD Float) — vraća se kao Decimal (JSON → string,
 * BACKEND_RULES §6). DSO je metrika (broj dana), ne novac → vraća se kao number.
 */

import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { OpenItemsService } from "./open-items.service";

const D = Prisma.Decimal;

/** Aging raspodela (Decimal) — koristi je i ukupno i po dužniku. */
export interface AgingBuckets {
  bucket0_30: Prisma.Decimal;
  bucket31_60: Prisma.Decimal;
  bucket61_90: Prisma.Decimal;
  bucket90plus: Prisma.Decimal;
  total: Prisma.Decimal;
}

/** Red top-liste dužnika: komitent + naziv + bucket raspodela salda. */
export interface TopDebtor extends AgingBuckets {
  partnerId: number | null; // analitička = komitent (null = sintetika bez analitike)
  partnerName: string | null; // iz šifarnika (meki ref; null ako obrisan/nepoznat)
}

/** Odgovor GET /saldakonti/collection-dashboard. */
export interface CollectionDashboard {
  asOf: string; // ISO datum preseka
  totalReceivable: Prisma.Decimal; // Σ saldo (side=receivable)
  totalPayable: Prisma.Decimal; // Σ |saldo| (side=payable)
  netReceivable: Prisma.Decimal; // potraživanja − obaveze
  overdueReceivable: Prisma.Decimal; // Σ saldo potraživanja sa daysOverdue > 0
  /** DSO — prosečan broj dana dospelosti potraživanja ponderisan iznosom. */
  dso: number;
  /** Broj otvorenih dokumenata (grupa) — potraživanja. */
  receivableOpenCount: number;
  aging: AgingBuckets; // ukupno po bucketu (svi komitenti; net pozicija)
  topDebtors: TopDebtor[]; // top 10 po neto saldu (dužnici: total > 0)
}

@Injectable()
export class CollectionDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly openItems: OpenItemsService,
  ) {}

  /**
   * Izgradi dashboard naplate na dan preseka (`asOf` default danas). Sve agregacije
   * nad izvedenim pogledom otvorenih stavki — bez materijalizacije, bez upisa.
   */
  async build(asOf?: Date): Promise<CollectionDashboard> {
    const cutoff = asOf ?? new Date();

    // Dva izvedena pogleda nad istim ledger_entries snapshot-om:
    //   items    — po dokumentu (side + saldo + daysOverdue) → KPI split + DSO,
    //   agingRows — po komitentu (bucketi) → aging total + top dužnici (poklapa se
    //               sa saldakonti aging tabom).
    const [items, agingRows] = await Promise.all([
      this.openItems.listOpenItems(undefined, undefined, cutoff),
      this.openItems.agingByPartner(undefined, cutoff),
    ]);

    // ── KPI: potraživanja / obaveze split po strani iz registra ────────────────
    let totalReceivable = new D(0);
    let totalPayable = new D(0);
    let overdueReceivable = new D(0);
    let receivableOpenCount = 0;
    // DSO ponder: Σ(saldo · daysOverdue) / Σ(saldo) nad potraživanjima sa poznatim
    // dospećem i pozitivnim saldom (stvarno dugovanje; overpay/nedospelo bez datuma
    // se izostavlja da ne izobliči metriku).
    let dsoWeighted = new D(0);
    let dsoWeight = new D(0);

    for (const it of items) {
      if (it.side === "payable") {
        totalPayable = totalPayable.add(it.balance.abs());
        continue;
      }
      // receivable
      totalReceivable = totalReceivable.add(it.balance);
      receivableOpenCount += 1;
      if (it.balance.greaterThan(0)) {
        if (it.daysOverdue != null) {
          dsoWeighted = dsoWeighted.add(it.balance.mul(it.daysOverdue));
          dsoWeight = dsoWeight.add(it.balance);
          if (it.daysOverdue > 0) {
            overdueReceivable = overdueReceivable.add(it.balance);
          }
        }
      }
    }

    const dso = dsoWeight.greaterThan(0)
      ? Number(dsoWeighted.div(dsoWeight).toFixed(1))
      : 0;

    // ── Aging total + top dužnici (per-komitent bucketi) ───────────────────────
    const aging = this.sumAging(agingRows);

    // Dužnici = neto potražna pozicija u našu korist (total > 0). Sort po saldu opadajuće.
    const debtors = agingRows
      .filter((r) => r.total.greaterThan(0))
      .sort((a, b) => (a.total.greaterThan(b.total) ? -1 : a.total.lessThan(b.total) ? 1 : 0))
      .slice(0, 10);

    const names = await this.resolveNames(
      debtors
        .map((d) => d.analyticalCode)
        .filter((id): id is number => id != null),
    );

    const topDebtors: TopDebtor[] = debtors.map((r) => ({
      partnerId: r.analyticalCode,
      partnerName: r.analyticalCode != null ? (names.get(r.analyticalCode) ?? null) : null,
      bucket0_30: r.bucket0_30,
      bucket31_60: r.bucket31_60,
      bucket61_90: r.bucket61_90,
      bucket90plus: r.bucket90plus,
      total: r.total,
    }));

    return {
      asOf: cutoff.toISOString(),
      totalReceivable,
      totalPayable,
      netReceivable: totalReceivable.sub(totalPayable),
      overdueReceivable,
      dso,
      receivableOpenCount,
      aging,
      topDebtors,
    };
  }

  /** Σ bucketa preko svih komitenata (net pozicija — poklapa se sa aging tabom). */
  private sumAging(
    rows: Array<{
      bucket0_30: Prisma.Decimal;
      bucket31_60: Prisma.Decimal;
      bucket61_90: Prisma.Decimal;
      bucket90plus: Prisma.Decimal;
      total: Prisma.Decimal;
    }>,
  ): AgingBuckets {
    let b0 = new D(0);
    let b31 = new D(0);
    let b61 = new D(0);
    let b90 = new D(0);
    let total = new D(0);
    for (const r of rows) {
      b0 = b0.add(r.bucket0_30);
      b31 = b31.add(r.bucket31_60);
      b61 = b61.add(r.bucket61_90);
      b90 = b90.add(r.bucket90plus);
      total = total.add(r.total);
    }
    return {
      bucket0_30: b0,
      bucket31_60: b31,
      bucket61_90: b61,
      bucket90plus: b90,
      total,
    };
  }

  /** Nazivi komitenata iz šifarnika (meki ref — batch findMany; nepoznati izostaju). */
  private async resolveNames(ids: number[]): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    if (ids.length === 0) return map;
    const customers = await this.prisma.customer.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    for (const c of customers) map.set(c.id, c.name);
    return map;
  }
}
