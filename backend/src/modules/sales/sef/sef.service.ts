import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma, type SefOutbox } from "@prisma/client";

/** Red outbox liste — bez velikih tela (ublXml, pdfAttachmentBase64). */
export type SefOutboxListItem = Omit<SefOutbox, "ublXml" | "pdfAttachmentBase64">;
import { PrismaService } from "../../../prisma/prisma.service";
import {
  ADVANCE_DIRECTION,
  ADVANCE_DOCUMENT_TYPE,
} from "../../pdv/dto/advance-vat.dto";
import { loadInvoiceAdvanceDeductions } from "../advance-deduction";
import { InvoicePdfService } from "../print/invoice-pdf.service";
import { SefClientService } from "./sef-client.service";
import {
  UblBuilderService,
  type UblCustomerParty,
  type UblInvoiceItemInput,
  type UblSupplierParty,
} from "./ubl-builder.service";

/**
 * SEF ORCHESTRATOR — životni ciklus izlazne e-fakture (doc 07 §8.5).
 * ==================================================================
 * Vezuje `Invoice` (Faza 5 §A), `UblBuilderService` (XML) i `SefClientService`
 * (mreža) u tok: enqueue → send → refreshStatus → cancel. Status i greške
 * perzistuje na `SefOutbox` (nikad ne obara poslovnu radnju na mrežnu grešku).
 *
 * IDEMPOTENCIJA: `requestId = crypto.randomUUID()` po outbox redu; SEF
 * deduplira slanje po njemu (`@@unique(requestId)` u šemi štiti od duplog reda).
 *
 * IZVOZ: `Invoice.isExport = true` NIJE na domaćem SEF-u (ExportInvoicePolicy) —
 * enqueue odbija izvoznu fakturu (BadRequest).
 *
 * STATUS MAPIRANJE (SEF → SefOutbox.status):
 *   Draft/New            → PENDING
 *   Sent/Seen/Approved…  → SENT/DELIVERED
 *   Rejected/Mistake     → REJECTED
 *   Cancelled/Storno     → CANCELLED
 *
 * ⚠️ NEUSPEH NA SEF-u NE SME DA IZGLEDA KAO USPEH (ispravka 03.08.2026).
 * ---------------------------------------------------------------------------
 * Pravilo „mrežna greška ne obara poslovnu radnju" (§D8) je tačno za SLANJE — red
 * ostaje PENDING i ponavlja se — ali je kod OTKAZIVANJA bilo sprovedeno tako da se
 * greška pretvarala u TIŠINU. Izmereno: outbox #901 `SENT`, `sefInvoiceId 555111`,
 * `cancelInvoice` vrati `{ok:false, httpStatus:-1, "timeout"}` → status je ostajao
 * `SENT`, greška je otišla samo u `error_message`, a `stornoInvoice`
 * (`fakturisanje.service.ts`) je id reda ipak upisao u `sefCancelledOutboxIds`, pa je
 * ekran javio „Račun storniran. Otkazano SEF redova: 1." Kupac pri tom na SEF-u ima
 * ŽIVU e-fakturu za dokument koji je kod nas storniran.
 *
 * Zato `cancel()` sada perzistuje stanje `CANCEL_PENDING` („storniran kod nas, SEF
 * NIJE potvrdio otkazivanje") i BACA — v. obrazloženje uz sam metod.
 */

/**
 * „Storniran kod nas, otkazivanje na SEF-u NIJE potvrđeno." — stanje u koje pada
 * outbox red kad `cancel()` ne dobije potvrdu (mreža, HTTP greška, DRY-RUN).
 *
 * Zašto POSEBAN status, a ne samo `error_message` uz `SENT`: `SENT` je istinit opis
 * SEF strane (dokument tamo i dalje živi), pa bi red bio nerazlučiv od reda kod koga je
 * sve u redu — ni ekran, ni ponovni pokušaj, ni izveštaj ne bi imali po čemu da ga
 * nađu. Ovo je JEDINO stanje u kome se naša evidencija i SEF svesno razilaze, i mora
 * da se vidi kao takvo. Kolona `sef_outbox.status` je `VarChar(20)` bez CHECK-a, pa
 * nova vrednost ne traži migraciju (14 znakova).
 */
export const SEF_OUTBOX_CANCEL_PENDING = "CANCEL_PENDING";

/**
 * Statusi iz kojih se sme pozvati OTKAZIVANJE (`/sales-invoice/cancel`).
 *
 * ⚠️ `DELIVERED` JE UKLONJEN 03.08.2026 (nalaz N3). Doc 07 §8.2 popisuje DVE rute sa DVA
 * različita guard-a: `/sales-invoice/cancel` (`ER_FakturaMozeDaSeOtkaze`) i
 * `/sales-invoice/storno` (`ER_FakturaMozeDaSeStornira`). Ovaj jedan skup je stajao za
 * oba, a implementirana je samo ruta za otkazivanje — pa je storniranje PRIHVAĆENE
 * e-fakture odlazilo na pogrešnu rutu. Izmereno: nad `DELIVERED` redom SEF vrati HTTP
 * 400, `cancel()` NIJE bacao, status je ostajao `DELIVERED` uz `error_message`, dakle
 * korisnik nije dobio nikakav znak da otkazivanje nije prošlo (nad `REJECTED` isti poziv
 * daje 409, tj. brana za `DELIVERED` prosto nije postojala).
 * Ruta za storno se NE IZMIŠLJA — v. `backend/docs/PREOSTALE_FAZE.md`, „🔶 OTVORENO".
 *
 * `CANCEL_PENDING` je ovde da bi ponovni pokušaj bio moguć (SEF cancel je idempotentan
 * po `invoiceId`).
 */
