import { PERMISSIONS } from "./permissions";
import { roleHasPermission, ROLE_PERMISSIONS } from "./role-permissions";
import { ALL_ROLE_KEYS, ROLES, type RoleKey } from "./roles";

/**
 * TALAS D — Projektni biro + Moj profil + Podešavanja permission matrica
 * (MODULE_SPEC_pb_profil_podesavanja_30.md §2.5, presuda D6/D7/D8, 13.07).
 * Rola-sloj pariteta sa ŽIVIM 1.0 DB gate-ovima (§2.1/§2.2); ROW-odluke (work_reports
 * self-scope, eng-tips draft/org-članstvo, komentar-1h, user_roles ALL=admin) dokazuje
 * e2e/DB — ovde SAMO rola. Kompletnost nad ALL_ROLE_KEYS pinuje pogrešan budući grant.
 */
describe("Talas D permission matrica (paritet 1.0 gate-ova)", () => {
  // „Aktivne" 2.0 uloge = one koje su U KATALOGU (`Object.keys(ROLE_PERMISSIONS)`). D-sloj
  // (univerzalna petlja) daje pb.read/pb.reports_own/profile.self SVAKOJ takvoj (§2.1/§0.2).
  // NB (re-integracija 14.07): tehnicar_odrzavanja je U mapi (aktivirao Talas F) ali BEZ
  // ai.chat → „ima ai.chat" VIŠE NIJE proxy za „u mapi"; koristimo direktno ključeve mape
  // (tačan skup koji D-petlja gađa). Deferred uloge (nabavka/kvalitet/…) NISU u mapi.
  const ACTIVE_ROLES = Object.keys(ROLE_PERMISSIONS) as RoleKey[];
  // Deferred/rezervisane bez modula (nisu u katalogu) — moraju biti default-deny svuda.
  const NON_ACTIVE = ALL_ROLE_KEYS.filter((r) => !ACTIVE_ROLES.includes(r));

  // pb_can_edit_tasks() paritet (§2.4.1: hr/poslovni_admin OSTAJU u edit-u — D7).
  const EDIT_ROLES = [
    ROLES.ADMIN,
    ROLES.HR,
    ROLES.MENADZMENT,
    ROLES.PM,
    ROLES.LEADPM,
    ROLES.POSLOVNI_ADMIN,
    ROLES.PROJEKTANT_VODJA,
  ];
  // comment/progress/tips_write = edit-krug ∪ inzenjer (§2.5).
  const EDIT_PLUS_INZENJER = [...EDIT_ROLES, ROLES.INZENJER];
  const REPORTS_ALL_ROLES = [
    ROLES.ADMIN,
    ROLES.LEADPM,
    ROLES.PM,
    ROLES.MENADZMENT,
  ];
  const ORG_PROFILE_ROLES = [
    ROLES.ADMIN,
    ROLES.MENADZMENT,
    ROLES.PM,
    ROLES.LEADPM,
  ];
  const PREDMET_ROLES = [ROLES.ADMIN, ROLES.MENADZMENT];
  const PROFILE_TEAM_ROLES = [
    ROLES.ADMIN,
    ROLES.HR,
    ROLES.MENADZMENT,
    ROLES.LEADPM,
    ROLES.PM,
    ROLES.POSLOVNI_ADMIN,
  ];
  const ADMIN_ONLY = [ROLES.ADMIN];

  const expectedExactly = (
    perm: (typeof PERMISSIONS)[keyof typeof PERMISSIONS],
    allowed: readonly string[],
  ) => {
    const set = new Set<string>(allowed);
    for (const role of ALL_ROLE_KEYS) {
      expect({ role, has: roleHasPermission(role, perm) }).toEqual({
        role,
        has: set.has(role),
      });
    }
  };

  describe("Projektni biro", () => {
    it("pb.read = SVE aktivne uloge (DB SELECT `true`)", () =>
      expectedExactly(PERMISSIONS.PB_READ, ACTIVE_ROLES));
    it("pb.reports_own = SVE aktivne uloge (self-scope u DB)", () =>
      expectedExactly(PERMISSIONS.PB_REPORTS_OWN, ACTIVE_ROLES));
    it("pb.edit = pb_can_edit_tasks() (hr/poslovni_admin OSTAJU — D7)", () =>
      expectedExactly(PERMISSIONS.PB_EDIT, EDIT_ROLES));
    it("pb.comment = edit-krug ∪ inzenjer", () =>
      expectedExactly(PERMISSIONS.PB_COMMENT, EDIT_PLUS_INZENJER));
    it("pb.progress = edit-krug ∪ inzenjer (restriktovani edit)", () =>
      expectedExactly(PERMISSIONS.PB_PROGRESS, EDIT_PLUS_INZENJER));
    it("pb.tips_write = edit-krug ∪ inzenjer/projektant_vodja", () =>
      expectedExactly(PERMISSIONS.PB_TIPS_WRITE, EDIT_PLUS_INZENJER));
    it("pb.reports_all = {admin, leadpm, pm, menadzment}", () =>
      expectedExactly(PERMISSIONS.PB_REPORTS_ALL, REPORTS_ALL_ROLES));
    it("pb.admin = SAMO admin", () =>
      expectedExactly(PERMISSIONS.PB_ADMIN, ADMIN_ONLY));

    it("inzenjer ima comment/progress/tips_write ALI NE pun pb.edit (§2.4.5)", () => {
      expect(roleHasPermission(ROLES.INZENJER, PERMISSIONS.PB_COMMENT)).toBe(
        true,
      );
      expect(roleHasPermission(ROLES.INZENJER, PERMISSIONS.PB_PROGRESS)).toBe(
        true,
      );
      expect(roleHasPermission(ROLES.INZENJER, PERMISSIONS.PB_TIPS_WRITE)).toBe(
        true,
      );
      expect(roleHasPermission(ROLES.INZENJER, PERMISSIONS.PB_EDIT)).toBe(
        false,
      );
    });
    it("hr I poslovni_admin imaju pb.edit (živo pravilo firme — NE sužavati)", () => {
      expect(roleHasPermission(ROLES.HR, PERMISSIONS.PB_EDIT)).toBe(true);
      expect(roleHasPermission(ROLES.POSLOVNI_ADMIN, PERMISSIONS.PB_EDIT)).toBe(
        true,
      );
    });
  });

  describe("Podešavanja", () => {
    it("settings.users = SAMO admin", () =>
      expectedExactly(PERMISSIONS.SETTINGS_USERS, ADMIN_ONLY));
    it("settings.audit = SAMO admin", () =>
      expectedExactly(PERMISSIONS.SETTINGS_AUDIT, ADMIN_ONLY));
    it("settings.system = SAMO admin", () =>
      expectedExactly(PERMISSIONS.SETTINGS_SYSTEM, ADMIN_ONLY));
    it("settings.org_profile = {admin, menadzment, pm, leadpm} (current_user_can_manage_org_profile)", () =>
      expectedExactly(PERMISSIONS.SETTINGS_ORG_PROFILE, ORG_PROFILE_ROLES));
    it("settings.predmet_aktivacija = {admin, menadzment}", () =>
      expectedExactly(PERMISSIONS.SETTINGS_PREDMET_AKTIVACIJA, PREDMET_ROLES));
  });

  describe("Moj profil", () => {
    it("profile.self = SVAKI prijavljen (sve aktivne uloge)", () =>
      expectedExactly(PERMISSIONS.PROFILE_SELF, ACTIVE_ROLES));
    it("profile.team = {admin, hr, menadzment, leadpm, pm, poslovni_admin}", () =>
      expectedExactly(PERMISSIONS.PROFILE_TEAM, PROFILE_TEAM_ROLES));
  });

  describe("default-deny za deferred/nepoznate uloge", () => {
    it.each(NON_ACTIVE)(
      "%s NEMA pb.read/profile.self (nije aktivirana)",
      (role) => {
        expect(roleHasPermission(role, PERMISSIONS.PB_READ)).toBe(false);
        expect(roleHasPermission(role, PERMISSIONS.PROFILE_SELF)).toBe(false);
      },
    );
    it("nepoznata uloga = deny na svim Talas D permisijama", () => {
      for (const perm of [
        PERMISSIONS.PB_READ,
        PERMISSIONS.PB_EDIT,
        PERMISSIONS.PB_ADMIN,
        PERMISSIONS.SETTINGS_USERS,
        PERMISSIONS.PROFILE_SELF,
        PERMISSIONS.PROFILE_TEAM,
      ]) {
        expect(roleHasPermission("nepostojeca", perm)).toBe(false);
      }
    });
  });
});
