import type { ReactNode } from 'react';
import { MobSwRegister } from './_components/mob-sw-register';

/**
 * Ljuska rute `/mob` — obeležava podstablo klasom `mob-scope`,
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
 *
 * Ovde se montira i `MobSwRegister` — service worker 3.0 mobilne (`/mob-sw.js`, scope
 * `/mob`) postoji SAMO za ovo podstablo. Layout je jedino mesto koje obavija svih ~26
 * `/mob` ekrana a ne dodiruje nijednu desktop rutu; registracija u `app/layout.tsx`
 * bi SW nametnula i celom ERP-u.
 */
export default function MobLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mob-scope contents">
      <MobSwRegister />
      {children}
    </div>
  );
}
