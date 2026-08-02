'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * `ScanHint` — kratka instrukcija radniku preko dna kadra punoekranskog skenera.
 *
 * ZAŠTO (prijava 01.08.2026, poređenje 1.0 ↔ 3.0 na iPhone-u): 1.0 ispod nišana drži
 * stalno vidljiv savet kako se drži telefon i šta se radi sa folijom/odsjajem
 * (`plan-montaze/src/ui/lokacije/scanModal.js:302-309`, klasa `.loc-scan-hint`), a
 * 3.0 ga NIJE imao ni u jednoj ljusci — radnik koji ne uhvati barkod nema šta da
 * proba osim da menja rastojanje nasumično. Tekst je doslovno preuzet iz 1.0.
 *
 * Jedina odstupanja od 1.0 stringa, oba namerna:
 *  • vodeći emoji (📏) je izbačen — DESIGN_SYSTEM §2 dozvoljava samo `lucide-react`
 *    ikone; nosilac značenja je tekst, ne emoji.
 *  • treći red 1.0 hinta („Tap-ni na ekran za fokus · 📂 iz slike · OCR skeniraj ·
 *    unesi ručno") nosi i AKCIJE; u 3.0 te akcije stoje kao prava dugmad u donjoj
 *    traci ljuske, pa hint zadržava samo instruktivni deo.
 *
 * Za razliku od 1.0 (`position:absolute; bottom:28px`) komponenta je običan blok koji
 * ljuska ubacuje u svoj plutajući donji stek — tako ne može da se preklopi sa statusom,
 * zoom klizačem ili poljem za ručni unos. Poluprovidna podloga je dopuna 1.0-u: tamo
 * je čitljivost nosila samo vinjeta, a hint sada stoji preko svetlijeg dela kadra.
 *
 * Boje su fiksne (bela preko crne), isti izuzetak od DESIGN_SYSTEM §3 kao kod
 * `ScanReticle`: stoji preko ŽIVE slike kamere, ne preko naše površine, pa se ne
 * sme menjati sa svetlom/tamnom temom.
 */
export function ScanHint({
  extra,
  className,
}: {
  /** Dodatni red specifičan za ljusku (npr. OCR ugao u Lokacijama). */
  extra?: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        'rounded-panel bg-black/55 px-3 py-1.5 text-center text-xs leading-normal text-white/90',
        className,
      )}
    >
      Drži telefon 10-15 cm od nalepnice
      <br />
      <strong className="font-semibold">Folija / sjaj:</strong> nagni papir da odsjaj ne
      prekrije crtice
      {extra ? (
        <>
          <br />
          {extra}
        </>
      ) : null}
    </p>
  );
}
