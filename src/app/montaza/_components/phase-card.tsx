'use client';

// Plan montaže — mobilna kartica faze (increment 7, paritet 1.0 mobileCards.js).
// Prikazuje se na uskim ekranima (< lg) umesto guste 23-kolone tabele. Koristi ISTE
// handlere kao desktop red (onField/onCheck/onToggleType/onPerson/onMove/onDelete/…).
// Ovde živi i DrawingChip (klikabilni chip povezanog crteža → signed URL PDF-a) koji
// desktop red (plan-tab) uvozi — plan-tab već uvozi PhaseCard pa je smer bez ciklusa.

import { useState } from 'react';
import { ChevronUp, ChevronDown, Trash2, FileText, Link2, Loader2, Pencil, Check } from 'lucide-react';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { cn } from '@/lib/cn';
import { fetchDrawingSignedUrl, type PhaseVM } from '@/api/plan-montaze';
import { STATUSES, CHECK_SHORT, CHECK_LABELS } from '@/lib/plan-montaze/constants';
import { calcDuration } from '@/lib/plan-montaze/date';
import { calcReadiness, calcRisk, riskTone, RISK_LABEL, locationColor } from '@/lib/plan-montaze/phase';

/**
 * Chip povezanog crteža (paritet 1.0 planTable.js „phase-linked-chip"): klik dohvata
 * signed URL i otvara PDF u novom tabu. Vidljiv i vieweru — BE gate presuđuje pristup.
 * Greška → tiho u konzolu + kratko crveno stanje na chipu.
 */
export function DrawingChip({ code }: { code: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function openPdf() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetchDrawingSignedUrl(code);
      const url = res.data?.url;
      if (!url) throw new Error('Prazan signed URL');
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      console.error('[montaza] Otvaranje PDF-a crteža nije uspelo:', code, e);
      setFailed(true);
      window.setTimeout(() => setFailed(false), 2500);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={openPdf}
      disabled={busy}
      title={failed ? 'Otvaranje PDF-a nije uspelo' : 'Otvori PDF crteža'}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-control border px-1 py-0.5 text-2xs hover:bg-surface-2 disabled:opacity-60',
        failed ? 'border-status-danger/60 text-status-danger' : 'border-line text-accent',
      )}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <FileText className="h-3 w-3" aria-hidden />}
      <span className="tnums">{code}</span>
    </button>
  );
}

