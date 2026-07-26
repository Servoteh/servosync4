import {
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from "@nestjs/common";

/**
 * Neki sy15 SECURITY DEFINER RPC-ovi NE rade RAISE — odbijenicu vraćaju kao
 * podatak: `{ ok:false, error:'<kod>' }`. Ako se taj payload samo prosledi,
 * Nest ga serijalizuje kao 2xx, FE mutacija ne baca, i korisnik dobije potvrdu
 * za nešto što se u bazi NIJE desilo.
 *
 * ⚠️ AUDIT-K3 (26.07): tako je radila korekcija prisustva —
 * `attendance_submit_correction` vraća `{ok:false, error:'prekasno'|'vec_korigovano'|…}`,
 * a i Kadrovska i Moj profil su prikazivali „✅ Zahtev poslat". Radnik koji
 * zaboravi da otkuca izlaz mislio je da je rešeno, šef nije dobio mejl, a
 * prisustvo je ostajalo sa otvorenim intervalom.
 *
 * `assertRpcOk` prevodi kod u tipiziranu grešku (BACKEND_RULES §7: poslovne
 * greške su tipizirane, 500 samo za neočekivano).
 */

/** Kodovi koje vraća `attendance_submit_correction` / `attendance_cancel_correction`. */
const PORUKE: Record<string, { poruka: string; vrsta: "403" | "409" | "422" }> =
  {
    nema_prava: {
      poruka: "Nemate pravo da korigujete prisustvo za tog zaposlenog.",
      vrsta: "403",
    },
    prekasno: {
      poruka:
        "Rok za ispravku je istekao — korekcija je moguća najviše 3 dana unazad.",
      vrsta: "422",
    },
    buducnost: {
      poruka: "Ne može se korigovati dan u budućnosti.",
      vrsta: "422",
    },
    obrazlozenje_obavezno: {
      poruka: "Obrazloženje je obavezno.",
      vrsta: "422",
    },
    nema_vremena: {
      poruka: "Unesite bar jedno vreme (ulaz ili izlaz).",
      vrsta: "422",
    },
    ulaz_posle_izlaza: {
      poruka: "Vreme ulaza ne može biti posle izlaza.",
      vrsta: "422",
    },
    nepoznat_zaposleni: {
      poruka: "Zaposleni nije pronađen.",
      vrsta: "422",
    },
    vec_korigovano: {
      poruka: "Za taj dan već postoji korekcija.",
      vrsta: "409",
    },
    ulaz_postoji: {
      poruka: "Ulaz za taj dan već postoji.",
      vrsta: "409",
    },
    izlaz_postoji: {
      poruka: "Izlaz za taj dan već postoji.",
      vrsta: "409",
    },
  };

/**
 * Propusti rezultat RPC-a ako je uspeh; inače baci tipiziranu grešku.
 * Rezultat bez `ok` polja se NE dira (RPC-ovi koji ne koriste taj obrazac).
 */
export function assertRpcOk<T>(v: T): T {
  if (!v || typeof v !== "object") return v;
  const rec = v as Record<string, unknown>;
  if (rec.ok !== false) return v;

  const kod = typeof rec.error === "string" ? rec.error : "";
  const m = PORUKE[kod];
  const poruka = m?.poruka ?? `Radnja nije izvršena (${kod || "nepoznat razlog"}).`;
  switch (m?.vrsta) {
    case "403":
      throw new ForbiddenException(poruka);
    case "409":
      throw new ConflictException(poruka);
    default:
      throw new UnprocessableEntityException(poruka);
  }
}
