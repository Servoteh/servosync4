'use client';

// Energetika / SCADA — desktop ljuska (3.0 TALAS E, MODULE_SPEC_scada_30 §4).
// Paritet 1.0 src/ui/energetika-scada/index.js: tabovi Pregled + 5 sistema (kopirani
// HP-HMI ekrani kroz iframe + most `__SCADA_BRIDGE__`) + Komande (audit, read). Iznad
// tabova: „overlay" statusa 5 sistema (status tačka + hero cifra), aktivni alarmi i
// clock-safe staleness baner. Gate: energetika.read (SAMO admin+menadzment — presuda E5).
//
// KOMANDE su R2 stub (COMMANDS_ENABLED=false): most vraća canControl=false → kopirani
// ekrani idu READ-ONLY. Potvrda (scada-confirm) i tok su spremni za aktivaciju.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { Tabs, type TabItem } from '@/app/reversi/_components/tabs';
import { useActiveAlarms, useScadaSites, useScadaSnapshots } from '@/api/energetika';
import {
  SITE_META,
  SITE_ORDER,
  fmtTime,
  fmtWhen,
  heroFor,
  isStale,
  siteIco,
  siteName,
  siteStatus,
  type ScadaSnapshotRow,
  type SiteStatusTone,
} from '@/lib/scada';
import { HmiHost } from './_components/hmi-host';
import { CommandsAudit } from './_components/commands-audit';
import { useScadaBridge } from './_components/scada-bridge';

type TabKey = 'pregled' | (typeof SITE_ORDER)[number] | 'komande';

const STATUS_TONE: Record<SiteStatusTone, Tone> = { on: 'success', off: 'danger', stale: 'warn' };
const STATUS_DOT: Record<SiteStatusTone, string> = { on: '🟢', off: '🔴', stale: '🟡' };

/**
 * 2.0 shell tema (`data-theme` na <html>); HMI ekran je prima kroz `?theme=`. Kad je tema
 * „system" (nema `data-theme`), @media prefers-color-scheme vodi celu app u dark — zato i
 * ovde padamo na matchMedia, da HMI ne ostane svetao ispod tamne ljuske.
 */
function currentTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light';
  const forced = document.documentElement.dataset.theme;
  if (forced === 'dark' || forced === 'light') return forced;
  return typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/**
 * Reaktivna tema ljuske — prati `data-theme` na <html> (MutationObserver) I OS preferencu
 * (matchMedia, za „system" režim) pa prosleđuje HMI iframe-u. Kad korisnik prebaci temu ili
 * OS pređe u dark, iframe se ponovo učita sa novom (key).
 */
function useShellTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(currentTheme);
  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setTheme(currentTheme());
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', sync);
    return () => {
      obs.disconnect();
      mq.removeEventListener('change', sync);
    };
  }, []);
  return theme;
}

/** Baner svežine (port 1.0 bannerText) — bridge offline ili per-sistem stale. */
function bannerText(snaps: ScadaSnapshotRow[], activeTab: TabKey): string {
  if (!snaps.length) {
    return '⚠️ Bridge se još nije javio — proveri servis na SCADA mašini (systemd na ubuntusrv).';
  }
  const allStale = snaps.every((s) => isStale(s.updatedAt));
  if (allStale) {
    const newest = snaps.reduce((m, s) => Math.max(m, new Date(s.updatedAt || 0).getTime()), 0);
    return `⚠️ Bridge offline — poslednji podatak ${newest ? fmtWhen(new Date(newest).toISOString()) : '—'}. Prikaz je zamrznut.`;
  }
  const cur = snaps.find((s) => s.siteKey === activeTab);
  if (cur && isStale(cur.updatedAt)) {
    return `⚠️ Podaci za ovaj sistem su zastareli (poslednji: ${fmtTime(cur.updatedAt)}) — bridge ne javlja za njega.`;
  }
  return '';
}

