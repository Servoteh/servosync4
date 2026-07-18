'use client';

import { DevPlansSection } from './razvoj/dev-plans';
import { AssessmentsSection } from './razvoj/assessments';
import { TalksSection } from './razvoj/talks';

/**
 * Kadrovska → „Razvoj i razgovori" (paritet 1.0 planRazvojaTab + talksSection +
 * assessment360Modal). Tri sekcije: Plan razvoja (lista+detalj+ciljevi+dnevnik 1-na-1),
 * Razgovori i korektivne mere (nacrt→podeli→„upoznat sam" + odluka o zaradi + plan mera),
 * 360° procene (kampanja + radar + ocena rukovodioca + ciljni nivoi + PDF). Vidljivost =
 * kadrovska.dev_manage (gate u page.tsx); row-scope/PII presuđuje sy15 RLS na backendu.
 */
export function RazvojTab() {
  return (
    <div className="space-y-8">
      <DevPlansSection />
      <AssessmentsSection />
      <TalksSection />
    </div>
  );
}
