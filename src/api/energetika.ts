'use client';

// Energetika / SCADA — TanStack Query hooks + imperativni fetcheri (za most u
// iframe-u) + komandni tok. 3.0 TALAS E; ugovori: backend energetika.controller.ts
// (§3 API), MODULE_SPEC_scada_30.md. Poll obrazac (presuda E3) — bez SSE/WS. Read
// endpointi (GET) su R1 (stabilni, deploy-uju se); KOMANDE (POST) su R2 (u toku) —
// hook-ovi/fetcheri su tu, ali tok je ZAKLJUČAN dok COMMANDS_ENABLED ne postane true.

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';
import {
  COMMANDS_ENABLED,
  noteServerTime,
  type HistoryRow,
  type ScadaAlarm,
  type ScadaCommand,
  type ScadaSite,
  type ScadaSnapshotRow,
} from '@/lib/scada';

// Interval poll-a (spec §3 — aktivan tab 5–10 s; komanda 1.5 s do 15 s).
const SNAPSHOT_POLL_MS = 5_000;
const ALARM_POLL_MS = 10_000;
const COMMANDS_POLL_MS = 15_000;

interface Wrapped<T> {
  data: T;
}
interface SnapshotsResp {
  data: ScadaSnapshotRow[];
  meta?: { serverNow?: string };
}
interface SnapshotResp {
  data: ScadaSnapshotRow | null;
  meta?: { serverNow?: string };
}

const KEYS = {
  sites: ['energetika', 'sites'] as const,
  snapshots: ['energetika', 'snapshots'] as const,
  snapshot: ['energetika', 'snapshot'] as const,
  history: ['energetika', 'history'] as const,
  alarms: ['energetika', 'alarms'] as const,
  alarmHistory: ['energetika', 'alarm-history'] as const,
  commands: ['energetika', 'commands'] as const,
  command: ['energetika', 'command'] as const,
};

// ─────────────────────────────────────────────────────────────── read hooks

/** Svih 5 sistema (sort_order). Retko se menja → blaži poll. */
export function useScadaSites(enabled = true) {
  return useQuery({
    queryKey: KEYS.sites,
    enabled,
    refetchInterval: 60_000,
    queryFn: () => apiFetch<Wrapped<ScadaSite[]>>('/v1/energetika/sites').then((r) => r.data),
  });
}

/**
 * Najnovija stanja svih sistema (poll ~5 s). Uz svaki odgovor beleži server-vreme
 * (E4 `meta.serverNow` + svaki `updatedAt`) za clock-safe staleness.
 */
export function useScadaSnapshots(enabled = true) {
  return useQuery({
    queryKey: KEYS.snapshots,
    enabled,
    refetchInterval: SNAPSHOT_POLL_MS,
    queryFn: async () => {
      const r = await apiFetch<SnapshotsResp>('/v1/energetika/snapshots');
      noteServerTime(r.meta?.serverNow);
      for (const s of r.data) noteServerTime(s.updatedAt);
      return r;
    },
  });
}

/** Snapshot jednog sistema (poll ~5 s). */
export function useScadaSnapshot(siteKey: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.snapshot, siteKey],
    enabled: enabled && !!siteKey,
    refetchInterval: SNAPSHOT_POLL_MS,
    queryFn: async () => {
      const r = await apiFetch<SnapshotResp>(`/v1/energetika/snapshots/${siteKey}`);
      noteServerTime(r.meta?.serverNow);
      noteServerTime(r.data?.updatedAt);
      return r.data;
    },
  });
}

/** Trend jednog sistema (BE preset filtrira metrike; long-format redovi). */
export function useScadaHistory(siteKey: string | null, hours = 24, system?: string) {
  return useQuery({
    queryKey: [...KEYS.history, siteKey, hours, system],
    enabled: !!siteKey,
    queryFn: () => fetchSiteHistoryRows(siteKey as string, hours, system),
  });
}

/** Aktivni alarmi svih sistema (poll ~10 s). */
export function useActiveAlarms(enabled = true) {
  return useQuery({
    queryKey: KEYS.alarms,
    enabled,
    refetchInterval: ALARM_POLL_MS,
    queryFn: () =>
      apiFetch<Wrapped<ScadaAlarm[]>>('/v1/energetika/alarms').then((r) => r.data),
  });
}

