'use client';

// Roditeljski most `window.__SCADA_BRIDGE__` koji shim (u iframe-u, isti origin)
// zove sinhrono. Port 1.0 `installBridge` (src/ui/energetika-scada/index.js): shim
// preusmeri `/api/*` iz HMI ekrana na 2.0 API kroz ovaj most. Oblik odgovora je
// 1:1 sa 1.0 (kopirani ekrani ga čitaju bez izmene): getSnapshot vraća payload +
// `online`/`_stale`/`_ageMs`/`_updatedAt`; getAlarms vraća SNAKE_CASE redove
// (kot2.js čita `a.raised_at`/`a.active`); getHistory shape-uje long-format u
// {samples}/{tags,series}. sendCommand ide kroz zamrznuti komandni tok (R2 stub).

import { useEffect, useRef } from 'react';
import {
  cancelScadaCommand,
  fetchAlarmHistoryRows,
  fetchSiteHistoryFull,
  fetchSiteHistoryRows,
  fetchSnapshotRow,
  sendScadaCommandFlow,
} from '@/api/energetika';
import {
  COMMANDS_ENABLED,
  ageMs,
  isStale,
  type HistoryRow,
  type ScadaPayload,
} from '@/lib/scada';

interface HistoryParams {
  system?: string;
}

export interface ScadaBridge {
  getSnapshot: (siteKey: string) => Promise<ScadaPayload>;
  getHistory: (siteKey: string, params?: HistoryParams) => Promise<unknown>;
  getAlarms: (siteKey: string) => Promise<unknown[]>;
  sendCommand: (cmd: {
    siteKey: string;
    target: string;
    value?: Record<string, unknown> | null;
  }) => Promise<{ ok: boolean; error?: string }>;
  canControl: () => boolean;
}

declare global {
  interface Window {
    __SCADA_BRIDGE__?: ScadaBridge;
  }
}

interface KotTag {
  name: string;
  label?: string;
  kind?: string;
  zone?: string;
}
let kot1TagsCache: { tags: KotTag[]; zones: unknown[] } | null = null;
async function kot1Tags(): Promise<{ tags: KotTag[]; zones: unknown[] }> {
  if (kot1TagsCache) return kot1TagsCache;
  try {
    const r = await fetch('/scada-hmi/kot1-tags.json');
    const j = (await r.json()) as { tags?: KotTag[]; zones?: unknown[] };
    kot1TagsCache = { tags: j.tags || [], zones: j.zones || [] };
  } catch {
    kot1TagsCache = { tags: [], zones: [] };
  }
  return kot1TagsCache;
}

/** long-format redovi → {samples:[{t, <ključ>:v}]} po mapi metric→ključ. */
function toSamples(rows: HistoryRow[], keyFor: (m: string) => string | null | undefined) {
  const byTs = new Map<number, Record<string, number>>();
  for (const r of rows) {
    const k = keyFor(r.metric);
    if (!k) continue;
    const t = new Date(r.ts).getTime();
    const rec = byTs.get(t) || { t };
    if (r.value != null) rec[k] = r.value;
    byTs.set(t, rec);
  }
  return [...byTs.values()].sort((a, b) => a.t - b.t);
}

