'use client';

// Štampa dokumenta u izolovanom iframe-u → browser dijalog → „Sačuvaj kao PDF".
// Port 1.0 `printPravilnikPdf` / `printKompVrednostiPdf`. Iframe (umesto window.open)
// izbegava blokiranje pop-up-a i ne dira app DOM. Tekst se renderuje nativno →
// pun Unicode (š/č/ć/ž/đ, ćirilica) i selektabilan tekst (nema rasterizacije).

export function printDocument(opts: { title: string; css: string; bodyHtml: string }): void {
  if (typeof document === 'undefined') return;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(iframe);

  const win = iframe.contentWindow;
  if (!win) { iframe.remove(); return; }
  const doc = win.document;
  doc.open();
  doc.write(`<!doctype html><html lang="sr"><head><meta charset="utf-8">
    <title>${opts.title}</title>
    <style>
      @page { size: A4; margin: 16mm 14mm; }
      body { margin:0; }
      ${opts.css}
      h2, h3.prg-part, h3.kv-part { page-break-after: avoid; }
      .prg-table, .prg-summary { page-break-inside: avoid; }
      p { orphans:3; widows:3; }
    </style></head><body>${opts.bodyHtml}</body></html>`);
  doc.close();

  const run = () => {
    win.focus();
    win.print();
    // Ukloni iframe nakon štampe (ostavi vremena dijalogu da se otvori).
    window.setTimeout(() => iframe.remove(), 1500);
  };
  if (doc.readyState === 'complete') {
    window.setTimeout(run, 120);
  } else {
    iframe.addEventListener('load', () => window.setTimeout(run, 120));
  }
}
