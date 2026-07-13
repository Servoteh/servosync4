'use client';

import { useState } from 'react';
import { ArrowLeft, Play, Lock, Unlock, Send } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { Can } from '@/lib/can';
import { Button } from '@/components/ui-kit/button';
import {
  newClientEventId,
  useLockSastanak,
  useMarkPrisutni,
  useReopenSastanak,
  useSastanakFull,
  useSeedFromTeme,
  useSendInvites,
  useUpdateSastanak,
  useUploadArhivaPdf,
} from '@/api/sastanci';
import { generateSastanakPdf } from '@/lib/sastanci-pdf';
import { Tabs, type TabItem } from './tabs';
import { formatDatum, formatVreme, SASTANAK_TIP_LABEL, SastanakStatusBadge } from './common';
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
  const [tab, setTab] = useState<DetailTab>('zapisnik');
  const [busy, setBusy] = useState<string | null>(null);

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
      const blob = await generateSastanakPdf(buildPdfInput(sast));
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
            </div>
          </>
        )}
      </header>

      {sast && (
        <div className="flex-1 space-y-4 overflow-auto p-6">
          <div className="flex flex-wrap gap-2 text-xs text-ink-secondary">
            <Chip label={`Učesnici ${sast.overview.prisutni}/${sast.overview.ucesnici}`} />
            <Chip label={`Tačke ${sast.overview.aktivnosti}`} />
            <Chip label={`Akcije ${sast.overview.akcijeOtvorene} otv.`} />
            <Chip label={`Odluke ${sast.overview.odluke}`} />
          </div>

          <Tabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Detalj sastanka" />

          {tab === 'zapisnik' && <DetaljZapisnik sast={sast} canEdit={canEdit} />}
          {tab === 'akcije' && <DetaljAkcije sastanakId={sast.id} canEdit={canEdit} />}
          {tab === 'priprema' && <DetaljPriprema sast={sast} canEdit={canEdit} />}
          {tab === 'odluke' && <DetaljOdluke sastanakId={sast.id} odluke={sast.odluke} canEdit={canEdit} />}
          {tab === 'arhiva' && <DetaljArhiva sast={sast} />}
        </div>
      )}
    </>
  );
}

function Chip({ label }: { label: string }) {
  return <span className="rounded-full border border-line bg-surface px-2.5 py-1">{label}</span>;
}