const CANCELLABLE_LOCAL_STATUSES = new Set([
  "PENDING",
  "SENT",
  SEF_OUTBOX_CANCEL_PENDING,
]);

/** SEF limit priloga (25 MB) — veći PDF se preskače (prilog nije obavezan). */
const MAX_PDF_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Rezultat enqueue-a: outbox red + eventualno (ne-blokirajuće) upozorenje. */
export interface EnqueueResult {
  outbox: SefOutbox;
  warning: string | null;
}

@Injectable()
export class SefService {
  private readonly logger = new Logger(SefService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: SefClientService,
    private readonly ubl: UblBuilderService,
    private readonly invoicePdf: InvoicePdfService,
  ) {}

  /**
   * Kreiraj SefOutbox red za fakturu: gradi UBL (sa PDF prilogom + OrderReference),
   * upisuje PENDING + requestId. Ne šalje (to je `send`). Odbija izvoz (nije na
   * domaćem SEF-u) i draft (level != 0 / status DRAFT — samo knjižena faktura ide
   * na SEF). Vraća `{ outbox, warning }` — warning je ne-blokirajuće upozorenje
   * (npr. javni sektor bez broja narudžbenice), ne baca izuzetak.
   */
  async enqueue(invoiceId: number, userId?: number): Promise<EnqueueResult> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { items: { orderBy: { lineNo: "asc" } } },
    });
    if (!invoice) throw new NotFoundException(`Faktura ${invoiceId} ne postoji.`);

    if (invoice.isExport) {
      throw new BadRequestException(
        "Izvozna faktura ne ide na domaći SEF (ExportInvoicePolicy).",
      );
    }
    if (invoice.level !== 0 || invoice.status === "DRAFT") {
      throw new BadRequestException(
        "Samo knjižena faktura (level 0) sme na SEF — dokument je još draft/predračun.",
      );
    }

    // VRSTA DOKUMENTA — kapija (nalaz N1). Do 03.08.2026. je ovde nije bilo, pa je
    // kapija propuštala SVE što je level 0 i POSTED. v. `assertDocumentTypeMayGoToSef`.
    await this.assertDocumentTypeMayGoToSef(invoice);

    // Firma-izdavalac + kupac za UBL strane.
    const company = await this.prisma.company.findUnique({
      where: { id: invoice.companyId },
    });
    if (!company) {
      throw new BadRequestException(
        `Firma (companyId=${invoice.companyId}) nije nađena — nema izdavaoca za UBL.`,
      );
    }
    const customer = invoice.customerId
      ? await this.prisma.customer.findUnique({
          where: { id: invoice.customerId },
        })
      : null;
    if (!customer) {
      throw new BadRequestException(
        "Faktura nema kupca (customerId) — SEF zahteva primaoca.",
      );
    }

    const supplier: UblSupplierParty = {
      name: company.companyName,
      taxId: company.taxId ?? "",
      registrationNumber: company.registrationNumber,
      address: company.address,
      city: company.city,
      // Grupa D: podaci za plaćanje → cac:PaymentMeans. IBAN/SWIFT (kolone dodate
      // migracijom 20260727110000) imaju prednost kod ino uplate; domaći tekući
      // račun je fallback.
      bankAccount: company.bankAccount,
      iban: company.iban,
      swift: company.swift,
    };
    const buyer: UblCustomerParty = {
      name: customer.name,
      taxId: customer.taxId,
      registrationNumber: customer.registrationNumber,
      address: customer.address,
      city: customer.city,
      publicSectorId: customer.publicSectorId,
    };

    // — Grupa D: jedinica mere po stavci (items.unit → UN/ECE Rec 20 unitCode) —
    // Do sada je svaka stavka išla sa tvrdim `unitCode="H87"` bez obzira na stvarnu JM
    // (kilogram, metar, m²…), pa je kupac na SEF-u dobijao pogrešnu jedinicu. Jedan
    // upit po fakturi (findMany po id-evima), ne po stavci.
    const itemIds = [
      ...new Set(
        invoice.items
          .map((it) => it.itemId)
          .filter((id): id is number => id != null),
      ),
    ];
    const unitByItemId = new Map<number, string | null>();
    if (itemIds.length > 0) {
      const catalog = await this.prisma.item.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, unit: true },
      });
      for (const row of catalog) unitByItemId.set(row.id, row.unit);
    }

    const items: UblInvoiceItemInput[] = invoice.items.map((it) => ({
      lineNo: it.lineNo,
      description: it.description,
      itemId: it.itemId,
      // Slobodna (uslužna) stavka nema artikal → nema JM; builder tada šalje H87.
      unit: it.itemId != null ? (unitByItemId.get(it.itemId) ?? null) : null,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      discountPercent: it.discountPercent,
      vatRateCode: it.vatRateCode, // A5: stopa/kategorija po liniji (TaxSubtotal granularnost)
      vatBase: it.vatBase,
      vatAmount: it.vatAmount,
      lineTotal: it.lineTotal,
    }));

    // — D7: PDF prilog fakture kroz postojeći InvoicePdfService (cac:Attachment) —
    // Generisanje/veličina priloga NE ruši enqueue: PDF prilog je opciona pogodnost.
    let pdfBase64: string | null = null;
    let pdfFileName: string | null = null;
    try {
      const { buffer, fileName } = await this.invoicePdf.buildInvoicePdf(
        invoice.id,
      );
      if (buffer.length > MAX_PDF_ATTACHMENT_BYTES) {
        this.logger.warn(
          `PDF prilog fakture ${invoice.id} (${buffer.length} B) prelazi SEF limit ` +
            `(${MAX_PDF_ATTACHMENT_BYTES} B) — prilog se preskače.`,
        );
      } else {
        pdfBase64 = buffer.toString("base64");
        pdfFileName = fileName;
      }
    } catch (err) {
      this.logger.warn(
        `Generisanje PDF priloga za fakturu ${invoice.id} nije uspelo — ` +
          `enqueue se nastavlja bez priloga: ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
    }

    // — Batch C §C1a: konačni račun na kome je odbijen avans nosi referencu AVR-a
    //   (cac:BillingReference) + PrepaidAmount, pa SEF PayableAmount pokazuje
    //   STVARNI ostatak za uplatu (grossTotal − avans), a ne uvek 0.
    //   N:M (migracija 20260726120000): račun može zatvarati VIŠE avansa, pa ide
    //   po jedan `cac:BillingReference` za svaki odbijen avans. Zbir uz broj samo
    //   prvog avansa bi bio netačna referenca na poreskom dokumentu (revizija, VISOK).
    //
    // ⚠️ IZNOS I REFERENCE IZ ISTOG PRAVILA (`./../advance-deduction`, ispravka
    // 02.08.2026). Ovde je do sada stajalo „ILI-ILI": zbir primena kad ih ima, inače
    // kolona. Za račun sa zatečenom 1:1 vezom (pdv modul, ruta `link-final`) I novom
    // N:M primenom e-faktura je nosila PrepaidAmount samo za N:M deo — dakle veći
    // PayableAmount nego što kupac duguje, i BillingReference bez jednog avansa.
    // Papir je isti kvar zatvorio istog dana; sada oba čitaju jednu funkciju.
    const deductions = await loadInvoiceAdvanceDeductions(this.prisma, invoice);

    // ⚠️ IZNOS BEZ REFERENCE SE NE ŠALJE — ceo dokument se ODBIJA (odluka 02.08.2026).
    // `advance_invoice_id` je MEK ref (nema FK — schema.prisma, Invoice), a spojna
    // tabela ima ON DELETE CASCADE. Kad AVR nestane (ručno čišćenje test-podataka
    // 4.0, ispravka u bazi), kolona i pokazivač ostaju, pa red umanjenja postoji BEZ
    // broja avansnog računa. Do sada je `filter` takav broj tiho izbacivao iz
    // referenci, a ceo zbir je i dalje išao u `PrepaidAmount`: e-faktura tvrdi
    // avansnu uplatu koju ne referencira nijedan `cac:BillingReference`.
    //
    // Zašto ODBIJANJE, a ne „izostavi iznos": obe tihe opcije šalju NETAČAN poreski
    // dokument. Bez iznosa `PayableAmount` traži pun iznos — kupac plaća 3.000 više
    // nego što duguje, i to na dokumentu koji se razilazi sa PDF prilogom ISTOG
    // slanja (štampa umanjenje prikazuje). Sa iznosom bez reference dokument tvrdi
    // avans koji ne dokazuje. Jedini ispravan ishod je da čovek popravi vezu pre
    // slanja; SEF nije mesto za pogađanje. Isti obrazac kao builder kod praznog
    // datuma prometa: glasan 400 umesto tihe laži.
    const danglingAdvanceIds = deductions.lines
      .filter((l) => !l.advanceDocumentNumber)
      .map((l) => l.advanceInvoiceId);
    if (danglingAdvanceIds.length > 0) {
      throw new BadRequestException(
        `Faktura ${invoice.documentNumber} odbija avans (#${danglingAdvanceIds.join(", #")}) ` +
          `kome se ne može utvrditi broj avansnog računa — e-faktura bi nosila ` +
          `PrepaidAmount ${deductions.total.toFixed(2)} bez reference na avansni račun ` +
          `(cac:BillingReference). Popravi vezu avansa na računu pa ponovi slanje.`,
      );
    }

    const prepaymentReferences = deductions.lines
      .map((l) => l.advanceDocumentNumber)
      .filter((n): n is string => !!n);
    const prepaidAmount = deductions.total.greaterThan(0)
      ? deductions.total
      : null;

    // — D6: upozorenje javni sektor bez broja narudžbenice (ne blokira) —
    let warning: string | null = null;
    const poNumber = invoice.poNumber?.trim();
    if (customer.publicSectorId && !poNumber) {
      warning =
        "Kupac je iz javnog sektora, a broj narudžbenice nije unet — SEF može odbiti fakturu.";
    }

    // — Datum prometa (BT-72) i poziv na broj (BT-83) —
    // Kolone `invoices.supply_date` i `invoices.payment_reference` postoje od
    // migracije 20260727140000, pa se čitaju direktno (do tada su se čitale kroz
    // defanzivan cast, jer ih grupa B nije isporučila).
    // PRAZAN datum prometa se NE PODMEĆE datumom izdavanja: `cac:Delivery` tada
    // izostaje. Datum izdavanja NIJE datum prometa i podmetanje bi bila laž na
    // poreskom dokumentu. Poziv na broj bez unosa pada na BROJ DOKUMENTA (BigBit
    // paritet — v. `buildPaymentMeans`).
    const ublXml = this.ubl.build({
      invoice: {
        documentType: invoice.documentType,
        documentNumber: invoice.documentNumber,
        documentDate: invoice.documentDate,
        dueDate: invoice.dueDate,
        currency: invoice.currency,
        isExport: invoice.isExport,
        netTotal: invoice.netTotal,
        vatTotal: invoice.vatTotal,
        grossTotal: invoice.grossTotal,
        note: invoice.note,
        poNumber: invoice.poNumber,
        // Avansni račun → InvoiceTypeCode 386. Šifra se NE prepisuje ovde: jedna je
        // (`pdv/dto/advance-vat.dto.ts` → `ADVANCE_DOCUMENT_TYPE`), a nju čita i sam
        // avansni tok. Do 03.08.2026. je ovde stajao literal `"AVR"` — četvrti primerak
        // iste konstante u modulu prodaje.
        isPrepayment: normalizeDocumentType(invoice.documentType) === ADVANCE_DOCUMENT_TYPE,
        // Jednina (`prepaymentReference`) je stariji ulaz buildera i ostaje samo kao
        // njegova rezerva — ovde uvek ide LISTA, jer je ona jedina tačna kad račun
        // zatvara više avansa. Prazna lista = avansa nema, pa nema ni reference.
        prepaymentReference: null,
        prepaymentReferences,
        prepaidAmount,
        // Datum prometa → cac:Delivery/cbc:ActualDeliveryDate. Knjižen račun ga uvek
        // ima (`postInvoice` ga podrazumeva na datum izdavanja ako nije unet), pa ovde
        // ostaje null samo za račune proknjižene PRE uvođenja polja — za njih builder
        // baca jasan 400 umesto da pošalje račun bez obaveznog elementa.
        supplyDate: invoice.supplyDate,
        paymentReference: invoice.paymentReference,
      },
      items,
      supplier,
      customer: buyer,
      pdfBase64,
      pdfFileName,
    });

    const outbox = await this.prisma.sefOutbox.create({
      data: {
        invoiceId: invoice.id,
        requestId: randomUUID(),
        ublXml,
        pdfAttachmentBase64: pdfBase64,
        status: "PENDING",
      },
    });

    // T3/A8: SEF status-istorija — PENDING (u red).
    await this.logStatus({
      outboxId: outbox.id,
      status: "PENDING",
      note: warning,
      userId,
    });

    return { outbox, warning };
  }

  /**
   * Pošalji outbox red na SEF. Na uspeh: SENT + sefInvoiceId + sentAt.
   * Na (mrežnu) grešku: ostaje PENDING, upisuje errorMessage — NE baca.
   */
  async send(outboxId: number, userId?: number): Promise<SefOutbox> {
    const outbox = await this.getOutbox(outboxId);
    if (outbox.status === "CANCELLED") {
      throw new ConflictException("Outbox je otkazan — ne može se slati.");
    }
    // Red koji čeka potvrdu otkazivanja je dokument koji smo VEĆ stornirali kod nas —
    // ponovno slanje bi kupcu poslalo drugu e-fakturu za isti storniran dokument.
    if (outbox.status === SEF_OUTBOX_CANCEL_PENDING) {
      throw new ConflictException(
        "Outbox čeka potvrdu otkazivanja na SEF-u (dokument je storniran kod nas) — " +
          "ne može se slati. Prvo ponovi otkazivanje.",
      );
    }

    // Defense in depth (review Batch A F3): faktura je u međuvremenu mogla biti stornirana
    // dok outbox red još stoji PENDING (npr. red kreiran, pa storno pre lokalnog otkazivanja).
    // Storniran dokument NE sme da ode na SEF.
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: outbox.invoiceId },
      select: { status: true },
    });
    if (invoice?.status === "CANCELLED") {
      await this.logStatus({
        outboxId,
        status: "ERROR",
        note: "Slanje obustavljeno — faktura je stornirana.",
        userId,
      });
      throw new ConflictException(
        "Faktura je stornirana — slanje obustavljeno.",
      );
    }

    const res = await this.client.sendInvoice(outboxId);

    if (res.dryRun) {
      // DRY-RUN: ne menja status (ostaje PENDING), samo beleži da nije poslato.
      const row = await this.prisma.sefOutbox.update({
        where: { id: outboxId },
        data: {
          errorMessage: "DRY-RUN: SEF_API_KEY nije podešen — nije poslato.",
        },
      });
      await this.logStatus({
        outboxId,
        status: "DRY_RUN",
        note: "Slanje: DRY-RUN (SEF_API_KEY nije podešen).",
        userId,
      });
      return row;
    }

    if (res.ok) {
      const row = await this.prisma.sefOutbox.update({
        where: { id: outboxId },
        data: {
          status: "SENT",
          sefInvoiceId: res.sefInvoiceId ?? outbox.sefInvoiceId,
          errorMessage: null,
          sentAt: new Date(),
        },
      });
      await this.logStatus({
        outboxId,
        status: "SENT",
        note: row.sefInvoiceId ? `SEF ID ${row.sefInvoiceId}` : null,
        userId,
      });
      return row;
    }

    // Mrežna/HTTP greška: zabeleži, ostavi PENDING za retry.
    const row = await this.prisma.sefOutbox.update({
      where: { id: outboxId },
      data: { errorMessage: res.errorMessage ?? "Nepoznata SEF greška." },
    });
    await this.logStatus({
      outboxId,
      status: "ERROR",
      note: `Slanje nije uspelo: ${res.errorMessage ?? "nepoznata SEF greška."}`,
      userId,
    });
    return row;
  }

  /**
   * Osveži status outbox reda sa SEF-a (polling). Mapira SEF status u lokalni.
   * Ne baca na mrežnu grešku.
   */
  async refreshStatus(outboxId: number, userId?: number): Promise<SefOutbox> {
    const before = await this.getOutbox(outboxId);
    const res = await this.client.pollStatus(outboxId);

    if (res.dryRun) return before;

    if (!res.ok) {
      return this.prisma.sefOutbox.update({
        where: { id: outboxId },
        data: {
          statusPolledAt: new Date(),
          errorMessage: res.errorMessage ?? "Polling greška.",
        },
      });
    }

    const localStatus = mapSefStatus(res.sefStatus);

    // ⚠️ `CANCEL_PENDING` SE NE GAZI POLLING-om (osim potvrdom otkazivanja).
    // Red u tom stanju nosi činjenicu koju SEF ne zna: dokument je kod nas STORNIRAN, a
    // otkazivanje na SEF-u nije potvrđeno. SEF na to pitanje odgovara `Sent`/`Seen` —
    // tačno, ali za nas nepotpuno — pa bi prvi poll vratio red u `SENT` i obrisao jedini
    // trag da otkazivanje duguje ponovni pokušaj. Prihvata se samo `CANCELLED`: to je
    // potvrda koju smo i čekali, i njome se stanje zatvara samo od sebe.
    const isCancelConfirmed = localStatus === "CANCELLED";
    const nextStatus =
      before.status === SEF_OUTBOX_CANCEL_PENDING && !isCancelConfirmed
        ? null
        : localStatus;

    const row = await this.prisma.sefOutbox.update({
      where: { id: outboxId },
      data: {
        status: nextStatus ?? undefined,
        statusPolledAt: new Date(),
        // Greška otkazivanja se ne briše dok otkazivanje nije potvrđeno — inače bi
        // poll obrisao i poruku zbog koje red uopšte stoji u redu za ponovni pokušaj.
        errorMessage:
          before.status === SEF_OUTBOX_CANCEL_PENDING && !isCancelConfirmed
            ? undefined
            : null,
      },
    });

    // T3/A8: log samo kad se status STVARNO promenio (izbegni šum od pollinga).
    if (nextStatus && nextStatus !== before.status) {
      await this.logStatus({
        outboxId,
        status: nextStatus,
        note: res.sefStatus
          ? `Osveženo sa SEF-a (${res.sefStatus})`
          : "Osveženo sa SEF-a.",
        userId,
      });
    }
    return row;
  }

  /**
   * Otkaži e-fakturu na SEF-u (`POST /sales-invoice/cancel`, guard
   * `ER_FakturaMozeDaSeOtkaze` — doc 07 §8.2).
   *
   * `reason` (opciono) = razlog storna (npr. iz storna fakture A5); SEF cancel API
   * nema polje za slobodan tekst, pa se razlog loguje (traceback), ne šalje portalu.
   *
   * ── ISHODI (svaki je RAZLIČIT i vidljiv) ──────────────────────────────────────
   *   • red nikad nije stigao na SEF (nema `sefInvoiceId`) → lokalno `CANCELLED`,
   *     bez mrežnog poziva, bez greške;
   *   • SEF potvrdio                                       → `CANCELLED`;
   *   • SEF nije potvrdio (mreža / HTTP greška / DRY-RUN)  → `CANCEL_PENDING` + BACA;
   *   • dokument je na SEF-u PRIHVAĆEN (`DELIVERED`)       → 409, bez poziva (N3).
   *
   * ── ZAŠTO OVDE BACA, A `send()` NE (odluka 03.08.2026, nalaz N2) ──────────────
   * Pravilo „mrežna greška ne obara poslovnu radnju" ovde je već ispoštovano PRE ovog
   * poziva: storniranje dokumenta (`fakturisanje.stornoInvoice`) je u tom trenutku već
   * upisano — faktura je `CANCELLED`, GL nalog je storniran, rezervacije oslobođene. Ono
   * što pada nije poslovna radnja nego IZVEŠTAJ o njoj, i pada tačno.
   *
   * Zašto ne „tiho, pa ćemo videti na ekranu": jedini potrošač koji o storniranju javlja
   * korisniku (`fakturisanje.service.ts`, `stornoInvoice`) rezultat ovog poziva NE GLEDA —
   * upiše `row.id` u `sefCancelledOutboxIds` i ekran ispiše „Otkazano SEF redova: 1".
   * Neuspeh bez izuzetka je zato na svakom sloju iznad NERAZLUČIV od uspeha; izmereno na
   * outbox #901 (`SENT`, `sefInvoiceId 555111`, timeout) — korisnik je dobio „Račun
   * storniran i na SEF-u", a kupac je i dalje imao važeću e-fakturu.
   *
   * Cena izbora (svesno prihvaćena): petlja u `stornoInvoice` prekida se na prvom
   * neuspelom redu, pa PENDING redovi tog dokumenta ostanu neotkazani. To NIJE opasno —
   * `send()` odbija slanje storniranog dokumenta (defense in depth) — ali jeste
   * nedovršeno; zapisano u `backend/docs/PREOSTALE_FAZE.md` kao posao nad tim fajlom
   * (skupljati ishod po redu umesto prekida).
   */
  async cancel(
    outboxId: number,
    reason?: string,
    userId?: number,
  ): Promise<SefOutbox> {
    const outbox = await this.getOutbox(outboxId);

    // N3 — PRIHVAĆENA e-faktura se ne OTKAZUJE nego STORNIRA, drugom rutom koju ovaj
    // kod nema. Bez ove brane je poziv odlazio na `/cancel`, SEF vraćao 400, a red
    // ostajao `DELIVERED` bez ijednog znaka korisniku (izmereno). Log-red se upisuje
    // baš zato što je stanje opasno: dokument je (najverovatnije) storniran kod nas, a
    // na SEF-u ga je kupac prihvatio.
    if (outbox.status === "DELIVERED") {
      await this.logStatus({
        outboxId,
        status: "ERROR",
        note:
          "Otkazivanje odbijeno: e-faktura je PRIHVAĆENA na SEF-u — traži se " +
          "storniranje (/sales-invoice/storno), koje još nije implementirano.",
        userId,
      });
      throw new ConflictException(
        `E-faktura outbox ${outboxId} je na SEF-u PRIHVAĆENA (status "${outbox.status}") i ` +
          "ne može da se otkaže — za prihvaćenu fakturu SEF traži STORNIRANJE " +
          "(druga ruta i drugi guard, doc 07 §8.2), a ono u ovoj verziji nije " +
          "implementirano. Ispravka ide knjižnim odobrenjem; v. PREOSTALE_FAZE.md.",
      );
    }

    if (!CANCELLABLE_LOCAL_STATUSES.has(outbox.status)) {
      throw new ConflictException(
        `Faktura u statusu "${outbox.status}" ne može da se otkaže/stornira.`,
      );
    }

    const trimmedReason = reason && reason.trim().length > 0 ? reason.trim() : null;
    if (trimmedReason) {
      this.logger.log(
        `SEF cancel outbox ${outboxId} (invoice ${outbox.invoiceId}) — razlog: ${trimmedReason}`,
      );
    }

    // Red BEZ `sefInvoiceId` nikada nije stigao do SEF-a (slanje nije prošlo ili nije ni
    // pokušano) — nema šta da se otkazuje na portalu, pa se otkazuje LOKALNO. Bez ovoga
    // bi takav red išao u `CANCEL_PENDING` i bacio 503 „SEF nije potvrdio", što je
    // netačno: SEF nije ni pitan, i nema šta da potvrdi. (Ista radnja koju za sve PENDING
    // redove dokumenta radi `cancelPendingLocally`.)
    if (!outbox.sefInvoiceId) {
      const row = await this.prisma.sefOutbox.update({
        where: { id: outboxId },
        data: { status: "CANCELLED", errorMessage: null },
      });
      await this.logStatus({
        outboxId,
        status: "CANCELLED",
        note: trimmedReason
          ? `Otkazano lokalno (red nikada nije poslat na SEF) — ${trimmedReason}`
          : "Otkazano lokalno — red nikada nije poslat na SEF.",
        userId,
      });
      return row;
    }

    const res = await this.client.cancelInvoice(outboxId);

    if (res.ok) {
      const row = await this.prisma.sefOutbox.update({
        where: { id: outboxId },
        data: { status: "CANCELLED", errorMessage: null },
      });
      await this.logStatus({
        outboxId,
        status: "CANCELLED",
        note: trimmedReason,
        userId,
      });
      return row;
    }

    // ── NEPOTVRĐENO OTKAZIVANJE ────────────────────────────────────────────────
    // DRY-RUN je ovde IST ISHOD kao mrežna greška, a ne poseban „bezbedan" slučaj:
    // dokument je storniran kod nas, a na SEF-u nije otkazan. Razlika je samo u razlogu,
    // pa je razlog u poruci. (Do 03.08.2026. je DRY-RUN ostavljao status netaknut i
    // vraćao red kao da je sve u redu.)
    const errorMessage = res.dryRun
      ? "DRY-RUN: SEF_API_KEY nije podešen — otkazivanje NIJE poslato na SEF."
      : (res.errorMessage ?? "Nepoznata SEF greška pri otkazivanju.");

    // Stanje se upisuje PRE bacanja — izuzetak nosi poruku korisniku, a red mora da
    // ostane pronađiv i posle nje (ekran /sef, ponovni pokušaj).
    await this.prisma.sefOutbox.update({
      where: { id: outboxId },
      data: { status: SEF_OUTBOX_CANCEL_PENDING, errorMessage },
    });
    await this.logStatus({
      outboxId,
      status: SEF_OUTBOX_CANCEL_PENDING,
      note: trimmedReason
        ? `Otkazivanje nije potvrđeno (${errorMessage}) — razlog storna: ${trimmedReason}`
        : `Otkazivanje nije potvrđeno: ${errorMessage}`,
      userId,
    });

    throw new ServiceUnavailableException(
      `Otkazivanje e-fakture na SEF-u NIJE potvrđeno (outbox ${outboxId}, SEF ID ` +
        `${outbox.sefInvoiceId}): ${errorMessage} Dokument je storniran kod nas, ali kupac ` +
        "na SEF-u i dalje vidi važeću e-fakturu. Red je označen statusom " +
        `${SEF_OUTBOX_CANCEL_PENDING} — ponovi otkazivanje na ekranu /sef kad veza proradi.`,
    );
  }

  /**
   * VRSTA DOKUMENTA — SME LI UOPŠTE NA SEF (nalaz N1, 03.08.2026).
   * ===========================================================================
   * Do ove brane je kapija gledala samo `level`/`status`, pa je na e-fakture kupca
   * odlazilo sve što je knjiženo. Izmereno: `REV-8/26` (revers, level 0, POSTED,
   * domaći, 10.000) prošao je `enqueue`, red je otišao u outbox `PENDING`, a UBL je
   * nosio `cbc:ID = REV-8/26`, `InvoiceTypeCode = 380` (KOMERCIJALNA FAKTURA) i
   * `PayableAmount = 10000.00`. Revers je zapis o zaduženju/vraćanju opreme — po njemu
   * se ništa ne plaća i ne ulazi ni u jednu poresku evidenciju.
   *
   * ── SPISAK SE NE PIŠE OVDE ─────────────────────────────────────────────────
   * Nijedan nov skup šifara: odgovor daje REGISTAR VRSTA (`document_types`), kolona
   * `post_in_vat_ledger` („Knjižiti u PDV evidenciju", BigBit `KnjizitiUPDVEvidenciju`
   * — v. `docs/schema-rename-map.md`). Veza nije proizvoljna nego definicijska: kod
   * domaćeg B2B prometa e-faktura na SEF-u JESTE račun, a račun je poreski dokument.
   * Vrsta koja ne ulazi u PDV evidenciju (KIF) nije poreski dokument, pa na SEF-u nema
   * šta da traži — i obrnuto.
   *
   * Migracija `20260728150000_registar_vrsta_i_koeficijent_dokumenta` je tu podelu već
   * posejala, i ona se poklapa sa traženom: `IFR`, `IFGP`, `IFUSL`, `IZVRO`, `IZVGP`,
   * `IZVUS`, `AVR` → `TRUE`; `PON`, `PROF`, `REV` → `FALSE`. Nova vrsta dokumenta se
   * uključuje/isključuje jednim redom u šifarniku, bez izmene ovog koda — tačno kao
   * `stock_check` i `screen_kind`.
   *
   * ── FAIL-CLOSED ────────────────────────────────────────────────────────────
   * Vrsta koja u registru NE POSTOJI se odbija. Tiho propuštanje nepoznate vrste je
   * ista greška zbog koje je revers i prošao: dokument o kome šifarnik ne zna ništa
   * ne sme da ode kupcu kao poreski dokument. Isti obrazac kao praznina datuma prometa
   * u builderu — glasan 400 umesto tihe laži.
   */
  private async assertDocumentTypeMayGoToSef(invoice: {
    documentNumber: string;
    documentType: string;
    advanceDirection?: string | null;
  }): Promise<void> {
    const code = normalizeDocumentType(invoice.documentType);
    if (!code) {
      throw new BadRequestException(
        `Dokument ${invoice.documentNumber} nema vrstu (documentType) — bez nje se ne ` +
          "može utvrditi sme li na SEF.",
      );
    }

    // SMER pre vrste: ulazni avansni račun nosi ISTU vrstu (`AVR`) kao izlazni, a to je
    // dobavljačev dokument koji smo samo evidentirali. Slanje bi kupcu poslalo tuđu
    // e-fakturu pod našim brojem.
    const direction = (invoice.advanceDirection ?? "").trim().toLowerCase();
    if (direction === ADVANCE_DIRECTION.IN) {
      throw new BadRequestException(
        `Dokument ${invoice.documentNumber} je ULAZNI avansni račun (dobavljačev) — ` +
          "izlazni SEF tok šalje samo dokumente koje MI izdajemo.",
      );
    }

    const registry = await this.prisma.documentType.findUnique({
      where: { code },
      select: {
        code: true,
        description: true,
        isInbound: true,
        postInVatLedger: true,
      },
    });

    if (!registry) {
      throw new BadRequestException(
        `Vrsta dokumenta „${code}" ne postoji u registru vrsta (document_types), pa se ` +
          `ne zna je li poreski dokument — ${invoice.documentNumber} se ne šalje na SEF. ` +
          "Dodaj vrstu u šifarnik pa ponovi slanje.",
      );
    }
    if (registry.isInbound) {
      throw new BadRequestException(
        `Vrsta ${code} (${registry.description}) je ULAZNI dokument — izlazni SEF tok ` +
          `šalje samo ono što mi izdajemo (${invoice.documentNumber}).`,
      );
    }
    if (registry.postInVatLedger !== true) {
      throw new BadRequestException(
        `Dokument ${invoice.documentNumber} je vrste ${code} (${registry.description}), ` +
          "koja se po registru vrsta NE knjiži u PDV evidenciju (KIF) — dakle nije " +
          "poreski dokument i ne ide na SEF. Na SEF idu samo fakture i avansni računi.",
      );
    }
  }

  /**
   * Lokalno otkaži SVE PENDING outbox redove fakture (storno fakture — review Batch A F3).
   * SEF poziv NIJE potreban jer PENDING red nikada nije poslat: updateMany PENDING → CANCELLED
   * + status-log po redu. SENT/DELIVERED/CANCEL_PENDING se ne diraju ovde: prva dva idu kroz
   * `cancel()` (SEF API), a `CANCEL_PENDING` je red koji ČEKA potvrdu sa SEF-a — lokalno
   * „otkazivanje" bi obrisalo jedini trag da otkazivanje duguje ponovni pokušaj.
   * Vraća id-eve lokalno otkazanih redova.
   */
  async cancelPendingLocally(
    invoiceId: number,
    reason?: string,
    userId?: number,
  ): Promise<number[]> {
    const pending = await this.prisma.sefOutbox.findMany({
      where: { invoiceId, status: "PENDING" },
      select: { id: true },
    });
    if (pending.length === 0) return [];

    const trimmed = reason && reason.trim().length > 0 ? reason.trim() : null;
    const note = trimmed ? `storno fakture — ${trimmed}` : "storno fakture";

    await this.prisma.sefOutbox.updateMany({
      where: { invoiceId, status: "PENDING" },
      data: { status: "CANCELLED", errorMessage: null },
    });
    for (const row of pending) {
      await this.logStatus({ outboxId: row.id, status: "CANCELLED", note, userId });
    }
    return pending.map((r) => r.id);
  }

  /**
   * Lista outbox redova (opciono filter po statusu / invoiceId).
   * BEZ velikih tela (ublXml, pdfAttachmentBase64) — red nosi ceo UBL XML i
   * base64 PDF prilog, pa bi lista od 200 redova bila višedeset-MB odgovor.
   * Puna tela se čitaju samo na detalju (getOutbox).
   */
  listOutbox(params: {
    status?: string;
    invoiceId?: number;
    skip?: number;
    take?: number;
  }): Promise<SefOutboxListItem[]> {
    const take = Math.min(Math.max(params.take ?? 50, 1), 200);
    return this.prisma.sefOutbox.findMany({
      where: {
        status: params.status,
        invoiceId: params.invoiceId,
      },
      select: {
        id: true,
        invoiceId: true,
        requestId: true,
        status: true,
        sefInvoiceId: true,
        errorMessage: true,
        sentAt: true,
        statusPolledAt: true,
        createdAt: true,
      },
      orderBy: { id: "desc" },
      skip: params.skip && params.skip > 0 ? params.skip : undefined,
      take,
    });
  }

  private async getOutbox(outboxId: number): Promise<SefOutbox> {
    const outbox = await this.prisma.sefOutbox.findUnique({
      where: { id: outboxId },
    });
    if (!outbox) throw new NotFoundException(`SefOutbox ${outboxId} ne postoji.`);
    return outbox;
  }

  /**
   * Hronološki status-log za JEDAN outbox ILI incoming red (timeline na /sef).
   * Sortiran rastuće po vremenu (najstariji prvo). Vraća do 200 zapisa. Bez filtera
   * vraća prazno (uvek se traži po jednom redu — controller obezbeđuje parametar).
   */
  listStatusLog(params: { outboxId?: number; incomingId?: number }) {
    const where: Prisma.SefStatusLogWhereInput = {};
    if (params.outboxId != null) where.outboxId = params.outboxId;
    if (params.incomingId != null) where.incomingId = params.incomingId;
    return this.prisma.sefStatusLog.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 200,
    });
  }

  /**
   * Best-effort upis u SEF status-log (append-only istorija dokument-toka). Log NE
   * sme da obori poslovnu radnju (enqueue/send/refresh/cancel) — greška se samo
   * zabeleži u logger. note se kroti na 500 (VarChar limit šeme).
   */
  private async logStatus(entry: {
    outboxId?: number | null;
    incomingId?: number | null;
    status: string;
    note?: string | null;
    userId?: number | null;
  }): Promise<void> {
    try {
      await this.prisma.sefStatusLog.create({
        data: {
          outboxId: entry.outboxId ?? null,
          incomingId: entry.incomingId ?? null,
          status: entry.status,
          note: entry.note ? entry.note.slice(0, 500) : null,
          userId: entry.userId ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(
        `SEF status-log upis nije uspeo (outbox=${entry.outboxId ?? "-"}, status=${entry.status}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * Šifra vrste dokumenta u obliku u kom stoji u registru (`document_types.code`) —
 * velika slova, bez razmaka. Isti oblik koji koristi `DocumentTypesService.byCode`.
 */
function normalizeDocumentType(raw: string | null | undefined): string {
  return (raw ?? "").trim().toUpperCase();
}

/**
 * Mapiranje SEF statusa (doc 07 §6.2) u lokalni SefOutbox.status.
 * Vraća undefined za nepoznat status (status se ne menja).
 */
function mapSefStatus(sef?: string): string | null {
  if (!sef) return null;
  const s = sef.toLowerCase();
  if (s.includes("draft") || s.includes("nacrt") || s === "new") return "PENDING";
  if (s.includes("reject") || s.includes("odbij") || s.includes("mistake"))
    return "REJECTED";
  if (s.includes("cancel") || s.includes("storno")) return "CANCELLED";
  if (
    s.includes("approv") ||
    s.includes("odobr") ||
    s.includes("seen") ||
    s.includes("delivered")
  )
    return "DELIVERED";
  if (s.includes("sent") || s.includes("posla")) return "SENT";
  return null;
}
