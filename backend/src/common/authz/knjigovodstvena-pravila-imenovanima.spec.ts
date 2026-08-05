import { PERMISSIONS as P, type PermissionKey } from "./permissions";
import { ROLE_PERMISSIONS, roleHasPermission } from "./role-permissions";
import { ALL_ROLE_KEYS, type RoleKey } from "./roles";

/**
 * KNJIGOVODSTVENA PRAVILA SE NE OTVARAJU ROLOM — brana uz odluku 05.08.2026.
 * =============================================================================
 * Dva ekrana u Podešavanjima (brojači dokumenata O-F11, šifarnik vrsta usluge P10)
 * stoje iza JEDNOG prava `settings.accounting_rules`.
 *
 * Vlasnik je tražio „knjigovođa ILI admin, svako svojom šifrom". Sprovedeno je istim
 * obrascem kojim su 05.08. zatvorene knjige: pravo ima SAMO rola `admin` (kroz ALL), a
 * knjigovođa ga dobija IMENOM kroz `user_permission_overrides`
 * (`prisma/seed/knjigovodstveni-sifarnici-imenovani.sql`).
 *
 * ZAŠTO NE ROLA `finansije`: rola postoji u katalogu ali je NAMERNO bez ijednog prava —
 * probana 05.08. kao nadskup menadžmenta i odbačena, jer bi uz knjige tiho dala i
 * upravljanje SCADA-om, forsiranje plana proizvodnje i izmenu montaže (8 paritet-brana,
 * 34 testa). Pojedinačno pravo je uže i preživljava sinhronizaciju rola: vezano je za
 * ČOVEKA, ne za rolu, pa ga prijava preko starog sistema ne dira.
 *
 * ZAŠTO OVAJ FAJL POSTOJI POSEBNO, pored `erp-knjige-samo-imenovanima.spec.ts` (koji isti
 * ključ nabraja u spisku KNJIGE): ovde se ključ proverava po VREDNOSTI STRINGA, ne preko
 * `P.…` konstante. Preimenovanje konstante bi u onom fajlu prošlo nemo (spisak se pomera
 * zajedno sa katalogom), a `user_permission_overrides.key` u bazi drži GOL STRING — pa bi
 * imenovani grantovi tiho prestali da važe i knjigovođa bi ostao bez ekrana bez ijedne
 * greške u logu.
 */

/** Gol string ključa — ISTA vrednost koja stoji u `user_permission_overrides.key`. */
const KLJUC = "settings.accounting_rules" as PermissionKey;

describe("Knjigovodstvena pravila (brojači + vrste usluge) se ne otvaraju rolom", () => {
  it("ključ postoji u katalogu i glasi tačno `settings.accounting_rules`", () => {
    // Vrednost je ugovor sa BAZOM (`user_permission_overrides.key`) i sa SQL seed-om
    // za imenovane ljude — ne sme da se menja uz preimenovanje TS konstante.
    expect(Object.values(P)).toContain(KLJUC);
    expect(P.SETTINGS_ACCOUNTING_RULES).toBe(KLJUC);
  });

  it("NIJEDNA rola osim `admin` ne nosi pravo nad knjigovodstvenim pravilima", () => {
    const prekrsaji: string[] = [];
    for (const role of ALL_ROLE_KEYS as readonly RoleKey[]) {
      if (role === "admin") continue; // admin ima ALL — to je i namera
      if (roleHasPermission(role, KLJUC)) prekrsaji.push(role);
    }
    expect(prekrsaji).toEqual([]);
  });

  it("`admin` ima pravo — inače niko ne bi mogao da podesi startni broj", () => {
    expect(roleHasPermission("admin", KLJUC)).toBe(true);
  });

  it("nova rola ne može da se doda sa ovim pravom a da niko ne primeti", () => {
    // Iterira se po ROLE_PERMISSIONS (izvor istine u kodu), ne po tvrdom spisku imena.
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      if (role === "admin") continue;
      expect({ role, ima: (perms ?? []).includes(KLJUC) }).toEqual({
        role,
        ima: false,
      });
    }
  });

  it("`finansije` je i dalje prazna rola — knjigovođa se imenuje, ne rolom", () => {
    // Da je neko usput „popravio" rolu `finansije` da bude nadskup menadžmenta, ovaj
    // test pada pre nego što ta odluka stigne na produkciju.
    expect(ROLE_PERMISSIONS.finansije ?? []).toEqual([]);
  });
});
