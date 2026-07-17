'use client';

import { Fragment } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { formatDate } from '@/lib/format';
import type { OpRow } from '@/api/plan-proizvodnje';
import { rokUrgencyClass, formatSecondsHm, plannedSeconds, num } from './shared';

/**
 * „Zašto je ovo ovde?" — dijagnostika uskog grla (GAP-PM-18). DOSLOVNI port 1.0
 * whyBottleneckModal.js: uslovni tagovi (Blokirano/Čeka prethodnu/HITNO/Rok/Kooperacija/
 * CAM), 4 tematska bloka (šta vuče / zašto redosled sa auto_sort_bucket opisom / kontekst
 * operacije / šta-ako), summary linija po prioritetu, mini-markdown **bold**. Čita samo
 * polja koja već stižu iz v_production_operations_effective — bez novog backend-a.
 * Dostupno i read-only korisnicima.
 */

interface WhyTag {
  key: string;
  label: string;
}
interface WhyBlock {
  title: string;
  lines: string[];
}
interface WhyExplanation {
  summaryLine: string;
  tags: WhyTag[];
  blocks: WhyBlock[];
}

function statusLabel(s: string): string {
  switch (s) {
    case 'waiting': return 'Čeka';
    case 'in_progress': return 'U radu';
    case 'blocked': return 'Blokirano';
    case 'completed': return 'Završeno';
    default: return s || '—';
  }
}

/** Objašnjenje auto_sort_bucket (SQL add_production_g2_readiness_urgency.sql). */
export function describeAutoSortBucket(row: OpRow): string {
  const st = row.local_status || 'waiting';
  const prevDone = !!row.is_ready_for_machine;
  const b = Number(row.auto_sort_bucket);

  if (st === 'blocked') return 'prioritet za operacije označene kao blokirane (bucket 7).';
  if (b === 1) return 'HITNO RN + spremno + U radu (najviši operativni signal).';
  if (b === 2) return 'HITNO RN + spremno + Čeka.';
  if (b === 3) return 'HITNO RN + još uvek čeka prethodnu operaciju.';
  if (b === 4) return 'standard + spremno + U radu.';
  if (b === 5) return 'standard + spremno + Čeka.';
  if (b === 6) return 'standard + čeka prethodnu operaciju (često većina backlog-a).';
  if (b === 7) return 'blokirano u planu.';
  if (b === 8) return 'preostalo / ostalo (npr. završeno u planu ili rubni slučaj).';
  if (!prevDone && st === 'waiting') return 'čeka prethodni korak u nizu (niži prioritet dok prethodna ne odmakne).';
  if (row.is_urgent) return 'HITNO RN — biće iznad standardnih u automatskom delu sorta.';
  return 'mešovit automatski prioritet (vidi rok i BigTehn prioritet).';
}

function pickSummaryLine(o: {
  blocked: boolean;
  ready: boolean;
  prevSt: string;
  urgent: boolean;
  rokClass: string;
  cooperation: boolean;
  camBlocking: boolean;
}): string {
  if (o.blocked) return 'Glavni signal: operacija je ručno blokirana u planu.';
  if (!o.ready) {
    if (o.prevSt === 'in_progress') return 'Glavni signal: čeka se završetak prethodne operacije koja je u radu.';
    if (o.prevSt === 'not_started') return 'Glavni signal: prethodna operacija u nizu još nije počela.';
    return 'Glavni signal: tehnološki niz — čeka se prethodni korak.';
  }
  if (o.cooperation) return 'Glavni signal: kooperacija (spoljni tok).';
  if (o.camBlocking) return 'Glavni signal: moguće CAM / programiranje kao usko grlo.';
  if (o.urgent) return 'Glavni signal: RN je označen kao HITNO — biće više u automatskom „bucket"-u.';
  if (o.rokClass === 'overdue' || o.rokClass === 'today') return 'Glavni signal: pritisak roka isporuke.';
  return 'Glavni signal: redosled na mašini (ručno + automatski sort), bez trenutnog „tvrđeg" blokatora u podacima.';
}

