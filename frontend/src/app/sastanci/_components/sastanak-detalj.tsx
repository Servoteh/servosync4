'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Play, Lock, Unlock, Send, Pencil, CalendarX, Printer, Trash2, X } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { Can } from '@/lib/can';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField } from '@/components/ui-kit/form-field';
import { toast } from '@/lib/toast';
import { ApiError } from '@/api/client';
import {
  arhiveQueryKey,
  newClientEventId,
  useAddUcesnik,
  useCancelSastanak,
  useDeleteSastanak,
  useLockSastanak,
  useMarkPrisutni,
  usePredmetPrioritet,
  useRemoveUcesnik,
  useReopenSastanak,
  useSastanakFull,
  useSastanakWeeklyDiff,
  useSeedFromTeme,
  useSendInvites,
  useUpdateSastanak,
  useUploadArhivaPdf,
  type Arhiva,
  type SastanakFull,
  type WeeklyDiff,
} from '@/api/sastanci';
import { DirectoryMultiPicker, type PickedUser } from './directory-multi-picker';
import { generateSastanakPdf } from '@/lib/sastanci-pdf';
import { Tabs, type TabItem } from './tabs';
import { formatDatum, formatVreme, INPUT_CLS, SASTANAK_TIP_LABEL, SastanakStatusBadge } from './common';
import { stampajZapisnik } from './print-zapisnik';
import { DetaljZapisnik } from './detalj-zapisnik';
import { DetaljAkcije } from './detalj-akcije';
import { DetaljPriprema } from './detalj-priprema';
import { DetaljOdluke } from './detalj-odluke';
import { DetaljArhiva } from './detalj-arhiva';
import { buildPdfInput, zapisnikDatumOf } from './zapisnik-pdf';
import { ZapisnikDatumModal } from './zapisnik-datum-modal';

type DetailTab = 'zapisnik' | 'akcije' | 'priprema' | 'odluke' | 'arhiva';

/**
 * Detalj sastanka — header sa statusnim tokom + 5 tabova (paritet 1.0 sastanakDetalj).
 * Renderuje se KAO STANJE unutar `/sastanci` (app je statički `output: export` — nema
 * dinamičkih ruta); `onBack` vraća na liste.
 */
