'use client';

// Dokumenta zaposlenog (kadrovska.pii) — upload (PDF/slika, ≤25MB) sa tipom +
// opcionim mejlom (queueEmail → kadr_queue_document_email), lista, Otvori
// (signed URL), Obriši. Paritet 1.0 employeesTab.js:1002-1026,1373-1450.

import { useRef, useState } from 'react';
import { Trash2, Upload, FileText } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { formatDate } from '@/lib/format';
import {
  newClientEventId,
  useEmployeeDocuments,
  useUploadDocument,
  useDeleteDocument,
  signDocument,
} from '@/api/kadrovska';
import { ConfirmDialog, INPUT_CLS, ROW_BTN, ROW_BTN_DANGER, SectionTitle } from './shared';

/** Tipovi dokumenata (1.0 EMPLOYEE_DOC_TYPE_LABELS). Novi tip MORA i u DB CHECK. */
const DOC_TYPE_LABELS: Record<string, string> = {
  licna_karta: 'Lična karta',
  pasos: 'Pasoš',
  vozacka: 'Vozačka dozvola',
  diploma: 'Diploma',
  ugovor: 'Ugovor o radu (generisan)',
  ugovor_skan: 'Skan ugovora',
  aneks: 'Aneks ugovora (generisan)',
  resenje_go: 'Rešenje o godišnjem odmoru (generisano)',
  resenje_porodiljsko: 'Rešenje o porodiljskom (generisano)',
  sporazumni_raskid: 'Sporazumni raskid ugovora (generisan)',
  potvrda_zaposlenje: 'Potvrda o zaposlenju (generisana)',
  potvrda_primanja: 'Potvrda o visini primanja (generisana)',
  karnet: 'Karnet (mesečni radni list)',
  lekarski: 'Lekarski nalaz',
  other: 'Ostalo',
};

const MAX_BYTES = 25 * 1024 * 1024;

type Toast = (msg: string) => void;

export function DocumentsSection({ employeeId, canEdit, onToast }: { employeeId: string; canEdit: boolean; onToast?: Toast }) {
  const q = useEmployeeDocuments(employeeId, true);
  const uploadM = useUploadDocument();
  const delM = useDeleteDocument();
  const fileRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState('other');
  const [desc, setDesc] = useState('');
  const [queueEmail, setQueueEmail] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [delId, setDelId] = useState<string | null>(null);
  const rows = q.data?.data ?? [];

  async function upload() {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      onToast?.('⚠ Fajl je veći od 25MB');
      return;
    }
    try {
      await uploadM.mutateAsync({
        employeeId,
        file,
        docType,
        description: desc.trim() || undefined,
        queueEmail: queueEmail || undefined,
        emailLabel: queueEmail ? DOC_TYPE_LABELS[docType] : undefined,
        clientEventId: newClientEventId(),
      });
      setFile(null);
      setDesc('');
      setQueueEmail(false);
      if (fileRef.current) fileRef.current.value = '';
      onToast?.(queueEmail ? '✅ Otpremljeno — mejl zakazan' : '✅ Dokument otpremljen');
    } catch {
      onToast?.('⚠ Upload nije uspeo');
    }
  }
  async function open(docId: string) {
    try {
      const r = await signDocument(docId);
      if (r.data) window.open(r.data, '_blank', 'noopener');
    } catch {
      onToast?.('⚠ Otvaranje nije uspelo');
    }
  }
  async function remove() {
    if (!delId) return;
    try {
      await delM.mutateAsync({ docId: delId });
      onToast?.('🗑 Obrisano');
    } catch {
      onToast?.('⚠ Brisanje nije uspelo');
    }
    setDelId(null);
  }

  return (
    <div>
      <SectionTitle>📎 Dokumenta</SectionTitle>
      {q.isLoading ? (
        <p className="text-sm text-ink-secondary">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-secondary">Nema priloženih dokumenata.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {rows.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 rounded-control border border-line px-3 py-1.5">
              <span className="flex min-w-0 items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-ink-secondary" aria-hidden />
                <span className="min-w-0 truncate">
                  <span className="text-ink-secondary">{DOC_TYPE_LABELS[d.docType] ?? d.docType}</span> · {d.fileName || '—'}
                  {d.uploadedAt ? <span className="text-ink-secondary"> · {formatDate(d.uploadedAt)}</span> : ''}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <button className={ROW_BTN} onClick={() => void open(d.id)}>
                  Otvori
                </button>
                {canEdit && (
                  <button className={ROW_BTN_DANGER} title="Obriši" onClick={() => setDelId(d.id)}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="mt-3 space-y-2 rounded-panel border border-dashed border-line bg-surface-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <select className={`${INPUT_CLS} max-w-[15rem]`} value={docType} onChange={(e) => setDocType(e.target.value)} aria-label="Tip dokumenta">
              {Object.entries(DOC_TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,image/*"
              capture="environment"
              className="max-w-[16rem] text-sm text-ink-secondary file:mr-2 file:rounded-control file:border file:border-line file:bg-surface file:px-2 file:py-1 file:text-sm file:text-ink"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <input className={INPUT_CLS} placeholder="Opis (opciono)" value={desc} onChange={(e) => setDesc(e.target.value)} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={queueEmail} onChange={(e) => setQueueEmail(e.target.checked)} />
              Pošalji mejl zaposlenom po otpremanju
            </label>
            <Button onClick={() => void upload()} loading={uploadM.isPending} disabled={!file}>
              <Upload className="h-4 w-4" aria-hidden /> Otpremi
            </Button>
          </div>
          <p className="text-xs text-ink-secondary">PDF ili slika, do 25MB. Sa telefona možeš i da uslikaš dokument.</p>
        </div>
      )}

      {delId && (
        <ConfirmDialog title="Brisanje dokumenta" body="Obrisati ovaj dokument? Akcija je trajna." busy={delM.isPending} onCancel={() => setDelId(null)} onConfirm={() => void remove()} />
      )}
    </div>
  );
}