export function buildWhyExplanation(row: OpRow | null): WhyExplanation {
  if (!row || typeof row !== 'object') {
    return { summaryLine: 'Nema podataka za analizu.', tags: [], blocks: [] };
  }
  const tags: WhyTag[] = [];
  const blocks: WhyBlock[] = [];

  const status = row.local_status || 'waiting';
  const urgent = !!row.is_urgent;
  const ready = !!row.is_ready_for_machine;
  const prevSt = row.previous_operation_status || 'none';
  const rokClass = rokUrgencyClass(row.rok_izrade);
  const rokLabel = row.rok_izrade ? formatDate(row.rok_izrade) : null;

  const effMac = row.assigned_machine_code || row.effective_machine_code || row.original_machine_code;
  const origMac = row.original_machine_code;

  // Tagovi
  if (status === 'blocked') tags.push({ key: 'blocked', label: 'Blokirano' });
  if (!ready) tags.push({ key: 'pred', label: 'Čeka prethodnu op.' });
  if (urgent) tags.push({ key: 'hitno', label: 'HITNO (RN)' });
  if (rokClass === 'overdue' || rokClass === 'today') {
    tags.push({ key: 'rok', label: rokClass === 'overdue' ? 'Rok istekao' : 'Rok danas' });
  }
  if (row.is_cooperation_effective) tags.push({ key: 'coop', label: 'Kooperacija' });
  if (!row.is_non_machining && !row.cam_ready) tags.push({ key: 'cam', label: 'CAM nije spreman' });

  // Blok 1
  const mainLines: string[] = [];
  if (status === 'blocked') {
    mainLines.push('Operacija je u statusu **Blokirano** u Planu proizvodnje — planer je eksplicitno zaustavio rad ili sledeći korak dok se blokada ne reši.');
  }
  if (!ready) {
    const po = row.previous_operation_operacija;
    const pm = row.previous_operation_machine_code;
    const prevHuman = po != null ? `operacija ${String(po).padStart(2, '0')}${pm ? ` (mašina ${pm})` : ''}` : 'prethodna operacija (nepoznat broj)';
    if (prevSt === 'in_progress') mainLines.push(`Prethodni korak u tehnološkom nizu je **u radu** (${prevHuman}). Ova operacija ne može da se smatra „spremnom" dok se prethodna ne zatvori po količini.`);
    else if (prevSt === 'not_started') mainLines.push(`Prethodni korak **nije počeo** (${prevHuman}). Ova operacija čeka start prethodne.`);
    else mainLines.push(`**Spremnost** za obradu na ovoj operaciji nije ispunjena — čeka se završetak ${prevHuman}.`);
  }
  if (row.is_cooperation_effective) {
    const partner = row.cooperation_partner ? String(row.cooperation_partner).trim() : '';
    const ret = row.cooperation_expected_return ? formatDate(row.cooperation_expected_return) : '';
    const src = row.cooperation_source || '';
    mainLines.push(`**Kooperacija** je aktivna${src ? ` (izvor: ${src})` : ''}.${partner ? ` Partner: ${partner}.` : ''}${ret ? ` Očekivani povratak (plan): ${ret}.` : ''}`);
  }
  if (!row.is_non_machining && !row.cam_ready && ready && status !== 'blocked') {
    mainLines.push('**CAM** nije označen kao spreman — ako je programiranje usko grlo, operacija može čekati i uprkos slobodnoj mašini.');
  }
  if ((rokClass === 'overdue' || rokClass === 'today') && mainLines.length === 0) {
    mainLines.push(
      rokClass === 'overdue'
        ? `**Rok isporuke** je u prošlosti (${rokLabel || '—'}) — pritisak na redosled, ali modul ne menja automatski prethodne operacije.`
        : `**Rok isporuke** je danas (${rokLabel || '—'}) — prioritet u listi pomoću HITNO/pin/rok sortiranja.`,
    );
  }
  if (mainLines.length === 0) {
    mainLines.push('Nema jednog „tvrdog" blokatora u podacima: prethodna operacija je zatvorena, status nije blokiran, ova operacija se u listi ponaša prema **redosledu na mašini** (ručni prioritet + automatsko sortiranje).');
  }
  blocks.push({ title: 'Šta trenutno vuče kašnjenje / red', lines: mainLines });

  // Blok 2
  const orderLines: string[] = [];
  const man = row.shift_sort_order;
  if (man != null && (man as unknown) !== '') {
    orderLines.push(`Postoji **ručni prioritet** (pin / drag-and-drop): shift_sort_order = ${String(man)} — ovaj red ide pre automatskog sorta.`);
  } else {
    orderLines.push('**Nema** ručnog shift_sort_order — redosled je od automatskog pravila u bazi.');
  }
  const bucket = row.auto_sort_bucket;
  if (bucket != null && (bucket as unknown) !== '') {
    orderLines.push(`**Automatski bucket** (auto_sort_bucket = ${String(bucket)}): ${describeAutoSortBucket(row)}`);
  }
  orderLines.push('Globalno sortiranje u aplikaciji: prvo ručni red, zatim bucket, pa **rok** (rok_izrade), pa BigTehn **prioritet** (prioritet_bigtehn), pa RN i broj operacije.');
  orderLines.push(`Plan u ovom modulu je **lista prioriteta po mašini (${String(effMac || '—')})**, ne kalendarsko zakazivanje po satima. Pozicija u listi određuje ko je „sledeći na redu" kada mašina oslobodi kapacitet.`);
  blocks.push({ title: 'Zašto je u ovom redosledu na mašini', lines: orderLines });

  // Blok 3
  const ctxLines: string[] = [];
  ctxLines.push(`**Efektivna mašina:** ${String(effMac || '—')}${origMac && origMac !== effMac ? ` (original iz BigTehn-a: ${String(origMac)})` : ''}.`);
  ctxLines.push(`**Lokalni status:** ${statusLabel(status)}. **Prijava u BigTehn:** ${row.is_done_in_bigtehn ? 'završena' : 'nije završena'} · komada urađeno ${num(row.komada_done)} / ${num(row.komada_total)}.`);
  ctxLines.push(`**Planirano / prijavljeno vreme:** ${formatSecondsHm(plannedSeconds(row))} / ${formatSecondsHm(row.real_seconds)}.`);
  if (row.shift_note && String(row.shift_note).trim()) {
    ctxLines.push(`**Napomena smene:** ${String(row.shift_note).trim()}`);
  }
  blocks.push({ title: 'Kontekst operacije', lines: ctxLines });

  // Blok 4
  blocks.push({
    title: 'Šta ako se promeni redosled',
    lines: ['Pomeranje nagore u listi skraćuje čekanje **na ovoj mašini**, ne ubrzava automatski prethodne operacije u tehnološkom nizu niti drugu mašinu. Za uticaj na ceo RN koristite tehnološki postupak i druge mašine u lancu.'],
  });

  const summaryLine = pickSummaryLine({
    blocked: status === 'blocked',
    ready,
    prevSt,
    urgent,
    rokClass,
    cooperation: !!row.is_cooperation_effective,
    camBlocking: !row.is_non_machining && !row.cam_ready,
  });

  return { summaryLine, tags, blocks };
}

