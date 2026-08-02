/**
 * PAYMENT PREPARATION SERVICE — priprema plaćanja / virmani (Faza 4 §C).
 * =========================================================================
 * Selektuje DOSPELE obaveze iz otvorenih stavaka GK (izveden pogled nad
 * `ledger_entries`, kao BigBit — NE materijalizovana tabela) i pretvara ih u
 * naloge za plaćanje (`PaymentOrder` / legacy `Virmani`) sa DEDUP-om koji
 * sprečava dvostruko plaćanje iste fakture istom dobavljaču.
 *
 * OTVORENA STAVKA (obaveza):
 *   red gde je `account` u `SaldakontoAccount` sa side="payable" (klasa 4),
 *   `reconciledAt IS NULL` (nezatvorena), nalog proknjižen. Saldo obaveze =
 *   Σ(credit − debit) po (konto, komitent, documentNumber). DOSPELA =
 *   `dueDate ≤ cutoff` (cutoff = danas).
 *
 * STATUS-MAŠINA (doc 21 §B, schema PaymentOrder.status):
 *   CREATED(0) → SIGNED(1) → PAID(2). `isLocked` (Zakljucano) je ortogonalno.
 *
 * POZIV NA BROJ: mod97.util (KBroj97 = 98 − ((broj×100) mod 97)).
 *
 * ⚠️ Čita SaldakontoAccount registar (ne hardkod „klase 4*") — doc PLAN §A.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ThreeWayMatchService } from "../nabavka/three-way-match.service";
import type { PaymentMatchWarning } from "../nabavka/dto/three-way-match.dto";
import {
  CreatePaymentOrdersDto,
  CreatePaymentOrderLineInput,
} from "./dto/create-payment-orders.dto";
import { CreateManualPaymentOrderDto } from "./dto/create-manual-payment-order.dto";
import {
  computeReferenceNumber,
  digitsOnly,
  isValidAccountNumber,
} from "./mod97.util";

const D = Prisma.Decimal;
const ZERO = new D(0);

/**
 * Koliko različitih komitenata sme da se pretraži po komitentu (stavke bez broja
 * dokumenta) pri obogaćivanju 3-way match upozorenjima. Gornja granica čuva
 * odziv ekrana — upozorenja su informativna, pa je odsecanje bezopasno.
 */
const MAX_PARTNER_WARNING_LOOKUPS = 25;

/**
 * Koliko nalaza sme da visi o JEDNOJ otvorenoj stavci (review K). Stavka bez broja dokumenta
 * hvata sve nalaze svog dobavljača, pa je jedna stavka umela da povuče stotine tuđih poruka.
 */
const MAX_WARNINGS_PER_ROW = 20;

/** Jedna dospela otvorena obaveza (agregat po konto+komitent+dokument). */
export interface DueLiability {
  accountCode: string;
  supplierId: number | null;
  documentNumber: string | null;
  /** otvoreni saldo obaveze = Σ(credit − debit); pozitivan = dugujemo. */
  openAmount: string; // Decimal kao string (BACKEND_RULES §6 — Decimal u JSON-u = string)
  currency: string;
  /** najranije dospeće po dokumentu (min dueDate). */
  dueDate: Date | null;
  /** dana u kašnjenju u odnosu na cutoff (>0 = dospelo/kasni). */
  daysOverdue: number;
  /** najstariji ledger_entry.id grupe — traceback ka izvornoj stavci. */
  sourceLedgerEntryId: number;
  /**
   * 3-way match nalazi vezani za ovu obavezu (naručeno/primljeno/fakturisano).
   * ⚠️ ČISTO INFORMATIVNO — prisustvo upozorenja NE sprečava kreiranje, potpis
   * ni izvoz naloga (poslovna odluka korisnika: prijavi, ne blokiraj).
   * Prazan niz kad nema nalaza ili kad modul nabavke nije povezan.
   */
  matchWarnings: PaymentMatchWarning[];
  /** Bar jedan nalaz nivoa WARNING na ovoj stavci (INFO se ne broji). */
  hasMatchWarnings: boolean;
}

