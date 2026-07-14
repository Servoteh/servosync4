'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui-kit/button';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  useAssessmentCampaigns,
  useAssessmentScope,
  useAssessmentRaters,
  useAssessmentResults,
  useAssessmentTargets,
  useAssessmentRaterScores,
  useAssessmentFramework,
  useCloseAssessment,
  useReopenAssessment,
  useShareAssessment,
  useUnshareAssessment,
  useOpenCampaign,
  openAssessment360,
  saveAssessmentScores,
  setAssessmentTargets,
  computeAssessment,
  assessmentGapToGoals,
  assessmentInvite,
  assessmentInviteCycle,
  newClientEventId,
  type CampaignAssessment,
  type AssessmentRater,
  type InviteResult,
} from '@/api/kadrovska';
import { sv, svNum } from '../common';
import { A360_STATUS_LABEL, WideModal, DevBlock, useNameMap } from './shared';
import { Radar, RADAR_COLORS, type RadarSeries } from './radar';
import { exportAssessmentPdf } from '@/lib/hr-pdf';

const A_TONE: Record<string, Tone> = { draft: 'neutral', collecting: 'info', closed: 'warn', shared: 'success' };
const KEY = ['kadrovska', 'assessments'];

function inviteToast(res: InviteResult | undefined) {
  if (!res) return toast('⚠ Slanje nije uspelo');
  if (res.ok) {
    const noEmail = Array.isArray(res.skipped) ? res.skipped.length : 0;
    toast(`✉ Pozivnice poslate: ${res.sent ?? 0}${noEmail ? ` · bez emaila: ${noEmail}` : ''}`);
  } else {
    toast(`⚠ ${res.reason === 'resend_not_configured' ? 'Email servis nije konfigurisan' : res.reason || res.error || 'Slanje nije uspelo'}`);
  }
}

export function AssessmentsSection() {
  const { nm } = useNameMap();
  const campQ = useAssessmentCampaigns({}, true);
  const rows = campQ.data?.data ?? [];
  const [campaignOpen, setCampaignOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [invitingId, setInvitingId] = useState<string | null>(null);

  const open = rows.filter((a) => a.status === 'collecting' || a.status === 'draft').length;
  const detail = openId ? rows.find((a) => a.id === openId) ?? null : null;

  async function invite(a: CampaignAssessment) {
    setInvitingId(a.id);
    try {
      const res = await assessmentInvite(a.id);
      inviteToast(res.data);
      campQ.refetch();
    } catch {
      toast('⚠ Slanje nije uspelo');
    } finally {
      setInvitingId(null);
    }
  }

  const cols: Column<CampaignAssessment>[] = [
    { key: 'emp', header: 'Zaposleni', render: (a) => <span className="font-medium">{nm(a.employeeId)}</span> },
    { key: 'camp', header: 'Kampanja', render: (a) => a.cycle?.title || a.cycle?.periodLabel || '—' },
    { key: 'period', header: 'Period', render: (a) => a.periodLabel || '—' },
    {
      key: 'status',
      header: 'Status',
      render: (a) => (
        <span className="flex items-center gap-1.5">
          <StatusBadge tone={A_TONE[a.status] ?? 'neutral'} label={A360_STATUS_LABEL[a.status] || a.status} />
          {a.visibleToEmployee && <span title="Podeljeno sa zaposlenim">👁</span>}
        </span>
      ),
    },
    { key: 'self', header: 'Samoprocena', align: 'right', render: (a) => raterCell(a.raters.find((r) => r.raterKind === 'self')) },
    {
      key: 'peers',
      header: 'Kolege',
      align: 'right',
      render: (a) => {
        const peers = a.raters.filter((r) => r.raterKind === 'peer');
        return peers.length ? `${peers.filter((p) => p.status === 'submitted').length}/${peers.length}` : '—';
      },
    },
    { key: 'leader', header: 'Rukovodilac', align: 'right', render: (a) => raterCell(a.raters.find((r) => r.raterKind === 'leader')) },
    {
      key: 'act',
      header: '',
      render: (a) => {
        const canInvite = a.status === 'collecting' || a.status === 'draft';
        return (
          <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
            <Button variant="secondary" className="h-7 px-2 text-xs" onClick={() => setOpenId(a.id)}>Otvori</Button>
            {canInvite && <Button variant="ghost" className="h-7 px-2 text-xs" loading={invitingId === a.id} onClick={() => invite(a)} title="Pošalji email pozivnice ocenjivačima koji čekaju">✉ Pozivnice</Button>}
          </div>
        );
      },
    },
  ];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-ink">📊 360° procene (kampanje)</h3>
        {rows.length > 0 && <span className="text-sm text-ink-secondary">u toku: {open} · ukupno: {rows.length}</span>}
        <div className="flex-1" />
        <Button variant="secondary" onClick={() => setCampaignOpen(true)} title="Otvori 360° procene za više zaposlenih odjednom">📊 360° kampanja</Button>
      </div>
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(a) => a.id}
        onRowActivate={(a) => setOpenId(a.id)}
        loading={campQ.isLoading}
        empty={<EmptyState title="Nema 360° procena" hint={'Kampanju otvarate dugmetom „📊 360° kampanja", a pojedinačnu iz detalja plana razvoja.'} />}
      />
      {campaignOpen && <CampaignModal onClose={() => setCampaignOpen(false)} />}
      {detail && <Assessment360Modal employeeId={detail.employeeId} employeeName={nm(detail.employeeId)} period={detail.periodLabel ?? undefined} status={detail.status} onClose={() => setOpenId(null)} />}
    </section>
  );
}

