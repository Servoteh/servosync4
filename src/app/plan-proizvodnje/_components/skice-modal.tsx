'use client';

import { useEffect, useRef, useState } from 'react';
import { Trash2, Upload, FileText } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { ApiError } from '@/api/client';
import { toast } from '@/lib/toast';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import {
  useDrawings,
  useUploadDrawing,
  useDeleteDrawing,
  fetchDrawingSignUrl,
  type PpDrawing,
} from '@/api/plan-proizvodnje';

/**
 * Skice operacije — Drawing Manager (GAP-PM-19): upload zona klik+drag-drop MULTIPLE,
 * MIME whitelist + 20MB limit (kanon = SQL bucket, ne BE 25MB) sa warn toastovima po
 * fajlu, sekvencijalni upload sa progresom „Uploadujem i/N", thumbnail GALERIJA (signed
 * img / PDF ikona, meta: naziv/KB/datum/uploader), CONFIRM pre soft-delete-a, sort desc
 * (najnovije prvo). Brojač skica je na dugmetu u OpsTable (drawings_count).
 */

const ALLOWED_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];
const MAX_BYTES = 20 * 1024 * 1024; // sinhronizovano sa SQL bucket limitom (1.0 kanon)

function isAllowed(f: File): boolean {
  return ALLOWED_MIMES.includes(f.type) || f.type.startsWith('image/');
}

export function SkiceModal({
  workOrder,
  line,
  onClose,
}: {
  workOrder: string;
  line: string;
  onClose: () => void;
}) {
  const q = useDrawings(workOrder, line);
  const upload = useUploadDrawing();
  const remove = useDeleteDrawing();
  const can = useCan();
  const canEdit = can(PERMISSIONS.PLAN_PROIZVODNJE_EDIT);
  const [err, setErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<{ i: number; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Sort desc — najnovije prvo (BE vraća asc, GAP-PM-19).
  const rows = [...(q.data?.data ?? [])].sort(
    (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
  );

  /** Validacija (MIME + veličina) sa warn toastom po fajlu → sekvencijalni upload sa progresom. */
  async function handleFiles(files: FileList | File[] | null | undefined) {
    if (!files) return;
    setErr(null);
    const list = Array.from(files);
    const valid: File[] = [];
    for (const f of list) {
      if (!isAllowed(f)) {
        toast(`⚠ „${f.name}" — nedozvoljen tip (samo slike i PDF).`);
        continue;
      }
      if (f.size > MAX_BYTES) {
        toast(`⚠ „${f.name}" — prevelik (max ${Math.round(MAX_BYTES / (1024 * 1024))} MB).`);
        continue;
      }
      valid.push(f);
    }
    if (valid.length === 0) return;
    for (let i = 0; i < valid.length; i++) {
      setProgress({ i: i + 1, total: valid.length });
      try {
        await upload.mutateAsync({ workOrder, line, file: valid[i] });
      } catch (e) {
        setErr(e instanceof ApiError ? e.message : `Upload „${valid[i].name}" nije uspeo.`);
      }
    }
    setProgress(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  async function open(d: PpDrawing) {
    setErr(null);
    try {
      const res = await fetchDrawingSignUrl(d.id);
      window.open(res.data.url, '_blank');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Nemate pravo na crtež ili nije dostupan.');
    }
  }

  function confirmRemove(d: PpDrawing) {
    if (window.confirm(`Obrisati skicu „${d.fileName}"?`)) remove.mutate({ id: d.id });
  }

  return (
    <Dialog open onClose={onClose} title={`Skice · RN ${workOrder} / linija ${line}`}>
      {canEdit && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleFiles(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          className={`mb-3 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-panel border-2 border-dashed px-4 py-6 text-center text-sm transition-colors ${
            dragOver ? 'border-accent bg-surface-2 text-ink' : 'border-line text-ink-secondary hover:bg-surface-2'
          }`}
        >
          <Upload className="h-5 w-5" />
          {progress ? (
            <span>Uploadujem {progress.i}/{progress.total}…</span>
          ) : (
            <span>Prevuci slike/PDF ovde ili klikni za izbor (max 20 MB po fajlu)</span>
          )}
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>
      )}

      {q.isLoading ? (
        <div className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</div>
      ) : rows.length === 0 ? (
        <div className="py-8 text-center text-sm text-ink-disabled">Nema skica.</div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {rows.map((d) => (
            <DrawingCard key={d.id} d={d} canEdit={canEdit} onOpen={() => open(d)} onRemove={() => confirmRemove(d)} />
          ))}
        </div>
      )}
      {err && <p className="mt-2 text-sm text-status-danger">{err}</p>}
    </Dialog>
  );
}

/** Kartica skice: thumbnail (slika lazy-signed / PDF ikona) + meta naziv/KB/datum/uploader. */
function DrawingCard({
  d,
  canEdit,
  onOpen,
  onRemove,
}: {
  d: PpDrawing;
  canEdit: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const isImage = (d.mimeType ?? '').startsWith('image/');
  const sizeKb = d.sizeBytes ? Math.round(d.sizeBytes / 1024) : null;
  const [thumb, setThumb] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (isImage) {
      fetchDrawingSignUrl(d.id)
        .then((res) => {
          if (alive) setThumb(res.data.url);
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [d.id, isImage]);

  return (
    <div className="overflow-hidden rounded-panel border border-line bg-surface">
      <button onClick={onOpen} className="block aspect-[4/3] w-full bg-surface-2" title="Otvori u novom tabu">
        {isImage && thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt={d.fileName} className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-ink-disabled">
            <FileText className="h-8 w-8" />
          </span>
        )}
      </button>
      <div className="flex items-start gap-1 p-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-ink" title={d.fileName}>{d.fileName}</div>
          <div className="text-2xs text-ink-disabled">
            {sizeKb != null ? `${sizeKb} KB · ` : ''}{formatDate(d.uploadedAt)}
            {d.uploadedBy ? ` · ${d.uploadedBy}` : ''}
          </div>
        </div>
        {canEdit && (
          <button
            onClick={onRemove}
            className="rounded-control p-1 text-status-danger hover:bg-status-danger-bg"
            aria-label="Obriši skicu"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
