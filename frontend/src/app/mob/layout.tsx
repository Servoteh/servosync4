import type { ReactNode } from 'react';

/**
 * Ljuska rute `/mob` — postoji SAMO da obeleži podstablo klasom `mob-scope`,
 * na koju se kače mobilna pravila iz `globals.css` (16px polja da iOS ne zumira
 * stranu na fokus + meta ≥ 44px na sirovim kontrolama Faze 0). Bez ovoga bi se
 * ista pravila morala ponavljati po svakom od ~25 `/mob` ekrana.
 *
 * `contents` (`display: contents`) briše sam omotač iz layout-a — raspored je
 * identičan kao pre uvođenja ove ljuske (strane i dalje sede direktno u
 * `body.flex.flex-col`), a selektor `.mob-scope …` radi normalno jer je stvar
 * DOM-a, ne rasporeda. Pregledač bez `display: contents` dobija običan blok div
 * pune širine — takođe bez posledica.
 *
 * Ljuska NEMA vizuelni sadržaj: zaglavlje/donja traka su `MobShell`
 * (`_components/mob-shell.tsx`), koji svaki ekran montira sam (neki ekrani —
 * skener preko cele slike kamere — namerno idu bez nje).
 */
export default function MobLayout({ children }: { children: ReactNode }) {
  return <div className="mob-scope contents">{children}</div>;
}
