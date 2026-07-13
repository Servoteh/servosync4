'use client';

import { CalendarClock, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import {
  useAkcije,
  useDashboardStats,
  useNextWeekly,
  useTeme,
} from '@/api/sastanci';
import { AkcijaStatusBadge, formatDatum, formatVreme, SASTANAK_TIP_LABEL } from './common';
import { KpiTile } from './tabs';
import { useDetailNav } from './detail-nav';

/** Pregled (KPI + predstojeći + moje akcije/teme) — paritet 1.0 dashboardTab. */
export function PregledTab({
  myEmail,
  onJump,
}: {
  myEmail: string;
  onJump: (tab: 'sastanci' | 'akcioni' | 'pmteme') => void;
}) {
  const nav = useDetailNav();
  const stats = useDashboardStats();
  const next = useNextWeekly();
  const myAkcije = useAkcije({ odgovoranEmail: myEmail });
  const myTeme = useTeme({ predlozioEmail: myEmail, excludeStatuses: 'zatvoreno,odbijeno' });

  const s = stats.data?.data;
  const nextS = next.data?.data ?? null;

  const openAkcije = (myAkcije.data?.data ?? [])
    .filter((a) => ['otvoren', 'u_toku', 'kasni'].includes(a.effective_status))
    .slice(0, 6);
  const teme = (myTeme.data?.data ?? []).slice(0, 6);

  return (
    <div className="space-y-6">
      {/* KPI red */}
      <div className="flex gap-3 overflow-x-auto pb-1">
        <KpiTile value={s?.sastanc_upcoming ?? 0} label="Sast. 14 dana" title="Sastanaka u 14 dana" onClick={() => onJump('sastanci')} />
        <KpiTile value={s?.sastanc_u_toku ?? 0} label="U toku" tone="info" title="Sastanci u toku" onClick={() => onJump('sastanci')} />
        <KpiTile value={s?.akcije_otvoreno ?? 0} label="Akcija otv." title="Otvorenih akcija" onClick={() => onJump('akcioni')} />
        <KpiTile value={s?.akcije_kasni ?? 0} label="Kasne" tone="danger" title="Akcija koje kasne" onClick={() => onJump('akcioni')} />
        <KpiTile value={s?.pm_teme_na_cekanju ?? 0} label="PM teme" tone="warn" title="PM teme na čekanju" onClick={() => onJump('pmteme')} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Sledeći sastanak */}
        <section className="rounded-panel border border-line bg-surface p-4">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
            <CalendarClock className="h-4 w-4 text-accent" aria-hidden /> Sledeći sastanak
          </h2>
          {nextS ? (
            <div className="space-y-2">
              <p className="text-base font-medium text-ink">{nextS.naslov}</p>
              <p className="tnums text-sm text-ink-secondary">
                {formatDatum(nextS.datum)} · {formatVreme(nextS.vreme)}
                {nextS.mesto ? ` · ${nextS.mesto}` : ''}
              </p>
              <p className="text-xs text-ink-disabled">{SASTANAK_TIP_LABEL[nextS.tip] ?? nextS.tip}</p>
              <Button variant="secondary" onClick={() => nav.open(nextS.id)}>
                Otvori
              </Button>
            </div>
          ) : (
            <p className="text-sm text-ink-secondary">Nema zakazanih sastanaka.</p>
          )}
        </section>

        {/* Moje akcije */}
        <section className="rounded-panel border border-line bg-surface p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Moje akcije</h2>
            <button className="flex items-center gap-1 text-xs text-accent hover:underline" onClick={() => onJump('akcioni')}>
              Sve <ArrowRight className="h-3 w-3" aria-hidden />
            </button>
          </div>
          {openAkcije.length ? (
            <ul className="space-y-2">
              {openAkcije.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-2">
                  <span className="line-clamp-2 text-sm text-ink">{a.naslov}</span>
                  <AkcijaStatusBadge status={a.effective_status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-secondary">Nemaš otvorenih akcija.</p>
          )}
        </section>

        {/* Moje teme */}
        <section className="rounded-panel border border-line bg-surface p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Moje teme</h2>
            <button className="flex items-center gap-1 text-xs text-accent hover:underline" onClick={() => onJump('pmteme')}>
              Sve <ArrowRight className="h-3 w-3" aria-hidden />
            </button>
          </div>
          {teme.length ? (
            <ul className="space-y-2">
              {teme.map((t) => (
                <li key={t.id} className="flex items-center gap-2">
                  {t.hitno && <span className="text-status-danger" title="Hitno" aria-hidden>🔥</span>}
                  <span className="line-clamp-1 text-sm text-ink">{t.naslov}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-secondary">Nemaš aktivnih tema.</p>
          )}
        </section>
      </div>
    </div>
  );
}
