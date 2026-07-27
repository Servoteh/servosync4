/**
 * KEP knjiga — princip vrednovanja (odluka vlasnika, 27.07.2026).
 * =============================================================================
 * Pravilnik dozvoljava da se knjiga evidencije prometa vodi po MALOPRODAJNOJ ili po
 * VELEPRODAJNOJ ceni; koji princip važi je odluka obveznika, ne programera. Zato je
 * to PODEŠAVANJE, a ne konstanta u kodu.
 *
 * Zašto je izbor RETROAKTIVAN: red knjige nosi već obračunatu vrednost (upisuje se pri
 * knjiženju dokumenta), pa bi čuvanje samo jednog iznosa značilo da preklop menja
 * isključivo buduće redove — a knjiga bi postala mešavina dva principa, što je gore od
 * pogrešnog principa jer se ne vidi. Zato `kepu_book_entries` nosi OBA iznosa
 * (`charge`/`discharge` = MP, `charge_vp`/`discharge_vp` = VP), a ovaj prekidač bira
 * koji se ČITA. Isti period se može ponovo odštampati po drugom principu bez knjiženja.
 *
 * Jedan izvor istine za: kepu.service (upit), kepu-pdf.service (štampa i napomena na
 * obrascu) i ekran Podešavanja.
 */

/** Ključ u tabeli `app_switches`. Vrednost stoji u koloni `value`, ne u `enabled`. */
export const KEP_VALUATION_SWITCH = "kep-vrednovanje";

/** MP = maloprodajna cena · VP = veleprodajna cena. */
export type KepValuation = "MP" | "VP";

/** Podrazumevano MP — zatečeno ponašanje pre nego što je izbor uveden. */
export const KEP_VALUATION_DEFAULT: KepValuation = "MP";

/** Srpski naziv principa za štampu i ekran. */
export const KEP_VALUATION_LABEL: Record<KepValuation, string> = {
  MP: "maloprodajna cena",
  VP: "veleprodajna cena",
};

/**
 * Pretvori zapisanu vrednost u princip. Nepoznata/prazna vrednost pada na MP —
 * knjiga mora da se odštampa i kad je podešavanje pokvareno, ali se tada na obrascu
 * vidi koji je princip stvarno primenjen (v. `KEP_VALUATION_LABEL`).
 */
export function parseKepValuation(value: string | null | undefined): KepValuation {
  return String(value ?? "").trim().toUpperCase() === "VP"
    ? "VP"
    : KEP_VALUATION_DEFAULT;
}
