'use client';

import type { Ref } from 'react';

import { cn } from '@/lib/cn';

/**
 * `ScanReticle` — nišan (retikl) preko žive slike kamere u punoekranskim skenerima.
 *
 * DOSLOVAN port vizuelnog jezika iz ServoSync 1.0 (`src/styles/legacy.css`,
 * `.loc-scan-reticle` / `.loc-scan-laser`). Ljudi u pogonu i magacinu skeniraju po
 * tom obliku godinama — 3.0 je dotad crtao skoro kvadratni okvir (288×160 px, 1.8:1),
 * fiksan u pikselima i bez vinjete, pa je „ličio na drugu aplikaciju" (prijava 01.08).
 * Tri stvari nose prepoznatljivost, sve tri su ovde:
 *
 *  1. **Oblik po vrsti koda** — `barcode` je širok i nizak (3:1, oblik same nalepnice),
 *     `qr` je kvadrat (QR karton sredstva).
 *  2. **Vinjeta** (`box-shadow: 0 0 0 9999px`) — zatamni SVE oko okvira i time fokusira
 *     oko na prozor skena. To je najveća vizuelna razlika u odnosu na dosadašnji 3.0.
 *  3. **Laser** — crvena linija preko sredine kadra koja lagano klizi gore-dole; služi
 *     kao „poravnaj 1D barkod sa linijom". Podrazumevano samo za `barcode`.
 *
 * Dimenzije su, kao u 1.0, **responsivne** (`min(…vw, …px)` + `aspect-ratio`), ne
 * fiksne u px: isti nišan radi i na 360 px telefonu i na tabletu u pogonu.
 *
 * **ISPRAVKA 02.08.2026 — nišan je bio ~15% uži i ~10% niži nego u 1.0.**
 * Merenje na iPhone-u (390pt): 1.0 = 358,8 × 112,1 px, 3.0 = 304,2 × 101,4 px.
 * Uzrok NIJE bio „širina koju pojede roditeljski padding" (`vw` je viewport-relativan
 * pa ga padding ne može smanjiti — `min(78vw,360px)` na 390pt daje TAČNO 304,2 px,
 * što je izmerena vrednost): portovane su vrednosti OSNOVNOG `.loc-scan-reticle`
 * pravila, dok obe žive 1.0 ljuske skeniraju u **prezentacionom** režimu —
 * `scanOverlay.js:423` (reversi) i `scanModal.js:513` (lokacije) bezuslovno rade
 * `overlay.classList.add('loc-scan-presentation')` čim kamera krene. Merodavna su
 * zato `legacy.css:4669-4681` pravila za taj režim (portret): `width:min(92vw,420px)`,
 * `aspect-ratio:3.2/1`, vinjeta `rgba(0,0,0,.52)`.
 *
 * Račun posle ispravke (portret):
 *   • iPhone 390pt → `min(0.92 × 390, 420) = 358,8 px` širine, `358,8 / 3,2 = 112,1 px`
 *     visine → paritet sa 1.0 (bilo 304,2 × 101,4).
 *   • 360 px telefon → `331,2 × 103,5 px` · 430pt (Pro Max) → `395,6 × 123,6 px`.
 *   • ≥ 457 px (tablet) → poklopac `420 × 131,3 px` — isti kao u 1.0.
 *
 * **Zašto ovde nema tokena teme** (izuzetak od DESIGN_SYSTEM §3): nišan ne stoji na
 * našoj površini nego preko ŽIVE slike kamere. Bela ivica i crveni laser moraju da se
 * vide i na sjajnom limu i u mračnom magacinu, i ne smeju da se menjaju sa svetlom/tamnom
 * temom — zato su `white/90` i crvena iz 1.0 fiksne. Radijus i dalje ide kroz token
 * (`rounded-panel` = 9 px; 1.0 ima 10 px — razlika je nevidljiva, token je važniji).
 *
 * NIJE portovan „presentation" (uvećani) režim iz 1.0 — širi okvir 4.2:1 uz pokušaj
 * landscape lock-a (`.loc-scan-presentation`). 3.0 taj koncept nema; ako zatreba, u
 * 1.0 CSS-u su gotove vrednosti za portret/pejzaž.
 *
 * Sam okvir ne dira kameru ni dekodiranje — čisto vizuelni sloj, `pointer-events-none`,
 * pa tap-to-focus na `<video>` ispod i dalje radi.
 *
 * **`bottomInset` (02.08.2026, Android regresija):** nišan se centrira u kadru UMANJENOM
 * za plutajući donji panel ljuske, ne u celom ekranu. Bez toga panel (koji od prelaska na
 * full-bleed kadar lebdi preko videa, `z-10`) prosto prekrije nišan: na 360×640 telefonu
 * u „neprekidnom" režimu sa listom skeniranog panel počinje na y≈251, a nišan zauzima
 * 278–382 — radnik cilja u okvir koji ne vidi i u laser koji je pokriven. Vrednost je
 * IZMERENA (`lib/use-scan-panel-inset.ts`), ne procenat: panel raste i pada uživo (zoom
 * klizač, 1–3 reda statusa, hint koji se gasi posle prvog skena, lista skeniranog).
 */

