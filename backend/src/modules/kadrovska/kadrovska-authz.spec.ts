import {
  KadrovskaAuthzService,
  NIJEDAN_RED,
  prazanKadrScope,
  type KadrScope,
} from "./kadrovska-authz.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * SLOJ PRAVA KADROVSKE — paritet 3.0 sa 49 RLS politika žive sy15 (08.08.2026).
 *
 * ZAŠTO OVAJ FAJL POSTOJI: u sy15 row-scope sprovodi RLS, pa ga kod NIJE
 * duplirao. U 3.0 RLS-a nema — prava sada zavise ISKLJUČIVO od
 * `KadrovskaAuthzService`. Greška se ne vidi kao pad: upit radi, ruta vrati 200,
 * ekran se otvori — samo ima VIŠE redova nego što sme.
 *
 * Zato se ovde NE tvrdi „ima podataka" nego se traži **TAČAN BROJ REDOVA** nad
 * fiksnim skupom, po roli. Uz svaki helper ide i **mutaciona proba**: namerno
 * pokvarena varijanta mora da PROMENI broj redova — inače test ne vredi
 * (pouka: 389 zelenih testova propustilo 6 kvarenja prava).
 */

const svc = new KadrovskaAuthzService({} as unknown as PrismaService);

// ═════════════════════════════════════════════════════════════════════════════
// Minimalni evaluator Prisma `where` isečaka — da bi se brojali REDOVI, a ne
// poređivali objekti. Podržava tačno ono što servis proizvodi: `OR`, `in`,
// `equals`+`mode`, skalarno poređenje i ulazak u relaciju.
// ═════════════════════════════════════════════════════════════════════════════

type Row = Record<string, unknown>;

function pogadja(row: Row | null, cond: unknown): boolean {
  if (row === null || row === undefined) return false;
  if (cond === null || typeof cond !== "object") return false;
  for (const [kljuc, uslov] of Object.entries(cond as Row)) {
    if (kljuc === "OR") {
      if (!(uslov as unknown[]).some((c) => pogadja(row, c))) return false;
      continue;
    }
    const vrednost = row[kljuc];
    if (uslov !== null && typeof uslov === "object") {
      const u = uslov as Row;
      if ("in" in u) {
        if (!(u.in as unknown[]).includes(vrednost)) return false;
        continue;
      }
      if ("equals" in u) {
        const a = u.equals;
        const neosetljivo = u.mode === "insensitive";
        const l =
          neosetljivo && typeof vrednost === "string"
            ? vrednost.toLowerCase()
            : vrednost;
        const d = neosetljivo && typeof a === "string" ? a.toLowerCase() : a;
        if (l !== d) return false;
        continue;
      }
      // Relacija: uđi u ugnežđeni objekat.
      if (!pogadja(vrednost as Row | null, u)) return false;
      continue;
    }
    if (vrednost !== uslov) return false;
  }
  return true;
}

/** Broj redova koje `where` propušta. `undefined` = bez sužavanja (svi redovi). */
function broj(redovi: Row[], where: unknown): number {
  if (where === undefined) return redovi.length;
  return redovi.filter((r) => pogadja(r, where)).length;
}

// ═════════════════════════════════════════════════════════════════════════════
// FIKSNI SKUP PODATAKA — 8 zaposlenih, namerno sa rubnim slučajevima
// ═════════════════════════════════════════════════════════════════════════════

const ZAPOSLENI = [
  { id: "e1", email: "ana@servoteh.com", subDepartmentId: 1, isActive: true },
  { id: "e2", email: "bojan@servoteh.com", subDepartmentId: 1, isActive: true },
  { id: "e3", email: "ceca@servoteh.com", subDepartmentId: 2, isActive: true },
  { id: "e4", email: "dejan@servoteh.com", subDepartmentId: 3, isActive: true },
  // Zaposleni BEZ tima (sub_department_id IS NULL) — nikad ne ulazi u sub-dept granu.
  {
    id: "e5",
    email: "era@servoteh.com",
    subDepartmentId: null,
    isActive: true,
  },
  // Zaposleni sa PRAZNIM mejlom — zamka `coalesce(email,'') <> ''`.
  { id: "e6", email: "", subDepartmentId: 2, isActive: true },
  { id: "e7", email: "", subDepartmentId: null, isActive: true },
  { id: "e8", email: "hana@servoteh.com", subDepartmentId: 4, isActive: true },
] as const;

const SATI = ZAPOSLENI.map((e, i) => ({ id: `w${i + 1}`, employee: { ...e } }));

