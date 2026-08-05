/**
 * One-off data migration: sy15 (1.0) `rev_*` tables -> 3.0 app-owned `rev_*` tables.
 * Korak 1 iz docs/PLAN_GASENJA_SY15_2026-08-03.md; merenje + runbook u
 * docs/SEOBA_REVERSA_2026-08-05.md.
 *
 * ⚠️ NE POKREĆE SE NA PRODUKCIJI dok ne padne odluka. Podrazumevani režim je
 * --dry-run (ništa se ne piše). Skripta ČITA sy15 (samo SELECT) i PIŠE u onu bazu
 * na koju pokazuje DATABASE_URL — proveri gde pokazuje pre `--apply`.
 *
 * ŠTA PRENOSI (14 tabela, redosledom koji poštuje FK):
 *   rev_inventory_groups -> subgroups -> subsubgroups
 *   rev_tools, rev_cutting_tool_catalog, rev_cutting_tool_stock
 *   rev_documents -> rev_document_lines -> rev_document_cutting_assignees
 *   rev_tool_batteries, rev_tool_service_log, rev_tool_stock_ledger
 *   rev_machine_heads, rev_recipient_locations
 *
 * ŠTA NE PRENOSI:
 *   `rev_api_idempotency` — uprkos prefiksu to je registar idempotencije CELE
 *   aplikacije (Sy15Service.runIdempotent), a ne tabela reversa. Izmereno 05.08:
 *   643 reda, od toga 2 reversi; ostalo kadrovska/sastanci/pb/održavanje/profil —
 *   domeni koji OSTAJU u sy15. Prenos bi im polomio idempotenciju. Kreće se od nule.
 *
 * KLJUČNE ODLUKE PRESLIKAVANJA:
 *   - UUID PK-ovi se ZADRŽAVAJU 1:1 -> prenos je egzaktno idempotentan (upsert po
 *     id-u), bez remap tabele. Ponovno pokretanje ažurira u mestu, nikad ne duplira.
 *   - Autori: sy15 `auth.users.<uuid>` -> email -> 3.0 `users.id` (Int).
 *     Nerazrešeno -> null, osim `rev_documents.issued_by` koji je NOT NULL —
 *     tamo se red PRESKAČE i prijavi (bez tihog podmetanja tuđeg naloga).
 *   - `employees.id` (uuid) i `loc_*.id` (uuid) se prenose DOSLOVNO kao meke veze
 *     bez FK-a — ti domeni su još u sy15 (KadrGridDayLock obrazac).
 *   - `barcode` i `loc_item_ref_id` se prenose eksplicitno da BEFORE INSERT trigeri
 *     ne bi iskovali nove. `loc_item_ref_id` se dodatno PROVERAVA (mora biti
 *     'rev_tools:<id>') jer ga trigger u 3.0 prepisuje po tom obrascu — ako se
 *     razlikuje, veza sa Lokacijama bi tiho pukla, pa se to prijavljuje kao blocker.
 *   - Posle uspešnog --apply sekvence barkodova se pomeraju (`setval`) na najveći
 *     preneseni broj, da novododati alat ne dobije već zauzet barkod.
 *
 * KONEKCIJE (iz backend/.env, kao migrate-pracenje-sy15.ts):
 *   - izvor sy15  : SY15_DATABASE_URL  (@prisma-sy15/client)
 *   - odrediste   : DATABASE_URL       (@prisma/client)
 *
 * POKRETANJE:
 *   npx ts-node --transpile-only backend/scripts/migrate-reversi-sy15.ts           # dry-run
 *   npx ts-node --transpile-only backend/scripts/migrate-reversi-sy15.ts --apply   # upis
 *   ... --verify-only    # samo uporedi brojeve izvor/odrediste, bez čitanja detalja
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  Prisma as Sy15Prisma,
  PrismaClient as Sy15PrismaClient,
} from "@prisma-sy15/client";

// ---------------------------------------------------------------------------
// Env bootstrap (bez dotenv zavisnosti) — isti obrazac kao migrate-pracenje-sy15.
// ---------------------------------------------------------------------------
function loadEnv(): void {
  const envPath = resolve(__dirname, "..", ".env");
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const APPLY = process.argv.includes("--apply");
const VERIFY_ONLY = process.argv.includes("--verify-only");

interface StepReport {
  read: number;
  written: number;
  skipped: number;
  inserted: number;
  updated: number;
  unresolved: Record<string, string[]>;
}
const report: Record<string, StepReport> = {};
const blockers: string[] = [];

function step(name: string): StepReport {
  const s: StepReport = {
    read: 0,
    written: 0,
    skipped: 0,
    inserted: 0,
    updated: 0,
    unresolved: {},
  };
  report[name] = s;
  return s;
}
function note(s: StepReport, category: string, key: string): void {
  (s.unresolved[category] ??= []).push(key);
}

/** Tabele koje se prenose, redosledom FK zavisnosti (i za verifikaciju brojeva). */
const TABLES = [
  "rev_inventory_groups",
  "rev_inventory_subgroups",
  "rev_inventory_subsubgroups",
  "rev_tools",
  "rev_cutting_tool_catalog",
  "rev_cutting_tool_stock",
  "rev_documents",
  "rev_document_lines",
  "rev_document_cutting_assignees",
  "rev_tool_batteries",
  "rev_tool_service_log",
  "rev_tool_stock_ledger",
  "rev_machine_heads",
  "rev_recipient_locations",
] as const;

