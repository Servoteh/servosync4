import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NotFoundException } from "@nestjs/common";
import { OdrzavanjeService } from "./odrzavanje.service";
import { OdrzavanjeAuthzService } from "./odrzavanje-authz.service";
import { OdrzavanjeFnService } from "./odrzavanje-fn.service";
import { OdrzavanjeSourceService } from "../../common/sy15/odrzavanje-source.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import type { MasinaOtpisNotifyService } from "./masina-otpis-notify.service";

/**
 * ČITANJA ODRŽAVANJA POD `ODRZAVANJE_IZVOR=3.0` — §7.1 (read sloj) + §7.4 (view-ovi).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 🔴 ŠTA OVAJ FAJL ČUVA I ZAŠTO POSTOJI OVAKAV (a ne prostiji)
 * ══════════════════════════════════════════════════════════════════════════════
 * U sy15 row-scope sprovodi 102 RLS politike, a svih 15 `v_maint_*` view-ova ima
 * `security_invoker = true` — dakle RLS pozivaoca se primenjivao I KROZ VIEW. U
 * 3.0 RLS-a nema. Ako se scope negde izostavi, upit i dalje RADI: ruta vrati 200,
 * ekran se otvori, ništa ne pukne — samo ima VIŠE redova nego što sme. Operater
 * vidi tuđe mašine, vozač tuđe lične podatke (JMBG, adresa).
 *
 * Test koji proverava „ima li podataka“ takav kvar NE HVATA — on i dalje prolazi,
 * čak lakše. Hvata ga ISKLJUČIVO test koji BROJI redove za USKU rolu. Zato ovde
 * nema nijednog `toBeGreaterThan(0)`: svako očekivanje je TAČAN BROJ, i za svaku
 * rutu se meri cela tabela istinitosti po rolama.
 *
 * Zato i baza nije `jest.fn()` koji vraća fiksnu listu (takav mock ne bi ni video
 * `where`), nego minimalni izvršilac Prisma `where` izraza nad fiksnim skupom
 * redova: `AND`/`OR`, `in`/`notIn`/`not`, i JEDNOSTAVNE relacije. Broj koji test
 * poredi je stvarni rezultat filtera koji je servis sastavio.
 *
 * View-ovi se ne mogu izvršiti (nema Postgresa), pa se za njih pinuje TEKST
 * upita: da li je scope fragment stvarno ušao u `WHERE`.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Minimalni izvršilac Prisma `where` izraza
// ═══════════════════════════════════════════════════════════════════════════════

type Red = Record<string, unknown>;
type Tabele = Record<string, Red[]>;

/** Relacije koje read-scope izrazi stvarno koriste (1 nivo dubine, po FK-u). */
const RELACIJE: Record<
  string,
  Record<string, { tabela: string; kljuc: string; strani: string }>
> = {
  maintAsset: {
    machine: { tabela: "maintMachine", kljuc: "assetId", strani: "assetId" },
  },
  maintWorkOrder: {
    asset: { tabela: "maintAsset", kljuc: "assetId", strani: "assetId" },
  },
  maintIncident: {
    asset: { tabela: "maintAsset", kljuc: "assetId", strani: "assetId" },
  },
  maintIncidentEvent: {
    incident: { tabela: "maintIncident", kljuc: "incidentId", strani: "id" },
  },
  maintWoEvent: {
    workOrder: { tabela: "maintWorkOrder", kljuc: "woId", strani: "woId" },
  },
  maintWoPart: {
    workOrder: { tabela: "maintWorkOrder", kljuc: "woId", strani: "woId" },
  },
  maintWoLabor: {
    workOrder: { tabela: "maintWorkOrder", kljuc: "woId", strani: "woId" },
  },
  maintDocument: {
    asset: { tabela: "maintAsset", kljuc: "assetId", strani: "assetId" },
    workOrder: { tabela: "maintWorkOrder", kljuc: "woId", strani: "woId" },
    incident: { tabela: "maintIncident", kljuc: "incidentId", strani: "id" },
    preventiveTask: {
      tabela: "maintTask",
      kljuc: "preventiveTaskId",
      strani: "id",
    },
    driver: { tabela: "maintDriver", kljuc: "driverId", strani: "driverId" },
  },
  // Gume vise o sredstvu — `vehicleTires` sužava kroz `assetScopedWhere`
  // (`{ asset: … }`). Bez ovog reda lažna baza ne ume da pređe vezu, pa bi
  // test scope-a pao na „Nepodržan operator" umesto da meri pravo.
  maintVehicleTire: {
    asset: { tabela: "maintAsset", kljuc: "assetId", strani: "assetId" },
  },
};

function poklapaOperator(v: unknown, op: Record<string, unknown>): boolean {
  for (const [k, ocek] of Object.entries(op)) {
    switch (k) {
      case "equals":
        if (v !== ocek) return false;
        break;
      case "in":
        if (!(ocek as unknown[]).includes(v)) return false;
        break;
      case "notIn":
        if ((ocek as unknown[]).includes(v)) return false;
        break;
      case "not":
        if (ocek === null) {
          if (v === null || v === undefined) return false;
        } else if (v === ocek) return false;
        break;
      case "gte":
        if (!(Number(v) >= Number(ocek))) return false;
        break;
      case "gt":
        if (!(Number(v) > Number(ocek))) return false;
        break;
      case "lt":
        if (!(Number(v) < Number(ocek))) return false;
        break;
      case "lte":
        if (!(Number(v) <= Number(ocek))) return false;
        break;
      case "contains": {
        const tekst = typeof v === "string" ? v : "";
        if (!tekst.toLowerCase().includes(String(ocek).toLowerCase()))
          return false;
        break;
      }
      case "mode":
        break; // `insensitive` je već primenjeno u `contains`
      default:
        throw new Error(`Nepodržan operator u testu: ${k}`);
    }
  }
  return true;
}

function pogadja(
  tabela: string,
  red: Red,
  where: unknown,
  baza: Tabele,
): boolean {
  if (!where || typeof where !== "object") return true;
  for (const [kljuc, vred] of Object.entries(where as Red)) {
    if (vred === undefined) continue;
    if (kljuc === "AND") {
      const lista = Array.isArray(vred) ? vred : [vred];
      if (!lista.every((w) => pogadja(tabela, red, w, baza))) return false;
      continue;
    }
    if (kljuc === "OR") {
      const lista = vred as unknown[];
      if (!lista.some((w) => pogadja(tabela, red, w, baza))) return false;
      continue;
    }
    const rel = RELACIJE[tabela]?.[kljuc];
    if (rel) {
      const fk = red[rel.kljuc];
      if (fk === null || fk === undefined) return false;
      const cilj = (baza[rel.tabela] ?? []).find((r) => r[rel.strani] === fk);
      if (!cilj) return false;
      if (!pogadja(rel.tabela, cilj, vred, baza)) return false;
      continue;
    }
    const v = red[kljuc] ?? null;
    if (vred !== null && typeof vred === "object" && !(vred instanceof Date)) {
      if (!poklapaOperator(v, vred as Record<string, unknown>)) return false;
      continue;
    }
    if (v !== (vred ?? null)) return false;
  }
  return true;
}

interface ZabelezenUpit {
  sql: string;
  values: unknown[];
}

function sqlTekst(q: unknown): string {
  const o = q as { sql?: string; strings?: string[] };
  if (typeof q === "string") return q;
  if (typeof o?.sql === "string") return o.sql;
  if (Array.isArray(o?.strings)) return o.strings.join(" ? ");
  return String(q);
}

/**
 * Lažni 3.0 Prisma klijent: tabele su obični nizovi, `where` se STVARNO izvršava,
 * a `$queryRaw` (view-ovi) se beleži i vraća unapred pripremljene redove.
 */