const PRISUSTVO = [
  { id: "a1", employee: { ...ZAPOSLENI[0] } },
  { id: "a2", employee: { ...ZAPOSLENI[1] } },
  { id: "a3", employee: { ...ZAPOSLENI[2] } },
  { id: "a4", employee: { ...ZAPOSLENI[3] } },
  { id: "a5", employee: { ...ZAPOSLENI[4] } },
  { id: "a6", employee: null }, // nespojena kartica (`employee_id IS NULL`)
  { id: "a7", employee: { ...ZAPOSLENI[7] } },
  { id: "a8", employee: { ...ZAPOSLENI[5] } },
];

const NADOKNADE = [
  { id: "m1", submittedBy: "ana@servoteh.com", employee: { ...ZAPOSLENI[0] } },
  {
    id: "m2",
    submittedBy: "bojan@servoteh.com",
    employee: { ...ZAPOSLENI[1] },
  },
  { id: "m3", submittedBy: "hr@servoteh.com", employee: { ...ZAPOSLENI[2] } },
  { id: "m4", submittedBy: "ceca@servoteh.com", employee: { ...ZAPOSLENI[2] } },
  // Zahtev sa PRAZNIM `submitted_by` — zamka koja postoji SAMO u `mu_select`.
  { id: "m5", submittedBy: "", employee: { ...ZAPOSLENI[5] } },
  {
    id: "m6",
    submittedBy: "dejan@servoteh.com",
    employee: { ...ZAPOSLENI[3] },
  },
];

const POTVRDE = [
  { id: "d1", employeeId: "e1" },
  { id: "d2", employeeId: "e2" },
  { id: "d3", employeeId: "e9" }, // potvrda bivšeg (neaktivnog) zaposlenog
];

const ONBOARDING_ZADACI = [
  { id: "t1", run: { employeeId: "e1" } },
  { id: "t2", run: { employeeId: "e2" } },
  { id: "t3", run: { employeeId: "e1" } },
];

// ═════════════════════════════════════════════════════════════════════════════
// ROLE POD PROBOM
// ═════════════════════════════════════════════════════════════════════════════

function scope(p: Partial<KadrScope> = {}): KadrScope {
  return { ...prazanKadrScope(1), ...p };
}

/** Admin — `users.role='admin'`. Skraćuje kaskadu na prvom `WHEN`. */
const ADMIN = scope({
  userId: 10,
  email: "admin@servoteh.com",
  roles: new Set(["admin"]),
});

/** Kadrovska referent — `role='hr'`. */
const HR = scope({
  userId: 11,
  email: "hr@servoteh.com",
  roles: new Set(["hr"]),
});

/** Rukovodilac sa EKSPLIKTNOM listom podsektora (`menadzment`, lista `{1,2}`). */
const RUKOVODILAC = scope({
  userId: 12,
  email: "sef@servoteh.com",
  roles: new Set(["menadzment"]),
  scopedRoles: new Set(["menadzment"]),
  managedSubDepartmentIds: [1, 2],
});

/** 🔴 Rukovodilac sa PRAZNOM listom `{}` — u sy15 ne vidi NIKOGA. */
const RUKOVODILAC_PRAZNA = scope({
  userId: 13,
  email: "sef2@servoteh.com",
  roles: new Set(["menadzment"]),
  scopedRoles: new Set(["menadzment"]),
  managedSubDepartmentIds: [],
});

/** 🔴 Rukovodilac BEZ `user_roles` reda (lista `NULL`) — grana „vidi sve". */
const RUKOVODILAC_BEZ_LISTE = scope({
  userId: 14,
  email: "sef3@servoteh.com",
  roles: new Set(["menadzment"]),
  scopedRoles: new Set(["menadzment"]),
  managedSubDepartmentIds: null,
});

/** Tim lider sa listom `{2}` — jedina rola koja scope dobija SAMO kroz listu. */
const TIM_LIDER = scope({
  userId: 15,
  email: "lider@servoteh.com",
  roles: new Set(["tim_lider"]),
  scopedRoles: new Set(["tim_lider"]),
  managedSubDepartmentIds: [2],
});

/** Običan zaposleni (Ana) — bez ijedne kadrovske role. */
const ZAPOSLENI_ANA = scope({
  userId: 16,
  email: "ana@servoteh.com",
  roles: new Set(["viewer"]),
  employeeId: "e1",
  activeEmployeeId: "e1",
});

/** Zaposleni BEZ tima (Era, `sub_department_id IS NULL`). */
const ZAPOSLENI_BEZ_TIMA = scope({
  userId: 17,
  email: "era@servoteh.com",
  roles: new Set(["viewer"]),
  employeeId: "e5",
  activeEmployeeId: "e5",
});

/** Servisni nalog BEZ mejla (bot/scheduler) — najopasniji rubni slučaj. */
const BEZ_MEJLA = scope({ userId: 18, email: "", roles: new Set(["viewer"]) });