function raterCell(r: AssessmentRater | undefined) {
  if (!r) return '—';
  const mark = r.invitedAt ? ` ✉` : '';
  return `${r.status === 'submitted' ? '✅' : '⏳'}${mark}`;
}

/* ── Campaign modal ── */
function CampaignModal({ onClose }: { onClose: () => void }) {
  const { list } = useNameMap();
  const open = useOpenCampaign();
  const [title, setTitle] = useState(`360° ${new Date().getFullYear()}`);
  const [period, setPeriod] = useState(String(new Date().getFullYear()));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sendInvites, setSendInvites] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const active = list.filter((e) => e.active);
  const noEmail = active.filter((e) => selected.has(e.id) && !e.email);
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function submit() {
    setErr('');
    if (!title.trim() || !period.trim()) return setErr('Naziv i period su obavezni.');
    if (selected.size === 0) return setErr('Izaberite bar jednog zaposlenog.');
    setBusy(true);
    try {
      const res = await open.mutateAsync({ title: title.trim(), period: period.trim(), employeeIds: [...selected], clientEventId: newClientEventId() });
      const d = res.data;
      const cycleId = typeof d === 'string' ? d : sv((d ?? null) as Record<string, unknown> | null, 'cycle_id') || sv((d ?? null) as Record<string, unknown> | null, 'cycleId') || sv((d ?? null) as Record<string, unknown> | null, 'id');
      if (sendInvites && cycleId) {
        const inv = await assessmentInviteCycle(cycleId, true);
        inviteToast(inv.data);
      } else {
        toast(`✅ Kampanja otvorena — ${selected.size} procena`);
      }
      onClose();
    } catch {
      setErr('Otvaranje kampanje nije uspelo (dozvola?).');
    } finally {
      setBusy(false);
    }
  }

  return (
    <WideModal
      open
      onClose={onClose}
      maxWidth="720px"
      title="📊 Nova 360° kampanja"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={busy} onClick={submit}>Otvori kampanju</Button>
        </>
      }
    >
      {err && <p className="mb-3 rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Naziv ciklusa" required><Input value={title} onChange={(e) => setTitle(e.target.value)} /></FormField>
        <FormField label="Period" required><Input value={period} placeholder="npr. 2026" onChange={(e) => setPeriod(e.target.value)} /></FormField>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-sm font-medium text-ink">Zaposleni ({selected.size})</span>
        <div className="flex gap-2">
          <button className="text-xs text-accent hover:underline" onClick={() => setSelected(new Set(active.map((e) => e.id)))}>Označi sve</button>
          <button className="text-xs text-ink-secondary hover:underline" onClick={() => setSelected(new Set())}>Poništi</button>
        </div>
      </div>
      <div className="mt-1.5 max-h-60 overflow-auto rounded-panel border border-line">
        {active.map((e) => (
          <label key={e.id} className="flex cursor-pointer items-center gap-2 border-b border-line-soft px-3 py-1.5 text-sm last:border-0 hover:bg-surface-2">
            <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
            <span className="text-ink">{e.name}</span>
            {!e.email && <span className="ml-auto text-2xs text-status-warn" title="Nema email — pozivnica se ne šalje">⚠ bez emaila</span>}
          </label>
        ))}
      </div>
      {noEmail.length > 0 && <p className="mt-1.5 text-2xs text-status-warn">⚠ {noEmail.length} izabranih nema email (neće dobiti pozivnicu).</p>}
      <label className="mt-3 flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={sendInvites} onChange={(e) => setSendInvites(e.target.checked)} />
        Pošalji pozivnice odmah (samoprocena + rukovodilac)
      </label>
    </WideModal>
  );
}

