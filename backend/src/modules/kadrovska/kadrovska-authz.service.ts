import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Kadrovska (HR) — 3.0 parnjak sy15 RLS-a.
 *
 * ⚠️ ZAŠTO OVAJ SERVIS MORA DA POSTOJI (isto kao `OdrzavanjeAuthzService`):
 * u sy15 row-scope sprovodi **49 RLS politika na 19 tabela**, pa ih kod NAMERNO
 * ne duplira u `WHERE` (doktrina A.2a — „scope se NE duplira"; guard je gruba
 * modul-kapija, PRAVU odluku donosi DB). 3.0 nema RLS. Da se ovaj sloj ne napiše,
 * prava bi **TIHO nestala**: upit i dalje radi, ruta vrati 200, ekran se otvori —
 * samo ima VIŠE redova nego što sme. Zaposleni bi video tuđu platu, tuđi JMBG,
 * tuđe odsustvo.
 *
 * Izvor istine: **živa sy15, 08.08.2026** (`pg_policies.qual`/`with_check` +
 * `pg_get_functiondef`), ne dokumentacija. Iznad svakog helpera stoji doslovan
 * izvorni izraz.
 *
 * Modul je pod zamrzavanjem (`docs/OTVORENI_POSLOVI.md` §K) — ovde se logika
 * PRENOSI kakva jeste. Zatečene nedoslednosti su označene `⚠️ ZATEČENO` i
 * prenete DOSLOVNO; popravka bi bila dorada, tj. prekršaj odluke.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 IZMERENO ODSTUPANJE #1 — ODAKLE SE ČITA ROLA (dva različita odgovora!)
 *
 * sy15 gejtovi gledaju `public.user_roles` PO MEJLU iz JWT-a. 3.0 `user_roles`
 * ima drugi oblik (`user_id`, `scope_type`) i DRUGU POPUNJENOST. Izmereno
 * 08.08.2026 nad živim bazama, broj RAZLIČITIH MEJLOVA po gejtu:
 *
 *   | gejt                  | sy15 | 3.0 unija | 3.0 samo `user_roles` |
 *   |-----------------------|-----:|----------:|----------------------:|
 *   | `is_admin`            |    4 |         5 |                     2 |
 *   | `is_hr`               |    1 |         1 |                 **0** |
 *   | `is_hr_or_admin`      |   26 |        25 |                     3 |
 *   | `is_poslovni_admin`   |    1 |         1 |                 **0** |
 *   | `is_management`       |   25 |        24 |                     3 |
 *   | `has_edit_role`       |   28 |        27 |                     3 |
 *   | `can_manage_vacreq`   |   28 |        27 |                     3 |
 *   | `can_manage_pii`      |    5 |         6 |                     2 |
 *
 * Za RAVNE gejtove parnjak je **UNIJA `users.role` + globalnih aktivnih
 * `user_roles.role`** (kao u održavanju): odstupanje je ±1, dok bi „samo
 * `user_roles`" ostavilo kadrovsku BEZ IJEDNOG HR korisnika (0!) i modul bi bio
 * prazan za sve osim dva admina.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 IZMERENO ODSTUPANJE #2 — ISTA UNIJA NA SUB-DEPARTMENT SCOPE-U **ŠIRI** PRAVA
 *
 * Ovde se obrazac iz održavanja NE SME prepisati po analogiji. `current_user_
 * manages_employee()` odlučuje ko vidi KOJE zaposlene (JMBG, adresa, račun).
 * Njegova grana glasi: „menadzment BEZ eksplicitne liste podsektora vidi SVE".
 * Lista živi SAMO u `user_roles.managed_sub_department_ids`.
 *
 * U 3.0 je `menadzment` PRIMARNA `users.role` (19 ljudi), a `user_roles` red sa
 * listom postoji za NJIH JEDNOG. Da je `menadzment` uzet iz unije, 18 ljudi bi
 * dobilo „lista je NULL" ⇒ **vide SVE zaposlene**. Izmereno, broj naloga:
 *
 *   | ishod `current_user_manages_employee` | sy15 danas | 3.0 UNIJA | 3.0 HIBRID |
 *   |---------------------------------------|-----------:|----------:|-----------:|
 *   | vidi SVE zaposlene                    |     **12** |    **27** |      **9** |
 *   | vidi samo svoje podsektore            |         14 |         1 |          1 |
 *   | vidi samo sebe                        |         34 |        43 |         61 |
 *
 * Naivna unija = **+15 ljudi dobija uvid u kadrovski karton CELE firme**. Zato
 * je ovde parnjak HIBRID: ravni gejtovi iz unije, a `menadzment`-grana i lista
 * podsektora ISKLJUČIVO iz `user_roles` (jedini izvor koji listu nosi). Greška
 * time ide u BEZBEDNOM smeru (12 → 9), a manjak je čist podatak, ne logika:
 * 13 `menadzment` + 1 `tim_lider` reda iz sy15 još nisu prebačeni u 3.0
 * `user_roles`. Backfill je uslov za preklop — v. izveštaj uz PR.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 IZMERENO ODSTUPANJE #3 — PRISMA NE UME DA IZRAZI `NULL` NIZ
 *
 * `managed_sub_department_ids` je u 3.0 bazi **nullable** (`is_nullable=YES`),
 * ali Prisma skalarne liste tipizira kao `Int[]` i NULL vraća kao `[]`. A baš
 * razlika `NULL` vs `{}` OKREĆE ishod:
 *
 *   `NULL` ⇒ „nema eksplicitnog scope-a" ⇒ menadzment vidi SVE
 *   `{}`   ⇒ „prazan scope"              ⇒ ne vidi NIKOGA
 *
 * Kroz `prisma.userRole.findMany()` te dve stvari IZGLEDAJU ISTO. Zato
 * `loadScope` tu kolonu čita **sirovim SQL-om**. Prepis preko Prisma klijenta bi
 * 4 sy15 menadzera sa `{}` (branislav.stanojevic, dijana.kastratovic,
 * jovica.milosevic, ljubisa.simovic) prebacio iz „ne vidi nikoga" u „vidi sve".
 * ════════════════════════════════════════════════════════════════════════════
 */

