'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Link2, RefreshCw, ArrowRight, AlertTriangle, Database } from 'lucide-react';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { ApiError } from '@/api/client';
import { toast } from '@/lib/toast';
import { formatDateTime, formatNumber, formatRelativeAge } from '@/lib/format';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { useSyncLogs } from '@/api/sync';
import { useBigbitSync, useSetBigbitSync, type SyncWarning } from '@/api/podesavanja';

// ============================================================================
// Podešavanja → Integracije — spoljni sistemi + platforma (paritet 1.0
// `integracijeTab.js`). KPI online/offline se izvodi iz zdravlja backend poziva
// (`GET /sync/log` kroz NestJS): uspeh = REST online. „Proveri konekciju” =
// refetch tog upita. Link ka postojećem `/syncs` ekranu (2.0 sync-status). Tabela
// integracija je statička (BigTehn/Auth/Resend/WhatsApp/MES — paritet 1.0 opis).
//
// Stavka B (26.07.2026): PREKIDAČ noćnog BigBit (.mdb) uvoza — vlasnik ga gasi/pali
// ovde, stanje je u bazi (`app_switches`), važi odmah bez restarta. Uz prekidač ide
// i STANJE (poslednji uspešan uvoz, broj redova, starost izvornog fajla) — jedina
// zaštita od „sync je ugašen mesec dana, a niko ne zna". Čitanje = settings.system
// (kapija ovog taba), preklop = sync.run (administrativna radnja, ne obično čitanje).
// ============================================================================

interface IntegRow {
  name: string;
  tone: Tone;
  label: string;
  note: string;
}

const INTEGRATIONS: IntegRow[] = [
  {
    name: 'BigTehn cache',
    tone: 'success',
    label: 'Aktivno',
    note: 'Predmeti, RN, mašine — read-only sync u 2.0 (vidi Sync status).',
  },
  {
    name: 'Supabase Auth (sy15)',
    tone: 'success',
    label: 'Aktivno',
    note: 'JWT + user_roles; invite/edit kroz Podešavanja → Korisnici.',
  },
  {
    name: 'Resend / email dispatch',
    tone: 'info',
    label: 'Po modulu',
    note: 'PB, Sastanci, HR, CMMS — Edge / dispatch funkcije.',
  },
  {
    name: 'WhatsApp (Meta)',
    tone: 'neutral',
    label: 'Opciono',
    note: 'HR / Sastanci — env secrets na Edge.',
  },
  {
    name: 'MES radni nalozi',
    tone: 'info',
    label: 'Samo čitanje',
    note: 'BigTehn radni nalozi — read-only kroz sync.',
  },
];

