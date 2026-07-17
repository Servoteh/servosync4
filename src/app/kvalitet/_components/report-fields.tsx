'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useAuth } from '@/lib/auth-context';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { NONCONFORMITY_TYPE, type NonconformityType } from '@/api/kvalitet';
import { WorkerMultiSelect } from './worker-multi-select';
import { roleFieldMode, type ReportFormState } from './helpers';

/**
 * Zajednička polja izveštaja o neusaglašenosti — koristi se i u dijalogu „Novi
 * izveštaj" i u izmeni detalja. Reorganizovano po Excel konvenciji vlasnika u tri
 * vizuelne grupe (§10 spec + Excel „škart/dorada"):
 *   • BELA („Automatski podaci") — sistem puni (datum, RN, crtež, kupac, količina,
 *     utrošeni sati + materijal u kg); ostaje ručno korigovljivo.
 *   • ŽUTA („Kontrola") — unosi Kontrola (opis greške, uzrok, radna jedinica, izvršioci).
 *   • ZELENA („Tehnologija") — unosi Tehnologija (preventivne mere, napomena,
 *     trošak kooperacije, dodatno — samo dorada).
 * Boje su isključivo statusni tokeni (neutral/warn/success): blaga pozadina + obojena
 * leva ivica + badge; NIJEDAN hex/rgb u komponenti. Rolno usmeravanje je MEKO
 * (backend presuđuje) — vidi `roleFieldMode`.
 */

type SectionTone = 'auto' | 'control' | 'tech';

const SECTION: Record<
  SectionTone,
  { title: string; box: string; dot: string }
> = {
  auto: {
    title: 'Automatski podaci',
    box: 'border-l-status-neutral bg-surface-2',
    dot: 'bg-status-neutral',
  },
  control: {
    title: 'Kontrola',
    box: 'border-l-status-warn bg-status-warn-bg/40',
    dot: 'bg-status-warn',
  },
  tech: {
    title: 'Tehnologija',
    box: 'border-l-status-success bg-status-success-bg/40',
    dot: 'bg-status-success',
  },
};

