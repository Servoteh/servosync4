'use client';

import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { AttachmentInput } from '@/components/ui-kit/attachment-input';
import { DictateButton } from '@/components/voice-controls';
import { toast } from '@/lib/toast';
import { apiFetch } from '@/api/client';
import {
  useAssets,
  useAttachIncidentFiles,
  useReportIncident,
  useSetStatusOverride,
  type AssetPickerRow,
  type AssetType,
  type IncidentDetail,
  type IncidentSeverity,
  type MaintMe,
} from '@/api/odrzavanje';
import { ASSET_TYPE_LABEL, SEVERITY_LABEL } from './common';
import { WoDetailDialog } from './wo-detail-dialog';

const SEVERITIES: IncidentSeverity[] = ['minor', 'major', 'critical'];
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
const MAX_PHOTOS = 10;

/**
 * Prijava kvara (REPORT — opšte pravo, F6). H23: picker SVIH sredstava (mašina/vozilo/
 * IT/objekat) + „Sredstvo je u zastoju" (samo mašine → override down) + auto-WO ponuda +
 * foto. Paritet 1.0 maintDialogs.js:112-387. Incidenti svih tipova ključaju se po
 * `asset_code` u koloni `machine_code` (§5.1 pravilo 24) → machineCode = assetCode.
 * `fixedMachine` fiksira mašinu (poziv iz kartona mašine); `fixedAsset` fiksira bilo koje
 * sredstvo sa assetId+assetType (poziv iz kartona vozila/IT/objekta — nosi tačan assetType).
 */
export function PrijavaKvaraDialog({
  onClose,
  me,
  fixedMachine,
  fixedAsset,
  onReported,
}: {
  onClose: () => void;
  me?: MaintMe | undefined;
  fixedMachine?: { code: string; name?: string };
  fixedAsset?: { code: string; name?: string; assetId: string; assetType: AssetType };
  onReported?: (incidentId: string) => void;
}) {
  const fixed = fixedAsset
    ? fixedAsset
    : fixedMachine
      ? { code: fixedMachine.code, name: fixedMachine.name, assetId: undefined as string | undefined, assetType: 'machine' as AssetType }
      : undefined;
  const [assetCode, setAssetCode] = useState<string>(fixed?.code ?? '');
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

  const selected: AssetPickerRow | undefined = fixed
    ? undefined
    : assets.find((a) => a.assetCode === assetCode);
  const isMachine = fixed ? fixed.assetType === 'machine' : selected?.assetType === 'machine';

  async function submit() {
    setErr(null);
    if (!assetCode) return setErr('Izaberite sredstvo.');
    if (!title.trim()) return setErr('Naslov je obavezan.');
    report.mutate(
      {
        machineCode: assetCode,
        ...(fixed?.assetId
          ? { assetId: fixed.assetId, assetType: fixed.assetType }
          : selected && !fixed
            ? { assetId: selected.assetId, assetType: selected.assetType }
            : {}),
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
      dismissable={false}
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

        {fixed ? (
          <FormField label="Sredstvo">
            <div className="rounded-control border border-line bg-surface-2 px-3 py-2 text-sm text-ink">
              {fixed.code}{fixed.name ? ` · ${fixed.name}` : ''}
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
          <div className="flex items-center gap-2">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Kratak opis kvara" className="flex-1" />
            <DictateButton onText={(t) => setTitle((v) => (v ? `${v} ${t}` : t))} title="Izdiktiraj naslov" />
          </div>
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
        {/*
          Diktiranje (STT) uz opis: kvar se prijavljuje IZ POGONA, često masnim rukama
          i sa telefona — kucanje je tu najveća prepreka. `DictateButton` je presečna
          infra (zapisnik/montaža/kadrovska), pa ovde nema novog koda ni zavisnosti.
        */}
        <FormField label="Opis" hint="Možeš i da izdiktiraš — mikrofon desno.">
          <div className="flex items-start gap-2">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Detalji, okolnosti…" className="flex-1" />
            <DictateButton onText={(t) => setDescription((v) => (v ? `${v}\n${t}` : t))} title="Izdiktiraj opis kvara" />
          </div>
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

        {/*
          Kit `AttachmentInput` umesto sirovog inputa: na /mob/odrzavanje je kamera
          primarni tok, a slike se sada i smanjuju (JPEG ≤1568px, EXIF rotacija) pre
          slanja — ranije je sirov HEIC/12 MP original odlazio u storage kakav jeste,
          pa se posle nije mogao prikazati (BE ovde ne validira format).
        */}
        <FormField label="Fotografije" hint={`Slikaj kvar telefonom ili priloži sliku (do ${MAX_PHOTOS}).`}>
          <AttachmentInput
            value={files}
            onChange={setFiles}
            onReject={(m) => toast(m)}
            max={MAX_PHOTOS}
            accept={['IMAGE']}
            maxBytes={MAX_PHOTO_BYTES}
            disabled={busy}
          />
        </FormField>
      </div>
    </Dialog>
  );
}
