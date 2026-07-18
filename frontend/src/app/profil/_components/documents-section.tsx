'use client';

import { useState } from 'react';
import { BookOpen, ClipboardList, Gem, FolderArchive, FileText, Printer, Check } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { toast } from '@/lib/toast';
import { printDocument } from '@/lib/print-document';
import { formatDate } from '@/lib/format';
import { newClientEventId, useAckDocument, useAcks, useVacation, usePosition, useProfileMe } from '@/api/moj-profil';
import { generateVacationRecordPdf, generateJobPositionPdf, openBlob, downloadBlob } from '@/lib/hr-pdf';
import { Section } from './section';
import { PRAVILNIK_GO_HTML, PRAVILNIK_GO_CSS, PRAVILNIK_GO_ACK } from './pravilnik-go-content';
import { KOMP_VREDNOSTI_HTML, KOMP_VREDNOSTI_CSS, KOMP_VREDNOSTI_ACK } from './company-values-content';

/**
 * Dokumenta i saglasnosti (paritet 1.0 „Moj profil" — Pravilnik GO + Kompanijske
 * vrednosti + „Upoznat/Saglasan" ack + Evidencija GO PDF + Opis pozicije PDF).
 *
 * Sadržaj pravilnika/vrednosti prenet DOSLOVNO iz 1.0 (pravilnik-go-content.tsx /
 * company-values-content.tsx). Štampa/PDF = izolovani print-iframe (pun Unicode).
 * Ack ide na `POST /v1/profile/acks` (useAckDocument); inicijalni status („Potvrđeno"
 * bez klika) čita se iz `GET /v1/profile/acks` (useAcks). Dupli ack je bezopasan
 * (ON CONFLICT DO NOTHING → alreadyAcked:true).
 */

type AckState = { done: boolean; at: string | null };

/** Dugme „Upoznat/Saglasan" za jedan dokument (ack); inicijalni status iz GET /acks. */
function AckButton({ refType, refId, label }: { refType: string; refId: string; label: string }) {
  const ackM = useAckDocument();
  const acksQ = useAcks();
  const existing = acksQ.data?.data?.find((a) => a.ref_type === refType && a.ref_id === refId);
  const [state, setState] = useState<AckState>({ done: false, at: null });
  const done = state.done || !!existing;
  const at = state.at ?? existing?.acked_at ?? null;

  async function onAck() {
    try {
      const res = (await ackM.mutateAsync({ clientEventId: newClientEventId(), refType, refId, label })) as {
        data?: { alreadyAcked?: boolean; acked_at?: string | null };
      };
      const d = res?.data ?? {};
      const at = d.acked_at ?? new Date().toISOString();
      setState({ done: true, at });
      toast(d.alreadyAcked ? 'Već ste potvrđeni — HR to vidi' : 'Potvrđeno — HR vidi');
    } catch {
      toast('Potvrda nije uspela — pokušajte ponovo');
    }
  }

  if (done) {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-status-success">
        <span className="inline-flex items-center gap-1 rounded-control bg-status-success-bg px-2 py-1 font-medium"><Check className="h-3.5 w-3.5" aria-hidden /> Potvrđeno</span>
        {at && <span className="text-xs text-ink-secondary">{formatDate(at)}</span>}
      </span>
    );
  }
  return (
    <Button variant="primary" onClick={onAck} loading={ackM.isPending} className="h-8">
      <Check className="h-4 w-4" aria-hidden /> Upoznat/Saglasan sam
    </Button>
  );
}

/** Modal sa punim tekstom dokumenta (dangerouslySetInnerHTML) + štampa/PDF + ack. */
function DocumentModal({
  title,
  html,
  css,
  printTitle,
  ack,
  onClose,
}: {
  title: string;
  html: string;
  css: string;
  printTitle: string;
  ack: { refType: string; refId: string; label: string };
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="xl2"
      footer={
        <>
          <AckButton refType={ack.refType} refId={ack.refId} label={ack.label} />
          <Button
            variant="secondary"
            onClick={() => printDocument({ title: printTitle, css, bodyHtml: html })}
            title="Otvara dijalog za štampu — izaberi „Sačuvaj kao PDF”"
          >
            <Printer className="h-4 w-4" aria-hidden /> Štampaj / Sačuvaj PDF
          </Button>
          <Button variant="ghost" onClick={onClose}>Zatvori</Button>
        </>
      }
    >
      <div className="rounded-control border border-line bg-white p-5">
        <style dangerouslySetInnerHTML={{ __html: css }} />
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </Dialog>
  );
}

