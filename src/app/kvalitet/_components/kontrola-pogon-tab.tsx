'use client';

import Link from 'next/link';
import { MonitorPlay } from 'lucide-react';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';

/**
 * Prečica ka pogonskom kiosku za kucanje kontrole (fullscreen `/pogon`) — kao
 * HUB pločica u 1.0, NE embed. Vidljiva samo ulogama sa `tehnologija.approve`;
 * ostali dobijaju objašnjenje.
 */
export function KontrolaPogonTab() {
  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-ink-secondary">
        Kucanje kontrole se obavlja na pogonskom terminalu preko punog ekrana. Otvori
        kiosk i skeniraj operaciju — sistem sam bira režim (kucanje ili kontrola) po
        skeniranoj operaciji.
      </p>

      <Can
        permission={PERMISSIONS.TEHNOLOGIJA_APPROVE}
        fallback={
          <div className="rounded-panel border border-line bg-surface-2 px-4 py-6 text-sm text-ink-secondary">
            Nemaš dozvolu za kucanje kontrole u pogonu. Obrati se kontroloru ili šefu.
          </div>
        }
      >
        <Link
          href="/pogon"
          target="_self"
          className="flex items-center gap-4 rounded-panel border border-accent bg-accent-subtle px-6 py-5 transition-colors hover:bg-accent-subtle/70"
        >
          <MonitorPlay className="h-10 w-10 shrink-0 text-accent" aria-hidden />
          <span className="flex flex-col">
            <span className="text-md font-semibold text-ink">
              Otvori kucanje kontrole (pogon)
            </span>
            <span className="text-sm text-ink-secondary">
              Pun ekran za skeniranje i kontrolu operacija na terminalu.
            </span>
          </span>
        </Link>
      </Can>
    </div>
  );
}
