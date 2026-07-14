'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { formatDate } from '@/lib/format';
import {
  useSaveEntitlement,
  useSetAdvance,
  newClientEventId,
  type VacationEntitlement,
} from '@/api/kadrovska';
import { useOdmoriUi } from './ui';

interface BalInfo {
  daysCarried: number;
  daysEarned: number | null;
  daysCommitted: number;
  daysUsed: number;
}

/**
 * ⚙ Zarađeni odmor (akrual podešavanje) — 1.0 openAccrualSettings.
 * Uključi srazmerno sticanje + avans kapiju, početak sticanja, godišnja baza,
 * iskorišćeno pre cutover-a (opening_used). Čuva vacation_entitlements (zadržava
 * pravo/preneto). Gate = vacation_edit (BE presuđuje).
 */
export function AccrualModal({
  employeeId,
  employeeName,
  year,
  ent,
  bal,
  onClose,
}: {
  employeeId: string;
  employeeName: string;
  year: number;
  ent: VacationEntitlement | null;
  bal: BalInfo;
  onClose: () => void;
}) {
  const { showToast } = useOdmoriUi();
  const save = useSaveEntitlement();

  const [model, setModel] = useState(ent?.accrualModel ?? false);
  const [start, setStart] = useState(ent?.accrualStart ? ent.accrualStart.slice(0, 10) : '');
  const [base, setBase] = useState(String(ent?.daysTotal ?? 20));
  const [opening, setOpening] = useState(String(ent?.openingUsed ?? 0));
  const [error, setError] = useState<string | null>(null);
  const daysCarried = ent?.daysCarriedOver ?? bal.daysCarried ?? 0;

  async function submit() {
    setError(null);
    if (model && !start) {
      setError('Za zarađeni odmor unesite početak sticanja (datum zaposlenja).');
      return;
    }
    const baseVal = Number.parseInt(base, 10);
    const baseNum = Number.isFinite(baseVal) ? baseVal : 20;
    try {
      await save.mutateAsync({
        clientEventId: newClientEventId(),
        employeeId,
        year,
        daysTotal: baseNum,
        daysCarriedOver: daysCarried,
        accrualModel: model,
        accrualBase: baseNum,
        openingUsed: Number.parseInt(opening, 10) || 0,
        ...(start ? { accrualStart: start } : {}),
        note: ent?.note ?? '',
      });
      showToast('✅ Zarađeni odmor sačuvan');
      onClose();
    } catch {
      setError('Čuvanje nije uspelo — proverite pravo (vacation_edit).');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Zarađeni odmor — ${employeeName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button onClick={submit} loading={save.isPending}>Sačuvaj</Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-ink-secondary">
          Godina {year}. „Zarađeno do danas" + avans (CEO/CFO) važe kad je model uključen.
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={model} onChange={(e) => setModel(e.target.checked)} />
          Zarađeni odmor — srazmerno sticanje (+ kapija za avans)
        </label>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Početak sticanja (datum zaposlenja)">
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </FormField>
          <FormField label="Godišnja baza (norma, npr. 20)">
            <Input type="number" min={0} max={365} value={base} onChange={(e) => setBase(e.target.value)} />
          </FormField>
          <FormField label="Iskorišćeno pre cutover-a">
            <Input type="number" min={0} max={365} value={opening} onChange={(e) => setOpening(e.target.value)} />
          </FormField>
        </div>
        <p className="text-xs text-ink-secondary">
          Preneto ({daysCarried}) se menja u koloni „Preneto". „Godišnja baza" je norma od koje se
          računa „zarađeno do danas" — ne prikazuje se nigde kao puno pravo unapred.
        </p>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

/**
 * 🛫 Avans (CEO/CFO odobrenje) — 1.0 openAdvanceApproval. Postavi/povuci odobrenje
 * + napomena; pečat (ko/kad) iz JWT-a u RPC-u. Server traži admin.
 */
export function AdvanceModal({
  employeeId,
  employeeName,
  year,
  ent,
  bal,
  onClose,
}: {
  employeeId: string;
  employeeName: string;
  year: number;
  ent: VacationEntitlement | null;
  bal: BalInfo;
  onClose: () => void;
}) {
  const { showToast } = useOdmoriUi();
  const setAdv = useSetAdvance();

  const [approved, setApproved] = useState(ent?.advanceApproved ?? false);
  const [note, setNote] = useState(ent?.advanceNote ?? '');
  const [error, setError] = useState<string | null>(null);

  const byLine = ent?.advanceApproved && ent.advanceApprovedBy
    ? `Trenutno odobrio: ${ent.advanceApprovedBy}${ent.advanceApprovedAt ? ' · ' + formatDate(ent.advanceApprovedAt) : ''}`
    : 'Avans još nije odobren.';
  const earnedLine = bal.daysEarned != null
    ? `Zarađeno do danas: ${bal.daysEarned} · angažovano (isk.+plan.): ${bal.daysCommitted || bal.daysUsed}`
    : 'Zarađeni odmor (srazmerno) nije uključen — avans se vodi samo evidenciono.';

  async function submit() {
    setError(null);
    try {
      const res = await setAdv.mutateAsync({
        employeeId,
        year,
        approved,
        note: note.trim(),
        clientEventId: newClientEventId(),
      });
      const status = ((res as { data?: { status?: string } }).data)?.status;
      if (status && status !== 'ok') {
        setError('Čuvanje nije uspelo — avans evidenciju upisuje samo uprava (CEO/CFO).');
        return;
      }
      showToast(approved ? '✅ Avans evidentiran kao odobren' : '✅ Odobrenje avansa povučeno');
      onClose();
    } catch {
      setError('Čuvanje nije uspelo — avans evidenciju upisuje samo uprava (CEO/CFO).');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Avans godišnjeg — ${employeeName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button onClick={submit} loading={setAdv.isPending}>Sačuvaj</Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-ink-secondary">Godina {year}. Odobrava uprava (CEO/CFO). {earnedLine}</p>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />
          Avans ODOBREN (CEO/CFO)
        </label>
        <FormField label="Napomena (razlog / uslovi)">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
        <p className="text-xs text-ink-secondary">{byLine}</p>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
