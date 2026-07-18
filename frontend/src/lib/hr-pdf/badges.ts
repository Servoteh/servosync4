import { newPdf, safeName } from './pdf-core';

// QR bedževi za kiosk kucanje (kapija/prisustvo) — PDF nalepnice, jsPDF + Roboto
// + qrcode (dinamički import, browser build). Port 1.0 `src/ui/kadrovska/kioskQrAdmin.js`
// (`_buildPdf`): A4 portret, mreža 2×5, QR 34mm + ime/odeljenje/token.
//
// `code` = TRAJAN „SVK-…" token po zaposlenom iz employee_badges (BE get-or-create
// POST /kadrovska/employees/:id/badges/qr — vidi useEnsureQrBadge). Isti token
// razrešava kapijski kiosk; ponovna štampa vraća isti token pa zalepljene
// nalepnice ostaju važeće. QR VIŠE NE kodira employee.id.

export interface BadgeItem {
  name: string;
  dep?: string;
  /** Sadržaj QR-a — trajni „SVK-…" token zaposlenog (employee_badges). */
  code: string;
}

/** Nasumičan „SVK-…" token (paritet 1.0 genToken) — offline fallback; kanonski
 *  token daje BE (useEnsureQrBadge). Zadržano za slučaj bez mreže/BE. */
export function generateBadgeToken(): string {
  const rnd = new Uint8Array(9);
  (globalThis.crypto || ({} as Crypto)).getRandomValues?.(rnd);
  const b36 = Array.from(rnd).map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12).toUpperCase();
  return 'SVK-' + b36;
}

/**
 * Napravi PDF QR nalepnica za listu zaposlenih. Vraća Blob za štampu/preuzimanje.
 * QR se generiše lokalno (offline) preko `qrcode`.
 */
export async function generateBadgeSheetPdf(items: BadgeItem[]): Promise<{ blob: Blob; fileName: string }> {
  const QRCode = (await import('qrcode')).default;
  const withQr = await Promise.all(
    items.map(async (it) => ({
      ...it,
      qrDataUrl: await QRCode.toDataURL(it.code, { errorCorrectionLevel: 'M', margin: 1, width: 320 }),
    })),
  );

  const { doc } = await newPdf('portrait');
  const PAGE_W = 210;
  const PAGE_H = 297;
  const M = 12;
  const COLS = 2;
  const ROWS = 5;
  const cellW = (PAGE_W - M * 2) / COLS; // 93 mm
  const cellH = (PAGE_H - M * 2) / ROWS; // ~54.6 mm
  const qr = 34;

  withQr.forEach((it, i) => {
    const idx = i % (COLS * ROWS);
    if (i > 0 && idx === 0) doc.addPage();
    const col = idx % COLS;
    const row = Math.floor(idx / COLS);
    const x = M + col * cellW;
    const y = M + row * cellH;

    doc.setDrawColor(210);
    doc.roundedRect(x + 2, y + 2, cellW - 4, cellH - 4, 2, 2);
    doc.addImage(it.qrDataUrl, 'PNG', x + 6, y + (cellH - qr) / 2 - 2, qr, qr);

    const tx = x + qr + 12;
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(20);
    doc.text(doc.splitTextToSize(it.name, cellW - qr - 18) as string[], tx, y + cellH / 2 - 4);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(120);
    if (it.dep) doc.text(doc.splitTextToSize(it.dep, cellW - qr - 18) as string[], tx, y + cellH / 2 + 5);
    doc.setFontSize(7);
    doc.setTextColor(160);
    doc.text(it.code, tx, y + cellH / 2 + 12);
  });

  return { blob: doc.output('blob'), fileName: 'kiosk-qr-nalepnice.pdf' };
}

/** Preuzmi Blob kao fajl (bez servera). */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Otvori Blob u novom tabu (štampa PDF-a). */
export function openBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
