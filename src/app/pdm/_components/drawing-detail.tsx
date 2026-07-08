'use client';

import { useState, type ReactNode } from 'react';
import { FileText } from 'lucide-react';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { useDrawing, openDrawingPdf } from '@/api/pdm';
import { formatDate, formatDateTime, formatNumber } from '@/lib/format';
import { drawingStatusMeta, weightLabel } from './pdm-helpers';
import { TabNav } from './tab-nav';
import { BomTree } from './bom-tree';
import { WhereUsed } from './where-used';

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

export function DrawingDetail({ id }: { id: number }) {
  const q = useDrawing(id);
  const [tab, setTab] = useState('bom');
  const [pdfOpening, setPdfOpening] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  async function onOpenPdf() {
    setPdfOpening(true);
    setPdfError(null);
    try {
      await openDrawingPdf(id);
    } catch (e) {
      setPdfError(e instanceof Error ? e.message : 'Greška pri otvaranju PDF-a.');
    } finally {
      setPdfOpening(false);
    }
  }

  if (q.isLoading) return <span className="text-sm text-ink-disabled">Učitavanje…</span>;
  if (q.error || !q.data)
    return <span className="text-sm text-status-danger">Greška pri učitavanju detalja.</span>;

  const d = q.data.data;
  const s = drawingStatusMeta(d.status, d.pdmStatus);

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={s.tone} label={s.label} />
        {d.isProcurement && <StatusBadge tone="info" label="Nabavni deo" />}
        <span className="text-ink-secondary">
          {formatNumber(d.componentCount)} komponenti · koristi se u{' '}
          {formatNumber(d.whereUsedCount)}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Field label="Kat. broj" value={d.catalogNumber || '—'} />
        <Field label="Dimenzije" value={d.dimensions || '—'} />
        <Field label="Oznaka" value={d.marking || '—'} />
        <Field label="Masa" value={weightLabel(d.weight)} />
        <Field label="Materijal" value={d.material || '—'} />
        <Field label="Količina" value={formatNumber(d.quantity)} />
        <Field label="Projektovao" value={d.designedBy || '—'} />
        <Field label="Datum projekta" value={formatDate(d.designDate)} />
        <Field label="Odobrio" value={d.approvedBy || '—'} />
        <Field label="Odobreno" value={formatDate(d.approvedDate)} />
        <Field label="Predmet" value={d.projectName || '—'} />
        <Field label="RN ref" value={d.workOrderRef || '—'} />
      </dl>

      {d.comment && <p className="text-ink-secondary">{d.comment}</p>}

      <div>
        <p className="mb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          PDF crteža
        </p>
        {d.pdf ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-ink-secondary">
              {d.pdf.fileName ?? d.fileName ?? '—'}
              {d.pdf.sizeKb != null && (
                <span className="tnums"> · {formatNumber(d.pdf.sizeKb)} KB</span>
              )}
              {d.pdf.uploadedAt && <span> · {formatDateTime(d.pdf.uploadedAt)}</span>}
              {!d.pdf.hasBinary && (
                <span className="text-ink-disabled"> · bez binarnog sadržaja</span>
              )}
            </p>
            {d.pdf.hasBinary && (
              <button
                disabled={pdfOpening}
                onClick={onOpenPdf}
                className="inline-flex items-center gap-1.5 rounded-control border border-line px-3 py-1 text-xs font-semibold text-ink-secondary disabled:cursor-not-allowed disabled:opacity-40"
              >
                <FileText className="h-3.5 w-3.5" aria-hidden />
                {pdfOpening ? 'Otvaram…' : 'Otvori PDF'}
              </button>
            )}
          </div>
        ) : (
          <span className="text-ink-disabled">Nema PDF-a za ovu reviziju.</span>
        )}
        {pdfError && (
          <p className="mt-1 text-sm text-status-danger" role="alert">
            {pdfError}
          </p>
        )}
      </div>

      <div>
        <TabNav
          size="sm"
          active={tab}
          onChange={setTab}
          tabs={[
            { key: 'bom', label: `Sastavnica (${d.componentCount})` },
            { key: 'where', label: `Gde se koristi (${d.whereUsedCount})` },
          ]}
        />
        <div className="pt-3">
          {tab === 'bom' ? <BomTree drawingId={id} /> : <WhereUsed drawingId={id} />}
        </div>
      </div>
    </div>
  );
}
