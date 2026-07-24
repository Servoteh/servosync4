'use client';

import { useEffect, useRef, useState } from 'react';
import { FileText, Image as ImageIcon, X } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { AttachmentInput } from '@/components/ui-kit/attachment-input';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { formatDate, formatDateTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { useWorkers } from '@/api/structures';
import {
  NC_LOCATION_LABEL,
  NC_SEVERITY_LABEL,
  NC_STATUS_LABEL,
  fetchNonconformityPhotoBlob,
  ncSeverityTone,
  ncStatusTone,
  openNonconformityPhoto,
  useAddNonconformityPhotos,
  useChangeNonconformityStatus,
  useNonconformity,
  useUpdateInvestigation,
  type NcEvent,
  type NcPhoto,
  type NcStatus,
} from '@/api/montaza-neusaglasenosti';

const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/** Prelazi statusa (paritet backend §2 mašine) → dugmad. */
const NEXT_ACTIONS: Record<NcStatus, { to: NcStatus; label: string }[]> = {
  CEKA_ANALIZU: [{ to: 'U_TOKU', label: 'Započni analizu' }],
  U_TOKU: [
    { to: 'ZAVRSENO', label: 'Završi' },
    { to: 'CEKA_ANALIZU', label: 'Vrati na čekanje' },
  ],
  ZAVRSENO: [],
};

/** Srpske labele tipova događaja (timeline). */
const EVENT_LABEL: Record<string, string> = {
  CREATED: 'Prijavljeno',
  STATUS_CHANGED: 'Promena statusa',
  INVESTIGATION_UPDATED: 'Ažurirana istraga',
  PHOTO_ADDED: 'Dodate fotografije',
  NOTE: 'Napomena',
};

function eventLine(e: NcEvent): string {
  const base = EVENT_LABEL[e.type] ?? e.type;
  if (e.type === 'STATUS_CHANGED' && e.data) {
    const to = e.data.to as string | undefined;
    if (to && to in NC_STATUS_LABEL) return `${base}: ${NC_STATUS_LABEL[to as NcStatus]}`;
  }
  return base;
}

interface WorkerRef {
  id: number;
  fullName: string | null;
}

/**
 * Detalj neusaglašenosti na montaži (zahtev 004/26). Prijava (immutable) + fotke
 * (thumbnail/lightbox) + istraga forma (manage, sa izborom izvršioca) + timeline.
 * Prikazan kao dijalog (static export — bez [id] rute). Dodavanje fotki: podnosilac
 * ili manage; zatvorena prijava se ne dopunjuje (BE 422).
 */
export function NeusaglasenostDetaljDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const { user, can } = useAuth();
  const detailQ = useNonconformity(id);
  const nc = detailQ.data?.data;

  const canManage = can(PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_MANAGE);
  const isReporter = !!user && !!nc && user.id === nc.reportedByUserId;
  const isClosed = nc?.status === 'ZAVRSENO';
  const canAddPhotos = (canManage || isReporter) && !isClosed;

  const updateInvestigation = useUpdateInvestigation();
  const changeStatus = useChangeNonconformityStatus();
  const addPhotos = useAddNonconformityPhotos();

  // Istraga forma. Seed SAMO jednom po nc.id (ne na svaki refetch — inače upload fotki /
  // promena statusa gaze ukucan tekst; review 004/26 #1). `seededId` ref pamti seedovan id.
  const seededId = useRef<number | null>(null);
  const [department, setDepartment] = useState('');
  const [report, setReport] = useState('');
  const [measures, setMeasures] = useState('');
  const [responsibleWorker, setResponsibleWorker] = useState<WorkerRef | null>(null);
  const [morePhotos, setMorePhotos] = useState<File[]>([]);
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => {
    if (!nc || seededId.current === nc.id) return;
    seededId.current = nc.id;
    setDepartment(nc.responsibleDepartment ?? '');
    setReport(nc.investigationReport ?? '');
    setMeasures(nc.preventiveMeasures ?? '');
    setResponsibleWorker(
      nc.responsibleWorkerId != null
        ? { id: nc.responsibleWorkerId, fullName: nc.responsibleWorker?.fullName ?? null }
        : null,
    );
  }, [nc]);

  async function saveInvestigation() {
    try {
      await updateInvestigation.mutateAsync({
        id,
        data: {
          responsibleDepartment: department.trim() || null,
          responsibleWorkerId: responsibleWorker?.id ?? null,
          investigationReport: report.trim() || null,
          preventiveMeasures: measures.trim() || null,
        },
      });
      toast('Istraga sačuvana.');
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function doStatus(to: NcStatus) {
    try {
      await changeStatus.mutateAsync({ id, status: to });
      toast(`Status: ${NC_STATUS_LABEL[to]}.`);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function uploadMore() {
    if (!morePhotos.length) return;
    try {
      await addPhotos.mutateAsync({ id, files: morePhotos });
      setMorePhotos([]);
      toast('Fotografije dodate.');
    } catch (e) {
      toast((e as Error).message);
    }
  }

  const title = nc ? nc.reportNumber : 'Neusaglašenost';

  return (
    <Dialog open onClose={onClose} size="xl" title={title}>
      {detailQ.isError ? (
        <div className="py-6">
          <EmptyState
            title="Neusaglašenost nije dostupna"
            hint="Zapis ne postoji ili trenutno nije dostupan. Osvežite listu ili pokušajte ponovo."
          />
          <div className="mt-4 flex justify-end">
            <Button variant="ghost" onClick={onClose}>
              Zatvori
            </Button>
          </div>
        </div>
      ) : detailQ.isLoading || !nc ? (
        <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : (
        <>
          <div className="space-y-5">
            {/* Zaglavlje: status + ozbiljnost */}
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={ncStatusTone(nc.status)} label={NC_STATUS_LABEL[nc.status]} />
              <StatusBadge
                tone={ncSeverityTone(nc.severity)}
                label={`Ozbiljnost: ${NC_SEVERITY_LABEL[nc.severity]}`}
              />
              <span className="ml-auto text-xs text-ink-secondary">
                Prijavio {nc.reportedBy.fullName ?? `#${nc.reportedByUserId}`} · {formatDate(nc.createdAt)}
              </span>
            </div>

            {/* Prijava (immutable) */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-secondary">Prijava</h3>
              <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                <Field label="Predmet" value={nc.projectNumber} mono />
                <Field
                  label="Mesto"
                  value={`${NC_LOCATION_LABEL[nc.locationKind]}${nc.locationNote ? ` — ${nc.locationNote}` : ''}`}
                />
                <Field label="Broj crteža" value={nc.drawingNumber} mono />
                <Field label="Radni nalog" value={nc.workOrderCode} mono />
              </dl>
              <div>
                <dt className="text-2xs uppercase tracking-wider text-ink-secondary">Opis problema</dt>
                <dd className="mt-0.5 whitespace-pre-wrap text-sm text-ink">{nc.description}</dd>
              </div>
            </section>

            {/* Fotografije */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-secondary">
                Fotografije ({nc.photos?.length ?? 0})
              </h3>
              {nc.photos && nc.photos.length > 0 ? (
                <ul className="flex flex-wrap gap-2">
                  {nc.photos.map((p) => (
                    <li key={p.id}>
                      <PhotoTile ncId={id} photo={p} onLightbox={setLightbox} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-disabled">Nema fotografija.</p>
              )}
              {canAddPhotos && (
                <div className="space-y-2">
                  <AttachmentInput
                    value={morePhotos}
                    onChange={setMorePhotos}
                    onReject={(m) => toast(m)}
                    max={MAX_PHOTOS}
                    accept={['IMAGE', 'FILE']}
                    maxBytes={MAX_PHOTO_BYTES}
                  />
                  {morePhotos.length > 0 && (
                    <Button variant="secondary" loading={addPhotos.isPending} onClick={() => void uploadMore()}>
                      Otpremi fotografije
                    </Button>
                  )}
                </div>
              )}
            </section>

            {/* Istraga */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-secondary">Istraga</h3>
              {canManage ? (
                <>
                  <FormField label="Odgovorno odeljenje" hint="Ko/šta je odgovorno za neusaglašenost.">
                    <Input
                      value={department}
                      onChange={(e) => setDepartment(e.target.value)}
                      placeholder="npr. Zavarivanje, Farbara, Kooperant…"
                    />
                  </FormField>
                  <FormField label="Izvršilac (radnik)" hint="Opciono — radnik odgovoran za neusaglašenost.">
                    <WorkerPicker value={responsibleWorker} onChange={setResponsibleWorker} />
                  </FormField>
                  <FormField label="Nalaz istrage">
                    <Textarea value={report} onChange={(e) => setReport(e.target.value)} rows={3} />
                  </FormField>
                  <FormField label="Preventivne mere">
                    <Textarea value={measures} onChange={(e) => setMeasures(e.target.value)} rows={2} />
                  </FormField>
                  <Button variant="secondary" loading={updateInvestigation.isPending} onClick={() => void saveInvestigation()}>
                    Sačuvaj istragu
                  </Button>
                </>
              ) : (
                <dl className="space-y-2">
                  <Field label="Odgovorno odeljenje" value={nc.responsibleDepartment} />
                  <Field label="Izvršilac" value={nc.responsibleWorker?.fullName ?? null} />
                  <Field label="Nalaz istrage" value={nc.investigationReport} />
                  <Field label="Preventivne mere" value={nc.preventiveMeasures} />
                </dl>
              )}
            </section>

            {/* Timeline */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-secondary">Istorija</h3>
              <ol className="space-y-1.5">
                {(nc.events ?? []).map((e) => (
                  <li key={e.id} className="flex items-baseline gap-2 text-sm">
                    <span className="tnums shrink-0 text-2xs text-ink-secondary">{formatDateTime(e.createdAt)}</span>
                    <span className="text-ink">{eventLine(e)}</span>
                    {e.actorName && <span className="text-2xs text-ink-secondary">· {e.actorName}</span>}
                  </li>
                ))}
              </ol>
            </section>
          </div>

          {/* Footer akcije: status prelazi (manage) + Zatvori */}
          <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
            {canManage &&
              NEXT_ACTIONS[nc.status].map((a) => (
                <Button
                  key={a.to}
                  variant={a.to === 'ZAVRSENO' ? 'primary' : 'secondary'}
                  loading={changeStatus.isPending}
                  onClick={() => void doStatus(a.to)}
                >
                  {a.label}
                </Button>
              ))}
            <Button variant="ghost" onClick={onClose}>
              Zatvori
            </Button>
          </div>
        </>
      )}

      {lightbox && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4"
          onClick={() => setLightbox(null)}
          role="presentation"
        >
          <button
            className="absolute right-4 top-4 rounded-control bg-black/40 p-2 text-white hover:bg-black/60"
            aria-label="Zatvori"
            onClick={() => setLightbox(null)}
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox}
            alt="Fotografija neusaglašenosti"
            className="max-h-[90vh] max-w-full rounded-panel object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </Dialog>
  );
}

/**
 * Pločica fotke: za slike dovuče blob → thumbnail (klik = lightbox); za PDF dugme
 * „Otvori" (novi tab). Blob se povlači autentikovano (`fetchNonconformityPhotoBlob`) jer
 * `<img src>` ne može da nosi Authorization header; object URL se čisti na unmount-u.
 */
function PhotoTile({
  ncId,
  photo,
  onLightbox,
}: {
  ncId: number;
  photo: NcPhoto;
  onLightbox: (url: string) => void;
}) {
  const isImage = photo.contentType.startsWith('image/');
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isImage) return;
    let url: string | null = null;
    let alive = true;
    fetchNonconformityPhotoBlob(ncId, photo.id)
      .then((blob) => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setThumbUrl(url);
      })
      .catch(() => {
        /* thumbnail best-effort — pad ostavlja placeholder */
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [ncId, photo.id, isImage]);

  if (isImage) {
    return (
      <button
        type="button"
        onClick={() => thumbUrl && onLightbox(thumbUrl)}
        className="grid h-20 w-20 place-items-center overflow-hidden rounded-control border border-line bg-surface-2 hover:border-accent"
        title={photo.fileName}
      >
        {thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbUrl} alt={photo.fileName} className="h-full w-full object-cover" />
        ) : (
          <ImageIcon className="h-5 w-5 text-ink-secondary" aria-hidden />
        )}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void openNonconformityPhoto(ncId, photo.id)}
      className="inline-flex items-center gap-1.5 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-surface-2"
      title={photo.fileName}
    >
      <FileText className="h-4 w-4 text-ink-secondary" aria-hidden />
      <span className="max-w-[10rem] truncate">{photo.fileName}</span>
    </button>
  );
}

/**
 * Izbor jednog izvršioca-radnika (single-select) — obrazac `worker-multi-select`
 * (pretraga po imenu, samo aktivni, `useWorkers`). Prazan = bez izvršioca.
 */
function WorkerPicker({
  value,
  onChange,
}: {
  value: WorkerRef | null;
  onChange: (next: WorkerRef | null) => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const list = useWorkers({ q: q.trim() || undefined, active: 'true', pageSize: 20 });
  const options = list.data?.data ?? [];

  if (value) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 rounded-control border border-line bg-surface-2 px-3 py-2 text-sm text-ink">
          {value.fullName ?? `Radnik #${value.id}`}
        </div>
        <Button variant="ghost" onClick={() => onChange(null)}>
          Ukloni
        </Button>
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Pretraga radnika po imenu…"
        className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink placeholder:text-ink-disabled focus-visible:border-accent focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
      />
      {open && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-control border border-line bg-surface shadow-lg">
          {list.isLoading ? (
            <div className="px-3 py-2 text-sm text-ink-disabled">Učitavanje…</div>
          ) : options.length === 0 ? (
            <div className="px-3 py-2 text-sm text-ink-disabled">{q ? 'Nema rezultata.' : 'Kucaj za pretragu…'}</div>
          ) : (
            options.map((w) => (
              <button
                type="button"
                key={w.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange({ id: w.id, fullName: w.fullName });
                  setOpen(false);
                  setQ('');
                }}
                className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-surface-2"
              >
                <span className="text-sm text-ink">{w.fullName ?? w.username}</span>
                {w.workUnit?.name && <span className="text-xs text-ink-disabled">{w.workUnit.name}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wider text-ink-secondary">{label}</dt>
      <dd className={`mt-0.5 text-sm text-ink ${mono ? 'tnums' : ''}`}>
        {value && value.trim() ? value : <span className="text-ink-disabled">—</span>}
      </dd>
    </div>
  );
}