/** Zbirni pregled dospelih obaveza sa 3-way match upozorenjima. */
export interface DueLiabilitiesWithWarnings {
  data: DueLiability[];
  meta: {
    cutoff: string;
    count: number;
    /** Zbirno: bar jedna stavka nosi upozorenje (WARNING). */
    hasMatchWarnings: boolean;
    /** Ukupan broj upozorenja (WARNING) preko svih stavki. */
    warningCount: number;
  };
}

@Injectable()
export class PaymentPreparationService {
  private readonly logger = new Logger(PaymentPreparationService.name);

  constructor(
    private readonly prisma: PrismaService,
    // 3-way match (modul Nabavka) je ČITALAC upozorenja. @Optional() namerno:
    // ako modul nije povezan, priprema plaćanja radi identično kao pre (bez
    // upozorenja) — nikad ne pada i nikad ne blokira plaćanje.
    @Optional()
    private readonly threeWayMatch?: ThreeWayMatchService,
  ) {}

  /**
   * Selektuj dospele obaveze na dan `cutoff` (default danas).
   * Grupiše otvorene potražne stavke sa payable konta po (konto, komitent,
   * dokument), sabira Σ(credit − debit), zadržava grupe sa saldom > 0 čije je
   * najranije dospeće `≤ cutoff`.
   */
  async selectDue(cutoff: Date = new Date()): Promise<DueLiability[]> {
    // 1) DOBAVLJAČKA payable konta iz registra (NE hardkod klase 4* — doc PLAN §A).
    //    partnerScope = "supplier" je OBAVEZAN uz side = "payable": konta primljenih
    //    avansa 4300/4302 su po saldu obaveza, ali obaveza prema KUPCU (njegov avans).
    //    Bez tog filtera kupčev avans (nema dueDate → tretira se kao dospeo) ulazi u
    //    predlog za plaćanje i može završiti u nalogu za prenos / e-bankingu — firma bi
    //    kupcu isplatila novac koji je kupac njoj uplatio (revizija, VISOK).
    //    NULL scope se namerno NE uzima (izlaz novca ide samo po potvrđenom podatku).
    const payableAccounts = await this.prisma.saldakontoAccount.findMany({
      where: { side: "payable", partnerScope: "supplier" },
      select: { account: true },
    });
    const accountCodes = payableAccounts.map((a) => a.account);
    if (accountCodes.length === 0) return [];

    // 2) otvorene stavke na tim kontima (reconciledAt IS NULL), proknjižen nalog.
    //    Grupišemo u memoriji po (konto, komitent, dokument) — groupBy ne daje
    //    lako „min(dueDate) + min(id)", pa radimo determinističku agregaciju.
    const rows = await this.prisma.ledgerEntry.findMany({
      where: {
        accountCode: { in: accountCodes },
        reconciledAt: null,
        journalEntry: { status: { in: ["POSTED", "LOCKED"] } },
      },
      select: {
        id: true,
        accountCode: true,
        analyticalCode: true,
        documentNumber: true,
        debit: true,
        credit: true,
        dueDate: true,
        currency: true,
      },
      orderBy: { id: "asc" },
    });

    interface Acc {
      accountCode: string;
      supplierId: number | null;
      documentNumber: string | null;
      balance: Prisma.Decimal;
      currency: string;
      dueDate: Date | null;
      firstId: number;
    }
    const groups = new Map<string, Acc>();
    for (const r of rows) {
      const key = `${r.accountCode}|${r.analyticalCode ?? ""}|${r.documentNumber ?? ""}`;
      const delta = r.credit.sub(r.debit); // payable saldo = Σ(credit − debit)
      const cur = groups.get(key);
      if (cur) {
        cur.balance = cur.balance.add(delta);
        if (r.dueDate && (!cur.dueDate || r.dueDate < cur.dueDate)) {
          cur.dueDate = r.dueDate;
        }
      } else {
        groups.set(key, {
          accountCode: r.accountCode,
          supplierId: r.analyticalCode ?? null,
          documentNumber: r.documentNumber ?? null,
          balance: delta,
          currency: r.currency ?? "RSD",
          dueDate: r.dueDate ?? null,
          firstId: r.id,
        });
      }
    }

    // 3) zadrži samo grupe sa pozitivnim saldom obaveze i dospećem ≤ cutoff.
    const cutMs = cutoff.getTime();
    const result: DueLiability[] = [];
    for (const g of groups.values()) {
      if (g.balance.lessThanOrEqualTo(ZERO)) continue; // nema obaveze
      // Bez dueDate → tretiramo kao dospelo (BigBit: prazna valuta = odmah).
      const dueMs = g.dueDate ? g.dueDate.getTime() : 0;
      if (dueMs > cutMs) continue; // nije dospelo
      const daysOverdue = g.dueDate
        ? Math.floor((cutMs - dueMs) / 86_400_000)
        : 0;
      result.push({
        accountCode: g.accountCode,
        supplierId: g.supplierId,
        documentNumber: g.documentNumber,
        openAmount: g.balance.toFixed(4),
        currency: g.currency,
        dueDate: g.dueDate,
        daysOverdue,
        sourceLedgerEntryId: g.firstId,
        matchWarnings: [],
        hasMatchWarnings: false,
      });
    }
    // najduže kašnjenje prvo (naplata/plaćanje prioritet).
    result.sort((a, b) => b.daysOverdue - a.daysOverdue);

    // 4) 3-way match upozorenja (informativno). Nikad ne menja izbor stavki i
    //    nikad ne obara selekciju — greška u obogaćivanju se loguje i ignoriše.
    await this.attachMatchWarnings(result);
    return result;
  }

