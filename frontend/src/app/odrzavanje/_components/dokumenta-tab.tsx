'use client';

import { useMemo, useRef, useState } from 'react';
import { Download, Pencil, Trash2, Upload } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  signDocumentUrl,
  useAssets,
  useDeleteDocument,
  useDocuments,
  useUpdateDocument,
  useUploadDocument,
  type MaintDocument,
  type MaintMe,
} from '@/api/odrzavanje';
import { DOC_CATEGORIES, CATEGORY_LABEL } from './asset-documents';
import { deadlineTone, daysUntil, isoToDateInput, tableEmpty } from './common';
import { Tabs } from './tabs';

const ENTITY_FILTERS = ['', 'asset', 'work_order', 'incident', 'preventive_task', 'driver'] as const;
const ENTITY_LABEL: Record<string, string> = {
  asset: 'Sredstvo',
  work_order: 'Radni nalog',
  incident: 'Kvar',
  preventive_task: 'Preventiva',
  driver: 'Vozač',
};
const MAX_MB = 25;
const ACCEPT = 'application/pdf,image/*,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/csv';
type ExpiryFilter = '' | 'expired' | 'soon' | 'valid';

async function openDoc(id: string) {
  try { const res = await signDocumentUrl(id); window.open(res.data.url, '_blank'); }
  catch { toast('Dokument nije dostupan (storage).'); }
}
function catLabel(id: string | null): string { return id ? CATEGORY_LABEL[id] ?? id : '—'; }

/** Dokumenta (globalno) + zaseban pregled „Dokumenta vozila" (paritet 1.0 scope='vehicles'). */
export function DokumentaTab({ me }: { me: MaintMe | undefined }) {
  const [tab, setTab] = useState<'sva' | 'vozila'>('sva');
  return (
    <div className="space-y-3">
      <Tabs tabs={[{ key: 'sva', label: 'Sva dokumenta' }, { key: 'vozila', label: 'Dokumenta vozila' }]} value={tab} onChange={setTab} ariaLabel="Dokumenta" />
      {tab === 'sva' && <SvaDokumenta me={me} />}
      {tab === 'vozila' && <DokumentaVozila />}
    </div>
  );
}

