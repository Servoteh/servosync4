'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import { ApiError } from '@/api/client';
import {
  newClientEventId,
  useAttendanceCorrections,
  useCancelCorrection,
  useGrid,
  useGridBatch,
  useDirectory,
  useKadrMe,
  type WorkHours,
  type AttendanceCorrection,
} from '@/api/kadrovska';
import { normEmp } from '../odsustva/shared';

/**
 * PRISUSTVO → „Za potvrdu" (kontrola kucanja).
 *
 * ⚠️ AUDIT-K7 (26.07). Tok ispravke kucanja je u 3.0 postojao CEO, ali BEZ ekrana
 * na kome se zatvara — pa su dve rute ostale mrtve (`attendance/corrections/:id/cancel`
 * i lista korekcija), a urednik grida nije imao gde da vidi šta čeka njegovu reč.
 *
 * Lanac (izmeren u kodu, nije pretpostavka):
 *   1) radnik u „Mom profilu" ispravi svoje kucanje uz OBRAZLOŽENJE
 *      → `attendance_submit_correction` upiše SINTETIČKI prolaz u `attendance_events`
 *        + red u `attendance_corrections` + pošalje mejl šefu;
 *   2) noćni auto-predlog (`grid-autofill.service.ts`) iz STVARNOG prisustva predloži
 *      sate u gridu i označi ih markerom `auto:kapija` u `last_edited_by`;
 *   3) urednik grida (Nikola) potvrdi dan — `hr_upsert_work_hours_batch` prepiše
 *      `last_edited_by` njegovim mejlom, i time marker NESTAJE = potvrđeno.
 *
 * Korekcija dakle NE menja grid direktno (doktrina §2.6: grid i prisustvo su
 * odvojeni tokovi, payroll čita ISKLJUČIVO grid) — ulazi kao PREDLOG, a poslednja
 * reč je uvek urednikova. Ovaj ekran čini ta dva koraka vidljivim na jednom mestu.
 */

