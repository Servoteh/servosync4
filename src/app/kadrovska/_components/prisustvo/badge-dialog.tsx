'use client';

import { useMemo, useState } from 'react';
import { Printer, QrCode } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { generateBadgeSheetPdf, openBlob, downloadBlob, type BadgeItem } from '@/lib/hr-pdf';
import { useDirectory, useEnsureQrBadge } from '@/api/kadrovska';
import { sv } from '../common';

/**
 * QR nalepnice za kapijski kiosk (F2 pilot). Za svakog izabranog zaposlenog
 * BE (POST employees/:id/badges/qr) get-or-create-uje TRAJAN „SVK-…" token u
 * employee_badges — ISTI token skenira kiosk. Ponovna štampa vraća isti token
 * (zalepljene nalepnice ostaju važeće). QR više NE kodira employee.id.
 */
export function BadgeDialog({ onClose }: { onClose: () => void }) {
  const dirQ = useDirectory();
  const ensure = useEnsureQrBadge();
  const all = dirQ.data?.data ?? [];
  const deps = useMemo(
    () => Array.from(new Set(all.map((r) => sv(r, 'department')).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'sr')),
    [all],
  );
  const [dep, setDep] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState('');

  const selected = useMemo(() => {
    const list = dep ? all.filter((r) => sv(r, 'department') === dep) : all;
    return [...list].sort((a, b) => sv(a, 'full_name').localeCompare(sv(b, 'full_name'), 'sr'));
  }, [all, dep]);

  // Za listu zaposlenih obezbedi SVK token (BE get-or-create) pa napravi PDF.
  async function makePdf(list: Record<string, unknown>[]) {
    if (!list.length) {
      setErr('Nema zaposlenih u izboru.');
      return;
    }
    setBusy(true);
    setErr('');
    setProgress({ done: 0, total: list.length });
    try {
      const items: BadgeItem[] = [];
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const res = await ensure.mutateAsync({ id: sv(e, 'id') });
        items.push({ name: sv(e, 'full_name'), dep: sv(e, 'department'), code: res.data.code });
        setProgress({ done: i + 1, total: list.length });
      }
      const { blob, fileName } = await generateBadgeSheetPdf(items);
      openBlob(blob);
      downloadBlob(blob, fileName);
      if (list.length === selected.length) onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Greška pri generisanju QR nalepnica.');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="🏷 QR nalepnice za kiosk (kapija)"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Otkaži
          </Button>
          <Button onClick={() => void makePdf(selected)} loading={busy} disabled={selected.length === 0}>
            <QrCode className="h-4 w-4" aria-hidden /> Generiši QR + PDF ({selected.length})
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block text-sm">
          Odeljenje (pilot grupa)
          <select
            value={dep}
            onChange={(e) => setDep(e.target.value)}
            disabled={busy}
            className="mt-1 h-9 w-full rounded-control border border-line bg-surface px-3 text-sm"
          >
            <option value="">— svi aktivni —</option>
            {deps.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>

        <p className="text-sm text-ink-secondary">
          {selected.length} zaposlenih u izboru
          {progress && ` · generišem ${progress.done}/${progress.total}…`}
        </p>

        {/* Pregled imena — provera pre štampe; pojedinačna štampa po zaposlenom. */}
        <div className="max-h-64 overflow-auto rounded-panel border border-line bg-surface-2">
          {selected.map((e) => (
            <div key={sv(e, 'id')} className="flex items-center justify-between gap-2 border-b border-line-soft px-3 py-1.5 text-sm last:border-b-0">
              <span>{sv(e, 'full_name')}</span>
              <button
                onClick={() => void makePdf([e])}
                disabled={busy}
                title="Štampaj samo ovu nalepnicu"
                className="inline-flex items-center gap-1 rounded-control px-2 py-1 text-xs text-ink-secondary hover:bg-surface hover:text-ink disabled:opacity-40"
              >
                <Printer className="h-3.5 w-3.5" aria-hidden /> Štampaj
              </button>
            </div>
          ))}
          {!selected.length && <div className="px-3 py-4 text-center text-sm text-ink-disabled">Nema zaposlenih.</div>}
        </div>

        {err && <p className="text-sm text-status-danger">{err}</p>}
        <p className="text-xs text-ink-secondary">
          QR sadrži trajni „SVK-" token po zaposlenom (employee_badges, get-or-create). Isti token skenira kiosk na kapiji;
          ponovna štampa ne poništava već zalepljene nalepnice.
        </p>
      </div>
    </Dialog>
  );
}
