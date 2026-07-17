'use client';

import { useMemo, useState } from 'react';
import { Camera } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { toast } from '@/lib/toast';
import { apiFetch } from '@/api/client';
import {
  useAssets,
  useAttachIncidentFiles,
  useReportIncident,
  useSetStatusOverride,
  type AssetPickerRow,
  type IncidentDetail,
  type IncidentSeverity,
  type MaintMe,
} from '@/api/odrzavanje';
import { ASSET_TYPE_LABEL, SEVERITY_LABEL } from './common';
import { WoDetailDialog } from './wo-detail-dialog';

const SEVERITIES: IncidentSeverity[] = ['minor', 'major', 'critical'];
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;

/**
 * Prijava kvara (REPORT — opšte pravo, F6). H23: picker SVIH sredstava (mašina/vozilo/
 * IT/objekat) + „Sredstvo je u zastoju" (samo mašine → override down) + auto-WO ponuda +
 * foto. Paritet 1.0 maintDialogs.js:112-387. Incidenti svih tipova ključaju se po
 * `asset_code` u koloni `machine_code` (§5.1 pravilo 24) → machineCode = assetCode.
 * `fixedMachine` fiksira mašinu (poziv iz kartona).
 */
export function PrijavaKvaraDialog({
  onClose,
  me,
  fixedMachine,
  onReported,
}: {
  onClose: () => void;
  me?: MaintMe | undefined;
  fixedMachine?: { code: string; name?: string };
  onReported?: (incidentId: string) => void;
}) {
  const [assetCode, setAssetCode] = useState<string>(fixedMachine?.code ?? '');
  const [assetFilter, setAssetFilter] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<IncidentSeverity>('minor');
  const [safety, setSafety] = useState(false);
  const [markDown, setMarkDown] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [autoWoId, setAutoWoId] = useState<string | null>(null);
  const [showWo, setShowWo] = useState(false);

  const assetsQ = useAssets(undefined, true);
  const report = useReportIncident();
  const attach = useAttachIncidentFiles();
  const override = useSetStatusOverride();
  const busy = report.isPending || attach.isPending || override.isPending;

  const assets = assetsQ.data?.data ?? [];
  const filtered = useMemo(() => {
    const t = assetFilter.trim().toLowerCase();
    if (!t) return assets;
    return assets.filter((a) => `${a.assetCode} ${a.name} ${ASSET_TYPE_LABEL[a.assetType] ?? ''}`.toLowerCase().includes(t));
  }, [assets, assetFilter]);

  const selected: AssetPickerRow | undefined = fixedMachine
    ? undefined
    : assets.find((a) => a.assetCode === assetCode);
  const isMachine = fixedMachine ? true : selected?.assetType === 'machine';

  function addFiles(list: FileList | null) {
    const next: File[] = [];
    for (const f of Array.from(list ?? [])) {
      if (!f.type?.startsWith('image/')) continue;
      if (f.size > MAX_PHOTO_BYTES) { toast(`„${f.name}" veće od 25 MB — preskočeno`); continue; }
      next.push(f);
    }
    setFiles((prev) => [...prev, ...next].slice(0, 10));
  }

  async function submit() {
    setErr(null);
    if (!assetCode) return setErr('Izaberite sredstvo.');
    if (!title.trim()) return setErr('Naslov je obavezan.');
    report.mutate(
      {
        machineCode: assetCode,
        ...(selected && !fixedMachine ? { assetId: selected.assetId, assetType: selected.assetType } : {}),
        title: title.trim(),
        description: description || undefined,
        severity,
        safetyMarker: safety,
      },
      {
        onSuccess: async (res) => {
          const id = (res.data as { id?: string })?.id;
          if (!id) { onClose(); return; }
          // „Sredstvo u zastoju" (samo mašine): ODMAH override down (§5.1 pravilo 2).
          if (markDown && isMachine) {
            try {
              await override.mutateAsync({ code: assetCode, status: 'down', reason: `Kvar: ${title.trim()}`.slice(0, 200) });
            } catch {
              toast('Kvar prijavljen, ali status „Zastoj" nije postavljen (ovlašćenje/RLS).');
            }
          }
          if (files.length) {
            try { await attach.mutateAsync({ id, files }); } catch { toast('Kvar prijavljen; deo fotografija nije otpremljen.'); }
          }
          onReported?.(id);
          // Auto-WO: pročitaj detalj → ponudi otvaranje (paritet 1.0 auto-open, maintDialogs.js:373-383).
          try {
            const det = await apiFetch<{ data: IncidentDetail }>(`/v1/maintenance/incidents/${id}`);
            const wo = det.data.workOrder;
            if (wo?.woId) {
              toast(`Kreiran radni nalog ${wo.woNumber ?? ''}`.trim());
              setAutoWoId(wo.woId);
              return; // ostani otvoren radi ponude „Otvori nalog"
            }
          } catch { /* detalj best-effort */ }
          toast(severity === 'minor' ? 'Kvar prijavljen. Za manje kvarove nalog se ne kreira automatski.' : 'Kvar prijavljen.');
          onClose();
        },
        onError: (e) => setErr((e as Error).message),
      },
    );
  }

  // Ponuda otvaranja auto-kreiranog radnog naloga (paritet 1.0 auto-open, maintDialogs.js:373-383).
  if (autoWoId) {
    if (showWo) return <WoDetailDialog woId={autoWoId} me={me} onClose={onClose} />;
    return (
      <Dialog
        open
        onClose={onClose}
        title="Kvar prijavljen"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>Zatvori</Button>
            <Button onClick={() => setShowWo(true)}>Otvori nalog</Button>
          </>
        }
      >
        <p className="text-sm text-ink">Automatski je kreiran radni nalog za ovaj kvar. Otvorite ga radi dodele i obrade.</p>
      </Dialog>
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
          <FormField label="Sredstvo">
            <div className="rounded-control border border-line bg-surface-2 px-3 py-2 text-sm text-ink">
              {fixedMachine.code}{fixedMachine.name ? ` · ${fixedMachine.name}` : ''}
            </div>
          </FormField>
        ) : (
          <FormField label="Sredstvo" required hint="Mašina, vozilo, IT oprema ili objekat.">
            <Input value={assetFilter} onChange={(e) => setAssetFilter(e.target.value)} placeholder="Pretraga šifre ili naziva…" className="mb-2" />
            <select value={assetCode} onChange={(e) => setAssetCode(e.target.value)} className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink">
              <option value="">{assetsQ.isLoading ? 'Učitavanje…' : '— izaberi sredstvo —'}</option>
              {filtered.map((a) => (
                <option key={a.assetId} value={a.assetCode}>
                  [{ASSET_TYPE_LABEL[a.assetType] ?? a.assetType}] {a.assetCode} · {a.name}
                </option>
              ))}
            </select>
            {selected && <p className="mt-1 text-2xs text-ink-secondary">{ASSET_TYPE_LABEL[selected.assetType]} · {selected.assetCode} · {selected.name}</p>}
          </FormField>
        )}

        <FormField label="Naslov" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Kratak opis kvara" />
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
        <label className={`flex items-center gap-2 text-sm ${isMachine ? 'cursor-pointer text-ink' : 'cursor-not-allowed text-ink-disabled'}`}>
          <input type="checkbox" checked={markDown && isMachine} disabled={!isMachine} onChange={(e) => setMarkDown(e.target.checked)} />
          Sredstvo je u zastoju (postavi status „Zastoj")
        </label>
        {!isMachine && assetCode && <p className="text-2xs text-ink-secondary">Zastoj se automatski postavlja samo za mašine.</p>}

        <FormField label="Fotografije">
          <label className="flex cursor-pointer items-center gap-2 rounded-control border border-dashed border-line px-3 py-2 text-sm text-ink-secondary hover:bg-surface-2">
            <Camera className="h-4 w-4" aria-hidden />
            {files.length ? `${files.length} slika izabrano` : 'Dodaj slike'}
            <input type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          </label>
        </FormField>
      </div>
    </Dialog>
  );
}