  /**
   * Zakači 3-way match nalaze na dospele obaveze (in-place). Spajanje: nalaz i
   * obaveza moraju imati ISTOG komitenta; ako obaveza ima broj dokumenta, uzimaju
   * se samo nalazi čiji `documentNumbers` sadrže taj broj, a ako ga nema (robni
   * ulaz ne upisuje `document_number` u GK stavku) uzimaju se nalazi tog dobavljača.
   *
   * DVA UPITA UKUPNO (review R4): ranije se `warningsForPayment` zvao u SERIJSKOJ petlji,
   * jednom po komitentu (do 25 poziva × do 5 upita ≈ 126 upita / ~8 s na ekranu pripreme).
   * Sada ide jedan poziv za sve brojeve dokumenata + jedan batch poziv za sve komitente.
   *
   * ŠIRINA MREŽE (review K): kod stavke BEZ broja dokumenta spajanje je grubo (svi nalazi
   * dobavljača), pa se tu uzimaju samo WARNING nalazi i najviše `MAX_WARNINGS_PER_ROW` —
   * inače jedna stavka povuče stotine tuđih INFO poruka („faktura još nije stigla u celosti").
   *
   * ⚠️ NIKAD ne baca: modul nabavke nije obavezan, a pad obogaćivanja ne sme da
   * obori pripremu plaćanja.
   */
  private async attachMatchWarnings(rows: DueLiability[]): Promise<void> {
    if (!this.threeWayMatch || rows.length === 0) return;

    const documentNumbers = [
      ...new Set(
        rows
          .map((r) => r.documentNumber)
          .filter((n): n is string => typeof n === "string" && n !== ""),
      ),
    ];
    // Komitenti čije stavke NEMAJU broj dokumenta (robni ulaz ne upisuje
    // `document_number` u GK stavku) — samo za njih se traži po komitentu.
    const partnersWithoutDocNumber = [
      ...new Set(
        rows
          .filter((r) => !r.documentNumber)
          .map((r) => r.supplierId)
          .filter((id): id is number => id != null && id > 0),
      ),
    ].slice(0, MAX_PARTNER_WARNING_LOOKUPS);

    try {
      const all: PaymentMatchWarning[] = [];
      // 1) jedan poziv za SVE brojeve dokumenata iz selekcije (ne po komitentu).
      if (documentNumbers.length > 0) {
        all.push(
          ...(await this.threeWayMatch.warningsForPayment({ documentNumbers })),
        );
      }
      // 2) JEDAN batch poziv za sve komitente čije stavke nemaju broj dokumenta.
      if (partnersWithoutDocNumber.length > 0) {
        all.push(
          ...(await this.threeWayMatch.warningsForPayment({
            partnerIds: partnersWithoutDocNumber,
          })),
        );
      }

      for (const row of rows) {
        if (row.supplierId == null) continue;
        const forPartner = all.filter((w) => w.supplierId === row.supplierId);
        const docNumber = row.documentNumber;
        const preciseMatch = docNumber != null && docNumber !== "";
        const matched = preciseMatch
          ? forPartner.filter((w) => w.documentNumbers.includes(docNumber))
          : // Grubo spajanje (samo po komitentu) — samo WARNING nalazi.
            forPartner.filter((w) => w.level === "WARNING");
        // Dedup po (narudžbenica, stavka, kod) — isti nalaz može doći iz oba prolaza.
        const seen = new Set<string>();
        row.matchWarnings = matched
          .filter((w) => {
            const key = `${w.orderId}|${w.lineNo ?? ""}|${w.code}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, MAX_WARNINGS_PER_ROW);
        row.hasMatchWarnings = row.matchWarnings.some(
          (w) => w.level === "WARNING",
        );
      }
    } catch (e) {
      // Informativni sloj — pad NE sme da obori pripremu plaćanja.
      this.logger.warn(
        `3-way match upozorenja nisu učitana (priprema plaćanja radi normalno): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * Dospele obaveze + ZBIRNI pokazatelj upozorenja (za traku/ikonicu na ekranu).
   * Isti podaci kao `selectDue`, samo sa `meta` zbirom.
   *
   * ⚠️ Upozorenja su informativna: `hasMatchWarnings: true` ne sme da onemogući
   * nijedno dugme ni da odbije kreiranje/potpis/izvoz naloga.
   */
  async selectDueWithWarnings(
    cutoff: Date = new Date(),
  ): Promise<DueLiabilitiesWithWarnings> {
    const data = await this.selectDue(cutoff);
    let warningCount = 0;
    for (const row of data)
      warningCount += row.matchWarnings.filter(
        (w) => w.level === "WARNING",
      ).length;
    return {
      data,
      meta: {
        cutoff: cutoff.toISOString(),
        count: data.length,
        hasMatchWarnings: data.some((r) => r.hasMatchWarnings),
        warningCount,
      },
    };
  }

  /**
   * Kreiraj naloge za plaćanje iz selekcije. Po stavci jedan `PaymentOrder`.
   * DEDUP: (referenceNumberCredit, supplierId) je @@unique u schemi
   * (`uq_payment_orders_dedup`) — hvatamo P2002 kao ConflictException da bi
   * pokušaj dvostrukog plaćanja iste fakture bio odbijen, ne 500.
   *
   * @returns kreirani nalozi (već postojeći duplikat baca ConflictException).
   */
  async createPaymentOrders(
    dto: CreatePaymentOrdersDto,
    actorUserId?: number,
  ): Promise<
    Array<{
      id: number;
      orderNumber: string;
      supplierId: number;
      amount: string;
      referenceNumberCredit: string | null;
      status: string;
    }>
  > {
    const created: Array<{
      id: number;
      orderNumber: string;
      supplierId: number;
      amount: string;
      referenceNumberCredit: string | null;
      status: string;
    }> = [];

    const debitModel = dto.referenceModelDebit ?? "99";

    // DobarTR (BigBit `ProveriTkRnPreKreiranjaVirmana`, doc 25 §C): žiro račun dobavljača mora
    // biti struktura-i-MOD97 validan (banka(3)-partija-KK(2)) PRE upisa naloga — inače ga banka
    // odbija posle izvoza. Validiramo SAMO kad je račun prisutan (prazan = poseban tok, ne blokira).
    // Agregiramo sve sporne stavke u jednu poruku (GAP audit: FE markira sve, ne prvu grešku).
    const badAccounts: string[] = [];
    for (const line of dto.lines) {
      const acct = line.supplierAccount?.trim();
      if (acct && !isValidAccountNumber(acct)) {
        badAccounts.push(`dobavljač ${line.supplierId}: neispravan žiro račun ${acct}`);
      }
    }
    if (badAccounts.length > 0) {
      throw new BadRequestException(
        `Neispravan tekući račun (DobarTR) — nalozi nisu kreirani: ${badAccounts.join("; ")}.`,
      );
    }

    // Ceo batch je ATOMIČAN (review VISOK): ako bilo koji nalog padne (npr. dedup P2002),
    // cela transakcija se rollback-uje — nema parcijalno kreiranih naloga koji bi pri
    // retry-u obarali na već-postojeće A/B. Sve-ili-ništa.
    await this.prisma.$transaction(async (tx) => {
      for (let i = 0; i < dto.lines.length; i++) {
        const line = dto.lines[i];
        const referenceNumberCredit = this.buildCreditReference(line);
        const referenceNumberDebit = line.documentNumber
          ? computeReferenceNumber(debitModel, line.documentNumber)
          : null;

        const orderNumber =
          dto.seriesNumber && dto.lines.length === 1
            ? dto.seriesNumber
            : `${dto.seriesNumber ?? "AUTO"}-${i + 1}`;

        // Dedup po IZVORNOJ otvorenoj stavci (review VISOK): @@unique(referenceNumberCredit,
        // supplierId) ne hvata dvostruko plaćanje kad je PNB prazan (PG tretira NULL kao
        // različit). Prava zaštita — ista otvorena stavka (sourceLedgerEntryId) sme dati
        // najviše JEDAN aktivan nalog. Radi i bez PNB-a.
        if (line.sourceLedgerEntryId != null) {
          const dup = await tx.paymentOrder.findFirst({
            where: { sourceLedgerEntryId: line.sourceLedgerEntryId },
            select: { id: true, orderNumber: true },
          });
          if (dup) {
            throw new ConflictException(
              `Otvorena stavka je već u nalogu ${dup.orderNumber} — dvostruko plaćanje odbijeno.`,
            );
          }
        }

        try {
          const order = await tx.paymentOrder.create({
          data: {
            orderNumber,
            supplierId: line.supplierId,
            supplierAccount: line.supplierAccount ?? null,
            amount: new D(line.amount),
            currency: line.currency ?? "RSD",
            referenceNumberDebit,
            referenceNumberCredit,
            purpose: line.purpose ?? "UPLATA ZA ROBU",
            dueDate: line.dueDate ? new Date(line.dueDate) : null,
            status: "CREATED",
            isLocked: false,
            sourceLedgerEntryId: line.sourceLedgerEntryId ?? null,
            createdByUserId: actorUserId ?? null,
            updatedByUserId: actorUserId ?? null,
          },
          select: {
            id: true,
            orderNumber: true,
            supplierId: true,
            amount: true,
            referenceNumberCredit: true,
            status: true,
          },
        });
        created.push({
          id: order.id,
          orderNumber: order.orderNumber,
          supplierId: order.supplierId,
          amount: order.amount.toFixed(4),
          referenceNumberCredit: order.referenceNumberCredit,
          status: order.status,
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002"
        ) {
          // @@unique(referenceNumberCredit, supplierId) → nalog za istu fakturu
          // i istog dobavljača već postoji (sprečeno dvostruko plaćanje, doc 21 §C).
          throw new ConflictException(
            `Nalog za plaćanje za dobavljača ${line.supplierId} i poziv na broj ` +
              `${referenceNumberCredit ?? "(prazan)"} već postoji — dvostruko plaćanje odbijeno.`,
          );
        }
          throw e;
        }
      }
    });
    return created;
  }

  /**
   * RUČNI pojedinačni nalog za plaćanje (BigBit `UnosVirmana`) — bez izvora iz
   * saldakonta (`sourceLedgerEntryId = null`). Ulazi u isti pregled/potpis/izvoz
   * tok kao i nalozi iz dospelih obaveza (status CREATED).
   *
   * DobarTR (doc 25 §C): žiro račun primaoca se ponovo validira (odbrana u dubini
   * iako DTO već proverava) — banka odbija nevalidan račun posle izvoza.
   * DEDUP: @@unique(referenceNumberCredit, supplierId) — dupli poziv na broj za
   * istog primaoca → ConflictException (ne 500). Kod praznog poziva na broj PG
   * tretira NULL kao različit, pa se ručni virmani bez PNB smeju ponavljati
   * (legitimno — poziv na broj mnoga plaćanja nemaju).
   *
   * Broj naloga: `RV-<id>` (Ručni Virman) — jedinstven po autoincrement id-u;
   * kreira se privremeno pa se podešava u istoj transakciji (atomično).
   */
  async createManualOrder(
    dto: CreateManualPaymentOrderDto,
    actorUserId?: number,
  ): Promise<{
    id: number;
    orderNumber: string;
    supplierId: number;
    amount: string;
    referenceNumberCredit: string | null;
    status: string;
  }> {
    const acct = dto.supplierAccount.trim();
    // Odbrana u dubini (DobarTR) — DTO validate to već radi, ali servis je izvor istine.
    if (!isValidAccountNumber(acct)) {
      throw new BadRequestException(
        `Neispravan tekući račun (DobarTR): ${acct}. Format: banka(3)-partija-kontrolni(2).`,
      );
    }

    const referenceNumberCredit =
      typeof dto.referenceNumber === "string" && dto.referenceNumber.trim() !== ""
        ? dto.referenceNumber.trim()
        : null;

    return this.prisma.$transaction(async (tx) => {
      let createdId: number;
      try {
        const order = await tx.paymentOrder.create({
          data: {
            orderNumber: "RV-NEW", // privremeno — podešava se na RV-<id> ispod
            supplierId: dto.supplierId,
            supplierAccount: acct,
            amount: new D(dto.amount),
            currency: dto.currency?.trim() || "RSD",
            referenceNumberDebit: null,
            referenceNumberCredit,
            purpose: dto.purpose.trim() || "UPLATA ZA ROBU",
            dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
            status: "CREATED",
            isLocked: false,
            sourceLedgerEntryId: null, // ručni unos — nema otvorene stavke GK
            createdByUserId: actorUserId ?? null,
            updatedByUserId: actorUserId ?? null,
          },
          select: { id: true },
        });
        createdId = order.id;
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002"
        ) {
          throw new ConflictException(
            `Nalog za plaćanje za dobavljača ${dto.supplierId} i poziv na broj ` +
              `${referenceNumberCredit ?? "(prazan)"} već postoji — dvostruko plaćanje odbijeno.`,
          );
        }
        throw e;
      }

      const updated = await tx.paymentOrder.update({
        where: { id: createdId },
        data: { orderNumber: `RV-${createdId}` },
        select: {
          id: true,
          orderNumber: true,
          supplierId: true,
          amount: true,
          referenceNumberCredit: true,
          status: true,
        },
      });

      return {
        id: updated.id,
        orderNumber: updated.orderNumber,
        supplierId: updated.supplierId,
        amount: updated.amount.toFixed(4),
        referenceNumberCredit: updated.referenceNumberCredit,
        status: updated.status,
      };
    });
  }

  /** CREATED → SIGNED (potpisan). */
  async markSigned(orderId: number, actorUserId?: number): Promise<void> {
    await this.transition(orderId, "CREATED", "SIGNED", actorUserId);
  }

  /** SIGNED → PAID (plaćen). */
  async markPaid(orderId: number, actorUserId?: number): Promise<void> {
    await this.transition(orderId, "SIGNED", "PAID", actorUserId);
  }

  /**
   * Masovni potpis (BigBit PotpisiVirmane je grupna akcija) — CREATED→SIGNED za više naloga.
   * Skip-ne-abort po nalogu: nalog koji nije u CREATED / zaključan se preskače uz razlog,
   * ostali prolaze. Vraća broj potpisanih + listu preskočenih.
   */
  async markSignedBatch(
    orderIds: number[],
    actorUserId?: number,
  ): Promise<{ signed: number; skipped: { id: number; reason: string }[] }> {
    const skipped: { id: number; reason: string }[] = [];
    let signed = 0;
    for (const id of orderIds) {
      try {
        await this.transition(id, "CREATED", "SIGNED", actorUserId);
        signed += 1;
      } catch (e) {
        skipped.push({
          id,
          reason: e instanceof Error ? e.message : "nepoznata greška",
        });
      }
    }
    return { signed, skipped };
  }

  // ── ZAKLJUČAVANJE VIRMANA (BigBit „Zakljucano" — B3) ──────────────────────

  /**
   * Zaključaj pojedinačni nalog (Zakljucano=true). Zaključan nalog je zamrznut:
   * ne može menjati status (sign/pay — guard u `transition`), ne ulazi u izvoz
   * (guard u PaymentExportService), i ne može se otključati osim `unlockOrder`.
   * Ortogonalno statusu — sme se zaključati CREATED/SIGNED/PAID. Idempotencija:
   * već zaključan → 409 (CAS updateMany hvata i trku i dvostruko zaključavanje).
   */
  async lockOrder(
    orderId: number,
    actorUserId?: number,
  ): Promise<{ id: number; isLocked: true }> {
    const order = await this.prisma.paymentOrder.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true, isLocked: true },
    });
    if (!order) {
      throw new NotFoundException(`Nalog za plaćanje ${orderId} ne postoji.`);
    }
    // Compare-and-swap: zaključaj SAMO ako je i dalje otključan (sprečava trku /
    // dvostruko zaključavanje) — count===0 znači da je neko drugi već zaključao.
    const res = await this.prisma.paymentOrder.updateMany({
      where: { id: orderId, isLocked: false },
      data: { isLocked: true, updatedByUserId: actorUserId ?? null },
    });
    if (res.count !== 1) {
      throw new ConflictException(
        `Nalog ${order.orderNumber} je već zaključan.`,
      );
    }
    return { id: orderId, isLocked: true };
  }

  /**
   * Otključaj nalog (Zakljucano=false) — ispravka greške pri zaključavanju (isti
   * obrazac kao GK unlock). Vraća nalog u tok potpis/izvoz. Nije zaključan → 409.
   */
  async unlockOrder(
    orderId: number,
    actorUserId?: number,
  ): Promise<{ id: number; isLocked: false }> {
    const order = await this.prisma.paymentOrder.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true, isLocked: true },
    });
    if (!order) {
      throw new NotFoundException(`Nalog za plaćanje ${orderId} ne postoji.`);
    }
    const res = await this.prisma.paymentOrder.updateMany({
      where: { id: orderId, isLocked: true },
      data: { isLocked: false, updatedByUserId: actorUserId ?? null },
    });
    if (res.count !== 1) {
      throw new ConflictException(
        `Nalog ${order.orderNumber} nije zaključan.`,
      );
    }
    return { id: orderId, isLocked: false };
  }

  /**
   * Masovno zaključavanje starijih naloga (isti obrazac kao GK lock-older iz review-a):
   * svi OTKLJUČANI nalozi sa `createdAt < beforeDate` prelaze u zaključane. `createdAt`
   * je uvek prisutan i deterministički prag (dueDate je nullabilan, pa nije pouzdan
   * period-ključ). Već zaključani se ne diraju.
   *
   * GUARD: prag u BUDUĆNOSTI se odbija (zaključao bi i tekuće naloge). `dryRun: true`
   * SAMO prebroji (bez izmene) — FE zove prvo proveru pa potvrdu. Izvršenje se loguje.
   */
  async lockOlderThan(
    beforeDate: Date,
    opts: { dryRun?: boolean } = {},
    actorUserId?: number,
  ): Promise<{ count: number; dryRun: boolean }> {
    if (!(beforeDate instanceof Date) || Number.isNaN(beforeDate.getTime())) {
      throw new ConflictException("Neispravan datum praga (beforeDate).");
    }
    const now = new Date();
    if (beforeDate.getTime() > now.getTime()) {
      throw new ConflictException(
        `Datum praga (${beforeDate.toISOString().slice(0, 10)}) je u budućnosti — ` +
          `zaključavanje bi obuhvatilo i tekuće naloge. Izaberi datum do danas.`,
      );
    }

    const where: Prisma.PaymentOrderWhereInput = {
      isLocked: false,
      createdAt: { lt: beforeDate },
    };

    if (opts.dryRun) {
      const count = await this.prisma.paymentOrder.count({ where });
      return { count, dryRun: true };
    }

    const res = await this.prisma.paymentOrder.updateMany({
      where,
      data: { isLocked: true, updatedByUserId: actorUserId ?? null },
    });
    this.logger.warn(
      `LOCK-OLDER virmani: zaključano ${res.count} naloga sa createdAt < ${beforeDate.toISOString().slice(0, 10)}`,
    );
    return { count: res.count, dryRun: false };
  }

  /**
   * Pregled naloga za plaćanje (BigBit paritet — bez ovoga refresh gubi naloge).
   * Filteri: status, supplierId, exported (null/not-null), period po createdAt. Paginacija.
   * Envelope { data, meta } (BACKEND_RULES §6). Decimal → string u JSON-u.
   */
  async listOrders(params: {
    status?: string;
    supplierId?: number;
    exported?: boolean;
    dateFrom?: string;
    dateTo?: string;
    skip?: number;
    take?: number;
  }) {
    const where: Prisma.PaymentOrderWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.supplierId != null) where.supplierId = params.supplierId;
    if (params.exported === true) where.exportedAt = { not: null };
    if (params.exported === false) where.exportedAt = null;
    if (params.dateFrom || params.dateTo) {
      where.createdAt = {};
      if (params.dateFrom) where.createdAt.gte = new Date(params.dateFrom);
      if (params.dateTo) where.createdAt.lte = new Date(params.dateTo);
    }

    const take = Math.min(params.take ?? 50, 200);
    const skip = params.skip ?? 0;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.paymentOrder.findMany({
        where,
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        skip,
        take,
      }),
      this.prisma.paymentOrder.count({ where }),
    ]);

    return {
      data: rows.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        supplierId: o.supplierId,
        supplierAccount: o.supplierAccount,
        amount: o.amount.toFixed(2),
        currency: o.currency,
        referenceNumberCredit: o.referenceNumberCredit,
        purpose: o.purpose,
        dueDate: o.dueDate,
        status: o.status,
        isLocked: o.isLocked,
        exportedAt: o.exportedAt,
      })),
      meta: { total, skip, take },
    };
  }

  // ───────────────────────────────────────────────────────────────────────────

  /** Poziv na broj u korist (primalac) — PNBOdobBroj + kontrolni sufiks. */
  private buildCreditReference(
    line: CreatePaymentOrderLineInput,
  ): string | null {
    const model = (line.referenceModelCredit ?? "97").trim();
    const base = line.referenceBaseCredit ?? line.documentNumber ?? "";
    // Nema osnove poziva na broj → legitimno bez PNB (mnoga plaćanja nemaju PNB): ostavi null,
    // NE blokiraj (doc 25 §C — blokada je samo za neispravan, ne za odsutan poziv na broj).
    if (base.trim() === "") return null;
    const ref = computeReferenceNumber(model, base);
    // PNB guard: kad je PNB IZRAČUNAT po MOD97 modelu ("97"), proveri konzistentnost kontrolnog
    // broja (ISO 7064 MOD 97-10 kao u KBroj97: ceo poziv na broj mod 97 == 1). Ako osnova nije
    // numerička pa kontrolni broj nije mogao da se doda (ref bez cifara) → tretiraj kao odsutan
    // PNB (vrati null, ne piši nevalidan poziv na broj). Nekonzistentan izračunat PNB = defekt
    // podataka → odbij, da ne ode neispravan poziv na broj u banku.
    if (model === "97") {
      const digits = digitsOnly(ref);
      if (digits === "") return null;
      if (BigInt(digits) % 97n !== 1n) {
        throw new BadRequestException(
          `Poziv na broj u korist (${ref}) za dobavljača ${line.supplierId} nije MOD97-konzistentan — proverite osnovu poziva na broj.`,
        );
      }
    }
    return ref;
  }

  private async transition(
    orderId: number,
    from: string,
    to: string,
    actorUserId?: number,
  ): Promise<void> {
    const order = await this.prisma.paymentOrder.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, isLocked: true },
    });
    if (!order) {
      throw new NotFoundException(`Nalog za plaćanje ${orderId} ne postoji.`);
    }
    if (order.isLocked) {
      throw new ConflictException(
        `Nalog ${orderId} je zaključan (Zakljucano) — promena statusa nije dozvoljena.`,
      );
    }
    if (order.status !== from) {
      throw new ConflictException(
        `Nalog ${orderId} je u statusu ${order.status}; očekivano ${from} za prelaz u ${to}.`,
      );
    }
    // Compare-and-swap: prelaz uspeva SAMO ako je status i dalje `from` i nalog nije
    // zaključan (review SREDNJI — sprečava izgubljeni update / prelaz iz pogrešnog stanja
    // pri konkurenciji, jer findUnique→update nije atomičan).
    const swapped = await this.prisma.paymentOrder.updateMany({
      where: { id: orderId, status: from, isLocked: false },
      data: { status: to, updatedByUserId: actorUserId ?? null },
    });
    if (swapped.count !== 1) {
      throw new ConflictException(
        `Nalog ${orderId} je u međuvremenu promenjen — prelaz ${from}→${to} nije izvršen. Osveži i pokušaj ponovo.`,
      );
    }
  }
}
