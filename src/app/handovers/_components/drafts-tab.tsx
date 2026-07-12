'use client';

import { useEffect, useState } from 'react';
import { Pencil, Plus, Printer, Send, Trash2 } from 'lucide-react';
import {
  DRAFT_ITEM_DECISION,
  useCreateHandoverDraft,
  useDeleteHandoverDraft,
  useDrawingsLookup,
  useHandoverDraft,
  useHandoverDrafts,
  useHandoverLookups,
  useSubmitHandoverDraft,
  useUpdateHandoverDraft,
  type CreateHandoverDraftInput,
  type CreateHandoverDraftItemInput,
  type DraftItemWarning,
  type Drawing,
  type HandoverDraft,
  type HandoverDraftDetail,
  type HandoverDraftItem,
} from '@/api/handovers';
import { useProjectsLookup, type ProjectLookup } from '@/api/lookups';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { ComboBox } from '@/components/ui-kit/combo-box';
import { formatDate, formatNumber } from '@/lib/format';
import {
  ConfirmDialog,
  DRAFT_ITEM_DECISION_LABEL,
  DRAFT_TYPE_OPTIONS,
  ErrorText,
  Field,
  NativeSelect,
  Textarea,
  draftStatusMeta,
  draftTypeLabel,
  errorBox,
  isUnresolvedDisputedItem,
  warnBox,
} from './common';
import { DecideDraftItemDialog } from './decision-dialog';
import { PrintDrawingsDialog } from './print-drawings-dialog';

const columns: Column<HandoverDraft>[] = [
  {
    key: 'draftNumber',
    header: 'Broj nacrta',
    render: (r) => <span className="tnums font-semibold text-ink">{r.draftNumber}</span>,
  },
  {
    key: 'draftDate',
    header: 'Datum',
    render: (r) => <span className="text-ink-secondary">{formatDate(r.draftDate)}</span>,
  },
  {
    key: 'project',
    header: 'Predmet',
    render: (r) => r.project?.projectNumber ?? `#${r.projectId}`,
  },
  {
    // Tip nacrta (P4 §6.5.2) — labele su radne do potvrde biroa (common.tsx).
    key: 'draftType',
    header: 'Tip',
    render: (r) => <span className="text-ink-secondary">{draftTypeLabel(r.draftType)}</span>,
  },
  {
    key: 'mainDrawing',
    header: 'Glavni crtež',
    render: (r) => (
      <span className="tnums text-ink-secondary">{r.mainDrawing?.drawingNumber ?? '—'}</span>
    ),
  },
  {
    key: 'pieceCount',
    header: 'Kom',
    align: 'right',
    numeric: true,
    render: (r) => formatNumber(r.pieceCount),
  },
  {
    key: 'itemsCount',
    header: 'Stavki',
    align: 'right',
    numeric: true,
    render: (r) => formatNumber(r.itemsCount),
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) => {
      const s = draftStatusMeta(r.status);
      return (
        <span className="inline-flex items-center gap-1.5">
          <StatusBadge tone={s.tone} label={s.label} />
          {r.isLocked && <StatusBadge tone="warn" label="Zaključan" />}
        </span>
      );
    },
  },
  {
    key: 'designer',
    header: 'Projektant',
    render: (r) => <span className="text-ink-secondary">{r.designer?.fullName ?? '—'}</span>,
  },
];

// ─────────────────────────────────────────────────────────────── forma (novi / izmena)

interface DraftFormState {
  designerId: string;
  project: ProjectLookup | null;
  draftType: number;
  mainDrawing: Drawing | null;
  pieceCount: string;
  note: string;
  statusId: number;
}

interface DraftItemDraft {
  key: string;
  drawing: Drawing | null;
  quantityToProduce: string;
  note: string;
}

