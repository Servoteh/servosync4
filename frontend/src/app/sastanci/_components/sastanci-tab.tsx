'use client';

import { useMemo, useState } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Button } from '@/components/ui-kit/button';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { useSastanci, type Sastanak } from '@/api/sastanci';
import {
  formatDatum,
  formatVreme,
  SASTANAK_TIP_LABEL,
  SastanakStatusBadge,
  tableEmpty,
  INPUT_CLS,
} from './common';
import { Tabs, type TabItem } from './tabs';
import { CalendarView, WeekView } from './sastanci-views';
import { CreateSastanakModal } from './create-sastanak-modal';
import { WeeklyControlModal } from './weekly-control-modal';
import { useDetailNav } from './detail-nav';

type ViewKey = 'lista' | 'kalendar' | 'nedelja';

/** Lista/kalendar/nedelja sastanaka + filteri + Novi/Sedmični (paritet 1.0 sastanciTab). */
export function SastanciTab() {
  const nav = useDetailNav();
  const [view, setView] = useState<ViewKey>('lista');
  const [q, setQ] = useState('');
  const [tip, setTip] = useState('');
  const [status, setStatus] = useState('');
  // null = zatvoren; tip/prenos pre-set za „Sedmični + prenos" (1.0 sstWeeklyCarry).
  const [createOpts, setCreateOpts] = useState<{ tip?: string; prenos?: boolean } | null>(null);
  const [weeklyOpen, setWeeklyOpen] = useState(false);

  // Za kalendar/nedelju učitavamo širi skup (bez paginacije filtera).
  const listQ = useSastanci({ q, tip, status, pageSize: view === 'lista' ? 50 : 300 });
  const rows = listQ.data?.data ?? [];

  // Zahtev 014/26 t.5 — u LISTI prikaži SLEDEĆI (predstojeći) termin, ne prethodni:
  // predstojeći sastanci (datum >= danas) idu prvi, uzlazno (najskoriji na vrhu), a
  // prošli iza njih silazno. Za nedeljne serije to znači da je gore sledeći termin,
  // a ne održani prethodni. Sort je nad učitanom stranom (server vraća datum desc);
  // kalendar/nedelja grupišu po danu pa im redosled nije bitan → koriste `rows`.
  const listaRows = useMemo(() => {
    const now = new Date();
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const dkey = (s: Sastanak) => String(s.datum).slice(0, 10);
    const skey = (s: Sastanak) => `${dkey(s)}T${(s.vreme ? String(s.vreme).slice(11, 16) || String(s.vreme).slice(0, 5) : '') || '00:00'}`;
    return [...rows].sort((a, b) => {
      const aUp = dkey(a) >= todayIso;
      const bUp = dkey(b) >= todayIso;
      if (aUp !== bUp) return aUp ? -1 : 1; // predstojeći pre prošlih
      const ak = skey(a);
      const bk = skey(b);
      if (ak === bk) return 0;
      // predstojeći: uzlazno (najskoriji prvi); prošli: silazno (najskoriji prošli prvi)
      return aUp ? (ak < bk ? -1 : 1) : ak > bk ? -1 : 1;
    });
  }, [rows]);

  const open = (id: string) => nav.open(id);

  const cols: Column<Sastanak>[] = [
    { key: 'naslov', header: 'Naslov', render: (r) => <span className="font-medium">{r.naslov}</span> },
    { key: 'tip', header: 'Tip', render: (r) => <span className="text-ink-secondary">{SASTANAK_TIP_LABEL[r.tip] ?? r.tip}</span> },
    { key: 'datum', header: 'Datum', render: (r) => <span className="tnums text-ink-secondary">{formatDatum(r.datum)}</span> },
    {
      key: 'vreme',
      // Kolona prikazuje PLANIRANO vreme (`sastanci.vreme`) — nije izvedeno iz vremena
      // kreiranja/izmene/zaključavanja. Tooltip je tu da to bude nedvosmisleno.
      header: <span title="Planirano vreme">Vreme</span>,
      render: (r) => <span className="tnums text-ink-secondary">{formatVreme(r.vreme)}</span>,
    },
    { key: 'mesto', header: 'Mesto', render: (r) => <span className="text-ink-secondary">{r.mesto || '—'}</span> },
    { key: 'status', header: 'Status', render: (r) => <SastanakStatusBadge status={r.status} /> },
  ];

  const viewTabs: TabItem<ViewKey>[] = [
    { key: 'lista', label: 'Lista' },
    { key: 'kalendar', label: 'Kalendar' },
    { key: 'nedelja', label: 'Nedelja' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs tabs={viewTabs} value={view} onChange={setView} ariaLabel="Prikaz sastanaka" />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select className={`${INPUT_CLS} w-auto`} value={tip} onChange={(e) => setTip(e.target.value)}>
            <option value="">Svi tipovi</option>
            {Object.entries(SASTANAK_TIP_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <select className={`${INPUT_CLS} w-auto`} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Svi statusi</option>
            <option value="planiran">Planiran</option>
            <option value="u_toku">U toku</option>
            <option value="zavrsen">Završen</option>
            <option value="zakljucan">Zaključan</option>
            <option value="otkazan">Otkazan</option>
          </select>
          <SearchBox value={q} onChange={setQ} placeholder="Naslov, mesto…" />
          <Can permission={PERMISSIONS.SASTANCI_WEEKLY_MOVE}>
            <Button variant="secondary" onClick={() => setWeeklyOpen(true)}>Sedmični</Button>
          </Can>
          <Can permission={PERMISSIONS.SASTANCI_EDIT}>
            <Button
              variant="secondary"
              title="Ručno kreiraj sedmični sastanak sa prenosom otvorenih akcija i učesnika"
              onClick={() => setCreateOpts({ tip: 'sedmicni', prenos: true })}
            >
              Sedmični + prenos
            </Button>
          </Can>
          <Can permission={PERMISSIONS.SASTANCI_EDIT}>
            <Button onClick={() => setCreateOpts({})}>+ Novi sastanak</Button>
          </Can>
        </div>
      </div>

      {view === 'lista' && (
        <DataTable
          columns={cols}
          rows={listaRows}
          rowKey={(r) => r.id}
          loading={listQ.isLoading}
          onRowActivate={(r) => open(r.id)}
          empty={tableEmpty(listQ.isError, 'Nema sastanaka', 'Zakaži prvi sastanak dugmetom „Novi sastanak“.')}
        />
      )}
      {view === 'kalendar' && <CalendarView sastanci={rows} onOpen={open} />}
      {view === 'nedelja' && <WeekView sastanci={rows} onOpen={open} />}

      {createOpts && (
        <CreateSastanakModal
          defaultTip={createOpts.tip ?? 'projektni'}
          defaultPrenos={!!createOpts.prenos}
          onClose={() => setCreateOpts(null)}
          onCreated={(s) => open(s.id)}
        />
      )}
      {weeklyOpen && <WeeklyControlModal onClose={() => setWeeklyOpen(false)} />}
    </div>
  );
}