async function main(): Promise<void> {
  loadEnv();
  if (!process.env.SY15_DATABASE_URL) {
    throw new Error("SY15_DATABASE_URL nije postavljen — nema izvora. Prekid.");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL nije postavljen — nema odredišta. Prekid.");
  }

  const prisma = new PrismaClient();
  const sy15 = new Sy15PrismaClient();

  console.log(
    `\n=== migrate-reversi-sy15 :: ${
      VERIFY_ONLY ? "VERIFY-ONLY" : APPLY ? "APPLY (piše)" : "DRY-RUN (ne piše)"
    } ===`,
  );
  console.log(
    `    odrediste: ${(process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":***@")}\n`,
  );

  try {
    if (VERIFY_ONLY) {
      await verifyCounts(sy15, prisma);
      return;
    }

    // -----------------------------------------------------------------------
    // Razrešivač autora: sy15 auth.users.<uuid> -> email -> 3.0 users.id.
    // -----------------------------------------------------------------------
    const authRows = await sy15.$queryRaw<{ id: string; email: string | null }[]>(
      Sy15Prisma.sql`SELECT id::text AS id, email FROM auth.users WHERE deleted_at IS NULL`,
    );
    const emailByAuthId = new Map<string, string>();
    for (const r of authRows) {
      if (r.email) emailByAuthId.set(r.id, r.email.toLowerCase());
    }
    const userIdByEmail = new Map<string, number>();
    for (const u of await prisma.user.findMany({ select: { id: true, email: true } })) {
      userIdByEmail.set(u.email.toLowerCase(), u.id);
    }
    /** null kad se ne razreši (pozivalac odlučuje: null-uj ili preskoči). */
    const resolveUser = (authUuid: string | null): number | null => {
      if (!authUuid) return null;
      const email = emailByAuthId.get(authUuid);
      if (!email) return null;
      return userIdByEmail.get(email) ?? null;
    };

    // =======================================================================
    // 1-3. Klasifikacija (grupe -> podgrupe -> podpodgrupe)
    // =======================================================================
    const s1 = step("1_rev_inventory_groups");
    const groups = await sy15.revInventoryGroup.findMany();
    s1.read = groups.length;
    const existingGroups = new Set(
      (await prisma.revInventoryGroup.findMany({ select: { id: true } })).map((r) => r.id),
    );
    for (const g of groups) {
      existingGroups.has(g.id) ? s1.updated++ : s1.inserted++;
      s1.written++;
      if (APPLY) {
        const data = {
          code: g.code,
          label: g.label,
          appliesTo: g.appliesTo,
          displayOrder: g.displayOrder,
          icon: g.icon,
          isSeeded: g.isSeeded,
          napomena: g.napomena,
        };
        await prisma.revInventoryGroup.upsert({
          where: { id: g.id },
          create: { id: g.id, ...data, createdAt: g.createdAt },
          update: data,
        });
      }
    }

    const s2 = step("2_rev_inventory_subgroups");
    const subgroups = await sy15.revInventorySubgroup.findMany();
    s2.read = subgroups.length;
    const existingSub = new Set(
      (await prisma.revInventorySubgroup.findMany({ select: { id: true } })).map((r) => r.id),
    );
    const groupIds = new Set(groups.map((g) => g.id));
    for (const sg of subgroups) {
      if (!groupIds.has(sg.groupId)) {
        s2.skipped++;
        note(s2, "grupa_ne_postoji", sg.id);
        continue;
      }
      existingSub.has(sg.id) ? s2.updated++ : s2.inserted++;
      s2.written++;
      if (APPLY) {
        const data = {
          groupId: sg.groupId,
          code: sg.code,
          label: sg.label,
          displayOrder: sg.displayOrder,
          isSeeded: sg.isSeeded,
          napomena: sg.napomena,
        };
        await prisma.revInventorySubgroup.upsert({
          where: { id: sg.id },
          create: { id: sg.id, ...data, createdAt: sg.createdAt },
          update: data,
        });
      }
    }

    const s3 = step("3_rev_inventory_subsubgroups");
    const subsubs = await sy15.revInventorySubsubgroup.findMany();
    s3.read = subsubs.length;
    const existingSubsub = new Set(
      (await prisma.revInventorySubsubgroup.findMany({ select: { id: true } })).map((r) => r.id),
    );
    const subgroupIds = new Set(subgroups.map((s) => s.id));
    for (const ss of subsubs) {
      if (!subgroupIds.has(ss.subgroupId)) {
        s3.skipped++;
        note(s3, "podgrupa_ne_postoji", ss.id);
        continue;
      }
      existingSubsub.has(ss.id) ? s3.updated++ : s3.inserted++;
      s3.written++;
      if (APPLY) {
        const data = {
          subgroupId: ss.subgroupId,
          code: ss.code,
          label: ss.label,
          displayOrder: ss.displayOrder,
          isSeeded: ss.isSeeded,
          napomena: ss.napomena,
        };
        await prisma.revInventorySubsubgroup.upsert({
          where: { id: ss.id },
          create: { id: ss.id, ...data, createdAt: ss.createdAt },
          update: data,
        });
      }
    }

    // =======================================================================
    // 4. rev_tools
    // =======================================================================
    const s4 = step("4_rev_tools");
    const tools = await sy15.revTool.findMany();
    s4.read = tools.length;
    const existingTools = new Set(
      (await prisma.revTool.findMany({ select: { id: true } })).map((r) => r.id),
    );
    for (const t of tools) {
      // Trigger u 3.0 prepisuje loc_item_ref_id po obrascu 'rev_tools:<id>'. Ako sy15
      // vrednost odstupa, veza sa loc_item_placements bi tiho pukla -> blocker.
      const expectedRef = `rev_tools:${t.id}`;
      if (t.locItemRefId && t.locItemRefId !== expectedRef) {
        blockers.push(
          `rev_tools ${t.id}: loc_item_ref_id='${t.locItemRefId}' != '${expectedRef}' — ` +
            `trigger bi ga prepisao i raskinuo vezu sa loc_item_placements`,
        );
      }
      if (t.createdBy && resolveUser(t.createdBy) == null) {
        note(s4, "createdBy_nerazresen", t.id);
      }
      existingTools.has(t.id) ? s4.updated++ : s4.inserted++;
      s4.written++;
      if (APPLY) {
        const data = {
          oznaka: t.oznaka,
          naziv: t.naziv,
          serijskiBroj: t.serijskiBroj,
          datumKupovine: t.datumKupovine,
          status: t.status,
          napomena: t.napomena,
          locItemRefId: t.locItemRefId,
          createdByUserId: resolveUser(t.createdBy),
          bigtehnSifraArtikla: t.bigtehnSifraArtikla,
          barcode: t.barcode,
          subgroupId: t.subgroupId,
          isQuantity: t.isQuantity,
          totalQty: t.totalQty,
          isConsumable: t.isConsumable,
          minStockQty: t.minStockQty,
          maxStockQty: t.maxStockQty,
          subsubgroupId: t.subsubgroupId,
          garancijaDo: t.garancijaDo,
          garancijaNapomena: t.garancijaNapomena,
          imaPunjac: t.imaPunjac,
          punjacSerijski: t.punjacSerijski,
          otpisDatum: t.otpisDatum,
          otpisRazlog: t.otpisRazlog,
          otpisByUserId: resolveUser(t.otpisBy),
          nabavnaVrednost: t.nabavnaVrednost,
        };
        await prisma.revTool.upsert({
          where: { id: t.id },
          create: { id: t.id, ...data, createdAt: t.createdAt },
          update: data,
        });
      }
    }

    // =======================================================================
    // 5-6. Rezni alat (katalog + stanje po lokaciji)
    // =======================================================================
    const s5 = step("5_rev_cutting_tool_catalog");
    const catalog = await sy15.revCuttingToolCatalog.findMany();
    s5.read = catalog.length;
    const existingCatalog = new Set(
      (await prisma.revCuttingToolCatalog.findMany({ select: { id: true } })).map((r) => r.id),
    );
    for (const c of catalog) {
      existingCatalog.has(c.id) ? s5.updated++ : s5.inserted++;
      s5.written++;
      if (APPLY) {
        const data = {
          barcode: c.barcode,
          oznaka: c.oznaka,
          naziv: c.naziv,
          compatibleMachineCodes: c.compatibleMachineCodes,
          unit: c.unit,
          status: c.status,
          napomena: c.napomena,
          createdByUserId: resolveUser(c.createdBy),
          bigtehnSifraArtikla: c.bigtehnSifraArtikla,
          minStockQty: c.minStockQty,
          subgroupId: c.subgroupId,
          maxStockQty: c.maxStockQty,
        };
        await prisma.revCuttingToolCatalog.upsert({
          where: { id: c.id },
          create: { id: c.id, ...data, createdAt: c.createdAt },
          update: data,
        });
      }
    }

    const s6 = step("6_rev_cutting_tool_stock");
    const stock = await sy15.revCuttingToolStock.findMany();
    s6.read = stock.length;
    const catalogIds = new Set(catalog.map((c) => c.id));
    const existingStock = new Set(
      (
        await prisma.revCuttingToolStock.findMany({
          select: { catalogId: true, locationId: true },
        })
      ).map((r) => `${r.catalogId}|${r.locationId}`),
    );
    for (const st of stock) {
      if (!catalogIds.has(st.catalogId)) {
        s6.skipped++;
        note(s6, "katalog_ne_postoji", `${st.catalogId}/${st.locationId}`);
        continue;
      }
      s6.written++;
      existingStock.has(`${st.catalogId}|${st.locationId}`) ? s6.updated++ : s6.inserted++;
      if (APPLY) {
        await prisma.revCuttingToolStock.upsert({
          where: {
            catalogId_locationId: { catalogId: st.catalogId, locationId: st.locationId },
          },
          create: {
            catalogId: st.catalogId,
            locationId: st.locationId,
            onHandQty: st.onHandQty,
          },
          update: { onHandQty: st.onHandQty },
        });
      }
    }

    // =======================================================================
    // 7-9. Dokumenti -> stavke -> zaduženi radnici
    // =======================================================================
    const s7 = step("7_rev_documents");
    const docs = await sy15.revDocument.findMany();
    s7.read = docs.length;
    const existingDocs = new Set(
      (await prisma.revDocument.findMany({ select: { id: true } })).map((r) => r.id),
    );
    const importedDocIds = new Set<string>();
    for (const d of docs) {
      // issued_by je NOT NULL — nerazrešen autor NE SME da se podmetne drugom nalogu.
      const issuedByUserId = resolveUser(d.issuedBy);
      if (issuedByUserId == null) {
        s7.skipped++;
        note(s7, "issued_by_nerazresen", `${d.docNumber} (${d.issuedBy})`);
        blockers.push(
          `rev_documents ${d.docNumber}: issued_by ${d.issuedBy} nema odgovarajući 3.0 users red`,
        );
        continue;
      }
      importedDocIds.add(d.id);
      existingDocs.has(d.id) ? s7.updated++ : s7.inserted++;
      s7.written++;
      if (APPLY) {
        const data = {
          docNumber: d.docNumber,
          docType: d.docType,
          recipientType: d.recipientType,
          recipientEmployeeId: d.recipientEmployeeId,
          recipientEmployeeName: d.recipientEmployeeName,
          recipientDepartment: d.recipientDepartment,
          recipientCompanyName: d.recipientCompanyName,
          recipientCompanyPib: d.recipientCompanyPib,
          recipientLocId: d.recipientLocId,
          expectedReturnDate: d.expectedReturnDate,
          issuedAt: d.issuedAt,
          issuedByUserId,
          status: d.status,
          returnConfirmedByUserId: resolveUser(d.returnConfirmedBy),
          returnConfirmedAt: d.returnConfirmedAt,
          returnNotes: d.returnNotes,
          pdfStoragePath: d.pdfStoragePath,
          pdfGeneratedAt: d.pdfGeneratedAt,
          napomena: d.napomena,
          recipientMachineCode: d.recipientMachineCode,
          issuedToEmployeeId: d.issuedToEmployeeId,
          issuedToEmployeeName: d.issuedToEmployeeName,
          bulkImportLegacyKey: d.bulkImportLegacyKey,
        };
        await prisma.revDocument.upsert({
          where: { id: d.id },
          create: { id: d.id, ...data, createdAt: d.createdAt },
          update: data,
        });
      }
    }

    const s8 = step("8_rev_document_lines");
    const lines = await sy15.revDocumentLine.findMany();
    s8.read = lines.length;
    const toolIds = new Set(tools.map((t) => t.id));
    const existingLines = new Set(
      (await prisma.revDocumentLine.findMany({ select: { id: true } })).map((r) => r.id),
    );
    const importedLineIds = new Set<string>();
    for (const l of lines) {
      if (!importedDocIds.has(l.documentId)) {
        s8.skipped++;
        note(s8, "dokument_nije_prenet", l.id);
        continue;
      }
      if (l.toolId && !toolIds.has(l.toolId)) {
        s8.skipped++;
        note(s8, "alat_ne_postoji", l.id);
        continue;
      }
      if (l.cuttingToolCatalogId && !catalogIds.has(l.cuttingToolCatalogId)) {
        s8.skipped++;
        note(s8, "katalog_ne_postoji", l.id);
        continue;
      }
      importedLineIds.add(l.id);
      s8.written++;
      existingLines.has(l.id) ? s8.updated++ : s8.inserted++;
      if (APPLY) {
        const data = {
          documentId: l.documentId,
          sortOrder: l.sortOrder,
          lineType: l.lineType,
          toolId: l.toolId,
          drawingNo: l.drawingNo,
          workOrderId: l.workOrderId,
          partName: l.partName,
          quantity: l.quantity,
          unit: l.unit,
          napomena: l.napomena,
          issueMovementId: l.issueMovementId,
          returnedQuantity: l.returnedQuantity,
          returnMovementId: l.returnMovementId,
          lineStatus: l.lineStatus,
          cuttingToolCatalogId: l.cuttingToolCatalogId,
        };
        await prisma.revDocumentLine.upsert({
          where: { id: l.id },
          create: { id: l.id, ...data, createdAt: l.createdAt },
          update: data,
        });
      }
    }

    const s9 = step("9_rev_document_cutting_assignees");
    const assignees = await sy15.revDocumentCuttingAssignee.findMany();
    s9.read = assignees.length;
    const existingAssignees = new Set(
      (await prisma.revDocumentCuttingAssignee.findMany({ select: { id: true } })).map(
        (r) => r.id,
      ),
    );
    for (const a of assignees) {
      if (!importedDocIds.has(a.documentId)) {
        s9.skipped++;
        note(s9, "dokument_nije_prenet", a.id);
        continue;
      }
      s9.written++;
      existingAssignees.has(a.id) ? s9.updated++ : s9.inserted++;
      if (APPLY) {
        const data = {
          documentId: a.documentId,
          employeeId: a.employeeId,
          role: a.role,
        };
        await prisma.revDocumentCuttingAssignee.upsert({
          where: { id: a.id },
          create: { id: a.id, ...data, createdAt: a.createdAt },
          update: data,
        });
      }
    }

    // =======================================================================
    // 10-12. Pod-evidencije alata
    // =======================================================================
    const s10 = step("10_rev_tool_batteries");
    const batteries = await sy15.revToolBattery.findMany();
    s10.read = batteries.length;
    const existingBatteries = new Set(
      (await prisma.revToolBattery.findMany({ select: { id: true } })).map((r) => r.id),
    );
    for (const b of batteries) {
      if (!toolIds.has(b.toolId)) {
        s10.skipped++;
        note(s10, "alat_ne_postoji", b.id);
        continue;
      }
      s10.written++;
      existingBatteries.has(b.id) ? s10.updated++ : s10.inserted++;
      if (APPLY) {
        const data = {
          toolId: b.toolId,
          serijskiBroj: b.serijskiBroj,
          kapacitet: b.kapacitet,
          datumNabavke: b.datumNabavke,
          status: b.status,
          napomena: b.napomena,
          createdByUserId: resolveUser(b.createdBy),
        };
        await prisma.revToolBattery.upsert({
          where: { id: b.id },
          create: { id: b.id, ...data, createdAt: b.createdAt },
          update: data,
        });
      }
    }

    const s11 = step("11_rev_tool_service_log");
    const services = await sy15.revToolServiceLog.findMany();
    s11.read = services.length;
    const existingServices = new Set(
      (await prisma.revToolServiceLog.findMany({ select: { id: true } })).map((r) => r.id),
    );
    for (const sv of services) {
      if (!toolIds.has(sv.toolId)) {
        s11.skipped++;
        note(s11, "alat_ne_postoji", sv.id);
        continue;
      }
      s11.written++;
      existingServices.has(sv.id) ? s11.updated++ : s11.inserted++;
      if (APPLY) {
        const data = {
          toolId: sv.toolId,
          datum: sv.datum,
          tip: sv.tip,
          opis: sv.opis,
          izvrsilac: sv.izvrsilac,
          trosak: sv.trosak,
          status: sv.status,
          napomena: sv.napomena,
          createdByUserId: resolveUser(sv.createdBy),
        };
        await prisma.revToolServiceLog.upsert({
          where: { id: sv.id },
          create: { id: sv.id, ...data, createdAt: sv.createdAt },
          update: data,
        });
      }
    }

    const s12 = step("12_rev_tool_stock_ledger");
    const ledger = await sy15.revToolStockLedger.findMany();
    s12.read = ledger.length;
    const existingLedger = new Set(
      (await prisma.revToolStockLedger.findMany({ select: { id: true } })).map((r) => r.id),
    );
    for (const lg of ledger) {
      if (!toolIds.has(lg.toolId)) {
        s12.skipped++;
        note(s12, "alat_ne_postoji", lg.id);
        continue;
      }
      // refDoc/refLine su ON DELETE SET NULL — nepreneta referenca se null-uje, red ostaje.
      const refDocId = lg.refDocId && importedDocIds.has(lg.refDocId) ? lg.refDocId : null;
      const refLineId = lg.refLineId && importedLineIds.has(lg.refLineId) ? lg.refLineId : null;
      if (lg.refDocId && !refDocId) note(s12, "ref_doc_nulovan", lg.id);
      if (lg.refLineId && !refLineId) note(s12, "ref_line_nulovan", lg.id);
      s12.written++;
      existingLedger.has(lg.id) ? s12.updated++ : s12.inserted++;
      if (APPLY) {
        const data = {
          toolId: lg.toolId,
          delta: lg.delta,
          reason: lg.reason,
          balanceAfter: lg.balanceAfter,
          refDocId,
          refLineId,
          note: lg.note,
          createdByUserId: resolveUser(lg.createdBy),
        };
        await prisma.revToolStockLedger.upsert({
          where: { id: lg.id },
          create: { id: lg.id, ...data, createdAt: lg.createdAt },
          update: data,
        });
      }
    }

    // =======================================================================
    // 13-14. Glave mašina + mapiranje primalaca na lokacije
    // =======================================================================
    const s13 = step("13_rev_machine_heads");
    const heads = await sy15.revMachineHead.findMany();
    s13.read = heads.length;
    const existingHeads = new Set(
      (await prisma.revMachineHead.findMany({ select: { id: true } })).map((r) => r.id),
    );
    for (const h of heads) {
      s13.written++;
      existingHeads.has(h.id) ? s13.updated++ : s13.inserted++;
      if (APPLY) {
        const data = {
          machineCode: h.machineCode,
          oznaka: h.oznaka,
          naziv: h.naziv,
          tip: h.tip,
          serijskiBroj: h.serijskiBroj,
          status: h.status,
          napomena: h.napomena,
          createdByUserId: resolveUser(h.createdBy),
        };
        await prisma.revMachineHead.upsert({
          where: { id: h.id },
          create: { id: h.id, ...data, createdAt: h.createdAt },
          update: data,
        });
      }
    }

    const s14 = step("14_rev_recipient_locations");
    const recipients = await sy15.revRecipientLocation.findMany();
    s14.read = recipients.length;
    const existingRecipients = new Set(
      (await prisma.revRecipientLocation.findMany({ select: { id: true } })).map((r) => r.id),
    );
    for (const r of recipients) {
      s14.written++;
      existingRecipients.has(r.id) ? s14.updated++ : s14.inserted++;
      if (APPLY) {
        const data = {
          recipientType: r.recipientType,
          recipientKey: r.recipientKey,
          recipientLabel: r.recipientLabel,
          locLocationId: r.locLocationId,
        };
        await prisma.revRecipientLocation.upsert({
          where: { id: r.id },
          create: { id: r.id, ...data, createdAt: r.createdAt },
          update: data,
        });
      }
    }

    // =======================================================================
    // Sekvence barkodova — da novi alat ne dobije već zauzet barkod.
    // =======================================================================
    if (APPLY) {
      await bumpSequence(prisma, "rev_tools_barcode_seq", "rev_tools", "barcode", "ALAT-");
      await bumpSequence(
        prisma,
        "rev_cutting_tool_barcode_seq",
        "rev_cutting_tool_catalog",
        "barcode",
        "RZN-",
      );
    }

    printReport();
    await verifyCounts(sy15, prisma);
  } finally {
    await prisma.$disconnect();
    await sy15.$disconnect();
  }
}

