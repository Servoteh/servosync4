import { PERMISSIONS as P } from "./permissions";
import { ROLE_PERMISSIONS, roleHasPermission } from "./role-permissions";
import { ALL_ROLE_KEYS, type RoleKey } from "./roles";

/**
 * KNJIGE SE NE OTVARAJU ROLOM — brana uz odluku Nenad, 05.08.2026.
 * =============================================================================
 * POVOD (izmereno nad produkcijom 05.08.2026): pun finansijski paket je stajao na
 * roli `menadzment`, koju nosi 19 AKTIVNIH ljudi. Glavnu knjigu, saldakonta,
 * izvode, plaćanja i PDV evidenciju je time videlo 24 čoveka (19 + 5 admina), bez
 * veze sa tim da li im je to deo posla.
 *
 * PRAVILO: knjige vide SAMO administratori (rola `admin` ima ALL) i pojedinačno
 * imenovani ljudi kroz `user_permission_overrides` (allow = true). Nijedna druga
 * rola ne sme da ih nosi.
 *
 * ZAŠTO TEST, A NE SAMO KOMENTAR: dodavanje permisije roli je jedan red i deluje
 * bezopasno — a tiho otvara knjige SVAKOM budućem korisniku te role. Ovaj test
 * pada na taj red, pre nego što stigne do produkcije.
 *
 * ⚠️ Ako se pravilo ikad promeni, menja se OVDE i uz odluku vlasnika — ne tako što
 * se test „popravi" da prođe.
 */

/**
 * PRAVILA PO KOJIMA KNJIGE NASTAJU — uređuje ih knjigovođa, a važe za sve buduće
 * dokumente. Ista brana kao za same knjige, i to namerno (odluka 05.08.2026):
 *
 *   • startni broj po seriji (`document_number_sequences.last_number`, O-F11) —
 *     određuje broj SLEDEĆE fakture, dakle broj po kom kupac plaća i po kom uplata
 *     zatvara stavku u saldakontima;
 *   • šifarnik vrsta usluge (`service_revenue_types`, P10) — konto prihoda i
 *     PORESKI TRETMAN; jedan red određuje da li se na promet obračunava PDV.
 *
 * Ko sme ovo da menja, sme posredno i da promeni sadržaj knjiga — pa ključ ne sme
 * da visi ni na jednoj roli, isto kao ni sama knjiga.
 */
const PRAVILA_KNJIGA = [P.SETTINGS_ACCOUNTING_RULES] as const;

/** Prava koja čine KNJIGE: glavna knjiga, saldakonta, novac, poreske evidencije. */
const KNJIGE = [
  ...PRAVILA_KNJIGA,
  P.GL_READ,
  P.GL_WRITE,
  P.SALDAKONTI_READ,
  P.SALDAKONTI_RECONCILE,
  P.PLACANJA_READ,
  P.PLACANJA_PREPARE,
  P.PLACANJA_EXPORT,
  P.IZVODI_READ,
  P.IZVODI_IMPORT,
  P.IZVODI_POST,
  P.KAMATA_READ,
  P.KAMATA_WRITE,
  P.BLAGAJNA_READ,
  P.BLAGAJNA_WRITE,
  P.PDV_READ,
  P.PDV_COMPUTE,
  P.ZR_READ,
  P.ZR_COMPUTE,
] as const;

/**
 * OPERATIVA — namerno OSTAJE uz rolu `menadzment`. Nabavka, ponude, roba, prodaja
 * i SEF nisu knjige nego svakodnevni posao; njihovo skidanje bi zaustavilo
 * komercijalu. Ovaj spisak je ovde da se razlika vidi, i da se ne „počisti" usput.
 */
const OPERATIVA = [
  P.NABAVKA_READ,
  P.ROBNO_READ,
  P.SALES_READ,
  P.SEF_READ,
] as const;

describe("Knjige (glavna knjiga, saldakonta, novac, PDV) se ne otvaraju rolom", () => {
  it("NIJEDNA rola osim `admin` ne nosi ijedno pravo nad knjigama", () => {
    const prekrsaji: string[] = [];

    for (const role of ALL_ROLE_KEYS as readonly RoleKey[]) {
      if (role === "admin") continue; // admin ima ALL — to je i namera
      for (const key of KNJIGE) {
        if (roleHasPermission(role, key)) prekrsaji.push(`${role} → ${key}`);
      }
    }

    // Poruka nabraja SVE prekršaje odjednom: ko god ovo obori, treba da vidi celu
    // sliku, a ne da je otkriva jedan po jedan kroz ponovna pokretanja.
    expect(prekrsaji).toEqual([]);
  });

  it("`admin` i dalje ima knjige — inače niko ne bi mogao da radi", () => {
    for (const key of KNJIGE) {
      expect(roleHasPermission("admin", key)).toBe(true);
    }
  });

  it("`menadzment` zadržava OPERATIVU — zatvaranje knjiga ne sme da zaustavi komercijalu", () => {
    for (const key of OPERATIVA) {
      expect(roleHasPermission("menadzment", key)).toBe(true);
    }
  });

  it("spisak KNJIGE prati katalog: svako pravo iz njega mora da postoji", () => {
    // Ako se permisija preimenuje a ovaj spisak ne, brana bi ćutke prestala da čuva
    // baš to pravo. Ovde se to vidi odmah.
    const katalog = new Set(Object.values(P));
    for (const key of KNJIGE) expect(katalog.has(key)).toBe(true);
  });

  it("nova rola ne može da se doda sa knjigama a da niko ne primeti", () => {
    // Iterira se po ROLE_PERMISSIONS (izvor istine u kodu), ne po tvrdom spisku
    // imena — pa rola dodata sutra prolazi kroz istu proveru.
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      if (role === "admin") continue;
      const sporne = (perms ?? []).filter((p) =>
        (KNJIGE as readonly string[]).includes(p),
      );
      expect({ role, sporne }).toEqual({ role, sporne: [] });
    }
  });
});
