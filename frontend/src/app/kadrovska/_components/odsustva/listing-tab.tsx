'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Dialog } from '@/components/ui-kit/dialog';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { FormField } from '@/components/ui-kit/form-field';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { ApiError } from '@/api/client';
import { formatDate } from '@/lib/format';
import {
  useAbsences,
  useDirectory,
  useCreateAbsence,
  useUpdateAbsence,
  useDeleteAbsence,
  useArchiveAbsence,
  useRestoreAbsence,
  useGridBatch,
  fetchHolidaySet,
  newClientEventId,
  type Absence,
} from '@/api/kadrovska';
import { SummaryChips } from '../common';
import {
  ABS_TYPE_OPTS,
  PAID_REASON_OPTS,
  SLOBODAN_REASON_OPTS,
  SICK_SUBTYPE_OPTS,
  absStyle,
  absTypeFullLabel,
  absenceGoesToGrid,
  buildAbsenceGridRows,
  validateAbsenceForWorkType,
  compareByName,
  daysInclusive,
  normEmp,
  todayYmd,
  ymd as ymdOf,
  type EmpRow,
} from './shared';

type SortKey = 'employee' | 'type' | 'dateFrom' | 'dateTo' | 'days';

const selectCls =
  'h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink focus-visible:outline-none focus-visible:border-accent';
const dateCls = 'h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink';