/**
 * Pomeri sekvencu na najveći preneseni broj iz barkoda (`<PREFIX>NNNNNN`).
 * Bez ovoga bi prvi novododati alat u 3.0 dobio 'ALAT-000001' i pao na unique.
 */
async function bumpSequence(
  prisma: PrismaClient,
  seq: string,
  table: string,
  column: string,
  prefix: string,
): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<{ maxnum: number | null }[]>(
    `SELECT max(substring(${column} from '^${prefix}([0-9]+)$')::bigint) AS maxnum FROM ${table}`,
  );
  const max = Number(rows[0]?.maxnum ?? 0);
  if (max > 0) {
    await prisma.$executeRawUnsafe(`SELECT setval('${seq}', ${max}, true)`);
    console.log(`  sekvenca ${seq} -> ${max}`);
  }
}

/**
 * Provera da se brojevi poklapaju: count(*) po tabeli u sy15 vs 3.0.
 * `rev_api_idempotency` se NAMERNO ne poredi — ne seli se (vidi zaglavlje).
 */
async function verifyCounts(sy15: Sy15PrismaClient, prisma: PrismaClient): Promise<void> {
  console.log("\n=== PROVERA BROJEVA (sy15 -> 3.0) ===");
  let allMatch = true;
  for (const t of TABLES) {
    const src = await sy15.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM ${t}`,
    );
    const dst = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM ${t}`,
    );
    const a = Number(src[0]?.n ?? 0);
    const b = Number(dst[0]?.n ?? 0);
    const ok = a === b;
    if (!ok) allMatch = false;
    console.log(`  ${ok ? "OK  " : "RAZLIKA"} ${t.padEnd(32)} sy15=${String(a).padStart(5)}  3.0=${String(b).padStart(5)}`);
  }
  console.log(
    allMatch
      ? "\n  Svi brojevi se poklapaju."
      : "\n  RAZLIKE POSTOJE — u dry-run režimu je to očekivano (ništa nije upisano).",
  );
  console.log(
    "  (rev_api_idempotency se ne poredi — ne seli se; registar cele aplikacije.)",
  );
}

