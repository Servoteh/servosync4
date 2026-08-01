import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * TRAG ŠTAMPE (`document_prints`) — ko je, kada i koji obrazac kog dokumenta odštampao,
 * i koji je to po redu primerak. Nadgradnja nad BigBitom: BigBit trag štampe NEMA nigde,
 * a kod nas je do 27.07.2026. postojao samo kao tekst u nozi papira („Štampao: X · datum")
 * koji se nigde nije pamtio — nije se moglo odgovoriti ni ko je izvadio otpremnicu, ni
 * koliko puta, ni da li je papir u tuđoj ruci original.
 *
 * UGOVOR ZA POZIVAOCE (PDF servisi):
 *   const trace = await this.prints.register({ kind: DOCUMENT_PRINT_KIND.STOCK, documentId, variant, userId });
 *   … `trace.isCopy` → žig „KOPIJA" preko papira i značka u zaglavlju;
 *   … `trace.copyNo` → „primerak br. N" u nozi.
 *
 * DVA PRAVILA KOJA SE NE SMEJU MENJATI:
 *
 *  1. `register` NIKAD NE BACA. Štampa je poslednji korak u ruci korisnika; ako upis traga
 *     padne (zaključana tabela, pad veze), papir MORA izaći. U tom slučaju vraća se
 *     `copyNo: null` i `isCopy: false`, pa se u nozi ne ispisuje broj primerka — bolje
 *     nego da papir tvrdi „primerak 1" a niko ne zna koji je zaista.
 *
 *  2. Broj primerka se dodeljuje pod `pg_advisory_xact_lock` UNUTAR transakcije, pa MAX+1
 *     u JS-u (isti obrazac kao `BlagajnaService.nextEntryNumber` i numeracija robnih
 *     dokumenata). Bez lock-a bi dva istovremena klika na „Štampaj" dobila isti broj i
 *     `uq_document_prints_copy` bi jedan od njih odbio — tj. jedna štampa bi pukla.
 */
export const DOCUMENT_PRINT_KIND = {
  /** `stock_documents` — primka, izdatnica, otpremnica, nivelacija, prenosnica, kalkulacija, zapisnik. */
  STOCK: "STOCK",
  /** `inventory_counts` — popisna lista (prazna/popunjena). */
  INVENTORY_COUNT: "INVENTORY_COUNT",
  /** `invoices` — račun, avansni račun, knjižno odobrenje/zaduženje, ino faktura. */
  INVOICE: "INVOICE",
  /** `purchase_orders` — narudžbenica dobavljaču. */
  PURCHASE_ORDER: "PURCHASE_ORDER",
  /** `journal_entries` — nalog za knjiženje (temeljnica). */
  GL_JOURNAL: "GL_JOURNAL",
  /** `cash_journals` — blagajnički dnevnik. */
  CASH_JOURNAL: "CASH_JOURNAL",
  /** `bank_statements` — bankovni izvod. */
  BANK_STATEMENT: "BANK_STATEMENT",
} as const;

export type DocumentPrintKind =
  (typeof DOCUMENT_PRINT_KIND)[keyof typeof DOCUMENT_PRINT_KIND];

export interface PrintTrace {
  /**
   * Id upisanog reda traga; `null` = trag nije upisan (pregled, ili pad upisa).
   * Služi da se red PONIŠTI kad render pukne — v. `discard`.
   */
  id: number | null;
  /** Redni broj primerka; `null` = upis traga nije uspeo (papir svejedno izlazi). */
  copyNo: number | null;
  /** `true` od drugog primerka nadalje — papir nosi žig „KOPIJA". */
  isCopy: boolean;
  /** Ime onoga ko štampa (za nogu); `null` kad korisnik nije poznat. */
  printedBy: string | null;
}

export interface RegisterPrintArgs {
  kind: DocumentPrintKind;
  documentId: number;
  /** Obrazac unutar dokumenta (`otpremnica`, `kalkulacija`, `popunjena`…). Prazno = jedan obrazac. */
  variant?: string | null;
  userId?: number | null;
  /** Ako je pozivalac već učitao ime, prosledi ga — štedi upit i garantuje isti snimak. */
  printedByName?: string | null;
  companyId?: number | null;
}

/** Trag koji se vraća kad upis padne — papir izlazi, ali ne tvrdi broj primerka. */
const NO_TRACE = (printedBy: string | null): PrintTrace => ({
  id: null,
  copyNo: null,
  isCopy: false,
  printedBy,
});

@Injectable()
export class DocumentPrintService {
  private readonly logger = new Logger(DocumentPrintService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Zabeleži štampu i vrati redni broj primerka. Nikad ne baca (v. pravilo 1 iznad).
   */
  async register(args: RegisterPrintArgs): Promise<PrintTrace> {
    const variant = (args.variant ?? "").trim().slice(0, 30);
    let printedBy = args.printedByName?.trim() || null;
    try {
      if (!printedBy) printedBy = await this.resolveUserName(args.userId);

      const created = await this.prisma.$transaction(async (tx) => {
        const lockKey = `print:${args.kind}:${args.documentId}:${variant}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        // MAX se računa u JS-u nad ključem koji indeks `uq_document_prints_copy`
        // pokriva — pod lock-om je to jedan indeksni pretraz, ne skeniranje tabele.
        const last = await tx.documentPrint.findFirst({
          where: {
            documentKind: args.kind,
            documentId: args.documentId,
            variant,
          },
          orderBy: { copyNo: "desc" },
          select: { copyNo: true },
        });
        const next = (last?.copyNo ?? 0) + 1;
        const row = await tx.documentPrint.create({
          data: {
            documentKind: args.kind,
            documentId: args.documentId,
            variant,
            copyNo: next,
            printedByUserId:
              args.userId != null && args.userId > 0 ? args.userId : null,
            printedByName: printedBy ? printedBy.slice(0, 100) : null,
            companyId: args.companyId ?? 0,
          },
          select: { id: true },
        });
        return { id: row.id, copyNo: next };
      });

      return {
        id: created.id,
        copyNo: created.copyNo,
        isCopy: created.copyNo > 1,
        printedBy,
      };
    } catch (e) {
      // Namerno samo upozorenje: štampa se NE prekida zbog traga (v. pravilo 1).
      this.logger.warn(
        `Trag štampe nije upisan (${args.kind}#${args.documentId}${variant ? `/${variant}` : ""}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return NO_TRACE(printedBy);
    }
  }

  /**
   * PONIŠTI trag kad papir NIJE nastao (pad rendera, prekinut odgovor).
   *
   * Broj primerka se dodeljuje PRE rendera, jer je deo sadržaja papira („primerak
   * br. N" u nozi i žig KOPIJA). Bez poništavanja bi neuspela štampa trajno
   * potrošila broj, pa bi PRVI stvarni otisak izašao kao „primerak br. 2" sa žigom
   * KOPIJA — papir bi tvrdio da nije original, a jeste.
   *
   * Briše se SAMO taj jedan red i samo po id-u koji je ova štampa upravo napravila;
   * pravilo „nikad ne brisati tragove po dokumentu" (koje bi oborilo MAX(copy_no))
   * time ostaje netaknuto. Nikad ne baca — poništavanje ne sme da zameni pravu
   * grešku rendera koja se propagira pozivaocu.
   */
  async discard(traceId: number | null): Promise<void> {
    if (traceId == null) return;
    try {
      await this.prisma.documentPrint.delete({ where: { id: traceId } });
    } catch (e) {
      this.logger.warn(
        `Trag štampe ${traceId} nije poništen posle neuspelog rendera: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * Istorija štampe jednog dokumenta (najnovije prvo) — za ekran „ko je ovo štampao".
   * Nikad ne baca; prazna lista je validan odgovor.
   */
  async history(
    kind: DocumentPrintKind,
    documentId: number,
    take = 50,
  ): Promise<
    Array<{
      copyNo: number;
      variant: string;
      printedAt: Date;
      printedByName: string | null;
    }>
  > {
    try {
      const rows = await this.prisma.documentPrint.findMany({
        where: { documentKind: kind, documentId },
        orderBy: { printedAt: "desc" },
        take: Math.min(Math.max(take, 1), 200),
        select: {
          copyNo: true,
          variant: true,
          printedAt: true,
          printedByName: true,
        },
      });
      return rows;
    } catch {
      return [];
    }
  }

  /** Ime korisnika (snimak za papir). `users` je sync-keš — ime se sme promeniti, papir ne sme. */
  private async resolveUserName(
    userId?: number | null,
  ): Promise<string | null> {
    if (userId == null || userId <= 0) return null;
    try {
      const u = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { fullName: true, email: true },
      });
      return u?.fullName?.trim() || u?.email || null;
    } catch {
      return null;
    }
  }
}
