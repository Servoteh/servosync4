import { generateKarnetPdf, type KarnetEmployee, type KarnetRow, type KarnetTotals } from './karnet';
import type { ProfileHours } from '@/api/moj-profil';

/**
 * „Moj karnet" — sklapanje `GET /v1/profile/hours` agregata u ulaz za `generateKarnetPdf`.
 *
 * Izdvojeno iz `app/profil/_components/monthly-hours-section.tsx` (desktop) da bi
 * `/mob/sati` dobio ISTI karnet bez kopiranja logike: generator je jedan, ćirilični
 * naslov/meseci/slova dana su jedan, pa PDF sa telefona ne može da se raziđe od onog
 * sa računara. BE radi ceo obračun (dnevni redovi + karnet totali) — ovde nema nijedne
 * poslovne odluke, samo preslikavanje polja.
 *
 * Ćirilica: `generateKarnetPdf` → `newPdf()` registruje Roboto iz `/public/fonts`
 * (isti origin, bez CDN-a), pa su ćirilični naslovi i oznake dana ispravni i offline.
 */

/** Ćirilični nazivi meseca (naslov karneta). */
const MONTH_NAMES_CYR = [
  'јануар', 'фебруар', 'март', 'април', 'мај', 'јун',
  'јул', 'август', 'септембар', 'октобар', 'новембар', 'децембар',
];
/** Ćir. slova dana Sun..Sat (getDay index) — rezerva ako BE ne pošalje `letter`. */
const DAY_LETTERS_CYR = ['Н', 'П', 'У', 'С', 'Ч', 'П', 'С'];

function dowOf(ymd: string | null | undefined): number {
  if (!ymd) return 0;
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

export interface SelfKarnetInput {
  /** Ceo agregat meseca (`useProfileHours`), sa `days` i `totals`. */
  data: ProfileHours;
  year: number;
  /** 1–12. */
  month: number;
  employeeName: string;
  employeePosition?: string;
}

export async function generateSelfKarnetPdf(
  input: SelfKarnetInput,
): Promise<{ blob: Blob; fileName: string }> {
  const { data, year, month, employeeName, employeePosition } = input;
  const monthLabel = `${MONTH_NAMES_CYR[month - 1]} ${year}.`;

  const rows = new Map<string, KarnetRow>();
  let fieldHours = 0;
  const days = data.days.map((d) => {
    rows.set(d.ymd, {
      hours: d.hours,
      overtimeHours: d.overtimeHours,
      fieldHours: d.fieldHours,
      twoMachineHours: d.twoMachineHours,
      absenceCode: d.absenceCode,
      absenceSubtype: d.absenceSubtype,
    });
    fieldHours += Number(d.fieldHours || 0);
    return { ymd: d.ymd, day: d.day, letter: d.letter || DAY_LETTERS_CYR[dowOf(d.ymd)] };
  });

  const employee: KarnetEmployee = {
    name: employeeName,
    position: employeePosition,
    rows,
    totals: data.totals as KarnetTotals,
    fieldHours,
  };

  return generateKarnetPdf({
    title: `КАРНЕТ — ${monthLabel}`,
    monthLabel,
    days,
    holidayYmdSet: new Set(data.holidays ?? []),
    employees: [employee],
  });
}
