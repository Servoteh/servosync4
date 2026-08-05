'use client';

import { Building2, FileDown, FileText } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { Section } from './section';

const PDF_URL = '/sistematizacija/Sistematizacija_radnih_mesta_2026-08-05_FINAL.pdf';
const DOC_URL = '/sistematizacija/Sistematizacija_radnih_mesta_2026-08-05_FINAL.docx';

/**
 * Sistematizacija radnih mesta — preuzimanje CELE sistematizacije kao PDF ili Word
 * (zahtev Nenada 27.07).
 *
 * VIDLJIVOST: admin + menadžment. Nijedna postojeća permisija nema TAČNO taj skup
 * (`kadrovska.read` je širi — uključuje i hr/poslovni_admin/projektant_vodja), pa se
 * krug sužava proverom role, uz `kadrovska.read` kao uslov da poziv uopšte prođe.
 * Kartica se sama sakriva (obrazac `TeamSection`).
 *
 * Od 05.08.2026. ovo je STATIČAN pravni dokument (advokatski pregledan `.docx` + PDF
 * izvezen iz njega u Word-u), ne generisan iz baze na klik — v.
 * docs/zahtevi/Sistematizacija_radnih_mesta_2026-08-05_FINAL.docx. Naredna pravna
 * verzija ide kroz ručnu zamenu fajlova u `frontend/public/sistematizacija/` (i
 * ažuriranje `PDF_URL`/`DOC_URL` ako se menja naziv fajla).
 */
export function SistematizacijaSection() {
  const { user, can } = useAuth();

  const role = (user?.role ?? '').trim().toLowerCase();
  const allowed = (role === 'admin' || role === 'menadzment') && can(PERMISSIONS.KADROVSKA_READ);
  if (!allowed) return null;

  function download(url: string) {
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <Section
      icon={<Building2 className="h-4 w-4 text-ink-secondary" />}
      title="Sistematizacija radnih mesta"
    >
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => download(PDF_URL)}>
          <FileText className="h-4 w-4" aria-hidden /> Preuzmi PDF
        </Button>
        <Button variant="secondary" onClick={() => download(DOC_URL)}>
          <FileDown className="h-4 w-4" aria-hidden /> Preuzmi Word
        </Button>
      </div>
      <p className="mt-2 text-xs text-ink-secondary">
        Preuzima celu sistematizaciju — sva radna mesta po odeljenjima i pododeljenjima, sa svrhom, odgovornostima,
        ovlašćenjima, KPI-jevima, kvalifikacijama i očekivanjima. Finalna verzija sa pravnim pregledom, 05.08.2026.
        Dostupno administratorima i menadžmentu.
      </p>
    </Section>
  );
}