/** 🔴 Nalog VAN spiska za plate — `admin`, ali nije u `kadr_salary_viewer_allowlist`. */
const ADMIN_VAN_SPISKA_ZA_PLATE = ADMIN;

/** Nalog NA spisku za plate. */
const NA_SPISKU_ZA_PLATE = scope({
  userId: 19,
  email: "nevena.knezevic@servoteh.com",
  roles: new Set(["admin"]),
  salaryViewer: true,
});

/** Grid-editor sa spiska koji NIJE admin — nosi `can_edit_kadrovska_grid()`. */
const GRID_EDITOR = scope({
  userId: 20,
  email: "nikola.mrkajic@servoteh.com",
  roles: new Set(["hr"]),
  gridEditor: true,
});

/** Bivši zaposleni — ima `employees` red, ali `is_active = false`. */
const BIVSI_ZAPOSLENI = scope({
  userId: 21,
  email: "bivsi@servoteh.com",
  roles: new Set(["viewer"]),
  employeeId: "e9",
  activeEmployeeId: null, // `rev_current_employee_id()` traži `is_active IS TRUE`
});

// ═════════════════════════════════════════════════════════════════════════════
// TABELA ISTINITOSTI — TAČAN BROJ REDOVA (nikad „> 0")
// ═════════════════════════════════════════════════════════════════════════════

describe("TABELA ISTINITOSTI — `employees` (employees_select, 8 redova u skupu)", () => {
  const oc: Array<[string, KadrScope, number]> = [
    ["admin", ADMIN, 8],
    ["kadrovska referent (hr)", HR, 8],
    ["rukovodilac, lista {1,2}", RUKOVODILAC, 4], // e1,e2 (sub1) + e3,e6 (sub2)
    ["🔴 rukovodilac, lista {} ", RUKOVODILAC_PRAZNA, 0],
    ["rukovodilac bez user_roles reda (lista NULL)", RUKOVODILAC_BEZ_LISTE, 8],
    ["tim lider, lista {2}", TIM_LIDER, 2], // e3, e6
    ["običan zaposleni (Ana)", ZAPOSLENI_ANA, 1],
    ["zaposleni BEZ tima (Era)", ZAPOSLENI_BEZ_TIMA, 1],
    ["🔴 nalog bez mejla", BEZ_MEJLA, 0],
  ];
  it.each(oc)("%s -> %s vidi TAČNO %i zaposlenih", (_ime, s, ocekivano) => {
    expect(broj([...ZAPOSLENI], svc.employeesSelectWhere(s))).toBe(ocekivano);
  });
});

describe("TABELA ISTINITOSTI — `work_hours` (work_hours_select, 8 redova)", () => {
  const oc: Array<[string, KadrScope, number]> = [
    ["admin", ADMIN, 8],
    ["kadrovska referent (hr)", HR, 8],
    ["rukovodilac, lista {1,2}", RUKOVODILAC, 4],
    ["🔴 rukovodilac, lista {}", RUKOVODILAC_PRAZNA, 0],
    ["tim lider, lista {2}", TIM_LIDER, 2],
    ["običan zaposleni (Ana)", ZAPOSLENI_ANA, 1],
    ["zaposleni BEZ tima (Era)", ZAPOSLENI_BEZ_TIMA, 1],
    ["🔴 nalog bez mejla", BEZ_MEJLA, 0],
  ];
  it.each(oc)("%s -> TAČNO %i redova sati", (_ime, s, ocekivano) => {
    expect(broj(SATI, svc.workHoursSelectWhere(s))).toBe(ocekivano);
  });
});

describe("TABELA ISTINITOSTI — `attendance_events` (2 politike = OR, 8 redova)", () => {
  const oc: Array<[string, KadrScope, number]> = [
    ["admin", ADMIN, 8],
    ["kadrovska referent (hr)", HR, 8],
    // ⚠️ `menadzment` je UNUTAR `current_user_is_hr_or_admin()` — vidi i nespojene.
    ["rukovodilac (menadzment)", RUKOVODILAC, 8],
    ["🔴 rukovodilac, lista {} (i dalje menadzment)", RUKOVODILAC_PRAZNA, 8],
    ["grid-editor sa spiska", GRID_EDITOR, 8],
    ["tim lider, lista {2}", TIM_LIDER, 2], // a3 (Ceca) + a8 (Filip)
    ["običan zaposleni (Ana)", ZAPOSLENI_ANA, 1],
    ["zaposleni BEZ tima (Era)", ZAPOSLENI_BEZ_TIMA, 1],
    ["🔴 nalog bez mejla", BEZ_MEJLA, 0],
  ];
  it.each(oc)("%s -> TAČNO %i događaja", (_ime, s, ocekivano) => {
    expect(broj(PRISUSTVO, svc.attendanceEventsSelectWhere(s))).toBe(ocekivano);
  });

  it("🔴 nespojena kartica (`employee_id IS NULL`) ne curi ka zaposlenom", () => {
    const w = svc.attendanceEventsSelectWhere(ZAPOSLENI_ANA);
    expect(pogadja(PRISUSTVO[5], w)).toBe(false);
  });
});

