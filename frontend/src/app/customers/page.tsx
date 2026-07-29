'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * `/customers` → `/komitenti` (ujedinjenje 29.07.2026).
 *
 * Ovde je nekad stajao stariji, NAMERNO suženi 2.0 pregled komitenata (bez računa,
 * rabata i limita), dok je 4.0 ekran `/komitenti` prikazivao pun matični karton —
 * dva ekrana nad istim podatkom, sa različitom širinom. Sada je širina odluka
 * BACKEND-a (`masters.read` bira sloj kolona, v. `modules/masters`), pa drugi ekran
 * više nema svrhu: `/komitenti` je jedini izvor istine.
 *
 * Ruta OSTAJE (kao preusmerenje) zbog zabeleženih linkova, bookmark-ova i starih
 * pretraga — brisanje foldera bi dalo hard-404 na static exportu.
 */
export default function CustomersRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/komitenti');
  }, [router]);

  return (
    <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
      Preusmeravanje na Komitente…
    </main>
  );
}
