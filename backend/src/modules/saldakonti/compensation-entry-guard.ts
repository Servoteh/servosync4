/**
 * AUTORIZACIJA PODATAKA nad stavkama kompenzacije (defekt D1, 04.08.2026).
 * =========================================================================
 * Kompenzacija knjiži tako što iz PROSLEĐENE otvorene stavke (`ledgerEntryId`)
 * prepisuje konto + komitenta + broj dokumenta u linije KMP naloga. Pre ovoga se ta
 * stavka učitavala `findUnique`-om u petlji BEZ ijedne provere čija je i u kakvom je
 * stanju, a sve što ne odgovara se tiho preskakalo (`continue`) — poslat tuđi
 * `ledgerEntryId` je zato proizvodio PROKNJIŽEN I POTPISAN nalog koji zatvara fakturu
 * trećeg komitenta (ispravka = storno + ručna rekonstrukcija saldakonta dva komitenta).
 *
 * Ovde je ta provera na jednom mestu i radi JEDNIM upitom
 * (`findMany … id: { in: [...] }`, ne N×`findUnique`). CEO zahtev se odbija ako bilo
 * koja stavka:
 *   • ne postoji u glavnoj knjizi,
 *   • ne pripada komitentu te kompenzacije,
 *   • nije na proknjiženom nalogu (`POSTED_ENTRY_STATUSES`),
 *   • je već zatvorena (`reconciledAt`).
 * Greška IMENUJE svaki sporni `ledgerEntryId` i razlog. Tiho preskakanje je za ove
 * slučajeve UKINUTO — ono je i napravilo defekt.
 *
 * PRAVILO „PARTNER TE KOMPENZACIJE" = `CompensationOrder.partnerId`.
 * ─────────────────────────────────────────────────────────────────────────
 * Nalog NOSI partnera eksplicitno (`compensation_orders.partner_id`, meki ref
 * `customers.id`), a `ledger_entries.analytical_code` je po šemi upravo komitent iz
 * istog šifarnika — pa je merodavno poređenje `analyticalCode == order.partnerId`.
 * Izabrano je ono, a NE slabije „sve linije dele isti `analyticalCode`": slabije
 * pravilo bi pustilo nalog zaveden na komitenta A da prebija stavke komitenta B
 * (interno konzistentno, poslovno tuđe) — a upravo je tuđi dug ono što se brani.
 * Mešanje partnera je time odbijeno automatski, jer se SVAKA linija meri prema
 * partneru NALOGA, ne prema prvoj liniji. Stavka bez analitike (sintetika,
 * `analyticalCode = null`) se odbija: za nju se ne može dokazati da pripada partneru.
 */

import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { POSTED_ENTRY_STATUSES } from "./open-items.service";

/** Jedna odbijena stavka: KOJI `ledgerEntryId` i ZAŠTO je odbijen. */
export interface RejectedCompensationEntry {
  ledgerEntryId: number;
  reason: string;
}

/**
 * Bar jedna stavka kompenzacije nije prihvatljiva za knjiženje (tuđi komitent /
 * nalog nije proknjižen / stavka već zatvorena / stavka ne postoji). 422 — zahtev je
 * sintaksno ispravan, poslovno nije; `details.rejected` je mašinski čitljiv pa front
 * može da obeleži TAČAN red. Odbija se CEO zahtev: kompenzacija je bilateralna, pa bi
 * knjiženje bez jedne linije ostavilo nebalansiran nalog.
 */
export class CompensationEntryRejectedException extends UnprocessableEntityException {
  readonly code = "COMPENSATION_ENTRY_REJECTED";
  constructor(rejected: RejectedCompensationEntry[]) {
    super({
      message:
        `Kompenzacija nije proknjižena — stavke glavne knjige su odbijene: ` +
        rejected
          .map((r) => `stavka ${r.ledgerEntryId}: ${r.reason}`)
          .join("; ") +
        `. Nijedna linija nije proknjižena (ceo zahtev je odbijen).`,
      code: "COMPENSATION_ENTRY_REJECTED",
      details: { rejected },
    });
    this.name = "CompensationEntryRejectedException";
  }
}

/** Linija naloga — strukturni podskup `CompensationOrderLine` koji knjiženju treba. */
export interface CompensationOrderLineRow {
  ledgerEntryId: number | null;
  side: string;
  amount: Prisma.Decimal;
}

