'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Button } from '@/components/ui-kit/button';
import { toast } from '@/lib/toast';
import { useYearOpen, type YearOpenResult } from '@/api/glavna-knjiga';

/**
 * Modal „Početno stanje" (BigBit paritet — prenos salda u novu godinu). U jednom potezu:
 *   • zatvaranje klasa 5 (rashodi) i 6 (prihodi), razlika (rezultat) na konto rezultata,
 *   • PS nalog klasa 0–4 za ciljnu godinu.
 * Radnja je NEPOVRATNA bez storna — traži se potvrda (window.confirm). Po uspehu prikazuje
 * id-eve naloga + broj linija + izabrani konto rezultata. TASTATURA: Esc = otkaži, Ctrl+S = prenesi.
 */
export function YearOpenDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const yearOpen = useYearOpen();
  const nowYear = new Date().getFullYear();
  const [fromYear, setFromYear] = useState<string>(String(nowYear - 1));
  const [toYear, setToYear] = useState<string>(String(nowYear));
  const [postingDate, setPostingDate] = useState<string>('');
  const [resultAccount, setResultAccount] = useState<string>('');
  const [result, setResult] = useState<YearOpenResult | null>(null);

  const err = (yearOpen.error as Error | null)?.message ?? null;
  const from = Number(fromYear);
  const to = Number(toYear);
  const canSubmit =
    Number.isInteger(from) &&
    Number.isInteger(to) &&
    to > from &&
    !yearOpen.isPending;

  const reset = () => {
    setFromYear(String(nowYear - 1));
    setToYear(String(nowYear));
    setPostingDate('');
    setResultAccount('');
    setResult(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const submit = () => {
    if (!canSubmit) return;
    if (
      !window.confirm(
        `Preneti početno stanje iz ${from} u ${to}? Zatvaraju se klase 5 i 6 (rezultat na ` +
          `konto rezultata) i kreira se PS nalog za ${to}. Radnja je NEPOVRATNA bez storna naloga.`,
      )
    )
      return;
    yearOpen.mutate(
      {
        fromYear: from,
        toYear: to,
        postingDate: postingDate.trim() || undefined,
        resultAccount: resultAccount.trim() || undefined,
      },
      {
        onSuccess: (res) => {
          setResult(res);
          toast(`Preneto: ${res.lines} linija (PS nalog #${res.openingEntryId}).`);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Početno stanje (prenos u novu godinu)"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={yearOpen.isPending}>
            {result ? 'Zatvori' : 'Otkaži'}
          </Button>
          {!result && (
            <Button onClick={submit} loading={yearOpen.isPending} disabled={!canSubmit}>
              Prenesi početno stanje
            </Button>
          )}
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!result) submit();
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            if (!result) submit();
          }
        }}
      >
        {err && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </div>
        )}

        <p className="text-sm text-ink-secondary">
          Zatvaraju se klase 5 (rashodi) i 6 (prihodi) — razlika (rezultat) ide na konto rezultata
          (klasa 3, automatski po prefiksu ili ručno zadat). Zatim se kreira nalog početnog stanja
          (PS) za klase 0–4 u ciljnoj godini. Radnja je nepovratna bez storna.
        </p>

        <div className="flex flex-wrap gap-3">
          <div className="w-32">
            <FormField label="Iz godine" required>
              <Input
                type="number"
                inputMode="numeric"
                value={fromYear}
                onChange={(e) => setFromYear(e.target.value)}
                disabled={!!result}
              />
            </FormField>
          </div>
          <div className="w-32">
            <FormField label="U godinu" required>
              <Input
                type="number"
                inputMode="numeric"
                value={toYear}
                onChange={(e) => setToYear(e.target.value)}
                disabled={!!result}
              />
            </FormField>
          </div>
          <div className="w-44">
            <FormField label="Datum PS naloga">
              <Input
                type="date"
                value={postingDate}
                onChange={(e) => setPostingDate(e.target.value)}
                disabled={!!result}
              />
            </FormField>
          </div>
          <div className="w-40">
            <FormField label="Konto rezultata">
              <Input
                placeholder="auto (klasa 3)"
                value={resultAccount}
                onChange={(e) => setResultAccount(e.target.value)}
                disabled={!!result}
              />
            </FormField>
          </div>
        </div>

        {!canSubmit && !result && to <= from && (
          <div className="rounded-panel border border-status-warn/40 bg-status-warn-bg px-3 py-2 text-sm text-ink">
            Ciljna godina mora biti posle izvorne.
          </div>
        )}

        {result && (
          <div className="space-y-2 rounded-panel border border-status-success/40 bg-status-success-bg px-3 py-3 text-sm text-ink">
            <div className="font-medium text-status-success">Prenos je izvršen.</div>
            <ul className="space-y-1 text-ink-secondary">
              <li>
                Zaključni nalog (klase 5/6):{' '}
                <span className="tnums font-medium text-ink">
                  {result.closingEntryId != null ? `#${result.closingEntryId}` : 'nije bilo salda'}
                </span>
                {result.closingLines > 0 && ` · ${result.closingLines} linija`}
              </li>
              <li>
                PS nalog (klase 0–4):{' '}
                <span className="tnums font-medium text-ink">#{result.openingEntryId}</span> ·{' '}
                {result.openingLines} linija
              </li>
              <li>
                Ukupno linija: <span className="tnums font-medium text-ink">{result.lines}</span>
              </li>
              {result.resultAccount && (
                <li>
                  Konto rezultata:{' '}
                  <span className="tnums font-medium text-ink">{result.resultAccount}</span>
                </li>
              )}
              {result.notes && <li className="text-2xs">{result.notes}</li>}
            </ul>
          </div>
        )}
      </form>
    </Dialog>
  );
}
