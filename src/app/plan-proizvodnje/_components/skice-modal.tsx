'use client';

import { useState } from 'react';
import { Trash2, Upload, FileText } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { ApiError } from '@/api/client';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import {
  useDrawings,
  useUploadDrawing,
  useDeleteDrawing,
  fetchDrawingSignUrl,
  type PpDrawing,
} from '@/api/plan-proizvodnje';

/** Skice operacije (production-drawings): upload/galerija/soft-delete + signed URL (gate C3). */
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
  const rows = q.data?.data ?? [];

  async function onUpload(file: File | undefined) {
    if (!file) return;
    setErr(null);
    try {
      await upload.mutateAsync({ workOrder, line, file });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Upload nije uspeo.');
    }
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

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Skice · RN ${workOrder} / linija ${line}`}
      footer={
        canEdit ? (
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink hover:bg-surface-2">
            <Upload className="h-4 w-4" /> Dodaj skicu
            <input type="file" className="hidden" onChange={(e) => onUpload(e.target.files?.[0])} />
          </label>
        ) : undefined
      }
    >
      {q.isLoading ? (
        <div className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</div>
      ) : rows.length === 0 ? (
        <div className="py-8 text-center text-sm text-ink-disabled">Nema skica.</div>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((d) => (
            <li key={d.id} className="flex items-center gap-2 rounded-control border border-line px-3 py-2">
              <FileText className="h-4 w-4 text-ink-secondary" aria-hidden />
              <button onClick={() => open(d)} className="flex-1 truncate text-left text-sm text-accent hover:underline">
                {d.fileName}
              </button>
              {canEdit && (
                <button
                  onClick={() => remove.mutate({ id: d.id })}
                  className="rounded-control p-1 text-status-danger hover:bg-status-danger-bg"
                  aria-label="Obriši skicu"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {err && <p className="mt-2 text-sm text-status-danger">{err}</p>}
    </Dialog>
  );
}