export function IntegracijeTab() {
  const q = useSyncLogs();

  // REST online = uspešan poziv kroz backend. Offline = greška/nedostupan.
  const online = q.isSuccess && !q.isError;
  const restTone: Tone = q.isLoading ? 'neutral' : online ? 'success' : 'warn';
  const restValue = q.isLoading ? 'Provera…' : online ? 'Online' : 'Offline';
  const restSub = q.isLoading ? 'Provera konekcije' : online ? 'REST odgovara (NestJS · sy15)' : 'REST nedostupan';

  const lastRun = Array.isArray(q.data) && q.data.length ? q.data[0] : null;

  async function checkConnection() {
    try {
      const r = await q.refetch();
      const ok = r.status === 'success' && !r.error;
      toast(ok ? '✅ REST online' : '⚠ REST nedostupan');
    } catch {
      toast('⚠ REST nedostupan');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-control bg-surface-2 text-ink-secondary">
          <Link2 className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-ink">Integracije</h2>
          <p className="text-xs text-ink-secondary">Spoljni sistemi i platforma</p>
        </div>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi label="REST" value={restValue} sub={restSub} tone={restTone} />
        {/* Ovaj KPI se odnosi na BigTehn/MSSQL šifarnički sync, NE na noćni BigBit
            .mdb uvoz iz kartice ispod — zelen ovde ne znači da finansije stižu. */}
        <Kpi
          label="Poslednji sync (BigTehn)"
          value={lastRun ? syncStatusLabel(lastRun.status) : online ? 'Nema zapisa' : '—'}
          sub={lastRun?.finishedAt ? formatDateTime(lastRun.finishedAt) : lastRun?.startedAt ? formatDateTime(lastRun.startedAt) : 'BigTehn cache'}
          tone={lastRun ? syncStatusTone(lastRun.status) : 'neutral'}
        />
        <Kpi label="Platforma" value="Servosync 2.0" sub="NestJS · Prisma · sy15" tone="neutral" />
      </div>

      {/* Akcije */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void checkConnection()}
          disabled={q.isFetching}
          className="inline-flex items-center gap-2 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-surface-2 disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? 'animate-spin' : ''}`} aria-hidden />
          Proveri konekciju
        </button>
        <Link
          href="/syncs"
          className="inline-flex items-center gap-1.5 text-sm text-accent underline underline-offset-2 hover:opacity-80"
        >
          Sync status (BigTehn) <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>

      <BigbitSyncCard />

      {/* Tabela integracija */}
      <div className="overflow-x-auto rounded-panel border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase text-ink-secondary">
              <th className="px-3 py-2">Integracija</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Napomena</th>
            </tr>
          </thead>
          <tbody>
            {INTEGRATIONS.map((r) => (
              <tr key={r.name} className="border-b border-line-soft">
                <td className="px-3 py-2 font-medium text-ink">{r.name}</td>
                <td className="px-3 py-2">
                  <StatusBadge tone={r.tone} label={r.label} />
                </td>
                <td className="px-3 py-2 text-ink-secondary">{r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-ink-disabled">
        Dijagnostika: tab Sistem. Notifikacije se podešavaju po modulu (tab Notifikacije).
      </p>
    </div>
  );
}

/**
 * Prekidač noćnog BigBit uvoza + stanje poslednjeg uvoza (stavka B).
 * Preklop je optimistički sa povratkom na server-istinu na grešku (kućni obrazac iz
 * `predmet-aktivacija-tab.tsx`); ui-kit nema Checkbox komponentu pa je goli
 * `<input type="checkbox">` u `<label>`-u — tastatura (Tab + Space) radi nativno.
 */
function BigbitSyncCard() {
  const q = useBigbitSync();
  const setM = useSetBigbitSync();
  const can = useCan();
  const mayToggle = can(PERMISSIONS.SYNC_RUN);

  const s = q.data?.data ?? null;
  // NEPOZNATO ≠ UKLJUČENO. Ranije je `?? true` uz `tone: success` značilo da pad
  // upita (500, istekao token, baza bez migracije) izgleda IDENTIČNO kao zdravo
  // stanje — pa je stvarno isključen uvoz mogao mesecima da se prikazuje zeleno.
  const unknown = q.isError || (!q.isLoading && !s);
  const serverEnabled = s?.enabled ?? true;

  // Lokalni izbor: pomera se odmah na klik, vraća se na server-istinu posle odgovora/greške.
  const [enabled, setEnabled] = useState(serverEnabled);
  const [note, setNote] = useState('');

  useEffect(() => {
    setEnabled(serverEnabled);
  }, [serverEnabled]);
  useEffect(() => {
    setNote(s?.note ?? '');
  }, [s?.note]);

  // Dok se stanje ne zna, preklop je zaključan — klik bi poslao PUT na osnovu
  // izmišljene vrednosti i obrisao postojeću napomenu.
  const busy = setM.isPending || q.isLoading || unknown;

  async function toggle(next: boolean) {
    const prev = enabled;
    setEnabled(next);
    try {
      await setM.mutateAsync({ enabled: next, note: note.trim() || undefined });
      toast(next ? '✅ Noćni uvoz iz BigBita je uključen' : '⏸ Noćni uvoz iz BigBita je isključen');
    } catch (e) {
      setEnabled(prev);
      const forbidden = e instanceof ApiError && e.status === 403;
      toast(forbidden ? '⚠ Nemate pravo da menjate ovo podešavanje' : '⚠ Čuvanje nije uspelo');
    }
  }

  return (
    <div className="rounded-panel border border-line bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-control bg-surface-2 text-ink-secondary">
            <Database className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-ink">Noćni uvoz finansija iz BigBita (.mdb)</h3>
            <p className="text-xs text-ink-secondary">
              Svake noći prenosi glavnu knjigu, naloge i kontni plan iz BigBita u 4.0. Šifarnici
              (komitenti, predmeti, artikli) idu ODVOJENIM sync-om — ovaj prekidač ih ne dira.
            </p>
          </div>
        </div>
        <StatusBadge
          tone={q.isLoading ? 'neutral' : unknown ? 'danger' : enabled ? 'success' : 'warn'}
          label={
            q.isLoading ? 'Učitavanje…' : unknown ? 'Stanje nepoznato' : enabled ? 'Uključen' : 'Isključen'
          }
        />
      </div>

      {unknown && (
        <div className="mb-3 flex items-start gap-2 rounded-control border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-xs text-ink">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Stanje uvoza nije moglo da se pročita — <strong>ne oslanjajte se na prikazano</strong>.
            Ne zna se ni da li je uvoz uključen ni kada je poslednji put radio. Osvežite stranicu;
            ako se ponovi, javite IT.
          </span>
        </div>
      )}

      {/* Prekidač */}
      <label
        className={`flex items-start gap-2.5 rounded-control border px-3 py-2 ${
          enabled ? 'border-line bg-surface-2' : 'border-status-warn/40 bg-status-warn-bg'
        } ${mayToggle && !busy ? 'cursor-pointer' : 'cursor-default opacity-70'}`}
      >
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={enabled}
          disabled={!mayToggle || busy}
          onChange={(e) => void toggle(e.target.checked)}
          aria-label="Noćni uvoz iz BigBita je uključen"
        />
        <span className="flex flex-col">
          <span className="text-sm font-medium text-ink">Uvoz radi svake noći</span>
          <span className="text-xs text-ink-secondary">
            {mayToggle
              ? 'Skinite kvačicu da biste zaustavili uvoz. Važi od SLEDEĆEG pokretanja (restart nije potreban); uvoz koji je već u toku biće završen do kraja.'
              : 'Uključivanje i isključivanje je dozvoljeno samo administratoru sinhronizacije.'}
          </span>
        </span>
      </label>

      {mayToggle && (
        <div className="mt-3 max-w-md">
          <FormField
            label="Napomena"
            hint="Zašto je uvoz isključen — upisuje se uz sledeći preklop i vidi se ovde."
          >
            <Input
              value={note}
              maxLength={500}
              disabled={busy}
              placeholder="npr. BigBit je u održavanju do ponedeljka"
              onChange={(e) => setNote(e.target.value)}
            />
          </FormField>
        </div>
      )}

      {/* Upozorenja */}
      {!!s?.warnings.length && (
        <ul className="mt-3 space-y-2">
          {s.warnings.map((w: SyncWarning, i: number) => (
            <li
              key={i}
              className={`flex items-start gap-2 rounded-control border px-3 py-2 text-xs ${
                w.level === 'danger'
                  ? 'border-status-danger/40 bg-status-danger-bg text-ink'
                  : 'border-status-warn/40 bg-status-warn-bg text-ink'
              }`}
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{w.message}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Stanje poslednjeg uvoza */}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Fact
          label="Poslednji uspešan uvoz"
          value={s?.lastSuccessAt ? formatDateTime(s.lastSuccessAt) : 'Još nije bilo uvoza'}
          sub={s?.lastSuccessAt ? formatRelativeAge(s.lastSuccessAt) : 'čeka se prvi prolaz'}
        />
        <Fact
          label="Uvezeno redova"
          value={typeof s?.rowsImported === 'number' ? formatNumber(s.rowsImported) : '—'}
          sub={s?.lastRun?.summary ?? 'u poslednjem uspešnom uvozu'}
        />
        <Fact
          label="Izvorni fajl"
          value={s?.source?.fileName ?? '—'}
          sub={
            s?.source?.modifiedAt
              ? `${formatDateTime(s.source.modifiedAt)} · ${formatRelativeAge(s.source.modifiedAt)}`
              : 'BigBit ga ostavlja u drop folder'
          }
        />
      </div>

      <p className="mt-3 text-xs text-ink-disabled">
        {s?.updatedAt ? (
          <>
            Prekidač poslednji put menjan {formatDateTime(s.updatedAt)}
            {s.updatedByEmail ? ` · ${s.updatedByEmail}` : ''}
            {s.note ? ` · „${s.note}”` : ''}
          </>
        ) : (
          'Prekidač još nije menjan.'
        )}
        {q.isError && ' · Stanje uvoza trenutno nije dostupno.'}
      </p>
    </div>
  );
}

/** Jedna „činjenica" o uvozu (label / vrednost / dopuna) — bez KPI bojenja. */
function Fact({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-panel border border-line bg-surface-2 px-3 py-2">
      <div className="text-2xs uppercase text-ink-secondary">{label}</div>
      <div className="truncate text-sm font-semibold text-ink" title={value}>
        {value}
      </div>
      <div className="truncate text-xs text-ink-secondary" title={sub}>
        {sub}
      </div>
    </div>
  );
}

function syncStatusLabel(status: string): string {
  return { success: 'Uspešno', running: 'U toku', partial: 'Delimično', failed: 'Greška' }[status] ?? status;
}
function syncStatusTone(status: string): Tone {
  return ({ success: 'success', running: 'info', partial: 'warn', failed: 'danger' } as Record<string, Tone>)[status] ?? 'neutral';
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: Tone }) {
  const border =
    tone === 'success'
      ? 'border-status-success/40 bg-status-success-bg'
      : tone === 'warn'
        ? 'border-status-warn/40 bg-status-warn-bg'
        : tone === 'danger'
          ? 'border-status-danger/40 bg-status-danger-bg'
          : tone === 'info'
            ? 'border-status-info/40 bg-status-info-bg'
            : 'border-line bg-surface';
  return (
    <div className={`rounded-panel border px-3 py-2 ${border}`}>
      <div className="text-2xs uppercase text-ink-secondary">{label}</div>
      <div className="text-sm font-semibold text-ink">{value}</div>
      <div className="text-xs text-ink-secondary">{sub}</div>
    </div>
  );
}
