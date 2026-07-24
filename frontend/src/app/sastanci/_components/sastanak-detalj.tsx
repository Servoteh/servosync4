'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Play, Lock, Unlock, Send, Pencil, CalendarX, Printer, Trash2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { Can } from '@/lib/can';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField } from '@/components/ui-kit/form-field';
import { toast } from '@/lib/toast';
import {
  arhiveQueryKey,
  newClientEventId,
  useCancelSastanak,
  useDeleteSastanak,
  useLockSastanak,
  useMarkPrisutni,
  usePredmetPrioritet,
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
import { generateSastanakPdf } from '@/lib/sastanci-pdf';
import { Tabs, type TabItem } from './tabs';
import { formatDatum, formatVreme, INPUT_CLS, SASTANAK_TIP_LABEL, SastanakStatusBadge } from './common';
import { stampajZapisnik } from './print-zapisnik';
import { DetaljZapisnik } from './detalj-zapisnik';
import { DetaljAkcije } from './detalj-akcije';
import { DetaljPriprema } from './detalj-priprema';
import { DetaljOdluke } from './detalj-odluke';
import { DetaljArhiva, buildPdfInput } from './detalj-arhiva';

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

  async function zakljucaj() {
    if (!sast) return;
    if (!confirm('Zaključati sastanak? Zapisnik se generiše i šalje učesnicima.')) return;
    setBusy('lock');
    try {
      // Zvanični (zaključani) PDF ne sme na potencijalno stale/failed hook
      // snapshotove — sveže dohvati weekly-diff i ⭐ prioritet predmeta; ako bilo
      // koji refetch padne, PREKINI zaključavanje (bez tihog izostavljanja).
      const [diffRes, prioRes] = await Promise.all([diffQ.refetch(), prioQ.refetch()]);
      if (diffRes.isError || prioRes.isError) {
        alert('Ne mogu da učitam podatke za PDF (od prošlog sastanka / prioritet predmeta) — pokušaj ponovo.');
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
      const blob = await generateSastanakPdf(buildPdfInput(sast, freshDiff, prioRes.data?.data));
      const cid = newClientEventId();
      const up = await uploadPdf.mutateAsync({ id: sast.id, blob, clientEventId: cid });
      await lock.mutateAsync({ id: sast.id, clientEventId: cid, pdfStoragePath: up.data.storagePath });
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
                  <Button loading={busy === 'lock'} onClick={() => void zakljucaj()}>
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
  const [error, setError] = useState<string | null>(null);
  const pozvanih = sast.ucesnici.filter((u) => u.pozvan).length;
  // Isti gejt kao BE (otkaz-pre-brisanja): živ sastanak + bar jedan pozvan.
  const willNotify = (sast.status === 'planiran' || sast.status === 'u_toku') && pozvanih > 0;

  async function submit() {
    setError(null);
    try {
      await deleteM.mutateAsync({ id: sast.id });
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Brisanje nije uspelo.');
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
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

/**
 * „Uredi" — meta podaci već zakazanog termina (naslov/datum/vreme/mesto), paritet 1.0
 * pripremiTab meta-edit. Serija se i dalje menja u tabu Šabloni (važi za BUDUĆE
 * instance); ovde se menja SAMO ovaj termin.
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
  const datum0 = String(sast.datum ?? '').slice(0, 10);
  const vreme0 = sast.vreme ? formatVreme(sast.vreme) : '';
  const [naslov, setNaslov] = useState(sast.naslov ?? '');
  const [datum, setDatum] = useState(datum0);
  const [vreme, setVreme] = useState(vreme0);
  const [mesto, setMesto] = useState(sast.mesto ?? '');
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
        <p className="text-xs text-ink-secondary">
          Menja se samo ovaj termin. Ritam serije (svi budući termini) se menja u tabu „Šabloni“.
        </p>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
