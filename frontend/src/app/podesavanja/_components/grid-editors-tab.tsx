'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { ApiError } from '@/api/client';
import { toast } from '@/lib/toast';
import { formatDate } from '@/lib/format';
import { useGridEditors, useAddGridEditor, useRemoveGridEditor } from '@/api/podesavanja';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Podešavanja → Urednici mesečnog grida (allowlist) — pun CRUD (paritet 1.0
 * `gridEditorsTab.js`). Ko sme da unosi/menja sate u Kadrovska → Mesečni grid
 * (sy15 `kadr_grid_editor_allowlist`). Add: POST (409 = već postoji); Ukloni:
 * DELETE po email-u uz confirm. Tab je već pod SETTINGS_USERS (admin) na nivou
 * page-a — ovde nema dodatnog gating-a.
 */
export function GridEditorsTab() {
  const q = useGridEditors();
  const addM = useAddGridEditor();
  const removeM = useRemoveGridEditor();
  const rows = q.data?.data ?? [];

  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    setErr(null);
    const e = email.trim();
    const n = note.trim();
    if (!e) return setErr('Unesi email.');
    if (!EMAIL_RE.test(e)) return setErr('Neispravan email format.');
    if (rows.some((r) => r.email.toLowerCase() === e.toLowerCase())) {
      return setErr('Email je već na listi urednika.');
    }
    try {
      await addM.mutateAsync({ email: e, note: n || undefined });
      toast('Dodato');
      setEmail('');
      setNote('');
    } catch (ex) {
      if (ex instanceof ApiError && ex.status === 409) {
        setErr('Već postoji.');
      } else {
        setErr(ex instanceof ApiError ? ex.message : 'Dodavanje nije uspelo.');
      }
    }
  }

  function remove(target: string) {
    if (!confirm(`Ukloniti ${target} sa liste?`)) return;
    removeM.mutate(
      { email: target },
      {
        onSuccess: () => toast('Uklonjeno'),
        onError: (ex) => toast(ex instanceof ApiError ? `⚠ ${ex.message}` : '⚠ Brisanje nije uspelo'),
      },
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-md font-semibold text-ink">Urednici mesečnog grida</h2>
        <p className="mt-0.5 text-xs text-ink-secondary">
          Ko sme da unosi i menja sate u Kadrovska → Mesečni grid. Sinhronizovano sa{' '}
          <code className="rounded bg-surface-2 px-1 text-2xs">kadr_grid_editor_allowlist</code>.
        </p>
      </div>

      {/* Forma: dodaj urednika */}
      <div className="rounded-panel border border-line bg-surface p-3">
        {err && <p className="mb-2 rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <FormField label="Email" required>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ime@servoteh.com"
                autoComplete="off"
                onKeyDown={(e) => e.key === 'Enter' && add()}
              />
            </FormField>
          </div>
          <div className="min-w-[220px] flex-1">
            <FormField label="Napomena">
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="npr. HR — mesečni grid"
                onKeyDown={(e) => e.key === 'Enter' && add()}
              />
            </FormField>
          </div>
          <Button onClick={add} loading={addM.isPending}>
            Dodaj
          </Button>
        </div>
      </div>

      {/* Tabela */}
      {q.isLoading ? (
        <p className="py-8 text-center text-sm text-ink-disabled">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <EmptyState title="Nema urednika grida" />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase text-ink-secondary">
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Napomena</th>
                <th className="px-3 py-2">Dodato</th>
                <th className="px-3 py-2 text-right">Akcije</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.email} className="border-b border-line-soft hover:bg-surface-2">
                  <td className="px-3 py-2 font-mono text-xs text-ink">{r.email}</td>
                  <td className="px-3 py-2 text-ink-secondary">{r.note || '—'}</td>
                  <td className="px-3 py-2 tnums text-ink-secondary">{r.createdAt ? formatDate(r.createdAt) : '—'}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end">
                      <button
                        onClick={() => remove(r.email)}
                        title={`Ukloni ${r.email}`}
                        aria-label={`Ukloni ${r.email}`}
                        className="rounded p-1 text-ink-secondary hover:bg-surface-2 hover:text-status-danger"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
