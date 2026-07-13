'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import {
  newClientEventId,
  useCreateDraftTema,
  useDraftReview,
  useDraftTeme,
  useDraftUvedi,
  useSastanci,
  useTeme,
} from '@/api/sastanci';
import { INPUT_CLS, TEMA_OBLASTI, TEMA_VRSTE } from './common';

/**
 * Draft teme tok (predlog → pregled → usvajanje → uvedi na sastanak) — paritet 1.0
 * draftTemePanel. Izbor projekta izveden iz postojećih tema (vidi napomenu u
 * po-projektu-tab: nedostaje sy15 projects-by-uuid lookup — R4).
 */
export function DraftTemeTab() {
  const temeQ = useTeme({});
  const [projektId, setProjektId] = useState<string>('');
  const drafts = useDraftTeme(projektId || null);
  const planiraniQ = useSastanci({ status: 'planiran', pageSize: 100 });
  const createDraft = useCreateDraftTema();
  const review = useDraftReview();
  const uvedi = useDraftUvedi();

  const [naslov, setNaslov] = useState('');
  const [vrsta, setVrsta] = useState('tema');
  const [oblast, setOblast] = useState('opste');
  const [error, setError] = useState<string | null>(null);

  const projects = useMemo(() => {
    const s = new Set<string>();
    for (const t of temeQ.data?.data ?? []) if (t.projekat_id) s.add(t.projekat_id);
    return [...s];
  }, [temeQ.data]);

  const planirani = planiraniQ.data?.data ?? [];

  async function addDraft() {
    setError(null);
    if (!projektId) return setError('Izaberi projekat.');
    if (!naslov.trim()) return setError('Naslov je obavezan.');
    try {
      await createDraft.mutateAsync({
        clientEventId: newClientEventId(),
        projektId,
        naslov: naslov.trim(),
        vrsta,
        oblast,
      });
      setNaslov('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kreiranje nije uspelo.');
    }
  }

  const rows = drafts.data?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <FormField label="Projekat">
          <select className={`${INPUT_CLS} w-64`} value={projektId} onChange={(e) => setProjektId(e.target.value)}>
            <option value="">— izaberi projekat —</option>
            {projects.map((p) => (
              <option key={p} value={p}>{p.slice(0, 8)}…</option>
            ))}
          </select>
        </FormField>
      </div>

      {projektId && (
        <>
          <section className="space-y-2 rounded-panel border border-line bg-surface p-4">
            <h3 className="text-sm font-semibold text-ink">Predloži nacrt teme</h3>
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="sm:col-span-2">
                <FormField label="Naslov">
                  <input className={INPUT_CLS} value={naslov} onChange={(e) => setNaslov(e.target.value)} />
                </FormField>
              </div>
              <FormField label="Vrsta">
                <select className={INPUT_CLS} value={vrsta} onChange={(e) => setVrsta(e.target.value)}>
                  {Object.entries(TEMA_VRSTE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </FormField>
              <FormField label="Oblast">
                <select className={INPUT_CLS} value={oblast} onChange={(e) => setOblast(e.target.value)}>
                  {Object.entries(TEMA_OBLASTI).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </FormField>
            </div>
            {error && <p className="text-sm text-status-danger">{error}</p>}
            <Button loading={createDraft.isPending} onClick={() => void addDraft()}>+ Predloži</Button>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">Nacrti tema</h3>
            {drafts.isLoading ? (
              <p className="text-sm text-ink-secondary">Učitavanje…</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-ink-secondary">Nema nacrta za ovaj projekat.</p>
            ) : (
              <ul className="space-y-2">
                {rows.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-panel border border-line bg-surface px-3 py-2">
                    <span className="flex-1 text-sm text-ink">{t.naslov}</span>
                    <Button variant="secondary" onClick={() => review.mutate({ id: t.id, odluka: 'aktivna' })}>Usvoji</Button>
                    <Button variant="ghost" onClick={() => review.mutate({ id: t.id, odluka: 'odbijena' })}>Odbij</Button>
                    <select
                      className={`${INPUT_CLS} w-48`}
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value) uvedi.mutate({ id: t.id, sastanakId: e.target.value });
                      }}
                    >
                      <option value="">Uvedi na sastanak…</option>
                      {planirani.map((s) => (
                        <option key={s.id} value={s.id}>{s.naslov}</option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