function printReport(): void {
  console.log("---------------------------------------------------------------");
  console.log(`REZULTAT (${APPLY ? "UPISANO" : "DRY-RUN"}):`);
  for (const [name, s] of Object.entries(report)) {
    const verb = APPLY ? "upisano" : "upisalo-bi";
    console.log(
      `\n  ${name}: procitano=${s.read} ${verb}=${s.written} (insert=${s.inserted} update=${s.updated}) preskoceno=${s.skipped}`,
    );
    for (const [cat, keys] of Object.entries(s.unresolved)) {
      const sample = keys.slice(0, 10).join(", ");
      const more = keys.length > 10 ? ` … (+${keys.length - 10})` : "";
      console.log(`      - ${cat}: ${keys.length}  [${sample}${more}]`);
    }
  }
  console.log("\nBLOKADE (moraju se rešiti PRE --apply):");
  if (blockers.length === 0) console.log("  nema — nijedan red ne gubi vezu.");
  else for (const b of blockers) console.log(`  ! ${b}`);
  console.log("---------------------------------------------------------------");
  if (!APPLY) console.log("DRY-RUN — ništa nije upisano. Za upis: --apply");
}

main().catch((err: unknown) => {
  console.error("\nmigrate-reversi-sy15 PAO:", err);
  process.exitCode = 1;
});