export function DocumentsSection() {
  const [modal, setModal] = useState<'pravilnik' | 'vrednosti' | null>(null);

  const vacationQ = useVacation();
  const positionQ = usePosition();
  const meQ = useProfileMe();
  const [goBusy, setGoBusy] = useState(false);
  const [posBusy, setPosBusy] = useState(false);

  const employeeName = meQ.data?.data?.employee?.full_name ?? '';

  async function onEvidencijaGo() {
    const data = vacationQ.data?.data;
    const blocks = data?.ledger ?? [];
    if (!blocks.length) {
      toast('Nema podataka o godišnjem odmoru za evidenciju.');
      return;
    }
    setGoBusy(true);
    try {
      const year = new Date().getFullYear();
      const current = blocks.find((b) => b.godina === year) ?? null;
      const { blob, fileName } = await generateVacationRecordPdf({
        employeeName: employeeName || '—',
        year,
        current,
        blocks,
        generatedDate: formatDate(new Date().toISOString().slice(0, 10)),
      });
      openBlob(blob);
      downloadBlob(blob, fileName);
    } catch (e) {
      toast('PDF nije uspeo: ' + (e instanceof Error ? e.message : ''));
    } finally {
      setGoBusy(false);
    }
  }

  async function onOpisPozicije() {
    const p = positionQ.data?.data;
    if (!p) {
      toast('Pozicija nije povezana sa opisom — obratite se HR-u.');
      return;
    }
    setPosBusy(true);
    try {
      const { blob, fileName } = await generateJobPositionPdf(p, employeeName ? { fullName: employeeName } : null);
      openBlob(blob);
      downloadBlob(blob, fileName);
    } catch (e) {
      toast('PDF nije uspeo: ' + (e instanceof Error ? e.message : ''));
    } finally {
      setPosBusy(false);
    }
  }

  return (
    <Section icon={<BookOpen className="h-4 w-4 text-ink-secondary" />} title="Dokumenta i saglasnosti" defaultOpen>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setModal('pravilnik')}><ClipboardList className="h-4 w-4" aria-hidden /> Pravilnik o GO</Button>
        <Button variant="secondary" onClick={() => setModal('vrednosti')}><Gem className="h-4 w-4" aria-hidden /> Kompanijske vrednosti</Button>
        <Button variant="secondary" onClick={onEvidencijaGo} loading={goBusy}><FolderArchive className="h-4 w-4" aria-hidden /> Evidencija GO (PDF)</Button>
        <Button variant="secondary" onClick={onOpisPozicije} loading={posBusy}><FileText className="h-4 w-4" aria-hidden /> Opis pozicije (PDF)</Button>
      </div>
      <p className="mt-2 text-xs text-ink-secondary">
        Otvorite dokument da pročitate pun tekst i potvrdite da ste upoznati/saglasni („Upoznat/Saglasan sam"), ili ga
        odštampajte / sačuvajte kao PDF. Evidencija GO i Opis pozicije se generišu iz Vaših podataka.
      </p>

      {modal === 'pravilnik' && (
        <DocumentModal
          title="Pravilnik o korišćenju godišnjeg odmora"
          html={PRAVILNIK_GO_HTML}
          css={PRAVILNIK_GO_CSS}
          printTitle="Pravilnik o korišćenju godišnjeg odmora — Servoteh"
          ack={PRAVILNIK_GO_ACK}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'vrednosti' && (
        <DocumentModal
          title="Kompanijske vrednosti"
          html={KOMP_VREDNOSTI_HTML}
          css={KOMP_VREDNOSTI_CSS}
          printTitle="Kompanijske vrednosti — Servoteh"
          ack={KOMP_VREDNOSTI_ACK}
          onClose={() => setModal(null)}
        />
      )}
    </Section>
  );
}
