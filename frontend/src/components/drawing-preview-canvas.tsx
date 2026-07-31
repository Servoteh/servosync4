'use client';

// Render PRVE strane PDF-a crteža na canvas (zahtev 052/26 — pregled na prelaz
// mišem). Namerno je izdvojen u zaseban modul: `pdfjs-dist` je ~1 MB i ulazi u
// bundle tek kad neko stvarno otvori pregled (`next/dynamic` + `ssr:false` u
// drawing-preview.tsx). Sve ovde je browser-only.
//
// Recept za render je isti kao u pdf-annotator.tsx (dpr ograničen na 2, bela
// podloga pre crtanja) — crteži su vektorski, pa bez dpr skaliranja kote i
// tanke linije pobele na ekranu.

import { useEffect, useRef, useState } from 'react';
import { openPdfDocument, type PDFDocumentProxy } from '@/components/annotate/pdfjs-loader';

export default function DrawingPreviewCanvas({
  bytes,
  width,
}: {
  /** Sirovi bajtovi PDF-a. `openPdfDocument` pravi kopiju, pa keš ostaje upotrebljiv. */
  bytes: ArrayBuffer;
  /** Željena širina prikaza u CSS pikselima. */
  width: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let doc: PDFDocumentProxy | null = null;
    setReady(false);
    setFailed(false);

    /**
     * Oslobađanje pdf.js dokumenta. MORA da se zove i iz async toka, ne samo iz
     * cleanup-a: `getDocument` diže sopstveni Web Worker, a kad korisnik skloni
     * miš pre nego što PDF stigne, cleanup je već prošao dok je `doc` bio null —
     * radnik bi ostao da visi (a hover se ponavlja desetinama puta).
     */
    const release = () => {
      const d = doc;
      doc = null;
      if (d) void d.destroy();
    };

    void (async () => {
      try {
        doc = await openPdfDocument(bytes);
        if (cancelled) return release();
        const page = await doc.getPage(1);
        if (cancelled) return release();
        const canvas = canvasRef.current;
        if (!canvas) return release();

        const base = page.getViewport({ scale: 1 });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: (width / base.width) * dpr });
        const pxW = Math.round(viewport.width);
        const pxH = Math.round(viewport.height);
        canvas.width = pxW;
        canvas.height = pxH;
        canvas.style.width = `${Math.round(pxW / dpr)}px`;
        canvas.style.height = `${Math.round(pxH / dpr)}px`;

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas 2d context nedostupan');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, pxW, pxH);
        await page.render({ canvasContext: ctx, viewport }).promise;
        // Slika je već na canvas-u — dokument (i njegov radnik) više ne trebaju.
        release();
        if (!cancelled) setReady(true);
      } catch {
        release();
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      release();
    };
  }, [bytes, width]);

  return (
    <div className="relative">
      {/* Canvas se montira ODMAH (ne iza `ready`) — efekat mu treba u prvom
          prolazu; dok render traje stoji poluproziran ispod poruke. */}
      <canvas
        ref={canvasRef}
        aria-label="Pregled prve strane crteža"
        className={ready ? '' : 'opacity-0'}
      />
      {!ready && (
        <p className="py-6 text-center text-xs text-ink-secondary" role="status">
          {failed ? 'Pregled crteža nije uspeo.' : 'Renderovanje crteža…'}
        </p>
      )}
    </div>
  );
}
