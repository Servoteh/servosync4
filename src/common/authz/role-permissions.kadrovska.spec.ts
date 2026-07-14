import { PERMISSIONS } from "./permissions";
import { roleHasPermission } from "./role-permissions";
import { ALL_ROLE_KEYS, ROLES } from "./roles";

/**
 * Kadrovska (HR) permission matrica — TALAS G (MODULE_SPEC_kadrovska_30.md §2.4,
 * presuda §7 „VAŽE SVI PREDLOZI"). Rola-sloj = VIDLJIVOST (paritet 1.0 auth.js/
 * shared.js gate-ova); PII/row maska OSTAJE u sy15 (RLS + v_employees_safe kroz GUC).
 *
 * KRITIČNE INVARIJANTE (pravila firme §2.6 — regresija = curenje):
 *   - `kadrovska.salary`  = SAMO admin (HR NAMERNO nema zarade).
 *   - `kadrovska.pii`     = admin ∨ poslovni_admin (HR NEMA PII — JMBG/adresa/kartice).
 *   - allowlist ključevi (`grid_edit`/`vacation_edit`) i named `vacreq_admin` (Zoran)
 *     NE idu nijednoj roli — samo admin (kroz ALL); ostali per-user override (§2.5).
 */
describe("Kadrovska permission matrica (paritet 1.0 auth.js/shared.js gate-ova)", () => {
  // Očekivani skupovi (admin je uvek unutra — ALL). Izvor = §2.1 helper-tabela / §2.4.
  const READ = [
    ROLES.ADMIN,
    ROLES.HR,
    ROLES.MENADZMENT,
    ROLES.POSLOVNI_ADMIN,
    ROLES.PROJEKTANT_VODJA,
  ];
  const EDIT = [
    ROLES.ADMIN,
    ROLES.HR,
    ROLES.MENADZMENT,
    ROLES.PM,
    ROLES.LEADPM,
    ROLES.POSLOVNI_ADMIN,
  ];
  const MANAGE = [ROLES.ADMIN, ROLES.HR, ROLES.POSLOVNI_ADMIN];
  const ADMIN_ONLY = [ROLES.ADMIN];
  const PII = [ROLES.ADMIN, ROLES.POSLOVNI_ADMIN];
  const CONTRACTS_READ = [
    ROLES.ADMIN,
    ROLES.HR,
    ROLES.MENADZMENT,
    ROLES.POSLOVNI_ADMIN,
  ];
  const VACREQ_MANAGE = [
    ROLES.ADMIN,
    ROLES.HR,
    ROLES.MENADZMENT,
    ROLES.PM,
    ROLES.LEADPM,
    ROLES.POSLOVNI_ADMIN,
  ];
  const ATTENDANCE = [ROLES.ADMIN, ROLES.HR, ROLES.MENADZMENT];
  // canViewPhoneDirectory (Imenik tab + bulk vCard) — širi mgmt gate od read.
  const IMENIK = [
    ROLES.ADMIN,
    ROLES.MENADZMENT,
    ROLES.HR,
    ROLES.POSLOVNI_ADMIN,
  ];
  const DEV_MANAGE = [
    ROLES.ADMIN,
    ROLES.MENADZMENT,
    ROLES.HR,
    ROLES.PM,
    ROLES.LEADPM,
  ];

  /** Svaka permisija se dodeljuje TAČNO očekivanom skupu — nijedna uloga van skupa. */
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

  // ---- KRITIČNE invarijante (posebno naglašene) ----

  it("kadrovska.salary = SAMO admin (HR NEMA zarade — pravilo firme)", () => {
    expect(roleHasPermission(ROLES.ADMIN, PERMISSIONS.KADROVSKA_SALARY)).toBe(
      true,
    );
    for (const role of [
      ROLES.HR,
      ROLES.MENADZMENT,
      ROLES.POSLOVNI_ADMIN,
      ROLES.PM,
      ROLES.LEADPM,
      ROLES.PROJEKTANT_VODJA,
    ]) {
      expect(roleHasPermission(role, PERMISSIONS.KADROVSKA_SALARY)).toBe(false);
    }
    expectedExactly(PERMISSIONS.KADROVSKA_SALARY, ADMIN_ONLY);
  });

  it("kadrovska.pii = admin ∨ poslovni_admin; HR NEMA PII (JMBG/adresa/kartice)", () => {
    expect(roleHasPermission(ROLES.ADMIN, PERMISSIONS.KADROVSKA_PII)).toBe(
      true,
    );
    expect(
      roleHasPermission(ROLES.POSLOVNI_ADMIN, PERMISSIONS.KADROVSKA_PII),
    ).toBe(true);
    // ⚠️ HR i menadzment NEMAJU pii — namerno (§2.6 pravilo 4).
    expect(roleHasPermission(ROLES.HR, PERMISSIONS.KADROVSKA_PII)).toBe(false);
    expect(roleHasPermission(ROLES.MENADZMENT, PERMISSIONS.KADROVSKA_PII)).toBe(
      false,
    );
    expectedExactly(PERMISSIONS.KADROVSKA_PII, PII);
  });

  it("allowlist/named ključevi (grid_edit/vacation_edit/vacreq_admin) = SAMO admin (ostalo per-user override)", () => {
    for (const perm of [
      PERMISSIONS.KADROVSKA_GRID_EDIT,
      PERMISSIONS.KADROVSKA_VACATION_EDIT,
      PERMISSIONS.KADROVSKA_VACREQ_ADMIN,
    ]) {
      expectedExactly(perm, ADMIN_ONLY);
    }
  });

  // ---- Kompletnost nad ALL_ROLE_KEYS (wrong-grant tripwire) ----

  describe("kompletnost nad ALL_ROLE_KEYS", () => {
    it("kadrovska.read = canAccessKadrovska (admin/hr/menadzment/poslovni_admin/projektant_vodja)", () =>
      expectedExactly(PERMISSIONS.KADROVSKA_READ, READ));
    it("kadrovska.edit = has_edit_role", () =>
      expectedExactly(PERMISSIONS.KADROVSKA_EDIT, EDIT));
    it("kadrovska.manage = kadr_can_manage_hr (admin/hr/poslovni_admin)", () =>
      expectedExactly(PERMISSIONS.KADROVSKA_MANAGE, MANAGE));
    it("kadrovska.admin = SAMO admin", () =>
      expectedExactly(PERMISSIONS.KADROVSKA_ADMIN, ADMIN_ONLY));
    it("kadrovska.contracts_read = read minus projektant_vodja", () =>
      expectedExactly(PERMISSIONS.KADROVSKA_CONTRACTS_READ, CONTRACTS_READ));
    it("kadrovska.vacreq_manage = current_user_can_manage_vacreq", () =>
      expectedExactly(PERMISSIONS.KADROVSKA_VACREQ_MANAGE, VACREQ_MANAGE));
    it("kadrovska.attendance = canSeePrisustvo (admin/hr/menadzment)", () =>
      expectedExactly(PERMISSIONS.KADROVSKA_ATTENDANCE, ATTENDANCE));
    it("kadrovska.attendance_shadow = canSeeShadow (admin/hr/menadzment)", () =>
      expectedExactly(PERMISSIONS.KADROVSKA_ATTENDANCE_SHADOW, ATTENDANCE));
    it("kadrovska.dev_manage = admin/menadzment/hr/pm/leadpm (row-scope u DB)", () =>
      expectedExactly(PERMISSIONS.KADROVSKA_DEV_MANAGE, DEV_MANAGE));
    it("kadrovska.imenik = canViewPhoneDirectory (admin/menadzment/hr/poslovni_admin)", () =>
      expectedExactly(PERMISSIONS.KADROVSKA_IMENIK, IMENIK));
  });

  // ---- Asimetrije (paritet 1.0, NE bug) ----

  it("pm/leadpm imaju edit+vacreq_manage+dev_manage ali NE read (nisu u canAccessKadrovska)", () => {
    for (const role of [ROLES.PM, ROLES.LEADPM]) {
      expect(roleHasPermission(role, PERMISSIONS.KADROVSKA_EDIT)).toBe(true);
      expect(roleHasPermission(role, PERMISSIONS.KADROVSKA_VACREQ_MANAGE)).toBe(
        true,
      );
      expect(roleHasPermission(role, PERMISSIONS.KADROVSKA_DEV_MANAGE)).toBe(
        true,
      );
      expect(roleHasPermission(role, PERMISSIONS.KADROVSKA_READ)).toBe(false);
    }
  });

  it("projektant_vodja ima read ali NE edit ni contracts_read (canViewContracts ga isključuje)", () => {
    expect(
      roleHasPermission(ROLES.PROJEKTANT_VODJA, PERMISSIONS.KADROVSKA_READ),
    ).toBe(true);
    expect(
      roleHasPermission(ROLES.PROJEKTANT_VODJA, PERMISSIONS.KADROVSKA_EDIT),
    ).toBe(false);
    expect(
      roleHasPermission(
        ROLES.PROJEKTANT_VODJA,
        PERMISSIONS.KADROVSKA_CONTRACTS_READ,
      ),
    ).toBe(false);
  });

  // ---- Default-deny za operativne / nepoznate uloge ----

  it("operativne role (monter/magacioner/sef/tehnolog/…) NEMAJU nijednu kadrovska.* permisiju", () => {
    const KADR_KEYS = Object.values(PERMISSIONS).filter((p) =>
      p.startsWith("kadrovska."),
    );
    for (const role of [
      ROLES.MONTER,
      ROLES.MAGACIONER,
      ROLES.SEF,
      ROLES.TEHNOLOG,
      ROLES.CNC_PROGRAMER,
      ROLES.KONTROLOR,
      ROLES.PROIZVODNI_RADNIK,
      ROLES.TIM_LIDER,
      ROLES.CNC_OPERATER,
      ROLES.NABAVKA_VIEW,
      ROLES.VIEWER,
      ROLES.TEHNICAR_ODRZAVANJA,
      ROLES.INZENJER,
    ]) {
      for (const perm of KADR_KEYS) {
        expect({ role, perm, has: roleHasPermission(role, perm) }).toEqual({
          role,
          perm,
          has: false,
        });
      }
    }
  });

  it("nepoznata uloga = default deny (sve kadrovska.*)", () => {
    for (const perm of Object.values(PERMISSIONS).filter((p) =>
      p.startsWith("kadrovska."),
    )) {
      expect(roleHasPermission("nepostojeca", perm)).toBe(false);
    }
  });
});
