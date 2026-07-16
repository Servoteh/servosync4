'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, Download, ChevronRight, FileDown, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Input } from '@/components/ui-kit/form-field';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { cn } from '@/lib/cn';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import {
  usePredmetIzvestaj,
  useUpsertNapomena,
  useUpsertOverride,
  normalizeIzvestaj,
  logExport,
  type IzvestajRow,
} from '@/api/pracenje';

const STATUS_OVR = [
  { v: '', label: 'Auto' },
  { v: 'u_radu', label: 'U radu' },
  { v: 'kompletirano', label: 'Kompletirano' },
  { v: 'nije_zapoceto', label: 'Nije započeto' },
];

function statusTone(row: IzvestajRow): Tone {
  const done = Number(row.kompletirano_za_lot ?? 0);
  const req = Number(row.required_for_lot ?? 0);
  if (row.status_override === 'kompletirano' || (req > 0 && done >= req)) return 'success';
  if (row.status_override === 'nije_zapoceto' || done === 0) return 'neutral';
  return 'info';
}

/** Ekran 2 — Tabela praćenja predmeta (stablo po level) + napomena/override (manage) + izvoz. */
export function PredmetView({
  itemId,
  rootRn,
  onBack,
  onOpenRnBigtehn,
}: {
  itemId: number;
  rootRn?: string;
  onBack: () => void;
  onOpenRnBigtehn: (bigtehnRnId: string) => void;
}) {
  const q = usePredmetIzvestaj(itemId, rootRn);
  const rows = useMemo(() => normalizeIzvestaj(q.data?.data), [q.data]);
  const napomena = useUpsertNapomena();
  const override = useUpsertOverride();
  const can = useCan();
  const canManage = can(PERMISSIONS.PRACENJE_MANAGE);
  const [expanded, setExpanded] = useState<string | null>(null);

  function exportCsv() {
    const head = ['Ident', 'Naziv', 'Crtež', 'Materijal', 'Lansirano', 'Završeno', 'Za lot', 'Kompletirano', 'Mašinska', 'Površinska'];
    const lines = rows.map((r) =>
      [
        r.ident_broj ?? '',
        r.naziv_pozicije ?? r.naziv_dela ?? '',
        r.broj_crteza ?? r.crtez_drawing_no ?? '',
        r.materijal ?? '',
        r.lansirana_kolicina ?? '',
        r.zavrsena_kolicina ?? '',
        r.required_for_lot ?? '',
        r.kompletirano_za_lot ?? '',
        r.masinska_done_override === true ? 'DA — ručno' : r.masinska_done_override === false ? 'NE — ručno' : daNeText(r.masinska_obrada_status),
        r.povrsinska_done_override === true ? 'DA — ručno' : r.povrsinska_done_override === false ? 'NE — ručno' : daNeText(r.povrsinska_zastita_status),
      ]
        .map((c) => `"${String(c).replace(/"/g, '""')}"`)
        .join(','),
    );
    const csv = [head.join(','), ...lines].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pracenje-predmet-${itemId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    logExport({ tab: 'tabela-pracenja', predmetItemId: itemId }).catch(() => {});
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Nazad
        </Button>
        <h2 className="text-md font-semibold text-ink">Predmet #{itemId}</h2>
        <span className="text-sm text-ink-secondary">{rows.length} pozicija</span>
        <Button variant="secondary" onClick={exportCsv} className="ml-auto">
          <Download className="h-4 w-4" /> Excel (CSV)
        </Button>
      </div>

      {q.isLoading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Učitavanje…</div>
      ) : rows.length === 0 ? (
        <EmptyState title="Nema podataka praćenja za predmet" />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="px-3 py-1.5">Pozicija</th>
                <th className="px-3 py-1.5">Crtež</th>
                <th className="px-3 py-1.5">Materijal</th>
                <th className="px-3 py-1.5">Za lot</th>
                <th className="px-3 py-1.5">Mašin.</th>
                <th className="px-3 py-1.5">Površ.</th>
                <th className="px-3 py-1.5">Status</th>
                <th className="px-3 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const node = String(r.node_id ?? '');
                const open = expanded === node;
                return (
                  <FragRow key={node}>
                    <tr className="border-b border-line-soft hover:bg-surface-2">
                      <td className="px-3 py-1.5" style={{ paddingLeft: 12 + Number(r.level ?? 0) * 16 }}>
                        <div className="font-medium text-ink">{r.naziv_pozicije ?? r.naziv_dela ?? '—'}</div>
                        <div className="text-xs text-ink-disabled">{r.ident_broj ?? ''}</div>
                      </td>
                      <td className="px-3 py-1.5 text-xs">{r.broj_crteza ?? r.crtez_drawing_no ?? '—'}</td>
                      <td className="px-3 py-1.5 text-xs">{r.materijal ?? '—'}</td>
                      <td className="tnums px-3 py-1.5 text-xs">
                        {r.kompletirano_za_lot ?? 0}/{r.required_for_lot ?? 0}
                      </td>
                      <td className="px-3 py-1.5 text-center text-xs">{daNe(r.masinska_obrada_status, r.masinska_done_override)}</td>
                      <td className="px-3 py-1.5 text-center text-xs">{daNe(r.povrsinska_zastita_status, r.povrsinska_done_override)}</td>
                      <td className="px-3 py-1.5">
                        <StatusBadge tone={statusTone(r)} label={r.status_override ? `⚑ ${r.status_override}` : autoLabel(r)} />
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <div className="inline-flex gap-1">
                          {r.rn_broj && (
                            <button
                              onClick={() => onOpenRnBigtehn(node)}
                              className="rounded-control p-1 text-ink-secondary hover:bg-surface-2"
                              title="Otvori RN"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            onClick={() => setExpanded(open ? null : node)}
                            className="rounded-control p-1 text-ink-secondary hover:bg-surface-2"
                            title="Napomena / override"
                          >
                            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-b border-line-soft bg-surface-2/50">
                        <td colSpan={8} className="px-4 py-3">
                          <RowEditor
                            row={r}
                            itemId={itemId}
                            canManage={canManage}
                            onNapomena={(note) =>
                              napomena.mutate({ itemId, bigtehnRnId: node, note, rnId: r.rn_id ?? undefined })
                            }
                            onOverride={(patch) =>
                              override.mutate({ itemId, bigtehnRnId: node, rnId: r.rn_id ?? undefined, ...patch })
                            }
                          />
                        </td>
                      </tr>
                    )}
                  </FragRow>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FragRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/**
 * DA/NE ćelija (1.0 daNeCell — tabelaPracenjaTab.js:82): BILO KOJI ne-prazan status
 * → „DA"; zeleno ako /urađeno|zavr|gotov|100/ i NE /nije|0\//, inače žuto DA;
 * pun tekst statusa u title tooltip. Ručni override gazi auto (⚑ oznaka).
 */
function daNe(auto: string | null | undefined, ovr: boolean | null | undefined): React.ReactNode {
  if (ovr === true || ovr === false) {
    return (
      <span className={ovr ? 'text-status-success' : 'text-ink-secondary'} title="Ručno postavljeno">
        {ovr ? 'DA' : 'NE'} ⚑
      </span>
    );
  }
  const s = String(auto ?? '').trim();
  if (!s || s === '—') return <span className="text-ink-secondary">NE</span>;
  const done = /urađeno|zavr|gotov|100/i.test(s) && !/nije|0\s*\//i.test(s);
  return (
    <span className={done ? 'text-status-success' : 'text-status-warn'} title={s}>
      DA
    </span>
  );
}

/** Izvozni tekst DA/NE (1.0 daNeText — pracenjeIzvestajExport.js:30): „DA — {pun status}". */
export function daNeText(statusStr: string | null | undefined): string {
  const s = String(statusStr ?? '').trim();
  if (!s || s === '—') return 'NE';
  return `DA — ${s}`;
}

function autoLabel(r: IzvestajRow): string {
  const done = Number(r.kompletirano_za_lot ?? 0);
  const req = Number(r.required_for_lot ?? 0);
  if (req > 0 && done >= req) return 'Kompletirano';
  if (done === 0) return 'Nije započeto';
  return 'U radu';
}

function RowEditor({
  row,
  itemId,
  canManage,
  onNapomena,
  onOverride,
}: {
  row: IzvestajRow;
  itemId: number;
  canManage: boolean;
  onNapomena: (note: string) => void;
  onOverride: (patch: { status?: string; masinska?: boolean; povrsinska?: boolean }) => void;
}) {
  void itemId;
  const [note, setNote] = useState(row.korisnicka_napomena ?? '');
  return (
    <div className="space-y-2">
      {row.sistemska_napomena && <p className="text-xs text-ink-secondary">Sistem: {row.sistemska_napomena}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-ink-secondary">Status override:</label>
        <select
          disabled={!canManage}
          value={row.status_override ?? ''}
          onChange={(e) => onOverride({ status: e.target.value })}
          className="h-8 rounded-control border border-line bg-surface px-2 text-sm text-ink"
        >
          {STATUS_OVR.map((o) => (
            <option key={o.v} value={o.v}>{o.label}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-ink">
          <input
            type="checkbox"
            disabled={!canManage}
            checked={row.masinska_done_override === true}
            onChange={(e) => onOverride({ masinska: e.target.checked })}
          />
          Mašinska gotova
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink">
          <input
            type="checkbox"
            disabled={!canManage}
            checked={row.povrsinska_done_override === true}
            onChange={(e) => onOverride({ povrsinska: e.target.checked })}
          />
          Površinska gotova
        </label>
      </div>
      <div className="flex items-center gap-2">
        <Input value={note} onChange={(e) => setNote(e.target.value)} disabled={!canManage} placeholder="Korisnička napomena…" className="h-8" />
        {canManage && (
          <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => onNapomena(note)}>
            <FileDown className="h-3.5 w-3.5" /> Sačuvaj
          </Button>
        )}
      </div>
    </div>
  );
}
