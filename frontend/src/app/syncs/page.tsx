'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Play, RefreshCw } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { useRunSync, useSyncLogs, type SyncLog } from '@/api/sync';
import {
  jeBigbitPosao,
  useRunJob,
  useSchedulerJobs,
  type JobRun,
  type ScheduledJob,
} from '@/api/scheduler';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { formatDateTime, formatDuration, formatNumber } from '@/lib/format';

/**
 * Sinhronizacije — šta se dovlači iz BigBita i kada.
 *
 * PRERAĐENO 05.08.2026 (zahtev vlasnika): ranije je ovaj ekran nudio SAMO stari QBigTehn
 * sync, a noćni uvoz iz BigBita — jedini kanal kojim danas stižu artikli, komitenti,
 * predmeti, glavna knjiga i robno — nije se mogao ni videti ni pokrenuti. Kad bi uvoz
 * zapeo, jedini izlaz je bio čekati sledeću noć. Zato noćni uvoz sada stoji na vrhu, sa
 * istorijom i dugmetom „Pokreni sada", a stari sync je sišao u sporedni deo (izvor mu je
 * zamrznut od 22.07.2026, ali ruta radi pa se ne uklanja).
 */

/** Status izvršenja → ton pilule (kanonska mapa, DESIGN_SYSTEM §7). */
function tonStatusa(status: string): Tone {
  const s = status.toUpperCase();
  if (s === 'DONE' || s === 'OK' || s === 'SUCCESS') return 'success';
  if (s === 'FAILED' || s === 'ERROR') return 'danger';
  if (s === 'RUNNING' || s === 'IN_PROGRESS') return 'info';
  if (s === 'SKIPPED') return 'neutral';
  return 'neutral';
}

/** Raspored u ljudskom obliku („svakog dana u 03:45"). */
function opisRasporeda(j: ScheduledJob): string {
  const s = j.schedule;
  if (s.kind === 'daily' && s.at) return `svakog dana u ${s.at}`;
  if (s.kind === 'interval' && s.everyMinutes) return `na svakih ${s.everyMinutes} min`;
  if (s.kind === 'weekly' && s.at) return `jednom nedeljno, u ${s.at}`;
  return s.kind;
}

function PoslednjeIzvrsenje({ run }: { run: JobRun | undefined }) {
  if (!run) return <span className="text-sm text-ink-disabled">još nije pokretano</span>;
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={tonStatusa(run.status)} label={run.status} />
        <span className="tnums text-xs text-ink-secondary">{formatDateTime(run.startedAt)}</span>
        <span className="tnums text-xs text-ink-disabled">
          {formatDuration(run.startedAt, run.finishedAt)}
        </span>
      </div>
      {run.error ? (
        <p className="break-words text-xs text-status-danger">{run.error}</p>
      ) : run.summary ? (
        <p className="break-words text-xs text-ink-secondary">{run.summary}</p>
      ) : null}
    </div>
  );
}