/** Istorija alarma jednog sistema (aktivni + očišćeni). */
export function useAlarmHistory(siteKey: string | null, limit = 100) {
  return useQuery({
    queryKey: [...KEYS.alarmHistory, siteKey, limit],
    enabled: !!siteKey,
    queryFn: () => fetchAlarmHistoryRows(siteKey as string, limit),
  });
}

/** Poslednje komande (audit tab; poll ~15 s dok je tab otvoren). */
export function useRecentCommands(limit = 40, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.commands, limit],
    enabled,
    refetchInterval: COMMANDS_POLL_MS,
    queryFn: () =>
      apiFetch<Wrapped<ScadaCommand[]>>(`/v1/energetika/commands?limit=${limit}`).then(
        (r) => r.data,
      ),
  });
}

// ────────────────────────────────────────────── imperativni fetcheri (za most)
// Most `__SCADA_BRIDGE__` (u iframe hostu) i touch komandni tok zovu ih direktno
// (ne kroz hook — on-demand po skenu/klik/poll-u).

/** Snapshot red jednog sistema (paritet 1.0 fetchSnapshotRow). */
export async function fetchSnapshotRow(siteKey: string): Promise<ScadaSnapshotRow | null> {
  const r = await apiFetch<SnapshotResp>(`/v1/energetika/snapshots/${siteKey}`);
  noteServerTime(r.meta?.serverNow);
  noteServerTime(r.data?.updatedAt);
  return r.data;
}

/** Istorija (long-format) — BE već filtrira metrike po sistemu (spec §3). */
export async function fetchSiteHistoryRows(
  siteKey: string,
  hours = 24,
  system?: string,
): Promise<HistoryRow[]> {
  const q = new URLSearchParams({ hours: String(hours) });
  if (system) q.set('system', system);
  const r = await apiFetch<{ data: HistoryRow[] }>(
    `/v1/energetika/history/${siteKey}?${q.toString()}`,
  );
  return r.data;
}

/** Istorija alarma jednog sistema (paritet 1.0 fetchAlarmHistory → /api/alarmmeta). */
export async function fetchAlarmHistoryRows(
  siteKey: string,
  limit = 100,
): Promise<ScadaAlarm[]> {
  const r = await apiFetch<Wrapped<ScadaAlarm[]>>(
    `/v1/energetika/alarms/${siteKey}?limit=${limit}`,
  );
  return r.data;
}

// ───────────────────────────────────────────────── KOMANDE (R2 — ZAKLJUČANO)
// Fetcheri postoje po ugovoru spec §3 (SendCommandDto: siteKey/target/op?/value?/
// clientEventId?). Tok se AKTIVIRA tek kad COMMANDS_ENABLED postane true (E R2 živ).
// Semantika je ZAMRZNUTA — FE samo šalje (insert → poll → cancel-on-timeout), ne
// menja tok. TODO(E R2): potvrditi tačan omotač POST odgovora (raw red vs {data}).

export interface SendCommandVars {
  siteKey: string;
  target: string;
  value?: Record<string, unknown> | null;
  op?: string;
  /** Idempotency ključ (1.0 `ui-<ts>-<rand>`); izostavljen → BE generiše svoj. */
  clientEventId?: string;
}

export interface SendCommandResult {
  ok: boolean;
  error?: string;
  status?: string;
}

/** INSERT `scada_commands` (pending) — POST /energetika/commands. R2. */
export async function insertScadaCommand(vars: SendCommandVars): Promise<ScadaCommand> {
  // TODO(E R2): kontroler vraća kreiran red; ako se uvede globalni {data} omotač,
  // prilagoditi ovde. Do tada: raw ScadaCommand po pročitanom service.create.
  return apiFetch<ScadaCommand>('/v1/energetika/commands', {
    method: 'POST',
    body: JSON.stringify({
      siteKey: vars.siteKey,
      target: vars.target,
      op: vars.op,
      value: vars.value ?? undefined,
      clientEventId: vars.clientEventId,
    }),
  });
}