function napraviDb(baza: Tabele, viewRedovi: Record<string, unknown[]> = {}) {
  const upiti: ZabelezenUpit[] = [];
  const filtriraj = (tabela: string, arg: { where?: unknown } = {}) =>
    (baza[tabela] ?? []).filter((r) => pogadja(tabela, r, arg.where, baza));
  const delegat = (tabela: string) => ({
    findMany: (a: { where?: unknown; skip?: number; take?: number } = {}) => {
      const svi = filtriraj(tabela, a);
      const od = a.skip ?? 0;
      return Promise.resolve(
        a.take != null ? svi.slice(od, od + a.take) : svi.slice(od),
      );
    },
    findFirst: (a = {}) => Promise.resolve(filtriraj(tabela, a)[0] ?? null),
    findUnique: (a = {}) => Promise.resolve(filtriraj(tabela, a)[0] ?? null),
    count: (a = {}) => Promise.resolve(filtriraj(tabela, a).length),
    groupBy: (a: { by: string[]; where?: unknown }) => {
      const grupe = new Map<string, number>();
      for (const r of filtriraj(tabela, a)) {
        const k = String(r[a.by[0]]);
        grupe.set(k, (grupe.get(k) ?? 0) + 1);
      }
      return Promise.resolve(
        [...grupe].map(([k, n]) => ({ [a.by[0]]: k, _count: { _all: n } })),
      );
    },
  });
  const klijent = new Proxy(
    {},
    {
      get(_c, prop: string) {
        if (prop === "$queryRaw") {
          return (q: unknown) => {
            const sql = sqlTekst(q);
            upiti.push({
              sql,
              values: (q as { values?: unknown[] }).values ?? [],
            });
            const pogodak = Object.entries(viewRedovi).find(([v]) =>
              sql.includes(v),
            );
            return Promise.resolve(pogodak ? pogodak[1] : []);
          };
        }
        if (prop === "then") return undefined;
        return delegat(prop);
      },
    },
  ) as unknown as PrismaService;
  return { klijent, upiti };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Fiksni skup podataka (mali, ali pokriva svaku granu politika)
// ═══════════════════════════════════════════════════════════════════════════════

const SADA = new Date("2026-08-07T10:00:00Z");

/** Šest naloga, po jedan za svaku rolu iz tabele istinitosti. */
const ADMIN = "admin@servoteh.com"; // users.role = admin        -> erp_admin
const MONTER = "monter@servoteh.com"; // users.role = monter       -> floor_read (NIJE admin)
const TEHNICAR = "tehnicar@servoteh.com"; // maint profil technician
const OPERATER = "operater@servoteh.com"; // maint profil operator, 2 mašine
const OPERATER0 = "operater0@servoteh.com"; // maint profil operator, 0 mašina
const VOZAC = "vozac@servoteh.com"; // bez ERP role i bez maint profila
const SEF = "sef@servoteh.com"; // maint profil chief
const RUKOVODSTVO = "rukovodstvo@servoteh.com"; // maint profil management

function svezaBaza(): Tabele {
  return {
    user: [
      { id: 1, email: ADMIN, role: "admin", active: true },
      { id: 2, email: MONTER, role: "monter", active: true },
      { id: 3, email: TEHNICAR, role: "korisnik", active: true },
      { id: 99, email: OPERATER, role: "korisnik", active: true },
      { id: 98, email: OPERATER0, role: "korisnik", active: true },
      { id: 77, email: VOZAC, role: "korisnik", active: true },
      { id: 5, email: SEF, role: "korisnik", active: true },
      { id: 6, email: RUKOVODSTVO, role: "korisnik", active: true },
    ],
    userRole: [],
    maintUserProfile: [
      {
        userId: 3,
        fullName: "Tehničar",
        role: "technician",
        active: true,
        assignedMachineCodes: [],
      },
      {
        userId: 99,
        fullName: "Operater",
        role: "operator",
        active: true,
        assignedMachineCodes: ["3.12", "6.1"],
      },
      {
        userId: 98,
        fullName: "Operater Bez",
        role: "operator",
        active: true,
        assignedMachineCodes: [],
      },
      {
        userId: 5,
        fullName: "Šef",
        role: "chief",
        active: true,
        assignedMachineCodes: [],
      },
      {
        userId: 6,
        fullName: "Rukovodstvo",
        role: "management",
        active: true,
        assignedMachineCodes: [],
      },
    ],
    // 3 mašine (2 dodeljene operateru, 1 tuđa) + vozilo + IT + objekat.
    maintAsset: [
      {
        assetId: "a1",
        assetType: "machine",
        assetCode: "3.12",
        name: "Bruspod",
        archivedAt: null,
      },
      {
        assetId: "a2",
        assetType: "machine",
        assetCode: "6.1",
        name: "Presa",
        archivedAt: null,
      },
      {
        assetId: "a3",
        assetType: "machine",
        assetCode: "8.2",
        name: "Strug",
        archivedAt: null,
      },
      {
        assetId: "v1",
        assetType: "vehicle",
        assetCode: "VOZ-1",
        name: "Kombi",
        archivedAt: null,
      },
      {
        assetId: "i1",
        assetType: "it",
        assetCode: "IT-1",
        name: "Server",
        archivedAt: null,
      },
      {
        assetId: "f1",
        assetType: "facility",
        assetCode: "OBJ-1",
        name: "Hala",
        archivedAt: null,
      },
    ],
    maintMachine: [
      {
        machineCode: "3.12",
        assetId: "a1",
        name: "Bruspod",
        responsibleUserId: 99,
        archivedAt: null,
      },
      {
        machineCode: "6.1",
        assetId: "a2",
        name: "Presa",
        responsibleUserId: null,
        archivedAt: null,
      },
      {
        machineCode: "8.2",
        assetId: "a3",
        name: "Strug",
        responsibleUserId: null,
        archivedAt: null,
      },
    ],
    // w2 je „moj nalog na tuđoj mašini“ — jedina provera disjunkcije `maint_wo_row_visible`.
    maintWorkOrder: [
      {
        woId: "w1",
        assetId: "a1",
        assetType: "machine",
        status: "novi",
        type: "kvar",
        priority: "p3_manje",
        reportedBy: 99,
        assignedTo: 99,
        costTotal: null,
        createdAt: SADA,
      },
      {
        woId: "w2",
        assetId: "a3",
        assetType: "machine",
        status: "novi",
        type: "kvar",
        priority: "p3_manje",
        reportedBy: 99,
        assignedTo: null,
        costTotal: null,
        createdAt: SADA,
      },
      {
        woId: "w3",
        assetId: "a3",
        assetType: "machine",
        status: "novi",
        type: "kvar",
        priority: "p3_manje",
        reportedBy: 1,
        assignedTo: 1,
        costTotal: null,
        createdAt: SADA,
      },
      {
        woId: "w4",
        assetId: "v1",
        assetType: "vehicle",
        status: "novi",
        type: "servis",
        priority: "p3_manje",
        reportedBy: 1,
        assignedTo: 1,
        costTotal: null,
        createdAt: SADA,
      },
    ],
    maintWoEvent: [
      { id: "e-w1", woId: "w1", at: SADA, eventType: "created" },
      { id: "e-w3", woId: "w3", at: SADA, eventType: "created" },
    ],
    maintWoPart: [
      {
        id: "p-w1",
        woId: "w1",
        partId: "p1",
        quantity: 2,
        unitCost: 100,
        partName: "Ležaj",
      },
      {
        id: "p-w3",
        woId: "w3",
        partId: "p1",
        quantity: 5,
        unitCost: 100,
        partName: "Ležaj",
      },
    ],
    maintWoLabor: [
      { id: "l-w1", woId: "w1", minutes: 30, createdAt: SADA },
      { id: "l-w3", woId: "w3", minutes: 60, createdAt: SADA },
    ],
    // n4 nema sredstvo -> ide granom `machine_code` (druga grana `maint_incident_row_visible`).
    maintIncident: [
      {
        id: "n1",
        machineCode: "3.12",
        assetId: "a1",
        status: "open",
        severity: "major",
        reportedAt: SADA,
        downtimeMinutes: 10,
        workOrderId: "w1",
      },
      {
        id: "n2",
        machineCode: "8.2",
        assetId: "a3",
        status: "open",
        severity: "minor",
        reportedAt: SADA,
        downtimeMinutes: null,
        workOrderId: null,
      },
      {
        id: "n3",
        machineCode: "VOZ-1",
        assetId: "v1",
        status: "open",
        severity: "minor",
        reportedAt: SADA,
        downtimeMinutes: null,
        workOrderId: null,
      },
      {
        id: "n4",
        machineCode: "6.1",
        assetId: null,
        status: "open",
        severity: "minor",
        reportedAt: SADA,
        downtimeMinutes: null,
        workOrderId: null,
      },
    ],
    maintIncidentEvent: [
      { id: "ev1", incidentId: "n1", at: SADA, eventType: "created" },
      { id: "ev3", incidentId: "n3", at: SADA, eventType: "created" },
    ],
    maintDriver: [
      {
        driverId: "d1",
        authUserId: 77,
        fullName: "Vozač Jedan",
        jmbg: "0101990710011",
        active: true,
      },
      {
        driverId: "d2",
        authUserId: 1,
        fullName: "Vozač Dva",
        jmbg: "0202980710022",
        active: true,
      },
    ],
    // Po jedan dokument za svaku granu kaskade `maint_document_visible`.
    maintDocument: [
      {
        documentId: "doc1",
        entityType: "asset",
        entityId: "a1",
        assetId: "a1",
        woId: null,
        incidentId: null,
        preventiveTaskId: null,
        driverId: null,
        deletedAt: null,
        sizeBytes: null,
        uploadedAt: SADA,
      },
      {
        documentId: "doc2",
        entityType: "work_order",
        entityId: "w3",
        assetId: null,
        woId: "w3",
        incidentId: null,
        preventiveTaskId: null,
        driverId: null,
        deletedAt: null,
        sizeBytes: null,
        uploadedAt: SADA,
      },
      {
        documentId: "doc3",
        entityType: "incident",
        entityId: "n3",
        assetId: null,
        woId: null,
        incidentId: "n3",
        preventiveTaskId: null,
        driverId: null,
        deletedAt: null,
        sizeBytes: null,
        uploadedAt: SADA,
      },
      {
        documentId: "doc4",
        entityType: "preventive_task",
        entityId: "t1",
        assetId: null,
        woId: null,
        incidentId: null,
        preventiveTaskId: "t1",
        driverId: null,
        deletedAt: null,
        sizeBytes: null,
        uploadedAt: SADA,
      },
      {
        documentId: "doc5",
        entityType: "driver",
        entityId: "d2",
        assetId: null,
        woId: null,
        incidentId: null,
        preventiveTaskId: null,
        driverId: "d2",
        deletedAt: null,
        sizeBytes: null,
        uploadedAt: SADA,
      },
    ],
    maintTask: [
      { id: "t1", machineCode: "3.12", title: "Podmazivanje", active: true },
      { id: "t2", machineCode: "8.2", title: "Zamena filtera", active: true },
    ],
    maintCheck: [
      {
        id: "c1",
        taskId: "t1",
        machineCode: "3.12",
        performedAt: SADA,
        result: "ok",
      },
      {
        id: "c2",
        taskId: "t2",
        machineCode: "8.2",
        performedAt: SADA,
        result: "ok",
      },
    ],
    // ⚠️ `deletedAt` na napomeni je DEO POLITIKE, ne upita — zato obrisana napomena
    // stoji baš na mašini koju operater VIDI (inače bi test prošao slučajno).
    maintMachineNote: [
      {
        id: "b1",
        machineCode: "3.12",
        author: 99,
        content: "živa",
        pinned: false,
        deletedAt: null,
        createdAt: SADA,
      },
      {
        id: "b2",
        machineCode: "3.12",
        author: 99,
        content: "obrisana",
        pinned: false,
        deletedAt: SADA,
        createdAt: SADA,
      },
      {
        id: "b3",
        machineCode: "8.2",
        author: 1,
        content: "tuđa",
        pinned: false,
        deletedAt: null,
        createdAt: SADA,
      },
    ],
    maintMachineFile: [
      {
        id: "f-1",
        machineCode: "3.12",
        fileName: "sema.pdf",
        deletedAt: null,
        sizeBytes: null,
        uploadedAt: SADA,
      },
      {
        id: "f-2",
        machineCode: "8.2",
        fileName: "tudja.pdf",
        deletedAt: null,
        sizeBytes: null,
        uploadedAt: SADA,
      },
    ],
    maintMachineStatusOverride: [
      {
        machineCode: "3.12",
        status: "maintenance",
        reason: "servis",
        setBy: 1,
        validUntil: null,
      },
    ],
    maintMachineDeletionLog: [
      {
        id: "dl1",
        machineCode: "9.9",
        machineName: "Stara",
        reason: "otpis",
        deletedAt: SADA,
      },
    ],
    maintPart: [
      {
        partId: "p1",
        partCode: "D-1",
        name: "Ležaj",
        active: true,
        currentStock: 1,
        minStock: 5,
        unitCost: 100,
      },
      {
        partId: "p2",
        partCode: "D-2",
        name: "Filter",
        active: true,
        currentStock: 9,
        minStock: 5,
        unitCost: 50,
      },
    ],
    maintPartStockMovement: [
      {
        movementId: "m1",
        partId: "p1",
        movementType: "in",
        quantity: 3,
        createdAt: SADA,
      },
    ],
    maintSupplier: [{ supplierId: "s1", name: "Dobavljač", active: true }],
    maintLocation: [
      {
        locationId: "l1",
        name: "Hala A",
        locationType: "lokacija",
        active: true,
      },
    ],
    maintVehicleTire: [
      {
        tireSetId: "g1",
        assetId: "v1",
        season: "summer",
        dimension: "205/55",
        count: 4,
        createdAt: SADA,
      },
    ],
    maintVehicleOwner: [
      { ownerId: "o1", name: "Servoteh", ownerType: "firma", active: true },
    ],
    maintVehicleDetails: [{ assetId: "v1", ownerId: "o1", odometerKm: 1000 }],
    maintItAssetDetails: [{ assetId: "i1", deviceType: "server" }],
    maintFacilityDetails: [{ assetId: "f1", facilityType: "hala" }],
    maintAssetServicePlan: [
      {
        planId: "sp1",
        assetId: "i1",
        name: "Servis",
        intervalMonths: 12,
        active: true,
        createdAt: SADA,
      },
    ],
    maintSettings: [{ id: 1, defaultWoPriority: "p4_planirano" }],
    maintNotificationRule: [
      {
        ruleId: "r1",
        eventType: "incident",
        channel: "in_app",
        enabled: true,
        createdAt: SADA,
      },
    ],
    maintNotificationLog: [
      {
        id: "no1",
        channel: "in_app",
        recipient: "x",
        body: "b",
        status: "queued",
        machineCode: "3.12",
        relatedEntityId: "n1",
        createdAt: SADA,
      },
      {
        id: "no2",
        channel: "in_app",
        recipient: "y",
        body: "b",
        status: "sent",
        machineCode: "8.2",
        relatedEntityId: "n2",
        createdAt: SADA,
      },
    ],
  };
}

const storageStub = {} as unknown as Sy15StorageService;

/**
 * Servis pod `ODRZAVANJE_IZVOR=3.0`, sa STVARNIM `OdrzavanjeAuthzService` i
 * `OdrzavanjeFnService` (ne mock-ovima — prava se moraju meriti kroz isti sloj
 * koji radi na produkciji) i lažnom 3.0 bazom.
 *
 * sy15 klijent je zamka: svaki poziv puca. Ako neka putanja pod `3.0` ipak
 * odluta u sy15, test pada glasno umesto da tiho čita pogrešnu bazu.
 */
function napraviServis(viewRedovi: Record<string, unknown[]> = {}) {
  const baza = svezaBaza();
  const { klijent, upiti } = napraviDb(baza, viewRedovi);
  const authz = new OdrzavanjeAuthzService(klijent);
  const fn = new OdrzavanjeFnService(klijent, authz);
  const sy15 = {
    withUserRls: () => {
      throw new Error("🔴 pod `3.0` se sy15 NE SME dodirnuti");
    },
    runIdempotentRls: () => {
      throw new Error("🔴 pod `3.0` se sy15 NE SME dodirnuti");
    },
  } as unknown as Sy15Service;
  const svc = new OdrzavanjeService(
    sy15,
    storageStub,
    { notifyOtpis: jest.fn() } as unknown as MasinaOtpisNotifyService,
    undefined,
    undefined,
    klijent,
    new OdrzavanjeSourceService(),
    undefined,
    authz,
    fn,
  );
  return { svc, upiti, baza };
}

const staro = process.env.ODRZAVANJE_IZVOR;
beforeEach(() => {
  process.env.ODRZAVANJE_IZVOR = "3.0";
});
afterEach(() => {
  if (staro === undefined) delete process.env.ODRZAVANJE_IZVOR;
  else process.env.ODRZAVANJE_IZVOR = staro;
});

/** Skraćenica: broj redova u `data` za dati nalog. */
async function broj(
  poziv: (email: string) => Promise<{ data: unknown }>,
  email: string,
): Promise<number> {
  const out = await poziv(email);
  return (out.data as unknown[]).length;
}

// ═══════════════════════════════════════════════════════════════════════════════
// (a) TABELA ISTINITOSTI PO ROLI — tačan broj redova, nikad „> 0“
// ═══════════════════════════════════════════════════════════════════════════════

describe("(a) Sredstva i mašine — `maint_asset_visible` / `maint_machine_visible`", () => {
  it.each([
    [ADMIN, 6],
    [MONTER, 6],
    // 🔴 Tehničar: SVE mašine, NIJEDNO vozilo/IT/objekat (grana `M ∧ ¬N`).
    [TEHNICAR, 3],
    [OPERATER, 2],
    // 🔴 Operater bez dodeljenih mašina dobija 0, ne sve (`cardinality(...) > 0`).
    [OPERATER0, 0],
    [VOZAC, 0],
  ])("listAssets(%s) = %i sredstava", async (email, ocekivano) => {
    const { svc } = napraviServis();
    expect(await broj((e) => svc.listAssets(e), email)).toBe(ocekivano);
  });

  it.each([
    [ADMIN, 3],
    [MONTER, 3],
    [TEHNICAR, 3],
    [OPERATER, 2],
    [OPERATER0, 0],
    [VOZAC, 0],
  ])("listMachines(%s) = %i mašina", async (email, ocekivano) => {
    const { svc } = napraviServis();
    const out = await svc.listMachines(email, {});
    expect(out.data).toHaveLength(ocekivano);
    expect(out.meta.pagination.total).toBe(ocekivano);
  });

  it("🔴 operater NE otvara karticu tuđe mašine (ista 404 poruka kao za nepostojeću)", async () => {
    const { svc } = napraviServis();
    await expect(svc.findMachine(OPERATER, "8.2")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.findMachine(OPERATER, "3.12")).resolves.toMatchObject({
      data: { machineCode: "3.12" },
    });
  });

  it("🔴 override tuđe mašine je `null`, ne red (RLS je vraćao nula redova)", async () => {
    const { svc } = napraviServis();
    expect(
      (await svc.machineStatusOverride(OPERATER, "3.12")).data,
    ).not.toBeNull();
    expect(
      (await svc.machineStatusOverride(OPERATER0, "3.12")).data,
    ).toBeNull();
  });

  it("🔴 napomene: soft-delete filter je DEO POLITIKE — obrisana ne iskrsava nazad", async () => {
    const { svc } = napraviServis();
    // Na mašini 3.12 su DVE napomene, jedna obrisana. Šef vidi tačno jednu.
    expect(await broj((e) => svc.machineNotes(e, "3.12"), SEF)).toBe(1);
    expect(await broj((e) => svc.machineNotes(e, "3.12"), OPERATER)).toBe(1);
    // Tuđa mašina: nula, bez obzira što napomena postoji i nije obrisana.
    expect(await broj((e) => svc.machineNotes(e, "8.2"), OPERATER)).toBe(0);
    expect(await broj((e) => svc.machineNotes(e, "8.2"), SEF)).toBe(1);
  });

  it("fajlovi/zadaci/kontrole prate isti `machine_code` scope", async () => {
    const { svc } = napraviServis();
    expect(await broj((e) => svc.machineFiles(e, "8.2"), OPERATER)).toBe(0);
    expect(await broj((e) => svc.machineFiles(e, "8.2"), TEHNICAR)).toBe(1);
    expect(await broj((e) => svc.listTasks(e), OPERATER)).toBe(1); // samo t1 (3.12)
    expect(await broj((e) => svc.listTasks(e), TEHNICAR)).toBe(2);
    expect(await broj((e) => svc.listChecks(e), OPERATER)).toBe(1);
    expect(await broj((e) => svc.listChecks(e), OPERATER0)).toBe(0);
    await expect(svc.findTask(OPERATER, "t2")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("(a) Radni nalozi — `maint_wo_row_visible` (disjunkcija „moj nalog je uvek moj“)", () => {
  it.each([
    [ADMIN, 4],
    [MONTER, 4],
    // Tehničar ne vidi nalog nad VOZILOM (w4) — sredstvo mu nije vidljivo.
    [TEHNICAR, 3],
    // 🔴 Operater vidi w1 (svoja mašina) I w2 (tuđa mašina, ali JE prijavilac).
    [OPERATER, 2],
    [OPERATER0, 0],
    [VOZAC, 0],
  ])("listWorkOrders(%s) = %i naloga", async (email, ocekivano) => {
    const { svc } = napraviServis();
    const out = await svc.listWorkOrders(email, {});
    expect(out.data).toHaveLength(ocekivano);
    expect(out.meta.pagination.total).toBe(ocekivano);
  });

  it("🔴 bez disjunkcije bi operater IZGUBIO nalog koji je sam prijavio na tuđoj mašini", async () => {
    const { svc } = napraviServis();
    const out = await svc.listWorkOrders(OPERATER, {});
    expect(out.data.map((w) => w.woId).sort()).toEqual(["w1", "w2"]);
    // …ali nalog na istoj tuđoj mašini koji je prijavio NEKO DRUGI ne vidi.
    await expect(svc.findWorkOrder(OPERATER, "w3")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("🔴 deca naloga nose scope RODITELJA (`EXISTS … maint_wo_row_visible`)", async () => {
    const { svc } = napraviServis();
    // w3 nije vidljiv operateru -> ni njegov trag, ni delovi, ni rad.
    expect(await broj((e) => svc.woEvents(e, "w3"), OPERATER)).toBe(0);
    expect(await broj((e) => svc.woParts(e, "w3"), OPERATER)).toBe(0);
    expect(await broj((e) => svc.woLabor(e, "w3"), OPERATER)).toBe(0);
    expect(await broj((e) => svc.woEvents(e, "w3"), ADMIN)).toBe(1);
    expect(await broj((e) => svc.woParts(e, "w3"), ADMIN)).toBe(1);
    expect(await broj((e) => svc.woLabor(e, "w3"), ADMIN)).toBe(1);
  });

  it("detalj naloga: sredstvo se razrešava POD SVOJIM scope-om (w2 = null sredstvo)", async () => {
    const { svc } = napraviServis();
    const out = await svc.findWorkOrder(OPERATER, "w2");
    expect(out.data.woId).toBe("w2");
    // Nalog vidi kao prijavilac, ali sredstvo (tuđa mašina 8.2) mu i dalje nije vidljivo.
    expect(out.data.asset).toBeNull();
    const admin = await svc.findWorkOrder(ADMIN, "w2");
    expect(admin.data.asset).toMatchObject({ assetCode: "8.2" });
  });

  it("`assignableUsers` ide kroz prepis DEFINER fn (aktivni operator/technician/chief/admin)", async () => {
    const { svc } = napraviServis();
    const out = await svc.assignableUsers(OPERATER);
    // 5 profila u bazi, ali `management` NIJE u spisku (rukovodstvo ne izvršava naloge).
    expect(
      (out.data as { maint_role: string }[]).map((r) => r.maint_role).sort(),
    ).toEqual(["chief", "operator", "operator", "technician"]);
  });
});

describe("(a) Incidenti — i ASIMETRIJA traga kvara", () => {
  it.each([
    [ADMIN, 4],
    [MONTER, 4],
    // Tehničar: n1+n2 (mašinska sredstva) + n4. n3 je vozilo pa otpada.
    // 🔴 n4 nema sredstvo → ide granom `machine_code`, a `maint_machine_visible`
    // za `technician` vraća TRUE BEZ gledanja dodeljenih šifara
    // (`talasF-fn-defs-2026-07-12.sql:1683`). Raniji broj (2) je bio pogrešan:
    // pinovao je sužavanje koje politika ne traži.
    [TEHNICAR, 3],
    // Operater: n1 (a1 = 3.12) + n4 (bez sredstva, machine_code 6.1).
    [OPERATER, 2],
    [OPERATER0, 0],
    [VOZAC, 0],
  ])("listIncidents(%s) = %i kvarova", async (email, ocekivano) => {
    const { svc } = napraviServis();
    const out = await svc.listIncidents(email, {});
    expect(out.data).toHaveLength(ocekivano);
    expect(out.meta.pagination.total).toBe(ocekivano);
  });

  it("operater vidi baš n1 i n4 (obe grane `maint_incident_row_visible`)", async () => {
    const { svc } = napraviServis();
    const out = await svc.listIncidents(OPERATER, {});
    expect(out.data.map((i) => i.id).sort()).toEqual(["n1", "n4"]);
  });

  it("🔴 tehničar VIDI kvar bez sredstva na mašini koja mu NIJE dodeljena (n4)", async () => {
    // Regresija: grana `asset_id IS NULL` je ranije išla kroz `assignedMachineCodes`,
    // pa je tehničar (bez dodeljenih šifara) dobijao `in: []` i gubio SVAKI takav
    // kvar. Politika `maint_machine_visible` za `technician` ne gleda dodele.
    const { svc } = napraviServis();
    const out = await svc.listIncidents(TEHNICAR, {});
    expect(out.data.map((i) => i.id).sort()).toEqual(["n1", "n2", "n4"]);
    // n3 je vozilo — asimetrija `assetListWhere` ostaje netaknuta.
    expect(out.data.map((i) => i.id)).not.toContain("n3");
  });

  it("🔴 operater bez dodeljenih mašina NE vidi kvar bez sredstva (prazan `in` = nula redova)", async () => {
    // Druga strana iste grane: za operatera sužavanje OSTAJE, i prazan `in: []`
    // mora ostati prazan — pretvaranje u `undefined` značilo bi „vidi sve".
    const { svc } = napraviServis();
    const out = await svc.listIncidents(OPERATER0, {});
    expect(out.data).toHaveLength(0);
  });

  it("🔴 ASIMETRIJA: trag kvara gleda `maint_machine_visible`, NE `maint_incident_row_visible`", async () => {
    const { svc } = napraviServis();
    // Tehničar NE vidi incident n3 (vozilo)…
    const inc = await svc.listIncidents(TEHNICAR, {});
    expect(inc.data.map((i) => i.id)).not.toContain("n3");
    // …ali VIDI njegov trag, jer politika `maint_incident_events` traži samo da
    // pozivalac vidi sve mašine. Prepis „po analogiji“ bi ovo SUZIO i time
    // promenio zatečeno ponašanje — zato je preneto doslovno.
    expect(await broj((e) => svc.incidentEvents(e, "n3"), TEHNICAR)).toBe(1);
    // Operater ne vidi ni jedno ni drugo (machine_code 'VOZ-1' nije njegov).
    expect(await broj((e) => svc.incidentEvents(e, "n3"), OPERATER)).toBe(0);
    expect(await broj((e) => svc.incidentEvents(e, "n1"), OPERATER)).toBe(1);
  });
});

describe("(a) Vozači — jedina politika sa per-red granom „ja sam taj vozač“", () => {
  it.each([
    [ADMIN, 2],
    [MONTER, 2],
    [TEHNICAR, 2],
    [OPERATER, 2],
    // 🔴 Vozač bez ijedne role vidi TAČNO SVOJ karton — ni jedan više.
    [VOZAC, 1],
  ])("findDriver dostupnost za %s (%i od 2 kartona)", async (email, ocek) => {
    const { svc } = napraviServis();
    let vidljivih = 0;
    for (const id of ["d1", "d2"]) {
      try {
        await svc.findDriver(email, id);
        vidljivih += 1;
      } catch {
        /* nevidljiv */
      }
    }
    expect(vidljivih).toBe(ocek);
  });

  it("🔴 vozač NE otvara tuđi karton (JMBG/adresa) — 404, ne prazan objekat", async () => {
    const { svc } = napraviServis();
    await expect(svc.findDriver(VOZAC, "d2")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.findDriver(VOZAC, "d1")).resolves.toMatchObject({
      data: { driverId: "d1" },
    });
  });
});

describe("(a) Dokumenta — kaskada `maint_document_visible`", () => {
  it.each([
    [ADMIN, 5],
    [MONTER, 5],
    // Tehničar: doc1 (mašinsko sredstvo) + doc2 (nalog w3 nad mašinom) + doc5
    // (vozač; `canReadAllDrivers` uključuje technician). doc3 je vozilo-incident,
    // doc4 visi o zadatku mašine 3.12 koju tehničar vidi.
    [TEHNICAR, 4],
    // Operater: doc1 (svoja mašina), doc4 (zadatak nad 3.12), doc5 (vozač — operator
    // je u `canReadAllDrivers`). doc2 je nalog w3 koji ne vidi, doc3 je vozilo.
    [OPERATER, 3],
    [OPERATER0, 1],
    // Vozač bez rola: samo dokument SVOG kartona (d1) — a njega u skupu nema.
    [VOZAC, 0],
  ])("listDocuments(%s) = %i dokumenata", async (email, ocekivano) => {
    const { svc } = napraviServis();
    const out = await svc.listDocuments(email, {});
    expect(out.data).toHaveLength(ocekivano);
    expect(out.meta.pagination.total).toBe(ocekivano);
  });

  it("dokument tuđeg naloga: 404 za operatera, red za admina", async () => {
    const { svc } = napraviServis();
    await expect(svc.findDocument(OPERATER, "doc2")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.findDocument(ADMIN, "doc2")).resolves.toMatchObject({
      data: { documentId: "doc2" },
    });
  });
});

describe("(a) Ravne kapije čitanja — RLS je vraćao NULA REDOVA, ne 403", () => {
  it("magacin (`canReadStock`): operater NE vidi delove, tehničar vidi", async () => {
    const { svc } = napraviServis();
    const op = (await svc.listParts(OPERATER, {})) as {
      data: unknown[];
      meta: { pagination: { total: number } };
    };
    expect(op.data).toHaveLength(0);
    // Ne samo prazna strana — i `total` mora biti 0, inače bi paginacija
    // odavala KOLIKO delova postoji onome ko nijedan ne sme da vidi.
    expect(op.meta.pagination.total).toBe(0);
    const teh = await svc.listParts(TEHNICAR, {});
    expect(teh.data).toHaveLength(2);
    // Kartica dela i kretanja zaliha prate isti krug.
    await expect(svc.findPart(OPERATER, "p1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(await broj((e) => svc.partStockMovements(e, "p1"), OPERATER)).toBe(
      0,
    );
    expect(await broj((e) => svc.partStockMovements(e, "p1"), TEHNICAR)).toBe(
      1,
    );
    expect(await broj((e) => svc.listSuppliers(e), OPERATER)).toBe(0);
    expect(await broj((e) => svc.listLocations(e), OPERATER)).toBe(0);
    expect(await broj((e) => svc.listLocations(e), ADMIN)).toBe(1);
  });

  it("🔴 outbox je UŽI od pravila: monter ne vidi nijedno, admin oba", async () => {
    const { svc } = napraviServis();
    const monter = await svc.notifications(MONTER, {});
    expect(monter.data).toHaveLength(0);
    expect(monter.meta.pagination.total).toBe(0);
    expect((await svc.notifications(ADMIN, {})).data).toHaveLength(2);
    // Pravila su ŠIRA (magacioner/erp-mgmt), ali monter ni njih nema.
    expect(await broj((e) => svc.notificationRules(e), MONTER)).toBe(0);
    expect(await broj((e) => svc.notificationRules(e), ADMIN)).toBe(1);
    expect(await broj((e) => svc.notificationRules(e), SEF)).toBe(1);
  });

  it("🔴 podešavanja: `management` ih NE vidi (zatečena nedoslednost sy15, doslovno)", async () => {
    const { svc } = napraviServis();
    expect((await svc.settings(OPERATER)).data).not.toBeNull();
    expect((await svc.settings(TEHNICAR)).data).not.toBeNull();
    expect((await svc.settings(RUKOVODSTVO)).data).toBeNull();
    expect((await svc.settings(VOZAC)).data).toBeNull();
  });

  it("trag brisanja mašina: admin vidi, monter ne", async () => {
    const { svc } = napraviServis();
    expect(await broj((e) => svc.deletionLog(e), ADMIN)).toBe(1);
    expect(await broj((e) => svc.deletionLog(e), MONTER)).toBe(0);
  });

  it("ime odgovornog: ne-admin dobija SAMO svoje (`maint_user_profiles` = self ∨ erp_admin)", async () => {
    const { svc } = napraviServis();
    const admin = await svc.listMachines(ADMIN, {});
    expect(
      admin.data.find((m) => m.machineCode === "3.12")?.responsibleName,
    ).toBe("Operater");
    // Tehničar vidi mašinu, ali NE i ime tuđeg odgovornog.
    const teh = await svc.listMachines(TEHNICAR, {});
    expect(
      teh.data.find((m) => m.machineCode === "3.12")?.responsibleName,
    ).toBeNull();
  });

  it("uvoz iz BigTehn kataloga pada GLASNO (view ne postoji u 3.0)", async () => {
    const { svc } = napraviServis();
    await expect(svc.importableMachines(ADMIN)).rejects.toThrow(
      /bigtehn_machines_cache/,
    );
  });

  it("nepoznat nalog ne dobija „prazna prava“ nego 403", async () => {
    const { svc } = napraviServis();
    await expect(svc.listMachines("niko@servoteh.com", {})).rejects.toThrow(
      /ne postoji u 3.0 bazi/,
    );
  });
});

describe("(a) Izveštaji — agregat je najtiši oblik curenja", () => {
  it("kvarovi: broj i downtime prate incident scope", async () => {
    const { svc } = napraviServis();
    const admin = await svc.reportIncidents(ADMIN, "all");
    expect(admin.data.total).toBe(4);
    expect(admin.data.downtimeMinutes).toBe(10);
    const op = await svc.reportIncidents(OPERATER, "all");
    expect(op.data.total).toBe(2);
    const op0 = await svc.reportIncidents(OPERATER0, "all");
    expect(op0.data.total).toBe(0);
    expect(op0.data.downtimeMinutes).toBe(0);
  });

  it("🔴 trošak naloga: operater vidi SAMO svoja dva naloga, ne zbir cele firme", async () => {
    const { svc } = napraviServis();
    const admin = await svc.reportWorkOrderCosts(ADMIN, "all");
    expect(admin.data.totalWorkOrders).toBe(4);
    // w1: 2 × 100 = 200, w3: 5 × 100 = 500.
    expect(admin.data.partsCost).toBe(700);
    expect(admin.data.laborMinutes).toBe(90);
    const op = await svc.reportWorkOrderCosts(OPERATER, "all");
    expect(op.data.totalWorkOrders).toBe(2);
    expect(op.data.partsCost).toBe(200);
    expect(op.data.laborMinutes).toBe(30);
    const op0 = await svc.reportWorkOrderCosts(OPERATER0, "all");
    expect(op0.data.totalWorkOrders).toBe(0);
    expect(op0.data.partsCost).toBe(0);
  });
});

describe("(a) Pregled (dashboard) — brojke su bile SUŽENE RLS-om", () => {
  it("otvoreni kvarovi/nalozi po roli", async () => {
    const { svc } = napraviServis();
    const admin = await svc.dashboard(ADMIN);
    expect(admin.data.openIncidents).toBe(4);
    expect(admin.data.openWorkOrders).toBe(4);
    const op = await svc.dashboard(OPERATER);
    expect(op.data.openIncidents).toBe(2);
    expect(op.data.openWorkOrders).toBe(2);
    const op0 = await svc.dashboard(OPERATER0);
    expect(op0.data.openIncidents).toBe(0);
    expect(op0.data.openWorkOrders).toBe(0);
  });

  it("brojevi kategorija sredstava prate `assetListWhere`", async () => {
    const { svc } = napraviServis();
    const teh = await svc.dashboard(TEHNICAR);
    expect(teh.data.categoryCounts).toEqual([{ asset_type: "machine", n: 3 }]);
    const op = await svc.dashboard(OPERATER);
    expect(op.data.categoryCounts).toEqual([{ asset_type: "machine", n: 2 }]);
    const op0 = await svc.dashboard(OPERATER0);
    expect(op0.data.categoryCounts).toEqual([]);
  });

  it("🔴 KPI kartica se NE ŠALJE onome ko ne vidi sve — `null`, ne tuđe brojke", async () => {
    const { svc, upiti } = napraviServis({
      v_maint_cmms_daily_summary: [{ active_work_orders: 4 }],
    });
    const op = await svc.dashboard(OPERATER);
    expect(op.data.dailySummary).toBeNull();
    expect(
      upiti.some((u) => u.sql.includes("v_maint_cmms_daily_summary")),
    ).toBe(false);
    const admin = await svc.dashboard(ADMIN);
    expect(admin.data.dailySummary).toEqual({ active_work_orders: 4 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (b) VIEW-OVI — scope MORA da uđe u tekst upita (`security_invoker` više ne važi)
// ═══════════════════════════════════════════════════════════════════════════════

describe("(b) 15 view-ova: scope fragment je u WHERE klauzuli", () => {
  /** Poslednji upit koji pominje dati view. */
  function upitZa(upiti: { sql: string; values: unknown[] }[], view: string) {
    const v = upiti.filter((u) => u.sql.includes(view));
    expect(v.length).toBeGreaterThan(0); // ruta MORA da čita view
    return v[v.length - 1];
  }

  it("1+2. `v_maint_machine_current_status` i `v_maint_task_due_dates` — `machine_code = ANY($codes)`", async () => {
    const { svc, upiti } = napraviServis();
    await svc.board(OPERATER);
    for (const view of [
      "v_maint_task_due_dates",
      "v_maint_machine_current_status",
    ]) {
      const u = upitZa(upiti, view);
      expect(u.sql).toMatch(/WHERE/);
      expect(u.sql).toContain("machine_code = ANY(");
      expect(u.values).toContainEqual(["3.12", "6.1"]);
    }
  });

  it("1+2. operater BEZ mašina dobija `FALSE`, ne prazan niz kroz drajver", async () => {
    const { svc, upiti } = napraviServis();
    await svc.tasksDue(OPERATER0);
    const u = upitZa(upiti, "v_maint_task_due_dates");
    expect(u.sql).toMatch(/WHERE\s+FALSE/);
  });

  it("3. `v_maint_machine_last_check` — čita se TRANZITIVNO kroz `v_maint_task_due_dates`", () => {
    // Nema sopstvene rute: `v_maint_task_due_dates` ga džoinuje, pa scope koji
    // uđe u spoljni upit važi i za njega. Da se čitao direktno, tražio bi svoj
    // `machineScopeSql` — zato je ovde zabeleženo, a ne prećutano.
    const izvor = readFileSync(
      join(__dirname, "odrzavanje.service.ts"),
      "utf8",
    );
    expect(izvor).not.toContain("v_maint_machine_last_check");
  });

  it("4. `v_maint_machines_with_responsible` — read sloj ga NE čita (ide Prisma putem)", () => {
    // Mašina + ime odgovornog se čitaju kroz `maint_machines` + `resolveProfiles30`,
    // gde scope nose `machineListWhere` i `userProfileListWhere`. Pinovano da se
    // view ne „vrati“ u kod bez svog isečka.
    const izvor = readFileSync(
      join(__dirname, "odrzavanje.service.ts"),
      "utf8",
    );
    expect(izvor).not.toContain("v_maint_machines_with_responsible");
  });

  it("5. `v_maint_documents_with_status` — read sloj ga NE čita (kaskada je u Prisma `where`)", () => {
    const izvor = readFileSync(
      join(__dirname, "odrzavanje.service.ts"),
      "utf8",
    );
    expect(izvor).not.toContain("v_maint_documents_with_status");
  });

  it("6. `v_maint_drivers_overview` — per-red `auth_user_id = ja` za vozača bez rola", async () => {
    const { svc, upiti } = napraviServis();
    await svc.listDrivers(VOZAC);
    const u = upitZa(upiti, "v_maint_drivers_overview");
    expect(u.sql).toMatch(/WHERE/);
    expect(u.sql).toContain("auth_user_id =");
    expect(u.values).toContain(77);
  });

  it("6. …a onaj ko sme sve vozače nema sužavanje (bez `WHERE`)", async () => {
    const { svc, upiti } = napraviServis();
    await svc.listDrivers(ADMIN);
    expect(upitZa(upiti, "v_maint_drivers_overview").sql).not.toMatch(/WHERE/);
  });

  it.each([
    [
      "v_maint_vehicle_overview",
      (s: OdrzavanjeService, e: string) => s.listVehicles(e),
    ],
    [
      "v_maint_it_overview",
      (s: OdrzavanjeService, e: string) => s.listItAssets(e),
    ],
    [
      "v_maint_facility_overview",
      (s: OdrzavanjeService, e: string) => s.listFacilities(e),
    ],
    [
      "v_maint_vehicle_bookings",
      (s: OdrzavanjeService, e: string) => s.vehicleBookings(e, "v1"),
    ],
    [
      "v_maint_vehicle_service_plan_due",
      (s: OdrzavanjeService, e: string) => s.vehicleServicePlanDue(e),
    ],
  ])(
    "7-11. `%s` — tehničar (vidi sve mašine, nijedno vozilo/IT/objekat) dobija `FALSE`",
    async (view, poziv) => {
      const { svc, upiti } = napraviServis();
      await poziv(svc, TEHNICAR);
      expect(upitZa(upiti, view).sql).toMatch(/WHERE\s+.*FALSE/);
      const drugi = napraviServis();
      await poziv(drugi.svc, ADMIN);
      expect(upitZa(drugi.upiti, view).sql).not.toMatch(/FALSE/);
    },
  );

  it("12. `v_maint_asset_service_plan_due` — view nabraja SVE tipove, pa scope zavisi od role", async () => {
    // 🔴 `nonMachineViewScopeSql` bi ovde bio POGREŠAN: tehničar bi izgubio i
    // mašinske planove, a operater bi dobio `FALSE` umesto svojih mašina.
    const teh = napraviServis();
    await teh.svc.assetServicePlanDue(TEHNICAR);
    expect(upitZa(teh.upiti, "v_maint_asset_service_plan_due").sql).toContain(
      "asset_type = 'machine'",
    );

    const op = napraviServis();
    await op.svc.assetServicePlanDue(OPERATER);
    const u = upitZa(op.upiti, "v_maint_asset_service_plan_due");
    expect(u.sql).toContain("asset_type = 'machine'");
    expect(u.sql).toContain("machine_code = ANY(");
    expect(u.values).toContainEqual(["3.12", "6.1"]);

    const op0 = napraviServis();
    await op0.svc.assetServicePlanDue(OPERATER0);
    expect(upitZa(op0.upiti, "v_maint_asset_service_plan_due").sql).toMatch(
      /WHERE\s+FALSE/,
    );

    const adm = napraviServis();
    await adm.svc.assetServicePlanDue(ADMIN);
    expect(upitZa(adm.upiti, "v_maint_asset_service_plan_due").sql).not.toMatch(
      /WHERE/,
    );
  });

  it("13. `v_maint_parts_with_vehicles` — magacinski krug (`canReadStock`)", async () => {
    const { svc, upiti } = napraviServis();
    await svc.listParts(OPERATER, {
      vehicleId: "00000000-0000-4000-8000-000000000001",
    });
    // Operater ne vidi vozilo -> ni upit ne stiže do view-a (asset scope preseca ranije).
    expect(
      upiti.some((u) => u.sql.includes("v_maint_parts_with_vehicles")),
    ).toBe(false);
  });

  it("13. …a šef koji vidi vozilo ali nema magacin dobija `FALSE` u WHERE", async () => {
    const { svc, upiti, baza } = napraviServis();
    // Vozilo mora biti nađeno po pravom uuid-u — koristimo šifru iz skupa.
    baza.maintAsset.push({
      assetId: "00000000-0000-4000-8000-000000000009",
      assetType: "vehicle",
      assetCode: "VOZ-9",
      name: "Kombi 9",
      archivedAt: null,
    });
    await svc.listParts(SEF, {
      vehicleId: "00000000-0000-4000-8000-000000000009",
    });
    const u = upitZa(upiti, "v_maint_parts_with_vehicles");
    expect(u.sql).toMatch(/WHERE/);
    // Šef JESTE u `canReadStock`, pa scope fragmenta nema — ostaje samo filter vozila.
    expect(u.sql).toContain("= ANY(vehicle_codes)");
  });

  it("14. `v_maint_vehicle_parts` — DVA kruga (magacin I sredstvo) spojena sa AND", async () => {
    const { svc, upiti } = napraviServis();
    await svc.vehicleParts(TEHNICAR, "v1");
    const u = upitZa(upiti, "v_maint_vehicle_parts");
    expect(u.sql).toMatch(/WHERE/);
    // Tehničar sme u magacin, ali NE vidi vozila -> tačno jedan `FALSE`.
    expect(u.sql).toContain("FALSE");
    expect(u.sql).toContain("asset_id =");
  });

  it("15. `v_maint_cmms_daily_summary` — ne sme da se pošalje bez punih prava", async () => {
    const uze = napraviServis();
    await uze.svc.dashboard(TEHNICAR);
    expect(
      uze.upiti.some((u) => u.sql.includes("v_maint_cmms_daily_summary")),
    ).toBe(false);
    const pun = napraviServis();
    await pun.svc.dashboard(MONTER);
    expect(
      pun.upiti.some((u) => u.sql.includes("v_maint_cmms_daily_summary")),
    ).toBe(true);
  });

  it("kalendar rokova: sva četiri view-a nose svoj isečak", async () => {
    const { svc, upiti } = napraviServis();
    await svc.calendarDeadlines(TEHNICAR);
    for (const view of [
      "v_maint_vehicle_service_plan_due",
      "v_maint_it_overview",
      "v_maint_facility_overview",
    ]) {
      expect(upitZa(upiti, view).sql).toContain("FALSE");
    }
    expect(upitZa(upiti, "v_maint_asset_service_plan_due").sql).toContain(
      "asset_type = 'machine'",
    );
  });

  it("izveštaj „zahtevaju pažnju“: oba view-a nose isečak, uslov pažnje ostaje", async () => {
    const { svc, upiti } = napraviServis();
    await svc.reportAttention(TEHNICAR);
    for (const view of ["v_maint_it_overview", "v_maint_facility_overview"]) {
      const u = upitZa(upiti, view);
      expect(u.sql).toContain("FALSE");
      expect(u.sql).toContain("open_wo_count > 0");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Brana: pod `sy15` se 3.0 grana NE dodiruje
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// ZABELEŽENO ODSTUPANJE (mereno na produkciji 07.08.2026) — NIJE ovde popravljeno
// ═══════════════════════════════════════════════════════════════════════════════

describe("🔴 OTVORENO: sredstvo tipa `machine` BEZ reda u `maint_machines`", () => {
  /*
   * Paritetno merenje na živoj bazi (jedna sesija, `SET LOCAL ROLE authenticated`
   * + GUC claims) dalo je za 4 naloga:
   *
   *   nalog                              sy15 RLS                3.0 scope
   *   veljko.mijajlovic (erp admin)      assets=141              assets=142
   *   stevan.birovljev  (chief)          assets=141              assets=142
   *   miljan.nikodijevic (management)    assets=141              assets=142
   *   nikola.savic      (chief)          assets=141              assets=142
   *   …a wo=134, incidents=22, drivers=30 poklapaju se TAČNO na sve četiri.
   *
   * Razlika je TAČNO JEDAN red i ima izmeren uzrok: u `maint_assets` postoji 1
   * sredstvo `asset_type='machine'` koje NEMA red u `maint_machines`
   * (`SELECT count(*) … NOT EXISTS` = 1). sy15 `maint_asset_visible` za mašinu
   * traži `EXISTS (SELECT 1 FROM maint_machines m WHERE m.asset_id = a.asset_id
   * AND maint_machine_visible(m.machine_code))`, pa taj siroti red ne vidi NIKO —
   * ni erp admin. `OdrzavanjeAuthzService.assetListWhere` za pozivaoca sa punim
   * pravima vraća `undefined` (bez sužavanja), pa pod `3.0` taj red POSTAJE
   * vidljiv u pickeru sredstava.
   *
   * ZAŠTO NIJE POPRAVLJENO OVDE: `assetListWhere` je ugovor koraka 2 (PR #119) i
   * njegov `undefined` je izričito pinovan u `odrzavanje-read-scope.spec.ts`.
   * Popravka je jedan uslov (`machine: { isNot: null }` na mašinskoj grani) i
   * dodiruje `assetScopedWhere`/`workOrderListWhere`/`incidentListWhere`/
   * `documentListWhere` — dakle tuđi opseg. Ovde je samo ZABELEŽENA da se ne bi
   * izgubila: opseg je 1 fantomski red u pickeru, ne curenje tuđih podataka.
   */
  it("odstupanje je vezano za `assetListWhere`, ne za ožičenje read sloja", async () => {
    const { svc, baza } = napraviServis();
    baza.maintAsset.push({
      assetId: "sirotan",
      assetType: "machine",
      assetCode: "X.X",
      name: "Sredstvo bez maint_machines reda",
      archivedAt: null,
    });
    // Pun pristup: red se vidi (3.0), iako ga sy15 RLS nikome ne pokazuje.
    expect(await broj((e) => svc.listAssets(e), ADMIN)).toBe(7);
    // 🔴 Ali za USKE role ne curi ništa — mašinska grana i dalje traži šifru
    // iz `maint_machines`, pa siroti red ne ulazi ni operateru ni tehničaru.
    expect(await broj((e) => svc.listAssets(e), TEHNICAR)).toBe(4); // 3 mašine + sirotan
    expect(await broj((e) => svc.listAssets(e), OPERATER)).toBe(2);
    expect(await broj((e) => svc.listAssets(e), OPERATER0)).toBe(0);
  });
});

describe("Prekidač presuđuje — 3.0 grana ne sme da procuri pod `sy15`", () => {
  it("pod `ODRZAVANJE_IZVOR=sy15` čitanje ide kroz sy15 most (a on je ovde zamka)", async () => {
    process.env.ODRZAVANJE_IZVOR = "sy15";
    const { svc, upiti } = napraviServis();
    await expect(svc.listMachines(ADMIN, {})).rejects.toThrow(
      /sy15 NE SME da se dodirne|sy15 NE SME/,
    );
    // 3.0 baza nije dodirnuta nijednim view upitom.
    expect(upiti).toHaveLength(0);
  });

  it("bez `OdrzavanjeAuthzService`/`OdrzavanjeFnService` pod `3.0` ostaje brana (503), nikad tiho sy15", async () => {
    const svc = new OdrzavanjeService(
      {
        withUserRls: () => {
          throw new Error("sy15 dodirnut");
        },
      } as unknown as Sy15Service,
      storageStub,
      { notifyOtpis: jest.fn() } as unknown as MasinaOtpisNotifyService,
      undefined,
      undefined,
      undefined,
      new OdrzavanjeSourceService(),
    );
    await expect(svc.listMachines(ADMIN, {})).rejects.toThrow(
      /nije prenet|503|ODRZAVANJE_IZVOR/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 🔴 MUTACIONA BRANA — pet mesta gde je scope DANAS ispravan, ali ga do sada
// ništa nije držalo.
//
// Mutaciona proba nad zatečenim skupom (389 testova) pustila je 28 kvarenja
// scope-a: 22 su pala, a 6 je PREŽIVELO. Uzrok je bio isti kod svih: postojeći
// testovi zovu rute BEZ filtera (`listAssets(e)`, `listMachines(e, {})`) i ne
// diraju detaljne rute uopšte. Testovi ispod zovu ih SA filterom i tvrde TAČAN
// BROJ REDOVA za usku rolu — „> 0" ovu klasu kvara ne hvata.
//
// Svaki test u naslovu nosi mutaciju koju mora da obori.
// ═══════════════════════════════════════════════════════════════════════════════
describe("🔴 mutaciona brana: scope pod filterom i na detaljnim rutama", () => {
  it("`listAssets` + ?type=vehicle: AND se NE SME zameniti spread-om (tehničar ne vidi vozila)", async () => {
    // Tehničar: `assetListWhere` = { assetType: 'machine' } (asimetrija je namerna).
    // Sa `AND: [{assetType:'vehicle'}, {assetType:'machine'}]` -> nula redova.
    // Sa spread-om bi `assetType:'vehicle'` PREGAZIO scope -> tehničar vidi v1.
    const { svc } = napraviServis();
    const out = await svc.listAssets(TEHNICAR, "vehicle");
    expect(out.data).toHaveLength(0);
    // Kontrola da podatak uopšte postoji: admin ga vidi.
    expect((await svc.listAssets(ADMIN, "vehicle")).data).toHaveLength(1);
    // I da tehničar NIJE prazan uopšte — mašine vidi sve tri.
    expect((await svc.listAssets(TEHNICAR, "machine")).data).toHaveLength(3);
  });

  it("`listMachines` + ?deadline=overdue: presek sa scope-om se NE SME zameniti `??`", async () => {
    // Pogled vraća 8.2 — mašinu koja operateru NIJE dodeljena (ima 3.12 i 6.1).
    // Presek `codeFilter ∩ scopeCodes` -> [] -> nula redova.
    // Sa `codeFilter ?? scopeCodes` operater bi video tuđu mašinu 8.2.
    const { svc } = napraviServis({
      v_maint_machine_current_status: [{ machine_code: "8.2" }],
    });
    const out = await svc.listMachines(OPERATER, { deadline: "overdue" });
    expect(out.data).toHaveLength(0);
    expect(out.meta.pagination.total).toBe(0);
    // Admin nema sužavanje pa istu mašinu vidi — dokaz da podatak postoji.
    const adm = await svc.listMachines(ADMIN, { deadline: "overdue" });
    expect(adm.data.map((m) => m.machineCode)).toEqual(["8.2"]);
  });

  it("`vehicleTires`: bez `assetScopedWhere` operater bi video gume tuđeg vozila", async () => {
    const { svc } = napraviServis();
    const out = await svc.vehicleTires(OPERATER, "v1");
    expect(out.data).toHaveLength(0);
    // Podatak postoji — admin ga vidi.
    expect((await svc.vehicleTires(ADMIN, "v1")).data).toHaveLength(1);
  });

  it("`findVehicle`: bez `assetListWhere` operater bi otvorio karton bilo kog vozila", async () => {
    // Karton nosi registraciju, vlasnika i kilometražu — širenje prava, ne sitnica.
    const { svc } = napraviServis();
    await expect(svc.findVehicle(OPERATER, "v1")).rejects.toThrow(
      /ne postoji ili nije vidljivo/i,
    );
    // Tehničar takođe ne sme (vozila nisu u njegovom skupu)…
    await expect(svc.findVehicle(TEHNICAR, "v1")).rejects.toThrow(
      /ne postoji ili nije vidljivo/i,
    );
    // …a admin sme, što dokazuje da red postoji.
    expect((await svc.findVehicle(ADMIN, "v1")).data.assetId).toBe("v1");
  });

  it("`findItAsset`/`findFacility`: bez `assetListWhere` operater bi otvorio karticu bilo kog sredstva", async () => {
    const { svc } = napraviServis();
    await expect(svc.findItAsset(OPERATER, "i1")).rejects.toThrow(
      /ne postoji ili nije vidljivo/i,
    );
    await expect(svc.findFacility(OPERATER, "f1")).rejects.toThrow(
      /ne postoji ili nije vidljivo/i,
    );
    // Tehničar isto ne sme — IT i objekti nisu mašine.
    await expect(svc.findItAsset(TEHNICAR, "i1")).rejects.toThrow(
      /ne postoji ili nije vidljivo/i,
    );
    // Admin sme.
    expect((await svc.findItAsset(ADMIN, "i1")).data.assetId).toBe("i1");
    expect((await svc.findFacility(ADMIN, "f1")).data.assetId).toBe("f1");
  });
});
