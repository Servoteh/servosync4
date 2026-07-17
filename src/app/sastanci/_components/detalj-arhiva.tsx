'use client';

import { useState } from 'react';
import { FileDown, Eye, Mail } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { toast } from '@/lib/toast';
import {
  fetchArhivaPdfUrl,
  usePredmetPrioritet,
  useResendLocked,
  type SastanakFull,
  type WeeklyDiff,
} from '@/api/sastanci';
import { generateSastanakPdf, type SastanakPdfInput } from '@/lib/sastanci-pdf';
import { formatDateTime } from '@/lib/format';
import { groupAkcijeByRn } from './common';

/**
 * Sklopi SastanakFull → ulaz za jsPDF generator. Akcioni plan grupisan po RN-u
 * (paritet 1.0 sastanciArhiva/getSastanakFullSaAkcijama): ⭐ prioritetni predmeti
 * prvi (`prioritet` = usePredmetPrioritet lista), pa šifra sr-numeric; „Bez RN /
 * projekta" poslednja; redovi po rb — naslov PDF sekcije „Akcioni plan po
 * projektima" time je istinit. `diff` (weekly diff sa sidrom = prethodni zaključani
 * sastanak) daje red „Od prošlog sastanka"; null = red se ne crta (1.0 paritet).
 */
export function buildPdfInput(
  sast: SastanakFull,
  diff?: WeeklyDiff | null,
  prioritet?: string[] | null,
): SastanakPdfInput {
  return {
    diffSummary: diff ?? null,
    naslov: sast.naslov,
    datum: sast.datum,
    vreme: sast.vreme,
    mesto: sast.mesto,
    tip: sast.tip,
    vodioLabel: sast.vodioLabel,
    vodioEmail: sast.vodioEmail,
    zakljucanByEmail: sast.zakljucanByEmail,
    ucesnici: sast.ucesnici.map((u) => ({ email: u.email, label: u.label, prisutan: u.prisutan, pozvan: u.pozvan })),
    aktivnosti: sast.aktivnosti.map((a) => ({
      naslov: a.naslov,
      sadrzajText: a.sadrzajText,
      napomena: a.napomena,
      odgovoranLabel: a.odgovoranLabel,
      odgovoranText: a.odgovoranText,
      odgovoranEmail: a.odgovoranEmail,
      rok: a.rok,
      rokText: a.rokText,
      status: a.status,
    })),
    akcioniPlanGrouped: sast.akcije.length
      ? groupAkcijeByRn(sast.akcije, prioritet, { rowSort: 'rb' }).map((g) => ({
          code: g.code || undefined,
          naziv: g.naziv,
          rows: g.rows.map((a) => ({
            naslov: a.naslov,
            effectiveStatus: a.effective_status,
            status: a.status,
            odgovoranLabel: a.odgovoran_label,
            odgovoranText: a.odgovoran_text,
            odgovoranEmail: a.odgovoran_email,
            rok: a.rok,
            rokText: a.rok_text,
          })),
        }))
      : [],
  };
}

/** Arhiva tab detalja — pregled nacrta PDF (nezaključan) / preuzimanje + ponovno slanje (zaključan). */
export function DetaljArhiva({ sast, weeklyDiff }: { sast: SastanakFull; weeklyDiff?: WeeklyDiff | null }) {
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.SASTANCI_MANAGE);
  const prioQ = usePredmetPrioritet();
  const resendM = useResendLocked();
  const [busy, setBusy] = useState(false);
  const locked = sast.status === 'zakljucan';

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
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void download()}>
              <FileDown className="h-4 w-4" aria-hidden /> Preuzmi PDF zapisnik
            </Button>
            {canManage && (
              <Button variant="secondary" loading={resendM.isPending} onClick={() => void resend()}>
                <Mail className="h-4 w-4" aria-hidden /> Pošalji ponovo
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
    </div>
  );
}
