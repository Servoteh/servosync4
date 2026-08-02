'use client';

import { useState, type ReactNode } from 'react';
import { Bot } from 'lucide-react';
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
import { FavStar } from '@/components/ui-kit/fav-star';
import { ScanReticle } from '@/components/ui-kit/scan-reticle';
import { ScanHint } from '@/components/ui-kit/scan-hint';

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
        title="FavStar — zvezdica omiljenog"
        note="Zahtev 010/26. Jedna komponenta, dve varijante (samo tokeni): „sidebar“ (tamni) i „hub“ (svetli). Idle zvezdica je skrivena dok red nije pod mišem/fokusom (ili na touch-u) — pređite mišem preko reda; omiljena (popunjena) je uvek vidljiva. Apsolutno pozicionirana uz desnu ivicu reda; touch-meta 44px (coarse/max-lg). Bez aria-pressed — stanje nosi dinamički aria-label/title."
      >
        <Demo title="Sidebar — idle (hover red)">
          <div className="rounded-panel bg-sidebar p-2">
            <div className="group relative flex items-center rounded-control hover:bg-sidebar-line/60">
              <span className="min-w-0 flex-1 truncate py-1.5 pl-3 pr-8 text-base text-sidebar-ink">
                Radni nalozi
              </span>
              <FavStar variant="sidebar" favorite={false} onToggle={() => {}} />
            </div>
          </div>
        </Demo>

        <Demo title="Sidebar — omiljen (uvek vidljiv)">
          <div className="rounded-panel bg-sidebar p-2">
            <div className="group relative flex items-center rounded-control hover:bg-sidebar-line/60">
              <span className="min-w-0 flex-1 truncate py-1.5 pl-3 pr-8 text-base text-sidebar-ink">
                Realizacija
              </span>
              <FavStar variant="sidebar" favorite onToggle={() => {}} />
            </div>
          </div>
        </Demo>

        <Demo title="Hub — idle (hover red)">
          <div className="rounded-panel border border-line bg-surface p-2">
            <div className="group relative flex items-center rounded-control hover:bg-accent-subtle">
              <span className="min-w-0 flex-1 truncate py-1.5 pl-2 pr-8 text-base text-ink">
                Radni nalozi
              </span>
              <FavStar variant="hub" favorite={false} onToggle={() => {}} />
            </div>
          </div>
        </Demo>

        <Demo title="Hub — omiljen (uvek vidljiv)">
          <div className="rounded-panel border border-line bg-surface p-2">
            <div className="group relative flex items-center rounded-control hover:bg-accent-subtle">
              <span className="min-w-0 flex-1 truncate py-1.5 pl-2 pr-8 text-base text-ink">
                Realizacija
              </span>
              <FavStar variant="hub" favorite onToggle={() => {}} />
            </div>
          </div>
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

      <Section
        title="AiWidget — plutajući AI asistent"
        note="Zahtev 003/26: okruglo dugme dole desno → kompaktni chat panel (AiChat variant='widget') koji ne tera korisnika da napusti trenutnu formu. Non-modal, minimizacija (X/Esc), nit i otvorenost preživljavaju navigaciju. Uživo ga montira AppShell samo korisnicima sa AI permisijom (traži prijavu i API), pa je ovde prikazan samo izgled plutajućeg dugmeta."
      >
        <Demo title="Plutajuće dugme (dole desno)">
          <div className="flex items-center gap-3">
            <span
              className="grid h-14 w-14 place-items-center rounded-full bg-accent text-accent-fg shadow-lg"
              aria-hidden
            >
              <Bot className="h-6 w-6" />
            </span>
            <span className="text-xs text-ink-secondary">
              Klik otvara panel (~380px; na telefonu donji sheet).
            </span>
          </div>
        </Demo>
      </Section>

      <Section
        title="ScanReticle — nišan skenera"
        note="Port vizuelnog jezika iz 1.0 (.loc-scan-reticle u prezentacionom režimu — obe žive 1.0 ljuske ga pale čim kamera krene): širok 3,2:1 prozor za 1D nalepnicu, kvadrat za QR, vinjeta koja zatamni okolinu i crvena linija skena. Dimenzije su viewport-relativne (min(92vw,420px) / min(70vw,280px)) — suzi prozor pregledača i okvir se sam skuplja; na iPhone 390pt daje 358,8 × 112,1 px, tačno kao 1.0. Podloga ispod je lažna „kamera“ (šahovnica), da se vidi šta vinjeta radi."
      >
        <div className="sm:col-span-2 lg:col-span-3 space-y-4">
          <Demo title="barcode (podrazumevano, sa laserom) — lokacije, reversi i montažna kartica">
            <FakeCamera>
              <ScanReticle variant="barcode" />
            </FakeCamera>
          </Demo>
          <Demo title="qr bez lasera — mobilno Održavanje (QR karton sredstva)">
            <FakeCamera>
              <ScanReticle variant="qr" laser={false} />
            </FakeCamera>
          </Demo>
          <Demo title="qr sa laserom (kombinovana nalepnica)">
            <FakeCamera>
              <ScanReticle variant="qr" laser />
            </FakeCamera>
          </Demo>
        </div>
      </Section>

      <Section
        title="ScanHint — instrukcija radniku u skeneru"
        note="Kratak savet kako se drži telefon i šta se radi sa folijom/odsjajem (doslovan tekst iz 1.0 .loc-scan-hint). Ljuska ga ubacuje u svoj plutajući donji stek preko kadra; „extra“ je red specifičan za ekran (OCR u Lokacijama, „Slikaj barkod“ u Reversima…)."
      >
        <div className="sm:col-span-2 lg:col-span-3 space-y-4">
          <Demo title="podrazumevano (bez dodatnog reda)">
            <FakeCamera>
              <div className="absolute inset-x-0 bottom-0 p-3">
                <ScanHint />
              </div>
            </FakeCamera>
          </Demo>
          <Demo title="sa dodatnim redom ljuske">
            <FakeCamera>
              <div className="absolute inset-x-0 bottom-0 p-3">
                <ScanHint extra={'Ne ide? Probaj „Iz slike" ili OCR na gornji desni ugao (predmet/TP)'} />
              </div>
            </FakeCamera>
          </Demo>
        </div>
      </Section>
    </main>
  );
}

/**
 * Lažna „slika kamere" za katalog: šahovnica pokazuje šta vinjeta (box-shadow 9999px)
 * zaista radi — na ravnoj crnoj podlozi se zatamnjenje ne bi videlo.
 */
function FakeCamera({ children }: { children: ReactNode }) {
  return (
    <div
      className="relative h-64 w-full overflow-hidden rounded-panel"
      style={{
        backgroundColor: '#3b4348',
        backgroundImage:
          'linear-gradient(45deg, #566065 25%, transparent 25%, transparent 75%, #566065 75%), linear-gradient(45deg, #566065 25%, transparent 25%, transparent 75%, #566065 75%)',
        backgroundSize: '32px 32px',
        backgroundPosition: '0 0, 16px 16px',
      }}
    >
      {children}
    </div>
  );
}