/** Render mini-markdown **bold** → <strong> (paritet 1.0 lineToHtml). */
function BoldLine({ text }: { text: string }) {
  const parts = String(text).split(/\*\*(.+?)\*\*/g);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}

const TAG_TONE: Record<string, Tone> = {
  blocked: 'danger',
  pred: 'warn',
  hitno: 'danger',
  rok: 'warn',
  coop: 'info',
  cam: 'neutral',
};

export function WhyBottleneckModal({ op, onClose }: { op: OpRow; onClose: () => void }) {
  const data = buildWhyExplanation(op);
  const subtitle = [op.rn_ident_broj, op.operacija != null ? `op. ${op.operacija}` : ''].filter(Boolean).join(' · ');

  return (
    <Dialog open onClose={onClose} title="Zašto je ovo ovde?">
      <div className="space-y-3">
        <div>
          <p className="text-sm text-ink-secondary">{subtitle || 'Operacija'}</p>
          {data.tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {data.tags.map((t) => (
                <StatusBadge key={t.key} tone={TAG_TONE[t.key] ?? 'neutral'} label={t.label} />
              ))}
            </div>
          )}
        </div>
        <div className="rounded-control bg-surface-2 px-3 py-2 text-sm font-medium text-ink">{data.summaryLine}</div>
        <div className="space-y-3">
          {data.blocks.map((bl) => (
            <section key={bl.title}>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-secondary">{bl.title}</h3>
              <ul className="space-y-1 text-sm text-ink">
                {bl.lines.map((ln, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className="text-ink-disabled">·</span>
                    <span><BoldLine text={ln} /></span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