/** Status jedne komande (poll posle slanja) — GET /energetika/commands/:id. R1. */
export async function fetchScadaCommand(id: string): Promise<ScadaCommand | null> {
  const r = await apiFetch<{ data: ScadaCommand | null }>(`/v1/energetika/commands/${id}`);
  return r.data;
}

/** Otkaži SVOJU pending komandu — POST /energetika/commands/:id/cancel → {status}. R2. */
export async function cancelScadaCommand(id: string): Promise<string> {
  const r = await apiFetch<{ status: string }>(`/v1/energetika/commands/${id}/cancel`, {
    method: 'POST',
  });
  return r.status;
}

const FINAL_STATUSES = new Set(['applied', 'failed', 'rejected', 'expired']);
const CMD_POLL_MS = 1_500;
const CMD_WAIT_MS = 15_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Komandni TOK (paritet 1.0 sendCommand/runCommand — ZAMRZNUTA semantika):
 * insert → toast → poll statusa (1.5 s) do konačnog ishoda → posle 15 s bez ishoda
 * `cancel` (da bridge ne izvrši naknadno) → vrati STVARNI status. FE samo šalje.
 *
 * ⚠ R3 STUB: dok COMMANDS_ENABLED=false (E R2 nije deploy-ovan) kratko spaja sa
 * jasnom porukom — nikad ne dira PLC. Aktivacija = flip konstante u lib/scada.ts.
 *
 * @param onToast opcioni feedback (touch ima svoj toast; desktop most prosleđuje).
 * @param shouldContinue opcioni „ekran još živ?" — na teardown fire-and-forget cancel
 *   (paritet 1.0: napuštanje ekrana u toku komande takođe otkazuje).
 */
export async function sendScadaCommandFlow(
  vars: SendCommandVars,
  opts: { onToast?: (msg: string) => void; shouldContinue?: () => boolean } = {},
): Promise<SendCommandResult> {
  const { onToast, shouldContinue } = opts;
  if (!COMMANDS_ENABLED) {
    const msg = 'Komandni tok se aktivira uz E R2 (backend u toku).';
    onToast?.(`⏳ ${msg}`);
    return { ok: false, error: msg };
  }

  let row: ScadaCommand;
  try {
    row = await insertScadaCommand(vars);
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || String(e) };
  }
  onToast?.('📤 Komanda poslata — čekam potvrdu bridge-a…');

  const started = Date.now();
  while (Date.now() - started < CMD_WAIT_MS) {
    if (shouldContinue && !shouldContinue()) break;
    await sleep(CMD_POLL_MS);
    if (shouldContinue && !shouldContinue()) break;
    let cmd: ScadaCommand | null = null;
    try {
      cmd = await fetchScadaCommand(row.id);
    } catch {
      /* prolazna mreža — probaj opet */
    }
    if (cmd && FINAL_STATUSES.has(cmd.status)) {
      if (cmd.status === 'applied') return { ok: true, status: 'applied' };
      const err = cmd.result?.error || `komanda: ${cmd.status}`;
      return { ok: false, error: err, status: cmd.status };
    }
  }

  // Teardown u toku komande → fire-and-forget cancel (ne ostavljamo pending do TTL-a).
  if (shouldContinue && !shouldContinue()) {
    void cancelScadaCommand(row.id).catch(() => {});
    return { ok: false, error: 'prekinuto' };
  }

  // Timeout → OTKAŽI da bridge ne izvrši zastarelu komandu; cancel vraća STVARNI status.
  let st: string | null = null;
  try {
    st = await cancelScadaCommand(row.id);
  } catch {
    /* mreža */
  }
  if (st === 'applied') return { ok: true, status: 'applied' };
  if (st === 'expired') {
    return {
      ok: false,
      status: 'expired',
      error: 'Bridge se nije javio — komanda je OTKAZANA (nije izvršena).',
    };
  }
  return {
    ok: false,
    status: st || undefined,
    error: `Bridge se nije javio na vreme (status: ${st || 'nepoznat'}) — proveri tab Komande.`,
  };
}