function SvaDokumenta({ me }: { me: MaintMe | undefined }) {
  const [entityType, setEntityType] = useState('');
  const [category, setCategory] = useState('');
  const [expiry, setExpiry] = useState<ExpiryFilter>('');
  const [page, setPage] = useState(1);
  const [metaDoc, setMetaDoc] = useState<MaintDocument | null>(null);

  const docs = useDocuments({ entityType, page, pageSize: 100 });
  const del = useDeleteDocument();
  const isChiefAdmin = me?.maintRole === 'chief' || me?.maintRole === 'admin' || !!me?.erpAdminOrManagement;
  const canUpload = isChiefAdmin || me?.maintRole === 'technician' || me?.maintRole === 'operator';

  const meta = docs.data?.meta.pagination;
  const rows = useMemo(() => {
    const all = docs.data?.data ?? [];
    return all.filter((r) => {
      if (category && r.category !== category) return false;
      if (expiry) {
        const d = daysUntil(r.validUntil);
        if (expiry === 'expired' && !(d != null && d < 0)) return false;
        if (expiry === 'soon' && !(d != null && d >= 0 && d <= 30)) return false;
        if (expiry === 'valid' && !(d == null || d > 30)) return false;
      }
      return true;
    });
  }, [docs.data, category, expiry]);

  /** Brisanje: šef/admin/ERP uvek; operator/tehničar samo ≤24h od otpreme (paritet 1.0). */
  function canDelete(doc: MaintDocument): boolean {
    if (isChiefAdmin) return true;
    if (me?.maintRole !== 'operator' && me?.maintRole !== 'technician') return false;
    return Date.now() - Date.parse(doc.uploadedAt) < 24 * 3600 * 1000;
  }

  const cols: Column<MaintDocument>[] = [
    { key: 'file', header: 'Fajl', render: (r) => (
      <div>
        <button onClick={() => openDoc(r.documentId)} className="flex items-center gap-2 text-accent hover:underline"><Download className="h-3.5 w-3.5" aria-hidden />{r.fileName}</button>
        {r.description && <div className="text-2xs text-ink-secondary">{r.description}</div>}
      </div>
    ) },
    { key: 'entity', header: 'Entitet', render: (r) => <span className="text-ink-secondary">{ENTITY_LABEL[r.entityType] ?? r.entityType}</span> },
    { key: 'cat', header: 'Kategorija', render: (r) => <span className="text-ink-secondary">{catLabel(r.category)}</span> },
    { key: 'valid', header: 'Važi do', render: (r) => (r.validUntil ? <StatusBadge tone={deadlineTone(r.validUntil)} label={formatDate(r.validUntil)} /> : <span className="text-ink-disabled">—</span>) },
    { key: 'up', header: 'Otpremljen', render: (r) => <span className="text-ink-secondary">{formatDate(r.uploadedAt)}</span> },
    ...(canUpload
      ? [{
          key: 'act', header: '', align: 'right' as const,
          render: (r: MaintDocument) => (
            <div className="flex justify-end gap-1.5">
              <button title="Izmeni meta" onClick={(e) => { e.stopPropagation(); setMetaDoc(r); }} className="text-ink-disabled hover:text-ink"><Pencil className="h-3.5 w-3.5" aria-hidden /></button>
              {canDelete(r) && <button title="Obriši" onClick={(e) => { e.stopPropagation(); if (confirm(`Obrisati dokument „${r.fileName}"?`)) del.mutate({ id: r.documentId }, { onSuccess: () => toast('Dokument obrisan') }); }} className="text-ink-disabled hover:text-status-danger"><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>}
            </div>
          ),
        }]
      : []),
  ];

  return (
    <div className="space-y-3">
      {canUpload && <UploadForm />}

      <div className="flex flex-wrap items-center gap-2">
        <select value={entityType} onChange={(e) => { setEntityType(e.target.value); setPage(1); }} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
          {ENTITY_FILTERS.map((e) => <option key={e} value={e}>{e ? ENTITY_LABEL[e] : 'Svi entiteti'}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
          <option value="">Sve kategorije</option>
          {DOC_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <select value={expiry} onChange={(e) => setExpiry(e.target.value as ExpiryFilter)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
          <option value="">Svi rokovi</option>
          <option value="expired">Istekli</option>
          <option value="soon">Ističu (≤30d)</option>
          <option value="valid">Važeći</option>
        </select>
      </div>

      <DataTable columns={cols} rows={rows} rowKey={(r) => r.documentId} loading={docs.isLoading} empty={tableEmpty(docs.isError, 'Nema dokumenata', 'Nema dokumenata za izabrani filter.')} />
      {(category || expiry) && <p className="text-2xs text-ink-secondary">Filteri kategorije/roka primenjeni su na tekuću stranu ({rows.length} od {docs.data?.data.length ?? 0}).</p>}
      {meta && meta.totalPages > 1 && <Pager page={meta.page} totalPages={meta.totalPages} onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} />}

      {metaDoc && <MetaDialog doc={metaDoc} onClose={() => setMetaDoc(null)} />}
    </div>
  );
}

/** Upload uz sredstvo (entity=asset) — datalist svih sredstava, 18 kategorija, „Važi do", ≤25MB, opis. */
function UploadForm() {
  const assets = useAssets(undefined, true);
  const upload = useUploadDocument();
  const fileRef = useRef<HTMLInputElement>(null);
  const [assetText, setAssetText] = useState('');
  const [category, setCategory] = useState('manual');
  const [validUntil, setValidUntil] = useState('');
  const [description, setDescription] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const catDef = DOC_CATEGORIES.find((c) => c.id === category);
  const list = assets.data?.data ?? [];

  function resolveAssetId(): string | null {
    const raw = assetText.trim().toLowerCase();
    const hit = list.find((a) => `${a.assetCode} — ${a.name}`.toLowerCase() === raw || a.assetCode.toLowerCase() === raw);
    return hit?.assetId ?? null;
  }
  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    setErr(null);
    const file = e.target.files?.[0];
    if (!file) return;
    const entityId = resolveAssetId();
    if (!entityId) { setErr('Izaberi sredstvo iz liste.'); if (fileRef.current) fileRef.current.value = ''; return; }
    if (file.size > MAX_MB * 1024 * 1024) { setErr(`Fajl je veći od ${MAX_MB} MB.`); if (fileRef.current) fileRef.current.value = ''; return; }
    upload.mutate(
      { file, entityType: 'asset', entityId, category, description: description.trim() || undefined, validUntil: validUntil || undefined },
      {
        onSuccess: () => { setAssetText(''); setDescription(''); setValidUntil(''); if (fileRef.current) fileRef.current.value = ''; toast('Dokument otpremljen'); },
        onError: (e2) => { setErr((e2 as Error).message); if (fileRef.current) fileRef.current.value = ''; },
      },
    );
  }

  return (
    <div className="space-y-2 rounded-panel border border-line bg-surface-2/40 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[14rem] flex-1">
          <FormField label="Sredstvo" required>
            <Input list="mnt-doc-assets" value={assetText} onChange={(e) => setAssetText(e.target.value)} placeholder="Šifra ili naziv sredstva" />
            <datalist id="mnt-doc-assets">
              {list.map((a) => <option key={a.assetId} value={`${a.assetCode} — ${a.name}`} />)}
            </datalist>
          </FormField>
        </div>
        <FormField label="Kategorija">
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
            {DOC_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </FormField>
        {catDef?.hasExpiry && <FormField label="Važi do"><Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></FormField>}
        <div className="min-w-[10rem] flex-1"><FormField label="Opis"><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="opciono" /></FormField></div>
        <input ref={fileRef} type="file" hidden accept={ACCEPT} onChange={onFile} />
        <Button variant="secondary" loading={upload.isPending} onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" aria-hidden /> Otpremi dokument</Button>
      </div>
      {err && <p className="text-sm text-status-danger">{err}</p>}
    </div>
  );
}

function MetaDialog({ doc, onClose }: { doc: MaintDocument; onClose: () => void }) {
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

/**
 * „Dokumenta vozila" — zbirni, samo za čitanje (paritet 1.0 filterVehicleScopedDocs):
 * sva vozačka dokumenta + dokumenta sredstava tipa vozilo. Dodavanje ide iz kartice
 * vozila/vozača. WO-nad-vozilom se ne uključuje (BE ne join-uje sredstvo WO-a).
 */
function DokumentaVozila() {
  const driverDocs = useDocuments({ entityType: 'driver', pageSize: 200 });
  const assetDocs = useDocuments({ entityType: 'asset', pageSize: 500 });
  const vehicles = useAssets('vehicle', false);

  const vehicleIds = useMemo(() => new Set((vehicles.data?.data ?? []).map((a) => a.assetId)), [vehicles.data]);
  const rows = useMemo(() => {
    const merged: MaintDocument[] = [
      ...(driverDocs.data?.data ?? []),
      ...(assetDocs.data?.data ?? []).filter((d) => d.assetId && vehicleIds.has(d.assetId)),
    ];
    return merged.sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt));
  }, [driverDocs.data, assetDocs.data, vehicleIds]);

  const loading = driverDocs.isLoading || assetDocs.isLoading || vehicles.isLoading;
  const isError = driverDocs.isError || assetDocs.isError || vehicles.isError;

  const cols: Column<MaintDocument>[] = [
    { key: 'file', header: 'Fajl', render: (r) => (
      <div>
        <button onClick={() => openDoc(r.documentId)} className="flex items-center gap-2 text-accent hover:underline"><Download className="h-3.5 w-3.5" aria-hidden />{r.fileName}</button>
        {r.description && <div className="text-2xs text-ink-secondary">{r.description}</div>}
      </div>
    ) },
    { key: 'target', header: 'Cilj', render: (r) => <span className="text-ink-secondary">{r.entityType === 'driver' ? 'Vozač' : 'Vozilo'}</span> },
    { key: 'cat', header: 'Kategorija', render: (r) => <span className="text-ink-secondary">{catLabel(r.category)}</span> },
    { key: 'valid', header: 'Važi do', render: (r) => (r.validUntil ? <StatusBadge tone={deadlineTone(r.validUntil)} label={formatDate(r.validUntil)} /> : <span className="text-ink-disabled">—</span>) },
    { key: 'up', header: 'Otpremljen', render: (r) => <span className="text-ink-secondary">{formatDate(r.uploadedAt)}</span> },
  ];

  return (
    <div className="space-y-3">
      <p className="text-2xs text-ink-secondary">Zbirni pregled dokumenata vozila i vozača (samo za čitanje). Dodavanje se radi iz kartice vozila ili vozača.</p>
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.documentId} loading={loading} empty={tableEmpty(isError, 'Nema dokumenata', 'Nema dokumenata vezanih za vozila ili vozače.')} />
    </div>
  );
}
