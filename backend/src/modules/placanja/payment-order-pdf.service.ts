import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../prisma/prisma.service";
import { PdfService } from "../documents/pdf.service";

/**
 * ŠTAMPA VIRMANA — obrazac „Nalog za prenos" (BigBit `StampajVirman`, doc 21).
 * =========================================================================
 * Klasičan srpski nalog za prenos (NBS obrazac): platilac (naša firma) → primalac,
 * sa poljima šifra plaćanja / valuta / iznos, račun pošiljaoca + model i poziv na
 * broj (zaduženje), račun primaoca + model i poziv na broj (odobrenje), svrha,
 * mesto i datum, pečat i potpis.
 *
 * Renderer je zajednički `PdfService` (pdfmake 0.3, Roboto pokriva srpski Latin
 * Extended-A) — ISTI put i obrazac kao `IosPdfService` / `InvoicePdfService`; ovaj
 * servis samo gradi `TDocumentDefinitions` i vraća `Buffer`. Nema nove PDF zavisnosti.
 *
 * ⚠️ Šifra plaćanja se NE čuva u `PaymentOrder` šemi (nema kolonu) — prikazuje se
 *    podrazumevana „221" (UPLATA ZA ROBU, doc 21). Model poziva na broj se takođe ne
 *    čuva zasebno, pa se model-polje ostavlja prazno (upisuje korisnik), a prikazuje
 *    se kompletan poziv na broj (sa kontrolnom cifrom) iz `referenceNumber*`.
 *
 * NOVAC: Prisma.Decimal (NIKAD Float) — `toFixed` nad Decimal-om, srpski zarez.
 */

/** Podaci platioca (naša firma) za zaglavlje naloga. */
interface PayerInfo {
  name: string;
  address: string | null;
  city: string | null;
  bankAccount: string | null;
  taxId: string | null;
}

/** Podaci primaoca (komitent) iz šifarnika — meki ref. */
interface PayeeInfo {
  id: number;
  name: string;
  address: string | null;
  city: string | null;
  postalCode: string | null;
}

