'use client';

import { useState } from 'react';
import Link from 'next/link';
import { QrCode, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { HelpSpot } from '@/components/ui-kit/help-spot';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { LiveView } from './prisustvo/live-view';
import { ShadowView } from './prisustvo/shadow-view';
import { KontrolaView } from './prisustvo/kontrola-view';
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
  const [view, setView] = useState<'live' | 'shadow' | 'kontrola'>(canLive ? 'live' : 'shadow');
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
          {/* AUDIT-K7: mesto gde se zatvara tok ispravke kucanja — ispravke radnika
              (uz obrazloženje) + auto-predlozi iz kapije koji čekaju potvrdu urednika. */}
          {canShadow && (
            <HelpSpot id="kadrovska.prisustvo.kontrola" variant="inline">
              <button
                onClick={() => setView('kontrola')}
                className={`rounded-control px-3 py-1.5 text-sm font-medium ${view === 'kontrola' ? 'bg-accent text-accent-fg' : 'text-ink-secondary'}`}
              >
                ✅ Za potvrdu
              </button>
            </HelpSpot>
          )}
        </div>
        {/* Mobilni pregled uživo (zahtev 019/26) — /mob/prisustvo, namerno VAN /m/*
            (worker proxy sve /m/* šalje na 1.0). Otvoriti na telefonu. `Link` =
            klijentska navigacija (tvrdi <a> bi rušio SPA stanje i sesijski keš). */}
        {canLive && (
          <Link
            href="/mob/prisustvo"
            className="ml-auto inline-flex h-9 items-center gap-2 rounded-control border border-line bg-surface px-4 text-base font-medium text-ink hover:bg-surface-2 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
          >
            <Smartphone className="h-4 w-4" aria-hidden /> Mobilni prikaz
          </Link>
        )}
        {/* BE ruta badges/qr gejtuje kadrovska.attendance_shadow (posle P1a fixa) —
            gejtuj afordansu istim ključem (hr/menadzment/admin), ne kadrovska.manage. */}
        {canShadow && (
          <Button className={canLive ? undefined : 'ml-auto'} variant="secondary" onClick={() => setBadgeOpen(true)}>
            <QrCode className="h-4 w-4" aria-hidden /> QR nalepnice
          </Button>
        )}
      </div>

      {view === 'live' && canLive && <LiveView />}
      {view === 'shadow' && canShadow && <ShadowView />}
      {view === 'kontrola' && canShadow && <KontrolaView />}

      {badgeOpen && <BadgeDialog onClose={() => setBadgeOpen(false)} />}
    </div>
  );
}