export default function EnergetikaPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('pregled');
  const [toast, setToast] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    id: unknown;
    text: string;
    source: MessageEventSource | null;
  } | null>(null);

  const readOk = can(PERMISSIONS.ENERGETIKA_READ);
  const control = can(PERMISSIONS.ENERGETIKA_CONTROL);
  const theme = useShellTheme();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Most na window-u dok je modul otvoren (samo ako ima read pristup).
  useScadaBridge(readOk && control, (msg) => setToast(msg));

  // Poruke iz iframe-a: drill-down navigacija + potvrda komande (roditeljski modal).
  useEffect(() => {
    if (!readOk) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin && e.origin !== 'null') return;
      const d = e.data as { type?: string; tab?: string; id?: unknown; text?: string } | null;
      if (!d) return;
      if (d.type === 'scada-nav' && d.tab && (d.tab === 'pregled' || d.tab in SITE_META)) {
        setTab(d.tab as TabKey);
      } else if (d.type === 'scada-confirm' && d.id != null) {
        setConfirm({ id: d.id, text: String(d.text || 'Potvrdi komandu?'), source: e.source });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [readOk]);

  // Auto-dismiss toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const snapshotsQ = useScadaSnapshots(readOk);
  const sitesQ = useScadaSites(readOk);
  const alarmsQ = useActiveAlarms(readOk);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  if (!readOk) {
    return (
      <AppShell>
        <PageHeader title="Energetika / SCADA" />
        <div className="grid flex-1 place-items-center p-8">
          <div className="max-w-md rounded-panel border border-line bg-surface p-6 text-center">
            <div className="text-3xl">🔒</div>
            <h2 className="mt-2 text-md font-semibold text-ink">Pristup ograničen</h2>
            <p className="mt-1 text-sm text-ink-secondary">
              Energetika / SCADA je dostupna samo administratorima i menadžmentu.
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  const snaps = snapshotsQ.data?.data ?? [];
  const sites = sitesQ.data;
  const snapBy = new Map(snaps.map((s) => [s.siteKey, s]));
  const newest = snaps.reduce((m, s) => Math.max(m, new Date(s.updatedAt || 0).getTime()), 0);
  const headerMeta = newest ? `Bridge: ${fmtTime(new Date(newest).toISOString())}` : undefined;
  const banner = bannerText(snaps, tab);
  const alarms = alarmsQ.data ?? [];

  const dotFor = (key: string): string => {
    const snap = snapBy.get(key);
    return STATUS_DOT[siteStatus(snap)[1]];
  };

  const tabs: TabItem<TabKey>[] = [
    { key: 'pregled', label: '📊 Pregled' },
    ...SITE_ORDER.map((k) => ({ key: k, label: `${dotFor(k)} ${SITE_META[k].tabLabel}` })),
    { key: 'komande', label: '📜 Komande' },
  ];

  return (
    <AppShell>
      <PageHeader
        title="Energetika / SCADA"
        count={headerMeta}
        actions={
          <Button variant="secondary" onClick={() => router.push('/m/energetika')}>
            📱 Touch prikaz
          </Button>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {/* „Overlay" statusa 5 sistema (live snapshot pregled). */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {SITE_ORDER.map((key) => {
            const snap = snapBy.get(key) ?? null;
            const [label, tone] = siteStatus(snap);
            const [num, unit, lbl] = heroFor(key, snap?.payload ?? null);
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className="rounded-panel border border-line bg-surface p-3 text-left hover:bg-surface-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-ink">
                    {siteIco(key)} {siteName(key, sites)}
                  </span>
                  <StatusBadge tone={STATUS_TONE[tone]} label={label} />
                </div>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="tabular-nums text-2xl font-semibold text-ink">{num}</span>
                  <span className="text-sm text-ink-secondary">{unit}</span>
                </div>
                <div className="text-xs text-ink-secondary">{lbl}</div>
              </button>
            );
          })}
        </div>

        {/* Aktivni alarmi (kompaktno). */}
        {alarms.length > 0 && (
          <div className="rounded-panel border border-status-warn/40 bg-status-warn-bg p-3">
            <div className="mb-1 text-sm font-medium text-status-warn">
              🚨 Aktivni alarmi ({alarms.length})
            </div>
            <ul className="space-y-0.5 text-sm text-ink">
              {alarms.slice(0, 6).map((a) => (
                <li key={a.id} className="flex items-baseline justify-between gap-3">
                  <span className="truncate">{a.text || a.code}</span>
                  <span className="tabular-nums shrink-0 text-xs text-ink-secondary">
                    {siteName(a.siteKey, sites)} · {fmtWhen(a.raisedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {banner && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {banner}
          </div>
        )}

        <Tabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Energetika / SCADA" />

        <div className="min-h-0 flex-1">
          {tab === 'komande' ? (
            <div className="h-full overflow-auto">
              <CommandsAudit active sites={sites} />
            </div>
          ) : (
            <div className="h-full min-h-[60vh] overflow-hidden rounded-panel border border-line">
              <HmiHost screen={tab === 'pregled' ? 'overview.html' : SITE_META[tab].screen} theme={theme} />
            </div>
          )}
        </div>
      </div>

      {/* Potvrda komande — 2.0 modal (tekst identičan 1.0). */}
      <Dialog
        open={!!confirm}
        onClose={() => resolveConfirm(false)}
        title="⚡ Potvrda komande"
        footer={
          <>
            <Button variant="secondary" onClick={() => resolveConfirm(false)}>
              Otkaži
            </Button>
            <Button variant="primary" onClick={() => resolveConfirm(true)}>
              Potvrdi
            </Button>
          </>
        }
      >
        <p className="whitespace-pre-line text-sm text-ink">{confirm?.text}</p>
        <p className="mt-2 text-xs text-ink-secondary">
          Komanda se izvršava na živom postrojenju i trajno beleži u audit.
        </p>
      </Dialog>

      {toast && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-panel border border-line bg-surface px-4 py-2 text-sm text-ink shadow-lg">
          {toast}
        </div>
      )}
    </AppShell>
  );

  function resolveConfirm(ok: boolean) {
    if (confirm?.source) {
      try {
        (confirm.source as Window).postMessage(
          { type: 'scada-confirm-result', id: confirm.id, ok },
          '*',
        );
      } catch {
        /* iframe nestao */
      }
    }
    setConfirm(null);
  }
}
