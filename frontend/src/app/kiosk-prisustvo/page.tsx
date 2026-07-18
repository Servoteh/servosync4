'use client';

import { KioskPunchScanner } from './_components/kiosk-punch-scanner';

/**
 * JAVNA ruta /kiosk-prisustvo — kapijski QR kiosk za evidenciju prisustva (F2 pilot).
 * NAMERNO bez prijave i bez AppShell-a: tablet na kapiji stoji stalno otvoren.
 * Barijera je „device key" (localStorage) + skenirani lični QR token; kiosk SAMO
 * beleži prolaz (ne otvara turniket). Port 1.0 `src/ui/kiosk/index.js`.
 *
 * NAPOMENA: ovo je odvojeno od /kiosk (barkod kiosk za naloge/operacije u pogonu,
 * koji traži prijavu). Static export: statička ruta bez [id] segmenata.
 */
export default function KioskPrisustvoPage() {
  return <KioskPunchScanner />;
}