interface Props {
  p: PhaseVM;
  displayNo: number;
  canEdit: boolean;
  engineers: string[];
  leads: string[];
  locations: string[];
  onField: (id: string, field: keyof PhaseVM, value: unknown) => void;
  onCheck: (id: string, ci: number, next: boolean) => void;
  onToggleType: (id: string) => void;
  onPerson: (id: string, field: 'responsibleEngineer' | 'montageLead', value: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onDelete: (id: string) => void;
  onOpenDesc: (id: string) => void;
  onOpenDrawings: (id: string) => void;
}

const field = 'h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink disabled:opacity-60';

export function PhaseCard({
  p,
  displayNo,
  canEdit,
  engineers,
  leads,
  locations,
  onField,
  onCheck,
  onToggleType,
  onPerson,
  onMove,
  onDelete,
  onOpenDesc,
  onOpenDrawings,
}: Props) {
  const dis = !canEdit;
  const dur = calcDuration(p.startDate, p.endDate);
  const rd = calcReadiness(p);
  const rk = calcRisk(p);
  const color = locationColor(p.location);

  // % slider: tokom prevlačenja SAMO lokalni preview; commit (business rules + save)
  // tek na otpuštanje (paritet 1.0 — pravila se ne primenjuju usred prevlačenja).
  const [pctPreview, setPctPreview] = useState<number | null>(null);
  const commitPct = () => {
    if (pctPreview != null && pctPreview !== p.pct) onField(p.id, 'pct', pctPreview);
    setPctPreview(null);
  };

  return (
    <div className="rounded-panel border border-line bg-surface p-3" style={{ borderLeft: `3px solid ${color}` }}>
      {/* Header: # + naziv + tip + brisanje */}
      <div className="flex items-start gap-2">
        <span className="tnums mt-2 text-xs text-ink-secondary">{displayNo}</span>
        <input
          value={p.phaseName}
          disabled={dis}
          onChange={(e) => onField(p.id, 'phaseName', e.target.value)}
          className={cn(field, 'flex-1 font-medium')}
          placeholder="Naziv faze"
        />
        <button
          type="button"
          disabled={dis}
          onClick={() => onToggleType(p.id)}
          className={cn(
            'mt-0.5 rounded-control px-2 py-1.5 text-2xs font-semibold',
            p.phaseType === 'electrical' ? 'bg-status-info-bg text-status-info' : 'bg-surface-2 text-ink-secondary',
          )}
        >
          {p.phaseType === 'electrical' ? 'E' : 'M'}
        </button>
        <button type="button" disabled={dis} onClick={() => onDelete(p.id)} className="mt-0.5 rounded-control p-1.5 text-status-danger hover:bg-status-danger-bg disabled:opacity-40">
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {/* Status + % */}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="text-2xs text-ink-secondary">
          Status
          <select value={p.status} disabled={dis} onChange={(e) => onField(p.id, 'status', parseInt(e.target.value, 10))} className={field}>
            {STATUSES.map((s, si) => (
              <option key={s} value={si}>{s}</option>
            ))}
          </select>
        </label>
        <label className="text-2xs text-ink-secondary">
          Napredak: {pctPreview ?? p.pct}%
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={pctPreview ?? p.pct}
            disabled={dis}
            onChange={(e) => setPctPreview(parseInt(e.target.value, 10))}
            onPointerUp={commitPct}
            onKeyUp={commitPct}
            onBlur={commitPct}
            className="mt-2 w-full"
          />
        </label>
      </div>

      {/* Datumi */}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="text-2xs text-ink-secondary">
          Početak
          <input type="date" value={p.startDate} disabled={dis} onChange={(e) => onField(p.id, 'startDate', e.target.value)} className={cn(field, dur === -1 && 'border-status-danger')} />
        </label>
        <label className="text-2xs text-ink-secondary">
          Kraj {dur != null && dur >= 0 ? `· ${dur} d` : dur === -1 ? '· kraj pre početka' : ''}
          <input type="date" value={p.endDate} disabled={dis} onChange={(e) => onField(p.id, 'endDate', e.target.value)} className={cn(field, dur === -1 && 'border-status-danger')} />
        </label>
      </div>

      {/* Lokacija + ljudi */}
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-2xs text-ink-secondary">
          Lokacija
          <select value={p.location} disabled={dis} onChange={(e) => onField(p.id, 'location', e.target.value)} className={field}>
            {!locations.includes(p.location) && <option value={p.location}>{p.location || '—'}</option>}
            {locations.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </label>
        <label className="text-2xs text-ink-secondary">
          Inženjer
          <select value={engineers.includes(p.responsibleEngineer) ? p.responsibleEngineer : ''} disabled={dis} onChange={(e) => onPerson(p.id, 'responsibleEngineer', e.target.value)} className={field}>
            <option value="">—</option>
            {!engineers.includes(p.responsibleEngineer) && p.responsibleEngineer && <option value={p.responsibleEngineer}>{p.responsibleEngineer}</option>}
            {engineers.map((e) => (
              <option key={e} value={e}>{e}</option>
            ))}
            {canEdit && <option value="__add__">+ Dodaj…</option>}
          </select>
        </label>
        <label className="text-2xs text-ink-secondary">
          Vođa
          <select value={leads.includes(p.montageLead) ? p.montageLead : ''} disabled={dis} onChange={(e) => onPerson(p.id, 'montageLead', e.target.value)} className={field}>
            <option value="">—</option>
            {!leads.includes(p.montageLead) && p.montageLead && <option value={p.montageLead}>{p.montageLead}</option>}
            {leads.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
            {canEdit && <option value="__add__">+ Dodaj…</option>}
          </select>
        </label>
      </div>

      {/* 8 checkova */}
      <div className="mt-2 grid grid-cols-4 gap-1">
        {p.checks.map((c, ci) => (
          <button
            key={ci}
            type="button"
            disabled={dis}
            onClick={() => onCheck(p.id, ci, !c)}
            title={CHECK_LABELS[ci]}
            className={cn(
              'flex flex-col items-center rounded-control px-1 py-1 text-2xs font-medium',
              c ? 'bg-status-success-bg text-status-success' : 'bg-surface-2 text-ink-disabled',
              'disabled:opacity-60',
            )}
          >
            <span>{CHECK_SHORT[ci]}</span>
            {c ? <Check className="h-3 w-3" aria-hidden /> : <span className="h-3 w-3 rounded-full border border-current opacity-40" aria-hidden />}
          </button>
        ))}
      </div>

      {/* Spremnost + rizik */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {rd.done ? (
          <StatusBadge tone="success" label="Završeno" />
        ) : rd.ready ? (
          <StatusBadge tone="success" label="Spreman" />
        ) : (
          <span title={rd.reasons.join('\n')}><StatusBadge tone="warn" label="Nije spreman" /></span>
        )}
        <span title={rk.reasons.map((r) => r.text).join('\n') || undefined}>
          <StatusBadge tone={riskTone(rk.level)} label={`Rizik: ${RISK_LABEL[rk.level]}`} />
        </span>
      </div>

      {/* Blokator + beleška */}
      <div className="mt-2 space-y-2">
        <textarea
          rows={2}
          value={p.blocker}
          disabled={dis}
          onChange={(e) => onField(p.id, 'blocker', e.target.value)}
          placeholder={p.status === 3 ? 'Blokator (obavezno)' : 'Blokator'}
          className={cn('w-full rounded-control border bg-surface px-2 py-1 text-sm text-ink disabled:opacity-60', p.status === 3 && !p.blocker.trim() ? 'border-status-warn' : 'border-line')}
        />
        <textarea
          rows={2}
          value={p.note}
          disabled={dis}
          onChange={(e) => onField(p.id, 'note', e.target.value)}
          placeholder="Beleška"
          className="w-full rounded-control border border-line bg-surface px-2 py-1 text-sm text-ink disabled:opacity-60"
        />
      </div>

      {/* Povezani crteži — chipovi klikabilni i za viewera (BE gate presuđuje) */}
      {p.linkedDrawings.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {p.linkedDrawings.map((no) => (
            <DrawingChip key={no} code={no} />
          ))}
          {canEdit && (
            <button
              type="button"
              onClick={() => onOpenDrawings(p.id)}
              title="Izmeni listu povezanih crteža"
              className="rounded-control border border-line p-1 text-ink-secondary hover:bg-surface-2"
            >
              <Pencil className="h-3 w-3" aria-hidden />
            </button>
          )}
        </div>
      )}

      {/* Akcije */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {canEdit && (
          <>
            <button type="button" onClick={() => onOpenDesc(p.id)} className={cn('flex items-center gap-1 rounded-control border border-line px-2 py-1 text-xs', p.description?.trim() ? 'text-accent' : 'text-ink-secondary')}>
              <FileText className="h-3.5 w-3.5" aria-hidden /> Opis
            </button>
            {p.linkedDrawings.length === 0 && (
              <button type="button" onClick={() => onOpenDrawings(p.id)} title="Poveži crteže" className="flex items-center gap-1 rounded-control border border-line px-2 py-1 text-xs text-ink-secondary">
                <Link2 className="h-3.5 w-3.5" aria-hidden /> Crteži
              </button>
            )}
            <div className="ml-auto flex items-center gap-1">
              <button type="button" onClick={() => onMove(p.id, -1)} className="rounded-control border border-line p-1 text-ink-secondary hover:bg-surface-2"><ChevronUp className="h-4 w-4" aria-hidden /></button>
              <button type="button" onClick={() => onMove(p.id, 1)} className="rounded-control border border-line p-1 text-ink-secondary hover:bg-surface-2"><ChevronDown className="h-4 w-4" aria-hidden /></button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
