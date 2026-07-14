'use client';

import { useState } from 'react';
import { Sparkles, Upload, X } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { ApiError } from '@/api/client';
import {
  aiGenerate,
  newClientId,
  useCreateReport,
  useUploadPhotos,
  MONTAZA_STATUS_LABELS,
  type AiGenerateOut,
} from '@/api/plan-montaze';

const MAX_PHOTOS = 16;

async function fileToB64(file: File): Promise<{ media_type: string; data: string }> {
  const buf = await file.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return { media_type: file.type || 'image/jpeg', data: btoa(bin) };
}

type Step = 'unos' | 'pregled';

/** Kreiranje izveštaja montera: slobodan tekst + fotke → AI strukturira → pregled/dopune → snimi. */
export function ReportCreate({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState<Step>('unos');
  const [tekst, setTekst] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [out, setOut] = useState<AiGenerateOut | null>(null);
  const [aiModel, setAiModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = useCreateReport();
  const uploadPhotos = useUploadPhotos();

  function reset() {
    setStep('unos');
    setTekst('');
    setFiles([]);
    setOut(null);
    setErr(null);
  }
  function close() {
    reset();
    onClose();
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    setFiles((prev) => [...prev, ...Array.from(list)].slice(0, MAX_PHOTOS));
  }

  async function runAi() {
    setErr(null);
    if (!tekst.trim() && files.length === 0) {
      setErr('Unesi tekst ili priloži fotke.');
      return;
    }
    setBusy(true);
    try {
      const slike = await Promise.all(files.map(fileToB64));
      const res = await aiGenerate({ tekst, slike });
      setOut(res.data);
      setAiModel((res.meta?.model as string) ?? null);
      setStep('pregled');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'AI strukturiranje nije uspelo.');
    } finally {
      setBusy(false);
    }
  }

  function patchOut<K extends keyof AiGenerateOut>(k: K, v: AiGenerateOut[K]) {
    setOut((o) => (o ? { ...o, [k]: v } : o));
  }

  async function save() {
    if (!out) return;
    setErr(null);
    setBusy(true);
    const id = newClientId();
    try {
      await create.mutateAsync({
        id,
        status: out.status,
        datum: out.datum,
        predmetItemId: out.predmet_item_id,
        predmet: out.predmet,
        nazivProjekta: out.naziv_projekta,
        klijent: out.klijent,
        lokacija: out.lokacija,
        pocetakRada: out.pocetak_rada,
        krajRada: out.kraj_rada,
        opisRadova: out.opis_radova,
        problemi: out.problemi,
        otvoreneStavke: out.otvorene_stavke,
        dodatniClanovi: out.dodatni_clanovi_tima,
        siroviTekst: tekst,
        aiModel: aiModel ?? undefined,
        aiJson: out as unknown as Record<string, unknown>,
      });
      if (files.length) {
        try {
          await uploadPhotos.mutateAsync({ id, files });
        } catch {
          /* fotke se mogu ponoviti kasnije (ciljani retry) */
        }
      }
      close();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Snimanje izveštaja nije uspelo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={step === 'unos' ? 'Novi izveštaj — unos' : 'Novi izveštaj — pregled'}
      footer={
        step === 'unos' ? (
          <>
            <Button variant="secondary" onClick={close}>Otkaži</Button>
            <Button onClick={runAi} loading={busy}>
              <Sparkles className="h-4 w-4" /> AI strukturiraj
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={() => setStep('unos')}>Nazad</Button>
            <Button onClick={save} loading={busy}>Sačuvaj</Button>
          </>
        )
      }
    >
      {step === 'unos' ? (
        <div className="space-y-3">
          <FormField label="Slobodan tekst (šta je urađeno)">
            <textarea
              value={tekst}
              onChange={(e) => setTekst(e.target.value)}
              rows={6}
              placeholder="Npr. Danas na predmetu 9400/2 u Dobanovcima montirali smo…"
              className="w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink"
            />
          </FormField>
          <div>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink hover:bg-surface-2">
              <Upload className="h-4 w-4" /> Dodaj fotke ({files.length}/{MAX_PHOTOS})
              <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
            </label>
            {files.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {files.map((f, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink">
                    {f.name.slice(0, 18)}
                    <button onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} aria-label="Ukloni">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
          {err && <p className="text-sm text-status-danger">{err}</p>}
        </div>
      ) : out ? (
        <div className="space-y-3">
          {out.nedostajuci_podaci.length > 0 && (
            <div className="rounded-control bg-status-warn-bg px-3 py-2 text-xs text-status-warn">
              Nedostaju: {out.nedostajuci_podaci.join(', ')}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Datum">
              <Input value={out.datum} onChange={(e) => patchOut('datum', e.target.value)} />
            </FormField>
            <FormField label="Status">
              <select
                value={out.status}
                onChange={(e) => patchOut('status', e.target.value)}
                className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
              >
                {Object.entries(MONTAZA_STATUS_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Predmet">
              <Input value={out.predmet} onChange={(e) => patchOut('predmet', e.target.value)} />
            </FormField>
            <FormField label="Klijent">
              <Input value={out.klijent} onChange={(e) => patchOut('klijent', e.target.value)} />
            </FormField>
            <FormField label="Lokacija">
              <Input value={out.lokacija} onChange={(e) => patchOut('lokacija', e.target.value)} />
            </FormField>
            <FormField label="Naziv projekta">
              <Input value={out.naziv_projekta} onChange={(e) => patchOut('naziv_projekta', e.target.value)} />
            </FormField>
            <FormField label="Početak rada">
              <Input value={out.pocetak_rada} onChange={(e) => patchOut('pocetak_rada', e.target.value)} />
            </FormField>
            <FormField label="Kraj rada">
              <Input value={out.kraj_rada} onChange={(e) => patchOut('kraj_rada', e.target.value)} />
            </FormField>
          </div>
          <FormField label="Opis radova">
            <textarea
              value={out.opis_radova}
              onChange={(e) => patchOut('opis_radova', e.target.value)}
              rows={3}
              className="w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink"
            />
          </FormField>
          <FormField label="Problemi">
            <textarea
              value={out.problemi}
              onChange={(e) => patchOut('problemi', e.target.value)}
              rows={2}
              className="w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink"
            />
          </FormField>
          <FormField label="Otvorene stavke">
            <textarea
              value={out.otvorene_stavke}
              onChange={(e) => patchOut('otvorene_stavke', e.target.value)}
              rows={2}
              className="w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink"
            />
          </FormField>
          {files.length > 0 && (
            <p className="text-xs text-ink-secondary">Priloženo fotki: {files.length} (snimaju se uz izveštaj).</p>
          )}
          {err && <p className="text-sm text-status-danger">{err}</p>}
        </div>
      ) : null}
    </Dialog>
  );
}
