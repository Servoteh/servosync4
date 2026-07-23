'use client';

import { useEffect, useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { AttachmentInput } from '@/components/ui-kit/attachment-input';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import {
  NC_LOCATION_LABEL,
  NC_SEVERITY_LABEL,
  NC_STATUS_LABEL,
  ncSeverityTone,
  ncStatusTone,
  openNonconformityPhoto,
  useAddNonconformityPhotos,
  useChangeNonconformityStatus,
  useNonconformity,
  useUpdateInvestigation,
  type NcEvent,
  type NcStatus,
} from '@/api/montaza-neusaglasenosti';

const MAX_PHOTOS = 6;

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
    if (to && to in NC_STATUS_LABEL)
      return `${base}: ${NC_STATUS_LABEL[to as NcStatus]}`;
  }
  return base;
}

/**
 * Detalj neusaglašenosti na montaži (zahtev 004/26). Prijava (immutable) + fotke
 * (otvaranje u novom tabu) + istraga forma (manage) + timeline. Prikazan kao dijalog
 * (static export — bez [id] rute). Dodavanje fotki: podnosilac ili manage.
 */
export function NeusaglasenostDetaljDialog({
  id,
  onClose,
}: {
  id: number;
  onClose: () => void;
}) {
  const { user, can } = useAuth();
  const detailQ = useNonconformity(id);
  const nc = detailQ.data?.data;

  const canManage = can(PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_MANAGE);
  const isReporter = !!user && !!nc && user.id === nc.reportedByUserId;
  const canAddPhotos = canManage || isReporter;

  const updateInvestigation = useUpdateInvestigation();
  const changeStatus = useChangeNonconformityStatus();
  const addPhotos = useAddNonconformityPhotos();

  // Istraga forma (seed iz detalja kad stigne).
  const [department, setDepartment] = useState('');
  const [report, setReport] = useState('');
  const [measures, setMeasures] = useState('');
  const [morePhotos, setMorePhotos] = useState<File[]>([]);

  useEffect(() => {
    if (!nc) return;
    setDepartment(nc.responsibleDepartment ?? '');
    setReport(nc.investigationReport ?? '');
    setMeasures(nc.preventiveMeasures ?? '');
  }, [nc]);

  async function saveInvestigation() {
    try {
      await updateInvestigation.mutateAsync({
        id,
        data: {
          responsibleDepartment: department.trim() || null,
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
      {detailQ.isLoading || !nc ? (
        <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : (
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
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-secondary">
              Prijava
            </h3>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
              <Field label="Predmet" value={nc.projectNumber} mono />
              <Field
                label="Mesto"
                value={`${NC_LOCATION_LABEL[nc.locationKind]}${
                  nc.locationNote ? ` — ${nc.locationNote}` : ''
                }`}
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
                    <button
                      type="button"
                      onClick={() => void openNonconformityPhoto(id, p.id)}
                      className="inline-flex items-center gap-1.5 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-surface-2"
                      title={p.fileName}
                    >
                      <ImageIcon className="h-4 w-4 text-ink-secondary" aria-hidden />
                      <span className="max-w-[10rem] truncate">{p.fileName}</span>
                    </button>
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
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-secondary">
              Istraga
            </h3>
            {canManage ? (
              <>
                <FormField label="Odgovorno odeljenje" hint="Ko/šta je odgovorno za neusaglašenost.">
                  <Input
                    value={department}
                    onChange={(e) => setDepartment(e.target.value)}
                    placeholder="npr. Zavarivanje, Farbara, Kooperant…"
                  />
                </FormField>
                <FormField label="Nalaz istrage">
                  <Textarea value={report} onChange={(e) => setReport(e.target.value)} rows={3} />
                </FormField>
                <FormField label="Preventivne mere">
                  <Textarea value={measures} onChange={(e) => setMeasures(e.target.value)} rows={2} />
                </FormField>
                <Button
                  variant="secondary"
                  loading={updateInvestigation.isPending}
                  onClick={() => void saveInvestigation()}
                >
                  Sačuvaj istragu
                </Button>
              </>
            ) : (
              <dl className="space-y-2">
                <Field label="Odgovorno odeljenje" value={nc.responsibleDepartment} />
                <Field label="Nalaz istrage" value={nc.investigationReport} />
                <Field label="Preventivne mere" value={nc.preventiveMeasures} />
              </dl>
            )}
          </section>

          {/* Timeline */}
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-secondary">
              Istorija
            </h3>
            <ol className="space-y-1.5">
              {(nc.events ?? []).map((e) => (
                <li key={e.id} className="flex items-baseline gap-2 text-sm">
                  <span className="tnums shrink-0 text-2xs text-ink-secondary">
                    {formatDate(e.createdAt)}
                  </span>
                  <span className="text-ink">{eventLine(e)}</span>
                  {e.actorName && <span className="text-2xs text-ink-secondary">· {e.actorName}</span>}
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}

      {/* Footer akcije: status prelazi (manage) + Zatvori */}
      <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
        {canManage &&
          nc &&
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
    </Dialog>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wider text-ink-secondary">{label}</dt>
      <dd className={`mt-0.5 text-sm text-ink ${mono ? 'tnums' : ''}`}>
        {value && value.trim() ? value : <span className="text-ink-disabled">—</span>}
      </dd>
    </div>
  );
}