/**
 * Linija kompenzacije sa PROVERENOM reprezentativnom stavkom (vlasništvo nad
 * komitentom + proknjižen nalog + stavka otvorena). Knjiženje sme da čita
 * konto/komitenta/broj dokumenta SAMO odavde.
 */
export interface PostableCompensationLine {
  side: string;
  amount: Prisma.Decimal; // novac je Decimal, nikad number
  entry: {
    id: number;
    accountCode: string;
    analyticalCode: number | null;
    documentNumber: string | null;
  };
}

/**
 * Učita i PROVERI sve stavke naloga; vrati samo knjižive linije ili baci
 * {@link CompensationEntryRejectedException} sa spiskom svih spornih stavki.
 */
export async function loadPostableCompensationLines(
  tx: Prisma.TransactionClient,
  lines: CompensationOrderLineRow[],
  partnerId: number,
): Promise<PostableCompensationLine[]> {
  // NAMERNO PRESKAKANJE — jedino koje ostaje: predlog iz otvorenih stavki grupiše po
  // dokumentu i za grupu bez per-red ID-a šalje `ledgerEntryId = null`
  // (v. `CompensationService.allocate`). Takva linija nema šta da knjiži i NIJE
  // greška korisnika.
  const withEntry = lines.filter(
    (l): l is CompensationOrderLineRow & { ledgerEntryId: number } =>
      l.ledgerEntryId != null,
  );
  if (withEntry.length === 0) return [];

  const ids = [...new Set(withEntry.map((l) => l.ledgerEntryId))];
  const rows = await tx.ledgerEntry.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      accountCode: true,
      analyticalCode: true,
      documentNumber: true,
      reconciledAt: true,
      journalEntry: { select: { id: true, status: true } },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Skupljaju se SVI razlozi (ne prvi) da korisnik u jednom prolazu vidi svaki sporan
  // red — inače bi ispravljao stavku po stavku uz novo knjiženje svaki put.
  const rejected: RejectedCompensationEntry[] = [];
  for (const id of ids) {
    const le = byId.get(id);
    if (le == null) {
      rejected.push({
        ledgerEntryId: id,
        reason: "ne postoji u glavnoj knjizi",
      });
      continue;
    }
    if (le.analyticalCode == null) {
      rejected.push({
        ledgerEntryId: id,
        reason:
          `nema komitenta (sintetički konto ${le.accountCode}) pa se ne može ` +
          `dokazati da pripada komitentu ${partnerId}`,
      });
    } else if (le.analyticalCode !== partnerId) {
      rejected.push({
        ledgerEntryId: id,
        reason:
          `pripada komitentu ${le.analyticalCode}, a kompenzacija je za komitenta ` +
          `${partnerId} (prebijanje tuđeg duga)`,
      });
    }
    if (!POSTED_ENTRY_STATUSES.includes(le.journalEntry.status)) {
      rejected.push({
        ledgerEntryId: id,
        reason:
          `nalog ${le.journalEntry.id} nije proknjižen (status ` +
          `${le.journalEntry.status}) — nacrt se ne prebija`,
      });
    }
    if (le.reconciledAt != null) {
      rejected.push({
        ledgerEntryId: id,
        reason:
          `već je zatvorena ${le.reconciledAt.toISOString().slice(0, 10)} ` +
          `(uparena ili prebijena)`,
      });
    }
  }
  if (rejected.length > 0)
    throw new CompensationEntryRejectedException(rejected);

  return withEntry.map((l) => {
    const le = byId.get(l.ledgerEntryId);
    if (le == null) {
      // Nedostižno (bez odbijenih je svaki id u mapi), ali se BACA a ne preskače:
      // tiho preskakanje nedostupne stavke je i bio defekt D1.
      throw new CompensationEntryRejectedException([
        {
          ledgerEntryId: l.ledgerEntryId,
          reason: "ne postoji u glavnoj knjizi",
        },
      ]);
    }
    return {
      side: l.side,
      amount: l.amount,
      entry: {
        id: le.id,
        accountCode: le.accountCode,
        analyticalCode: le.analyticalCode,
        documentNumber: le.documentNumber,
      },
    };
  });
}