@Injectable()
export class PaymentOrderPdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
  ) {}

  /**
   * Generiši PDF naloga za prenos za dati `orderId`. Vraća `{ buffer, fileName }`.
   * Baca NotFound ako nalog ne postoji. Platilac = primarna firma (najmanji id);
   * primalac = komitent po `supplierId` (meki ref — prikaz „Komitent N" ako obrisan).
   */
  async buildOrderPdf(
    orderId: number,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const order = await this.prisma.paymentOrder.findUnique({
      where: { id: orderId },
    });
    if (!order) {
      throw new NotFoundException(`Nalog za plaćanje ${orderId} ne postoji.`);
    }

    const [payer, payee] = await Promise.all([
      this.loadPayer(),
      this.loadPayee(order.supplierId),
    ]);

    const docDefinition = this.buildDocDefinition(order, payer, payee);
    const buffer = await this.pdf.render(docDefinition);
    return { buffer, fileName: `nalog-za-prenos-${order.orderNumber}.pdf` };
  }

  // ------------------------------------------------------------ učitavanje

  /**
   * Platilac (naša firma) — obrazac nema `companyId`, pa se uzima primarna firma
   * (najmanji id); ako je nema → Servoteh fallback (isti obrazac kao IosPdfService).
   */
  private async loadPayer(): Promise<PayerInfo> {
    const company = await this.prisma.company.findFirst({
      orderBy: { id: "asc" },
      select: {
        companyName: true,
        address: true,
        city: true,
        bankAccount: true,
        taxId: true,
      },
    });
    if (!company) {
      return {
        name: "Servoteh d.o.o.",
        address: null,
        city: null,
        bankAccount: null,
        taxId: null,
      };
    }
    return {
      name: company.companyName,
      address: company.address,
      city: company.city,
      bankAccount: company.bankAccount,
      taxId: company.taxId,
    };
  }

  /** Primalac (komitent) iz šifarnika — meki ref; null ako obrisan/ne postoji. */
  private async loadPayee(supplierId: number): Promise<PayeeInfo | null> {
    const c = await this.prisma.customer.findUnique({
      where: { id: supplierId },
      select: {
        id: true,
        name: true,
        address: true,
        city: true,
        postalCode: true,
      },
    });
    if (!c) return null;
    return {
      id: c.id,
      name: c.name,
      address: c.address,
      city: c.city,
      postalCode: c.postalCode,
    };
  }

  // --------------------------------------------------------- dokument (pdfmake)

  private buildDocDefinition(
    order: {
      orderNumber: string;
      amount: Prisma.Decimal;
      currency: string;
      purpose: string | null;
      supplierId: number;
      supplierAccount: string | null;
      referenceNumberDebit: string | null;
      referenceNumberCredit: string | null;
      dueDate: Date | null;
      status: string;
    },
    payer: PayerInfo,
    payee: PayeeInfo | null,
  ): TDocumentDefinitions {
    const payerBlock = [
      payer.name,
      [payer.address, payer.city].filter(Boolean).join(", "),
      payer.taxId ? `PIB: ${payer.taxId}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const payeeBlock = payee
      ? [
          payee.name,
          [payee.address, payee.postalCode, payee.city]
            .filter(Boolean)
            .join(", "),
        ]
          .filter(Boolean)
          .join("\n")
      : `Komitent ${order.supplierId} (nije u šifarniku)`;

    // Šifra plaćanja nema kolonu u šemi → podrazumevana „221" (doc 21).
    const paymentCode = "221";
    const amountText = `${formatDecimal(order.amount, 2)} ${order.currency}`;

    const header = this.buildHeader();
    const form = this.buildForm({
      payerBlock,
      payeeBlock,
      purpose: order.purpose ?? "UPLATA ZA ROBU",
      paymentCode,
      currency: order.currency,
      amountText,
      payerAccount: payer.bankAccount ?? "",
      payeeAccount: order.supplierAccount ?? "",
      refDebit: order.referenceNumberDebit ?? "",
      refCredit: order.referenceNumberCredit ?? "",
    });
    const signoff = this.buildSignoff(order.dueDate);

    return {
      pageSize: "A4",
      pageMargins: [40, 36, 40, 40],
      content: [header, form, signoff],
      styles: {
        title: { fontSize: 16, bold: true },
        subtitle: { fontSize: 10, color: "#555", margin: [0, 2, 0, 0] },
        formLabel: {
          fontSize: 6,
          bold: true,
          color: "#666",
          characterSpacing: 0.3,
        },
        formValue: { fontSize: 10, margin: [0, 1, 0, 0] },
        formValueBig: { fontSize: 12, bold: true, margin: [0, 1, 0, 0] },
        signLbl: {
          fontSize: 8,
          color: "#555",
          alignment: "center",
          margin: [0, 2, 0, 0],
        },
      },
      defaultStyle: { font: "Roboto", fontSize: 9 },
      footer: (currentPage: number, pageCount: number): Content => ({
        text: `Nalog za prenos ${order.orderNumber} · strana ${currentPage}/${pageCount}`,
        alignment: "center",
        fontSize: 7,
        color: "#888",
        margin: [0, 8, 0, 0],
      }),
    };
  }

  private buildHeader(): Content {
    return {
      stack: [
        { text: "NALOG ZA PRENOS", style: "title" },
        {
          text: "Obrazac naloga za prenos sredstava (bezgotovinsko plaćanje)",
          style: "subtitle",
        },
      ],
      margin: [0, 0, 0, 10],
    };
  }

  /**
   * Telo naloga — levo veliki blokovi (platilac / svrha / primalac), desno grid
   * (šifra plaćanja | valuta | iznos, račun pošiljaoca, model+poziv zaduženja,
   * račun primaoca, model+poziv odobrenja). Faithful NBS „nalog za prenos".
   */
  private buildForm(f: {
    payerBlock: string;
    payeeBlock: string;
    purpose: string;
    paymentCode: string;
    currency: string;
    amountText: string;
    payerAccount: string;
    payeeAccount: string;
    refDebit: string;
    refCredit: string;
  }): Content {
    const box = (
      label: string,
      value: string,
      opts?: { colSpan?: number; valueStyle?: string },
    ): TableCell => ({
      colSpan: opts?.colSpan,
      stack: [
        { text: label, style: "formLabel" },
        {
          text: value && value.trim() !== "" ? value : " ",
          style: opts?.valueStyle ?? "formValue",
        },
      ],
      margin: [5, 4, 5, 4],
    });

    // Levi stub — platilac / svrha plaćanja / primalac.
    const leftTable: Content = {
      table: {
        widths: ["*"],
        body: [
          [box("PLATILAC", f.payerBlock)],
          [box("SVRHA PLAĆANJA", f.purpose)],
          [box("PRIMALAC", f.payeeBlock)],
        ],
      },
      layout: gridLayout(),
    };

    // Desni stub — grid polja naloga (colSpan ćelije nose `{}` filere, pdfmake API).
    const rightTable: Content = {
      table: {
        widths: ["auto", "auto", "*"],
        body: [
          [
            box("ŠIFRA PLAĆANJA", f.paymentCode),
            box("VALUTA", f.currency),
            box("IZNOS", f.amountText, { valueStyle: "formValueBig" }),
          ],
          [box("RAČUN POŠILJAOCA", f.payerAccount, { colSpan: 3 }), {}, {}],
          [
            box("MODEL", ""),
            box("POZIV NA BROJ (ZADUŽENJE)", f.refDebit, { colSpan: 2 }),
            {},
          ],
          [box("RAČUN PRIMAOCA", f.payeeAccount, { colSpan: 3 }), {}, {}],
          [
            box("MODEL", ""),
            box("POZIV NA BROJ (ODOBRENJE)", f.refCredit, { colSpan: 2 }),
            {},
          ],
        ],
      },
      layout: gridLayout(),
    };

    return {
      columns: [
        { width: "48%", stack: [leftTable] },
        { width: "*", stack: [rightTable] },
      ],
      columnGap: 10,
      margin: [0, 0, 0, 0],
    };
  }

  /**
   * Donji deo — mesto i datum / datum valute, pečat i potpis platioca. Datum
   * valute = dospeće naloga ako je uneto (informativno).
   */
  private buildSignoff(dueDate: Date | null): Content {
    return {
      margin: [0, 18, 0, 0],
      columns: [
        {
          width: "*",
          stack: [
            {
              text: `Datum valute: ${fmtDate(dueDate)}`,
              fontSize: 9,
              color: "#333",
            },
            {
              text: "Mesto i datum prijema: ____________________",
              fontSize: 9,
              color: "#333",
              margin: [0, 8, 0, 0],
            },
          ],
        },
        {
          width: "*",
          stack: [
            {
              canvas: [
                { type: "line", x1: 0, y1: 0, x2: 180, y2: 0, lineWidth: 0.5 },
              ],
              margin: [0, 30, 0, 0],
            },
            { text: "Pečat i potpis platioca", style: "signLbl" },
          ],
        },
      ],
      columnGap: 40,
    };
  }
}

// ---------------------------------------------------------------- layout / format

/** Bordered grid layout (tanke sive linije, uniforman padding) — kao NBS obrazac. */
function gridLayout() {
  return {
    hLineWidth: () => 0.6,
    vLineWidth: () => 0.6,
    hLineColor: () => "#999999",
    vLineColor: () => "#999999",
    paddingTop: () => 0,
    paddingBottom: () => 0,
    paddingLeft: () => 0,
    paddingRight: () => 0,
  };
}

/** Datum dd.MM.yyyy. (srpski). */
function fmtDate(d: Date | null): string {
  if (!d) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}.`;
}

/**
 * Prisma.Decimal → string sa fiksnim brojem decimala (srpski zarez). NIKAD Float
 * aritmetika — `toFixed` nad Decimal-om.
 */
function formatDecimal(value: Prisma.Decimal, decimals: number): string {
  return value.toFixed(decimals).replace(".", ",");
}