const AUTO_MARKER = 'auto:kapija';

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function KontrolaView() {
  const { can } = useAuth();
  const canGridEdit = can(PERMISSIONS.KADROVSKA_GRID_EDIT);
  const meQ = useKadrMe();
  const me = meQ.data?.data;

  /**
   * Ko sme da PONIŠTI ispravku (odluka Nenad, 26.07: „i Nikola i šefovi
   * pododeljenja i admini — Nenad, Nevena, Zoran, za sve").
   *
   * Merodavan je DB: `attendance_cancel_correction` propušta
   * `current_user_manages_employee(emp) ∨ current_user_is_hr_or_admin()` —
   * dakle admin/hr/poslovni_admin za SVE, a `menadzment` samo u svom opsegu
   * pododeljenja. Ovde samo prikazujemo dugme istoj grupi; server presuđuje
   * red-po-red i vraća jasnu poruku ako nema prava (AUDIT-K3 assertRpcOk).
   *
   * ⚠️ Grid editor (allowlist) NIJE deo `current_user_manages_employee` — vidi
   * napomenu u zaglavlju fajla.
   */
  const canCancel =
    !!me &&
    (me.isAdmin || me.isHr || me.poslovniAdmin || me.isManagement || me.gridEditor);

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [msg, setMsg] = useState('');

  const from = ymd(new Date(year, month - 1, 1));
  const to = ymd(new Date(year, month, 0));

  const corrQ = useAttendanceCorrections({ from, to });
  const gridQ = useGrid({ year, month });
  const dirQ = useDirectory();
  const cancelM = useCancelCorrection();
  const batchM = useGridBatch();

  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of (dirQ.data?.data ?? []).map(normEmp)) m.set(r.id, r.name);
    return m;
  }, [dirQ.data]);
  const empName = (id: string) => names.get(id) || id.slice(0, 8);

  /* ── A) Korekcije radnika koje čekaju reč urednika ─────────────────────── */
  const corrections = corrQ.data?.data ?? [];

  /* ── B) Dani u gridu koji su još AUTO predlog (nepotvrđeni) ────────────── */
  const autoRows = useMemo(
    () => (gridQ.data?.data?.rows ?? []).filter((r) => r.lastEditedBy === AUTO_MARKER),
    [gridQ.data],
  );

  function shiftMonth(delta: number) {
    let y = year;
    let m = month + delta;
    while (m < 1) { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    setYear(y);
    setMonth(m);
    setMsg('');
  }

  async function onCancel(id: string, name: string, day: string) {
    if (!confirm(`Poništiti korekciju za ${name} (${formatDate(day)})?\n\nSintetički prolaz ostaje u evidenciji kucanja; poništava se samo korekcija.`)) return;
    setMsg('');
    try {
      await cancelM.mutateAsync({ id, clientEventId: newClientEventId() });
      setMsg('Korekcija poništena.');
      void corrQ.refetch();
    } catch (e) {
      setMsg(e instanceof ApiError ? `⚠ ${e.message}` : '⚠ Poništavanje nije uspelo.');
    }
  }

  /**
   * Potvrda AUTO predloga = ponovni upis ISTIH vrednosti kroz `grid/batch`.
   * RPC pri tom postavlja `last_edited_by = current_user_email()`, pa marker
   * `auto:kapija` nestaje — bez nove rute i bez diranja deljenog RPC-a.
   */
  async function confirmAuto(rows: WorkHours[], askConfirm = true) {
    if (!rows.length) return;
    if (askConfirm && !confirm(`Potvrditi ${rows.length} auto-predlog(a) kao proveren unos?`)) return;
    setMsg('');
    try {
      await batchM.mutateAsync({
        clientEventId: newClientEventId(),
        rows: rows.map((r) => ({
          employeeId: r.employeeId,
          workDate: String(r.workDate).slice(0, 10),
          hours: Number(r.hours ?? 0),
          overtimeHours: Number(r.overtimeHours ?? 0),
          fieldHours: Number(r.fieldHours ?? 0),
          fieldSubtype: (r.fieldSubtype === 'domestic' || r.fieldSubtype === 'foreign') ? r.fieldSubtype : undefined,
          twoMachineHours: Number(r.twoMachineHours ?? 0),
          absenceCode: r.absenceCode ?? undefined,
          absenceSubtype: r.absenceSubtype ?? undefined,
        })),
      });
      setMsg(`✅ Potvrđeno ${rows.length} dana — AUTO oznaka uklonjena.`);
      void gridQ.refetch();
    } catch (e) {
      setMsg(e instanceof ApiError ? `⚠ ${e.message}` : '⚠ Potvrda nije uspela.');
    }
  }

  const corrCols: Column<AttendanceCorrection>[] = [
    { key: 'emp', header: 'Zaposleni', render: (r) => empName(r.employeeId) },
    { key: 'day', header: 'Dan', render: (r) => formatDate(r.day) },
    { key: 'in', header: 'Ulaz', render: (r) => r.correctedIn || '—' },
    { key: 'out', header: 'Izlaz', render: (r) => r.correctedOut || '—' },
    {
      key: 'reason',
      header: 'Obrazloženje radnika',
      render: (r) => <span className="text-ink-secondary">{r.reason || '—'}</span>,
    },
    {
      key: 'ko',
      header: 'Podneo',
      render: (r) => (
        <span className="text-2xs text-ink-secondary">
          {r.createdForSelf ? 'sam radnik' : r.createdBy || '—'}
        </span>
      ),
    },
    { key: 'st', header: 'Status', render: (r) => <StatusBadge tone="warn" label={r.status} /> },
    {
      key: 'act',
      header: '',
      align: 'right',
      render: (r) =>
        canCancel ? (
          <Button
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => onCancel(r.id, empName(r.employeeId), r.day)}
          >
            Poništi
          </Button>
        ) : null,
    },
  ];

  const autoCols: Column<WorkHours>[] = [
    { key: 'emp', header: 'Zaposleni', render: (r) => empName(r.employeeId) },
    { key: 'day', header: 'Dan', render: (r) => formatDate(String(r.workDate)) },
    { key: 'h', header: 'Predloženo sati', align: 'right', render: (r) => Number(r.hours ?? 0) || '—' },
    { key: 'abs', header: 'Odsustvo', render: (r) => r.absenceCode || '—' },
    { key: 'st', header: 'Status', render: () => <StatusBadge tone="info" label="AUTO — čeka potvrdu" /> },
    {
      // ODLUKA Nenad (26.07): potvrda ide PO REDU — masovno dugme previše lako
      // „prevuče" i dan koji je trebalo pogledati. Zato je ovo glavna radnja.
      key: 'ok',
      header: '',
      align: 'right',
      render: (r) =>
        canGridEdit ? (
          <Button
            className="h-7 px-2 text-xs"
            disabled={batchM.isPending}
            onClick={() => confirmAuto([r], false)}
          >
            ✓ Potvrdi
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" className="h-8 px-2" onClick={() => shiftMonth(-1)} aria-label="Prethodni mesec">←</Button>
        <span className="tabular-nums text-sm font-medium text-ink">
          {String(month).padStart(2, '0')}/{year}
        </span>
        <Button variant="secondary" className="h-8 px-2" onClick={() => shiftMonth(1)} aria-label="Sledeći mesec">→</Button>
        <div className="flex-1" />
        {msg && <span className="text-sm text-ink-secondary">{msg}</span>}
      </div>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-ink">✎ Ispravke kucanja koje su radnici prijavili</h3>
          <span className="text-2xs text-ink-secondary">
            Radnik ih podnosi iz „Mog profila" uz obrazloženje; šef dobija mejl.
          </span>
        </div>
        {corrections.length === 0 ? (
          <EmptyState title="Nema aktivnih ispravki za ovaj mesec" />
        ) : (
          <DataTable
            columns={corrCols}
            rows={corrections}
            rowKey={(r) => r.id}
            loading={corrQ.isLoading}
            empty={<EmptyState title="Nema ispravki" />}
          />
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-ink">🕐 Auto-predlozi iz kapije koji čekaju potvrdu</h3>
          <span className="text-2xs text-ink-secondary">
            Predlog je izveden iz stvarnog kucanja. Potvrda upisuje vaš potpis i sklanja AUTO oznaku.
          </span>
          <div className="flex-1" />
          {/* Masovna potvrda je SPOREDNA (ghost) — glavna radnja je „✓ Potvrdi" po
              redu, da se dan koji je trebalo pogledati ne prevuče u gomili. */}
          {canGridEdit && autoRows.length > 0 && (
            <Button variant="ghost" loading={batchM.isPending} onClick={() => confirmAuto(autoRows)}>
              Potvrdi sve ({autoRows.length})
            </Button>
          )}
        </div>
        {autoRows.length === 0 ? (
          <EmptyState title="Nema nepotvrđenih auto-predloga" />
        ) : (
          <DataTable
            columns={autoCols}
            rows={autoRows}
            rowKey={(r) => `${r.employeeId}|${String(r.workDate).slice(0, 10)}`}
            loading={gridQ.isLoading}
            empty={<EmptyState title="Nema predloga" />}
          />
        )}
        {!canGridEdit && autoRows.length > 0 && (
          <p className="text-2xs text-ink-secondary">
            Potvrdu upisuje urednik mesečnog grida (`kadrovska.grid_edit`).
          </p>
        )}
      </section>
    </div>
  );
}
