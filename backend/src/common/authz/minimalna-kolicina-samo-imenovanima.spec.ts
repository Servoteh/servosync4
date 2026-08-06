import { PERMISSIONS as P } from "./permissions";
import { ROLE_PERMISSIONS, roleHasPermission } from "./role-permissions";
import { ALL_ROLE_KEYS, type RoleKey } from "./roles";

/**
 * MINIMALNA KOLIČINA SE NE OTVARA ROLOM — brana uz odluku vlasnika, 06.08.2026.
 * =============================================================================
 * ODLUKA (doslovno): „ISPOD MINIMALNE KOLIČINE UNOSE MAGACIONERI, za sada korisnici
 * sa mejlom dusko.kostic, radisav.radevic, nikola.savic."
 *
 * „za sada" i „troje imenovanih" su suština, ne uzgredna napomena — pa se pravo NE
 * kači ni na jednu rolu. IZMERENO na produkciji 06.08.2026:
 *
 *   | rola       | aktivnih |
 *   |------------|----------|
 *   | magacioner |    8     |
 *   | menadzment |   19     |
 *
 * Trojica imenovanih sede u DVE role (Duško Kostić 42 = menadzment, Radisav Radević 51
 * i Nikola Savić 52 = magacioner), pa bi najuža rolna dodela koja ih sve pokriva
 * otvorila kolonu 27 ljudima umesto 3. Zato dodela ide ISKLJUČIVO kroz
 * `user_permission_overrides` (`prisma/seed/minimalne-kolicine-imenovani.sql`),
 * ključana po E-MAILU.
 *
 * ZAŠTO TEST, A NE SAMO KOMENTAR: `P.MASTERS_MIN_QUANTITY` u nizu role je jedan red i
 * deluje bezopasno („pa magacioneri to i rade"). Taj red bi tiho dao pravo svakom
 * budućem magacioneru — uključujući ljude koje vlasnik nije imenovao. Ovaj test pada
 * na njega, pre nego što stigne do produkcije.
 *
 * ⚠️ Ako se pravilo ikad promeni, menja se OVDE i uz odluku vlasnika — ne tako što se
 * test „popravi" da prođe.
 */

/** Pravo koje se čuva: izmena `items.min_quantity` i ništa drugo. */
const MINIMALNA = [P.MASTERS_MIN_QUANTITY] as const;

/**
 * Šta magacioner NASTAVLJA da ima — spisak je ovde da se razlika vidi i da se ovaj
 * talas ne pročita kao oduzimanje. Lager listu i artikle vidi kroz `directory.read`,
 * a robno kretanje kroz `robno.read` (Radisav ga ima imenom od 05.08.2026).
 */
const NETAKNUTO = [P.DIRECTORY_READ] as const;

describe("Minimalna količina artikla se ne otvara rolom", () => {
  it("NIJEDNA rola osim `admin` ne nosi `masters.min_quantity`", () => {
    const prekrsaji: string[] = [];
    for (const role of ALL_ROLE_KEYS as readonly RoleKey[]) {
      if (role === "admin") continue; // admin ima ALL — to je i namera
      for (const key of MINIMALNA) {
        if (roleHasPermission(role, key)) prekrsaji.push(`${role} → ${key}`);
      }
    }
    // Poruka nabraja SVE prekršaje odjednom — ko obori branu, vidi celu sliku.
    expect(prekrsaji).toEqual([]);
  });

  it("`magacioner` NEMA pravo iako je posao njegov — vlasnik je imenovao troje", () => {
    // Najlakša greška: „magacioneri unose minimalne" → dodaj roli. Rola ima 8 ljudi.
    expect(roleHasPermission("magacioner", P.MASTERS_MIN_QUANTITY)).toBe(false);
  });

  it("`menadzment` NEMA pravo — Duško ga dobija imenom, ne kroz svoju rolu", () => {
    expect(roleHasPermission("menadzment", P.MASTERS_MIN_QUANTITY)).toBe(false);
  });

  it("`admin` ima pravo — inače niko ne bi mogao da ispravi grešku", () => {
    expect(roleHasPermission("admin", P.MASTERS_MIN_QUANTITY)).toBe(true);
  });

  it("uski ključ NIJE isto što i kišobran `masters.write`", () => {
    // Da su isti ključ, trojica imenovanih bi na dan otvaranja unosa artikala
    // dobila ceo šifarnik (artikli + komitenti). Dva različita stringa su jedina
    // stvar koja to razdvaja, pa se pinuju.
    expect(P.MASTERS_MIN_QUANTITY).not.toBe(P.MASTERS_WRITE);
    expect(P.MASTERS_MIN_QUANTITY).toBe("masters.min_quantity");
  });

  it("magacioner zadržava uvid u šifarnik — ovo nije oduzimanje prava", () => {
    for (const key of NETAKNUTO) {
      expect(roleHasPermission("magacioner", key)).toBe(true);
    }
  });

  it("nova rola ne može da se doda sa ovim pravom a da niko ne primeti", () => {
    // Iterira se po ROLE_PERMISSIONS (izvor istine u kodu), ne po tvrdom spisku
    // imena — pa rola dodata sutra prolazi kroz istu proveru.
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      if (role === "admin") continue;
      const sporne = (perms ?? []).filter((p) =>
        (MINIMALNA as readonly string[]).includes(p),
      );
      expect({ role, sporne }).toEqual({ role, sporne: [] });
    }
  });

  it("ključ postoji u katalogu (preimenovanje ne sme tiho da isprazni branu)", () => {
    const katalog = new Set(Object.values(P));
    for (const key of MINIMALNA) expect(katalog.has(key)).toBe(true);
  });
});
