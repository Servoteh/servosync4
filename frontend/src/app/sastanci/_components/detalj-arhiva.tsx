'use client';

import { useState } from 'react';
import { FileDown, Eye, Mail, RefreshCw, CalendarClock } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { toast } from '@/lib/toast';
import {
  fetchArhivaPdfUrl,
  usePredmetPrioritet,
  useResendLocked,
  useSastanakFull,
  useSetZapisnikDatum,
  type SastanakFull,
  type WeeklyDiff,
} from '@/api/sastanci';
import { generateSastanakPdf } from '@/lib/sastanci-pdf';
import { formatDateTime } from '@/lib/format';
import { formatDatum } from './common';
// `buildPdfInput` je preseljen u ./zapisnik-pdf — deli ga i tok zaključavanja
// (sastanak-detalj) i re-generisanje ispod, pa mu je mesto van ovog taba.
import { buildPdfInput, useZapisnikPdfRegen, zapisnikDatumOf } from './zapisnik-pdf';
import { ZapisnikDatumModal } from './zapisnik-datum-modal';

/** Arhiva tab detalja — pregled nacrta PDF (nezaključan) / preuzimanje + ponovno slanje (zaključan). */
export function DetaljArhiva({ sast, weeklyDiff }: { sast: SastanakFull; weeklyDiff?: WeeklyDiff | null }) {
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.SASTANCI_MANAGE);
  const prioQ = usePredmetPrioritet();
  const resendM = useResendLocked();
  const [busy, setBusy] = useState(false);
  const locked = sast.status === 'zakljucan';

  // Re-generisanje zvaničnog PDF-a (1.0 regenerateSastanakPdf paritet) živi u
  // ./zapisnik-pdf — isti tok koristi i ispravka datuma ispod.
  const fullQ = useSastanakFull(sast.id);
  const { regenerisi } = useZapisnikPdfRegen(sast.id);
  const setDatumM = useSetZapisnikDatum();
  const [regenBusy, setRegenBusy] = useState(false);
  const [datumOpen, setDatumOpen] = useState(false);
  const [datumBusy, setDatumBusy] = useState(false);

  async function regenerate() {
    if (!confirm('Re-generisati PDF zapisnika iz TRENUTNIH podataka i zameniti postojeći u arhivi?')) return;
    setRegenBusy(true);
    try {
      await regenerisi();
      toast('PDF zapisnika re-generisan i sačuvan u arhivi.');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Re-generisanje PDF-a nije uspelo.');
    } finally {
      setRegenBusy(false);
    }
  }

  /**
   * Ispravka datuma zapisnika na ZAKLJUČANOM sastanku (zahtev 014/26).
   *
   * REDOSLED JE NAMERAN: prvo PDF (generisanje + upload), pa tek onda upis datuma.
   * Sve što može da padne — dohvat svežih podataka, jsPDF, storage upload — dešava
   * se PRE ijednog upisa u bazu, pa neuspeh ostavlja zapis i PDF onakvima kakvi su
   * bili (nema stanja „datum promenjen, PDF star", koje je i bio koren pritužbe).
   * Obrnut redosled bi u istom kvaru ostavio zaključan zapis koji tvrdi jedan datum
   * dok priloženi PDF nosi drugi, i „Pošalji ponovo" bi taj razlaz i razaslao mejlom.
   * Ostatak rizika je uzak i bezopasan: padne li baš PATCH posle uspešnog upload-a,
   * arhiva već drži PDF sa ISPRAVNIM (željenim) datumom, a kolona kasni — korisnik
   * dobija jasnu grešku i ponavlja radnju (idempotentno: nov PDF + isti PATCH).
   */
  async function sacuvajDatum(datum: string) {
    setDatumBusy(true);
    try {
      await regenerisi(datum);
      await setDatumM.mutateAsync({ id: sast.id, zapisnikDatum: datum });
      await fullQ.refetch();
      setDatumOpen(false);
      toast(`Datum zapisnika je sada ${formatDatum(datum)}; PDF u arhivi je zamenjen.`);
    } catch (e) {
      alert(
        `${e instanceof Error ? e.message : 'Ispravka datuma nije uspela.'}\n\n` +
          'Datum zapisnika NIJE promenjen — pokušaj ponovo.',
      );
    } finally {
      setDatumBusy(false);
    }
  }

  async function preview() {
    setBusy(true);
    try {
      const blob = await generateSastanakPdf(buildPdfInput(sast, weeklyDiff, prioQ.data?.data));
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'PDF nije moguće generisati.');
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    try {
      const res = await fetchArhivaPdfUrl(sast.id);
      if (res.data?.url) window.open(res.data.url, '_blank', 'noopener');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'PDF nije dostupan.');
    }
  }

  async function resend() {
    if (!confirm('Poslati zaključani zapisnik ponovo mejlom SVIM učesnicima sastanka?')) return;
    try {
      await resendM.mutateAsync({ id: sast.id });
      toast('Zapisnik poslat svim učesnicima.');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Slanje nije uspelo.');
    }
  }

  return (
    <div className="space-y-4">
      {locked ? (
        <div className="rounded-panel border border-line bg-surface p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-status-warn">🔒 Zaključano</div>
          <p className="text-sm text-ink-secondary">
            Zaključano: {formatDateTime(sast.zakljucanAt)} · {sast.zakljucanByEmail ?? '—'}
          </p>
          {/* Datum koji zaista stoji na PDF-u i u mejlu — vidljiv da se greška uhvati
              bez otvaranja priloga (zahtev 014/26). */}
          <p className="tnums text-sm text-ink-secondary">
            Datum zapisnika: {formatDatum(zapisnikDatumOf(sast))}
            {sast.zapisnikDatum && String(sast.zapisnikDatum).slice(0, 10) !== String(sast.datum).slice(0, 10)
              ? ` (zakazani termin: ${formatDatum(sast.datum)})`
              : ''}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void download()}>
              <FileDown className="h-4 w-4" aria-hidden /> Preuzmi PDF zapisnik
            </Button>
            {canManage && (
              <Button variant="secondary" loading={resendM.isPending} onClick={() => void resend()}>
                <Mail className="h-4 w-4" aria-hidden /> Pošalji ponovo
              </Button>
            )}
            {canManage && (
              <Button variant="secondary" onClick={() => setDatumOpen(true)}>
                <CalendarClock className="h-4 w-4" aria-hidden /> Ispravi datum zapisnika
              </Button>
            )}
            {canManage && (
              <Button variant="secondary" loading={regenBusy} onClick={() => void regenerate()}>
                <RefreshCw className="h-4 w-4" aria-hidden /> Re-generiši PDF
              </Button>
            )}
            <Button variant="ghost" loading={busy} onClick={() => void preview()}>
              <Eye className="h-4 w-4" aria-hidden /> Pregledaj (re-generiši)
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-panel border border-line bg-surface p-4">
          <p className="text-sm text-ink-secondary">Sastanak još nije zaključan. Možeš pregledati nacrt zapisnika.</p>
          <div className="mt-3">
            <Button variant="secondary" loading={busy} onClick={() => void preview()}>
              <Eye className="h-4 w-4" aria-hidden /> Pregledaj PDF (nacrt)
            </Button>
          </div>
        </div>
      )}
      {datumOpen && (
        <ZapisnikDatumModal
          mode="ispravka"
          datumSastanka={sast.datum}
          initialDatum={zapisnikDatumOf(sast)}
          busy={datumBusy}
          onPotvrdi={(d) => void sacuvajDatum(d)}
          onClose={() => setDatumOpen(false)}
        />
      )}
    </div>
  );
}
