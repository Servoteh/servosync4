'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { ApiError } from '@/api/client';
import {
  useUpsertPhase,
  useUpdatePhase,
  useDeletePhase,
  type PmPhase,
  type PhaseInput,
} from '@/api/plan-montaze';
import { CHECK_LABELS, STATUSES, applyBusinessRules, checks8, DEFAULT_LOCATIONS } from './phase-util';

type Draft = {
  phaseName: string;
  location: string;
  startDate: string;
  endDate: string;
  actualStartDate: string;
  actualEndDate: string;
  responsibleEngineer: string;
  montageLead: string;
  status: number;
  pct: number;
  checks: boolean[];
  blocker: string;
  note: string;
  description: string;
  phaseType: string;
  linkedDrawings: string;
};

function fromPhase(p: PmPhase | null, projectId: string, workPackageId: string): Draft {
  return {
    phaseName: p?.phaseName ?? '',
    location: p?.location ?? DEFAULT_LOCATIONS[0],
    startDate: p?.startDate?.slice(0, 10) ?? '',
    endDate: p?.endDate?.slice(0, 10) ?? '',
    actualStartDate: p?.actualStartDate?.slice(0, 10) ?? '',
    actualEndDate: p?.actualEndDate?.slice(0, 10) ?? '',
    responsibleEngineer: p?.responsibleEngineer ?? '',
    montageLead: p?.montageLead ?? '',
    status: p?.status ?? 0,
    pct: p?.pct ?? 0,
    checks: p ? checks8(p) : new Array(8).fill(false),
    blocker: p?.blocker ?? '',
    note: p?.note ?? '',
    description: p?.description ?? '',
    phaseType: p?.phaseType ?? 'mechanical',
    linkedDrawings: (p?.linkedDrawings ?? []).join(', '),
    // projectId/workPackageId captured by caller
  } as Draft & { _pid?: string; _wpid?: string };
}

/**
 * Modal za dodavanje/izmenu faze montaže. 8 checkbox-a spremnosti + status↔pct
 * business rules (paritet 1.0 phase.js). Read-only kad `canEdit=false`.
 */
