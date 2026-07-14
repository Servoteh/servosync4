'use client';

import { useState } from 'react';
import { Camera } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { useAttachIncidentFiles, useMachines, useReportIncident, type IncidentSeverity } from '@/api/odrzavanje';
import { SEVERITY_LABEL } from './common';

const SEVERITIES: IncidentSeverity[] = ['minor', 'major', 'critical'];

/**
 * Prijava kvara (REPORT — opšte pravo, F6). Naslov/ozbiljnost/opis/foto/bezbednosni
 * rizik. Foto ide kroz `maint_attach_incident_files` RPC (prijavilac sme, F3).
 * `fixedMachine` fiksira mašinu (poziv iz kartona / mobilnog kartona sredstva).
 */
export function PrijavaKvaraDialog({
  onClose,
  fixedMachine,
}: {
  onClose: () => void;
  fixedMachine?: { code: string; name?: string };
}) {
  const [machineCode, setMachineCode] = useState(fixedMachine?.code ?? '');
  const [machineQ, setMachineQ] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<IncidentSeverity>('minor');
  const [safety, setSafety] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const machines = useMachines({ q: machineQ, pageSize: 50 });
  const report = useReportIncident();
  const attach = useAttachIncidentFiles();
  const busy = report.isPending || attach.isPending;

  function submit() {
    setErr(null);
    if (!machineCode) return setErr('Izaberite mašinu.');
    if (!title.trim()) return setErr('Naslov je obavezan.');
    report.mutate(
      { machineCode, title, description: description || undefined, severity, safetyMarker: safety },
      {
        onSuccess: async (res) => {
          const id = (res.data as { id?: string })?.id;
          if (id && files.length) {
            try {
              await attach.mutateAsync({ id, files });
            } catch {
              /* prijava je prošla; foto best-effort */
            }
          }
          onClose();
        },
        onError: (e) => setErr((e as Error).message),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Prijava kvara"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Otkaži</Button>
          <Button onClick={submit} loading={busy}>Prijavi</Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}

        {fixedMachine ? (
          <FormField label="Mašina">
            <div className="rounded-control border border-line bg-surface-2 px-3 py-2 text-sm text-ink">
              {fixedMachine.code}{fixedMachine.name ? ` · ${fixedMachine.name}` : ''}
            </div>
          </FormField>
        ) : (
          <FormField label="Mašina" required>
            <Input value={machineQ} onChange={(e) => setMachineQ(e.target.value)} placeholder="Pretraga mašine…" className="mb-2" />
            <select value={machineCode} onChange={(e) => setMachineCode(e.target.value)} className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink">
              <option value="">{machines.isLoading ? 'Učitavanje…' : '— izaberi mašinu —'}</option>
              {(machines.data?.data ?? []).map((m) => (
                <option key={m.machineCode} value={m.machineCode}>{m.machineCode} · {m.name}</option>
              ))}
            </select>
          </FormField>
        )}

        <FormField label="Naslov" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Šta ne radi" />
        </FormField>
        <FormField label="Ozbiljnost">
          <div className="flex gap-2">
            {SEVERITIES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSeverity(s)}
                className={`flex-1 rounded-control border px-3 py-1.5 text-sm ${severity === s ? 'border-accent bg-accent-subtle text-ink' : 'border-line text-ink-secondary'}`}
              >
                {SEVERITY_LABEL[s]}
              </button>
            ))}
          </div>
        </FormField>
        <FormField label="Opis">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Detalji, okolnosti…" />
        </FormField>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={safety} onChange={(e) => setSafety(e.target.checked)} />
          Bezbednosni rizik
        </label>

        <FormField label="Fotografije">
          <label className="flex cursor-pointer items-center gap-2 rounded-control border border-dashed border-line px-3 py-2 text-sm text-ink-secondary hover:bg-surface-2">
            <Camera className="h-4 w-4" aria-hidden />
            {files.length ? `${files.length} slika izabrano` : 'Dodaj slike'}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              className="hidden"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 10))}
            />
          </label>
        </FormField>
      </div>
    </Dialog>
  );
}