function toFormState(draft: HandoverDraftDetail | null): DraftFormState {
  return {
    designerId: draft ? String(draft.designerId) : '',
    project: draft?.project
      ? {
          id: draft.project.id,
          projectNumber: draft.project.projectNumber,
          projectName: draft.project.projectName,
          customerId: draft.project.customerId,
          description: null,
        }
      : null,
    draftType: draft?.draftType ?? 0,
    mainDrawing: draft?.mainDrawing
      ? {
          id: draft.mainDrawing.id,
          drawingNumber: draft.mainDrawing.drawingNumber,
          revision: draft.mainDrawing.revision,
          catalogNumber: '',
          name: draft.mainDrawing.name,
          material: draft.mainDrawing.material,
          dimensions: draft.mainDrawing.dimensions,
          weight: draft.mainDrawing.weight ?? null,
          marking: '',
          isProcurement: false,
          pdmStatus: '',
          statusId: 0,
          designedBy: null,
          designDate: null,
          approvedBy: null,
          approvedDate: null,
          fileName: null,
          projectName: null,
          workOrderRef: null,
          createdAt: null,
          status: null,
        }
      : null,
    pieceCount: draft ? String(draft.pieceCount) : '1',
    note: draft?.note ?? '',
    statusId: draft?.statusId ?? 0,
  };
}

function newItemRow(): DraftItemDraft {
  return { key: `${Date.now()}-${Math.random()}`, drawing: null, quantityToProduce: '1', note: '' };
}

