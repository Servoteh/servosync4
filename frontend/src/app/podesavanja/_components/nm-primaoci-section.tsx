'use client';

import { useState } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { ApiError } from '@/api/client';
import { toast } from '@/lib/toast';
import { formatDate } from '@/lib/format';
import { useNmPrimaoci, useAddNmPrimalac, useRemoveNmPrimalac } from '@/api/podesavanja';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Podešavanja → Notifikacije: primaoci obaveštenja o NEUSAGLAŠENOSTI NA MONTAŽI
 * (zahtev 034/26 — Zoranova lista, „Nenad Jaraković može da koriguje"). Obrazac
 * `grid-editors-tab.tsx` (add: POST, 409 = već postoji; ukloni: DELETE + confirm —
 * na backendu je SOFT, istorija ostaje). Tab je pod SETTINGS_SYSTEM (samo admin),
 * isto važi i za rute — ovde nema dodatnog gating-a.
 *
 * Promena važi od SLEDEĆE prijave: mejl i zvonce čitaju tabelu pri svakom slanju.
 */
export function NmPrimaociSection() {
  const q = useNmPrimaoci();
  const addM = useAddNmPrimalac();
  const removeM = useRemoveNmPrimalac();
  const rows = q.data?.data ?? [];

  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    setErr(null);
    const e = email.trim();
    const n = fullName.trim();
    if (!e) return setErr('Unesi email.');
    if (!EMAIL_RE.test(e)) return setErr('Neispravan email format.');
    if (rows.some((r) => r.email.toLowerCase() === e.toLowerCase())) {
      return setErr('Email je već na listi primalaca.');
    }
    try {
      await addM.mutateAsync({ email: e, fullName: n || undefined });
      toast('Dodato');
      setEmail('');
      setFullName('');
    } catch (ex) {
      if (ex instanceof ApiError && ex.status === 409) {
        setErr('Već postoji.');
      } else {
        setErr(ex instanceof ApiError ? ex.message : 'Dodavanje nije uspelo.');
      }
    }
  }

  function remove(target: string) {
    if (!confirm(`Ukloniti ${target} sa liste primalaca?`)) return;
    removeM.mutate(
      { email: target },
      {
        onSuccess: () => toast('Uklonjeno'),
        onError: (ex) => toast(ex instanceof ApiError ? `⚠ ${ex.message}` : '⚠ Uklanjanje nije uspelo'),
      },
    );
  }

  return (
    <section className="space-y-3 rounded-panel border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-control bg-surface-2 text-ink-secondary">
          <AlertTriangle className="h-4 w-4" aria-hidden />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-ink">Neusaglašenosti na montaži — primaoci obaveštenja</h3>
          <p className="mt-0.5 text-xs text-ink-secondary">
            Ko dobija mejl i zvonce na svaku novu prijavu neusaglašenosti (zahtev 034/26). Promena
            važi od sledeće prijave. Zvonce stiže samo primaocima čiji nalog ima vezanog radnika —
            mejl stiže svima sa liste.
          </p>
        </div>
      </div>

      {/* Forma: dodaj primaoca */}
      <div className="rounded-control border border-line bg-surface-2/50 p-3">
        {err && <p className="mb-2 rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <FormField label="Email" required>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ime.prezime@servoteh.com"
                autoComplete="off"
                onKeyDown={(e) => e.key === 'Enter' && add()}
              />
            </FormField>
          </div>
          <div className="min-w-[180px] flex-1">
            <FormField label="Ime i prezime">
              <Input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="npr. Zoran Jaraković"
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
        <p className="py-6 text-center text-sm text-ink-disabled">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nema primalaca"
          hint="Dok je lista prazna, obaveštenja o neusaglašenosti se NE šalju nikome."
        />
      ) : (
        <div className="overflow-x-auto rounded-control border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase text-ink-secondary">
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Ime</th>
                <th className="px-3 py-2">Dodato</th>
                <th className="px-3 py-2 text-right">Akcije</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.email} className="border-b border-line-soft hover:bg-surface-2">
                  <td className="px-3 py-2 font-mono text-xs text-ink">{r.email}</td>
                  <td className="px-3 py-2 text-ink-secondary">{r.fullName || '—'}</td>
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
    </section>
  );
}