export function ListingTab() {
  const { can } = useAuth();
  const canEdit = can(PERMISSIONS.KADROVSKA_EDIT);
  const canGridEdit = can(PERMISSIONS.KADROVSKA_GRID_EDIT);

  const absQ = useAbsences();
  const dirQ = useDirectory();

  const [empF, setEmpF] = useState('');
  const [typeF, setTypeF] = useState('');
  const [fromF, setFromF] = useState('');
  const [toF, setToF] = useState('');
  const [archView, setArchView] = useState(false);
  const [sort, setSort] = useState<{ col: SortKey; dir: 'asc' | 'desc' }>({ col: 'dateFrom', dir: 'desc' });
  const [modal, setModal] = useState<{ open: boolean; edit: Absence | null }>({ open: false, edit: null });

  const del = useDeleteAbsence();
  const archive = useArchiveAbsence();
  const restore = useRestoreAbsence();

  const emps: EmpRow[] = useMemo(
    () => (dirQ.data?.data ?? []).map(normEmp).sort(compareByName),
    [dirQ.data],
  );
  const nameMap = useMemo(() => new Map(emps.map((e) => [e.id, e])), [emps]);
  const empName = (id: string) => nameMap.get(id)?.name || id.slice(0, 8);

  const all = absQ.data?.data ?? [];
  const activeItems = useMemo(() => all.filter((a) => !a.archivedAt), [all]);

  const filtered = useMemo(() => {
    const list = all.filter((a) => {
      if (archView ? !a.archivedAt : a.archivedAt) return false;
      if (empF && a.employeeId !== empF) return false;
      if (typeF && a.type !== typeF) return false;
      if (fromF && a.dateTo && a.dateTo.slice(0, 10) < fromF) return false;
      if (toF && a.dateFrom && a.dateFrom.slice(0, 10) > toF) return false;
      return true;
    });
    const acc: Record<SortKey, (a: Absence) => string | number> = {
      employee: (a) => empName(a.employeeId),
      type: (a) => a.type || '',
      dateFrom: (a) => a.dateFrom || '',
      dateTo: (a) => a.dateTo || '',
      days: (a) => Number(a.daysCount || 0),
    };
    const f = acc[sort.col];
    return list.slice().sort((x, y) => {
      const vx = f(x);
      const vy = f(y);
      let c: number;
      if (typeof vx === 'string' && typeof vy === 'string') c = vx.localeCompare(vy, 'sr');
      else c = Number(vx) - Number(vy);
      return sort.dir === 'asc' ? c : -c;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, archView, empF, typeF, fromF, toF, sort, nameMap]);

  // Summary — tekući mesec (clamp).
  const chips = useMemo(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const mStart = ymdOf(y, m, 1);
    const mEnd = ymdOf(y, m, new Date(y, m, 0).getDate());
    let mCount = 0;
    let mDays = 0;
    let mSick = 0;
    for (const a of activeItems) {
      const df = (a.dateFrom || '').slice(0, 10);
      const dt = (a.dateTo || '').slice(0, 10);
      if (!df || !dt || dt < mStart || df > mEnd) continue;
      mCount++;
      mDays += daysInclusive(df < mStart ? mStart : df, dt > mEnd ? mEnd : dt);
      if (a.type === 'bolovanje') mSick++;
    }
    return { count: activeItems.length, mCount, mDays, mSick };
  }, [activeItems]);

  function toggleSort(col: SortKey) {
    setSort((s) => (s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }));
  }
  const sortMark = (col: SortKey) => (sort.col === col ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  const cols: Column<Absence>[] = [
    {
      key: 'employee',
      header: `Zaposleni${sortMark('employee')}`,
      render: (r) => <span className="font-medium text-ink">{empName(r.employeeId)}</span>,
    },
    {
      key: 'type',
      header: `Tip${sortMark('type')}`,
      render: (r) => {
        const st = absStyle(r.type);
        return (
          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${st.badge}`}>
            {absTypeFullLabel(r)}
          </span>
        );
      },
    },
    { key: 'dateFrom', header: `Od${sortMark('dateFrom')}`, render: (r) => (r.dateFrom ? formatDate(r.dateFrom) : '—') },
    { key: 'dateTo', header: `Do${sortMark('dateTo')}`, render: (r) => (r.dateTo ? formatDate(r.dateTo) : '—') },
    {
      key: 'days',
      header: `Dana${sortMark('days')}`,
      align: 'right',
      numeric: true,
      render: (r) => (r.daysCount != null ? r.daysCount : daysInclusive((r.dateFrom || '').slice(0, 10), (r.dateTo || '').slice(0, 10))),
    },
    { key: 'note', header: 'Napomena', render: (r) => <span className="text-ink-secondary">{r.note || '—'}</span> },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <div className="flex justify-end gap-1.5">
          {!archView && (
            <Button variant="secondary" className="h-7 px-2 text-xs" disabled={!canEdit} onClick={() => setModal({ open: true, edit: r })}>
              Izmeni
            </Button>
          )}
          {archView ? (
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={!canEdit}
              onClick={() => restore.mutate({ id: r.id, clientEventId: newClientEventId() })}
            >
              Vrati
            </Button>
          ) : (
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={!canEdit}
              onClick={() => {
                if (
                  window.confirm(
                    'Odsustvo se sklanja iz aktivne evidencije i izveštaja. Možeš ga kasnije vratiti iz pogleda „Arhivirana".',
                  )
                )
                  archive.mutate({ id: r.id, clientEventId: newClientEventId() });
              }}
            >
              Arhiviraj
            </Button>
          )}
          {archView && (
            <Button
              variant="danger"
              className="h-7 px-2 text-xs"
              disabled={!canEdit}
              onClick={() => {
                if (window.confirm('Obrisati odsustvo? Akcija je trajna.')) del.mutate({ id: r.id });
              }}
            >
              Obriši
            </Button>
          )}
        </div>
      ),
    },
  ];

  const total = archView ? all.length - activeItems.length : activeItems.length;

  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-secondary">
        Odsustva koja ulaze u obračun (godišnji, bolovanje, slobodan, neplaćeno, plaćeno, službeni put, slava) upisuju
        se u <strong>mesečni grid</strong> i vide se u tabu <strong>Pregled</strong>. Ova lista drži tip „ostalo" i
        starije unose.
      </p>

      <SummaryChips
        items={[
          { label: 'Ukupno u evidenciji', value: chips.count, tone: 'accent' },
          { label: 'U tekućem mesecu', value: chips.mCount },
          { label: 'Dana u mesecu', value: chips.mDays },
          { label: 'Bolovanja (mesec)', value: chips.mSick, tone: chips.mSick ? 'warn' : 'default' },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={empF} onChange={(e) => setEmpF(e.target.value)}>
          <option value="">Svi zaposleni</option>
          {emps.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <select className={selectCls} value={typeF} onChange={(e) => setTypeF(e.target.value)}>
          <option value="">Svi tipovi</option>
          {ABS_TYPE_OPTS.map((o) => (
            <option key={o.v} value={o.v}>
              {o.l}
            </option>
          ))}
        </select>
        <input type="date" className={dateCls} value={fromF} onChange={(e) => setFromF(e.target.value)} title="Od" />
        <input type="date" className={dateCls} value={toF} onChange={(e) => setToF(e.target.value)} title="Do" />
        <select
          className={selectCls}
          value={archView ? 'archived' : 'active'}
          onChange={(e) => setArchView(e.target.value === 'archived')}
          title="Aktivna ili arhivirana odsustva"
        >
          <option value="active">Aktivna</option>
          <option value="archived">Arhivirana</option>
        </select>
        <span className="ml-auto text-sm text-ink-secondary">
          {filtered.length === total ? `${total} odsustava` : `${filtered.length} / ${total} odsustava`}
        </span>
        <Button disabled={!canEdit} onClick={() => setModal({ open: true, edit: null })}>
          + Novo odsustvo
        </Button>
      </div>

      <div className="[&_th]:cursor-pointer" onClickCapture={onHeaderClick(toggleSort)}>
        <DataTable
          columns={cols}
          rows={filtered}
          rowKey={(r) => r.id}
          loading={absQ.isLoading}
          empty={
            <EmptyState
              title={
                total === 0
                  ? archView
                    ? 'Nema arhiviranih odsustava'
                    : 'Nema odsustava'
                  : 'Nijedan rezultat ne odgovara filterima'
              }
              hint={total === 0 && !archView ? 'Dodaj prvo odsustvo (godišnji, bolovanje, službeno…)' : undefined}
            />
          }
        />
      </div>

      {modal.open && (
        <AbsenceModal
          edit={modal.edit}
          emps={emps}
          canGridEdit={canGridEdit}
          onClose={() => setModal({ open: false, edit: null })}
        />
      )}
    </div>
  );
}

/** Klik na <th> (colgroup nema data-key) → mapiraj po tekstu zaglavlja na SortKey. */
function onHeaderClick(toggle: (c: SortKey) => void) {
  const map: Record<string, SortKey> = {
    Zaposleni: 'employee',
    Tip: 'type',
    Od: 'dateFrom',
    Do: 'dateTo',
    Dana: 'days',
  };
  return (e: React.MouseEvent) => {
    const th = (e.target as HTMLElement).closest('th');
    if (!th) return;
    const label = (th.textContent || '').replace(/[▲▼\s]+$/, '').trim();
    const key = map[label];
    if (key) toggle(key);
  };
}

// ── Novo / Izmeni odsustvo ───────────────────────────────────────────────────

function AbsenceModal({
  edit,
  emps,
  canGridEdit,
  onClose,
}: {
  edit: Absence | null;
  emps: EmpRow[];
  canGridEdit: boolean;
  onClose: () => void;
}) {
  const isEdit = !!edit;
  const create = useCreateAbsence();
  const update = useUpdateAbsence();
  const gridBatch = useGridBatch();

  const [empId, setEmpId] = useState(edit?.employeeId ?? '');
  const [type, setType] = useState(edit?.type ?? 'godisnji');
  const [sickSubtype, setSickSubtype] = useState(edit?.absenceSubtype ?? 'obicno');
  const [paidReason, setPaidReason] = useState(edit?.paidReason ?? '');
  const [slobodanReason, setSlobodanReason] = useState(edit?.slobodanReason ?? '');
  const [dateFrom, setDateFrom] = useState((edit?.dateFrom ?? '').slice(0, 10));
  const [dateTo, setDateTo] = useState((edit?.dateTo ?? '').slice(0, 10));
  const [daysStr, setDaysStr] = useState(edit?.daysCount != null ? String(edit.daysCount) : '');
  const [note, setNote] = useState(edit?.note ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const empOptions = isEdit ? emps : emps.filter((e) => e.isActive);
  const emp = emps.find((e) => e.id === empId);

  async function submit() {
    setErr('');
    if (!empId) return setErr('Izaberi zaposlenog.');
    if (!dateFrom || !dateTo) return setErr('Datumi su obavezni.');
    if (dateTo < dateFrom) return setErr('„Do" ne može biti pre „Od".');
    if (type === 'placeno' && !paidReason) return setErr('Za plaćeno odsustvo izaberi razlog.');
    if (type === 'slobodan' && !slobodanReason) return setErr('Za slobodan dan izaberi razlog.');
    if (type === 'neplaceno' && !note.trim())
      return setErr('Za neplaćeno odsustvo obavezno unesi napomenu (npr. ko je odobrio i razlog).');
    if (emp?.workType) {
      const v = validateAbsenceForWorkType(type, emp.workType);
      if (!v.ok) return setErr(v.msg);
    }
    const daysCount = daysStr.trim() === '' ? daysInclusive(dateFrom, dateTo) : parseInt(daysStr, 10);

    setBusy(true);
    try {
      // Most → grid: NOVI unos tipa sa grid ekvivalentom ide u work_hours (radni dani).
      if (!isEdit && absenceGoesToGrid(type)) {
        if (!canGridEdit) {
          setErr(
            'Godišnji, bolovanje, slobodan dan i neplaćeno se upisuju u mesečni grid — za to je potreban nalog editora grida (kadrovska.grid_edit).',
          );
          setBusy(false);
          return;
        }
        const holidaySet = await fetchHolidaySet(dateFrom, dateTo);
        const built = buildAbsenceGridRows({ employeeId: empId, type, absenceSubtype: sickSubtype, dateFrom, dateTo, holidaySet });
        if (!built) {
          setErr('Period nema nijedan radni dan (sve su vikendi/praznici).');
          setBusy(false);
          return;
        }
        await gridBatch.mutateAsync({ rows: built.rows, clientEventId: newClientEventId() });
        onClose();
        return;
      }

      // Absences tabela (edit bilo kog tipa, ili NOVI 'ostalo').
      if (isEdit && edit) {
        await update.mutateAsync({
          id: edit.id,
          patch: {
            type,
            dateFrom,
            dateTo,
            daysCount,
            note: note.trim() || null,
            paidReason: type === 'placeno' ? paidReason || null : null,
            slobodanReason: type === 'slobodan' ? slobodanReason || null : null,
            absenceSubtype: type === 'bolovanje' ? sickSubtype : null,
          },
        });
      } else {
        await create.mutateAsync({
          clientEventId: newClientEventId(),
          employeeId: empId,
          type,
          dateFrom,
          dateTo,
          daysCount,
          note: note.trim() || undefined,
          paidReason: type === 'placeno' ? paidReason : undefined,
          slobodanReason: type === 'slobodan' ? slobodanReason : undefined,
          absenceSubtype: type === 'bolovanje' ? sickSubtype : undefined,
        });
      }
      onClose();
    } catch (e) {
      const ae = e as ApiError;
      const msg = (ae?.message || '').toLowerCase();
      if (ae?.status === 409 || msg.includes('overlap') || msg.includes('preklap') || msg.includes('23p01')) {
        setErr('Postoji preklapajuće odsustvo za ovog zaposlenog u tom periodu. Proveri postojeća odsustva.');
      } else {
        setErr(ae?.message || 'Greška pri čuvanju.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={isEdit ? 'Izmeni odsustvo' : 'Novo odsustvo'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={busy}>
            Sačuvaj
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && (
          <div className="rounded-control border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger" role="alert">
            {err}
          </div>
        )}
        <FormField label="Zaposleni" required>
          <select className={`${selectCls} w-full`} value={empId} onChange={(e) => setEmpId(e.target.value)} disabled={isEdit}>
            <option value="">— izaberi —</option>
            {empOptions.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Tip odsustva" required>
            <select className={`${selectCls} w-full`} value={type} onChange={(e) => setType(e.target.value)}>
              {ABS_TYPE_OPTS.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.l}
                </option>
              ))}
            </select>
          </FormField>
          {type === 'bolovanje' && (
            <FormField label="Tip bolovanja">
              <select className={`${selectCls} w-full`} value={sickSubtype} onChange={(e) => setSickSubtype(e.target.value)}>
                {SICK_SUBTYPE_OPTS.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.l}
                  </option>
                ))}
              </select>
            </FormField>
          )}
          {type === 'placeno' && (
            <FormField label="Razlog (plaćeno)" required>
              <select className={`${selectCls} w-full`} value={paidReason} onChange={(e) => setPaidReason(e.target.value)}>
                <option value="">—</option>
                {PAID_REASON_OPTS.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.l}
                  </option>
                ))}
              </select>
            </FormField>
          )}
          {type === 'slobodan' && (
            <FormField label="Razlog (slobodan dan)" required>
              <select className={`${selectCls} w-full`} value={slobodanReason} onChange={(e) => setSlobodanReason(e.target.value)}>
                <option value="">— izaberi razlog —</option>
                {SLOBODAN_REASON_OPTS.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.l}
                  </option>
                ))}
              </select>
            </FormField>
          )}
        </div>
        <div className="grid grid-cols-3 gap-3">
          <FormField label="Od" required>
            <input type="date" className={`${dateCls} w-full`} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </FormField>
          <FormField label="Do" required>
            <input type="date" className={`${dateCls} w-full`} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </FormField>
          <FormField label="Dana">
            <input
              type="number"
              min={0}
              max={365}
              className={`${dateCls} w-full`}
              placeholder="Auto"
              value={daysStr}
              onChange={(e) => setDaysStr(e.target.value)}
            />
          </FormField>
        </div>
        <FormField label="Napomena">
          <textarea
            className="min-h-[64px] w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink"
            maxLength={500}
            placeholder="Opcioni komentar…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </FormField>
        {!isEdit && absenceGoesToGrid(type) && (
          <p className="text-xs text-ink-secondary">
            ⓘ Ovaj tip se upisuje u <strong>mesečni grid</strong> (samo radni dani; vikendi/praznici se preskaču).
          </p>
        )}
      </div>
    </Dialog>
  );
}
