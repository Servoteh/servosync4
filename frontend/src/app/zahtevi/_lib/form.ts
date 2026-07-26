import { z } from 'zod';
import { NAV_DOMAINS, allModules, hrefPath } from '@/lib/navigation';
import {
  REQUEST_KINDS,
  REQUEST_PRIORITIES,
  REQUEST_KIND_LABEL,
  REQUEST_PRIORITY_LABEL,
} from '@/api/zahtevi';
import type { SelectOption } from '@/components/ui-kit/select';

/**
 * Moduli za select — slugovi iz nav kataloga (MODULE_SPEC §8: „modul (select iz
 * nav kataloga)"). Slug = pathname href-a bez vodeće „/" (npr. „/odrzavanje" →
 * „odrzavanje"), dedup-ovan (crosslisted stavke se pojavljuju dvaput u modelu).
 * Label = nav label. Sortirano po labeli. BE prima slobodan string (≤40) — ovo je samo predlog.
 *
 * Href iz modela SME da nosi query (pogledi modula, npr. „/montaza?view=gantt" —
 * PLAN_NAV_PODMENIJI): takve stavke NISU zaseban modul, pa dele slug svog pathname-a, a kao
 * naziv dobijaju DOMEN (korisnik u zahtevu bira „Montaža i servis", ne „Gantt"). Stavka bez
 * query-ja (pravi modul) uvek pobeđuje nad pogledom.
 */
export function moduleOptions(): SelectOption[] {
  const seen = new Map<string, { label: string; exact: boolean }>();
  for (const domain of NAV_DOMAINS) {
    for (const m of allModules(domain)) {
      const path = hrefPath(m.href);
      const slug = path.replace(/^\//, '');
      if (!slug || slug.includes('/')) continue; // preskoči prazne / pod-rute
      const exact = path === m.href;
      const prev = seen.get(slug);
      if (prev && (prev.exact || !exact)) continue;
      seen.set(slug, { label: exact ? m.label : domain.title, exact });
    }
  }
  return Array.from(seen.entries())
    .map(([value, { label }]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'sr'));
}

export const kindOptions: SelectOption[] = REQUEST_KINDS.map((k) => ({
  value: k,
  label: REQUEST_KIND_LABEL[k],
}));

export const priorityOptions: SelectOption[] = REQUEST_PRIORITIES.map((p) => ({
  value: p,
  label: REQUEST_PRIORITY_LABEL[p],
}));

/**
 * Zod šema forme novog zahteva (DESIGN_SYSTEM §6: poruke na srpskom, konkretne).
 * Samo klijentska provera pre slanja — BE i dalje autoritativno validira
 * (validateCreateChangeRequest, srpske poruke). Opciona polja su prazan string
 * dok korisnik ne izabere (Select bez izbora = "").
 */
export const zahtevFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Naslov je obavezan.')
    .max(200, 'Naslov može imati najviše 200 znakova.'),
  description: z.string().trim().min(1, 'Opis je obavezan.'),
  kind: z.string().optional(),
  module: z.string().optional(),
  priorityUser: z.string().optional(),
  expectedBehavior: z.string().optional(),
  currentBehavior: z.string().optional(),
});

export type ZahtevFormValues = z.infer<typeof zahtevFormSchema>;