function DraftFormDialog({
  open,
  draft,
  onClose,
}: {
  open: boolean;
  draft: HandoverDraftDetail | null;
  onClose: () => void;
}) {
  const isEdit = draft != null;
  const [form, setForm] = useState<DraftFormState>(() => toFormState(draft));
  const [items, setItems] = useState<DraftItemDraft[]>([]);
  // Soft upozorenja iz create odgovora (meta.warnings, P4 §6.5.3/§6.5.4) —
  // nacrt JESTE kreiran, pa se umesto tihog zatvaranja prikaže lista (inline,
  // isti obrazac "success ekrana" kao LaunchHandoverDialog).
  const [warnings, setWarnings] = useState<DraftItemWarning[] | null>(null);
  const lookups = useHandoverLookups();
  const create = useCreateHandoverDraft();
  const update = useUpdateHandoverDraft();
  const mut = isEdit ? update : create;
  const set = (patch: Partial<DraftFormState>) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    if (open) {
      setForm(toFormState(draft));
      setItems([]);
      setWarnings(null);
    }
  }, [open, draft]);

  async function submit() {
    try {
      if (isEdit) {
        await update.mutateAsync({
          id: draft.id,
          data: {
            projectId: form.project?.id,
            mainDrawingId: form.mainDrawing?.id ?? null,
            draftType: form.draftType,
            pieceCount: Number(form.pieceCount) || undefined,
            note: form.note.trim() || null,
            statusId: form.statusId,
          },
        });
      } else {
        const payload: CreateHandoverDraftInput = {
          designerId: Number(form.designerId),
          projectId: form.project?.id ?? 0,
          mainDrawingId: form.mainDrawing?.id,
          draftType: form.draftType,
          pieceCount: Number(form.pieceCount) || 0,
          note: form.note.trim() || undefined,
          items: items
            .filter((i) => i.drawing)
            .map<CreateHandoverDraftItemInput>((i) => ({
              drawingId: i.drawing!.id,
              quantityToProduce: Number(i.quantityToProduce) || 1,
              note: i.note.trim() || undefined,
            })),
        };
        const res = await create.mutateAsync(payload);
        const created = res.meta?.warnings ?? [];
        if (created.length > 0) {
          setWarnings(created);
          return; // dijalog ostaje otvoren sa listom upozorenja
        }
      }
      onClose();
    } catch {
      /* greška se prikazuje ispod */
    }
  }

  // Ekran upozorenja posle uspešnog kreiranja: hard greške ne dolaze ovde
  // (422 obara mutaciju), pa je jedino dugme „Zatvori".
  if (warnings) {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title="Novi nacrt primopredaje"
        footer={
          <Button variant="secondary" onClick={onClose}>
            Zatvori
          </Button>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-ink">
            Nacrt je kreiran, ali stavke nose upozorenja — proverite ih pre predaje u primopredaju:
          </p>
          <ul className={`${warnBox} list-disc space-y-1 pl-8`}>
            {warnings.map((w, i) => (
              <li key={`${w.drawingId}-${w.type}-${i}`}>{w.message}</li>
            ))}
          </ul>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEdit ? `Izmena nacrta ${draft.draftNumber}` : 'Novi nacrt primopredaje'}
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Otkaži
          </button>
          <Button
            onClick={submit}
            loading={mut.isPending}
            // Bez ovoga se šalje designerId=Number('')=0 / projectId=0 i čeka
            // backend 400 — isti obrazac kao NewWorkOrderDialog (work-orders).
            disabled={!form.project || (!isEdit && !form.designerId.trim())}
          >
            Snimi
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {!isEdit && (
          <p className="text-xs text-ink-disabled">
            Broj nacrta generiše sistem. Projektant se unosi šifrom radnika (biranje iz liste
            stiže sa šifarnicima).
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Predmet" required>
            <ComboBox<ProjectLookup>
              value={form.project}
              onChange={(p) => set({ project: p })}
              useSearch={useProjectsLookup}
              getKey={(p) => p.id}
              getLabel={(p) => p.projectNumber}
              getSublabel={(p) => p.projectName ?? p.description ?? ''}
              placeholder="Broj/naziv predmeta…"
            />
          </FormField>
          {!isEdit && (
            <FormField label="Projektant" required hint="Šifra radnika">
              <Input
                type="number"
                min={1}
                value={form.designerId}
                onChange={(e) => set({ designerId: e.target.value })}
              />
            </FormField>
          )}
          {isEdit && (
            <FormField label="Status nacrta">
              <NativeSelect
                value={form.statusId}
                onChange={(e) => set({ statusId: Number(e.target.value) })}
                className="w-full"
              >
                {(lookups.data?.data.draftStatuses ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {/* Vrednosti 0/1/2 = backend draft_type; labele radne do potvrde
              biroa (P4 §8 #6) — jedan izvor: DRAFT_TYPE_LABEL u common.tsx. */}
          <FormField label="Tip nacrta">
            <NativeSelect
              value={form.draftType}
              onChange={(e) => set({ draftType: Number(e.target.value) })}
              className="w-full"
            >
              {DRAFT_TYPE_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Broj komada" required>
            <Input
              type="number"
              min={1}
              value={form.pieceCount}
              onChange={(e) => set({ pieceCount: e.target.value })}
            />
          </FormField>
        </div>
        <FormField label="Glavni crtež sklopa" hint="Opciono — ako je nacrt za ceo sklop.">
          <ComboBox<Drawing>
            value={form.mainDrawing}
            onChange={(d) => set({ mainDrawing: d })}
            useSearch={useDrawingsLookup}
            getKey={(d) => d.id}
            getLabel={(d) => `${d.drawingNumber} / ${d.revision}`}
            getSublabel={(d) => d.name}
            placeholder="Broj crteža…"
          />
        </FormField>
        <FormField label="Napomena">
          <Textarea
            value={form.note}
            maxLength={250}
            onChange={(e) => set({ note: e.target.value })}
          />
        </FormField>

        {!isEdit && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                Stavke ({items.length})
              </p>
              <button
                type="button"
                onClick={() => setItems((it) => [...it, newItemRow()])}
                className="inline-flex items-center gap-1 rounded-control border border-line px-2 py-1 text-xs font-semibold text-ink-secondary hover:bg-surface-2"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Dodaj stavku
              </button>
            </div>
            {items.length > 0 && (
              <div className="space-y-2 rounded-control border border-line bg-surface-2/40 p-2.5">
                {items.map((it, idx) => (
                  <div key={it.key} className="flex items-end gap-2">
                    <div className="flex-1">
                      <ComboBox<Drawing>
                        value={it.drawing}
                        onChange={(d) =>
                          setItems((prev) =>
                            prev.map((p, i) => (i === idx ? { ...p, drawing: d } : p)),
                          )
                        }
                        useSearch={useDrawingsLookup}
                        getKey={(d) => d.id}
                        getLabel={(d) => `${d.drawingNumber} / ${d.revision}`}
                        getSublabel={(d) => d.name}
                        placeholder="Broj crteža…"
                      />
                    </div>
                    <Input
                      type="number"
                      min={1}
                      value={it.quantityToProduce}
                      onChange={(e) =>
                        setItems((prev) =>
                          prev.map((p, i) =>
                            i === idx ? { ...p, quantityToProduce: e.target.value } : p,
                          ),
                        )
                      }
                      className="w-20"
                      title="Količina za izradu"
                    />
                    <button
                      type="button"
                      onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
                      className="rounded-control border border-line p-1.5 text-ink-secondary hover:bg-surface-2"
                      aria-label="Ukloni stavku"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <ErrorText error={mut.error} />
      </div>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────── detalj (expand) + stavke

/**
 * Kolone stavki zavise od stanja nacrta (zaključan?) i callback-a za odluku,
 * pa se grade po detalju (isti razlog kao kolone u approved-tab.tsx).
 * Sporne stavke (§6.5.4): badge „Sporna" dok nema odluke (tačno kriterijum
 * backend submit gate-a); posle odluke ostaje neutralni „Duplikat" trag.
 */
function buildItemColumns(opts: {
  locked: boolean;
  onDecide: (item: HandoverDraftItem) => void;
}): Column<HandoverDraftItem>[] {
  return [
    {
      key: 'drawing',
      header: 'Crtež',
      render: (r) => (
        <span className="tnums font-semibold text-ink">
          {r.drawing ? `${r.drawing.drawingNumber} / ${r.drawing.revision}` : `#${r.drawingId}`}
        </span>
      ),
    },
    { key: 'name', header: 'Naziv', render: (r) => r.drawing?.name || '—' },
    {
      key: 'quantityDefined',
      header: 'Kol. definisana',
      align: 'right',
      numeric: true,
      render: (r) => formatNumber(r.quantityDefinedInDrawing ?? 0),
    },
    {
      key: 'quantityToProduce',
      header: 'Kol. za izradu',
      align: 'right',
      numeric: true,
      render: (r) => (
        <span className="font-semibold text-ink">{formatNumber(r.quantityToProduce)}</span>
      ),
    },
    {
      key: 'mainDrawing',
      header: 'Vodeći sklop',
      render: (r) => (
        <span className="tnums text-ink-secondary">{r.mainDrawing?.drawingNumber ?? '—'}</span>
      ),
    },
    {
      key: 'flags',
      header: 'Napomena',
      render: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {isUnresolvedDisputedItem(r) ? (
            <StatusBadge tone="warn" label="Sporna" />
          ) : (
            r.preCheckDuplicate && (
              <span
                title={
                  r.decisionAction > 0
                    ? `Odluka: ${DRAFT_ITEM_DECISION_LABEL[r.decisionAction] ?? '—'}${
                        r.decisionDateTime ? ` · ${formatDate(r.decisionDateTime)}` : ''
                      }`
                    : undefined
                }
                className="inline-flex"
              >
                <StatusBadge tone="neutral" label="Duplikat" />
              </span>
            )
          )}
          {r.excludeFromHandover && <StatusBadge tone="neutral" label="Isključena" />}
          <span className="text-ink-secondary">{r.note || '—'}</span>
        </span>
      ),
    },
    {
      // Odluka projektanta (§6.5.4) — samo za pre-check duplikate; re-odluka
      // dozvoljena dok nacrt nije zaključan (backend 422 za zaključan).
      key: 'decision',
      header: 'Odluka',
      align: 'right',
      render: (r) =>
        r.preCheckDuplicate && !opts.locked ? (
          <Can permission={PERMISSIONS.PRIMOPREDAJE_WRITE}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                opts.onDecide(r);
              }}
              className="rounded-control border border-line px-2.5 py-1 text-xs font-semibold text-ink-secondary hover:bg-surface-2"
            >
              {r.decisionAction === DRAFT_ITEM_DECISION.NONE ? 'Odluči' : 'Promeni odluku'}
            </button>
          </Can>
        ) : r.preCheckDuplicate ? (
          <span className="text-ink-secondary">
            {DRAFT_ITEM_DECISION_LABEL[r.decisionAction] ?? '—'}
          </span>
        ) : (
          <span className="text-ink-disabled">—</span>
        ),
    },
  ];
}

function DraftDetail({
  draft,
  onEdit,
  onSubmitted,
}: {
  draft: HandoverDraft;
  onEdit: (detail: HandoverDraftDetail) => void;
  onSubmitted?: () => void;
}) {
  const q = useHandoverDraft(draft.id);
  const del = useDeleteHandoverDraft();
  const submit = useSubmitHandoverDraft();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingSubmit, setConfirmingSubmit] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [deciding, setDeciding] = useState<HandoverDraftItem | null>(null);

  if (q.isLoading) return <span className="text-sm text-ink-disabled">Učitavanje…</span>;
  if (q.error || !q.data)
    return <span className="text-sm text-status-danger">Greška pri učitavanju detalja.</span>;

  const d = q.data.data;
  const s = draftStatusMeta(d.status);
  // Sporne stavke bez odluke (§6.5.4) — isti kriterijum kao backend submit
  // gate (422): predaja je blokirana i u UI dok se sve ne odluče.
  const unresolved = d.items.filter(isUnresolvedDisputedItem);
  const itemColumns = buildItemColumns({ locked: !!d.isLocked, onDecide: setDeciding });

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={s.tone} label={s.label} />
        {d.isLocked && <StatusBadge tone="warn" label="Zaključan" />}
        <span className="flex-1" />
        {/* Štampa je read-only — dostupna i za zaključan nacrt, bez permission gate-a
            (endpoint traži samo primopredaje.read, isto kao i sam prikaz). */}
        <button
          onClick={() => setPrintOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-control border border-line px-2.5 py-1 text-xs font-semibold text-ink-secondary hover:bg-surface-2"
        >
          <Printer className="h-3.5 w-3.5" aria-hidden />
          Štampaj sve crteže
        </button>
        {/* PATCH/DELETE/submit traže primopredaje.write (handover-drafts.controller) —
            uloge sa samo read (cnc_programer, magacioner) ne vide mutirajuće akcije. */}
        <Can permission={PERMISSIONS.PRIMOPREDAJE_WRITE}>
          {!d.isLocked && (
            <>
              <button
                onClick={() => onEdit(d)}
                className="inline-flex items-center gap-1.5 rounded-control border border-line px-2.5 py-1 text-xs font-semibold text-ink-secondary hover:bg-surface-2"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
                Izmeni
              </button>
              {!confirmingDelete ? (
                <button
                  onClick={() => setConfirmingDelete(true)}
                  className="inline-flex items-center gap-1.5 rounded-control border border-status-danger px-2.5 py-1 text-xs font-semibold text-status-danger hover:bg-status-danger-bg"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  Obriši
                </button>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-xs text-ink-secondary">Obrisati nacrt?</span>
                  <button
                    onClick={() => del.mutate(d.id)}
                    disabled={del.isPending}
                    className="rounded-control bg-status-danger px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    Potvrdi
                  </button>
                  <button
                    onClick={() => setConfirmingDelete(false)}
                    className="rounded-control border border-line px-2.5 py-1 text-xs text-ink-secondary hover:bg-surface-2"
                  >
                    Otkaži
                  </button>
                </span>
              )}
            </>
          )}
          <button
            onClick={() => setConfirmingSubmit(true)}
            disabled={d.isLocked || submit.isPending || unresolved.length > 0}
            title={
              d.isLocked
                ? 'Nacrt je već predat (zaključan).'
                : unresolved.length > 0
                  ? 'Nacrt ima sporne stavke bez odluke projektanta — donesite odluku (kolona „Odluka”) pre predaje.'
                  : undefined
            }
            className="inline-flex items-center gap-1.5 rounded-control bg-accent px-2.5 py-1 text-xs font-semibold text-accent-fg hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" aria-hidden />
            Predaj u primopredaju
          </button>
        </Can>
      </div>

      <ErrorText error={del.error} />

      {/* Blokada predaje dok ima spornih stavki bez odluke (§6.5.4) — backend
          422 poruka je krajnja istina (prikaz u ConfirmDialog-u ispod). */}
      {!d.isLocked && unresolved.length > 0 && (
        <div className={warnBox}>
          Sporne stavke bez odluke projektanta:{' '}
          {unresolved
            .map((i) => (i.drawing ? i.drawing.drawingNumber : `#${i.drawingId}`))
            .join(', ')}{' '}
          — „Predaj u primopredaju” je blokirano dok se za svaku ne donese odluka (kolona
          „Odluka” u tabeli stavki).
        </div>
      )}

      <PrintDrawingsDialog
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        scope={{ kind: 'draft', id: d.id }}
        subtitle={`Nacrt ${d.draftNumber}`}
      />

      <DecideDraftItemDialog
        draftId={d.id}
        item={deciding}
        open={deciding != null}
        onClose={() => setDeciding(null)}
      />

      <ConfirmDialog
        open={confirmingSubmit}
        title="Predaja u primopredaju"
        confirmLabel="Predaj"
        message={
          <>
            Nacrt <span className="font-semibold text-ink">{d.draftNumber}</span> se zaključava i za
            svaku ne-isključenu stavku se kreira primopredaja u statusu „U obradi”. Akcija se ne može
            opozvati.
          </>
        }
        loading={submit.isPending}
        error={submit.error}
        onCancel={() => setConfirmingSubmit(false)}
        onConfirm={() =>
          submit.mutate(d.id, {
            onSuccess: () => {
              setConfirmingSubmit(false);
              onSubmitted?.();
            },
          })
        }
      />

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Field label="Projektant" value={d.designer?.fullName ?? '—'} />
        <Field
          label="Predmet"
          value={
            d.project
              ? [d.project.projectNumber, d.project.projectName].filter(Boolean).join(' · ')
              : `#${d.projectId}`
          }
        />
        <Field label="Tip nacrta" value={draftTypeLabel(d.draftType)} />
        <Field label="Glavni crtež" value={d.mainDrawing?.drawingNumber ?? '—'} />
        <Field label="Broj komada" value={formatNumber(d.pieceCount)} />
        <Field label="Datum nacrta" value={formatDate(d.draftDate)} />
        {d.note && <Field label="Napomena" value={d.note} />}
      </dl>

      <div>
        <p className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          Stavke ({d.items.length})
        </p>
        <DataTable
          columns={itemColumns}
          rows={d.items}
          rowKey={(r) => r.id}
          empty={<EmptyState title="Nacrt nema stavki" />}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── tab

export function DraftsTab({ onSubmitted }: { onSubmitted?: () => void }) {
  const [q, setQ] = useState('');
  const [statusId, setStatusId] = useState<number | ''>('');
  const [isLocked, setIsLocked] = useState<'' | 'true' | 'false'>('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<HandoverDraftDetail | null>(null);
  const resetPage = () => setPage(1);

  const lookups = useHandoverLookups();
  const list = useHandoverDrafts({
    page,
    q: q.trim() || undefined,
    statusId,
    isLocked,
  });

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;
  const hasFilter = !!(q || statusId !== '' || isLocked);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1 text-xs text-ink-secondary">
            Pretraga
            <SearchBox
              value={q}
              onChange={(v) => {
                setQ(v);
                resetPage();
              }}
              placeholder="Broj nacrta, napomena…"
            />
          </div>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Status
            <NativeSelect
              value={statusId}
              onChange={(e) => {
                setStatusId(e.target.value === '' ? '' : Number(e.target.value));
                resetPage();
              }}
            >
              <option value="">Svi</option>
              {(lookups.data?.data.draftStatuses ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Zaključanost
            <NativeSelect
              value={isLocked}
              onChange={(e) => {
                setIsLocked(e.target.value as '' | 'true' | 'false');
                resetPage();
              }}
            >
              <option value="">Sve</option>
              <option value="false">Otključan</option>
              <option value="true">Zaključan</option>
            </NativeSelect>
          </label>
          {hasFilter && (
            <button
              onClick={() => {
                setQ('');
                setStatusId('');
                setIsLocked('');
                resetPage();
              }}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Očisti
            </button>
          )}
        </div>
        <Can permission={PERMISSIONS.PRIMOPREDAJE_WRITE}>
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            Novi nacrt
          </Button>
        </Can>
      </div>

      {meta && (
        <span className="block text-sm text-ink-secondary">{formatNumber(meta.total)} zapisa</span>
      )}

      {list.error && <div className={errorBox}>{(list.error as Error).message}</div>}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        onRowActivate={(r) => setExpanded((e) => (e === r.id ? null : r.id))}
        expandedKey={expanded}
        renderExpanded={(r) => (
          <DraftDetail
            draft={r}
            onEdit={(detail) => {
              setEditing(detail);
            }}
            onSubmitted={onSubmitted}
          />
        )}
        empty={
          <EmptyState
            title="Nema nacrta primopredaje"
            hint="Promeni filtere ili kreiraj novi nacrt dugmetom gore."
          />
        }
      />

      {meta && meta.totalPages > 1 && (
        <Pager
          page={meta.page}
          totalPages={meta.totalPages}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
        />
      )}

      <DraftFormDialog open={creating} draft={null} onClose={() => setCreating(false)} />
      <DraftFormDialog
        open={editing != null}
        draft={editing}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}
