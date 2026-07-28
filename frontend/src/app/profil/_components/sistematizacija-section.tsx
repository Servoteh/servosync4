'use client';

import { useState } from 'react';
import { Building2, FileDown, FileText } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { toast } from '@/lib/toast';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { fetchOrgStructure } from '@/api/kadrovska';
import {
  generateSistematizacijaPdf,
  generateSistematizacijaDoc,
  openBlob,
  downloadBlob,
} from '@/lib/hr-pdf';
import { Section } from './section';

/**
 * Sistematizacija radnih mesta — preuzimanje CELE sistematizacije (org struktura +
 * opisi svih radnih mesta) kao PDF ili Word (zahtev Nenada 27.07).
 *
 * VIDLJIVOST: admin + menadžment. Nijedna postojeća permisija nema TAČNO taj skup
 * (`kadrovska.read` je širi — uključuje i hr/poslovni_admin/projektant_vodja), pa se
 * krug sužava proverom role, uz `kadrovska.read` kao uslov da poziv uopšte prođe.
 * Kartica se sama sakriva (obrazac `TeamSection`).
 *
 * PODACI: postojeći `GET /v1/kadrovska/org-structure` (guard `kadrovska.read`, koji
 * menadžment ima) — bez novog backend endpointa. Fetch je IMPERATIVAN, na klik, da se
 * org struktura ne povlači svakom otvaranju profila.
 *
 * Word izvoz je `.doc` (Word-kompatibilan HTML), ne pravi `.docx` — v. komentar u
 * `lib/hr-pdf/sistematizacija-doc.ts`.
 */
export function SistematizacijaSection() {
  const { user, can } = useAuth();
  const [busy, setBusy] = useState<'pdf' | 'doc' | null>(null);

  const role = (user?.role ?? '').trim().toLowerCase();
  const allowed = (role === 'admin' || role === 'menadzment') && can(PERMISSIONS.KADROVSKA_READ);
  if (!allowed) return null;

  async function onExport(kind: 'pdf' | 'doc') {
    setBusy(kind);
    try {
      const org = (await fetchOrgStructure()).data;
      if (!org?.jobPositions?.length) {
        toast('Sistematizacija je prazna — nijedno radno mesto nije uneto.');
        return;
      }
      if (kind === 'pdf') {
        const { blob, fileName } = await generateSistematizacijaPdf(org);
        openBlob(blob);
        downloadBlob(blob, fileName);
      } else {
        const { blob, fileName } = generateSistematizacijaDoc(org);
        downloadBlob(blob, fileName);
      }
    } catch (e) {
      toast('Preuzimanje nije uspelo: ' + (e instanceof Error ? e.message : ''));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section
      icon={<Building2 className="h-4 w-4 text-ink-secondary" />}
      title="Sistematizacija radnih mesta"
    >
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => onExport('pdf')} loading={busy === 'pdf'} disabled={busy !== null}>
          <FileText className="h-4 w-4" aria-hidden /> Preuzmi PDF
        </Button>
        <Button variant="secondary" onClick={() => onExport('doc')} loading={busy === 'doc'} disabled={busy !== null}>
          <FileDown className="h-4 w-4" aria-hidden /> Preuzmi Word
        </Button>
      </div>
      <p className="mt-2 text-xs text-ink-secondary">
        Preuzima celu sistematizaciju — sva radna mesta po odeljenjima i pododeljenjima, sa svrhom, odgovornostima,
        ovlašćenjima, KPI-jevima, kvalifikacijama i očekivanjima. Word verzija se otvara i uređuje u Word-u
        (format <code>.doc</code>); za <code>.docx</code> u Word-u izaberite „Sačuvaj kao”. Dostupno administratorima
        i menadžmentu.
      </p>
    </Section>
  );
}
