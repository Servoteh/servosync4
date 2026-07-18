'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { downloadBlob } from '@/lib/hr-pdf';
import { buildPayrollGroupPdfs, splitName, type GroupJoined, type PayrollGroupPdf } from '@/lib/hr-pdf/payroll-groups';
import {
  fetchNotifications,
  newClientEventId,
  useNotifCancel,
  useNotifDispatch,
  useNotifRetarget,
  useUploadDocument,
  type EmployeeDocument,
  type TxResponse,
} from '@/api/kadrovska';
import { MONTHS_SR_LAT, s, type ViewRow } from './calc';

const ACCOUNTANT_EMAIL = 'holpen@gmail.com';

export function AccountantModal({
  open,
  onClose,
  employees,
  current,
}: {
  open: boolean;
  onClose: () => void;
  /** v_employees_safe redovi (snake_case). */
  employees: ViewRow[];
  /** v_employee_current_salary redovi (snake_case). */
  current: ViewRow[];
  nameOf?: (id: string) => string;
}) {
  const { can, user } = useAuth();
  const canPii = can(PERMISSIONS.KADROVSKA_PII);
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState<'' | 'download' | 'send'>('');

  const uploadDoc = useUploadDocument();
  const retarget = useNotifRetarget();
  const cancelNotif = useNotifCancel();
  const dispatch = useNotifDispatch();

  const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];
  const selectCls = 'h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink';

  async function buildPdfs(): Promise<PayrollGroupPdf[]> {
    const bySal = new Map(current.map((c) => [s(c, 'employee_id'), c]));
    const joined: GroupJoined[] = employees
      .filter((e) => e.is_active !== false && bySal.has(s(e, 'id')))
      .map((e) => {
        // full_name na sy15 je „Prezime Ime" — koristi first_name/last_name kolone
        // koje v_employees_safe VEĆ ima; splitName je samo fallback.
        const firstName = s(e, 'first_name');
        const lastName = s(e, 'last_name');
        const fb = firstName || lastName ? null : splitName(s(e, 'full_name'));
        return {
          firstName: firstName || fb?.firstName || '',
          lastName: lastName || fb?.lastName || '',
          sal: bySal.get(s(e, 'id'))!,
        };
      });
    return buildPayrollGroupPdfs({ month, year, joined });
  }

  async function onDownload() {
    setBusy('download');
    try {
      setStatus('⏳ Generisanje PDF tabela…');
      const pdfs = await buildPdfs();
      if (!pdfs.length) {
        setStatus('⚠ Nema podataka — nijedna tabela nema redove.');
        return;
      }
      for (let i = 0; i < pdfs.length; i++) {
        setStatus(`⬇ Preuzimanje ${i + 1}/${pdfs.length}: ${pdfs[i].title}…`);
        downloadBlob(pdfs[i].blob, pdfs[i].filename);
        // Kratka pauza — browseri gutaju višestruke download-e u istom tick-u.
        await new Promise((r) => setTimeout(r, 400));
      }
      setStatus(`✅ Preuzeto ${pdfs.length} PDF-ova: ${pdfs.map((p) => `${p.title} (${p.count})`).join(' · ')}`);
    } catch (e) {
      console.error('[zarade/knjigovodja]', e);
      setStatus('⚠ Greška pri generisanju tabela.');
    } finally {
      setBusy('');
    }
  }

  /** Zaposleni-„sidro" za queue RPC: prvo red sa mejlom trenutnog korisnika —
   *  u (malo verovatnoj) trci sa dispatch cron-om mejl bi otišao adminu, nikad
   *  pogrešnoj trećoj strani (1.0 pickQueueAnchorEmployee). */
  function pickAnchor(): ViewRow | null {
    const meEmail = String(user?.email || '').trim().toLowerCase();
    const active = employees.filter((e) => e.is_active !== false && String(s(e, 'email')).trim());
    return (
      (meEmail ? active.find((e) => s(e, 'email').trim().toLowerCase() === meEmail) : null) ||
      active[0] ||
      null
    );
  }

  /** 1.0 tok: upload+queue (outbox) → nađi queued red po attachment_path →
   *  retarget na knjigovođu → dispatch. Napomena: 2.0 upload usput upiše i
   *  meta-red u dosije sidro-zaposlenog (docType 'other') — prihvaćeno odstupanje. */
  async function onSend() {
    const mesec = MONTHS_SR_LAT[month - 1];
    setBusy('send');
    try {
      setStatus('⏳ Generisanje PDF tabela…');
      const pdfs = await buildPdfs();
      if (!pdfs.length) {
        setStatus('⚠ Nema podataka — nijedna tabela nema redove.');
        return;
      }
      if (!window.confirm(`Poslati ${pdfs.length} tabela za ${mesec} ${year} na ${ACCOUNTANT_EMAIL}?\nSvaka tabela ide kao poseban mejl sa PDF prilogom.`)) return;

      const anchor = pickAnchor();
      if (!anchor) {
        setStatus('⚠ Slanje nije moguće: nijedan aktivan zaposleni nema upisan mejl (queue mehanizam).');
        return;
      }

      let sent = 0;
      const failed: string[] = [];
      for (let i = 0; i < pdfs.length; i++) {
        const p = pdfs[i];
        setStatus(`✉ Slanje ${i + 1}/${pdfs.length}: ${p.title}…`);
        try {
          // 1) PDF u storage + outbox red (kadr_queue_document_email — primalac je privremeno „sidro").
          const file = new File([p.blob], p.filename, { type: 'application/pdf' });
          const up = (await uploadDoc.mutateAsync({
            employeeId: s(anchor, 'id'),
            file,
            docType: 'other',
            description: `Tabela zarada — ${p.title}`,
            queueEmail: true,
            emailLabel: `Tabela zarada — ${p.title}`,
            clientEventId: newClientEventId(),
          })) as TxResponse<EmployeeDocument & { path?: string }>;
          const doc = up.data;
          const path = doc.path || doc.storagePath;
          if (!path) { failed.push(p.title); continue; }

          // 2) Nađi sveže queued outbox red po putanji priloga (payload->>attachment_path).
          const notifs = await fetchNotifications({ status: 'queued' });
          const row = (notifs.data ?? []).find((r) => {
            const payload = r.payload as Record<string, unknown> | null | undefined;
            return payload && String(payload.attachment_path ?? '') === path;
          });
          const rowId = row ? String(row.id ?? '') : '';
          if (!rowId) { failed.push(p.title); continue; }

          // 3) Preusmeri red na knjigovođu + naš subject/telo.
          const subject = `Zarade ${mesec} ${year} — tabele (${i + 1}/${pdfs.length}): ${p.title}`;
          const bodyHtml =
            '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">'
            + '<p>Poštovani,</p>'
            + `<p>u prilogu je tabela <strong>${p.title}</strong> za obračun zarada — `
            + `${mesec} ${year} (${p.count} zaposlenih). `
            + `Mejl ${i + 1} od ${pdfs.length} — svaka tabela stiže kao poseban PDF prilog.</p>`
            + '<p style="font-size:.85em;color:#64748b;">Srdačan pozdrav,<br><em>Servoteh d.o.o.</em></p>'
            + '</div>';
          try {
            await retarget.mutateAsync({ id: rowId, recipient: ACCOUNTANT_EMAIL, subject, body: bodyHtml });
          } catch (e) {
            // Red nije više queued ili PATCH pao — otkaži da ne ode pogrešnom primaocu.
            console.error('[zarade/knjigovodja] retarget', p.key, e);
            try { await cancelNotif.mutateAsync({ id: rowId }); } catch { /* best-effort */ }
            failed.push(p.title);
            continue;
          }
          sent += 1;
        } catch (e) {
          console.error('[zarade/knjigovodja] send', p.key, e);
          failed.push(p.title);
        }
      }

      // 4) Odmah pokreni dispatch (inače čeka cron).
      if (sent) {
        setStatus('⏳ Pokrećem slanje (dispatch)…');
        try { await dispatch.mutateAsync({}); } catch (e) { console.warn('[zarade/knjigovodja] dispatch', e); }
      }

      if (!failed.length) {
        setStatus(`✅ Poslato ${sent}/${pdfs.length} tabela na ${ACCOUNTANT_EMAIL}.`);
      } else {
        setStatus(`⚠ Poslato ${sent}/${pdfs.length}. Nije poslato: ${failed.join(', ')}. Proveri HR notifikacije (outbox) i pokušaj ponovo.`);
      }
    } catch (e) {
      console.error('[zarade/knjigovodja]', e);
      setStatus('⚠ Greška pri generisanju/slanju tabela.');
    } finally {
      setBusy('');
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="📤 Tabele za knjigovođu"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Zatvori</Button>
          <Button variant="secondary" onClick={onDownload} loading={busy === 'download'} disabled={busy === 'send'}>⬇ Preuzmi PDF-ove</Button>
          <Button
            onClick={onSend}
            loading={busy === 'send'}
            disabled={busy === 'download' || !canPii}
            title={canPii ? 'Upload + outbox red + preusmerenje na knjigovođu + dispatch' : 'Slanje zahteva kadrovska.pii (upload dokumenata)'}
          >
            ✉ Pošalji na {ACCOUNTANT_EMAIL}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-secondary">
          Mesečne PDF tabele zarada po grupama (bez olakšica / olakšice / razvoj / stranci / HAP Fluid / prevoz).
          Grupa „Keš" se ne šalje. Slanje ide na <strong>{ACCOUNTANT_EMAIL}</strong> — po jedan mejl po tabeli (PDF prilog).
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1.5 text-base font-medium text-ink">
            Mesec
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className={selectCls}>
              {MONTHS_SR_LAT.map((nm, i) => (
                <option key={nm} value={i + 1}>{nm}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5 text-base font-medium text-ink">
            Godina
            <select value={year} onChange={(e) => setYear(Number(e.target.value))} className={selectCls}>
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="min-h-5 text-sm text-ink-secondary" aria-live="polite">{status}</div>
      </div>
    </Dialog>
  );
}
