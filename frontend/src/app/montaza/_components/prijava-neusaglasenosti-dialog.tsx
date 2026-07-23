'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { AttachmentInput } from '@/components/ui-kit/attachment-input';
import { toast } from '@/lib/toast';
import {
  NC_SEVERITIES,
  NC_SEVERITY_LABEL,
  NC_LOCATION_KINDS,
  NC_LOCATION_LABEL,
  useAddNonconformityPhotos,
  useCreateNonconformity,
  type NcLocationKind,
  type NcSeverity,
} from '@/api/montaza-neusaglasenosti';
import { PredmetPicker, type PredmetSelection } from './predmet-picker';

const MAX_PHOTOS = 6;

/**
 * Prijava neusaglašenosti na montaži (zahtev 004/26) — fork obrasca
 * `prijava-kvara-dialog.tsx`. Prijavljuju svi sa pristupom Montaži; svaka prijava
 * obaveštava menadžment (backend: zvonce + mejl). Deli ga desktop tab i /m/montaza
 * (responsive 360px, kamera primarni tok kroz AttachmentInput). Predmet je obavezan
 * (postojeći montaža predmet-picker); crtež/RN opciono; ozbiljnost/lokacija segmentirano.
 */
export function PrijavaNeusaglasenostiDialog({
  onClose,
  onCreated,
  fixedProject,
}: {
  onClose: () => void;
  onCreated?: (id: number) => void;
  /** Prefill predmeta (npr. kad se otvara iz konteksta projekta). */
  fixedProject?: { projectNumber: string; projectId?: number | null };
}) {
  const [predmet, setPredmet] = useState<{ number: string; id: number | null } | null>(
    fixedProject
      ? { number: fixedProject.projectNumber, id: fixedProject.projectId ?? null }
      : null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<NcSeverity>('SREDNJA');
  const [locationKind, setLocationKind] = useState<NcLocationKind>('SERVOTEH');
  const [locationNote, setLocationNote] = useState('');
  const [drawingNumber, setDrawingNumber] = useState('');
  const [workOrderCode, setWorkOrderCode] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const create = useCreateNonconformity();
  const addPhotos = useAddNonconformityPhotos();
  const busy = create.isPending || addPhotos.isPending;

  function onPredmet(sel: PredmetSelection) {
    setPredmet({ number: sel.predmet_broj, id: sel.predmet_item_id });
  }

  async function submit() {
    setErr(null);
    if (!predmet?.number) return setErr('Izaberite predmet.');
    if (!description.trim()) return setErr('Opis problema je obavezan.');
    if (locationKind === 'TEREN' && !locationNote.trim())
      return setErr('Za teren unesite lokaciju.');

    try {
      const res = await create.mutateAsync({
        projectNumber: predmet.number,
        projectId: predmet.id ?? undefined,
        description: description.trim(),
        severity,
        locationKind,
        locationNote: locationKind === 'TEREN' ? locationNote.trim() : undefined,
        drawingNumber: drawingNumber.trim() || undefined,
        workOrderCode: workOrderCode.trim() || undefined,
      });
      const id = res.data.id;
      if (files.length) {
        try {
          await addPhotos.mutateAsync({ id, files });
        } catch {
          toast('Neusaglašenost je prijavljena; deo fotografija nije otpremljen.');
        }
      }
      toast(`Neusaglašenost ${res.data.reportNumber} je prijavljena.`);
      onCreated?.(id);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        dismissable={false}
        size="lg"
        title="Prijavi neusaglašenost"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Otkaži
            </Button>
            <Button onClick={submit} loading={busy}>
              Prijavi
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {err && (
            <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
              {err}
            </p>
          )}

          <FormField label="Predmet" required hint="Broj predmeta na kom je nastala neusaglašenost.">
            <div className="flex items-center gap-2">
              <div className="min-h-9 flex-1 rounded-control border border-line bg-surface-2 px-3 py-2 text-sm text-ink">
                {predmet?.number ? (
                  <span className="tnums font-medium">{predmet.number}</span>
                ) : (
                  <span className="text-ink-disabled">— nije izabran —</span>
                )}
              </div>
              <Button
                variant="secondary"
                onClick={() => setPickerOpen(true)}
                disabled={!!fixedProject}
              >
                {predmet ? 'Izmeni' : 'Izaberi'}
              </Button>
            </div>
          </FormField>

          <FormField label="Opis problema" required>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Odstupanje od crteža, deo ne može da se ugradi, loše zavarivanje/farbanje…"
              autoFocus
            />
          </FormField>

          <FormField label="Ozbiljnost" required>
            <div className="flex gap-2">
              {NC_SEVERITIES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSeverity(s)}
                  className={`flex-1 rounded-control border px-3 py-1.5 text-sm ${
                    severity === s
                      ? 'border-accent bg-accent-subtle text-ink'
                      : 'border-line text-ink-secondary'
                  }`}
                >
                  {NC_SEVERITY_LABEL[s]}
                </button>
              ))}
            </div>
          </FormField>

          <FormField label="Mesto" required>
            <div className="flex gap-2">
              {NC_LOCATION_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setLocationKind(k)}
                  className={`flex-1 rounded-control border px-3 py-1.5 text-sm ${
                    locationKind === k
                      ? 'border-accent bg-accent-subtle text-ink'
                      : 'border-line text-ink-secondary'
                  }`}
                >
                  {NC_LOCATION_LABEL[k]}
                </button>
              ))}
            </div>
          </FormField>

          {locationKind === 'TEREN' && (
            <FormField label="Lokacija (teren)" required>
              <Input
                value={locationNote}
                onChange={(e) => setLocationNote(e.target.value)}
                placeholder="Gde na terenu (objekat / grad / gradilište)"
              />
            </FormField>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label="Broj crteža" hint="Opciono.">
              <Input
                value={drawingNumber}
                onChange={(e) => setDrawingNumber(e.target.value)}
                placeholder="npr. 123-45-06"
              />
            </FormField>
            <FormField label="Radni nalog (RN)" hint="Opciono.">
              <Input
                value={workOrderCode}
                onChange={(e) => setWorkOrderCode(e.target.value)}
                placeholder="npr. 06/93-4"
              />
            </FormField>
          </div>

          <FormField label="Fotografije" hint={`Slikaj ili priloži (do ${MAX_PHOTOS}).`}>
            <AttachmentInput
              value={files}
              onChange={setFiles}
              onReject={(m) => toast(m)}
              max={MAX_PHOTOS}
            />
          </FormField>
        </div>
      </Dialog>

      <PredmetPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={onPredmet}
      />
    </>
  );
}