/** Jedan posao: šta radi, kada ide, kako je prošao poslednji put, i dugme. */
function KarticaPosla({
  job,
  onPokreni,
  pokrece,
}: {
  job: ScheduledJob;
  onPokreni: (key: string) => void;
  pokrece: boolean;
}) {
  const [istorija, setIstorija] = useState(false);
  const poslednje = job.lastRuns[0];

  return (
    <section className="rounded-panel border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-medium text-ink">{job.description}</h3>
          <p className="mt-0.5 text-xs text-ink-disabled">
            <span className="tnums">{job.key}</span> · {opisRasporeda(job)}
          </p>
        </div>
        <Can permission={PERMISSIONS.SCHEDULER_RUN}>
          <Button
            variant="secondary"
            onClick={() => onPokreni(job.key)}
            loading={pokrece}
            title="Pokreni posao odmah, ne čekajući raspored"
          >
            {!pokrece && <Play className="h-4 w-4" aria-hidden />}
            {pokrece ? 'U toku…' : 'Pokreni sada'}
          </Button>
        </Can>
      </div>

      <div className="mt-3 border-t border-line-soft pt-3">
        <PoslednjeIzvrsenje run={poslednje} />
      </div>

      {job.lastRuns.length > 1 && (
        <>
          <button
            type="button"
            onClick={() => setIstorija((v) => !v)}
            aria-expanded={istorija}
            className="mt-3 flex min-h-11 items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary sm:min-h-0"
          >
            <ChevronRight
              className={`h-4 w-4 shrink-0 transition-transform ${istorija ? 'rotate-90' : ''}`}
              aria-hidden
            />
            Ranija izvršenja ({job.lastRuns.length - 1})
          </button>
          {istorija && (
            <div className="mt-2 space-y-2 border-l-2 border-line-soft pl-3">
              {job.lastRuns.slice(1).map((r) => (
                <PoslednjeIzvrsenje key={r.startedAt} run={r} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ─────────────────────────────────────────── stari QBigTehn sync (sporedni deo)

const kolone: Column<SyncLog>[] = [
  { key: 'startedAt', header: 'Početak', render: (r) => formatDateTime(r.startedAt) },
  { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  {
    key: 'scope',
    header: 'Opseg',
    render: (r) => <span className="text-ink-secondary">{r.entityScope ?? '—'}</span>,
  },
  {
    key: 'upserted',
    header: 'Upisano',
    align: 'right',
    numeric: true,
    render: (r) => formatNumber(r.rowsUpserted),
  },
  {
    key: 'duration',
    header: 'Trajanje',
    align: 'right',
    numeric: true,
    render: (r) => (
      <span className="text-ink-secondary">{formatDuration(r.startedAt, r.finishedAt)}</span>
    ),
  },
  {
    key: 'trigger',
    header: 'Okidač',
    render: (r) => <span className="text-ink-secondary">{r.trigger}</span>,
  },
];

function RazradaPoEntitetima({ log }: { log: SyncLog }) {
  if (!log.metadata) return <span className="text-sm text-ink-disabled">Nema detalja.</span>;
  const entries = Object.entries(log.metadata).sort(
    (a, b) => (b[1].rowsUpserted ?? 0) - (a[1].rowsUpserted ?? 0),
  );
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3 md:grid-cols-4">
      {entries.map(([entity, m]) => (
        <div key={entity} className="flex justify-between gap-2 text-xs">
          <span className={m.error ? 'text-status-danger' : 'text-ink-secondary'}>{entity}</span>
          <span className="tnums text-ink">
            {m.error ? 'greška' : formatNumber(m.rowsUpserted ?? 0)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────── ekran

export default function SyncsPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();
  const logs = useSyncLogs();
  const runSync = useRunSync();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [stariOtvoren, setStariOtvoren] = useState(false);

  const smePoslove = can(PERMISSIONS.SCHEDULER_READ);
  const poslovi = useSchedulerJobs(smePoslove);
  const runJob = useRunJob();
  const [uToku, setUToku] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const rows = logs.data ?? [];
  const sviPoslovi = poslovi.data?.data.jobs ?? [];
  const bigbit = sviPoslovi.filter((j) => jeBigbitPosao(j.key));
  const ostali = sviPoslovi.filter((j) => !jeBigbitPosao(j.key));
  const pogonUgasen = poslovi.data?.data.enabled === false;

  function pokreni(key: string) {
    setUToku(key);
    runJob.mutate(key, { onSettled: () => setUToku(null) });
  }

  return (
    <AppShell>
      <PageHeader
        title="Sinhronizacije"
        count={bigbit.length ? `${bigbit.length} poslova` : undefined}
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        {pogonUgasen && (
          <div className="rounded-panel border border-status-warn/30 bg-status-warn-bg px-4 py-3 text-sm text-status-warn">
            Zakazani poslovi su <strong>isključeni na serveru</strong> — ništa neće krenuti samo
            od sebe. „Pokreni sada" i dalje radi.
          </div>
        )}

        {runJob.error && (
          <div className="rounded-panel border border-status-danger/30 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(runJob.error as Error).message}
          </div>
        )}

        {smePoslove ? (
          <section className="space-y-3">
            <h2 className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
              Uvoz iz BigBita
            </h2>
            <p className="text-sm text-ink-secondary">
              Ovim kanalom stižu <span className="font-medium text-ink">artikli, komitenti,
              predmeti, glavna knjiga i robno stanje</span>. Izvoz iz BigBita ide jednom dnevno,
              pa je uneto do 17:30 vidljivo sutra ujutru. Radni nalozi se ne sinhronizuju — oni
              se otvaraju u aplikaciji i vide se odmah.
            </p>

            {poslovi.isPending ? (
              <p className="text-sm text-ink-secondary">Učitavanje…</p>
            ) : bigbit.length === 0 ? (
              <EmptyState
                title="Nema registrovanih poslova uvoza"
                hint="Noćni uvoz je isključen prekidačem ili posao nije registrovan na serveru."
              />
            ) : (
              bigbit.map((j) => (
                <KarticaPosla
                  key={j.key}
                  job={j}
                  onPokreni={pokreni}
                  pokrece={uToku === j.key && runJob.isPending}
                />
              ))
            )}

            {ostali.length > 0 && (
              <details className="rounded-panel border border-line bg-surface-2 p-3">
                <summary className="cursor-pointer text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                  Ostali zakazani poslovi ({ostali.length})
                </summary>
                <div className="mt-3 space-y-3">
                  {ostali.map((j) => (
                    <KarticaPosla
                      key={j.key}
                      job={j}
                      onPokreni={pokreni}
                      pokrece={uToku === j.key && runJob.isPending}
                    />
                  ))}
                </div>
              </details>
            )}
          </section>
        ) : (
          <div className="rounded-panel border border-line bg-surface-2 px-4 py-3 text-sm text-ink-secondary">
            Za pregled zakazanih poslova treba pravo <span className="tnums">scheduler.read</span>.
          </div>
        )}

        {/* ── stari QBigTehn sync: izvor zamrznut 22.07.2026, ruta i dalje radi ── */}
        <details
          open={stariOtvoren}
          onToggle={(e) => setStariOtvoren((e.currentTarget as HTMLDetailsElement).open)}
          className="rounded-panel border border-line bg-surface p-4"
        >
          <summary className="cursor-pointer text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
            Stari QBigTehn sync ({formatNumber(rows.length)} zapisa)
          </summary>

          <div className="mt-3 space-y-3">
            <div className="space-y-1 rounded-panel border border-line bg-surface-2 px-4 py-3 text-sm text-ink-secondary">
              <p>
                Osvežava QBigTehn šifarnike (konfiguracija, registri, MRP…).{' '}
                <span className="font-medium text-ink">
                  Artikli, predmeti i komitenti su preskočeni
                </span>{' '}
                — njihov QBigTehn izvor je zamrznut od 22.07.2026, vozi ih uvoz iz BigBita gore.
              </p>
            </div>

            <Can permission={PERMISSIONS.SYNC_RUN}>
              <Button
                variant="secondary"
                onClick={() => runSync.mutate()}
                loading={runSync.isPending}
              >
                {!runSync.isPending && <RefreshCw className="h-4 w-4" aria-hidden />}
                {runSync.isPending ? 'Sinhronizacija u toku…' : 'Pokreni stari sync'}
              </Button>
            </Can>

            {(runSync.error || logs.error) && (
              <div className="rounded-panel border border-status-danger/30 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
                {(runSync.error as Error)?.message ??
                  (logs.error as Error)?.message ??
                  'Došlo je do greške.'}
              </div>
            )}

            <DataTable
              columns={kolone}
              rows={rows}
              rowKey={(r) => r.id}
              loading={logs.isLoading}
              onRowActivate={(r) => setExpanded((e) => (e === r.id ? null : r.id))}
              expandedKey={expanded}
              renderExpanded={(r) => <RazradaPoEntitetima log={r} />}
              empty={<EmptyState title="Još nema sinhronizacija" />}
            />
          </div>
        </details>
      </div>
    </AppShell>
  );
}