export function PhaseModal({
  open,
  onClose,
  phase,
  projectId,
  workPackageId,
  canEdit,
}: {
  open: boolean;
  onClose: () => void;
  phase: PmPhase | null;
  projectId: string;
  workPackageId: string;
  canEdit: boolean;
}) {
  const [d, setD] = useState<Draft>(() => fromPhase(phase, projectId, workPackageId));
  const [err, setErr] = useState<string | null>(null);
  const upsert = useUpsertPhase();
  const update = useUpdatePhase();
  const remove = useDeletePhase();

  useEffect(() => {
    if (open) {
      setD(fromPhase(phase, projectId, workPackageId));
      setErr(null);
    }
  }, [open, phase, projectId, workPackageId]);

  function set<K extends keyof Draft>(key: K, val: Draft[K], changed?: 'status' | 'pct' | 'start' | 'end') {
    setD((prev) => applyBusinessRules({ ...prev, [key]: val }, changed));
  }

  async function save() {
    setErr(null);
    if (!d.phaseName.trim()) {
      setErr('Naziv faze je obavezan.');
      return;
    }
    const base: Partial<PhaseInput> = {
      phaseName: d.phaseName.trim(),
      location: d.location || undefined,
      startDate: d.startDate || null,
      endDate: d.endDate || null,
      actualStartDate: d.actualStartDate || null,
      actualEndDate: d.actualEndDate || null,
      responsibleEngineer: d.responsibleEngineer,
      montageLead: d.montageLead,
      status: d.status,
      pct: d.pct,
      checks: d.checks,
      blocker: d.blocker,
      note: d.note,
      description: d.description,
      phaseType: d.phaseType,
      linkedDrawings: d.linkedDrawings
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    try {
      if (phase) {
        await update.mutateAsync({ id: phase.id, patch: base });
      } else {
        await upsert.mutateAsync({ projectId, workPackageId, phaseName: base.phaseName!, ...base });
      }
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Greška pri čuvanju faze.');
    }
  }

  async function del() {
    if (!phase || !confirm('Obrisati fazu?')) return;
    setErr(null);
    try {
      await remove.mutateAsync({ id: phase.id });
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Greška pri brisanju.');
    }
  }

  const busy = upsert.isPending || update.isPending || remove.isPending;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={phase ? 'Izmena faze' : 'Nova faza'}
      footer={
        canEdit ? (
          <>
            {phase && (
              <Button variant="danger" onClick={del} loading={remove.isPending} className="mr-auto">
                Obriši
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>
              Otkaži
            </Button>
            <Button onClick={save} loading={busy}>
              Sačuvaj
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            Zatvori
          </Button>
        )
      }
    >
      <fieldset disabled={!canEdit} className="space-y-3">
        <FormField label="Naziv faze" required>
          <Input value={d.phaseName} onChange={(e) => set('phaseName', e.target.value)} />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Lokacija">
            <Input value={d.location} onChange={(e) => set('location', e.target.value)} list="montaza-lokacije" />
            <datalist id="montaza-lokacije">
              {DEFAULT_LOCATIONS.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </FormField>
          <FormField label="Tip">
            <select
              value={d.phaseType}
              onChange={(e) => set('phaseType', e.target.value)}
              className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
            >
              <option value="mechanical">Mašinska</option>
              <option value="electrical">Električna</option>
            </select>
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Plan početak">
            <Input type="date" value={d.startDate} onChange={(e) => set('startDate', e.target.value, 'start')} />
          </FormField>
          <FormField label="Plan kraj">
            <Input type="date" value={d.endDate} onChange={(e) => set('endDate', e.target.value, 'end')} />
          </FormField>
          <FormField label="Stvarni početak">
            <Input type="date" value={d.actualStartDate} onChange={(e) => set('actualStartDate', e.target.value)} />
          </FormField>
          <FormField label="Stvarni kraj">
            <Input type="date" value={d.actualEndDate} onChange={(e) => set('actualEndDate', e.target.value)} />
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Inženjer">
            <Input value={d.responsibleEngineer} onChange={(e) => set('responsibleEngineer', e.target.value)} />
          </FormField>
          <FormField label="Vođa montaže">
            <Input value={d.montageLead} onChange={(e) => set('montageLead', e.target.value)} />
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Status">
            <select
              value={d.status}
              onChange={(e) => set('status', Number(e.target.value), 'status')}
              className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
            >
              {STATUSES.map((s, i) => (
                <option key={s} value={i}>
                  {s}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label={`Napredak: ${d.pct}%`}>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={d.pct}
              onChange={(e) => set('pct', Number(e.target.value), 'pct')}
              className="w-full"
            />
          </FormField>
        </div>

        <div>
          <div className="mb-1.5 text-base font-medium text-ink">Spremnost (8)</div>
          <div className="grid grid-cols-2 gap-1.5">
            {CHECK_LABELS.map((label, i) => (
              <label key={label} className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={!!d.checks[i]}
                  onChange={(e) => {
                    const next = [...d.checks];
                    next[i] = e.target.checked;
                    set('checks', next);
                  }}
                />
                {label}
              </label>
            ))}
          </div>
        </div>

        <FormField label="Blokator">
          <Input value={d.blocker} onChange={(e) => set('blocker', e.target.value)} />
        </FormField>

        <FormField label="Napomena">
          <textarea
            value={d.note}
            onChange={(e) => set('note', e.target.value)}
            rows={2}
            className="w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink"
          />
        </FormField>

        <FormField label="Opis">
          <textarea
            value={d.description}
            onChange={(e) => set('description', e.target.value)}
            rows={2}
            className="w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink"
          />
        </FormField>

        <FormField label="Povezani crteži (brojevi, zarezom)">
          <Input value={d.linkedDrawings} onChange={(e) => set('linkedDrawings', e.target.value)} />
        </FormField>

        {err && <p className="text-sm text-status-danger">{err}</p>}
      </fieldset>
    </Dialog>
  );
}
