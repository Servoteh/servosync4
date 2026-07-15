'use client';

// Izveštaji — create-wizard (increment 4). Port 1.0 izvestajCreateFlow.js + izvestajiView.js
// create korak: slobodan tekst + fotke (downscale) → AI strukturira (BE port edge) → preview
// sa dopunama + izbor predmeta → idempotentno snimanje (klijentski UUID) → PDF + upload fotki
// → gotovo (retry fotki/PDF, otvori PDF). Deljena logika sa mobilnim (/m/izvestaj) stiže u inc.5.

import { useCallback, useRef, useState } from 'react';
import { ArrowLeft, Plus, X, Check, AlertTriangle, FileDown, RefreshCw, Search } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui-kit/button';
import { cn } from '@/lib/cn';
import { parseDmyToIso } from '@/lib/plan-montaze/date';
import { IZVESTAJ_STATUS, IZVESTAJ_MAX_FOTKE } from '@/lib/plan-montaze/constants';
import { downscaleImageToJpeg, type DownscaledPhoto } from '@/lib/plan-montaze/image';
import { generateIzvestajPdf } from '@/lib/plan-montaze/izvestaj-pdf';
import {
  newClientEventId,
  useAiGenerate,
  useCreateReport,
  useUploadReportPdf,
  useUploadReportPhotos,
  fetchReportPdfUrl,
  type MontazaAiOut,
} from '@/api/plan-montaze';
import { PredmetPicker } from './predmet-picker';

type Step = 'unos' | 'obrada' | 'preview' | 'cuvanje' | 'gotovo';
interface Photo extends DownscaledPhoto {
  opis: string;
}
interface Saved {
  id: string;
  broj: string;
  pdfOk: boolean;
  photosOk: boolean;
  photoCount: number;
}

const REQUIRED = ['datum', 'predmet', 'klijent', 'lokacija', 'pocetak_rada', 'kraj_rada'] as const;
const LABELE: Record<string, string> = {
  datum: 'Datum rada',
  predmet: 'Predmet / projekat',
  klijent: 'Klijent',
  lokacija: 'Lokacija rada',
  pocetak_rada: 'Početak rada',
  kraj_rada: 'Kraj rada',
};
const DATUM_MSG = 'Datum mora biti DD.MM.GGGG (npr. 02.07.2026) ili GGGG-MM-DD.';

function computeMissing(d: MontazaAiOut): string[] {
  return REQUIRED.filter((f) => (f === 'predmet' ? !(d.predmet || d.naziv_projekta) : !d[f]));
}

/** DD.MM.YYYY ili YYYY-MM-DD → ISO; '' /null = nevalidno. */
function toIsoDate(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  return parseDmyToIso(t) || null;
}

const emptyOut = (): MontazaAiOut => ({
  datum: '',
  predmet: '',
  naziv_projekta: '',
  klijent: '',
  lokacija: '',
  pocetak_rada: '',
  kraj_rada: '',
  opis_radova: '',
  problemi: '',
  otvorene_stavke: '',
  status: 'u_toku',
  dodatni_clanovi_tima: [],
  fotodokumentacija: [],
  predmet_item_id: null,
  nedostajuci_podaci: [],
});