/** Port 1.0 buildHistory — BE već filtrira metrike po sistemu (spec §3). */
async function buildHistory(siteKey: string, params?: HistoryParams): Promise<unknown> {
  if (siteKey === 'kot1') {
    // Dinamički iz BE `meta.metrics`/`meta.series` (paritet 1.0 buildHistory) — bez
    // hardkodovanog spiska. Zone (za grupisanje na ekranu) obogaćujemo iz kot1-tags.json.
    const full = await fetchSiteHistoryFull('kot1', 24);
    if (full.metrics.length > 0) {
      const local = await kot1Tags();
      const zoneByName = new Map((local.tags || []).map((t) => [t.name, t.zone]));
      const tags = full.metrics.map((m) => ({
        name: m.key,
        label: m.label,
        kind: m.kind,
        zone: zoneByName.get(m.key),
      }));
      return { tags, series: full.series };
    }
    // Fallback (BE meta prazan — grane nisu spojene): lokalni kot1-tags.json + long-format.
    const local = await kot1Tags();
    const tags = (local.tags || [])
      .filter((t) => t.kind === 'temp' || t.kind === 'setpoint')
      .map((t) => ({ name: t.name, label: t.label, kind: t.kind, zone: t.zone }));
    const series: Record<string, { t: number; v: number | null }[]> = {};
    for (const r of full.rows) {
      (series[r.metric] ||= []).push({ t: new Date(r.ts).getTime(), v: r.value });
    }
    return { tags, series };
  }
  if (siteKey === 'kot2') {
    const rows = await fetchSiteHistoryRows('kot2', 24);
    return { samples: toSamples(rows, (m) => m) };
  }
  if (siteKey === 'kot3') {
    const rows = await fetchSiteHistoryRows('kot3', 24);
    return { samples: toSamples(rows, (m) => m) };
  }
  if (siteKey === 'solar-sigen') {
    const sys = params?.system || '';
    const prefix = `${sys}:`;
    const suffixMap: Record<string, string> = {
      pv: 'pv',
      load: 'lo',
      grid: 'gr',
      battery: 'ba',
      soc: 'soc',
    };
    const rows = await fetchSiteHistoryRows('solar-sigen', 24, sys);
    return {
      samples: toSamples(rows, (m) =>
        m.startsWith(prefix) ? suffixMap[m.slice(prefix.length)] : null,
      ),
    };
  }
  if (siteKey === 'solar-kaco') {
    const rows = await fetchSiteHistoryRows('solar-kaco', 24);
    const map: Record<string, string> = { pv: 'pv', grid: 'gr' };
    return { samples: toSamples(rows, (m) => map[m]) };
  }
  return { samples: [] };
}

/**
 * Instalira most na `window` dok je host montiran. `canControl` = ima li korisnik
 * `energetika.control` I da li je komandni tok uključen (COMMANDS_ENABLED) — dok je
 * R2 stub, vraća false pa kopirani HMI ekrani idu READ-ONLY (shim krije komande).
 */
export function useScadaBridge(hasControlPermission: boolean, onToast: (msg: string) => void) {
  const toastRef = useRef(onToast);
  toastRef.current = onToast;
  const canControl = hasControlPermission && COMMANDS_ENABLED;

  useEffect(() => {
    const bridge: ScadaBridge = {
      getSnapshot: async (siteKey) => {
        const row = await fetchSnapshotRow(siteKey);
        if (!row) return { online: false, _stale: true } as ScadaPayload;
        const p: ScadaPayload = { ...(row.payload || {}) };
        if (p.online === undefined) p.online = row.online === true;
        const age = ageMs(row.updatedAt);
        p._updatedAt = row.updatedAt || null;
        p._ageMs = Number.isFinite(age) ? Math.round(age) : null;
        // Bridge ne javlja → prikaz NE SME da izgleda živo (staleness relativan na server).
        if (isStale(row.updatedAt)) {
          p.online = false;
          p._stale = true;
        }
        return p;
      },
      getHistory: (siteKey, params) => buildHistory(siteKey, params),
      // meta o alarmima → SNAKE_CASE (kopirani ekrani čitaju a.raised_at/a.active/a.code).
      getAlarms: async (siteKey) => {
        const rows = await fetchAlarmHistoryRows(siteKey, 100);
        return rows.map((a) => ({
          id: a.id,
          site_key: a.siteKey,
          code: a.code,
          severity: a.severity,
          text: a.text,
          active: a.active,
          raised_at: a.raisedAt,
          cleared_at: a.clearedAt,
        }));
      },
      sendCommand: async ({ siteKey, target, value }) => {
        if (!canControl) return { ok: false, error: 'Nemate pravo slanja komandi' };
        const res = await sendScadaCommandFlow(
          { siteKey, target, value },
          { onToast: (m) => toastRef.current(m) },
        );
        return { ok: res.ok, error: res.error };
      },
      canControl: () => canControl,
    };
    window.__SCADA_BRIDGE__ = bridge;
    return () => {
      // Očisti da ne drži referencu posle napuštanja modula.
      try {
        delete window.__SCADA_BRIDGE__;
      } catch {
        window.__SCADA_BRIDGE__ = undefined;
      }
    };
  }, [canControl]);
}
