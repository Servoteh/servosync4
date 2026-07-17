'use client';

import { useState } from 'react';
import { Play, Power, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { formatDateTime, formatRelativeAge } from '@/lib/format';
import {
  useSyncArm,
  useSyncOutbound,
  useSyncRunNow,
  useSyncStatus,
  type IngestByAction,
  type IngestHeartbeat,
  type IngestSample,
  type SyncOutboundRow,
} from '@/api/lokacije';

/**
 * Sync tab (admin) — BigTehn ingest worker + MSSQL outbound queue.
 * Paritet 1.0 renderSyncTab / renderBigtehnIngestPanelHtml (index.js:2167-2453):
 * status badge (ARMED/DRY-RUN) + heartbeat, stat kartice, by_action pilule,
 * sample-ovi (≤25 iz `last_run_summary.samples`), i outbound tabela
 * (Status/Movement ID/Kreirano/Greška). Zamenjuje raniji sirov JSON <pre> (L-20/L-21).
 */
export function SyncTab() {
  const status = useSyncStatus();
  const outbound = useSyncOutbound(100);
  const arm = useSyncArm();
  const runNow = useSyncRunNow();
  const [msg, setMsg] = useState<string | null>(null);

  const data = status.data?.data;
  const ingest = data?.ingest ?? {};
  // Ingest heartbeat je zaseban field (`data.heartbeat`), NE worker-health (`data.health`).
  const heartbeat = data?.heartbeat ?? {};
  const armed = ingest.armed === true || ingest.is_armed === true;
  const ingestError = ingest.ok === false ? String(ingest.error ?? 'unknown') : null;

  const summary = ingest.last_run_summary ?? {};
  const byAction: IngestByAction = summary.by_action ?? {};
  const samples: IngestSample[] = Array.isArray(summary.samples) ? summary.samples : [];

  const lastRun = ingest.last_run_at ? formatRelativeAge(ingest.last_run_at) : '—';
  const watermark = ingest.watermark != null ? String(ingest.watermark) : '0';
  const processedTotal = summary.processed_total != null ? String(summary.processed_total) : '0';
  const armedExecuted = byAction.armed_executed != null ? String(byAction.armed_executed) : '0';
  const armedErrors = Number(byAction.armed_errors ?? 0);
  const parserFallback = Number(byAction.parser_fallback ?? 0);

  async function doArm(next: boolean) {
    setMsg(null);
    try {
      await arm.mutateAsync(next);
      setMsg(next ? 'Worker je AKTIVIRAN (armed=TRUE).' : 'Worker je vraćen u dry-run (armed=FALSE).');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Greška.');
    }
  }

  async function doRun() {
    setMsg(null);
    try {
      await runNow.mutateAsync();
      setMsg('Ručno okidanje ingest-a poslato.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Greška.');
    }
  }

  const armConfirm = armed
    ? 'Sigurno da gasiš worker? Auto-generisanje TRANSFER pokreta će prestati.'
    : 'Sigurno da aktiviraš worker? Od ovog trenutka će automatski praviti TRANSFER pokrete iz BigTehn prijava.';

  return (
    <div className="space-y-4">
      {/* ── BigTehn ingest worker panel ── */}
      <div className="rounded-panel border border-line bg-surface p-3.5">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h3 className="text-md font-semibold text-ink">BigTehn ingest worker</h3>
          {!ingestError && (
            <StatusBadge
              tone={armed ? 'success' : 'warn'}
              label={armed ? 'ARMED — auto TRANSFER aktivan' : 'DRY-RUN — samo loguje'}
            />
          )}
          <HeartbeatDot heartbeat={heartbeat} />
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={() => void status.refetch()} title="Osveži status worker-a">
              <RefreshCw className="h-4 w-4" /> Osveži
            </Button>
            <Button
              loading={runNow.isPending}
              variant="secondary"
              onClick={() => void doRun()}
              title="Ručno pokreni worker odmah (umesto da čekaš 5-min pg_cron)"
            >
              <Play className="h-4 w-4" /> Pokreni sada
            </Button>
            <Button
              loading={arm.isPending}
              variant={armed ? 'secondary' : 'primary'}
              onClick={() => {
                if (window.confirm(armConfirm)) void doArm(!armed);
              }}
            >
              <Power className="h-4 w-4" />
              {armed ? 'DISARM (vrati u dry-run)' : 'ARM (aktiviraj auto TRANSFER)'}
            </Button>
          </div>
        </div>

        {ingestError ? (
          <IngestErrorNotice code={ingestError} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatCard label="Poslednje pokretanje" value={lastRun} />
              <StatCard label="Watermark (signal id)" value={watermark} />
              <StatCard label="Obrađeno u poslednjem run-u" value={processedTotal} />
              <StatCard
                label="Armed executed / errors"
                value={
                  <>
                    {armedExecuted}{' '}
                    <span className={`text-xs ${armedErrors > 0 ? 'text-status-danger' : 'text-ink-secondary'}`}>
                      / {armedErrors}
                    </span>
                  </>
                }
              />
            </div>

            <div className="mt-3">
              <div className="mb-1.5 text-xs text-ink-secondary">Klasifikacija prijava (by_action):</div>
              <ByActionPills byAction={byAction} />
              {parserFallback > 0 && (
                <p className="mt-1.5 text-xs text-status-warn">
                  Parser fallback: {parserFallback} ident-i nisu mečovali aktivan predmet u keš-u (split 1 / split 2 fallback). Pogledaj sample-ove dole.
                </p>
              )}
            </div>

            <div className="mt-4">
              <div className="mb-1.5 flex items-center justify-between">
                <strong className="text-sm text-ink">Sample-ovi iz poslednjeg run-a (do 25)</strong>
                <span className="text-2xs text-ink-disabled">
                  izvor: <code>loc_bigtehn_ingest_state.last_run_summary.samples</code>
                </span>
              </div>
              <SamplesTable samples={samples} />
            </div>
          </>
        )}
        {msg && <p className="mt-2 text-sm text-ink-secondary">{msg}</p>}
      </div>

      {/* ── Poslednji bridge sync (po jobu) ── */}
      <Panel title="Poslednji bridge sync (po jobu)">
        {(data?.bridge ?? []).length === 0 ? (
          <p className="text-sm text-ink-secondary">Nema zapisa.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-2xs uppercase tracking-wider text-ink-secondary">
                  <th className="py-1.5">Job</th>
                  <th>Status</th>
                  <th>Poslednji završetak</th>
                </tr>
              </thead>
              <tbody>
                {(data?.bridge ?? []).map((b) => (
                  <tr key={b.sync_job} className="border-b border-line-soft">
                    <td className="py-1.5">{b.sync_job}</td>
                    <td>
                      <StatusBadge status={b.status ?? 'unknown'} />
                    </td>
                    <td className="tnums text-ink-secondary">{formatDateTime(b.last_finished)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* ── Outbound queue (MSSQL write-back) ── */}
      <Panel title={`Outbound sync (MSSQL write-back) — ${outbound.data?.data.length ?? 0}`}>
        <p className="mb-2 text-xs text-ink-secondary">
          Redovi čekaju Node worker na infrastrukturi (MSSQL write-back).
        </p>
        <OutboundTable
          rows={outbound.data?.data ?? []}
          isLoading={outbound.isLoading}
          isError={outbound.isError}
        />
      </Panel>
    </div>
  );
}

// ── Podkomponente ───────────────────────────────────────────────────────────

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-panel border border-line bg-surface p-3.5">
      <div className="mb-2 text-md font-semibold text-ink">{title}</div>
      {children}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-control border border-line-soft bg-surface-2 px-3 py-2">
      <div className="text-2xs uppercase tracking-wide text-ink-secondary">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-ink tnums">{value}</div>
    </div>
  );
}

/**
 * Heartbeat indikator: tačka + „pre N min" (paritet 1.0 hbDot, index.js:2241).
 * Čita INGEST heartbeat (`data.heartbeat`), ne worker-health summary. Prazan `{}`
 * (BE još nije spojio rutu / nema pulsa) → „heartbeat: —" kao 1.0 `if (!hb)`.
 */
function HeartbeatDot({ heartbeat }: { heartbeat: IngestHeartbeat }) {
  if (heartbeat.age_seconds == null && heartbeat.is_alive == null) {
    return <span className="text-xs text-ink-secondary">heartbeat: —</span>;
  }
  const ageMin = Math.max(0, Math.round(Number(heartbeat.age_seconds ?? 0) / 60));
  const alive = heartbeat.is_alive === true;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-secondary">
      <span
        className={`h-2 w-2 rounded-full ${alive ? 'bg-status-success' : 'bg-status-danger'}`}
        aria-hidden
      />
      heartbeat pre {ageMin} min {alive ? '' : '(WORKER NE RADI)'}
    </span>
  );
}

/** Poruka kad DB stanje worker-a nije dostupno (paritet 1.0 statusRes.ok===false). */
function IngestErrorNotice({ code }: { code: string }) {
  const hint =
    code === 'state_missing'
      ? ' Primeni migraciju add_loc_phase2a_bigtehn_ingest_dryrun.sql.'
      : code === 'not_admin'
        ? ' Samo administratori vide ovaj panel.'
        : '';
  return (
    <p className="text-sm text-status-warn">
      Status worker-a: <code>{code}</code>.{hint}
    </p>
  );
}

// by_action redosled + labele (paritet 1.0 renderByActionPillsHtml order).
const BY_ACTION_ORDER: { key: string; label: string; tone: Tone }[] = [
  { key: 'initial_placement', label: 'initial', tone: 'info' },
  { key: 'chain_transfer', label: 'chain', tone: 'info' },
  { key: 'shelf_transfer', label: 'shelf→m', tone: 'info' },
  { key: 'skip_already', label: 'skip:tu', tone: 'neutral' },
  { key: 'skip_zero_qty', label: 'skip:qty=0', tone: 'neutral' },
  { key: 'skip_bad_ident', label: 'skip:ident', tone: 'neutral' },
  { key: 'no_machine_loc', label: 'no loc', tone: 'neutral' },
  { key: 'no_rn_in_cache', label: 'no RN', tone: 'neutral' },
  { key: 'too_old', label: 'staro', tone: 'neutral' },
  { key: 'armed_executed', label: 'exec', tone: 'success' },
  { key: 'armed_errors', label: 'errors', tone: 'danger' },
  { key: 'parser_fallback', label: 'fb parser', tone: 'warn' },
];

function ByActionPills({ byAction }: { byAction: IngestByAction }) {
  const pills = BY_ACTION_ORDER.map((o) => ({ ...o, v: Number(byAction[o.key] ?? 0) })).filter(
    (o) => o.v > 0,
  );
  if (pills.length === 0) {
    return <span className="text-sm text-ink-secondary">— bez podataka, worker još nije pokrenut —</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {pills.map((p) => (
        <span key={p.key} className="inline-flex items-center gap-1 text-xs">
          <StatusBadge tone={p.tone} label={`${p.label}: ${p.v}`} />
        </span>
      ))}
    </div>
  );
}

/** Ton pilule po akciji sample-a (paritet 1.0 actionPill). */
function sampleActionTone(action: string): Tone {
  if (action === 'initial_placement' || action === 'chain_transfer' || action === 'shelf_transfer') return 'info';
  if (action.startsWith('skip_')) return 'neutral';
  if (action === 'no_machine_loc' || action === 'no_rn_in_cache' || action === 'too_old') return 'danger';
  return 'neutral';
}
function sampleActionLabel(action: string): string {
  if (action === 'initial_placement') return 'initial';
  if (action === 'chain_transfer') return 'chain';
  if (action === 'shelf_transfer') return 'shelf→m';
  if (action === 'skip_already_there') return 'skip: već tu';
  return action || '—';
}

function SamplesTable({ samples }: { samples: IngestSample[] }) {
  if (samples.length === 0) {
    return (
      <div className="rounded-control border border-line-soft bg-surface-2 px-3 py-2 text-sm text-ink-secondary">
        Nema sample-ova — worker još nije pokrenut, ili nije bilo novih prijava od poslednjeg watermark-a.
      </div>
    );
  }
  return (
    <div className="max-h-96 overflow-auto rounded-control border border-line-soft">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-surface-2">
          <tr className="border-b border-line text-left text-2xs uppercase tracking-wide text-ink-secondary">
            <th className="px-2 py-1.5">Sig #</th>
            <th className="px-2 py-1.5">Ident → predmet / tp</th>
            <th className="px-2 py-1.5">Op</th>
            <th className="px-2 py-1.5">Mašina</th>
            <th className="px-2 py-1.5">Trenutna lok.</th>
            <th className="px-2 py-1.5 text-right">Qty</th>
            <th className="px-2 py-1.5">Akcija</th>
            <th className="px-2 py-1.5">Prijavljeno</th>
          </tr>
        </thead>
        <tbody>
          {samples.map((s, i) => {
            const action = String(s.action ?? '');
            return (
              <tr key={`${s.signal_id ?? i}-${i}`} className="border-b border-line-soft align-top">
                <td className="px-2 py-1.5 tnums text-ink-secondary">{s.signal_id != null ? String(s.signal_id) : ''}</td>
                <td className="px-2 py-1.5">
                  <span className="text-ink">{s.ident ?? ''}</span>
                  {s.parser_fallback && <span className="ml-1 text-status-warn" title="parser fallback">⚠fb</span>}
                  <br />
                  <span className="text-2xs text-ink-secondary">
                    {(s.predmet ?? '') || '—'} / {(s.tp ?? '') || '—'}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-ink-secondary">{s.op ?? ''}</td>
                <td className="px-2 py-1.5 text-ink-secondary">{s.machine ?? ''}</td>
                <td className="px-2 py-1.5">
                  {s.from_loc ? (
                    <>
                      <span className="text-ink">{String(s.from_loc)}</span>
                      {s.from_type && (
                        <>
                          <br />
                          <span className="text-2xs text-ink-secondary">{String(s.from_type)}</span>
                        </>
                      )}
                    </>
                  ) : (
                    <span className="text-ink-disabled">—</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right">
                  {s.transfer_qty != null ? (
                    <>
                      <strong className="text-ink tnums">{String(s.transfer_qty)}</strong>
                      {s.rn_total != null && <span className="text-ink-secondary tnums"> / {String(s.rn_total)}</span>}
                    </>
                  ) : (
                    <span className="text-ink-disabled">—</span>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex flex-wrap items-center gap-1">
                    <StatusBadge tone={sampleActionTone(action)} label={sampleActionLabel(action)} />
                    {s.armed_executed === true && <StatusBadge tone="success" label="✓" />}
                  </div>
                  {s.armed_error && (
                    <div className="mt-0.5 text-2xs text-status-danger">{String(s.armed_error).slice(0, 80)}</div>
                  )}
                </td>
                <td className="px-2 py-1.5 text-2xs text-ink-secondary">
                  {s.started_at ? formatRelativeAge(s.started_at) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Status outbound reda → ton pilule. */
function outboundTone(status: string): Tone {
  const s = status.toLowerCase();
  if (s === 'sent' || s === 'done' || s === 'success') return 'success';
  if (s === 'pending' || s === 'queued') return 'info';
  if (s === 'retry' || s === 'partial') return 'warn';
  if (s === 'failed' || s === 'dead_letter' || s === 'error') return 'danger';
  return 'neutral';
}

function OutboundTable({
  rows,
  isLoading,
  isError,
}: {
  rows: SyncOutboundRow[];
  isLoading: boolean;
  isError: boolean;
}) {
  if (isLoading) return <p className="text-sm text-ink-secondary">Učitavanje…</p>;
  if (isError)
    return <p className="text-sm text-status-warn">Nema pristupa ili tabela nije kreirana.</p>;
  if (rows.length === 0) return <p className="text-sm text-ink-secondary">Nema događaja.</p>;
  return (
    <div className="max-h-96 overflow-auto rounded-control border border-line-soft">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-surface-2">
          <tr className="border-b border-line text-left text-2xs uppercase tracking-wide text-ink-secondary">
            <th className="px-2 py-1.5">Status</th>
            <th className="px-2 py-1.5">Movement ID</th>
            <th className="px-2 py-1.5">Kreirano</th>
            <th className="px-2 py-1.5">Greška</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.source_record_id ?? i}-${i}`} className="border-b border-line-soft">
              <td className="px-2 py-1.5">
                <StatusBadge tone={outboundTone(String(r.status ?? ''))} label={String(r.status ?? '—')} />
              </td>
              <td className="px-2 py-1.5 font-mono text-xs text-ink-secondary">
                {r.source_record_id ? `${String(r.source_record_id).slice(0, 8)}…` : '—'}
              </td>
              <td className="px-2 py-1.5 tnums text-ink-secondary">{formatDateTime(r.created_at)}</td>
              <td className="px-2 py-1.5 text-xs text-status-danger">
                {r.last_error ? String(r.last_error).slice(0, 120) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