describe("TABELA ISTINITOSTI — `makeup_requests` (mu_select, 6 redova)", () => {
  const oc: Array<[string, KadrScope, number]> = [
    ["admin", ADMIN, 6],
    ["kadrovska referent (hr)", HR, 6],
    ["rukovodilac (menadzment)", RUKOVODILAC, 6],
    ["tim lider (nije u can_manage_vacreq)", TIM_LIDER, 0],
    ["običan zaposleni (Ana)", ZAPOSLENI_ANA, 1],
    ["zaposleni BEZ tima (Era)", ZAPOSLENI_BEZ_TIMA, 0],
    // 🔴 `mu_select` NEMA `<> ''` guard — prazan mejl hvata prazan `submitted_by`.
    ["🔴 nalog bez mejla (zatečena rupa)", BEZ_MEJLA, 1],
  ];
  it.each(oc)("%s -> TAČNO %i zahteva", (_ime, s, ocekivano) => {
    expect(broj(NADOKNADE, svc.makeupRequestsSelectWhere(s))).toBe(ocekivano);
  });
});

describe("TABELA ISTINITOSTI — potvrde i onboarding (`rev_current_employee_id`)", () => {
  it("HR vidi sve 3 potvrde; Ana TAČNO 1; bivši zaposleni TAČNO 0", () => {
    expect(broj(POTVRDE, svc.documentAckSelectWhere(HR))).toBe(3);
    expect(broj(POTVRDE, svc.documentAckSelectWhere(ZAPOSLENI_ANA))).toBe(1);
    // 🔴 `is_active IS TRUE` u `rev_current_employee_id()` — bivši ne vidi ni svoju.
    expect(broj(POTVRDE, svc.documentAckSelectWhere(BIVSI_ZAPOSLENI))).toBe(0);
  });

  it("onboarding zadaci: scope ide kroz RODITELJA (`run.employee_id`)", () => {
    expect(broj(ONBOARDING_ZADACI, svc.onboardingTasksSelectWhere(HR))).toBe(3);
    expect(
      broj(ONBOARDING_ZADACI, svc.onboardingTasksSelectWhere(ZAPOSLENI_ANA)),
    ).toBe(2);
    expect(
      broj(ONBOARDING_ZADACI, svc.onboardingTasksSelectWhere(BEZ_MEJLA)),
    ).toBe(0);
  });
});

describe("TABELA ISTINITOSTI — PLATE (jedina brava je allowlist)", () => {
  const PLATE = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];

  it("🔴 nalog VAN spiska za plate vidi TAČNO 0 obračuna — i kad je `admin`", () => {
    expect(broj(PLATE, svc.salarySelectWhere(ADMIN_VAN_SPISKA_ZA_PLATE))).toBe(
      0,
    );
    expect(svc.canViewSalary(ADMIN_VAN_SPISKA_ZA_PLATE)).toBe(false);
    expect(svc.canWriteSalary(ADMIN_VAN_SPISKA_ZA_PLATE)).toBe(false);
  });

  it("nalog SA spiska vidi svih 3", () => {
    expect(broj(PLATE, svc.salarySelectWhere(NA_SPISKU_ZA_PLATE))).toBe(3);
  });

  it("🔴 spisak KO SME da vidi plate nije čitljiv NIKOME (RLS bez politika)", () => {
    expect(svc.canReadSalaryViewerAllowlist()).toBe(false);
    // Asimetrija prema druga dva allowlista, koji su `qual = true`.
    expect(svc.canReadGridEditorAllowlist()).toBe(true);
    expect(svc.canReadVacationEditorAllowlist()).toBe(true);
  });
});

