'use client';

import { useEffect, useState } from 'react';
import { FileText, Link2, Loader2 } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { ComboBox } from '@/components/ui-kit/combo-box';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatDate } from '@/lib/format';
import { ApiError } from '@/api/client';
import {
  useReportDetail,
  useLinkPredmet,
  usePredmetiLookup,
  fetchReportPdfUrl,
  fetchPhotoUrl,
  MONTAZA_STATUS_LABELS,
  type PredmetLookup,
  type ReportFoto,
} from '@/api/plan-montaze';

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-ink-secondary">{label}</div>
      <div className="text-sm text-ink">{value || '—'}</div>
    </div>
  );
}

function PhotoThumb({ foto }: { foto: ReportFoto }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchPhotoUrl(foto.id)
      .then((r) => alive && setUrl(r.data.url))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [foto.id]);
  return (
    <a href={url ?? undefined} target="_blank" rel="noreferrer" className="block">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={foto.opis ?? `Foto ${foto.redniBroj}`} className="h-20 w-20 rounded-control border border-line object-cover" />
      ) : (
        <div className="grid h-20 w-20 place-items-center rounded-control border border-line bg-surface-2">
          <Loader2 className="h-4 w-4 animate-spin text-ink-disabled" />
        </div>
      )}
    </a>
  );
}

/** Detalj izveštaja montera: polja + fotke + PDF + „Poveži predmet". */
export function ReportDetail({ id, onClose, canManage }: { id: string; onClose: () => void; canManage: boolean }) {
  const q = useReportDetail(id);
  const link = useLinkPredmet();
  const [linking, setLinking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const r = q.data?.data;

  async function openPdf() {
    try {
      const res = await fetchReportPdfUrl(id);
      window.open(res.data.url, '_blank');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'PDF nije dostupan.');
    }
  }

  async function onPickPredmet(p: PredmetLookup | null) {
    setErr(null);
    try {
      await link.mutateAsync({
        id,
        predmetItemId: p?.id ?? null,
        predmetBroj: p?.broj_predmeta,
        nazivProjekta: p?.naziv_predmeta ?? undefined,
        klijent: p?.customer_name ?? undefined,
      });
      setLinking(false);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Povezivanje predmeta nije uspelo.');
    }
  }

  return (
    <Dialog open onClose={onClose} title={r?.brojIzvestaja ? `Izveštaj ${r.brojIzvestaja}` : 'Izveštaj'}>
      {q.isLoading || !r ? (
        <div className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <StatusBadge tone="info" label={MONTAZA_STATUS_LABELS[r.status] ?? r.status} />
            <span className="text-sm text-ink-secondary">{formatDate(r.datumRada)}</span>
            {r.pdfPath && (
              <Button variant="ghost" onClick={openPdf} className="ml-auto">
                <FileText className="h-4 w-4" /> PDF
              </Button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Predmet" value={r.predmetBroj} />
            <Field label="Klijent" value={r.klijent} />
            <Field label="Projekat" value={r.nazivProjekta} />
            <Field label="Lokacija" value={r.lokacija} />
            <Field label="Početak" value={r.pocetakRada} />
            <Field label="Kraj" value={r.krajRada} />
            <Field label="Autor" value={r.autorIme} />
            <Field label="Dodatni članovi" value={(r.dodatniClanovi ?? []).join(', ')} />
          </div>

          <Field label="Opis radova" value={<span className="whitespace-pre-wrap">{r.opisRadova}</span>} />
          {r.problemi && <Field label="Problemi" value={<span className="whitespace-pre-wrap">{r.problemi}</span>} />}
          {r.otvoreneStavke && (
            <Field label="Otvorene stavke" value={<span className="whitespace-pre-wrap">{r.otvoreneStavke}</span>} />
          )}

          {r.fotke.length > 0 && (
            <div>
              <div className="mb-1.5 text-2xs uppercase tracking-wider text-ink-secondary">Fotke ({r.fotke.length})</div>
              <div className="flex flex-wrap gap-2">
                {r.fotke.map((f) => (
                  <PhotoThumb key={f.id} foto={f} />
                ))}
              </div>
            </div>
          )}

          <div className="rounded-panel border border-line p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-ink">
              <Link2 className="h-4 w-4" /> Predmet
              {!linking && (
                <Button variant="ghost" onClick={() => setLinking(true)} className="ml-auto">
                  {r.predmetItemId ? 'Promeni' : 'Poveži'}
                </Button>
              )}
            </div>
            {linking ? (
              <div className="space-y-2">
                <ComboBox<PredmetLookup>
                  value={null}
                  onChange={onPickPredmet}
                  useSearch={(term) => usePredmetiLookup(term, false)}
                  getKey={(p) => p.id}
                  getLabel={(p) => `${p.broj_predmeta} — ${p.naziv_predmeta ?? ''}`}
                  getSublabel={(p) => p.customer_name ?? ''}
                  placeholder="Broj predmeta…"
                />
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => onPickPredmet(null)}>Odveži</Button>
                  <Button variant="ghost" onClick={() => setLinking(false)}>Otkaži</Button>
                </div>
              </div>
            ) : (
              <div className="text-sm text-ink-secondary">
                {r.predmetBroj ? `${r.predmetBroj}${r.klijent ? ` · ${r.klijent}` : ''}` : 'Nije povezano'}
              </div>
            )}
            {!canManage && <p className="mt-1 text-2xs text-ink-disabled">Izmenu vidi autor/menadžment.</p>}
          </div>

          {err && <p className="text-sm text-status-danger">{err}</p>}
        </div>
      )}
    </Dialog>
  );
}