export type ScanReticleVariant = 'barcode' | 'qr';

export function ScanReticle({
  variant,
  laser,
  className,
  bottomInset = 0,
  frameRef,
}: {
  /** `barcode` = široki 3:1 prozor (1D nalepnice) · `qr` = kvadrat (QR karton). */
  variant: ScanReticleVariant;
  /** Crvena linija skena. Podrazumevano uključena samo za `barcode`. */
  laser?: boolean;
  /** Dodatne klase omotača (retko — npr. drugačiji z-index u ljusci). */
  className?: string;
  /**
   * Visina plutajućeg donjeg panela ljuske u px (`lib/use-scan-panel-inset.ts`).
   * Nišan i laser se centriraju u kadru umanjenom za toliko. `0` = staro ponašanje.
   */
  bottomInset?: number;
  /**
   * Ref na SAM OKVIR nišana (unutrašnja kutija sa ivicom) — ljuska ga prosleđuje
   * dekoderu kao `acceptRegion` (nišan-gejt za Samsung A-seriju, 04.08.2026:
   * `shouldLimitScanToReticle` u `lib/barcode-decoder`). Nišan i dalje NE dira
   * ni kameru ni dekodiranje — ref je samo izvor geometrije prozora.
   */
  frameRef?: Ref<HTMLDivElement>;
}) {
  const showLaser = laser ?? variant === 'barcode';

  return (
    <div
      // `overflow-hidden` je obavezan: vinjeta je senka od 9999 px i bez klipovanja
      // bi iscurela preko topbara i donje trake ljuske. Omotač OSTAJE preko celog
      // ekrana (`inset-0`) baš zbog vinjete — zatamnjenje mora da pokrije i pojas iza
      // donjeg panela, čiji je gornji deo providan gradijent.
      className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}
      aria-hidden
    >
      {/* Centrirajuća kutija = kadar MINUS donji panel. Mora da bude pozicionirana:
          laser je `position:absolute; top:50%` i računa se od NJE, pa okvir i laser
          ostaju spojeni kad se panel promeni (na `padding` omotača laser ne reaguje —
          apsolutni element se pozicionira po padding-boksu, tj. po celom ekranu). */}
      <div
        className="absolute inset-x-0 top-0 grid place-items-center"
        style={{ bottom: bottomInset }}
      >
        <div
          ref={frameRef}
          className={cn(
            'rounded-panel border-2 border-white/90',
            variant === 'barcode'
              ? // 1.0 prezentacioni režim, portret (legacy.css:4675-4680) — v. račun u JSDoc-u.
                'aspect-[3.2/1] w-[min(92vw,420px)] shadow-[0_0_0_9999px_rgba(0,0,0,0.52)]'
              : // QR kvadrat nema 1.0 pandan (3.0 koncept) — ostaje na osnovnoj vinjeti .45.
                'aspect-square w-[min(70vw,280px)] shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]',
          )}
        />
        {/* Laser je pozicioniran (z-auto) i dolazi POSLE okvira, pa se crta iznad vinjete.
            Ide preko cele širine kadra — isto kao 1.0 `.loc-scan-laser`. */}
        {showLaser && <div className="scan-laser" />}
      </div>
    </div>
  );
}
