'use client';

import { useRef, useState } from 'react';
import { Download, Pencil, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { Dialog } from '@/components/ui-kit/dialog';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  signDocumentUrl,
  useDeleteDocument,
  useDocuments,
  useUpdateDocument,
  useUploadDocument,
  type MaintDocument,
} from '@/api/odrzavanje';
import { deadlineTone, isoToDateInput } from './common';

/** Kategorije dokumenata (1.0 DOC_CATEGORIES, maintDocumentsPanel.js:17-39). */
export const DOC_CATEGORIES: { id: string; label: string; hasExpiry?: boolean }[] = [
  /* Vozila-specifične kategorije (Sprint 2) — sa „važi do" rokom */
  { id: 'traffic_permit', label: 'Saobraćajna dozvola', hasExpiry: true },
  { id: 'insurance_policy', label: 'Polisa osiguranja', hasExpiry: true },
  { id: 'inspection_report', label: 'Tehnički pregled', hasExpiry: true },
  { id: 'leasing_contract', label: 'Leasing ugovor', hasExpiry: true },
  { id: 'service_invoice', label: 'Servisni račun' },
  { id: 'purchase_invoice', label: 'Račun za kupovinu' },
  /* Vozač-specifične kategorije (Sprint 6/8) */
  { id: 'drivers_license_scan', label: 'Vozačka dozvola (skenirana)', hasExpiry: true },
  { id: 'id_card_scan', label: 'Lična karta (skenirana)', hasExpiry: true },
  { id: 'medical_check_scan', label: 'Lekarski uput (skeniran)', hasExpiry: true },
  { id: 'driver_photo', label: 'Foto vozača' },
  /* Generičke kategorije */
  { id: 'manual', label: 'Uputstvo' },
  { id: 'photo', label: 'Fotografija' },
  { id: 'drawing', label: 'Tehnički crtež' },
  { id: 'service_report', label: 'Servisni izveštaj' },
  { id: 'warranty', label: 'Garancija', hasExpiry: true },
  { id: 'invoice', label: 'Račun' },
  { id: 'inspection', label: 'Inspekcija' },
  { id: 'other', label: 'Drugo' },
];
export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(DOC_CATEGORIES.map((c) => [c.id, c.label]));
const MAX_MB = 25;

/**
 * Dokumenta po sredstvu (maint_documents, entity=asset) — paritet 1.0
 * renderMaintDocumentsPanel(assetId): upload (fajl + kategorija + „važi do" + opis) + lista
 * (open kroz signed URL, meta-izmena, brisanje). Reusable u kartonu IT/objekta.
 */
export function AssetDocuments({ assetId, canUpload }: { assetId: string; canUpload: boolean }) {
  const docs = useDocuments({ assetId, entityType: 'asset', pageSize: 100 });
  const upload = useUploadDocument();
  const del = useDeleteDocument();
  const fileRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState('manual');
  const [validUntil, setValidUntil] = useState('');
  const [description, setDescription] = useState('');
  const [metaDoc, setMetaDoc] = useState<MaintDocument | null>(null);
  const rows = docs.data?.data ?? [];
  const catDef = DOC_CATEGORIES.find((c) => c.id === category);

  async function open(id: string) {
    try { const res = await signDocumentUrl(id); window.open(res.data.url, '_blank'); }
    catch { toast('Dokument nije dostupan (storage).'); }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_MB * 1024 * 1024) { toast(`Dokument veći od ${MAX_MB} MB.`); if (fileRef.current) fileRef.current.value = ''; return; }
    upload.mutate(
      { file, entityType: 'asset', entityId: assetId, category, description: description.trim() || undefined, validUntil: validUntil || undefined },
      {
        onSuccess: () => { setDescription(''); setValidUntil(''); if (fileRef.current) fileRef.current.value = ''; toast('Dokument otpremljen'); },
        onError: (err) => { toast((err as Error).message); if (fileRef.current) fileRef.current.value = ''; },
      },
    );
  }

  return (
    <div className="space-y-3">
      {canUpload && (
        <div className="flex flex-wrap items-end gap-2 rounded-panel border border-line bg-surface-2/40 p-3">
          <FormField label="Kategorija">
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
              {DOC_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </FormField>
          {catDef?.hasExpiry && <FormField label="Važi do"><Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></FormField>}
          <div className="min-w-[10rem] flex-1"><FormField label="Opis"><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="opciono" /></FormField></div>
          <input ref={fileRef} type="file" hidden onChange={onFile} />
          <Button variant="secondary" loading={upload.isPending} onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" aria-hidden /> Otpremi dokument</Button>
        </div>
      )}

      {docs.isLoading ? (
        <p className="py-4 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-ink-secondary">Nema dokumenata za ovo sredstvo.</p>
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="p-2">Fajl</th><th className="p-2">Kategorija</th><th className="p-2">Važi do</th><th className="p-2">Otpremljen</th><th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((doc) => (
                <tr key={doc.documentId} className="border-b border-line-soft">
                  <td className="p-2"><button onClick={() => open(doc.documentId)} className="flex items-center gap-2 text-accent hover:underline"><Download className="h-3.5 w-3.5" aria-hidden />{doc.fileName}</button>{doc.description && <div className="text-2xs text-ink-secondary">{doc.description}</div>}</td>
                  <td className="p-2 text-ink-secondary">{doc.category ? CATEGORY_LABEL[doc.category] ?? doc.category : '—'}</td>
                  <td className="p-2">{doc.validUntil ? <StatusBadge tone={deadlineTone(doc.validUntil)} label={formatDate(doc.validUntil)} /> : <span className="text-ink-disabled">—</span>}</td>
                  <td className="p-2 text-ink-secondary">{formatDate(doc.uploadedAt)}</td>
                  <td className="p-2 text-right">
                    {canUpload && (
                      <div className="flex justify-end gap-1.5">
                        <button title="Izmeni meta" onClick={() => setMetaDoc(doc)} className="text-ink-disabled hover:text-ink"><Pencil className="h-3.5 w-3.5" aria-hidden /></button>
                        <button title="Obriši" onClick={() => { if (confirm(`Obrisati dokument „${doc.fileName}"?`)) del.mutate({ id: doc.documentId }, { onSuccess: () => toast('Dokument obrisan') }); }} className="text-ink-disabled hover:text-status-danger"><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {metaDoc && <MetaForm doc={metaDoc} onClose={() => setMetaDoc(null)} />}
    </div>
  );
}

function MetaForm({ doc, onClose }: { doc: MaintDocument; onClose: () => void }) {
  const update = useUpdateDocument();
  const [category, setCategory] = useState(doc.category ?? 'other');
  const [validUntil, setValidUntil] = useState(isoToDateInput(doc.validUntil));
  const [description, setDescription] = useState(doc.description ?? '');
  return (
    <Dialog open onClose={onClose} title="Izmeni meta-podatke dokumenta"
      footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button loading={update.isPending} onClick={() => update.mutate({ id: doc.documentId, patch: { category, validUntil: validUntil || null, description: description.trim() || null } }, { onSuccess: () => { toast('Sačuvano'); onClose(); } })}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">{doc.fileName}</p>
        <FormField label="Kategorija">
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink">
            {DOC_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </FormField>
        <FormField label="Važi do"><Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></FormField>
        <FormField label="Opis"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></FormField>
      </div>
    </Dialog>
  );
}