/** Obojena grupa polja sa naslovom, tačkom i opcionim hintom (npr. zaključano). */
function Section({
  tone,
  hint,
  children,
}: {
  tone: SectionTone;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const s = SECTION[tone];
  return (
    <section
      className={cn(
        'rounded-panel border border-line border-l-4 p-3 sm:p-4',
        s.box,
      )}
    >
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={cn('h-2 w-2 rounded-full', s.dot)} aria-hidden />
        <h3 className="text-sm font-semibold text-ink">{s.title}</h3>
        {hint && <span className="text-xs text-ink-secondary">· {hint}</span>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/** Legenda tri boje (belo/žuto/zeleno) — iznad sekcija. */
function Legend() {
  const items: { dot: string; label: string }[] = [
    { dot: 'bg-status-neutral', label: 'belo — automatski' },
    { dot: 'bg-status-warn', label: 'žuto — kontrola' },
    { dot: 'bg-status-success', label: 'zeleno — tehnologija' },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-secondary">
      <span className="font-medium text-ink">Legenda:</span>
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span className={cn('h-2 w-2 rounded-full', it.dot)} aria-hidden />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/** Zaključan izgled (siva pozadina) kad rola nema pravo unosa u tu sekciju. */
const lockedField =
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-secondary';

export function ReportFields({
  form,
  onChange,
  type,
  autoExtras,
}: {
  form: ReportFormState;
  onChange: (patch: Partial<ReportFormState>) => void;
  type: NonconformityType;
  /** Auto-izračunati blok (utrošeni sati + materijal + „Preračunaj") — samo detalj/škart. */
  autoExtras?: ReactNode;
}) {
  const { user } = useAuth();
  const mode = roleFieldMode(user?.role);
  // Kontrolor: žuto editabilno, zeleno zaključano. Tehnolog: obrnuto. Ostali/nepoznato: sve.
  const controlLocked = mode === 'tech';
  const techLocked = mode === 'control';
  const isScrap = type === NONCONFORMITY_TYPE.SCRAP;
  const isRework = type === NONCONFORMITY_TYPE.REWORK;

  return (
    <div className="space-y-4">
      <Legend />

      {/* ── BELA: automatski podaci ─────────────────────────────────────── */}
      <Section tone="auto">
        {autoExtras}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormField label="Datum" required>
            <Input
              type="date"
              value={form.reportDate}
              onChange={(e) => onChange({ reportDate: e.target.value })}
            />
          </FormField>
          <FormField label="Broj RN (ident)">
            <Input
              value={form.identNumber}
              onChange={(e) => onChange({ identNumber: e.target.value })}
              placeholder="npr. 9400-1/442"
            />
          </FormField>
          <FormField label="Broj crteža">
            <Input
              value={form.drawingNumber}
              onChange={(e) => onChange({ drawingNumber: e.target.value })}
            />
          </FormField>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormField label="Naziv pozicije">
            <Input
              value={form.partName}
              onChange={(e) => onChange({ partName: e.target.value })}
            />
          </FormField>
          <FormField label="Kupac">
            <Input
              value={form.customerName}
              onChange={(e) => onChange({ customerName: e.target.value })}
            />
          </FormField>
          <FormField label="Količina (kom)" required>
            <Input
              type="number"
              min={0}
              inputMode="numeric"
              value={form.quantity}
              onChange={(e) => onChange({ quantity: e.target.value })}
              placeholder="npr. 3"
            />
          </FormField>
        </div>

        {/* Ručna korekcija auto vrednosti (sati/materijal) — Excel bela zona. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormField label="Utrošeno radnih sati" hint="Auto za škart; ručna korekcija dozvoljena.">
            <Input
              value={form.spentHoursText}
              onChange={(e) => onChange({ spentHoursText: e.target.value })}
              placeholder="npr. 4,64h"
            />
          </FormField>
          {isScrap && (
            <FormField label="Trošak materijala (kg)" hint="Auto iz mase; ručna korekcija dozvoljena.">
              <Input
                inputMode="decimal"
                value={form.materialKg}
                onChange={(e) => onChange({ materialKg: e.target.value })}
                placeholder="npr. 8,64"
              />
            </FormField>
          )}
          <FormField label="Materijal — opis">
            <Input
              value={form.materialCostNote}
              onChange={(e) => onChange({ materialCostNote: e.target.value })}
              placeholder="npr. Č.4732 — 14,14kg"
            />
          </FormField>
        </div>
      </Section>

      {/* ── ŽUTA: kontrola ──────────────────────────────────────────────── */}
      <Section tone="control" hint={controlLocked ? 'unosi Kontrola' : undefined}>
        <FormField label="Opis greške" required>
          <Textarea
            className={lockedField}
            disabled={controlLocked}
            value={form.defectDescription}
            onChange={(e) => onChange({ defectDescription: e.target.value })}
            placeholder="Šta je neispravno…"
          />
        </FormField>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Radna jedinica">
            <Input
              className={lockedField}
              disabled={controlLocked}
              value={form.workUnit}
              onChange={(e) => onChange({ workUnit: e.target.value })}
              placeholder="npr. CNC glodanje"
            />
          </FormField>
          <FormField label="Uzrok">
            <Input
              className={lockedField}
              disabled={controlLocked}
              value={form.cause}
              onChange={(e) => onChange({ cause: e.target.value })}
              placeholder="npr. Neopreznost, Loš materijal…"
            />
          </FormField>
        </div>

        <FormField
          label="Izvršioci (radnici)"
          hint="Org-jedinice / spoljne izvršioce (Magacin alata, Projektni biro…) upiši u polje ispod."
        >
          <WorkerMultiSelect
            value={form.culpritWorkers}
            onChange={(culpritWorkers) => onChange({ culpritWorkers })}
            disabled={controlLocked}
          />
        </FormField>

        <FormField label="Izvršilac (slobodan tekst)">
          <Input
            className={lockedField}
            disabled={controlLocked}
            value={form.culpritText}
            onChange={(e) => onChange({ culpritText: e.target.value })}
            placeholder="npr. Magacin alata, RN 9000…"
          />
        </FormField>
      </Section>

      {/* ── ZELENA: tehnologija ─────────────────────────────────────────── */}
      <Section tone="tech" hint={techLocked ? 'unosi Tehnologija' : undefined}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Preventivne mere">
            <Textarea
              className={lockedField}
              disabled={techLocked}
              value={form.preventiveMeasures}
              onChange={(e) => onChange({ preventiveMeasures: e.target.value })}
            />
          </FormField>
          <FormField label="Napomena">
            <Textarea
              className={lockedField}
              disabled={techLocked}
              value={form.note}
              onChange={(e) => onChange({ note: e.target.value })}
            />
          </FormField>
        </div>

        <FormField label="Trošak kooperacije">
          <Input
            className={lockedField}
            disabled={techLocked}
            value={form.coopCostNote}
            onChange={(e) => onChange({ coopCostNote: e.target.value })}
          />
        </FormField>

        {isRework && (
          <FormField label="Dodatno">
            <Textarea
              className={lockedField}
              disabled={techLocked}
              value={form.extra}
              onChange={(e) => onChange({ extra: e.target.value })}
            />
          </FormField>
        )}
      </Section>
    </div>
  );
}