/** `current_user_is_admin()` — `role = 'admin'`. */
const ROLE_ADMIN = "admin";
/** `current_user_is_hr()` — `role = 'hr'`. */
const ROLE_HR = "hr";
/** `current_user_is_poslovni_admin()` — `role = 'poslovni_admin'`. */
const ROLE_POSLOVNI_ADMIN = "poslovni_admin";
/** `current_user_is_hr_or_admin()` — ⚠️ ime laže: uključuje i `menadzment`. */
const ROLES_HR_OR_ADMIN = ["admin", "hr", "menadzment"] as const;
/** `current_user_is_management()` — `IN ('admin','menadzment') AND project_id IS NULL`. */
const ROLES_MANAGEMENT = ["admin", "menadzment"] as const;
/** `has_edit_role()` — globalna grana (`project_id IS NULL`). */
const ROLES_EDIT_GLOBAL = [
  "admin",
  "hr",
  "menadzment",
  "pm",
  "leadpm",
  "poslovni_admin",
] as const;
/** `has_edit_role(proj_id)` — projektna grana (samo uz prosleđen projekat). */
const ROLES_EDIT_PROJECT = ["pm", "leadpm"] as const;
/** `current_user_can_manage_vacreq()` — role grana (uz `is_vacreq_admin`). */
const ROLES_MANAGE_VACREQ = [
  "admin",
  "hr",
  "menadzment",
  "leadpm",
  "pm",
  "poslovni_admin",
] as const;
/** `current_user_manages_employee()` — role koje SKRAĆUJU kaskadu na „vidi sve". */
const ROLES_MANAGES_ALL = ["pm", "leadpm", "projektant_vodja"] as const;
/** `current_user_managed_sub_department_ids()` — role koje NOSE listu podsektora. */
const ROLES_SUBDEPT_SCOPE = ["menadzment", "tim_lider"] as const;

/**
 * 🔴 `current_user_is_vacreq_admin()` — mejl je ZAKUCAN U TELU sy15 funkcije:
 *   `SELECT lower(coalesce(auth.jwt()->>'email','')) = ANY (ARRAY['zoran.jarakovic@servoteh.com'])`
 * Prenosi se doslovno. ⚠️ ZATEČENO: hard-kodiran nalog u bravi — nema tabele,
 * nema revizije, gasi se samo izmenom funkcije. Prijavljeno, NIJE popravljeno
 * (zamrzavanje §K).
 */
const VACREQ_ADMIN_EMAILS = ["zoran.jarakovic@servoteh.com"] as const;

/** Prisma `where` isečak koji NIKAD ne pogađa red — parnjak RLS-a „nula redova". */
export const NIJEDAN_RED = { id: { in: [] as string[] } } as const;

/**
 * Snimak prava pozivaoca. U sy15 su gejtovi `STABLE` pa ih planer računa jednom
 * po naredbi; ovde se učita jednom po zahtevu, a svi predikati ispod su ČISTE
 * funkcije nad njim (testabilni bez baze).
 */
export interface KadrScope {
  /** 3.0 `users.id`. */
  userId: number;
  /**
   * `lower(auth.jwt() ->> 'email')`. Prazan string = nalog bez mejla.
   * 🔴 Prazan mejl NIJE isto što i „svi mejlovi" — v. `employeesSelectWhere`.
   */
  email: string;
  /**
   * RAVNI gejtovi: unija `users.role` + globalnih aktivnih `user_roles.role`,
   * sve lowercase. (Odstupanje #1.)
   */
  roles: Set<string>;
  /**
   * SAMO globalne aktivne `user_roles.role` — izvor koji NOSI listu podsektora.
   * Koristi se ISKLJUČIVO u `menadzment`-grani `manages*`. (Odstupanje #2.)
   */
  scopedRoles: Set<string>;
  /**
   * `current_user_managed_sub_department_ids()`.
   * 🔴 `null` (nema reda / NULL kolona) ≠ `[]` (prazna lista) — v. odstupanje #3.
   */
  managedSubDepartmentIds: number[] | null;
  /** `current_user_employee_id()` — mapiranje mejla na `employees.id`, BEZ `is_active`. */
  employeeId: string | null;
  /** `rev_current_employee_id()` — ISTO, ali UZ `is_active IS TRUE`. Asimetrija je zatečena. */
  activeEmployeeId: string | null;
  /** `can_edit_kadrovska_grid()` — mejl je u `kadr_grid_editor_allowlist`. */
  gridEditor: boolean;
  /** `current_user_can_view_salary()` — mejl je u `kadr_salary_viewer_allowlist`. */
  salaryViewer: boolean;
  /** `can_edit_vacation_balance()` — mejl je u `kadr_vacation_editor_allowlist`. */
  vacationEditor: boolean;
  /** `current_user_hides_contracts()` — `user_roles.kadrovska_hide_contracts`. */
  hideContracts: boolean;
}

/** `where` isečak nad `employees` (rezultat `employeesSelectWhere`). */
export type EmployeeScopeWhere =
  | typeof NIJEDAN_RED
  | { OR: Array<Record<string, unknown>> };

/** Prazan snimak — nalog bez ijedne role i bez mejla (default-deny osnova). */
export function prazanKadrScope(userId = 0): KadrScope {
  return {
    userId,
    email: "",
    roles: new Set<string>(),
    scopedRoles: new Set<string>(),
    managedSubDepartmentIds: null,
    employeeId: null,
    activeEmployeeId: null,
    gridEditor: false,
    salaryViewer: false,
    vacationEditor: false,
    hideContracts: false,
  };
}

@Injectable()
export class KadrovskaAuthzService {
  private readonly logger = new Logger(KadrovskaAuthzService.name);
  /** Keš `to_regclass` probe — kadrovske tabele stižu tek migracijom seobe. */
  private kadrTabelePostoje: boolean | null = null;

