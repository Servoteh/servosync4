'use client';

import { useEffect, useRef } from 'react';

/**
 * Lokalni QR render (H2) — canvas preko `qrcode` npm lib, NIKAD eksterni servis
 * (paritet 1.0 maintAssetQr.js:6-11). Ne curi šifru sredstva na internet i radi na
 * on-prem/air-gapped LAN-u. `size` je stranica u px.
 */
export function QrCanvas({ url, size = 140 }: { url: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    const canvas = ref.current;
    if (!canvas || !url) return;
    void (async () => {
      try {
        const { toCanvas } = await import('qrcode');
        if (cancelled) return;
        await toCanvas(canvas, url, { width: size, margin: 1 });
      } catch {
        /* render best-effort — bez QR-a karton i dalje radi */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, size]);

  return <canvas ref={ref} width={size} height={size} className="rounded-control bg-white p-1" aria-label="QR kod sredstva" />;
}