/* ── 360 detail modal (radar + scoring + participants + actions) ── */
export function Assessment360Modal({ employeeId, employeeName, period, status, onClose }: { employeeId: string; employeeName: string; period?: string; status?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { list } = useNameMap();
  const cevRef = useRef(newClientEventId());
  const [aid, setAid] = useState<string | null>(null);
  const [initErr, setInitErr] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [statusState, setStatusState] = useState(status ?? 'collecting');
  const seededRef = useRef(-1);

  useEffect(() => {
    let cancelled = false;
    openAssessment360({ employeeId, period: period ?? null, clientEventId: cevRef.current })
      .then((res) => { if (!cancelled) { if (res.data) setAid(res.data); else setInitErr('Nemate pravo ili profil/pozicija nisu povezani.'); } })
      .catch(() => { if (!cancelled) setInitErr('Greška pri učitavanju procene.'); });
    return () => { cancelled = true; };
  }, [employeeId, period]);

  const scopeQ = useAssessmentScope(aid);
  const ratersQ = useAssessmentRaters(aid);
  const resultsQ = useAssessmentResults(aid);
  const targetsQ = useAssessmentTargets(aid);
  const fwQ = useAssessmentFramework(!!aid);
  const raters = ratersQ.data?.data ?? [];
  const leaderRater = raters.find((r) => r.raterKind === 'leader') ?? null;
  const scoresQ = useAssessmentRaterScores(leaderRater?.id ?? null, !!leaderRater);

  const [leaderMap, setLeaderMap] = useState<Map<number, number>>(new Map());
  const [targetMap, setTargetMap] = useState<Map<number, number>>(new Map());

  // Seed lokalnih mapa iz servera (jednom po aid/reloadKey; edit ne trigeruje refetch).
  useEffect(() => {
    if (!aid || seededRef.current === reloadKey) return;
    if (targetsQ.data && (!leaderRater || scoresQ.data)) {
      const lm = new Map<number, number>();
      for (const s of scoresQ.data?.data ?? []) if (s.level != null) lm.set(s.competenceId, s.level);
      const tm = new Map<number, number>();
      for (const t of targetsQ.data.data) if (t.targetLevel != null) tm.set(t.competenceId, t.targetLevel);
      setLeaderMap(lm);
      setTargetMap(tm);
      seededRef.current = reloadKey;
    }
  }, [aid, reloadKey, targetsQ.data, scoresQ.data, leaderRater]);

  const scope = scopeQ.data?.data ?? [];
  const results = resultsQ.data?.data ?? [];
  const framework = fwQ.data?.data ?? [];

  // levelsByComp iz frameworka (tooltip deskriptor).
  const levelsByComp = useMemo(() => {
    const m = new Map<number, { level: number; descriptor: string }[]>();
    for (const row of framework) {
      const cid = Number(row['competence_id'] ?? row['comp_id']);
      if (!cid) continue;
      const arr = m.get(cid) ?? [];
      arr.push({ level: svNum(row, 'level'), descriptor: sv(row, 'descriptor') });
      m.set(cid, arr);
    }
    return m;
  }, [framework]);

  // Grupisanje scope-a.
  const groups = useMemo(() => {
    const map = new Map<number, { id: number; name: string; scope: string; sort: number; comps: { id: number; name: string }[] }>();
    const order: number[] = [];
    for (const r of scope) {
      const gid = Number(r['group_id']);
      if (!map.has(gid)) { map.set(gid, { id: gid, name: sv(r, 'group_name'), scope: sv(r, 'scope'), sort: svNum(r, 'group_sort'), comps: [] }); order.push(gid); }
      map.get(gid)!.comps.push({ id: Number(r['competence_id']), name: sv(r, 'competence_name') });
    }
    return order.map((id) => map.get(id)!).sort((a, b) => a.sort - b.sort);
  }, [scope]);

  const resByComp = useMemo(() => {
    const m = new Map<number, { self: number | null; peer: number | null }>();
    for (const r of results) if (r.scopeKind === 'competence') m.set(r.refId, { self: r.selfAvg == null ? null : Number(r.selfAvg), peer: r.peerAvg == null ? null : Number(r.peerAvg) });
    return m;
  }, [results]);
  const resByGroup = useMemo(() => {
    const m = new Map<number, { self: number | null; peer: number | null }>();
    for (const r of results) if (r.scopeKind === 'group') m.set(r.refId, { self: r.selfAvg == null ? null : Number(r.selfAvg), peer: r.peerAvg == null ? null : Number(r.peerAvg) });
    return m;
  }, [results]);

  // Radar serije (uživo: leader/target iz mapa, self/peer iz group rezultata).
  const radarData: { labels: string[]; datasets: RadarSeries[] } = useMemo(() => {
    const labels = groups.map((g) => g.name);
    const avg = (ids: number[], map: Map<number, number>) => {
      const v = ids.map((id) => map.get(id)).filter((x): x is number => x != null);
      return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
    };
    return {
      labels,
      datasets: [
        { label: 'Samoprocena', color: RADAR_COLORS.self, data: groups.map((g) => resByGroup.get(g.id)?.self ?? null) },
        { label: 'Kolege', color: RADAR_COLORS.peer, data: groups.map((g) => resByGroup.get(g.id)?.peer ?? null) },
        { label: 'Rukovodilac', color: RADAR_COLORS.leader, data: groups.map((g) => avg(g.comps.map((c) => c.id), leaderMap)) },
        { label: 'Cilj', color: RADAR_COLORS.target, data: groups.map((g) => avg(g.comps.map((c) => c.id), targetMap)) },
      ],
    };
  }, [groups, resByGroup, leaderMap, targetMap]);

  const peers = raters.filter((r) => r.raterKind === 'peer');
  const self = raters.find((r) => r.raterKind === 'self');
  const canEdit = statusState === 'collecting' || statusState === 'draft';
  const [busy, setBusy] = useState(false);

  const closeA = useCloseAssessment();
  const reopenA = useReopenAssessment();
  const shareA = useShareAssessment();
  const unshareA = useUnshareAssessment();

  function toggleDot(kind: 'leader' | 'target', comp: number, v: number) {
    const setter = kind === 'leader' ? setLeaderMap : setTargetMap;
    setter((prev) => { const n = new Map(prev); if (n.get(comp) === v) n.delete(comp); else n.set(comp, v); return n; });
  }

  async function reloadAll() {
    await qc.invalidateQueries({ queryKey: KEY });
    setReloadKey((k) => k + 1);
  }

  async function save() {
    if (!aid) return;
    setBusy(true);
    try {
      if (leaderRater) {
        const items = [...leaderMap.entries()].map(([competenceId, level]) => ({ competenceId, level }));
        if (items.length) await saveAssessmentScores(leaderRater.id, items);
      }
      const tg = [...targetMap.entries()].map(([competence_id, target_level]) => ({ competence_id, target_level }));
      await setAssessmentTargets(aid, tg);
      await computeAssessment(aid);
      toast('💾 Sačuvano');
      await reloadAll();
    } catch {
      toast('⚠ Greška pri snimanju');
    } finally {
      setBusy(false);
    }
  }

  async function doState(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try { await fn(); toast('✅ ' + msg); await reloadAll(); } catch { toast('⚠ Akcija nije uspela'); } finally { setBusy(false); }
  }

  async function doGap() {
    if (!aid || !confirm('Napraviti razvojne ciljeve za kompetencije gde je cilj iznad ocene rukovodioca?')) return;
    setBusy(true);
    try { const res = await assessmentGapToGoals(aid, 'leader', 1); const n = Number(res.data) || 0; toast(n > 0 ? `🎯 Kreirano ${n} razvojnih ciljeva` : 'Nema jaza za nove ciljeve (ili već postoje).'); } catch { toast('⚠ Nije uspelo'); } finally { setBusy(false); }
  }

  async function doInvite() {
    if (!aid) return;
    setBusy(true);
    try { const res = await assessmentInvite(aid); inviteToast(res.data); await reloadAll(); } catch { toast('⚠ Slanje nije uspelo'); } finally { setBusy(false); }
  }

  async function doPdf() {
    if (!aid) return;
    setBusy(true);
    try {
      await computeAssessment(aid);
      const freshRes = await resultsQ.refetch();
      const r = freshRes.data?.data ?? results;
      const gRes = new Map<number, Record<string, unknown>>();
      const cRes = new Map<number, Record<string, unknown>>();
      for (const x of r) { if (x.scopeKind === 'group') gRes.set(x.refId, x as unknown as Record<string, unknown>); else cRes.set(x.refId, x as unknown as Record<string, unknown>); }
      const num = (v: unknown) => (v == null ? null : Number(v));
      const groupsPdf = groups.map((g) => { const x = gRes.get(g.id) ?? {}; return { groupName: g.name, scope: g.scope, self: num(x['selfAvg']), peer: num(x['peerAvg']), leader: num(x['leaderVal']), target: num(x['targetVal']) }; });
      const compsPdf: { groupName: string; competenceName: string; self: number | null; peer: number | null; leader: number | null; target: number | null }[] = [];
      for (const g of groups) for (const c of g.comps) { const x = cRes.get(c.id) ?? {}; compsPdf.push({ groupName: g.name, competenceName: c.name, self: num(x['selfAvg']), peer: num(x['peerAvg']), leader: num(x['leaderVal']), target: num(x['targetVal']) }); }
      const emp = list.find((e) => e.id === employeeId);
      await exportAssessmentPdf({ employeeName, positionName: emp?.position || '', period: period || '', groups: groupsPdf, competences: compsPdf });
    } catch (e) {
      toast('⚠ PDF nije uspeo: ' + (e instanceof Error ? e.message : ''));
    } finally { setBusy(false); }
  }

  const [peerSel, setPeerSel] = useState('');
  const [peerEmail, setPeerEmail] = useState('');
  async function addPeer() {
    if (!aid) return;
    const ids = peerSel ? [peerSel] : [];
    const emails = peerEmail.trim() ? [peerEmail.trim()] : [];
    if (!ids.length && !emails.length) return toast('Izaberi kolegu ili unesi e-mail.');
    setBusy(true);
    try {
      await openAssessment360({ employeeId, period: period ?? null, peerEmployeeIds: ids, peerEmails: emails, clientEventId: newClientEventId() });
      toast('✅ Dodat ocenjivač');
      setPeerSel(''); setPeerEmail('');
      await reloadAll();
    } catch { toast('⚠ Nije uspelo'); } finally { setBusy(false); }
  }

  const loading = !aid && !initErr;

  return (
    <WideModal
      open
      onClose={onClose}
      maxWidth="1040px"
      title={`📊 360° procena — ${employeeName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Zatvori</Button>
          {canEdit && <Button loading={busy} onClick={save}>💾 Sačuvaj ocenu + ciljeve</Button>}
        </>
      }
    >
      {initErr ? (
        <p className="py-8 text-center text-status-danger">{initErr}</p>
      ) : loading ? (
        <p className="py-8 text-center text-ink-secondary">Otvaram procenu…</p>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-secondary">
            <span>Period: <b className="text-ink">{period || '—'}</b></span>
            <span>Samoprocena: {self ? (self.status === 'submitted' ? '✅' : '⏳') : '—'}</span>
            <span>Kolege: <b className="text-ink">{peers.filter((p) => p.status === 'submitted').length}/{peers.length}</b></span>
            <span>Rukovodilac: {leaderRater?.status === 'submitted' ? '✅' : '⏳'}</span>
          </div>

          <div className="mx-auto max-w-[460px]">
            <Radar labels={radarData.labels} datasets={radarData.datasets} />
          </div>

          <DevBlock title="⭐ Ocena rukovodioca i ciljni nivoi">
            <p className="mb-2 text-2xs text-ink-secondary">Kolone: <b>Self</b>=samoprocena · <b>Peer</b>=kolege (prosek) · <b>Ti</b>=tvoja ocena · <b>Cilj</b>=ciljni nivo</p>
            {groups.map((g) => (
              <div key={g.id} className="mb-3">
                <div className="mb-1 text-sm font-semibold text-ink">{g.name} <span className="text-2xs font-normal uppercase text-ink-secondary">· {g.scope}</span></div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-2xs uppercase text-ink-secondary">
                        <th className="py-1 text-left">Kompetencija</th>
                        <th className="py-1">Self</th>
                        <th className="py-1">Peer</th>
                        <th className="py-1">Ti</th>
                        <th className="py-1">Cilj</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.comps.map((c) => {
                        const rr = resByComp.get(c.id);
                        const lvls = levelsByComp.get(c.id) ?? [];
                        const desc = (n: number) => { const l = lvls.find((x) => x.level === n); return l ? `Nivo ${n}: ${l.descriptor}` : `Nivo ${n}`; };
                        return (
                          <tr key={c.id} className="border-t border-line-soft">
                            <td className="py-1.5 pr-2 font-medium text-ink">{c.name}</td>
                            <td className="text-center text-ink-secondary">{rr?.self != null ? rr.self.toFixed(1) : '—'}</td>
                            <td className="text-center text-ink-secondary">{rr?.peer != null ? rr.peer.toFixed(1) : '—'}</td>
                            <td className="text-center"><DotRow value={leaderMap.get(c.id)} onPick={(v) => toggleDot('leader', c.id, v)} desc={desc} disabled={!canEdit} /></td>
                            <td className="text-center"><DotRow value={targetMap.get(c.id)} onPick={(v) => toggleDot('target', c.id, v)} desc={desc} disabled={!canEdit} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </DevBlock>

          <DevBlock title="👥 Učesnici (kolege ocenjivači) i pozivnice">
            <ul className="mb-2 space-y-0.5 text-sm">
              {peers.length === 0 ? (
                <li className="text-ink-secondary">Još nema kolega ocenjivača.</li>
              ) : (
                peers.map((p) => (
                  <li key={p.id}>{p.raterEmployeeId ? '👤' : '✉'} {p.raterEmail || (p.raterEmployeeId ? list.find((e) => e.id === p.raterEmployeeId)?.name : null) || '—'} {p.status === 'submitted' ? '✅' : '⏳'}</li>
                ))
              )}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <select value={peerSel} onChange={(e) => setPeerSel(e.target.value)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
                <option value="">— kolega iz tima —</option>
                {list.filter((e) => e.active && e.id !== employeeId).map((e) => (<option key={e.id} value={e.id}>{e.name}</option>))}
              </select>
              <Input className="w-56" type="email" value={peerEmail} placeholder="ili e-mail (bez naloga)" onChange={(e) => setPeerEmail(e.target.value)} />
              <Button variant="secondary" className="h-9" onClick={addPeer}>+ Dodaj</Button>
              <Button variant="secondary" className="h-9" loading={busy} onClick={doInvite}>✉ Pošalji pozivnice</Button>
            </div>
          </DevBlock>

          <DevBlock title="⚙ Akcije">
            <div className="flex flex-wrap gap-2">
              {canEdit ? (
                <Button variant="secondary" onClick={async () => { await doState(() => closeA.mutateAsync({ id: aid!, clientEventId: newClientEventId() }), 'Zatvoreno'); setStatusState('closed'); }}>🔒 Zatvori prikupljanje</Button>
              ) : (
                <Button variant="secondary" onClick={async () => { await doState(() => reopenA.mutateAsync({ id: aid!, clientEventId: newClientEventId() }), 'Ponovo otvoreno'); setStatusState('collecting'); }}>↺ Ponovo otvori</Button>
              )}
              <Button variant="secondary" onClick={() => doState(() => shareA.mutateAsync({ id: aid!, clientEventId: newClientEventId() }), 'Podeljeno sa zaposlenim')}>📨 Podeli sa zaposlenim</Button>
              <Button variant="secondary" onClick={() => doState(() => unshareA.mutateAsync({ id: aid!, clientEventId: newClientEventId() }), 'Sakriveno')}>🙈 Sakrij</Button>
              <Button variant="secondary" onClick={doGap}>🎯 Ciljevi iz jaza</Button>
              <Button variant="secondary" loading={busy} onClick={doPdf}>📄 PDF izveštaj</Button>
            </div>
          </DevBlock>
        </>
      )}
    </WideModal>
  );
}

function DotRow({ value, onPick, desc, disabled }: { value: number | undefined; onPick: (v: number) => void; desc: (n: number) => string; disabled?: boolean }) {
  return (
    <span className="inline-flex gap-0.5">
      {[0, 1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={disabled}
          title={desc(n)}
          onClick={() => onPick(n)}
          className={`h-6 w-6 rounded-control border text-2xs font-semibold ${value === n ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface text-ink hover:border-accent'} disabled:opacity-50`}
        >
          {n}
        </button>
      ))}
    </span>
  );
}