export function IzvestajWizard({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const autorIme = user?.email ?? '';

  const aiGen = useAiGenerate();
  const createReport = useCreateReport();
  const uploadPdf = useUploadReportPdf();
  const uploadPhotos = useUploadReportPhotos();

  const [step, setStep] = useState<Step>('unos');
  const [tekst, setTekst] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [addingPhotos, setAddingPhotos] = useState(false);
  const [data, setData] = useState<MontazaAiOut>(emptyOut);
  const [aiModel, setAiModel] = useState('');
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState<Saved | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [progress, setProgress] = useState('');
  const izvId = useRef<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const setField = useCallback((k: keyof MontazaAiOut, v: unknown) => {
    setData((d) => ({ ...d, [k]: v }));
  }, []);

  async function addFiles(fileList: FileList | null) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setAddingPhotos(true);
    setErr('');
    let failed = 0;
    const added: Photo[] = [];
    for (const f of files) {
      if (photos.length + added.length >= IZVESTAJ_MAX_FOTKE) break;
      try {
        const ds = await downscaleImageToJpeg(f);
        added.push({ ...ds, opis: '' });
      } catch {
        failed++;
      }
    }
    setPhotos((p) => [...p, ...added]);
    setAddingPhotos(false);
    if (failed) setErr(`${failed === 1 ? 'Jedna slika nije' : failed + ' slika nije'} učitana.`);
  }

  async function generate() {
    if (!tekst.trim() && !photos.length) {
      setErr('Unesi tekst ili dodaj bar jednu fotografiju.');
      return;
    }
    setErr('');
    setStep('obrada');
    try {
      const res = await aiGen.mutateAsync({
        tekst,
        slike: photos.map((p) => ({ media_type: 'image/jpeg', data: p.base64 })),
      });
      const out = res.data;
      setData(out);
      setAiModel(res.meta?.model ?? '');
      // AI opise fotki mapiraj po rednom broju
      if (Array.isArray(out.fotodokumentacija)) {
        setPhotos((prev) => {
          const next = prev.slice();
          for (const f of out.fotodokumentacija) {
            const idx = (Number(f.redni_broj) || 0) - 1;
            if (idx >= 0 && idx < next.length) next[idx] = { ...next[idx], opis: f.opis || '' };
          }
          return next;
        });
      }
      setStep('preview');
    } catch (e) {
      setStep('unos');
      setErr(e instanceof Error ? e.message : 'AI obrada nije uspela.');
    }
  }

  async function confirm() {
    const missing = computeMissing(data);
    if (missing.length) {
      setErr('Obavezna polja nisu popunjena: ' + missing.map((f) => LABELE[f] || f).join(', ') + '.');
      return;
    }
    const iso = toIsoDate(data.datum);
    if (data.datum && iso === null) {
      setErr(DATUM_MSG);
      return;
    }
    setErr('');
    if (!izvId.current) izvId.current = newClientEventId();
    const id = izvId.current;
    setStep('cuvanje');
    setProgress('Snimam izveštaj…');

    // 1) Idempotentno snimanje (klijentski UUID). Retry posle pada koristi ISTI id.
    let broj = '';
    try {
      const res = await createReport.mutateAsync({
        id,
        status: data.status,
        datum: iso ?? undefined,
        predmetItemId: data.predmet_item_id ?? undefined,
        predmet: data.predmet || undefined,
        nazivProjekta: data.naziv_projekta || undefined,
        klijent: data.klijent || undefined,
        lokacija: data.lokacija || undefined,
        pocetakRada: data.pocetak_rada || undefined,
        krajRada: data.kraj_rada || undefined,
        opisRadova: data.opis_radova || undefined,
        problemi: data.problemi || undefined,
        otvoreneStavke: data.otvorene_stavke || undefined,
        dodatniClanovi: data.dodatni_clanovi_tima,
        autorIme: autorIme || undefined,
        siroviTekst: tekst || undefined,
        aiModel: aiModel || undefined,
        aiJson: data as unknown as Record<string, unknown>,
      });
      broj = (res.data as { brojIzvestaja?: string })?.brojIzvestaja ?? '';
    } catch (e) {
      setStep('preview');
      setErr(e instanceof Error ? e.message : 'Snimanje nije uspelo (dozvola/mreža).');
      return;
    }

    // 2) PDF (sa dodeljenim brojem) + 3) fotke — nezavisni retry-evi na „gotovo" ekranu.
    setProgress('Pravim PDF i otpremam fotografije…');
    const pdfOk = await savePdf(id, broj);
    const photosOk = await savePhotos(id);

    setSaved({ id, broj, pdfOk, photosOk, photoCount: photos.length });
    setStep('gotovo');
  }

  async function savePdf(id: string, broj: string): Promise<boolean> {
    try {
      const pdf = await generateIzvestajPdf({
        broj,
        datum: data.datum,
        predmet: data.predmet,
        naziv_projekta: data.naziv_projekta,
        klijent: data.klijent,
        lokacija: data.lokacija,
        monter: autorIme,
        dodatni_clanovi: data.dodatni_clanovi_tima,
        pocetak: data.pocetak_rada,
        kraj: data.kraj_rada,
        opis: data.opis_radova,
        problemi: data.problemi,
        otvorene: data.otvorene_stavke,
        statusLabel: IZVESTAJ_STATUS[data.status] ?? data.status,
        fotke: photos.map((p, i) => ({ dataUrl: p.dataUrl, w: p.w, h: p.h, opis: p.opis, redni_broj: i + 1 })),
      });
      await uploadPdf.mutateAsync({ id, blob: pdf.blob, fileName: pdf.fileName });
      return true;
    } catch {
      return false;
    }
  }

  async function savePhotos(id: string): Promise<boolean> {
    if (!photos.length) return true;
    try {
      await uploadPhotos.mutateAsync({
        id,
        files: photos.map((p, i) => new File([p.blob], `foto-${i + 1}.jpg`, { type: 'image/jpeg' })),
        opisi: photos.map((p) => p.opis),
      });
      return true;
    } catch {
      return false;
    }
  }

  async function retryPdf() {
    if (!saved) return;
    setStep('cuvanje');
    setProgress('Ponovo generišem PDF…');
    const ok = await savePdf(saved.id, saved.broj);
    setSaved((s) => (s ? { ...s, pdfOk: ok } : s));
    setStep('gotovo');
  }
  async function retryPhotos() {
    if (!saved) return;
    setStep('cuvanje');
    setProgress('Ponovo otpremam fotografije…');
    const ok = await savePhotos(saved.id);
    setSaved((s) => (s ? { ...s, photosOk: ok } : s));
    setStep('gotovo');
  }
  async function openPdf() {
    if (!saved) return;
    try {
      const res = await fetchReportPdfUrl(saved.id);
      if (res.data?.url) window.open(res.data.url, '_blank', 'noopener');
    } catch {
      /* ignore */
    }
  }

  const missing = new Set(computeMissing(data));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onClose} className="flex items-center gap-1 rounded-control border border-line px-2 py-1 text-sm text-ink-secondary hover:bg-surface-2">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Lista
        </button>
        <h2 className="text-md font-semibold text-ink">Novi izveštaj</h2>
      </div>

      {err && (
        <div className="flex items-center gap-2 rounded-control border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          {err}
        </div>
      )}

      {(step === 'obrada' || step === 'cuvanje') && (
        <div className="grid place-items-center gap-3 py-16 text-center">
          <RefreshCw className="h-8 w-8 animate-spin text-accent" aria-hidden />
          <p className="text-sm text-ink-secondary">{step === 'obrada' ? 'AI obrađuje izveštaj…' : progress || 'Čuvam…'}</p>
        </div>
      )}

      {step === 'unos' && (
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-ink" htmlFor="wtekst">
              Napiši šta je urađeno (kao poruka)
            </label>
            <textarea
              id="wtekst"
              value={tekst}
              onChange={(e) => setTekst(e.target.value)}
              rows={6}
              placeholder="npr. Danas montirali rezervoar za predmet 9400/2. Falile dve spojnice. Ostaje proba hidraulike. Radio sa Markom, 8–14h."
              className="w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-disabled"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-ink">
              Fotografije ({photos.length}/{IZVESTAJ_MAX_FOTKE})
            </label>
            <div className="flex flex-wrap gap-2">
              {photos.map((p, i) => (
                <div key={i} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.dataUrl} alt={`foto ${i + 1}`} className="h-20 w-20 rounded-control border border-line object-cover" />
                  <button
                    type="button"
                    onClick={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}
                    className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-status-danger text-xs text-white"
                    aria-label="Ukloni"
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </div>
              ))}
              {photos.length < IZVESTAJ_MAX_FOTKE && (
                <button
                  type="button"
                  disabled={addingPhotos}
                  onClick={() => fileRef.current?.click()}
                  className="grid h-20 w-20 place-items-center rounded-control border border-dashed border-line text-ink-secondary hover:bg-surface-2 disabled:opacity-50"
                >
                  {addingPhotos ? '…' : <Plus className="h-5 w-5" aria-hidden />}
                </button>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
          </div>
          <Button onClick={generate} disabled={(!tekst.trim() && !photos.length) || addingPhotos}>
            Generiši izveštaj
          </Button>
        </div>
      )}

      {step === 'preview' && (
        <div className="space-y-4">
          {missing.size > 0 && (
            <div className="rounded-control border border-status-warn/40 bg-status-warn-bg px-3 py-2 text-sm text-status-warn">
              Dopuni još: <strong>{[...missing].map((f) => LABELE[f] || f).join(', ')}</strong> — možeš ukucati direktno ispod.
            </div>
          )}
          <div className="text-sm text-ink-secondary">
            Monter / Serviser: <strong className="text-ink">{autorIme || '—'}</strong>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <WField label="Datum rada" value={data.datum} onChange={(v) => setField('datum', v)} missing={missing.has('datum')} />
            <WField label="Predmet / projekat" value={data.predmet} onChange={(v) => setField('predmet', v)} missing={missing.has('predmet')} />
            <WField label="Naziv projekta" value={data.naziv_projekta} onChange={(v) => setField('naziv_projekta', v)} />
            <WField label="Klijent" value={data.klijent} onChange={(v) => setField('klijent', v)} missing={missing.has('klijent')} />
            <WField label="Lokacija rada" value={data.lokacija} onChange={(v) => setField('lokacija', v)} missing={missing.has('lokacija')} />
            <WField label="Početak" value={data.pocetak_rada} onChange={(v) => setField('pocetak_rada', v)} missing={missing.has('pocetak_rada')} />
            <WField label="Kraj" value={data.kraj_rada} onChange={(v) => setField('kraj_rada', v)} missing={missing.has('kraj_rada')} />
            <WField
              label="Dodatni članovi (zarezom)"
              value={data.dodatni_clanovi_tima.join(', ')}
              onChange={(v) => setField('dodatni_clanovi_tima', v.split(',').map((s) => s.trim()).filter(Boolean))}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setPickerOpen(true)} className="flex items-center gap-1 rounded-control border border-line px-2 py-1 text-sm text-ink-secondary hover:bg-surface-2">
              <Search className="h-4 w-4" aria-hidden /> Izaberi / ispravi predmet iz baze
            </button>
            {data.predmet_item_id ? (
              <span className="text-xs text-status-success">✓ predmet vezan za bazu</span>
            ) : (
              <span className="text-xs text-status-warn">AI nije potvrdio predmet — izaberi ručno</span>
            )}
          </div>

          <WArea label="Opis izvedenih radova" value={data.opis_radova} onChange={(v) => setField('opis_radova', v)} rows={4} />
          <WArea label="Problemi / odstupanja" value={data.problemi} onChange={(v) => setField('problemi', v)} rows={2} />
          <WArea label="Otvorene stavke / napomena" value={data.otvorene_stavke} onChange={(v) => setField('otvorene_stavke', v)} rows={2} />

          <div className="max-w-xs">
            <label className="mb-1 block text-sm font-medium text-ink">Status</label>
            <select value={data.status} onChange={(e) => setField('status', e.target.value)} className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink">
              {Object.entries(IZVESTAJ_STATUS).map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </div>

          {photos.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-ink">Foto-dokumentacija ({photos.length})</h3>
              <div className="space-y-2">
                {photos.map((p, i) => (
                  <div key={i} className="flex gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.dataUrl} alt={`foto ${i + 1}`} className="h-20 w-28 rounded-control border border-line object-cover" />
                    <textarea
                      value={p.opis}
                      onChange={(e) => setPhotos((prev) => prev.map((x, j) => (j === i ? { ...x, opis: e.target.value } : x)))}
                      rows={2}
                      placeholder={`Opis fotke ${i + 1}`}
                      className="flex-1 rounded-control border border-line bg-surface px-2 py-1 text-sm text-ink"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-between gap-2">
            <Button variant="secondary" onClick={() => setStep('unos')}>← Izmeni unos</Button>
            <Button onClick={confirm}>Sačuvaj izveštaj</Button>
          </div>
        </div>
      )}

      {step === 'gotovo' && saved && (
        <div className="grid place-items-center gap-3 py-10 text-center">
          <div className={cn('grid h-14 w-14 place-items-center rounded-full', saved.pdfOk && saved.photosOk ? 'bg-status-success-bg text-status-success' : 'bg-status-warn-bg text-status-warn')}>
            {saved.pdfOk && saved.photosOk ? <Check className="h-7 w-7" aria-hidden /> : <AlertTriangle className="h-7 w-7" aria-hidden />}
          </div>
          <div className="text-md font-semibold text-ink">{saved.pdfOk && saved.photosOk ? 'Izveštaj sačuvan' : 'Sačuvano uz upozorenje'}</div>
          <div className="tnums text-sm text-ink-secondary">{saved.broj}</div>
          {!saved.pdfOk && <div className="text-sm text-status-warn">PDF nije generisan.</div>}
          {!saved.photosOk && <div className="text-sm text-status-warn">Fotografije nisu otpremljene.</div>}
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {!saved.photosOk && saved.photoCount > 0 && (
              <Button variant="secondary" onClick={retryPhotos}><RefreshCw className="h-4 w-4" aria-hidden /> Fotografije ponovo</Button>
            )}
            {!saved.pdfOk && (
              <Button variant="secondary" onClick={retryPdf}><RefreshCw className="h-4 w-4" aria-hidden /> PDF ponovo</Button>
            )}
            {saved.pdfOk && (
              <Button variant="secondary" onClick={openPdf}><FileDown className="h-4 w-4" aria-hidden /> Otvori PDF</Button>
            )}
            <Button onClick={onClose}>Nazad na listu</Button>
          </div>
        </div>
      )}

      <PredmetPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(sel) =>
          setData((d) => ({
            ...d,
            predmet: sel.predmet_broj,
            predmet_item_id: sel.predmet_item_id,
            naziv_projekta: sel.naziv_projekta,
            klijent: sel.klijent,
          }))
        }
      />
    </div>
  );
}

function WField({ label, value, onChange, missing }: { label: string; value: string; onChange: (v: string) => void; missing?: boolean }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-ink">
        {label}
        {missing && <span className="ml-1 text-xs text-status-warn">• fali</span>}
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn('h-9 w-full rounded-control border bg-surface px-2 text-sm text-ink', missing ? 'border-status-warn' : 'border-line')}
      />
    </div>
  );
}

function WArea({ label, value, onChange, rows }: { label: string; value: string; onChange: (v: string) => void; rows: number }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-ink">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="w-full rounded-control border border-line bg-surface px-2 py-1 text-sm text-ink"
      />
    </div>
  );
}
