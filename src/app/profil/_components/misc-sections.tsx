'use client';

import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { Markdown } from '@/lib/markdown';
import { formatDate } from '@/lib/format';
import {
  useTalks,
  useAcknowledgeTalk,
  useExpectations,
  usePosition,
  useCompanyValues,
  useColleaguesOnLeave,
} from '@/api/moj-profil';
import { useMyIssuedTools, useMyConsumed } from '@/api/reversi';
import { Section } from './section';

// ------------------------------------------------------------------ Razgovori

export function TalksSection() {
  const q = useTalks();
  const rows = q.data?.data ?? [];
  const ackM = useAcknowledgeTalk();
  const pending = rows.filter((t) => t.shared_at && !t.acknowledged_at).length;

  return (
    <Section icon="🗣" title="Razgovori sa nadređenim" badge={pending ? <StatusBadge tone="warn" label={`${pending} čeka`} /> : undefined}>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-disabled">Još nema podeljenih zapisnika razgovora.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((t) => {
            const acked = !!t.acknowledged_at;
            return (
              <li key={t.id} className="flex items-center justify-between rounded-control border border-line-soft bg-surface-2 px-3 py-2">
                <div>
                  <div className="text-sm font-medium text-ink">{t.title || 'Razgovor'}</div>
                  <div className="text-xs text-ink-secondary">{t.talk_date ? formatDate(t.talk_date) : ''}</div>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge tone={acked ? 'success' : 'warn'} label={acked ? '✔ potvrđeno' : '⏳ čeka potvrdu'} />
                  {!acked && t.shared_at && (
                    <Button variant="secondary" onClick={() => ackM.mutate({ id: t.id })} className="h-7 text-xs">
                      ✔ Upoznat/a sam
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ Očekivanja

const EXP_STATUS_LABEL: Record<string, string> = {
  aktivno: 'Aktivno',
  u_toku: 'U toku',
  ispunjeno: 'Ispunjeno',
  otkazano: 'Otkazano',
};

export function ExpectationsSection() {
  const q = useExpectations();
  const rows = q.data?.data ?? [];
  return (
    <Section icon="🎯" title="Moja očekivanja">
      {rows.length === 0 ? (
        <p className="text-sm text-ink-disabled">Nema definisanih očekivanja.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((e) => (
            <li key={e.id} className="rounded-control border border-line-soft bg-surface-2 p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium text-ink">{e.title}</span>
                <StatusBadge tone={e.status === 'ispunjeno' ? 'success' : e.status === 'u_toku' ? 'warn' : 'neutral'} label={EXP_STATUS_LABEL[e.status] || e.status} />
              </div>
              {e.descriptionMd && <Markdown source={e.descriptionMd} className="mt-1 text-sm text-ink-secondary" />}
              <div className="mt-1 text-xs text-ink-disabled">
                {e.dueDate ? `📅 Rok: ${formatDate(e.dueDate)}` : '📅 Bez roka'} · Definisao: {e.createdBy ?? '—'}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ Opis pozicije

export function PositionSection() {
  const q = usePosition();
  const p = q.data?.data;
  return (
    <Section icon="📈" title="Pozicija i razvoj">
      {!p ? (
        <p className="text-sm text-ink-disabled">Vaša pozicija nije povezana sa opisom posla — obratite se HR-u.</p>
      ) : (
        <div className="space-y-3">
          <h3 className="text-base font-semibold text-ink">{p.name}</h3>
          {p.reportsToLine && <p className="text-sm text-ink-secondary">▸ Linijski odgovara: {p.reportsToLine}</p>}
          <MdBlock title="📝 Svrha radnog mesta" md={p.summaryMd} />
          <MdBlock title="🛡 Ključne odgovornosti" md={p.responsibilitiesMd} />
          <MdBlock title="⚖ Ovlašćenja" md={p.authorityMd} />
          <MdBlock title="✅ Obaveze" md={p.dutiesMd} />
          <MdBlock title="📊 KPI / merila uspeha" md={p.kpiMd} />
          <MdBlock title="🎓 Kvalifikacije" md={p.qualificationsMd} />
          <MdBlock title="🤝 Ključna saradnja" md={p.collaborationMd} />
          <MdBlock title="🎯 Očekivanja" md={p.expectationsMd} />
        </div>
      )}
    </Section>
  );
}

function MdBlock({ title, md }: { title: string; md: string | null }) {
  if (!md) return null;
  return (
    <div>
      <h4 className="mb-1 text-sm font-semibold text-ink">{title}</h4>
      <Markdown source={md} className="text-sm text-ink-secondary" />
    </div>
  );
}

// ------------------------------------------------------------------ Vrednosti firme

export function CompanyValuesSection() {
  const q = useCompanyValues();
  const c = q.data?.data;
  return (
    <Section icon="💎" title="Vrednosti firme">
      {!c ? (
        <p className="text-sm text-ink-disabled">Nema unetih vrednosti firme.</p>
      ) : (
        <div className="space-y-3">
          <MdBlock title="🚀 Misija" md={c.missionMd} />
          <MdBlock title="🔭 Vizija" md={c.visionMd} />
          <MdBlock title="💎 Vrednosti" md={c.valuesMd} />
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ Kolege na odsustvu

const ABS_TYPE_LABELS: Record<string, string> = {
  godisnji: 'Godišnji odmor',
  bolovanje: 'Bolovanje',
  sluzbeno: 'Službeni put',
  slava: 'Krsna slava',
  placeno: 'Plaćeno odsustvo',
  neplaceno: 'Neplaćeno odsustvo',
  slobodan: 'Slobodan dan',
  ostalo: 'Ostalo',
};

export function ColleaguesSection() {
  const q = useColleaguesOnLeave();
  const rows = q.data?.data ?? [];
  return (
    <Section icon="👥" title="Kolege na odsustvu">
      {rows.length === 0 ? (
        <p className="text-sm text-ink-disabled">Niko trenutno nije na odsustvu.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((c, i) => (
            <li key={i} className="flex items-center justify-between text-sm">
              <span className="text-ink">
                🟠 {c.full_name}
                {c.department && <span className="text-ink-secondary"> · {c.department}</span>}
              </span>
              <span className="text-ink-secondary">
                {ABS_TYPE_LABELS[c.type] || c.type} · {formatDate(c.date_from)} → {formatDate(c.date_to)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ Zaduženja (revers) — reuse Reversi API

export function ReversiSection() {
  const issuedQ = useMyIssuedTools();
  const consumedQ = useMyConsumed();
  const issued = issuedQ.data?.data ?? [];
  const consumed = consumedQ.data?.data ?? [];
  if (issued.length === 0 && consumed.length === 0) return null;

  return (
    <Section icon="🔧" title="Zaduženja (revers)">
      {issued.length > 0 && (
        <>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-secondary">Trenutna zaduženja</h3>
          <table className="mb-3 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-2xs uppercase text-ink-secondary">
                <th className="py-1.5">Predmet</th>
                <th className="py-1.5">Br. dokumenta</th>
                <th className="py-1.5">Izdato</th>
                <th className="py-1.5">Rok povr.</th>
                <th className="py-1.5">Kol.</th>
              </tr>
            </thead>
            <tbody>
              {issued.map((r, i) => (
                <tr key={i} className="border-b border-line-soft">
                  <td className="py-1.5 text-ink">{[r.oznaka, r.naziv].filter(Boolean).join(' — ')}</td>
                  <td className="py-1.5 tnums text-ink-secondary">{r.doc_number}</td>
                  <td className="py-1.5 tnums">{formatDate(r.issued_at)}</td>
                  <td className="py-1.5 tnums">{r.expected_return_date ? formatDate(r.expected_return_date) : '—'}</td>
                  <td className="py-1.5 tnums">{r.quantity} {r.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {consumed.length > 0 && (
        <>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-secondary">Potrošeno</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-2xs uppercase text-ink-secondary">
                <th className="py-1.5">Predmet</th>
                <th className="py-1.5">Kol.</th>
                <th className="py-1.5">Datum</th>
              </tr>
            </thead>
            <tbody>
              {consumed.map((r, i) => (
                <tr key={i} className="border-b border-line-soft">
                  <td className="py-1.5 text-ink">{[r.oznaka, r.naziv].filter(Boolean).join(' — ')}</td>
                  <td className="py-1.5 tnums">{r.quantity}</td>
                  <td className="py-1.5 tnums">{formatDate(r.consumed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Section>
  );
}
