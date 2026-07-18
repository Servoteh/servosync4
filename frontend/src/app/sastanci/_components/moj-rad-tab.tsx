'use client';

import { Check, X } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { useAkcije, useMyMeetings, useSetMyRsvp, type Sastanak } from '@/api/sastanci';
import {
  AkcijaStatusBadge,
  formatDatum,
  formatVreme,
  SastanakStatusBadge,
  tableEmpty,
} from './common';
import { useDetailNav } from './detail-nav';

/** Moj rad — moji sastanci (+ RSVP) + moje akcije (paritet 1.0 mojRadTab). */
export function MojRadTab({ myEmail }: { myEmail: string }) {
  const nav = useDetailNav();
  const meetings = useMyMeetings();
  const akcije = useAkcije({ odgovoranEmail: myEmail });
  const rsvp = useSetMyRsvp();

  const meetingRows = meetings.data?.data ?? [];
  const akcijeRows = (akcije.data?.data ?? []).filter((a) =>
    ['otvoren', 'u_toku', 'kasni'].includes(a.effective_status),
  );

  const mCols: Column<Sastanak>[] = [
    { key: 'naslov', header: 'Naslov', render: (r) => <span className="font-medium">{r.naslov}</span> },
    { key: 'datum', header: 'Datum', render: (r) => <span className="tnums text-ink-secondary">{formatDatum(r.datum)} {formatVreme(r.vreme)}</span> },
    { key: 'status', header: 'Status', render: (r) => <SastanakStatusBadge status={r.status} /> },
    {
      key: 'rsvp',
      header: 'Dolazak',
      render: (r) => {
        const locked = r.status === 'zakljucan' || r.status === 'otkazan';
        return (
          <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
            <button
              disabled={locked || rsvp.isPending}
              title="Dolazim"
              onClick={() => rsvp.mutate({ id: r.id, status: 'dolazim' })}
              className="rounded-control border border-line p-1 text-status-success hover:bg-surface-2 disabled:opacity-40"
            >
              <Check className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button
              disabled={locked || rsvp.isPending}
              title="Ne dolazim"
              onClick={() => rsvp.mutate({ id: r.id, status: 'ne_dolazim' })}
              className="rounded-control border border-line p-1 text-status-danger hover:bg-surface-2 disabled:opacity-40"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        );
      },
    },
  ];

  const aCols: Column<(typeof akcijeRows)[number]>[] = [
    { key: 'status', header: 'Status', render: (r) => <AkcijaStatusBadge status={r.effective_status} /> },
    { key: 'naslov', header: 'Zadatak', render: (r) => <span className="font-medium">{r.naslov}</span> },
    { key: 'rok', header: 'Rok', render: (r) => <span className={`tnums ${r.effective_status === 'kasni' ? 'text-status-danger' : 'text-ink-secondary'}`}>{r.rok_text || formatDatum(r.rok)}</span> },
  ];

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">Moji sastanci</h2>
        <DataTable
          columns={mCols}
          rows={meetingRows}
          rowKey={(r) => r.id}
          loading={meetings.isLoading}
          onRowActivate={(r) => nav.open(r.id)}
          empty={tableEmpty(meetings.isError, 'Nema sastanaka', 'Nisi učesnik nijednog sastanka.')}
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">Moje akcije (otvorene)</h2>
        <DataTable
          columns={aCols}
          rows={akcijeRows}
          rowKey={(r) => r.id}
          loading={akcije.isLoading}
          empty={tableEmpty(akcije.isError, 'Nema akcija', 'Nemaš otvorenih zaduženja.')}
        />
      </section>
    </div>
  );
}
