'use client';

import { useEffect, useState } from 'react';
import { Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { cn } from '@/lib/cn';
import {
  useNotifConfig,
  useUpdateNotifConfig,
  useTipCategories,
  useUpsertTipCategory,
  useDeleteTipCategory,
  type PbNotifConfig,
  type PbTipCategory,
} from '@/api/projektni-biro';

export function PodesavanjaTab() {
  const cfgQ = useNotifConfig();
  const updateM = useUpdateNotifConfig();
  const [form, setForm] = useState<Partial<PbNotifConfig>>({});
  const [recipients, setRecipients] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const c = cfgQ.data?.data;
    if (c) {
      setForm(c);
      setRecipients((c.emailRecipients ?? []).join(', '));
    }
  }, [cfgQ.data]);

  const set = <K extends keyof PbNotifConfig>(k: K, v: PbNotifConfig[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setSaved(false);
    await updateM.mutateAsync({
      enabled: form.enabled,
      deadlineWarningDays: form.deadlineWarningDays,
      overloadThresholdPct: form.overloadThresholdPct,
      emailRecipients: recipients.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
      notifyOnBlocked: form.notifyOnBlocked,
      notifyOnOverload: form.notifyOnOverload,
      notifyOnDeadlineWarning: form.notifyOnDeadlineWarning,
      notifyOnDeadlineOverdue: form.notifyOnDeadlineOverdue,
      notifyOnNoEngineer: form.notifyOnNoEngineer,
      digestMode: form.digestMode,
      quietHoursStart: form.quietHoursStart || null,
      quietHoursEnd: form.quietHoursEnd || null,
    });
    setSaved(true);
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Notifikacije */}
      <div className="rounded-panel border border-line bg-surface p-4">
        <h3 className="mb-3 text-sm font-semibold text-ink">Email notifikacije (Projektni biro)</h3>
        {cfgQ.isError ? (
          <EmptyState title="Greška pri učitavanju" hint="Osveži stranicu ili pokušaj ponovo." />
        ) : (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={!!form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Notifikacije uključene
          </label>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Upozorenje pred rok (dana)">
              <Input type="number" min={1} max={30} value={form.deadlineWarningDays ?? 3} onChange={(e) => set('deadlineWarningDays', Number(e.target.value))} />
            </FormField>
            <FormField label="Prag preopterećenosti (%)">
              <Input type="number" min={50} max={200} value={form.overloadThresholdPct ?? 100} onChange={(e) => set('overloadThresholdPct', Number(e.target.value))} />
            </FormField>
          </div>
          <FormField label="Email primaoci" hint="Razdvojeno zarezom">
            <Textarea value={recipients} onChange={(e) => setRecipients(e.target.value)} rows={2} />
          </FormField>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {(
              [
                ['notifyOnBlocked', 'Blokirani zadaci'],
                ['notifyOnOverload', 'Preopterećenost'],
                ['notifyOnDeadlineWarning', 'Rok uskoro'],
                ['notifyOnDeadlineOverdue', 'Kašnjenje roka'],
                ['notifyOnNoEngineer', 'Bez inženjera'],
              ] as [keyof PbNotifConfig, string][]
            ).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={!!form[k]} onChange={(e) => set(k, e.target.checked as never)} /> {label}
              </label>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Tihi sati — početak">
              <Input type="time" value={form.quietHoursStart ?? ''} onChange={(e) => set('quietHoursStart', e.target.value)} />
            </FormField>
            <FormField label="Tihi sati — kraj">
              <Input type="time" value={form.quietHoursEnd ?? ''} onChange={(e) => set('quietHoursEnd', e.target.value)} />
            </FormField>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={!!form.digestMode} onChange={(e) => set('digestMode', e.target.checked)} /> Grupiši poruke (digest)
          </label>
          <div className="flex items-center gap-3">
            <Button onClick={save} loading={updateM.isPending}>
              Sačuvaj
            </Button>
            {saved && <span className="text-sm text-status-success">Sačuvano.</span>}
          </div>
        </div>
        )}
      </div>

      <CategoriesEditor />
    </div>
  );
}

function CategoriesEditor() {
  const q = useTipCategories();
  const upsertM = useUpsertTipCategory();
  const delM = useDeleteTipCategory();
  const [naziv, setNaziv] = useState('');
  const [ikona, setIkona] = useState('');
  const [boja, setBoja] = useState('#64748b');
  const [redosled, setRedosled] = useState(0);

  // Inline izmena postojeće kategorije
  const [editId, setEditId] = useState<string | null>(null);
  const [editNaziv, setEditNaziv] = useState('');
  const [editSlug, setEditSlug] = useState('');

  async function add() {
    if (!naziv.trim()) return;
    await upsertM.mutateAsync({ naziv: naziv.trim(), ikona: ikona || undefined, boja, redosled, jeAktivna: true });
    setNaziv('');
    setIkona('');
  }

  // Očuva postojeća polja kategorije (upsert po id-u je update) uz zadate izmene.
  function toUpsert(c: PbTipCategory, patch: { naziv?: string; slug?: string; jeAktivna?: boolean }) {
    return {
      id: c.id,
      naziv: patch.naziv ?? c.naziv,
      slug: (patch.slug ?? c.slug) || undefined,
      ikona: c.ikona ?? undefined,
      boja: c.boja ?? undefined,
      redosled: c.redosled ?? undefined,
      jeAktivna: patch.jeAktivna ?? c.je_aktivna ?? true,
    };
  }

  function startEdit(c: PbTipCategory) {
    setEditId(c.id);
    setEditNaziv(c.naziv);
    setEditSlug(c.slug ?? '');
  }
  function cancelEdit() {
    setEditId(null);
    setEditNaziv('');
    setEditSlug('');
  }
  async function saveEdit(c: PbTipCategory) {
    const nv = editNaziv.trim();
    if (!nv) return;
    await upsertM.mutateAsync(toUpsert(c, { naziv: nv, slug: editSlug.trim() }));
    cancelEdit();
  }
  async function toggleActive(c: PbTipCategory) {
    await upsertM.mutateAsync(toUpsert(c, { jeAktivna: !(c.je_aktivna ?? true) }));
  }

  return (
    <div className="rounded-panel border border-line bg-surface p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">Kategorije saveta</h3>
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Naziv" required>
          <Input value={naziv} onChange={(e) => setNaziv(e.target.value)} maxLength={80} />
        </FormField>
        <FormField label="Ikona">
          <Input value={ikona} onChange={(e) => setIkona(e.target.value)} maxLength={8} />
        </FormField>
        <FormField label="Boja">
          <Input type="color" value={boja} onChange={(e) => setBoja(e.target.value)} />
        </FormField>
        <FormField label="Redosled">
          <Input type="number" min={0} max={999} value={redosled} onChange={(e) => setRedosled(Number(e.target.value))} />
        </FormField>
      </div>
      <Button onClick={add} loading={upsertM.isPending} className="mt-2">
        Dodaj
      </Button>

      {q.isError ? (
        <EmptyState title="Greška pri učitavanju" hint="Osveži stranicu ili pokušaj ponovo." />
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-2xs uppercase text-ink-secondary">
              <th className="py-1.5">Ikona</th>
              <th className="py-1.5">Naziv</th>
              <th className="py-1.5">Red</th>
              <th className="py-1.5" />
            </tr>
          </thead>
          <tbody>
            {(q.data?.data ?? []).map((c) =>
              editId === c.id ? (
                <tr key={c.id} className="border-b border-line-soft">
                  <td colSpan={4} className="py-2">
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="min-w-[9rem] flex-1">
                        <FormField label="Naziv" required>
                          <Input value={editNaziv} onChange={(e) => setEditNaziv(e.target.value)} maxLength={80} />
                        </FormField>
                      </div>
                      <div className="min-w-[9rem] flex-1">
                        <FormField label="Slug">
                          <Input value={editSlug} onChange={(e) => setEditSlug(e.target.value)} maxLength={80} />
                        </FormField>
                      </div>
                      <Button onClick={() => saveEdit(c)} loading={upsertM.isPending}>
                        Sačuvaj
                      </Button>
                      <Button variant="secondary" onClick={cancelEdit}>
                        Otkaži
                      </Button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={c.id} className={cn('border-b border-line-soft', c.je_aktivna === false && 'opacity-50')}>
                  <td className="py-1.5">{c.ikona}</td>
                  <td className="py-1.5 text-ink">
                    {c.naziv} {c.je_aktivna === false && <span className="text-xs text-ink-disabled">(neaktivna)</span>}
                  </td>
                  <td className="py-1.5 tnums text-ink-secondary">{c.redosled ?? 0}</td>
                  <td className="py-1.5 text-right">
                    <div className="inline-flex items-center gap-2">
                      <button
                        onClick={() => toggleActive(c)}
                        disabled={upsertM.isPending}
                        className={cn(
                          'transition-colors disabled:opacity-50',
                          c.je_aktivna === false ? 'text-ink-disabled hover:text-ink' : 'text-status-success hover:text-status-success/80',
                        )}
                        aria-label={c.je_aktivna === false ? 'Aktiviraj' : 'Deaktiviraj'}
                        title={c.je_aktivna === false ? 'Aktiviraj' : 'Deaktiviraj'}
                      >
                        {c.je_aktivna === false ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                      <button onClick={() => startEdit(c)} className="text-ink-disabled hover:text-ink" aria-label="Izmeni" title="Izmeni">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => confirm('Obrisati kategoriju?') && delM.mutate({ id: c.id })} className="text-ink-disabled hover:text-status-danger" aria-label="Obriši" title="Obriši">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
