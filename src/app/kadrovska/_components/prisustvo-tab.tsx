'use client';

import { useState } from 'react';
import { QrCode } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { LiveView } from './prisustvo/live-view';
import { ShadowView } from './prisustvo/shadow-view';
import { BadgeDialog } from './prisustvo/badge-dialog';

/**
 * TAB Prisustvo (P10) — dva pogleda:
 *   • „Uživo": SVI aktivni zaposleni (imenik ⨝ v_attendance_now) + feed poslednjih
 *     prolaza sa kapije + nepoznate kartice — HR uživo prati kucanje (F2 pilot).
 *   • „Poređenje sa gridom" (shadow): mesečni izveštaj odstupanja prisustva vs grid,
 *     sa drill-om po danima — osnova za odluku o gašenju Katze obračuna.
 * „QR nalepnice" otvara generator SVK- tokena za kiosk. Kiosk sam je na javnoj
 * ruti /kiosk-prisustvo.
 */
export function PrisustvoTab() {
  const { can } = useAuth();
  const canLive = can(PERMISSIONS.KADROVSKA_ATTENDANCE);
  const canShadow = can(PERMISSIONS.KADROVSKA_ATTENDANCE_SHADOW);
  const [view, setView] = useState<'live' | 'shadow'>(canLive ? 'live' : 'shadow');
  const [badgeOpen, setBadgeOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex gap-1 rounded-panel border border-line bg-surface p-1">
          {canLive && (
            <button
              onClick={() => setView('live')}
              className={`rounded-control px-3 py-1.5 text-sm font-medium ${view === 'live' ? 'bg-accent text-accent-fg' : 'text-ink-secondary'}`}
            >
              ⏱ Uživo
            </button>
          )}
          {canShadow && (
            <button
              onClick={() => setView('shadow')}
              className={`rounded-control px-3 py-1.5 text-sm font-medium ${view === 'shadow' ? 'bg-accent text-accent-fg' : 'text-ink-secondary'}`}
            >
              📊 Poređenje sa gridom
            </button>
          )}
        </div>
        {/* BE ruta badges/qr gejtuje kadrovska.attendance_shadow (posle P1a fixa) —
            gejtuj afordansu istim ključem (hr/menadzment/admin), ne kadrovska.manage. */}
        {canShadow && (
          <Button className="ml-auto" variant="secondary" onClick={() => setBadgeOpen(true)}>
            <QrCode className="h-4 w-4" aria-hidden /> QR nalepnice
          </Button>
        )}
      </div>

      {view === 'live' && canLive && <LiveView />}
      {view === 'shadow' && canShadow && <ShadowView />}

      {badgeOpen && <BadgeDialog onClose={() => setBadgeOpen(false)} />}
    </div>
  );
}