  constructor(private readonly prisma: PrismaService) {}

  // =========================================================================
  // Učitavanje snimka — JEDINI deo koji dodiruje bazu
  // =========================================================================

  /**
   * Učitava snimak prava za korisnika.
   *
   * 🔴 Zašto sirov SQL a ne Prisma modeli:
   *  1. `managed_sub_department_ids` — Prisma NULL niz vraća kao `[]` (odstupanje #3);
   *  2. allowlist tabele i `employees` u 3.0 stižu tek migracijom seobe, pa se
   *     njihovo postojanje MERI (`to_regclass`) umesto da se pretpostavlja
   *     (pouka „izmeri `to_regclass`, ne pamti"). Dok ih nema, allowlist brave su
   *     `false` (default-deny) — nikad `true`.
   */
  async loadScope(userId: number): Promise<KadrScope> {
    const scope = prazanKadrScope(userId);

    const [user, extraRoles] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, role: true, active: true },
      }),
      this.prisma.userRole.findMany({
        where: { userId, isActive: true, scopeType: "global" },
        select: { role: true },
      }),
    ]);
    if (!user) return scope;

    scope.email = (user.email ?? "").trim().toLowerCase();

    // 🔴 Deaktiviran 3.0 nalog ne nosi NIJEDNU rolu — ni primarnu ni dodatnu.
    // sy15 nema parnjak za `users.active` (tamo `is_active` stoji na redu
    // `user_roles`), pa je ovo svesno, izmereno pravilo: brojevi u odstupanju #1
    // izračunati su upravo sa `users.active` na OBE grane unije. Da se gasi samo
    // primarna rola, deaktiviran nalog sa `user_roles` redom zadržao bi prava.
    if (user.active) {
      if (user.role) scope.roles.add(user.role.trim().toLowerCase());
      for (const r of extraRoles) {
        if (!r.role) continue;
        const rola = r.role.trim().toLowerCase();
        scope.roles.add(rola);
        // `scopedRoles` NAMERNO ne dobija `users.role` — v. odstupanje #2.
        scope.scopedRoles.add(rola);
      }
    }

    // `current_user_managed_sub_department_ids()`:
    //   WHERE role IN ('menadzment','tim_lider') AND is_active
    //   ORDER BY project_id NULLS FIRST LIMIT 1
    // 3.0 parnjak za `project_id NULLS FIRST` = globalni red pre projektnog.
    const lista = await this.prisma.$queryRaw<
      Array<{ managed_sub_department_ids: number[] | null }>
    >(Prisma.sql`
      SELECT ur.managed_sub_department_ids
      FROM public.user_roles ur
      WHERE ur.user_id = ${userId}
        AND ur.is_active IS TRUE
        AND ur.role = ANY(${[...ROLES_SUBDEPT_SCOPE]}::text[])
      ORDER BY (ur.scope_type = 'global') DESC, ur.id
      LIMIT 1
    `);
    // Nema reda -> funkcija u sy15 vraća NULL. Red sa NULL kolonom -> takođe NULL.
    scope.managedSubDepartmentIds =
      lista[0]?.managed_sub_department_ids ?? null;

    if (scope.email && (await this.kadrovskeTabelePostoje())) {
      await this.ucitajKadrovskeBrave(scope);
    }
    return scope;
  }

  /** `to_regclass` proba — meri se, ne pamti se (keširano po instanci servisa). */
  private async kadrovskeTabelePostoje(): Promise<boolean> {
    if (this.kadrTabelePostoje !== null) return this.kadrTabelePostoje;
    const [red] = await this.prisma.$queryRaw<Array<{ ima: boolean }>>(
      Prisma.sql`SELECT to_regclass('public.employees') IS NOT NULL
                     AND to_regclass('public.kadr_grid_editor_allowlist') IS NOT NULL AS ima`,
    );
    this.kadrTabelePostoje = red?.ima === true;
    if (!this.kadrTabelePostoje) {
      this.logger.warn(
        "Kadrovske tabele još nisu u 3.0 bazi — allowlist brave i mapiranje na `employees` su default-deny.",
      );
    }
    return this.kadrTabelePostoje;
  }

  /**
   * Allowlist brave + mapiranje mejla na `employees.id`.
   *
   * 🔴 Dve mape mejl→zaposleni, NAMERNO odvojene:
   *   `current_user_employee_id()`  — BEZ `is_active` filtera
   *   `rev_current_employee_id()`   — SA `is_active IS TRUE`
   * Asimetrija je zatečena i prenosi se doslovno: potvrde dokumenata
   * (`kadr_document_ack`) i onboarding vise o AKTIVNOM redu, pa bivši zaposleni
   * gubi pristup svojoj potvrdi; ocene/razgovori vise o običnom mapiranju.
   */
  private async ucitajKadrovskeBrave(scope: KadrScope): Promise<void> {
    const [red] = await this.prisma.$queryRaw<
      Array<{
        emp_id: string | null;
        emp_id_aktivan: string | null;
        grid: boolean;
        salary: boolean;
        vacation: boolean;
      }>
    >(Prisma.sql`
      SELECT
        (SELECT e.id::text FROM public.employees e
          WHERE lower(e.email) = ${scope.email} LIMIT 1) AS emp_id,
        (SELECT e.id::text FROM public.employees e
          WHERE lower(e.email) = ${scope.email} AND e.is_active IS TRUE LIMIT 1) AS emp_id_aktivan,
        EXISTS (SELECT 1 FROM public.kadr_grid_editor_allowlist a
                 WHERE lower(a.email) = ${scope.email}) AS grid,
        EXISTS (SELECT 1 FROM public.kadr_salary_viewer_allowlist a
                 WHERE lower(a.email) = ${scope.email}) AS salary,
        EXISTS (SELECT 1 FROM public.kadr_vacation_editor_allowlist a
                 WHERE lower(a.email) = ${scope.email}) AS vacation
    `);
    if (!red) return;
    scope.employeeId = red.emp_id;
    scope.activeEmployeeId = red.emp_id_aktivan;
    scope.gridEditor = red.grid;
    scope.salaryViewer = red.salary;
    scope.vacationEditor = red.vacation;
  }

  // =========================================================================
  // GEJT FUNKCIJE — doslovan prepis sy15 tela
  // =========================================================================

  /** `current_user_is_admin()` — `role='admin' AND is_active`. */
  isAdmin(s: KadrScope): boolean {
    return s.roles.has(ROLE_ADMIN);
  }

  /** `current_user_is_hr()` — `role='hr' AND is_active`. */
  isHr(s: KadrScope): boolean {
    return s.roles.has(ROLE_HR);
  }

  /**
   * `current_user_is_hr_or_admin()` — `role IN ('admin','hr','menadzment')`.
   * ⚠️ ZATEČENO: ime funkcije LAŽE — `menadzment` je unutra. Zbog toga celo
   * rukovodstvo (25 ljudi) čita `attendance_events`, `kadr_notification_log`
   * i `kadr_notification_config`. Prenosi se doslovno.
   */
  isHrOrAdmin(s: KadrScope): boolean {
    return ROLES_HR_OR_ADMIN.some((r) => s.roles.has(r));
  }

  /** `current_user_is_poslovni_admin()` — `role='poslovni_admin'`. */
  isPoslovniAdmin(s: KadrScope): boolean {
    return s.roles.has(ROLE_POSLOVNI_ADMIN);
  }

  /**
   * `current_user_is_management()` — `IN ('admin','menadzment') AND project_id IS NULL`.
   * 3.0: `users.role` je po prirodi globalna, `user_roles` se uzima sa
   * `scope_type='global'` (parnjak `project_id IS NULL`) — v. `loadScope`.
   */
  isManagement(s: KadrScope): boolean {
    return ROLES_MANAGEMENT.some((r) => s.roles.has(r));
  }

  /**
   * `has_edit_role(proj_id)`.
   *
   * 🔴 Prva linija tela je `IF auth_email = '' THEN RETURN false` — nalog BEZ
   * mejla nema pravo izmene čak i ako nosi rolu. Bez toga bi servisni nalog
   * (bot, scheduler) mogao da menja kadrovske podatke.
   *
   * Projektna grana (`pm`/`leadpm` na konkretnom projektu) prenosi se radi
   * tačnosti; u kadrovskoj se zove BEZ argumenta (`employees_update`), pa je
   * živa samo globalna grana.
   */
  hasEditRole(s: KadrScope, projektneRole?: Set<string> | null): boolean {
    if (s.email === "") return false;
    if (ROLES_EDIT_GLOBAL.some((r) => s.roles.has(r))) return true;
    if (!projektneRole) return false;
    return ROLES_EDIT_PROJECT.some((r) => projektneRole.has(r));
  }

  /** `current_user_can_manage_employee_pii()` = `is_admin ∨ is_poslovni_admin`. */
  canManageEmployeePii(s: KadrScope): boolean {
    return this.isAdmin(s) || this.isPoslovniAdmin(s);
  }

  /**
   * `kadr_can_manage_hr()` = `is_hr_or_admin ∨ can_manage_employee_pii`.
   * Brava onboardinga i potvrda dokumenata.
   */
  canManageHr(s: KadrScope): boolean {
    return this.isHrOrAdmin(s) || this.canManageEmployeePii(s);
  }

  /** `current_user_is_vacreq_admin()` — zakucan mejl u telu sy15 funkcije. */
  isVacreqAdmin(s: KadrScope): boolean {
    return (VACREQ_ADMIN_EMAILS as readonly string[]).includes(s.email);
  }

  /** `current_user_can_manage_vacreq()` = `is_vacreq_admin ∨ role ∈ {...}`. */
  canManageVacreq(s: KadrScope): boolean {
    return (
      this.isVacreqAdmin(s) || ROLES_MANAGE_VACREQ.some((r) => s.roles.has(r))
    );
  }

  /**
   * `can_edit_kadrovska_grid()` — ALLOWLIST, ne rola:
   *   `EXISTS (SELECT 1 FROM kadr_grid_editor_allowlist WHERE lower(email)=lower(current_user_email()))`
   * 🔴 Admin koji NIJE na spisku NE sme da menja grid. Prepis „admin uvek sme"
   * bi otvorio upis radnih sati celoj administraciji.
   */
  canEditKadrovskaGrid(s: KadrScope): boolean {
    return s.gridEditor;
  }

  /**
   * `current_user_can_view_salary()` — ALLOWLIST (`kadr_salary_viewer_allowlist`).
   * JEDINA brava za plate: nosi 8 politika (`salary_payroll` 4 + `salary_terms` 4).
   * 🔴 Nezavisna je od `admin`: nalog van spiska ne vidi platu ni sa `admin` rolom.
   */
  canViewSalary(s: KadrScope): boolean {
    return s.salaryViewer;
  }

  /** `can_edit_vacation_balance()` — ALLOWLIST (`kadr_vacation_editor_allowlist`). */
  canEditVacationBalance(s: KadrScope): boolean {
    return s.vacationEditor;
  }

  /** `current_user_hides_contracts()` — `user_roles.kadrovska_hide_contracts`. */
  hidesContracts(s: KadrScope): boolean {
    return s.hideContracts;
  }

  /**
   * `current_user_managed_sub_department_ids()`.
   * 🔴 `null` ≠ `[]`. Vraća se kakvo jeste — pozivalac MORA razlikovati.
   */
  managedSubDepartmentIds(s: KadrScope): number[] | null {
    return s.managedSubDepartmentIds;
  }

  /**
   * `current_user_manages_employee(p_emp_id uuid)` — KASKADA, doslovno:
   *
   *   WHEN is_admin            THEN true
   *   WHEN is_hr               THEN true
   *   WHEN is_poslovni_admin   THEN true
   *   WHEN role IN ('pm','leadpm','projektant_vodja') THEN true
   *   WHEN managed_sub_department_ids() IS NULL THEN EXISTS(role='menadzment')
   *   ELSE EXISTS(employees e WHERE e.id = p_emp_id
   *               AND e.sub_department_id IS NOT NULL
   *               AND e.sub_department_id = ANY(managed_sub_department_ids()))
   *
   * 🔴 Tri zamke koje prepis lako izgubi:
   *  1. `{}` (prazna lista) NIJE `NULL` — pada u ELSE i vraća FALSE. U sy15 su
   *     danas 4 menadzera sa `{}` i oni ne vide NIJEDNOG zaposlenog.
   *  2. `p_emp_id = NULL` (poziv iz `attendance_events_read_own`) u ELSE grani
   *     daje NULL ⇒ ponaša se kao FALSE.
   *  3. `menadzment`-grana se čita iz `scopedRoles` (samo `user_roles`), NE iz
   *     unije — inače +15 ljudi vidi ceo kadrovski karton (odstupanje #2).
   */
  managesEmployee(
    s: KadrScope,
    employee: { id: string; subDepartmentId: number | null } | null,
  ): boolean {
    if (this.managesAllEmployees(s)) return true;
    const lista = s.managedSubDepartmentIds;
    // Grana 5 je već potrošena u `managesAllEmployees`; ovde ostaje samo ELSE.
    if (lista === null) return false;
    if (employee === null) return false; // `e.id = NULL` -> NULL -> false
    if (employee.subDepartmentId === null) return false;
    return lista.includes(employee.subDepartmentId);
  }

  /**
   * Bool deo `current_user_manages_employee` koji NE zavisi od reda — tj. „vidi
   * SVE zaposlene". Izdvojen kao imenovan predikat da se izraz ne prepisuje na
   * dva mesta (pouka: dva prepisa istog uslova su se već razišla).
   */
  managesAllEmployees(s: KadrScope): boolean {
    if (this.isAdmin(s) || this.isHr(s) || this.isPoslovniAdmin(s)) return true;
    if (ROLES_MANAGES_ALL.some((r) => s.roles.has(r))) return true;
    // `WHEN managed_sub_department_ids() IS NULL THEN EXISTS(role='menadzment')`
    if (s.managedSubDepartmentIds === null) {
      return s.scopedRoles.has("menadzment");
    }
    return false;
  }

  // =========================================================================
  // `employees` — 4 politike
  // =========================================================================

  /**
   * `employees_select` SELECT:
   *   `current_user_manages_employee(id)
   *    OR (lower(coalesce(email,'')) = lower(coalesce(jwt.email,'')) AND coalesce(email,'') <> '')`
   *
   * 🔴 Član `coalesce(email,'') <> ''` je BRANA, ne ukras: bez njega bi nalog
   * BEZ mejla (`lower('') = lower('')`) povukao SVAKOG zaposlenog kome je mejl
   * prazan — a takvih je u kadrovskoj većina proizvodnje.
   */
  employeesSelectWhere(s: KadrScope): EmployeeScopeWhere | undefined {
    if (this.managesAllEmployees(s)) return undefined;
    const grane: Array<Record<string, unknown>> = [];
    const lista = s.managedSubDepartmentIds;
    if (lista !== null && lista.length > 0) {
      grane.push({ subDepartmentId: { in: lista } });
    }
    if (s.email !== "") {
      grane.push({ email: { equals: s.email, mode: "insensitive" } });
    }
    // Nijedna grana ne može da pogodi red -> parnjak RLS-a „nula redova".
    if (grane.length === 0) return NIJEDAN_RED;
    return { OR: grane };
  }

  /** `employees_insert` WITH CHECK: `is_admin ∨ is_hr ∨ is_poslovni_admin`. */
  canInsertEmployee(s: KadrScope): boolean {
    return this.isAdmin(s) || this.isHr(s) || this.isPoslovniAdmin(s);
  }

  /**
   * `employees_update` USING = WITH CHECK:
   *   `is_admin ∨ is_hr ∨ is_poslovni_admin ∨ (has_edit_role() AND manages_employee(id))`
   */
  canUpdateEmployee(
    s: KadrScope,
    employee: { id: string; subDepartmentId: number | null } | null,
  ): boolean {
    if (this.isAdmin(s) || this.isHr(s) || this.isPoslovniAdmin(s)) return true;
    return this.hasEditRole(s) && this.managesEmployee(s, employee);
  }

  /**
   * `employees_delete` USING: `is_admin ∨ is_hr`.
   * ⚠️ ZATEČENA ASIMETRIJA: brisanje je UŽE od izmene — `poslovni_admin` sme da
   * MENJA zaposlenog ali ne i da ga OBRIŠE. Prepis „isto kao update" bi tiho
   * dao pravo brisanja. Prenosi se doslovno.
   */
  canDeleteEmployee(s: KadrScope): boolean {
    return this.isAdmin(s) || this.isHr(s);
  }

  // =========================================================================
  // `work_hours` — 4 politike (radni sati = osnova za platu)
  // =========================================================================

  /**
   * `work_hours_select` SELECT:
   *   `current_user_manages_employee(employee_id)
   *    OR employee_id IN (SELECT e.id FROM employees e
   *                       WHERE lower(coalesce(e.email,'')) = lower(coalesce(jwt.email,''))
   *                         AND coalesce(e.email,'') <> '')`
   */
  workHoursSelectWhere(s: KadrScope): Record<string, unknown> | undefined {
    const emp = this.employeesSelectWhere(s);
    if (emp === undefined) return undefined;
    if (emp === NIJEDAN_RED) return NIJEDAN_RED;
    return { employee: emp };
  }

  /**
   * `work_hours_insert` WITH CHECK:
   *   `can_edit_kadrovska_grid() AND (absence_code IS DISTINCT FROM 'nop' OR current_user_is_admin())`
   *
   * 🔴 `nop` (neplaćeno odsustvo) je posebno pravo: grid-editor sa spiska sme sve
   * OSIM `nop` — za `nop` treba i `admin`. `IS DISTINCT FROM` znači da NULL
   * `absence_code` PROLAZI (NULL je „različito od 'nop'").
   */
  canWriteWorkHour(s: KadrScope, absenceCode: string | null): boolean {
    if (!this.canEditKadrovskaGrid(s)) return false;
    const nijeNop = absenceCode !== "nop"; // `IS DISTINCT FROM` — NULL prolazi
    return nijeNop || this.isAdmin(s);
  }

  /**
   * `work_hours_update` USING: `can_edit_kadrovska_grid()`;
   * WITH CHECK: isto kao INSERT (dakle `nop` traži i `admin`).
   * ⚠️ Asimetrija USING/CHECK: red SA `nop`-om se sme dohvatiti za izmenu, ali
   * se ne sme UPISATI `nop` bez `admin` role.
   */
  canUpdateWorkHourRow(s: KadrScope): boolean {
    return this.canEditKadrovskaGrid(s);
  }

  /** `work_hours_delete` USING: `can_edit_kadrovska_grid()` — bez `nop` izuzetka. */
  canDeleteWorkHour(s: KadrScope): boolean {
    return this.canEditKadrovskaGrid(s);
  }

  // =========================================================================
  // `attendance_events` — 2 politike (491k redova, kapija piše na 10 min)
  // =========================================================================

  /**
   * DVE permisivne SELECT politike ⇒ **OR**, ne AND:
   *
   *   `attendance_events_read`     = `is_hr_or_admin() OR can_edit_kadrovska_grid()`
   *   `attendance_events_read_own` = `employee_id IN (own by email)
   *                                   OR current_user_manages_employee(NULL::uuid)
   *                                   OR employee_id IN (employees WHERE sub_department_id
   *                                        = ANY(coalesce(managed_sub_department_ids(),'{}')))`
   *
   * 🔴 `current_user_manages_employee(NULL)` — argument je DOSLOVNO NULL. Zato
   * kaskada nikad ne stigne do ELSE grane: `tim_lider` sa listom NE prolazi kroz
   * taj član, nego kroz TREĆI disjunkt (koji gleda `employees.sub_department_id`
   * direktno). Prepis koji bi prosledio pravi `employee_id` promašio bi pravilo.
   *
   * 🔴 `coalesce(list,'{}')` u trećem članu: kad je lista NULL, `= ANY('{}')` je
   * FALSE — sub-dept grana se GASI, ne otvara.
   *
   * 🔴 Događaj sa `employee_id IS NULL` (nespojena kartica) vidi SAMO
   * hr/admin/menadzment/grid-editor: `NULL IN (...)` je NULL ⇒ false.
   */
  attendanceEventsSelectWhere(
    s: KadrScope,
  ): Record<string, unknown> | undefined {
    if (this.isHrOrAdmin(s) || this.canEditKadrovskaGrid(s)) return undefined;
    if (this.managesAllEmployees(s)) return undefined; // manages_employee(NULL)
    const grane: Array<Record<string, unknown>> = [];
    if (s.email !== "") {
      grane.push({
        employee: { email: { equals: s.email, mode: "insensitive" } },
      });
    }
    const lista = s.managedSubDepartmentIds ?? [];
    if (lista.length > 0) {
      grane.push({ employee: { subDepartmentId: { in: lista } } });
    }
    if (grane.length === 0) return NIJEDAN_RED;
    return { OR: grane };
  }

  /**
   * ⚠️ ZATEČENO: `attendance_events` NEMA nijednu INSERT/UPDATE/DELETE politiku
   * (RLS uključen ⇒ upis je za `authenticated` ZABRANJEN). Jedini pisci su
   * DEFINER putevi koji RLS zaobilaze: Katze most (`syncKatze.js`) i kiosk
   * (`kiosk_record_punch`). U 3.0 to znači: aplikativni sloj NE SME da upisuje
   * prisustvo — samo most i kiosk.
   */
  canWriteAttendanceEvent(): boolean {
    return false;
  }

  // =========================================================================
  // `makeup_requests` — 4 politike (nadoknada sati)
  // =========================================================================

  /**
   * `mu_select` SELECT:
   *   `lower(submitted_by) = lower(jwt.email)
   *    OR employee_id IN (SELECT id FROM employees WHERE lower(email) = lower(jwt.email))
   *    OR current_user_can_manage_vacreq()`
   *
   * ⚠️ ZATEČENA ASIMETRIJA prema `employees_select`: ovde NEMA ni `coalesce(...,'')`
   * ni `<> ''` guarda. Posledica koja se prenosi doslovno: nalog sa PRAZNIM
   * mejlom povlači sve zahteve čiji je `submitted_by` prazan string. Prijavljeno,
   * NIJE popravljeno (zamrzavanje §K).
   */
  makeupRequestsSelectWhere(s: KadrScope): Record<string, unknown> | undefined {
    if (this.canManageVacreq(s)) return undefined;
    return {
      OR: [
        { submittedBy: { equals: s.email, mode: "insensitive" } },
        { employee: { email: { equals: s.email, mode: "insensitive" } } },
      ],
    };
  }

  /**
   * `mu_insert` WITH CHECK: `lower(submitted_by) = lower(jwt.email)`.
   * Zahtev se ne podnosi u tuđe ime — jedina provera, BEZ role-gejta.
   */
  canInsertMakeupRequest(s: KadrScope, submittedBy: string | null): boolean {
    return (submittedBy ?? "").trim().toLowerCase() === s.email;
  }

  /** `mu_update` USING = WITH CHECK: `current_user_can_manage_vacreq()`. */
  canUpdateMakeupRequest(s: KadrScope): boolean {
    return this.canManageVacreq(s);
  }

  /**
   * `mu_delete` USING: `current_user_is_hr_or_admin()`.
   * ⚠️ ZATEČENA ASIMETRIJA: brisanje je UŽE od izmene — `pm`/`leadpm`/
   * `poslovni_admin` (koji prolaze `can_manage_vacreq`) NE smeju da brišu.
   */
  canDeleteMakeupRequest(s: KadrScope): boolean {
    return this.isHrOrAdmin(s);
  }

  // =========================================================================
  // `kadr_document_ack` — 2 politike (potvrda o prijemu dokumenta)
  // =========================================================================

  /**
   * `p_doc_ack_read` SELECT: `kadr_can_manage_hr() OR employee_id = rev_current_employee_id()`.
   * 🔴 `rev_current_employee_id()` traži `is_active IS TRUE` — bivši zaposleni
   * NE vidi ni svoju potvrdu. Zatečeno, prenosi se.
   */
  documentAckSelectWhere(s: KadrScope): Record<string, unknown> | undefined {
    if (this.canManageHr(s)) return undefined;
    if (s.activeEmployeeId === null) return NIJEDAN_RED;
    return { employeeId: s.activeEmployeeId };
  }

  /**
   * `p_doc_ack_insert_own` WITH CHECK: `employee_id = rev_current_employee_id()`.
   * 🔴 NEMA HR grane — ni HR ni admin ne potvrđuju prijem umesto zaposlenog.
   */
  canInsertDocumentAck(s: KadrScope, employeeId: string | null): boolean {
    return s.activeEmployeeId !== null && employeeId === s.activeEmployeeId;
  }

  /**
   * ⚠️ ZATEČENO: `kadr_document_ack` nema UPDATE ni DELETE politiku ⇒ potvrda je
   * neopoziva za sve, uključujući admina.
   */
  canModifyDocumentAck(): boolean {
    return false;
  }

  // =========================================================================
  // Onboarding — 6 politika na 4 tabele
  // =========================================================================

  /**
   * `p_onb_runs_manage` (ALL) = `kadr_can_manage_hr()`;
   * `p_onb_runs_own_read` (SELECT) = `employee_id = rev_current_employee_id()`.
   * Permisivne politike ⇒ SELECT je OR.
   */
  onboardingRunsSelectWhere(s: KadrScope): Record<string, unknown> | undefined {
    if (this.canManageHr(s)) return undefined;
    if (s.activeEmployeeId === null) return NIJEDAN_RED;
    return { employeeId: s.activeEmployeeId };
  }

  /**
   * `p_onb_tasks_own_read` SELECT:
   *   `EXISTS (SELECT 1 FROM kadr_onboarding_runs r
   *            WHERE r.id = run_id AND r.employee_id = rev_current_employee_id())`
   * 🔴 Scope ide kroz RODITELJA (`run`), ne kroz zadatak — zadatak nema
   * `employee_id`. Prepis po zadatku ne bi imao po čemu da filtrira i vratio bi SVE.
   */
  onboardingTasksSelectWhere(
    s: KadrScope,
  ): Record<string, unknown> | undefined {
    if (this.canManageHr(s)) return undefined;
    if (s.activeEmployeeId === null) return NIJEDAN_RED;
    return { run: { employeeId: s.activeEmployeeId } };
  }

  /** `p_onb_runs_manage` / `p_onb_tasks_manage` WITH CHECK = `kadr_can_manage_hr()`. */
  canWriteOnboarding(s: KadrScope): boolean {
    return this.canManageHr(s);
  }

  /**
   * `p_onb_tmpl_all` i `p_onb_tmpl_items_all` (ALL, USING = CHECK) = `kadr_can_manage_hr()`.
   * ⚠️ NEMA „own read" grane: običan zaposleni NE VIDI šablone onboardinga,
   * čak ni onaj po kome njegov onboarding teče.
   */
  canReadOnboardingTemplates(s: KadrScope): boolean {
    return this.canManageHr(s);
  }

  /** Isti izraz nosi i upis (USING = WITH CHECK). */
  canWriteOnboardingTemplates(s: KadrScope): boolean {
    return this.canManageHr(s);
  }

  // =========================================================================
  // Sertifikati / lekarski — 8 politika, ISTI izraz na sve 4 komande
  // =========================================================================

  /**
   * `kadr_certificates_{select,insert,update,delete}` i
   * `kadr_medical_exams_{select,insert,update,delete}`:
   *   `current_user_is_hr_or_admin() OR current_user_is_poslovni_admin()`
   *
   * 🔴 NEMA „vidi svoje" grane: zaposleni NE VIDI ni svoj lekarski pregled ni
   * svoj sertifikat. To je najšire odstupanje od očekivanja korisnika u modulu —
   * zatečeno, prenosi se doslovno.
   */
  canReadCertificates(s: KadrScope): boolean {
    return this.isHrOrAdmin(s) || this.isPoslovniAdmin(s);
  }

  /** Isti izraz nosi INSERT/UPDATE/DELETE (sve četiri politike su identične). */
  canWriteCertificates(s: KadrScope): boolean {
    return this.canReadCertificates(s);
  }

  /** `kadr_medical_exams_*` — isti izraz kao sertifikati, posebno imenovan. */
  canReadMedicalExams(s: KadrScope): boolean {
    return this.isHrOrAdmin(s) || this.isPoslovniAdmin(s);
  }

  /** `kadr_medical_exams_{insert,update,delete}`. */
  canWriteMedicalExams(s: KadrScope): boolean {
    return this.canReadMedicalExams(s);
  }

  // =========================================================================
  // Obaveštenja — 5 politika
  // =========================================================================

  /** `kadr_cfg_select_hr` SELECT: `current_user_is_hr_or_admin()`. */
  canReadNotificationConfig(s: KadrScope): boolean {
    return this.isHrOrAdmin(s);
  }

  /** `kadr_cfg_update_hr` USING = WITH CHECK: `current_user_is_hr_or_admin()`. */
  canUpdateNotificationConfig(s: KadrScope): boolean {
    return this.isHrOrAdmin(s);
  }

  /**
   * ⚠️ ZATEČENO: `kadr_notification_config` nema INSERT ni DELETE politiku —
   * red se sme samo MENJATI. Konfiguracija je fiksan skup redova.
   */
  canInsertNotificationConfig(): boolean {
    return false;
  }

  /** `kadr_notif_select_hr` / `kadr_notif_update_hr` / `kadr_notif_delete_hr`. */
  canReadNotificationLog(s: KadrScope): boolean {
    return this.isHrOrAdmin(s);
  }

  /** `kadr_notif_update_hr` USING = WITH CHECK. */
  canUpdateNotificationLog(s: KadrScope): boolean {
    return this.isHrOrAdmin(s);
  }

  /** `kadr_notif_delete_hr` USING. */
  canDeleteNotificationLog(s: KadrScope): boolean {
    return this.isHrOrAdmin(s);
  }

  /**
   * ⚠️ ZATEČENO: `kadr_notification_log` nema INSERT politiku — outbox puni
   * ISKLJUČIVO DEFINER `kadr_queue_*` familija. U 3.0 to znači da red u outbox
   * sme da upiše samo servisni put, nikad korisnički zahtev.
   */
  canInsertNotificationLog(): boolean {
    return false;
  }

  // =========================================================================
  // Revizioni trag
  // =========================================================================

  /**
   * `kadr_audit_log_select` SELECT: `current_user_is_admin()`.
   * 🔴 SAMO `admin` (4 naloga) — ni HR ni menadzment. Nema INSERT/UPDATE/DELETE
   * politike ⇒ trag se ne sme ni dopisati ni obrisati iz aplikacije.
   */
  canReadAuditLog(s: KadrScope): boolean {
    return this.isAdmin(s);
  }

  // =========================================================================
  // Allowlist tabele — 8 politika + JEDNA ZAKLJUČANA
  // =========================================================================

  /**
   * `kadr_grid_editor_allowlist_select` i `kadr_vacation_editor_allowlist_select`:
   *   `qual = true` ⇒ svi ulogovani VIDE ko sme da menja grid / stanje odmora.
   */
  canReadGridEditorAllowlist(): boolean {
    return true;
  }

  /** Isti izraz (`true`) za `kadr_vacation_editor_allowlist_select`. */
  canReadVacationEditorAllowlist(): boolean {
    return true;
  }

  /**
   * 🔴 `kadr_salary_viewer_allowlist` — RLS UKLJUČEN, **NULA POLITIKA**
   * (izmereno: `relrowsecurity = t`, `count(pg_policies) = 0`). To znači
   * DENY-ALL za sve komande i sve korisnike; jedini čitalac je DEFINER
   * `current_user_can_view_salary()`.
   *
   * Ovo je jedina tabela domena koju NIKO ne sme da pročita direktno, i jedina
   * asimetrija prema druga dva allowlista (`select = true`). Prepis „po analogiji
   * sa ostalim allowlistama" odao bi KO SME DA VIDI PLATE — a to je i samo po
   * sebi osetljiv podatak.
   */
  canReadSalaryViewerAllowlist(): boolean {
    return false;
  }

  /**
   * `kadr_grid_editor_allowlist_{insert,update,delete}` i
   * `kadr_vacation_editor_allowlist_{insert,update,delete}`: `current_user_is_admin()`.
   */
  canWriteAllowlist(s: KadrScope): boolean {
    return this.isAdmin(s);
  }

  // =========================================================================
  // Praznici
  // =========================================================================

  /** `kadr_holidays_select`: `qual = true` — kalendar praznika vide svi. */
  canReadHolidays(): boolean {
    return true;
  }

  /** `kadr_holidays_{insert,update,delete}_admin`: `current_user_is_admin()`. */
  canWriteHolidays(s: KadrScope): boolean {
    return this.isAdmin(s);
  }

  // =========================================================================
  // Bonus dani odmora
  // =========================================================================

  /**
   * `bonus_go_read` SELECT: `role() = 'authenticated'` (politika je na `{public}`).
   *
   * ⚠️ ZATEČENI KVAR, prenosi se doslovno: SVAKI ulogovani korisnik vidi bonus
   * dane odmora SVIH zaposlenih (ko je radio vikend i koliko je dobio). Nema ni
   * „samo svoje" ni sub-department sužavanja. Prijavljeno, NIJE popravljeno (§K).
   */
  canReadVacationBonusDays(s: KadrScope): boolean {
    // Parnjak `role() = 'authenticated'` u 3.0 = postoji ulogovan korisnik.
    return s.userId > 0;
  }

  /**
   * ⚠️ ZATEČENO: `vacation_bonus_days` nema INSERT/UPDATE/DELETE politiku ⇒
   * upis ide isključivo kroz DEFINER (`kadr_grant_bonus_go`, `makeup_approve`).
   */
  canWriteVacationBonusDays(): boolean {
    return false;
  }

  // =========================================================================
  // 🔴 PLATE — brava koja NIJE u 49 politika ovog domena, ali domen zaključava
  // =========================================================================

  /**
   * `salary_payroll` (4 politike) i `salary_terms` (4 politike) nose ISKLJUČIVO
   * `current_user_can_view_salary()` — allowlist od 2 mejla.
   *
   * 🔴 Te tabele NISU u skupu od 49 (prefiks im nije `kadr_`/`hr_`), ali brava
   * jeste kadrovska i ovde se drži da ne bi ostala bez vlasnika. Pravilo:
   * plata se ne otvara ni po roli ni po vlasništvu nad redom — SAMO spisak.
   * `admin` van spiska NE VIDI platu.
   */
  salarySelectWhere(s: KadrScope): typeof NIJEDAN_RED | undefined {
    return this.canViewSalary(s) ? undefined : NIJEDAN_RED;
  }

  /** Isti izraz nosi INSERT/UPDATE/DELETE nad `salary_payroll` i `salary_terms`. */
  canWriteSalary(s: KadrScope): boolean {
    return this.canViewSalary(s);
  }
}
