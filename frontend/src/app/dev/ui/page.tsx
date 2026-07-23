'use client';

import { useState, type ReactNode } from 'react';
import { FormField } from '@/components/ui-kit/form-field';
import { Button } from '@/components/ui-kit/button';
import { Select, type SelectOption } from '@/components/ui-kit/select';
import { AttachmentInput } from '@/components/ui-kit/attachment-input';
import { AudioRecorder } from '@/components/ui-kit/audio-recorder';
import {
  HelpProvider,
  HelpToggleButton,
  type HelpRegistry,
} from '@/components/ui-kit/help-mode';
import { HelpSpot } from '@/components/ui-kit/help-spot';
import { HelpTour, type HelpTourStep } from '@/components/ui-kit/help-tour';

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

const HELP_DEMO_REGISTRY: HelpRegistry = {
  'demo.polje': {
    title: 'Primer polja',
    text: 'U info režimu se uz svako polje pojavi mala „i" oznaka; klik/tap/hover otvara ovaj oblačić sa objašnjenjem šta polje radi i zašto.',
  },
  'demo.akcija': {
    title: 'Primer akcije',
    text: 'Isto važi i za dugmad/akcije — objašnjenje šta se dešava kad ih pritisnete, iz ugla korisnika.',
  },
};

const HELP_DEMO_TOUR: HelpTourStep[] = [{ spotId: 'demo.polje' }, { spotId: 'demo.akcija' }];

export default function DevUiPage() {
  const [jedinica, setJedinica] = useState('cnc-glodanje');
  const [prazno, setPrazno] = useState('');
  const [smena, setSmena] = useState('prva');
  const [prilozi, setPrilozi] = useState<File[]>([]);
  const [odbaceno, setOdbaceno] = useState<string | null>(null);
  const [snimak, setSnimak] = useState<Blob | null>(null);

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

      <Section
        title="AttachmentInput"
        note="Dropzone + kamera + lista pending fajlova (Zahtevi §5). Slike se resize-uju pre dodavanja; audio ≤ 15 MB; do 10 priloga."
      >
        <Demo title="Prazno / sa fajlovima">
          <AttachmentInput
            value={prilozi}
            onChange={setPrilozi}
            onReject={setOdbaceno}
            max={10}
          />
          {odbaceno && <p className="mt-1 text-xs text-status-danger">{odbaceno}</p>}
        </Demo>

        <Demo title="Zaključano (disabled)">
          <AttachmentInput value={[]} onChange={() => {}} disabled />
        </Demo>
      </Section>

      <Section
        title="AudioRecorder"
        note="Snimanje glasovne poruke kao priloga (Zahtevi §5). MediaRecorder → Blob; preview + trajanje; graceful bez mikrofona."
      >
        <Demo title="Snimanje / preview">
          <AudioRecorder value={snimak} onChange={setSnimak} />
          {snimak && (
            <p className="mt-1 text-2xs text-ink-secondary">
              Snimak: {(snimak.size / 1024).toFixed(0)} KB
            </p>
          )}
        </Demo>

        <Demo title="Zaključano (disabled)">
          <AudioRecorder value={null} onChange={() => {}} disabled />
        </Demo>
      </Section>

      <Section
        title="Info režim — HelpSpot, HelpTour, dugme za pomoć"
        note="Ugrađeni vodič (PLAN_INFO_VODIC): oznake za pomoć uz polja i akcije + vođena tura. Ovde je režim uključen radi prikaza; markeri i tura ne diraju localStorage (persist=false)."
      >
        <div className="sm:col-span-2 lg:col-span-3">
          <HelpProvider
            moduleKey="dev-ui-demo"
            registry={HELP_DEMO_REGISTRY}
            persist={false}
            defaultActive
          >
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-ink-secondary">Zaglavlje modula:</span>
                <HelpToggleButton />
                <span className="text-2xs text-ink-secondary">
                  („?" pali/gasi režim i Shift+? na tastaturi; „Provedi me" pokreće turu)
                </span>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <HelpSpot id="demo.polje">
                  <FormField label="Primer polja" hint="Uz polje stoji mala oznaka za pomoć.">
                    <Select options={RADNA_JEDINICA} defaultValue="cnc-glodanje" />
                  </FormField>
                </HelpSpot>
                <div className="flex items-end">
                  <HelpSpot id="demo.akcija" variant="inline">
                    <Button variant="secondary">Primer akcije</Button>
                  </HelpSpot>
                </div>
              </div>
              <HelpTour steps={HELP_DEMO_TOUR} />
            </div>
          </HelpProvider>
        </div>
      </Section>
    </main>
  );
}