describe("Gejtovi — asimetrije koje prepis po analogiji gubi", () => {
  const POSLOVNI_ADMIN = scope({
    userId: 22,
    email: "dragana.madjercic@servoteh.com",
    roles: new Set(["poslovni_admin"]),
  });
  const PM = scope({
    userId: 23,
    email: "pm@servoteh.com",
    roles: new Set(["pm"]),
  });

  it("🔴 `employees_delete` je UŽE od `employees_update` (bez poslovni_admin)", () => {
    expect(svc.canUpdateEmployee(POSLOVNI_ADMIN, null)).toBe(true);
    expect(svc.canDeleteEmployee(POSLOVNI_ADMIN)).toBe(false);
  });

  it("🔴 `mu_delete` je UŽE od `mu_update` (pm prolazi update, ne i delete)", () => {
    expect(svc.canUpdateMakeupRequest(PM)).toBe(true);
    expect(svc.canDeleteMakeupRequest(PM)).toBe(false);
  });

  it("🔴 `nop` traži i `admin` — grid-editor sa spiska ga ne sme upisati", () => {
    expect(svc.canWriteWorkHour(GRID_EDITOR, "go")).toBe(true);
    expect(svc.canWriteWorkHour(GRID_EDITOR, null)).toBe(true); // IS DISTINCT FROM
    expect(svc.canWriteWorkHour(GRID_EDITOR, "nop")).toBe(false);
    const adminEditor = scope({
      userId: 24,
      email: "nenad.jarakovic@servoteh.com",
      roles: new Set(["admin"]),
      gridEditor: true,
    });
    expect(svc.canWriteWorkHour(adminEditor, "nop")).toBe(true);
  });

  it("🔴 `admin` van grid-spiska NE SME da menja radne sate", () => {
    expect(svc.canEditKadrovskaGrid(ADMIN)).toBe(false);
    expect(svc.canWriteWorkHour(ADMIN, "go")).toBe(false);
    expect(svc.canDeleteWorkHour(ADMIN)).toBe(false);
  });

  it("🔴 `has_edit_role` odbija nalog BEZ mejla i kad nosi rolu", () => {
    const botSaAdminRolom = scope({
      userId: 25,
      email: "",
      roles: new Set(["admin"]),
    });
    expect(svc.hasEditRole(botSaAdminRolom)).toBe(false);
  });

  it("🔴 `is_vacreq_admin` je ZAKUCAN mejl, radi bez ijedne role", () => {
    const zoran = scope({ userId: 26, email: "zoran.jarakovic@servoteh.com" });
    expect(svc.isVacreqAdmin(zoran)).toBe(true);
    expect(svc.canManageVacreq(zoran)).toBe(true);
    expect(
      svc.canManageVacreq(scope({ userId: 27, email: "neko@servoteh.com" })),
    ).toBe(false);
  });

  it("⚠️ `current_user_is_hr_or_admin` UKLJUČUJE `menadzment` (ime laže)", () => {
    expect(svc.isHrOrAdmin(RUKOVODILAC)).toBe(true);
    expect(svc.isHr(RUKOVODILAC)).toBe(false);
  });

  it("zaposleni NE VIDI ni svoj lekarski pregled ni svoj sertifikat", () => {
    expect(svc.canReadMedicalExams(ZAPOSLENI_ANA)).toBe(false);
    expect(svc.canReadCertificates(ZAPOSLENI_ANA)).toBe(false);
    expect(svc.canReadCertificates(HR)).toBe(true);
  });

  it("tabele bez INSERT politike ostaju zatvorene za aplikaciju", () => {
    expect(svc.canWriteAttendanceEvent()).toBe(false);
    expect(svc.canInsertNotificationLog()).toBe(false);
    expect(svc.canInsertNotificationConfig()).toBe(false);
    expect(svc.canWriteVacationBonusDays()).toBe(false);
    expect(svc.canModifyDocumentAck()).toBe(false);
  });

  it("⚠️ ZATEČENO: bonus dane odmora SVIH vidi svaki ulogovan korisnik", () => {
    expect(svc.canReadVacationBonusDays(ZAPOSLENI_ANA)).toBe(true);
    expect(svc.canReadVacationBonusDays(prazanKadrScope(0))).toBe(false);
  });

  it("revizioni trag čita SAMO `admin` — ni HR ni menadzment", () => {
    expect(svc.canReadAuditLog(ADMIN)).toBe(true);
    expect(svc.canReadAuditLog(HR)).toBe(false);
    expect(svc.canReadAuditLog(RUKOVODILAC)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 🔴 MUTACIONE PROBE — svaka namerno pokvarena varijanta MORA da promeni ishod.
// Ako mutacija preživi, test iznad ne meri ništa.
// ═════════════════════════════════════════════════════════════════════════════

describe("MUTACIONE PROBE — dokaz da tabela istinitosti stvarno meri", () => {
  it("M1 `managesAllEmployees` čita `menadzment` iz UNIJE umesto iz `user_roles`", () => {
    // Mutacija = obrazac iz održavanja prepisan „po analogiji". Na produkciji bi
    // to podiglo broj naloga koji vide CEO kadrovski karton sa 12 na 27.
    const bezUserRolesReda = scope({
      userId: 30,
      email: "sef4@servoteh.com",
      roles: new Set(["menadzment"]), // ima rolu u uniji…
      scopedRoles: new Set(), // …ali NEMA `user_roles` red
      managedSubDepartmentIds: null,
    });
    const tacno = broj(
      [...ZAPOSLENI],
      svc.employeesSelectWhere(bezUserRolesReda),
    );
    const mutirano = bezUserRolesReda.roles.has("menadzment")
      ? ZAPOSLENI.length
      : tacno;
    expect(tacno).toBe(0);
    expect(mutirano).toBe(8);
    expect(mutirano).not.toBe(tacno);
  });

  it("M2 prazna lista `{}` tretirana kao `NULL`", () => {
    const tacno = broj(
      [...ZAPOSLENI],
      svc.employeesSelectWhere(RUKOVODILAC_PRAZNA),
    );
    const mutSc = { ...RUKOVODILAC_PRAZNA, managedSubDepartmentIds: null };
    const mutirano = broj([...ZAPOSLENI], svc.employeesSelectWhere(mutSc));
    expect(tacno).toBe(0);
    expect(mutirano).toBe(8);
  });

  it("M3 `employees_select` bez guarda `coalesce(email,'') <> ''`", () => {
    const tacno = broj([...ZAPOSLENI], svc.employeesSelectWhere(BEZ_MEJLA));
    // Mutacija: prazan mejl se pusti u `equals` -> hvata e6 i e7.
    const mutirano = broj([...ZAPOSLENI], {
      OR: [{ email: { equals: "", mode: "insensitive" } }],
    });
    expect(tacno).toBe(0);
    expect(mutirano).toBe(2);
  });

  it("M4 `NIJEDAN_RED` zamenjen sa `undefined` (najtiši mogući kvar)", () => {
    const tacno = broj([...ZAPOSLENI], svc.employeesSelectWhere(BEZ_MEJLA));
    const mutirano = broj([...ZAPOSLENI], undefined);
    expect(tacno).toBe(0);
    expect(mutirano).toBe(8);
    expect(svc.employeesSelectWhere(BEZ_MEJLA)).toEqual(NIJEDAN_RED);
  });

  it("M5 `workHoursSelectWhere` propušta `NIJEDAN_RED` kao bez-sužavanja", () => {
    const tacno = broj(SATI, svc.workHoursSelectWhere(BEZ_MEJLA));
    const mutirano = broj(SATI, { employee: NIJEDAN_RED });
    expect(tacno).toBe(0);
    // I mutirana varijanta daje 0 — zato se dodatno pinuje IDENTITET isečka:
    expect(mutirano).toBe(0);
    expect(svc.workHoursSelectWhere(BEZ_MEJLA)).toEqual(NIJEDAN_RED);
    expect(svc.workHoursSelectWhere(BEZ_MEJLA)).not.toBeUndefined();
  });

  it("M6 `attendance` bez disjunkta `is_hr_or_admin` (kvar u UŽEM smeru)", () => {
    const tacno = broj(PRISUSTVO, svc.attendanceEventsSelectWhere(RUKOVODILAC));
    // Mutacija: samo grid-editor grana -> rukovodilac pada na sub-dept scope.
    const mutirano = broj(PRISUSTVO, {
      OR: [{ employee: { subDepartmentId: { in: [1, 2] } } }],
    });
    expect(tacno).toBe(8);
    expect(mutirano).toBe(4);
  });

  it("M7 `attendance` pušta nespojene kartice (`employee_id IS NULL`)", () => {
    const tacno = broj(
      PRISUSTVO,
      svc.attendanceEventsSelectWhere(ZAPOSLENI_ANA),
    );
    const mutirano = broj(PRISUSTVO, {
      OR: [
        {
          employee: {
            email: { equals: "ana@servoteh.com", mode: "insensitive" },
          },
        },
        { employee: null },
      ],
    });
    expect(tacno).toBe(1);
    // Mutacija dohvata i a6 (nespojena kartica) -> 2 reda: Ana bi videla dolazak
    // kolege čija kartica nije mapirana na `employees`.
    expect(mutirano).toBe(2);
    expect(mutirano).not.toBe(tacno);
    expect(
      pogadja(PRISUSTVO[5], svc.attendanceEventsSelectWhere(ZAPOSLENI_ANA)),
    ).toBe(false);
  });

  it("M8 `mu_select` popravljen guardom `<> ''` (prepis PO ANALOGIJI suzi pravo)", () => {
    const tacno = broj(NADOKNADE, svc.makeupRequestsSelectWhere(BEZ_MEJLA));
    const mutirano = 0; // varijanta sa guardom kakav ima `employees_select`
    expect(tacno).toBe(1); // zatečeno ponašanje sy15 — prenosi se DOSLOVNO
    expect(mutirano).not.toBe(tacno);
  });

  it("M9 potvrde čitane preko `current_user_employee_id` (bez `is_active`)", () => {
    const tacno = broj(POTVRDE, svc.documentAckSelectWhere(BIVSI_ZAPOSLENI));
    const mutirano = broj(POTVRDE, { employeeId: BIVSI_ZAPOSLENI.employeeId });
    expect(tacno).toBe(0);
    expect(mutirano).toBe(1);
  });

  it("M10 onboarding zadaci filtrirani po zadatku umesto po `run`", () => {
    const tacno = broj(
      ONBOARDING_ZADACI,
      svc.onboardingTasksSelectWhere(ZAPOSLENI_ANA),
    );
    const mutirano = broj(ONBOARDING_ZADACI, undefined); // nema po čemu -> svi
    expect(tacno).toBe(2);
    expect(mutirano).toBe(3);
  });

  it("M11 `canViewSalary` dopunjen sa `|| isAdmin` (najskuplja moguća greška)", () => {
    const tacno = svc.canViewSalary(ADMIN_VAN_SPISKA_ZA_PLATE);
    const mutirano = svc.canViewSalary(ADMIN) || svc.isAdmin(ADMIN);
    expect(tacno).toBe(false);
    expect(mutirano).toBe(true);
  });

  it("M12 `canReadSalaryViewerAllowlist` prepisan po analogiji (`true`)", () => {
    expect(svc.canReadSalaryViewerAllowlist()).toBe(false);
    expect(svc.canReadGridEditorAllowlist()).not.toBe(
      svc.canReadSalaryViewerAllowlist(),
    );
  });

  it("M13 `canWriteWorkHour` bez `nop`/`admin` klauzule", () => {
    const tacno = svc.canWriteWorkHour(GRID_EDITOR, "nop");
    const mutirano = svc.canEditKadrovskaGrid(GRID_EDITOR);
    expect(tacno).toBe(false);
    expect(mutirano).toBe(true);
  });

  it("M14 `canDeleteEmployee` prepisan kao `canUpdateEmployee`", () => {
    const poslovni = scope({
      userId: 28,
      email: "pa@servoteh.com",
      roles: new Set(["poslovni_admin"]),
    });
    expect(svc.canDeleteEmployee(poslovni)).toBe(false);
    expect(svc.canUpdateEmployee(poslovni, null)).toBe(true);
  });

  it("M15 `hasEditRole` bez brane za prazan mejl", () => {
    const bot = scope({ userId: 29, email: "", roles: new Set(["hr"]) });
    const tacno = svc.hasEditRole(bot);
    const mutirano = [
      "admin",
      "hr",
      "menadzment",
      "pm",
      "leadpm",
      "poslovni_admin",
    ].some((r) => bot.roles.has(r));
    expect(tacno).toBe(false);
    expect(mutirano).toBe(true);
  });

  it("M16 `isVacreqAdmin` bez zakucanog mejla", () => {
    const zoran = scope({ userId: 31, email: "zoran.jarakovic@servoteh.com" });
    expect(svc.canManageVacreq(zoran)).toBe(true);
    // Mutacija: samo role grana -> Zoran (bez ijedne role) gubi pravo.
    const mutirano = [
      "admin",
      "hr",
      "menadzment",
      "leadpm",
      "pm",
      "poslovni_admin",
    ].some((r) => zoran.roles.has(r));
    expect(mutirano).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// `loadScope` — jedini deo koji dodiruje bazu. Ovde se pinuju TRI pravila koja
// se ne vide iz čistih predikata: gašenje rola deaktiviranog naloga, očuvanje
// razlike `NULL` vs `[]`, i default-deny dok kadrovskih tabela još nema.
// ═════════════════════════════════════════════════════════════════════════════

describe("loadScope — čitanje snimka iz baze", () => {
  type RawOdgovor = unknown[];

  function prismaMock(opts: {
    active: boolean;
    role: string | null;
    extraRoles: string[];
    lista: number[] | null | undefined;
    tabelePostoje?: boolean;
    brave?: {
      emp_id: string | null;
      emp_id_aktivan: string | null;
      grid: boolean;
      salary: boolean;
      vacation: boolean;
    };
  }) {
    const odgovori: RawOdgovor[] = [
      // 1. lista podsektora (sirov SQL — jedini način da NULL preživi)
      opts.lista === undefined
        ? []
        : [{ managed_sub_department_ids: opts.lista }],
      // 2. `to_regclass` proba
      [{ ima: opts.tabelePostoje ?? false }],
    ];
    if (opts.tabelePostoje && opts.brave) odgovori.push([opts.brave]);
    let poziv = 0;
    return {
      user: {
        findUnique: () =>
          Promise.resolve({
            email: "korisnik@servoteh.com",
            role: opts.role,
            active: opts.active,
          }),
      },
      userRole: {
        findMany: () =>
          Promise.resolve(opts.extraRoles.map((role) => ({ role }))),
      },
      // Odgovori se vraćaju po REDU poziva: 1) lista podsektora,
      // 2) `to_regclass` proba, 3) allowlist brave (ako tabele postoje).
      $queryRaw: () => Promise.resolve(odgovori[poziv++] ?? []),
    } as unknown as PrismaService;
  }

  it("🔴 deaktiviran nalog ne nosi NIJEDNU rolu — ni primarnu ni iz `user_roles`", async () => {
    const s = await new KadrovskaAuthzService(
      prismaMock({
        active: false,
        role: "admin",
        extraRoles: ["menadzment"],
        lista: null,
      }),
    ).loadScope(1);
    expect([...s.roles]).toEqual([]);
    expect([...s.scopedRoles]).toEqual([]);
    // Bez rola i bez liste -> ne vidi nijednog zaposlenog.
    expect(broj([...ZAPOSLENI], svc.employeesSelectWhere(s))).toBe(0);
  });

  it("aktivan nalog dobija UNIJU `users.role` + `user_roles.role`", async () => {
    const s = await new KadrovskaAuthzService(
      prismaMock({
        active: true,
        role: "menadzment",
        extraRoles: ["tim_lider"],
        lista: [2],
      }),
    ).loadScope(1);
    expect([...s.roles].sort()).toEqual(["menadzment", "tim_lider"]);
    expect([...s.scopedRoles]).toEqual(["tim_lider"]);
    expect(s.managedSubDepartmentIds).toEqual([2]);
  });

  it("🔴 `scopedRoles` NE sadrži `users.role` — inače unija širi prava (odstupanje #2)", async () => {
    const s = await new KadrovskaAuthzService(
      prismaMock({
        active: true,
        role: "menadzment", // primarna rola, BEZ `user_roles` reda
        extraRoles: [],
        lista: undefined, // nema reda -> lista je NULL
      }),
    ).loadScope(1);
    expect(s.roles.has("menadzment")).toBe(true);
    expect(s.scopedRoles.has("menadzment")).toBe(false);
    expect(s.managedSubDepartmentIds).toBeNull();
    // Ključ: NE prolazi kroz granu „menadzment bez liste vidi sve".
    expect(svc.managesAllEmployees(s)).toBe(false);
    expect(broj([...ZAPOSLENI], svc.employeesSelectWhere(s))).toBe(0);
  });

  it("🔴 razlika `NULL` vs `[]` preživi čitanje (Prisma je ne bi sačuvala)", async () => {
    const sNull = await new KadrovskaAuthzService(
      prismaMock({
        active: true,
        role: "viewer",
        extraRoles: ["menadzment"],
        lista: null,
      }),
    ).loadScope(1);
    const sPrazna = await new KadrovskaAuthzService(
      prismaMock({
        active: true,
        role: "viewer",
        extraRoles: ["menadzment"],
        lista: [],
      }),
    ).loadScope(1);
    expect(sNull.managedSubDepartmentIds).toBeNull();
    expect(sPrazna.managedSubDepartmentIds).toEqual([]);
    // Ista rola, ista tabela — SUPROTAN ishod. To je ceo smisao sirovog SQL-a.
    expect(broj([...ZAPOSLENI], svc.employeesSelectWhere(sNull))).toBe(8);
    expect(broj([...ZAPOSLENI], svc.employeesSelectWhere(sPrazna))).toBe(0);
  });

  it("dok kadrovskih tabela nema, allowlist brave su default-deny (nikad `true`)", async () => {
    const s = await new KadrovskaAuthzService(
      prismaMock({
        active: true,
        role: "admin",
        extraRoles: [],
        lista: null,
        tabelePostoje: false,
      }),
    ).loadScope(1);
    expect(s.gridEditor).toBe(false);
    expect(s.salaryViewer).toBe(false);
    expect(s.vacationEditor).toBe(false);
    expect(s.activeEmployeeId).toBeNull();
    // Admin bez spiska: ne menja grid i ne vidi plate.
    expect(svc.canEditKadrovskaGrid(s)).toBe(false);
    expect(svc.canViewSalary(s)).toBe(false);
  });

  it("kad tabele postoje, brave i mapiranje mejl→zaposleni se učitavaju", async () => {
    const s = await new KadrovskaAuthzService(
      prismaMock({
        active: true,
        role: "hr",
        extraRoles: [],
        lista: null,
        tabelePostoje: true,
        brave: {
          emp_id: "e1",
          emp_id_aktivan: null, // ima red, ali `is_active = false`
          grid: true,
          salary: false,
          vacation: true,
        },
      }),
    ).loadScope(1);
    expect(s.gridEditor).toBe(true);
    expect(s.vacationEditor).toBe(true);
    expect(s.salaryViewer).toBe(false);
    // 🔴 Dve mape su ODVOJENE: `employeeId` postoji, `activeEmployeeId` ne.
    expect(s.employeeId).toBe("e1");
    expect(s.activeEmployeeId).toBeNull();
  });
});
