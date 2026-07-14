'use client';

import { useState } from 'react';
import { FileDown, Eye } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { fetchArhivaPdfUrl, type SastanakFull, type WeeklyDiff } from '@/api/sastanci';
import { generateSastanakPdf, type SastanakPdfInput } from '@/lib/sastanci-pdf';
import { formatDateTime } from '@/lib/format';

/**
 * Sklopi SastanakFull → ulaz za jsPDF generator (jedna grupa akcija). `diff`
 * (weekly diff) daje red „Od prošlog sastanka" — 1.0 ga uvek ima u zvaničnom/
 * emailovanom PDF-u (review nalaz #3).
 */
export function buildPdfInput(sast: SastanakFull, diff?: WeeklyDiff | null): SastanakPdfInput {
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
      ? [
          {
            naziv: 'Akcioni plan',
            rows: sast.akcije.map((a) => ({
              naslov: a.naslov,
              effectiveStatus: a.effective_status,
              status: a.status,
              odgovoranLabel: a.odgovoran_label,
              odgovoranText: a.odgovoran_text,
              odgovoranEmail: a.odgovoran_email,
              rok: a.rok,
              rokText: a.rok_text,
            })),
          },
        ]
      : [],
  };
}

/** Arhiva tab detalja — pregled nacrta PDF (nezaključan) / preuzimanje (zaključan). */
export function DetaljArhiva({ sast, weeklyDiff }: { sast: SastanakFull; weeklyDiff?: WeeklyDiff | null }) {
  const [busy, setBusy] = useState(false);
  const locked = sast.status === 'zakljucan';

  async function preview() {
    setBusy(true);
    try {
      const blob = await generateSastanakPdf(buildPdfInput(sast, weeklyDiff));
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

  return (
    <div className="space-y-4">
      {locked ? (
        <div className="rounded-panel border border-line bg-surface p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-status-warn">🔒 Zaključano</div>
          <p className="text-sm text-ink-secondary">
            Zaključano: {formatDateTime(sast.zakljucanAt)} · {sast.zakljucanByEmail ?? '—'}
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" onClick={() => void download()}>
              <FileDown className="h-4 w-4" aria-hidden /> Preuzmi PDF zapisnik
            </Button>
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
