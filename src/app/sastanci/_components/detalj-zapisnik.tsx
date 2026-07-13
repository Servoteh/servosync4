'use client';

import { useState } from 'react';
import { ArrowDown, ArrowUp, Check, Plus, Trash2, Download, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { DictateButton, RefineButton } from '@/components/voice-controls';
import {
  aiSummary,
  newClientEventId,
  useCreateAktivnost,
  useDeleteAktivnost,
  useReorderAktivnosti,
  useSeedFromTeme,
  useUpdateAktivnost,
  type Aktivnost,
  type SastanakFull,
  type WeeklyDiff,
} from '@/api/sastanci';
import { formatDatum, formatVreme, INPUT_CLS } from './common';

/** Zapisnik tab — tačke (CRUD + reorder + STT/refine + obrađeno) + Uvezi teme + AI rezime. */
export function DetaljZapisnik({
  sast,
  canEdit,
  weeklyDiff,
}: {
  sast: SastanakFull;
  canEdit: boolean;
  weeklyDiff?: WeeklyDiff | null;
}) {
  const seed = useSeedFromTeme();
  const create = useCreateAktivnost();
  const reorder = useReorderAktivnosti();
  const [summary, setSummary] = useState<string | null>(null);
  const [summBusy, setSummBusy] = useState(false);

  const tacke = sast.aktivnosti;
  const locked = sast.status === 'zakljucan' || sast.status === 'otkazan';
  const editable = canEdit && !locked;

  function move(idx: number, dir: -1 | 1) {
    const next = [...tacke];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    reorder.mutate({ id: sast.id, ids: next.map((t) => t.id) });
  }

  async function runSummary() {
    setSummBusy(true);
    try {
      // Payload MORA pratiti backend buildSummaryContent (§sastanci-summary):
      // {naslov,datum,vreme,mesto,ucesnici[],diff,grupe[{code,naziv,akcije[…]}]}.
      // Ranije poslati {aktivnosti,akcije} bili su ignorisani → „(nema zadataka)"
      // (review nalaz #2). Grupe = paritet 1.0 buildPayload/packAkcija.
      const grupe = sast.akcije.length
        ? [
            {
              code: '',
              naziv: 'Akcioni plan',
              akcije: sast.akcije.map((a, i) => ({
                rb: a.rb ?? i + 1,
                naslov: a.naslov,
                opis: a.opis ?? '',
                odgovoran: a.odgovoran_label || a.odgovoran_text || a.odgovoran_email || '',
                rok: a.rok_text || (a.rok ? formatDatum(a.rok) : ''),
                status: a.status,
              })),
            },
          ]
        : [];
      const diff = weeklyDiff
        ? { dodato: weeklyDiff.novo, zavrseno: weeklyDiff.zavrsenoOveNedelje, kasni: weeklyDiff.kasni }
        : null;
      const res = await aiSummary(sast.id, {
        naslov: sast.naslov,
        datum: formatDatum(sast.datum),
        vreme: sast.vreme ? formatVreme(sast.vreme) : '',
        mesto: sast.mesto ?? '',
        ucesnici: sast.ucesnici.map((u) => u.label || u.email),
        diff,
        grupe,
      });
      setSummary(res.data.summary);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Sažimanje trenutno nije dostupno.');
    } finally {
      setSummBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {editable && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => create.mutate({ id: sast.id, clientEventId: newClientEventId(), naslov: 'Nova tačka' })}>
            <Plus className="h-4 w-4" aria-hidden /> Dodaj tačku
          </Button>
          <Button variant="secondary" loading={seed.isPending} onClick={() => seed.mutate({ id: sast.id })}>
            Uvezi teme sa dnevnog reda
          </Button>
          <Button variant="ghost" loading={summBusy} onClick={() => void runSummary()}>
            <Sparkles className="h-4 w-4" aria-hidden /> Sažmi zapisnik (AI)
          </Button>
        </div>
      )}

      {tacke.length === 0 ? (
        <p className="rounded-panel border border-line bg-surface p-6 text-center text-sm text-ink-secondary">
          Nema tačaka zapisnika. {editable ? 'Dodaj tačku ili uvezi teme.' : ''}
        </p>
      ) : (
        <div className="space-y-3">
          {tacke.map((t, idx) => (
            <TackaCard key={t.id} tacka={t} idx={idx} editable={editable} onMove={(d) => move(idx, d)} />
          ))}
        </div>
      )}

      {summary !== null && (
        <Dialog open onClose={() => setSummary(null)} title="AI rezime zapisnika">
          <p className="whitespace-pre-wrap text-sm text-ink">{summary}</p>
        </Dialog>
      )}
    </div>
  );
}

