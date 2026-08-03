import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../prisma/prisma.service";
import { PdfService } from "../documents/pdf.service";
import { SERVOTEH_LOGO_DATA_URL } from "../documents/servoteh-logo";
import { byId, uniqueIds } from "../../common/relations";
import { HANDOVER_STATUS } from "./handovers.service";

/**
 * Statusi primopredaje koji znače „odobrena" za štampu liste pozicija:
 * SAGLASAN (1) i LANSIRAN (3) — lansiranje podrazumeva prethodno odobrenje,
 * pa delimično lansiran nacrt (pozicije se lansiraju jedna po jedna kroz
 * „Otkucaj TP"/„Lansiraj") NE gubi pravo na štampu. U OBRADI (0) i
 * ODBIJENO (2) nisu odobrene → 422.
 */
const APPROVED_LIKE_STATUSES: readonly number[] = [
  HANDOVER_STATUS.APPROVED,
  HANDOVER_STATUS.LAUNCHED,
];

/** Nazivi statusa primopredaje za srpsku 422 poruku (isti rečnik kao FE tabovi). */
const HANDOVER_STATUS_NAME: Readonly<Record<number, string>> = {
  [HANDOVER_STATUS.PENDING]: "U OBRADI",
  [HANDOVER_STATUS.APPROVED]: "SAGLASAN",
  [HANDOVER_STATUS.REJECTED]: "ODBIJENO",
  [HANDOVER_STATUS.LAUNCHED]: "LANSIRAN",
};

/** Bezbedan token za ime fajla (draftNumber je `G-yymmdd-nnn`, ali defanzivno — isti obrazac kao print-bundle). */
function sanitizeFileToken(value: string): string {
  return value.replace(/[^\w.-]+/g, "_") || "nacrt";
}

