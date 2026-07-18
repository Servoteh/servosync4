'use client';

import { useState, type ReactNode } from 'react';
import { FormField } from '@/components/ui-kit/form-field';
import { Select, type SelectOption } from '@/components/ui-kit/select';

/**
 * `/dev/ui` — interni katalog kit komponenti u svim stanjima (DESIGN_SYSTEM.md §12).
 * Nije deo navigacije i ne zove API; služi za vizuelni review i smoke test na
 * 360 / 768 / 1024 / 1440 px (§11). Svaka nova kit komponenta dobija svoju sekciju.
 */

/** Jedna komponenta = jedna sekcija; unutar nje po jedan `Demo` za svako stanje. */
function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-panel border border-line bg-surface p-4">
      <h2 className="text-md font-semibold text-ink">{title}</h2>
      {note && <p className="mt-1 text-xs text-ink-secondary">{note}</p>}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {children}
      </div>
    </section>
  );
}

function Demo({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-2xs font-medium uppercase tracking-wide text-ink-secondary">
        {title}
      </p>
      {children}
    </div>
  );
}

const RADNA_JEDINICA: SelectOption[] = [
  { value: 'cnc-glodanje', label: 'CNC glodanje' },
  { value: 'cnc-struganje', label: 'CNC struganje' },
  { value: 'brusenje', label: 'Brušenje' },
  { value: 'varenje', label: 'Varenje' },
  { value: 'montaza', label: 'Montaža' },
  { value: 'kontrola', label: 'Kontrola' },
];

const SMENA: SelectOption[] = [
  { value: 'prva', label: 'Prva smena' },
  { value: 'druga', label: 'Druga smena' },
  { value: 'treca', label: 'Treća smena (ukinuta)', disabled: true },
];

export default function DevUiPage() {
  const [jedinica, setJedinica] = useState('cnc-glodanje');
  const [prazno, setPrazno] = useState('');
  const [smena, setSmena] = useState('prva');

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <header>
        <h1 className="text-lg font-semibold text-ink">Katalog kit komponenti</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Interna strana za vizuelni review (DESIGN_SYSTEM.md §12). Proveri na 360 / 768 /
          1024 / 1440 px i u obe teme.
        </p>
      </header>

      <Section
        title="Select"
        note="Kratka fiksna lista. Za šifarnike sa pretragom ide ComboBox."
      >
        <Demo title="Osnovno">
          <FormField label="Radna jedinica">
            <Select
              options={RADNA_JEDINICA}
              value={jedinica}
              onChange={(e) => setJedinica(e.target.value)}
            />
          </FormField>
        </Demo>

        <Demo title="Sa praznom opcijom">
          <FormField label="Odgovoran" hint="Prazna opcija „—“ briše izbor.">
            <Select
              options={RADNA_JEDINICA}
              placeholder="—"
              value={prazno}
              onChange={(e) => setPrazno(e.target.value)}
            />
          </FormField>
        </Demo>

        <Demo title="Obavezno">
          <FormField label="Smena" required>
            <Select
              options={SMENA}
              required
              value={smena}
              onChange={(e) => setSmena(e.target.value)}
            />
          </FormField>
        </Demo>

        <Demo title="Neizborna opcija">
          <FormField label="Smena" hint="„Treća smena“ je disabled na nivou opcije.">
            <Select
              options={SMENA}
              placeholder="—"
              value={smena}
              onChange={(e) => setSmena(e.target.value)}
            />
          </FormField>
        </Demo>

        <Demo title="Zaključano (disabled)">
          <FormField label="Radna jedinica" hint="Rola nema pravo unosa.">
            <Select options={RADNA_JEDINICA} defaultValue="cnc-glodanje" disabled />
          </FormField>
        </Demo>

        <Demo title="Greška (FormField)">
          <FormField label="Radna jedinica" required error="Izaberi radnu jedinicu.">
            <Select options={RADNA_JEDINICA} placeholder="—" defaultValue="" />
          </FormField>
        </Demo>
      </Section>
    </main>
  );
}