export function SastanakDetalj({ id, onBack }: { id: string; onBack: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<DetailTab>('zapisnik');
  const [busy, setBusy] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Potvrda zaključavanja = modal sa izborom datuma zapisnika (zahtev 014/26).
  const [lockOpen, setLockOpen] = useState(false);
  // Ponuda „Pošalji ponovo" posle promene termina — NIKAD auto-slanje (odluka
  // vlasnika): pozivnica sa novim .ics ostaje svestan klik. Traka je neblokirajuća
  // i sama nestaje tek na akciju ili „Ne sada".
  const [terminChanged, setTerminChanged] = useState(false);

  const fullQ = useSastanakFull(id);
  const updateS = useUpdateSastanak();
  const markPrisutni = useMarkPrisutni();
  const seed = useSeedFromTeme();
  const lock = useLockSastanak();
  const reopen = useReopenSastanak();
  const invites = useSendInvites();
  const uploadPdf = useUploadArhivaPdf();

  const sast = fullQ.data?.data;
  const canEdit = can(PERMISSIONS.SASTANCI_EDIT);
  const canManage = can(PERMISSIONS.SASTANCI_MANAGE);
  // „Obriši sastanak" (zahtev 013/26): vidljivo `sastanci.edit` holderima; RED
  // (organizator ∨ mgmt) presuđuje sy15 RLS. Zaključan sastanak sme samo mgmt
  // (DB guard sast_check_not_locked = 422 za ostale) — zato ga tada krijemo osim
  // za manage, da izbegnemo zajamčeni 422.
  const canDeleteMeeting = canEdit && (sast?.status !== 'zakljucan' || canManage);

  // Red „Od prošlog sastanka" (PDF/AI rezime) — sidro = PRETHODNI ZAKLJUČANI
  // sastanak (BE weekly-diff; 1.0 paritet). Raniji `since = sopstveni zakljucanAt`
  // je pre lock-a bio null → uvek „0 novo · 0 završeno". data === null (nema
  // prethodnog) → red se NE prikazuje ni u headeru ni u PDF-u.
  const diffQ = useSastanakWeeklyDiff(id);
  const dd = diffQ.data?.data;
  const weeklyDiff: WeeklyDiff | null = dd
    ? { novo: dd.novo, zavrsenoOveNedelje: dd.zavrsenoOveNedelje, kasni: dd.kasni, aktivnih: dd.aktivnih }
    : null;

  // S1 — „Prethodni zapisnik": id prethodnog ZAKLJUČANOG sastanka dolazi iz istog
  // weekly-diff odgovora (aditivno). `?? null` je graciozno dok BE polje još ne
  // vraća — dugme se tada prosto ne prikazuje.
  const prethodniSastanakId = dd?.prethodniSastanakId ?? null;
  // Snapshot prethodnog SAMO iz već postojećeg keša, bez subscribe-a: aktivan
  // useArhive ovde bi na svako otvaranje detalja (i na svaku mutaciju, jer sve
  // invalidiraju širok ['sastanci'] ključ) skidao CELU arhivu sa punim snapshot
  // jsonb-ovima. Ako keša nema, helper štampa živim putem (sam fetch-uje detalj).
  const [printBusy, setPrintBusy] = useState(false);

  async function stampajPrethodni() {
    if (!prethodniSastanakId || printBusy) return;
    setPrintBusy(true);
    try {
      const arh = qc
        .getQueryData<{ data: Arhiva[] }>(arhiveQueryKey)
        ?.data.find((a) => a.sastanakId === prethodniSastanakId);
      await stampajZapisnik(qc, prethodniSastanakId, arh?.snapshot);
    } finally {
      setPrintBusy(false);
    }
  }

  // ⭐ prioritet predmeta — redosled RN grupa u zvaničnom (zaključanom) PDF-u.
  const prioQ = usePredmetPrioritet();

  async function pocni() {
    if (!sast) return;
    setBusy('pocni');
    try {
      await updateS.mutateAsync({ id: sast.id, patch: { status: 'u_toku' } });
      await markPrisutni.mutateAsync({ id: sast.id });
      await seed.mutateAsync({ id: sast.id }).catch(() => {});
      await fullQ.refetch();
    } finally {
      setBusy(null);
    }
  }

  /**
   * Zaključavanje — zahtev 014/26 t.1 + presuda vlasnika 25.07.2026.
   * Datum koji nosi PDF zapisnik, mejl i naziv priloga („Zapisnik-<datum>.pdf") bira
   * se u `ZapisnikDatumModal`: podrazumevano DANAS (dan zaključavanja), uz prečicu na
   * zakazani termin kad se razlikuju. Raniji goli `confirm` je samo prikazivao
   * `sast.datum` i upućivao na „Uredi" — ovde se datum stvarno bira.
   */
  async function zakljucaj(zapisnikDatum: string) {
    if (!sast) return;
    setBusy('lock');
    try {
      // Zvanični (zaključani) PDF ne sme na potencijalno stale/failed hook
      // snapshotove — sveže dohvati SAM SASTANAK (tačke/učesnici/akcije), weekly-diff
      // i ⭐ prioritet predmeta; ako bilo koji refetch padne, PREKINI zaključavanje.
      // `fullQ` je ovde dodat naknadno (review F19): PRVI, najvažniji PDF se gradio iz
      // keširanog `sast`, dok ga re-generisanje na zaključanom već čita sveže — pa je
      // zvanični zapisnik bio jedini koji je mogao da promaši poslednju izmenu.
      const [fullRes, diffRes, prioRes] = await Promise.all([
        fullQ.refetch(),
        diffQ.refetch(),
        prioQ.refetch(),
      ]);
      const fresh = fullRes.data?.data;
      if (fullRes.isError || diffRes.isError || prioRes.isError || !fresh) {
        alert('Ne mogu da učitam podatke za PDF (sastanak / od prošlog sastanka / prioritet predmeta) — pokušaj ponovo.');
        return;
      }
      // Jeftin FE guard uz BE proveru (review D5): drugi tab / drugi klik / druga
      // sesija su možda već zaključali. Bez ovoga bismo upload-om prepisali zvanični
      // PDF, a `already_locked` bi prošao kao uspeh — PDF i datum bi se razišli.
      if (fresh.status === 'zakljucan') {
        alert('Sastanak je u međuvremenu već zaključan — prikaz je osvežen. Za zamenu PDF-a koristi „Re-generiši PDF" u tabu Arhiva.');
        setLockOpen(false);
        return;
      }
      const freshDd = diffRes.data?.data;
      const freshDiff: WeeklyDiff | null = freshDd
        ? {
            novo: freshDd.novo,
            zavrsenoOveNedelje: freshDd.zavrsenoOveNedelje,
            kasni: freshDd.kasni,
            aktivnih: freshDd.aktivnih,
          }
        : null;
      // Izabrani datum ide i u PDF (override — kolona se upisuje tek u /lock) i u
      // sam /lock, da ga sy15 triger uhvati u payload-u mejla iz ISTOG UPDATE-a.
      const blob = await generateSastanakPdf(buildPdfInput(fresh, freshDiff, prioRes.data?.data, zapisnikDatum));
      const cid = newClientEventId();
      const up = await uploadPdf.mutateAsync({ id: sast.id, blob, clientEventId: cid });
      const res = await lock.mutateAsync({
        id: sast.id,
        clientEventId: cid,
        pdfStoragePath: up.data.storagePath,
        zapisnikDatum,
      });
      // Echo provera (review D10): FE i BE se deploy-uju nezavisno, a globalni
      // ValidationPipe (`whitelist: true` bez `forbidNonWhitelisted`) bi na starijem
      // backendu TIHO odbacio `zapisnikDatum` — PDF bi nosio jedan, a mejl drugi datum.
      const upisan = String(res.data?.zapisnik_datum ?? '').slice(0, 10);
      if (res.data?.ok !== false && upisan && upisan !== zapisnikDatum) {
        alert(
          `Sastanak je zaključan, ali je upisan datum ${formatDatum(upisan)} umesto ${formatDatum(zapisnikDatum)}. ` +
            'Ispravi ga kroz „Ispravi datum zapisnika" u tabu Arhiva.',
        );
      }
      setLockOpen(false);
      await fullQ.refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Zaključavanje nije uspelo.');
    } finally {
      setBusy(null);
    }
  }

  const tabs: TabItem<DetailTab>[] = [
    { key: 'zapisnik', label: 'Zapisnik' },
    { key: 'akcije', label: 'Akcije' },
    { key: 'priprema', label: 'Priprema' },
    { key: 'odluke', label: 'Odluke' },
    { key: 'arhiva', label: 'Arhiva' },
  ];

  return (
    <>
      <header className="flex min-h-[var(--command-bar-height)] shrink-0 flex-wrap items-center gap-3 border-b border-line bg-surface px-6 py-2">
        <button onClick={onBack} className="rounded-control p-1.5 text-ink-secondary hover:bg-surface-2" aria-label="Nazad">
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </button>
        {fullQ.isLoading ? (
          <span className="text-sm text-ink-secondary">Učitavanje…</span>
        ) : !sast ? (
          <span className="text-sm text-status-danger">Sastanak nije pronađen.</span>
        ) : (
          <>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-semibold text-ink">{sast.naslov}</h1>
              <p className="tnums text-xs text-ink-secondary">
                {SASTANAK_TIP_LABEL[sast.tip] ?? sast.tip} · {formatDatum(sast.datum)} · {formatVreme(sast.vreme)}
                {sast.mesto ? ` · ${sast.mesto}` : ''}
                {/* Zapisnik ume da nosi drugi datum od zakazanog termina (zahtev 014/26);
                    prikaži ga tu da PDF i zaglavlje nikad ne govore različito. */}
                {sast.zapisnikDatum &&
                String(sast.zapisnikDatum).slice(0, 10) !== String(sast.datum).slice(0, 10)
                  ? ` · zapisnik: ${formatDatum(zapisnikDatumOf(sast))}`
                  : ''}
              </p>
            </div>
            <SastanakStatusBadge status={sast.status} />
            <div className="flex flex-wrap items-center gap-2">
              {/* S1 — štampa zapisnika PRETHODNOG (zaključanog) sastanka: čita se na
                  početku tekućeg sastanka. Prikaz samo dok sastanak još traje
                  (planiran/u_toku) i samo ako prethodni postoji. */}
              {(sast.status === 'planiran' || sast.status === 'u_toku') && prethodniSastanakId && (
                <Button variant="secondary" loading={printBusy} onClick={() => void stampajPrethodni()}>
                  <Printer className="h-4 w-4" aria-hidden /> Prethodni zapisnik
                </Button>
              )}
              {/* Meta-izmena termina (paritet 1.0 pripremiTab). Zaključan sastanak se
                  ne dira — prvo „Otvori ponovo" (mgmt), kao i kod ostalih izmena. */}
              {sast.status !== 'zakljucan' && (
                <Can permission={PERMISSIONS.SASTANCI_EDIT}>
                  <Button variant="secondary" onClick={() => setEditOpen(true)}>
                    <Pencil className="h-4 w-4" aria-hidden /> Uredi
                  </Button>
                </Can>
              )}
              {/* Otkazivanje (S2) — samo dok sastanak nije održan/zatvoren. Šalje
                  mejlove, pa ide preko confirm dijaloga, ne odmah na klik. */}
              {(sast.status === 'planiran' || sast.status === 'u_toku') && (
                <Can permission={PERMISSIONS.SASTANCI_EDIT}>
                  <Button variant="danger" onClick={() => setCancelOpen(true)}>
                    <CalendarX className="h-4 w-4" aria-hidden /> Otkaži sastanak
                  </Button>
                </Can>
              )}
              {sast.status === 'planiran' && (
                <>
                  <Can permission={PERMISSIONS.SASTANCI_MANAGE}>
                    <Button variant="secondary" loading={invites.isPending} onClick={() => invites.mutate({ id: sast.id })}>
                      <Send className="h-4 w-4" aria-hidden /> {sast.pozivnicePoslateAt ? 'Pošalji ponovo' : 'Zakaži (pozivnice)'}
                    </Button>
                  </Can>
                  <Can permission={PERMISSIONS.SASTANCI_EDIT}>
                    <Button loading={busy === 'pocni'} onClick={() => void pocni()}>
                      <Play className="h-4 w-4" aria-hidden /> Počni sastanak
                    </Button>
                  </Can>
                </>
              )}
              {sast.status === 'u_toku' && (
                <Can permission={PERMISSIONS.SASTANCI_EDIT}>
                  <Button loading={busy === 'lock'} onClick={() => setLockOpen(true)}>
                    <Lock className="h-4 w-4" aria-hidden /> Zaključaj
                  </Button>
                </Can>
              )}
              {(sast.status === 'zakljucan' || sast.status === 'zavrsen') && (
                <Can permission={PERMISSIONS.SASTANCI_MANAGE}>
                  <Button variant="secondary" loading={reopen.isPending} onClick={() => reopen.mutate({ id: sast.id })}>
                    <Unlock className="h-4 w-4" aria-hidden /> Otvori ponovo
                  </Button>
                </Can>
              )}
              {/* Brisanje (zahtev 013/26) — TRAJNO uklanjanje sastanka (razlika od
                  „Otkaži" koji ga čuva). Organizator/mgmt (RLS presuđuje); dostupno
                  u svakom statusu (zaključan samo mgmt). Ide preko confirm dijaloga. */}
              {canDeleteMeeting && (
                <Button variant="danger" onClick={() => setDeleteOpen(true)}>
                  <Trash2 className="h-4 w-4" aria-hidden /> Obriši sastanak
                </Button>
              )}
            </div>
          </>
        )}
      </header>

      {sast && (
        <div className="flex-1 space-y-4 overflow-auto p-6">
          {terminChanged && sast.status === 'planiran' && (
            <div
              role="status"
              aria-live="polite"
              className="flex flex-wrap items-center gap-3 rounded-panel border border-status-warn/40 bg-status-warn-bg px-4 py-3"
            >
              <p className="min-w-0 flex-1 basis-64 text-sm text-ink">
                Termin je promenjen. Učesnici imaju staru pozivnicu — pošalji pozivnice ponovo da
                dobiju novi termin u kalendaru (.ics).
              </p>
              <div className="flex shrink-0 gap-2">
                <Button variant="secondary" onClick={() => setTerminChanged(false)}>
                  Ne sada
                </Button>
                <Can permission={PERMISSIONS.SASTANCI_MANAGE}>
                  <Button
                    loading={invites.isPending}
                    onClick={() =>
                      invites.mutate(
                        { id: sast.id },
                        { onSuccess: () => setTerminChanged(false) },
                      )
                    }
                  >
                    <Send className="h-4 w-4" aria-hidden /> Pošalji ponovo
                  </Button>
                </Can>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2 text-xs text-ink-secondary">
            <Chip label={`Učesnici ${sast.overview.prisutni}/${sast.overview.ucesnici}`} />
            <Chip label={`Tačke ${sast.overview.aktivnosti}`} />
            <Chip label={`Akcije ${sast.overview.akcijeOtvorene} otv.`} />
            <Chip label={`Odluke ${sast.overview.odluke}`} />
          </div>

          <Tabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Detalj sastanka" />

          {tab === 'zapisnik' && <DetaljZapisnik sast={sast} canEdit={canEdit} weeklyDiff={weeklyDiff} />}
          {tab === 'akcije' && <DetaljAkcije sastanakId={sast.id} canEdit={canEdit} />}
          {tab === 'priprema' && <DetaljPriprema sast={sast} canEdit={canEdit} />}
          {tab === 'odluke' && <DetaljOdluke sastanakId={sast.id} odluke={sast.odluke} canEdit={canEdit} />}
          {tab === 'arhiva' && <DetaljArhiva sast={sast} weeklyDiff={weeklyDiff} />}
        </div>
      )}

      {sast && cancelOpen && (
        <OtkaziSastanakDialog
          sast={sast}
          onClose={() => setCancelOpen(false)}
          onDone={() => {
            setCancelOpen(false);
            void fullQ.refetch();
          }}
        />
      )}

      {sast && deleteOpen && (
        <ObrisiSastanakDialog
          sast={sast}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => {
            setDeleteOpen(false);
            toast('Sastanak je obrisan.');
            onBack();
          }}
        />
      )}

      {sast && editOpen && (
        <UrediSastanakModal
          sast={sast}
          onClose={() => setEditOpen(false)}
          onSaved={(changedTermin) => {
            setEditOpen(false);
            if (changedTermin) setTerminChanged(true);
            void fullQ.refetch();
          }}
        />
      )}

      {sast && lockOpen && (
        <ZapisnikDatumModal
          mode="lock"
          datumSastanka={sast.datum}
          busy={busy === 'lock'}
          onPotvrdi={(d) => void zakljucaj(d)}
          onClose={() => setLockOpen(false)}
        />
      )}
    </>
  );
}

function Chip({ label }: { label: string }) {
  return <span className="rounded-full border border-line bg-surface px-2.5 py-1">{label}</span>;
}

/**
 * Potvrda otkazivanja (S2). Radnja je destruktivna I šalje mejlove, pa mora biti
 * eksplicitna — zato dijalog, a ne `confirm()`: tekst mora da kaže koliko ljudi
 * dobija obaveštenje, a greška sa servera se prikazuje u dijalogu (kod `confirm()`
 * bi završila u `alert`-u).
 *
 * `dismissable` ostaje podrazumevano `true` — ovde nema unosa, pa su Escape i klik
 * na pozadinu ispravan „odustani" (za razliku od obrasca „Uredi", B1).
 *
 * BE/RPC može vratiti `ok:false` (zaključan / već otkazan) — to NIJE greška nego
 * poruka; dijalog je prikaže i osveži detalj.
 */
function OtkaziSastanakDialog({
  sast,
  onClose,
  onDone,
}: {
  sast: SastanakFull;
  onClose: () => void;
  onDone: () => void;
}) {
  const cancelM = useCancelSastanak();
  const [error, setError] = useState<string | null>(null);
  const pozvanih = sast.ucesnici.filter((u) => u.pozvan).length;

  async function submit() {
    setError(null);
    try {
      const res = await cancelM.mutateAsync({ id: sast.id, clientEventId: newClientEventId() });
      if (res.data?.ok === false) {
        setError(
          res.data.reason === 'locked'
            ? 'Sastanak je zaključan — prvo ga otvori ponovo, pa otkaži.'
            : 'Sastanak je već otkazan.',
        );
        return;
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Otkazivanje nije uspelo.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Otkaži sastanak"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Odustani</Button>
          <Button variant="danger" loading={cancelM.isPending} onClick={() => void submit()}>
            <CalendarX className="h-4 w-4" aria-hidden /> Otkaži i obavesti
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-ink">
        <p>
          Sastanak <strong>{sast.naslov}</strong> ({formatDatum(sast.datum)}
          {sast.vreme ? `, ${formatVreme(sast.vreme)}` : ''}) dobija status <strong>Otkazan</strong>.
        </p>
        <p className="rounded-panel border border-status-warn/40 bg-status-warn-bg px-3 py-2">
          {pozvanih > 0 ? (
            <>
              Svim pozvanim učesnicima (<strong className="tnums">{pozvanih}</strong>) biće{' '}
              <strong>poslat mejl o otkazivanju</strong>. Slanje se ne može opozvati.
            </>
          ) : (
            <>Nema pozvanih učesnika — mejl neće biti poslat nikome.</>
          )}
        </p>
        <p className="text-xs text-ink-secondary">
          Sastanak se ne briše: zapisnik, akcije i odluke ostaju. Otvorene akcije prebaci na
          naredni sastanak pre otkazivanja („Sedmični + prenos“).
        </p>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

/**
 * Potvrda BRISANJA sastanka (zahtev 013/26 — Zoran Jaraković, odobreno 24.07.2026).
 * Razlika od „Otkaži": brisanje je TRAJNO i uklanja sastanak. Zato eksplicitan
 * dijalog sa jasnim upozorenjem, a ne `confirm()`. Za žive sastanke (planiran/
 * u_toku) sa pozvanima BE prvo pušta cancel tok (mejl o otkazivanju), pa briše —
 * dijalog to najavljuje. Server greška (403 nemate prava / 422 zaključan) se
 * prikazuje u dijalogu. `dismissable` ostaje default `true` (nema unosa → Escape/
 * klik na pozadinu je ispravan „odustani").
 */
function ObrisiSastanakDialog({
  sast,
  onClose,
  onDeleted,
}: {
  sast: SastanakFull;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const deleteM = useDeleteSastanak();
  const [error, setError] = useState<{ msg: string; detail?: string } | null>(null);
  const pozvanih = sast.ucesnici.filter((u) => u.pozvan).length;
  // Isti gejt kao BE (otkaz-pre-brisanja): živ sastanak + bar jedan pozvan.
  const willNotify = (sast.status === 'planiran' || sast.status === 'u_toku') && pozvanih > 0;

  async function submit() {
    setError(null);
    try {
      await deleteM.mutateAsync({ id: sast.id });
      onDeleted();
    } catch (e) {
      // Ljudska poruka umesto sirove BE greške (koja za živ sastanak sa pozvanima
      // nosi tekst o OTKAZIVANJU, a drugde UUID). 403 = nema prava; 404 = red je u
      // međuvremenu nestao (konkurentno brisanje); ostalo (npr. 422 zaključan) →
      // generička poruka + BE detalj u drugom, prigušenom redu.
      setError(mapDeleteError(e));
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Obriši sastanak"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Odustani</Button>
          <Button variant="danger" loading={deleteM.isPending} onClick={() => void submit()}>
            <Trash2 className="h-4 w-4" aria-hidden /> Obriši trajno
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-ink">
        <p>
          Sastanak <strong>{sast.naslov}</strong> ({formatDatum(sast.datum)}
          {sast.vreme ? `, ${formatVreme(sast.vreme)}` : ''}) se <strong>trajno briše</strong>.
        </p>
        <p className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2">
          Zapisnik, tačke, slike, odluke i arhiva ovog sastanka se <strong>brišu i ne mogu se
          vratiti</strong>. Otvorene akcije i PM teme ostaju (veza sa sastankom se uklanja).
        </p>
        {willNotify && (
          <p className="rounded-panel border border-status-warn/40 bg-status-warn-bg px-3 py-2">
            Sastanak još nije održan — svim pozvanim učesnicima (
            <strong className="tnums">{pozvanih}</strong>) biće{' '}
            <strong>poslat mejl o otkazivanju</strong> pre brisanja. Slanje se ne može opozvati.
          </p>
        )}
        {error && (
          <div className="space-y-0.5">
            <p className="text-sm text-status-danger">{error.msg}</p>
            {error.detail && (
              <p className="break-words text-xs text-ink-secondary">{error.detail}</p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Sirovu BE grešku brisanja → ljudska poruka (+ opcioni detalj u drugom redu). */
function mapDeleteError(e: unknown): { msg: string; detail?: string } {
  if (e instanceof ApiError) {
    if (e.status === 403) return { msg: 'Brisanje nije uspelo: nemate pravo nad ovim sastankom.' };
    if (e.status === 404) return { msg: 'Sastanak više ne postoji — osvežite listu.' };
    return { msg: 'Brisanje nije uspelo.', detail: e.message };
  }
  return { msg: 'Brisanje nije uspelo.', detail: e instanceof Error ? e.message : undefined };
}

/**
 * „Uredi" — meta podaci već zakazanog termina (naslov/datum/vreme/mesto) + učesnici,
 * paritet 1.0 pripremiTab meta-edit. Menja SAMO ovaj sastanak; ritam ponavljajuće
 * serije se podešava kroz šablone (Admin ⚙ → Šabloni), za buduće termine.
 *
 * Zahtev 014/26 t.3 — poruka više ne pominje nepostojeći „tab Šabloni" (šabloni su
 * iza ⚙ i tiču se serija, ne pojedinačnog sastanka); opisuje stvarni tok izmene.
 * Zahtev 014/26 t.4 — dodavanje/uklanjanje učesnika (reuse DirectoryMultiPicker +
 * postojeće add/remove rute). Izmene učesnika se primenjuju ODMAH (svaka je svoja
 * mutacija), za razliku od naslova/datuma/vremena/mesta koji idu na „Sačuvaj".
 * Dodat učesnik na PLANIRAN sastanak → sy15 trigger automatski šalje pozivnicu;
 * uklonjeni učesnik ne dobija nikakvo obaveštenje.
 *
 * `dismissable={false}` — obrazac sa unosom se ne sme zatvoriti klikom na pozadinu
 * ni Escape-om (B1), samo X / Otkaži.
 */
function UrediSastanakModal({
  sast,
  onClose,
  onSaved,
}: {
  sast: SastanakFull;
  onClose: () => void;
  /** `changedTermin` = datum i/ili vreme su stvarno promenjeni (→ ponuda re-send pozivnica). */
  onSaved: (changedTermin: boolean) => void;
}) {
  const update = useUpdateSastanak();
  const addU = useAddUcesnik();
  const removeU = useRemoveUcesnik();
  // Živi detalj deli keš sa roditeljem (isti query-key) — add/remove invalidiraju
  // ['sastanci'] pa se lista učesnika ovde osvežava sama.
  const fullQ = useSastanakFull(sast.id);
  const ucesnici = fullQ.data?.data.ucesnici ?? sast.ucesnici;
  const currentEmails = ucesnici.map((u) => u.email);
  // Otkazan (i zaključan — mada dotle „Uredi" i ne stiže) → učesnici se ne diraju,
  // isto kao Priprema tab (detalj-priprema.tsx: locked = zakljucan ∨ otkazan).
  const ucesniciLocked = sast.status === 'zakljucan' || sast.status === 'otkazan';

  const datum0 = String(sast.datum ?? '').slice(0, 10);
  const vreme0 = sast.vreme ? formatVreme(sast.vreme) : '';
  const [naslov, setNaslov] = useState(sast.naslov ?? '');
  const [datum, setDatum] = useState(datum0);
  const [vreme, setVreme] = useState(vreme0);
  const [mesto, setMesto] = useState(sast.mesto ?? '');
  const [toAdd, setToAdd] = useState<PickedUser[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!naslov.trim()) return setError('Naslov je obavezan.');
    if (!datum) return setError('Datum je obavezan.');
    try {
      await update.mutateAsync({
        id: sast.id,
        patch: {
          naslov: naslov.trim(),
          datum,
          // '' → BE tretira kao brisanje vremena (toDbTime); ne šalje se undefined
          // jer bi tada „obriši vreme" bilo nemoguće.
          vreme,
          mesto: mesto.trim(),
        },
      });
      onSaved(datum !== datum0 || vreme !== vreme0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Snimanje nije uspelo.');
    }
  }

  async function addParticipants() {
    setError(null);
    // Pozivnica (sy15 trigger na INSERT) nosi termin koji je TRENUTNO u bazi. Ako
    // je u formi promenjen datum/vreme a nije sačuvan, dodavanje bi poslalo pozivnicu
    // sa STARIM terminom → traži prvo „Sačuvaj".
    if (datum !== datum0 || vreme !== vreme0) {
      setError('Prvo sačuvajte novi termin („Sačuvaj"), pa dodajte učesnike — pozivnica nosi termin koji važi u trenutku dodavanja.');
      return;
    }
    try {
      // Sekvencijalno — svaki INSERT okida invite trigger (planiran). Preskoči
      // već-prisutne (retry posle delimičnog neuspeha ne sme da POST-uje duplikat →
      // 409) i skini svakog uspešno dodatog iz `toAdd` ODMAH, da retry krene od
      // prvog nedodatog (a ne da ponovi već upisane).
      const have = new Set(currentEmails.map((e) => e.toLowerCase()));
      for (const u of toAdd) {
        if (have.has(u.email.toLowerCase())) continue;
        await addU.mutateAsync({ id: sast.id, email: u.email, label: u.label });
        setToAdd((prev) => prev.filter((p) => p.email.toLowerCase() !== u.email.toLowerCase()));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dodavanje učesnika nije uspelo.');
    }
  }

  async function removeParticipant(email: string, label?: string | null) {
    // Uklanjanje briše i evidenciju (prisustvo/priprema/RSVP) — eksplicitna potvrda
    // (isti obrazac kao zaključavanje).
    if (
      !confirm(
        `Ukloniti učesnika ${label || email}? Briše se i evidencija prisustva, pripreme i RSVP za ovaj sastanak.`,
      )
    )
      return;
    setError(null);
    try {
      await removeU.mutateAsync({ id: sast.id, email });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Uklanjanje učesnika nije uspelo.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={false}
      title="Uredi sastanak"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={update.isPending} onClick={() => void submit()}>Sačuvaj</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <FormField label="Naslov" required>
          <input className={INPUT_CLS} value={naslov} onChange={(e) => setNaslov(e.target.value)} autoFocus />
        </FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Datum" required>
            <input className={INPUT_CLS} type="date" value={datum} onChange={(e) => setDatum(e.target.value)} />
          </FormField>
          <FormField label="Vreme">
            <input className={INPUT_CLS} type="time" value={vreme} onChange={(e) => setVreme(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Mesto">
          <input className={INPUT_CLS} value={mesto} onChange={(e) => setMesto(e.target.value)} />
        </FormField>

        {/* Zahtev 014/26 t.4 — učesnici (primenjuje se odmah). */}
        <div className="space-y-2 rounded-panel border border-line p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-ink">Učesnici ({ucesnici.length})</span>
            {!ucesniciLocked && <span className="text-xs text-ink-disabled">primenjuje se odmah</span>}
          </div>
          {ucesnici.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {ucesnici.map((u) => (
                <span
                  key={u.email}
                  className="inline-flex items-center gap-1 rounded-control bg-surface-2 px-2 py-1 text-xs text-ink"
                >
                  {u.label || u.email}
                  {!ucesniciLocked && (
                    <button
                      type="button"
                      onClick={() => void removeParticipant(u.email, u.label)}
                      // Onemogući dok DELETE + refetch traju — inače drugi klik na
                      // isti (još prikazan) čip udara već obrisanog → lažna „ne postoji".
                      disabled={removeU.isPending || fullQ.isFetching}
                      className="text-ink-secondary hover:text-status-danger disabled:opacity-50"
                      aria-label={`Ukloni ${u.label || u.email}`}
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  )}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-ink-secondary">Nema učesnika.</p>
          )}
          {ucesniciLocked ? (
            <p className="text-xs text-ink-secondary">Učesnici se ne menjaju na otkazanom sastanku.</p>
          ) : (
            <>
              <DirectoryMultiPicker value={toAdd} onChange={setToAdd} exclude={currentEmails} />
              {toAdd.length > 0 && (
                <Button variant="secondary" loading={addU.isPending} onClick={() => void addParticipants()}>
                  Dodaj u sastanak ({toAdd.length})
                </Button>
              )}
              <p className="text-xs text-ink-secondary">
                {sast.status === 'planiran'
                  ? 'Dodatom učesniku automatski stiže pozivnica mejlom. Uklonjeni učesnik ne dobija obaveštenje.'
                  : 'Pozivnica se automatski šalje samo za planiran sastanak — dodatom učesniku sada ne stiže mejl. Uklonjeni učesnik ne dobija obaveštenje.'}
              </p>
            </>
          )}
        </div>

        <p className="text-xs text-ink-secondary">
          Izmene važe samo za ovaj sastanak. Sastanci koji se ponavljaju podešavaju se kroz
          šablone (Admin ⚙ → Šabloni) i to važi za buduće termine.
        </p>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