function TackaCard({
  tacka,
  idx,
  editable,
  onMove,
}: {
  tacka: Aktivnost;
  idx: number;
  editable: boolean;
  onMove: (dir: -1 | 1) => void;
}) {
  const update = useUpdateAktivnost();
  const del = useDeleteAktivnost();
  const [naslov, setNaslov] = useState(tacka.naslov);
  const [tekst, setTekst] = useState(tacka.sadrzajText ?? '');
  const obradjeno = tacka.status === 'zavrsen';

  function saveNaslov() {
    if (naslov !== tacka.naslov) update.mutate({ aktId: tacka.id, patch: { naslov } });
  }
  function saveTekst() {
    if (tekst !== (tacka.sadrzajText ?? '')) update.mutate({ aktId: tacka.id, patch: { sadrzajText: tekst } });
  }

  return (
    <div className="rounded-panel border border-line bg-surface p-3">
      <div className="mb-2 flex items-start gap-2">
        <span className="tnums mt-1.5 text-sm font-semibold text-ink-secondary">{idx + 1}.</span>
        <input
          className={`${INPUT_CLS} flex-1 font-medium`}
          value={naslov}
          disabled={!editable}
          onChange={(e) => setNaslov(e.target.value)}
          onBlur={saveNaslov}
        />
        {editable && (
          <div className="flex items-center gap-1">
            <button title="Gore" className="rounded-control border border-line p-1 text-ink-secondary hover:bg-surface-2" onClick={() => onMove(-1)}>
              <ArrowUp className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button title="Dole" className="rounded-control border border-line p-1 text-ink-secondary hover:bg-surface-2" onClick={() => onMove(1)}>
              <ArrowDown className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button
              title={obradjeno ? 'Vrati u obradu' : 'Označi obrađeno'}
              className={`rounded-control border p-1 ${obradjeno ? 'border-status-success/50 bg-status-success-bg text-status-success' : 'border-line text-ink-secondary'} hover:bg-surface-2`}
              onClick={() => update.mutate({ aktId: tacka.id, patch: { status: obradjeno ? 'u_toku' : 'zavrsen' } })}
            >
              <Check className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button title="Obriši" className="rounded-control border border-line p-1 text-status-danger hover:bg-surface-2" onClick={() => { if (confirm('Obrisati tačku?')) del.mutate({ aktId: tacka.id }); }}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        )}
      </div>
      <div className="pl-6">
        <div className="relative">
          <textarea
            className={`${INPUT_CLS} min-h-20`}
            value={tekst}
            disabled={!editable}
            onChange={(e) => setTekst(e.target.value)}
            onBlur={saveTekst}
            placeholder="Sadržaj tačke…"
          />
          {editable && (
            <div className="mt-1 flex gap-1">
              <DictateButton context="zapisnik" onText={(txt) => setTekst((v) => (v ? `${v} ${txt}` : txt))} />
              <RefineButton profil="zapisnik" getText={() => tekst} onText={(txt) => { setTekst(txt); update.mutate({ aktId: tacka.id, patch: { sadrzajText: txt } }); }} />
              <span className="self-center text-2xs text-ink-disabled">
                <Download className="mr-0.5 inline h-3 w-3 rotate-180" aria-hidden />diktiraj / doteraj
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