/** Datum dd.MM.yyyy. („—" za null) — isti format kao RN dokument. */
function fmtDate(d: Date | null): string {
  if (!d) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}.`;
}

/**
 * Zahtev 055/26 (Strahinja, planer): „Primopredaja — lista pozicija po nacrtu".
 * PDF sa zaglavljem (broj nacrta, datum nacrta + datum odobrenja, projekat) i
 * tabelom pozicija (r. br., broj crteža, naziv pozicije, količina) — za modul
 * ODOBRENE primopredaje. Renderer je zajednički `PdfService` (pdfmake), isti
 * font/stil obrazac kao `work-order-print.service.ts`.
 *
 * KAPIJA „samo odobrene" (Strahinja: štampa SAMO za odobrene primopredaje):
 * `drawing_handovers` nema FK ka nacrtu, pa se pozicije vezuju istim soft
 * odnosom kao `resolveDraftContext` u handovers.service.ts, samo u suprotnom
 * smeru: za svaki crtež ne-isključene stavke nacrta uzima se NAJSKORIJA
 * primopredaja tog crteža (max id). Nacrt je „odobren" kad je PREDAT
 * (`is_locked`) i kad su SVE takve primopredaje u statusu SAGLASAN ili
 * LANSIRAN — inače 422 sa spiskom spornih pozicija.
 *
 * IZBOR DATUMA u zaglavlju (zadatak traži dokumentovan izbor):
 *  - „Datum nacrta" = `handover_drafts.draft_date` (uvek postoji — datum
 *    samog dokumenta, Strahinjin „datum");
 *  - „Datum odobrenja" = MAX(`status_changed_at`) preko pozicija koje su
 *    TRENUTNO u statusu SAGLASAN — za njih je `status_changed_at` upravo
 *    trenutak odobravanja (`approve()` ga upisuje pri prelazu 0→1). Pozicije
 *    već LANSIRANE se izostavljaju iz ovog maksimuma jer lansiranje PREPISUJE
 *    `status_changed_at` (trenutak lansiranja, ne odobrenja); ako nijedna
 *    pozicija nije više SAGLASAN (sve lansirane), prikazuje se „—".
 */
@Injectable()
export class HandoverDraftPrintService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
  ) {}

  async buildDraftPositionsPdf(
    draftId: number,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const draft = await this.prisma.handoverDraft.findUnique({
      where: { id: draftId },
      select: {
        id: true,
        draftNumber: true,
        draftDate: true,
        projectId: true,
        isLocked: true,
        statusId: true,
      },
    });
    if (!draft) throw new NotFoundException(`Nacrt ${draftId} ne postoji.`);

    // Kapija 1: nepredati nacrt nema primopredaje (soft veza po crtežu bi
    // inače „pokupila" tuđe primopredaje istog crteža iz RANIJIH nacrta i
    // lažno propustila štampu) — zato prvo `is_locked` (postavlja ga submit).
    if (draft.isLocked !== true)
      throw new UnprocessableEntityException(
        `Nacrt ${draft.draftNumber} još nije predat u primopredaju — lista pozicija se štampa samo za odobrene primopredaje.`,
      );

    // Pozicije = ne-isključene stavke (isključene ne ulaze u primopredaju —
    // isti kriterijum kao submit() i print-bundle). Redosled id asc = redosled
    // unosa (isti kao detalj nacrta).
    const items = await this.prisma.handoverDraftItem.findMany({
      where: { draftId, excludeFromHandover: false },
      select: { id: true, drawingId: true, quantityToProduce: true },
      orderBy: { id: "asc" },
    });
    if (!items.length)
      throw new UnprocessableEntityException(
        "Nacrt nema pozicija za štampu — sve stavke su isključene iz primopredaje.",
      );

    const drawingIds = uniqueIds(items.map((i) => i.drawingId));
    const [drawings, project, handoverRows] = await Promise.all([
      this.prisma.drawing.findMany({
        where: { id: { in: drawingIds } },
        select: { id: true, drawingNumber: true, revision: true, name: true },
      }),
      this.prisma.project.findUnique({
        where: { id: draft.projectId },
        select: { id: true, projectNumber: true, projectName: true },
      }),
      // Najskorija primopredaja PO CRTEŽU (orderBy id desc, prvi pogodak
      // pobedi) — isti best-effort smer kao `resolveDraftContext`.
      this.prisma.drawingHandover.findMany({
        where: { drawingId: { in: drawingIds } },
        select: {
          id: true,
          drawingId: true,
          statusId: true,
          statusChangedAt: true,
        },
        orderBy: { id: "desc" },
      }),
    ]);
    const drawingById = byId(drawings);
    const latestHandover = new Map<number, (typeof handoverRows)[number]>();
    for (const h of handoverRows) {
      if (!latestHandover.has(h.drawingId)) latestHandover.set(h.drawingId, h);
    }

    // Kapija 2 („samo odobrene"): svaka pozicija mora imati primopredaju u
    // statusu SAGLASAN/LANSIRAN. Sporne se nabrajaju brojem crteža + stanjem.
    const notApproved: string[] = [];
    for (const dId of drawingIds) {
      const h = latestHandover.get(dId);
      const d = drawingById.get(dId);
      const label = d ? `${d.drawingNumber} / ${d.revision}` : `#${dId}`;
      if (!h) notApproved.push(`${label} (bez primopredaje)`);
      else if (!APPROVED_LIKE_STATUSES.includes(h.statusId))
        notApproved.push(
          `${label} (${HANDOVER_STATUS_NAME[h.statusId] ?? `status ${h.statusId}`})`,
        );
    }
    if (notApproved.length)
      throw new UnprocessableEntityException(
        `Primopredaja za nacrt ${draft.draftNumber} nije odobrena — lista pozicija se štampa samo za odobrene primopredaje. ` +
          `Pozicije koje nisu odobrene: ${notApproved.join(", ")}.`,
      );

    // Datum odobrenja: max(status_changed_at) pozicija TRENUTNO u SAGLASAN
    // (vidi doc-komentar klase — lansirane su izostavljene namerno).
    let approvalDate: Date | null = null;
    for (const h of latestHandover.values()) {
      if (h.statusId !== HANDOVER_STATUS.APPROVED) continue;
      if (
        h.statusChangedAt &&
        (!approvalDate || h.statusChangedAt > approvalDate)
      )
        approvalDate = h.statusChangedAt;
    }

    const docDefinition = this.buildDocDefinition({
      draftNumber: draft.draftNumber,
      draftDate: draft.draftDate,
      approvalDate,
      projectLabel: project
        ? [project.projectNumber, project.projectName]
            .filter(Boolean)
            .join(" · ")
        : "",
      positions: items.map((i) => {
        const d = drawingById.get(i.drawingId);
        return {
          drawingLabel: d
            ? `${d.drawingNumber} / ${d.revision}`
            : `#${i.drawingId}`,
          name: d?.name ?? "",
          quantity: i.quantityToProduce,
        };
      }),
    });

    const buffer = await this.pdf.render(docDefinition);
    return {
      buffer,
      fileName: `primopredaja-${sanitizeFileToken(draft.draftNumber)}-pozicije.pdf`,
    };
  }

  private buildDocDefinition(args: {
    draftNumber: string;
    draftDate: Date | null;
    approvalDate: Date | null;
    projectLabel: string;
    positions: Array<{ drawingLabel: string; name: string; quantity: number }>;
  }): TDocumentDefinitions {
    const { draftNumber, draftDate, approvalDate, projectLabel, positions } =
      args;

    // Zaglavlje po obrascu RN dokumenta: logo Servoteha gore-levo, naziv
    // dokumenta + broj nacrta u sredini.
    const headerColumns: Content = {
      columns: [
        { image: SERVOTEH_LOGO_DATA_URL, width: 128 },
        {
          width: "*",
          margin: [12, 4, 0, 0],
          stack: [
            { text: "PRIMOPREDAJA — LISTA POZICIJA", style: "title" },
            { text: `Nacrt ${draftNumber}`, style: "subtitle" },
          ],
        },
      ],
      columnGap: 8,
    };

    const infoRow = (
      l1: string,
      v1: string,
      l2: string,
      v2: string,
    ): Content[] => [
      { text: l1, style: "lbl" },
      { text: v1 || "—", style: "val" },
      { text: l2, style: "lbl" },
      { text: v2 || "—", style: "val" },
    ];
    const info: Content = {
      margin: [0, 10, 0, 10],
      table: {
        widths: ["auto", "*", "auto", "*"],
        body: [
          infoRow("Broj nacrta", draftNumber, "Projekat", projectLabel),
          infoRow(
            "Datum nacrta",
            fmtDate(draftDate),
            "Datum odobrenja",
            fmtDate(approvalDate),
          ),
          infoRow("Broj pozicija", String(positions.length), "", ""),
        ],
      },
      layout: "lightHorizontalLines",
    };

    // `headerRows: 1` — zaglavlje tabele se ponavlja na svakoj strani preloma.
    const headerCells: Content[] = [
      { text: "R. br.", style: "th" },
      { text: "Broj crteža", style: "th" },
      { text: "Naziv pozicije", style: "th" },
      { text: "Količina", style: "th", alignment: "right" },
    ];
    const bodyRows: Content[][] = positions.map((p, idx) => [
      { text: String(idx + 1), style: "tdNum" },
      { text: p.drawingLabel, style: "td" },
      { text: p.name, style: "td" },
      { text: String(p.quantity), style: "tdNum" },
    ]);
    const table: Content = {
      table: {
        headerRows: 1,
        widths: ["auto", "auto", "*", "auto"],
        body: [headerCells, ...bodyRows],
      },
      layout: {
        hLineWidth: (i: number) => (i <= 1 ? 0.8 : 0.5),
        vLineWidth: () => 0,
        hLineColor: () => "#cccccc",
        paddingTop: (i: number) => (i === 0 ? 2 : 4),
        paddingBottom: (i: number) => (i === 0 ? 2 : 4),
        paddingLeft: () => 4,
        paddingRight: () => 4,
      },
    };

    return {
      pageSize: "A4",
      pageMargins: [28, 28, 28, 36],
      content: [headerColumns, info, table],
      styles: {
        title: { fontSize: 18, bold: true },
        subtitle: { fontSize: 11, color: "#555", margin: [0, 2, 0, 0] },
        lbl: { fontSize: 8, bold: true, color: "#555" },
        val: { fontSize: 9 },
        th: { fontSize: 8, bold: true, fillColor: "#f0f0f0" },
        td: { fontSize: 9 },
        tdNum: { fontSize: 9, alignment: "right" },
      },
      defaultStyle: { font: "Roboto", fontSize: 9 },
      footer: (currentPage: number, pageCount: number): Content => ({
        text: `Nacrt ${draftNumber} · strana ${currentPage}/${pageCount}`,
        alignment: "center",
        fontSize: 7,
        color: "#888",
        margin: [0, 8, 0, 0],
      }),
    };
  }
}
