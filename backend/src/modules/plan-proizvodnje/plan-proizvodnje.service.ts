import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { IdempotencyService } from "../../common/idempotency/idempotency.service";
import { assertAttachment } from "../../common/attachments/attachment-format.util";
import { jsonSafe } from "../../common/json-safe";
import { machineGroupSlug } from "./departments";
import { IS_COMPLETED_EFFECTIVE } from "./plan-proizvodnje.sql";
import type {
  BulkReassignDto,
  CooperationGroupPatchDto,
  CooperationGroupUpsertDto,
  MachineHallUpsertDto,
  OverlayReorderDto,
  OverlayShiftChainDto,
  OverlayUpsertDto,
  ReassignDto,
  SetUrgentDto,
  TerminCreateDto,
  TerminPatchDto,
} from "./dto/plan-proizvodnje-mutation.dto";

type Tx = Prisma.TransactionClient;
/** Čitač za `collectChain` — isti upit ide i van transakcije (pregled) i u njoj (upis). */
type ChainDb = Tx | PrismaService;

/**
 * Kućni presedan za WRITE guard (`pracenje.service.ts:34` `CYCLE_MAX_DEPTH`).
 * MAX_DEPTH=20 iz `pracenje-read`/pdm je PRETESNO — izmeren lanac na mašini 3.40 ima
 * 16 ivica (19 čvorova), pa bi ga kapa od 20 dodirivala već sledeće sezone.
 */
export const CASCADE_MAX_DEPTH = 50;
/** Tvrda kapa skupa. Danas je maksimum 19 čvorova — kapa čuva od budućih podataka. */
const CASCADE_MAX_NODES = 500;
/** Prisma default je 5 s, a ČEKANJE NA BRAVE ulazi u budžet (cnc-programs.service.ts). */
const CASCADE_TX_TIMEOUT_MS = 15_000;

/**
 * Zona po kojoj se meri „ceo kalendarski dan".
 *
 * 🔴 Sesijska zona baze je `Etc/UTC` (izmereno 06.08.2026), gde je `+ interval '5 days'`
 * zapravo 120 SATI: `2026-10-23 08:00` postaje `2026-10-28 07:00` po beogradskom zidnom
 * satu (prelaz na zimsko 25.10.2026). Roundtrip `AT TIME ZONE 'Europe/Belgrade'` daje
 * `08:00` i poklapa se sa FE `addDays` (`setDate`, zidni sat). Izmereno na produkciji:
 * sa zonom 2026-10-28 08:00, naivno 2026-10-28 07:00.
 */
const PLAN_TZ = "Europe/Belgrade";

/**
 * `AT TIME ZONE 'Europe/Belgrade'` kao SQL TEKST, ne kao bind parametar.
 *
 * `Prisma.raw` je ovde bezbedan po konstrukciji: `PLAN_TZ` je modulna konstanta i u
 * izraz ne ulazi nijedan podatak sa zahteva. Tekst (a ne parametar) je namerno — tako
 * izraz stoji u SQL-u čitljiv i proverljiv testom, umesto da se krije iza `$3`.
 */
const AT_PLAN_TZ = Prisma.raw(`AT TIME ZONE '${PLAN_TZ}'`);

/** Razlog preskoka pri kaskadi (075/26) — kod + srpski tekst za planera. */
const SKIP_RAZLOZI = {
  orfan: "operacija više ne postoji (mrtva veza)",
  arhivirano: "pozicija je arhivirana",
  bez_termina: "nema planiran termin",
  zavrseno: "pozicija je završena",
} as const;
type SkipKod = keyof typeof SKIP_RAZLOZI;
/** Slovo klase u otisku stanja lanca (v. `chainHash`). */
const KLASA_SLOVO: Record<SkipKod | "moved", string> = {
  moved: "M",
  zavrseno: "Z",
  bez_termina: "T",
  arhivirano: "A",
  orfan: "O",
};

/** Čvor lanca — par ključeva `plan_proizvodnje_overlays`. */
interface ChainNode {
  wo: number;
  line: number;
}

/** Uslov („prethodnik") jednog overlay reda — čita ga hod naviše u anti-ciklus brani. */
interface PredecessorRef {
  predecessor_work_order_id: number | null;
  predecessor_line: number | null;
}

/** Jedan čvor zatvorenja lanca, onako kako ga vraća `collectChain` SQL. */
interface ChainRow {
  work_order_id: string;
  line_id: string;
  dubina: number;
  ciklus: boolean;
  putanja_txt: string[];
  planned_start_at: Date | null;
  planned_end_at: Date | null;
  /** Izračunat NOV termin (isti izraz kao UPDATE) — pregled je bit-identičan upisu. */
  novi_start: Date | null;
  novi_end: Date | null;
  orfan: boolean;
  arhivirano: boolean;
  rn_ident_broj: string | null;
  operacija: number | null;
  broj_crteza: string | null;
  effective_machine_code: string | null;
  zavrseno: boolean;
}

interface SkippedRow extends ChainRow {
  razlog_kod: SkipKod;
  razlog: string;
}

interface ChainPlan {
  /** Ciklus u zatvorenju — sve ostalo je tada prazno; upis se NE radi. */
  ciklus: { putanja: string[]; ivica: string } | null;
  sidro: ChainRow | null;
  moved: ChainRow[];
  skipped: SkippedRow[];
  dubinaMax: number;
  zahvat: number;
}

/**
 * `409 chain_changed` — plan se promenio između pregleda i upisa. Telo nosi SVEŽ plan
 * (isti oblik kao uspešan odgovor), da dijalog može da se prerenderuje BEZ drugog
 * poziva. `message` je KOD (FE `overlayErrorMessage` traži kod u `String(e.message)`).
 */
export class ChainChangedException extends ConflictException {
  constructor(plan: unknown) {
    super({ message: "chain_changed", code: "chain_changed", plan });
  }
}

/**
 * Skice se primaju po SADRŽAJU (`common/attachments`), ne po MIME listi iz 1.0
 * `drawingManager`-a. Ta lista je primala `image/heic` i `image/webp`, a galerija
 * skica ih prikazuje kroz `<img>` — HEIC bi se upisao i ostao trajno nevidljiv.
 * Ostaju JPG/PNG/PDF (front `skice-modal` već nudi upravo njih).
 */

/**
 * Plan proizvodnje — WRITE (mutacioni) sloj nad 2.0 app-owned `plan_proizvodnje_*`
 * tabelama (F5b, plan §4.2 (b)/(c)/(e)). Zamena za sy15 DEFINER RPC-ove
 * (`reassign_production_line`, overlay/urgency/koop upsert-e) i storage bucket —
 * sve sada kroz `PrismaService` (glavna baza). Autorizacija: kontroler gejtuje
 * `plan_proizvodnje.edit` (+ `.force` za forsirani reassign, `.koop_admin` za grupe);
 * sy15 RLS (`can_edit_plan_proizvodnje`) više NE presuđuje (ugašen most).
 *
 * `reassign` je verni port sy15 RPC-a (snapshot:3313-3437): group-mismatch gate
 * (`machine_group_mismatch` → 422), force gate (`force_reason` ≥3 + `plan_proizvodnje.force`
 * → 403), idempotencija audita `ON CONFLICT (client_event_uuid, line_id) DO NOTHING`.
 * BE je sada KONAČNI gate (nema DB DEFINER-a) — pokriveno testom.
 *
 * id-jevi (`work_order_id`/`line_id`) su Int u native tabelama (ISTI id prostor kao
 * work_orders/work_order_operations); FE šalje stringove (M3) → `Number(...)`.
 */
@Injectable()
export class PlanProizvodnjeService {
  constructor(
    private readonly prisma: PrismaService,
    // `IdempotencyModule` je `@Global` (app.module.ts) → modul se ne dira.
    private readonly idem: IdempotencyService,
  ) {}

  // ==========================================================================
  // Overlays (merge upsert)
  // ==========================================================================

  /**
   * Overlay UPSERT (patch, merge — samo poslata polja se menjaju; ON CONFLICT
   * (work_order_id, line_id)). Audit kolone (cam_ready_at/by, ready_override_at/by,
   * cooperation_set_at/by) stampuje server. `updated_by`/`created_by` = email.
   */
  async upsertOverlay(email: string, dto: OverlayUpsertDto) {
    const wo = Number(dto.workOrderId);
    const line = Number(dto.lineId);
    const now = new Date();
    const patch: Record<string, unknown> = {};
    if (dto.localStatus !== undefined) patch.localStatus = dto.localStatus;
    if (dto.shiftNote !== undefined) patch.shiftNote = dto.shiftNote;
    // Pin-marker: klijent šalje shiftSortOrder=-1 kao „pin-to-top" signal.
    // Kanon (1.0 pinToTop): vrednost = MIN(shift_sort_order ručnih iste efektivne
    // mašine) − 1 (bez ručnih → 1). Ostale vrednosti (drag redosled, null=unpin) prolaze
    // doslovno. Računa se u tx (delta min nad overlay ⋈ linija).
    const isPinMarker = dto.shiftSortOrder === -1;
    if (dto.shiftSortOrder !== undefined && !isPinMarker)
      patch.shiftSortOrder = dto.shiftSortOrder;
    if (dto.assignedMachineCode !== undefined)
      patch.assignedMachineCode = dto.assignedMachineCode;
    if (dto.camReady !== undefined) {
      patch.camReady = dto.camReady;
      patch.camReadyAt = dto.camReady ? now : null;
      patch.camReadyBy = dto.camReady ? email : null;
    }
    if (dto.readyOverride !== undefined) {
      patch.readyOverride = dto.readyOverride;
      patch.readyOverrideAt = dto.readyOverride ? now : null;
      patch.readyOverrideBy = dto.readyOverride ? email : null;
    }
    if (dto.cooperationStatus !== undefined) {
      patch.cooperationStatus = dto.cooperationStatus;
      if (dto.cooperationStatus === "none") {
        patch.cooperationPartner = null;
        patch.cooperationExpectedReturn = null;
        patch.cooperationSetBy = null;
        patch.cooperationSetAt = null;
      } else {
        if (dto.cooperationPartner !== undefined)
          patch.cooperationPartner = dto.cooperationPartner;
        patch.cooperationExpectedReturn = this.toDbDate(
          dto.cooperationExpectedReturn,
        );
        patch.cooperationSetBy = email;
        patch.cooperationSetAt = now;
      }
    }
    // ── Zahtev 046/26 (gant). Termini/uslov/završenost — merge patch (undefined = ne
    //    diraj, null = obriši). Ne dodiruju `shiftSortOrder` (ručni redosled = master).
    if (dto.plannedStartAt !== undefined)
      patch.plannedStartAt = this.toDbTs(dto.plannedStartAt);
    if (dto.plannedEndAt !== undefined)
      patch.plannedEndAt = this.toDbTs(dto.plannedEndAt);
    if (dto.plannedDurationMinutes !== undefined)
      patch.plannedDurationMinutes = dto.plannedDurationMinutes;
    if (dto.plannedDone !== undefined) {
      patch.plannedDone = dto.plannedDone;
      // null = skini override (vrati auto iz kucanja) → i audit se briše.
      patch.plannedDoneAt = dto.plannedDone === null ? null : now;
      patch.plannedDoneBy = dto.plannedDone === null ? null : email;
    }
    if (dto.predecessorWorkOrderId !== undefined) {
      const pw = dto.predecessorWorkOrderId;
      patch.predecessorWorkOrderId = pw === null ? null : Number(pw);
      // Brisanje RN prethodnika nosi i liniju (uslov je par, ne dva nezavisna polja).
      if (pw === null) patch.predecessorLine = null;
    }
    if (dto.predecessorLine !== undefined && dto.predecessorWorkOrderId !== null)
      patch.predecessorLine =
        dto.predecessorLine === null ? null : Number(dto.predecessorLine);

    const touchesTerms =
      patch.plannedStartAt !== undefined || patch.plannedEndAt !== undefined;
    const touchesPredecessor =
      patch.predecessorWorkOrderId !== undefined ||
      patch.predecessorLine !== undefined;

    return this.prisma.$transaction(async (tx) => {
      // Termini/uslov se validiraju nad SPOJENIM stanjem (postojeći red ⊕ patch) —
      // v. `assertPlanConsistent`; provera nad samim patch-om propušta svaki poziv
      // koji nosi samo jedno od dva polja (FE resize/Shift+strelice).
      if (touchesTerms || touchesPredecessor) {
        await this.assertPlanConsistent(tx, wo, line, patch, touchesTerms, touchesPredecessor);
      }
      if (isPinMarker) {
        patch.shiftSortOrder = await this.resolvePinOrder(tx, wo, line);
      }
      const row = await tx.planProizvodnjeOverlay.upsert({
        where: { workOrderId_lineId: { workOrderId: wo, lineId: line } },
        create: {
          workOrderId: wo,
          lineId: line,
          ...patch,
          createdBy: email,
          updatedBy: email,
        },
        update: { ...patch, updatedBy: email, updatedAt: now },
      });
      await this.preslikajTerminFazaA(tx, row, email, now);
      return { data: jsonSafe(row) };
    });
  }

  /**
   * 078/26 FAZA A — dvostruki upis termina u `plan_proizvodnje_termini`.
   *
   * 🔴 Preslikava se ZAVRŠNO STANJE OVERLAY REDA, ne patch. To je jedina razlika koja
   * ovu fazu čini bezbednom: API je merge-patch (FE resize bara i Shift+←/→ šalju SAMO
   * `plannedEndAt`), pa bi preslikavanje patch-a upisalo NULL u polje koje korisnik nije
   * ni dirao, dok bi overlay zadržao staru vrednost — tiho razilaženje koje se nigde ne
   * prijavljuje. Kopiranjem celog reda razilaženje je nemoguće po konstrukciji, pa
   * provera „razlika mora biti 0" pred prelazak čitanja ima smisla.
   *
   * LENJ: termin nastaje tek kad pozicija dobije `plannedStartAt`, i briše se kad ga
   * izgubi (skidanje sa ganta). Time dva mesta koja prave overlay BEZ termina
   * (`reorderOverlays`, `bulkReassign`) ostaju netaknuta — jedinstveni indeks dozvoljava
   * NULA redova, pa im ne treba nikakav upis i ne ulaze u budžet svoje transakcije.
   *
   * U Fazi B ovaj preslikač NESTAJE — tada gant piše direktno u termine, a overlay više
   * ne nosi `planned_*`.
   */
  private async preslikajTerminFazaA(
    tx: Tx,
    row: {
      id: number;
      workOrderId: number;
      lineId: number;
      plannedStartAt: Date | null;
      plannedEndAt: Date | null;
      plannedDurationMinutes: number | null;
      plannedDone: boolean | null;
      plannedDoneAt: Date | null;
      plannedDoneBy: string | null;
    },
    email: string,
    now: Date,
  ): Promise<void> {
    // `== null` NAMERNO (hvata i `undefined`), ne `=== null`. Overlay red koji nikad
    // nije bio na gantu vraća polje kao odsutno, ne kao NULL — a `planned_start_at` u
    // tabeli termina je NOT NULL, pa bi strogo poređenje ovde napravilo upis bez
    // početka i srušilo zahtev na 500. Nema početka → nema termina, tačka.
    if (row.plannedStartAt == null) {
      // Pozicija je skinuta sa ganta (ili nikad nije bila) — termina nema. `deleteMany`
      // (ne `delete`) jer reda ne mora biti: upis je lenj, a `delete` bi pukao na P2025.
      await tx.planProizvodnjeTermin.deleteMany({ where: { overlayId: row.id } });
      return;
    }
    // Količina se u Fazi A ne deli — jedan termin nosi pun plan operacije. Čita se
    // ovde (a ne u `create` grani) da vrednost bude ista i kad red tek nastaje.
    const wo = await tx.workOrder.findUnique({
      where: { id: row.workOrderId },
      select: { pieceCount: true },
    });
    const zajednicko = {
      plannedStartAt: row.plannedStartAt,
      plannedEndAt: row.plannedEndAt,
      plannedDurationMinutes: row.plannedDurationMinutes,
      plannedDone: row.plannedDone,
      plannedDoneAt: row.plannedDoneAt,
      plannedDoneBy: row.plannedDoneBy,
      updatedBy: email,
    };
    await tx.planProizvodnjeTermin.upsert({
      where: { overlayId: row.id },
      create: {
        overlayId: row.id,
        workOrderId: row.workOrderId,
        lineId: row.lineId,
        kolicina: wo?.pieceCount ?? null,
        createdBy: email,
        ...zajednicko,
      },
      // `kolicina` i `assignedMachineCode` se NAMERNO ne diraju pri izmeni — u Fazi B
      // ih postavlja planer po terminu, a ovaj put sme da menja samo vremena.
      update: { ...zajednicko, updatedAt: now },
    });
  }

  /**
   * Validacija termina i uslova nad SPOJENIM stanjem (postojeći red ⊕ patch).
   *
   * API je merge-patch, pa provera nad SAMIM patch-om propušta svaki poziv koji nosi
   * jedno od dva polja: FE resize bara i Shift+←/→ šalju samo `plannedEndAt`, a uslov
   * ume da stigne kao dva odvojena poziva (prvo linija, pa RN). Zato se postojeći red
   * čita u ISTOJ transakciji i `FOR UPDATE` — drugi planer čeka do commit-a umesto da
   * nad zastarelim kešom upiše kraj pre početka.
   *
   * Pravila (sva → 422; naopak interval se NIKAD ne upisuje):
   *   • `planned_end_before_start`    — kraj pre početka,
   *   • `predecessor_self_reference`  — stavka kao sopstveni uslov (ciklus dužine 1),
   *   • `predecessor_pair_incomplete` — uslov je PAR (RN + linija); pola para je siroče
   *     na kome bi se F2 auto-pomeranje po uslovu zavrtelo,
   *   • `predecessor_cycle`           — 075/26: veza koja zatvara petlju DUŽE od 1
   *     (`A→B→A` je do sada prolazio; kaskada bi se na njemu vrtela).
   */
  private async assertPlanConsistent(
    tx: Tx,
    wo: number,
    line: number,
    patch: Record<string, unknown>,
    checkTerms: boolean,
    checkPredecessor: boolean,
  ): Promise<void> {
    const rows = await tx.$queryRaw<
      {
        planned_start_at: Date | null;
        planned_end_at: Date | null;
        predecessor_work_order_id: number | null;
        predecessor_line: number | null;
      }[]
    >(Prisma.sql`
      SELECT planned_start_at, planned_end_at,
             predecessor_work_order_id, predecessor_line
        FROM plan_proizvodnje_overlays
       WHERE work_order_id = ${wo} AND line_id = ${line}
       FOR UPDATE`);
    const cur = rows[0];
    /** Spojena vrednost: patch ima prednost (uklj. eksplicitni null), inače baza. */
    const merged = <T>(key: string, existing: T | null | undefined): T | null =>
      patch[key] !== undefined ? ((patch[key] as T | null) ?? null) : (existing ?? null);

    if (checkTerms) {
      const start = merged<Date>("plannedStartAt", cur?.planned_start_at);
      const end = merged<Date>("plannedEndAt", cur?.planned_end_at);
      if (start && end && end.getTime() < start.getTime()) {
        throw new UnprocessableEntityException("planned_end_before_start");
      }
    }
    if (checkPredecessor) {
      const pwo = merged<number>("predecessorWorkOrderId", cur?.predecessor_work_order_id);
      const pline = merged<number>("predecessorLine", cur?.predecessor_line);
      if (pwo === wo && pline === line) {
        throw new UnprocessableEntityException("predecessor_self_reference");
      }
      if ((pwo === null) !== (pline === null)) {
        throw new UnprocessableEntityException("predecessor_pair_incomplete");
      }
      if (pwo !== null && pline !== null) {
        await this.assertNoPredecessorCycle(tx, wo, line, pwo, pline);
      }
    }
  }

  /**
   * 075/26 — anti-ciklus PRI KREIRANJU veze. Do sada se branila samo samo-referenca
   * (ciklus dužine 1), pa je `A→B→A` prolazio; kaskadno pomeranje bi na takvom podatku
   * moralo da se oslanja isključivo na `CYCLE` guard u SQL-u.
   *
   * Postavljanje uslova (wo,line) → (pwo,pline) zatvara petlju TAČNO kad je (wo,line)
   * već PREDAK predloženog prethodnika. Čvor ima NAJVIŠE JEDNOG prethodnika (par kolona
   * na redu, ne tabela veza), pa je ovo LINEARAN hod naviše — ne BFS kao uzor
   * `pracenje.service.ts` `wouldCreateParentCycle`.
   *
   * ⚠️ GRANICA KOJU TREBA ZNATI: ovaj hod čita redove koje jednoredni `FOR UPDATE` iz
   * `assertPlanConsistent` NE zaključava, pa dva istovremena upisa i dalje teorijski
   * mogu da sklope ciklus. `CYCLE` guard u kaskadi (`collectChain`) je KONAČNA brana i
   * ostaje i pored ovoga.
   *
   * 🔴 KAPA MORA DA SE ČUJE: ako se hod ne zaustavi, veza se ODBIJA sa `cascade_too_deep`.
   * Ranije se ćutke izlazilo iz petlje i veza je PROLAZILA — a to je tačno onaj lanac koji
   * kaskada posle ne ume da pomeri celog.
   *
   * 🔴 GRANICA JE `dubina < CASCADE_MAX_DEPTH`, NE `<=` (treći krug 075/26). Sa `<=` je
   * hod posećivao 51 pretka i puštao vezu, a `collectChain` nad korenom je toj istoj
   * poziciji davao `dubina = 51 > 50` → `cascade_too_deep`: veza se upiše, a lanac
   * postane NEPOMERLJIV. Čuvar mora da bude bar toliko strog koliko i kapa koju brani.
   *
   * Račun: hod poseti pretke `P0…Pk` (`P0` je predloženi prethodnik). Posle upisa je nova
   * pozicija na dubini `k + 1` od korena, pa mora da važi `k + 1 <= CASCADE_MAX_DEPTH`,
   * tj. najviše `CASCADE_MAX_DEPTH` poseta — tačno `dubina` u `0 … CASCADE_MAX_DEPTH − 1`.
   */
  private async assertNoPredecessorCycle(
    tx: Tx,
    wo: number,
    line: number,
    pwo: number,
    pline: number,
  ): Promise<void> {
    const visited = new Set<string>();
    let cur: ChainNode | null = { wo: pwo, line: pline };
    for (let dubina = 0; dubina < CASCADE_MAX_DEPTH && cur !== null; dubina++) {
      const node: ChainNode = cur;
      if (node.wo === wo && node.line === line) {
        throw new UnprocessableEntityException({
          message: "predecessor_cycle",
          code: "predecessor_cycle",
        });
      }
      const kljuc = `${node.wo}:${node.line}`;
      // Zatečen ciklus UZVODNO (bez naše ivice) nije naš problem — prekid, ne greška.
      if (visited.has(kljuc)) return;
      visited.add(kljuc);
      const rows: PredecessorRef[] = await tx.$queryRaw<PredecessorRef[]>(Prisma.sql`
        SELECT predecessor_work_order_id, predecessor_line
          FROM plan_proizvodnje_overlays
         WHERE work_order_id = ${node.wo} AND line_id = ${node.line}`);
      const p: PredecessorRef | undefined = rows[0];
      cur =
        p?.predecessor_work_order_id != null && p.predecessor_line != null
          ? { wo: p.predecessor_work_order_id, line: p.predecessor_line }
          : null;
    }
    // Hod nije stigao do korena ni posle `CASCADE_MAX_DEPTH` predaka — nova pozicija bi
    // sela na dubinu ≥ `CASCADE_MAX_DEPTH + 1`, tj. na lanac koji kaskada odbija.
    if (cur !== null) {
      throw new UnprocessableEntityException({
        message: "cascade_too_deep",
        code: "cascade_too_deep",
        dubina: CASCADE_MAX_DEPTH + 1,
        cap: CASCADE_MAX_DEPTH,
      });
    }
  }

  /**
   * Pin-to-top kanon (1.0 pinToTop): MIN(shift_sort_order) postojećih RUČNIH
   * (NOT NULL) operacija ISTE efektivne mašine kao ciljna linija, minus 1. Bez ručnih
   * redova → 1. Ciljna operacija se isključuje. Efektivna mašina = COALESCE(overlay
   * assigned, work_order_operations.work_center_code) — poštuje reassign.
   */
  private async resolvePinOrder(
    tx: Tx,
    wo: number,
    line: number,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ min_order: number | null }[]>(Prisma.sql`
      SELECT MIN(o.shift_sort_order)::int AS min_order
        FROM plan_proizvodnje_overlays o
        JOIN work_order_operations l ON l.work_order_id = o.work_order_id AND l.id = o.line_id
       WHERE COALESCE(o.assigned_machine_code, NULLIF(BTRIM(l.work_center_code), '')) = (
               SELECT COALESCE(o2.assigned_machine_code, NULLIF(BTRIM(l2.work_center_code), ''))
                 FROM work_order_operations l2
                 LEFT JOIN plan_proizvodnje_overlays o2
                   ON o2.work_order_id = l2.work_order_id AND o2.line_id = l2.id
                WHERE l2.work_order_id = ${wo} AND l2.id = ${line} LIMIT 1
             )
         AND o.shift_sort_order IS NOT NULL
         AND NOT (o.work_order_id = ${wo} AND o.line_id = ${line})`);
    const min = rows[0]?.min_order;
    return min != null ? min - 1 : 1;
  }

  /**
   * Bulk reorder — `shift_sort_order` = 1..n u datom redosledu (jedan tx).
   *
   * 🔴 075/26 (treći krug): KANON SE POŠTUJE REDOSLEDOM UPISA, ne samo pre-lock-om.
   * Prva verzija je stavila samo `lockOverlays` PRE petlje i to je bio no-op za skoro
   * sve: `SELECT … FOR UPDATE` zaključava samo redove KOJI POSTOJE, a `upsert` je ovde
   * najčešće INSERT. Izmereno na produkciji: od 217.732 operacija samo 242 ima overlay
   * red — 217.490 parova brava ne bi ni dotakla, pa bi INSERT-i i dalje uzimali brave
   * nad unique indeksom `uq_…_wo_line` PRIKAZNIM redosledom (hala/mašina/
   * `shift_sort_order`) dok ih kaskada uzima po `(work_order_id, line_id)`. To je `40P01`
   * posle `deadlock_timeout = 1 s`, planeru vidljiv kao 500.
   *
   * Zato se parovi SORTIRAJU po `(work_order_id, line_id)` pre petlje. Redni broj
   * (`shiftSortOrder`) se veže za stavku PRE sortiranja — sortira se REDOSLED UPISA, ne
   * značenje podatka.
   *
   * `lockOverlays` OSTAJE i pored sortiranja: za 242 postojeća reda uzima sve brave u
   * jednom iskazu i u kanonskom redosledu ODMAH, pa se međusobno presecajući poslovi
   * sudaraju na prvom iskazu (jasan `40P01`/čekanje) umesto na sredini petlje, sa pola
   * upisanih redova iza sebe.
   */
  async reorderOverlays(email: string, dto: OverlayReorderDto) {
    const now = new Date();
    const stavke = dto.items
      .map((it, i) => ({
        wo: Number(it.workOrderId),
        line: Number(it.lineId),
        redni: i + 1,
      }))
      .sort((a, b) => a.wo - b.wo || a.line - b.line);
    return this.prisma.$transaction(async (tx) => {
      await this.lockOverlays(tx, stavke);
      for (const s of stavke) {
        await tx.planProizvodnjeOverlay.upsert({
          where: { workOrderId_lineId: { workOrderId: s.wo, lineId: s.line } },
          create: {
            workOrderId: s.wo,
            lineId: s.line,
            shiftSortOrder: s.redni,
            createdBy: email,
            updatedBy: email,
          },
          update: { shiftSortOrder: s.redni, updatedBy: email, updatedAt: now },
        });
      }
      return { data: { reordered: dto.items.length } };
    });
  }

  // ==========================================================================
  // Kaskadno pomeranje vezanih pozicija (075/26 — F2 iz 046/26)
  // ==========================================================================

  /**
   * Pomeri SIDRO i ceo lanac njegovih sledbenika za ISTI broj kalendarskih dana.
   *
   * SEMANTIKA (presuđena merenjem 06.08.2026, ne preispitivati):
   *  • **ISTI POMAK**, nikad „prilepi za kraj prethodnika". Od 30 izmerenih razmaka
   *    bar-do-bar 10 je POZITIVNO (6 su granice kalendara — noć 16:00→08:00, vikend
   *    petak 16:00→ponedeljak 08:00; 1 je namerna rezerva od 24 h), a JEDAN živ razmak
   *    je NEGATIVAN (`47616/231315` traje do 12:00, sledbenik `47610/231280` počinje u
   *    11:00). Svako pravilo „sledbenik posle prethodnika" bacalo bi 422 nad zatečenim
   *    podatkom, a lepljenje bi uništilo namerne razmake.
   *  • **Sidro se pomera UVEK**, i kad je završeno: koren lanca mašine 3.40
   *    (`47617/231323`) JESTE završen, pa bi brana nad sidrom učinila gest nevidljivim.
   *  • **Preskok se odnosi na UPIS, nikad na HOD.** 5 od 7 završenih pozicija je u
   *    SREDINI lanca; prekid hoda bi na 3.40 pomerio 0 umesto 15 pozicija.
   *  • **`work_orders.is_locked` se NE proverava.** Svih 39 vezanih pozicija je na
   *    zaključanim nalozima, a `is_locked` je danas SAMO PRIKAZ (u backendu se pojavljuje
   *    isključivo u modulu `handovers`). Brana bi bila mrtva funkcija, ne stroga.
   *  • **Kaskada je SERVERSKA.** `LinkLayer` razrešava veze samo među iscrtanih ~300
   *    redova (`gantt-tab.tsx` `MAX_ROWS`) nad feed-om koji je i sam `LIMIT 5000` sa
   *    serverskim `hall`/`q` filterima — klijentski spisak bi tiho gubio rep lanca.
   *    Zato klijent šalje SAMO sidro i deltu.
   */
  async shiftChain(email: string, dto: OverlayShiftChainDto) {
    const wo = Number(dto.workOrderId);
    const line = Number(dto.lineId);
    const delta = dto.deltaDays;
    const pregled = dto.dryRun === true;

    // Bez posla — nula dodira baze, nula potrošenog ključa idempotencije.
    if (delta === 0 && !pregled) {
      throw new UnprocessableEntityException({
        message: "delta_zero",
        code: "delta_zero",
      });
    }

    // PREGLED — bez transakcije, bez brave, NE troši idempotency ključ.
    if (pregled) {
      const plan = await this.collectChain(this.prisma, wo, line, delta);
      return {
        data: this.chainResponse(plan, delta, null),
        meta: { dry_run: true, cap: CASCADE_MAX_NODES },
      };
    }

    // UPIS. Delta NIJE idempotentna sama po sebi (dva puta primenjeno = 10 umesto 5
    // dana), pa se ključ NE izmišlja na serveru — za razliku od `reassign`-a.
    if (!dto.clientEventId) {
      throw new BadRequestException({
        message: "client_event_required",
        code: "client_event_required",
      });
    }
    const ishod = await this.idem.run(
      email,
      dto.clientEventId,
      "plan_proizvodnje.gant.shift_chain",
      (tx) => this.applyShiftChain(tx, email, dto, wo, line, delta),
      { timeoutMs: CASCADE_TX_TIMEOUT_MS },
    );
    return {
      data: ishod.result,
      meta: {
        dry_run: false,
        idempotent: ishod.idempotent,
        cap: CASCADE_MAX_NODES,
      },
    };
  }

  /** Pet koraka u JEDNOJ transakciji: plan → brave → ponovni plan → UPDATE → odgovor. */
  private async applyShiftChain(
    tx: Tx,
    email: string,
    dto: OverlayShiftChainDto,
    wo: number,
    line: number,
    delta: number,
  ) {
    // (a) plan pre brava
    const plan1 = await this.collectChain(tx, wo, line, delta);
    if (plan1.ciklus) {
      throw new UnprocessableEntityException({
        message: "predecessor_cycle",
        code: "predecessor_cycle",
        cycle: plan1.ciklus,
      });
    }

    // (b) BRAVE — ZASEBAN iskaz, kanonski redosled, nad CELIM skupom (moved + skipped).
    // 🔴 `FOR UPDATE` nad rekurzivnim CTE-om TIHO NE ZAKLJUČAVA NIŠTA: upit prođe bez
    // greške i vrati redove, ali `EXPLAIN` pokazuje samo `CTE Scan`, BEZ `LockRows`
    // (provereno na produkciji 06.08.2026). Zato OBAVEZNO dva odvojena iskaza.
    // Zaključava se i `skipped` — preskočena pozicija sme u međuvremenu da dobije termin.
    await this.lockOverlays(tx, [
      ...plan1.moved.map((r) => ({
        wo: Number(r.work_order_id),
        line: Number(r.line_id),
      })),
      ...plan1.skipped.map((r) => ({
        wo: Number(r.work_order_id),
        line: Number(r.line_id),
      })),
    ]);

    // (c) ISTI upit, sada POD BRAVOM.
    const plan2 = await this.collectChain(tx, wo, line, delta);
    // 🔴 CIKLUS NASTAO IZMEĐU DVA ČITANJA IDE NA 422, NE NA 409: ciklus je TRAJNO stanje
    // podatka, pa bi `chain_changed` (koji planera šalje da „pogleda ponovo") vratio
    // dijalog sa PRAZNOM tabelom i aktivnim dugmetom „Pomeri" — beskonačna petlja nad
    // stanjem koje se samo od sebe ne popravlja. 422 nosi ivicu koju treba razvezati.
    if (plan2.ciklus) {
      throw new UnprocessableEntityException({
        message: "predecessor_cycle",
        code: "predecessor_cycle",
        cycle: plan2.ciklus,
      });
    }
    const hash1 = this.chainHash(plan1);
    const hash2 = this.chainHash(plan2);
    if (
      hash1 !== hash2 ||
      (dto.expectedHash && dto.expectedHash !== hash2)
    ) {
      throw new ChainChangedException(this.chainResponse(plan2, delta, null));
    }

    // (d) JEDAN UPDATE nad plan2.moved.
    const parovi = plan2.moved.map((r) => ({
      wo: Number(r.work_order_id),
      line: Number(r.line_id),
    }));
    const updated = await tx.$queryRaw<
      {
        work_order_id: string;
        line_id: string;
        planned_start_at: Date | null;
        planned_end_at: Date | null;
      }[]
    >(Prisma.sql`
      UPDATE plan_proizvodnje_overlays o
         SET planned_start_at = ${this.shiftExpr(Prisma.raw("o.planned_start_at"), delta)},
             planned_end_at   = ${this.shiftEndExpr(
               Prisma.raw("o.planned_start_at"),
               Prisma.raw("o.planned_end_at"),
               delta,
             )},
             updated_by = ${email},
             updated_at = now()
       WHERE (o.work_order_id, o.line_id) IN (${this.pairsSql(parovi)})
         AND o.planned_start_at IS NOT NULL
      RETURNING o.work_order_id::text AS work_order_id, o.line_id::text AS line_id,
                o.planned_start_at, o.planned_end_at`);

    if (updated.length !== plan2.moved.length) {
      // Pod bravom je ovo nemoguće — signal je da je brava izgubljena, ne poslovni slučaj.
      throw new InternalServerErrorException(
        `Kaskada: očekivano ${plan2.moved.length} pomerenih redova, upisano ${updated.length}.`,
      );
    }

    // ── 078/26: isti pomak i u `plan_proizvodnje_termini` ───────────────────────
    //
    // 🔴 ODLUKA (Nenad 08.08.2026): kad lanac pomeri poziciju koja ima VIŠE termina,
    // pomeraju se SVI, istim pomakom. Razlog: „uslov" (veza sa prethodnikom) je
    // osobina POZICIJE, a ne pojedinačnog termina — pozicija u celini kasni ili rani.
    // Selektivno pomeranje bi razbilo redosled unutar same operacije („5 pa 3 pa 2"
    // prestalo bi da bude taj redosled), a planer nigde ne bi video zašto.
    //
    // 🔴 Zašto se termini pomeraju SAMI, a ne prepisuju sa overlay-a: overlay nosi
    // JEDNU vrednost, pa bi prepis sve termine pozicije slepio na isti datum. Svaki
    // termin zato pomera SVOJU vrednost — isti izraz (`shiftExpr`) koji je maločas
    // pomerio overlay, samo nad `t.planned_start_at`.
    //
    // 🔴 Sa SOPSTVENOM brojačkom branom. Bez nje bi podupis bio NEM: odgovor se gradi
    // iz `RETURNING`-a overlay-a, pa bi FE optimistički prerenderovao barove na nova
    // vremena dok bi termini držali stara — laž na ekranu, najgora klasa u ovom modulu.
    const ocekivanoTermina = await tx.planProizvodnjeTermin.count({
      where: { OR: parovi.map((p) => ({ workOrderId: p.wo, lineId: p.line })) },
    });
    const pomereniTermini = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE plan_proizvodnje_termini t
         SET planned_start_at = ${this.shiftExpr(Prisma.raw("t.planned_start_at"), delta)},
             planned_end_at   = ${this.shiftEndExpr(
               Prisma.raw("t.planned_start_at"),
               Prisma.raw("t.planned_end_at"),
               delta,
             )},
             updated_by = ${email},
             updated_at = now()
       WHERE (t.work_order_id, t.line_id) IN (${this.pairsSql(parovi)})
      RETURNING t.id::text AS id`);

    if (pomereniTermini.length !== ocekivanoTermina) {
      throw new InternalServerErrorException(
        `Kaskada (termini): očekivano ${ocekivanoTermina} termina, pomereno ${pomereniTermini.length}.`,
      );
    }

    // LEČENJE: pozicija koja na overlay-u ima termin a u tabeli nema nijedan red
    // (npr. overlay nastao pre 078/26). Uzima se VEĆ POMERENA vrednost sa overlay-a,
    // pa se NE sme pomerati drugi put. Bez ovoga bi kaskada — inače ispravna i
    // korisniku vidljiva radnja — pukla zbog knjigovodstva koje niko ne čita.
    // `ON CONFLICT` se NE koristi: posle Faze B jedinstvenog indeksa više nema.
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO plan_proizvodnje_termini (
        overlay_id, work_order_id, line_id,
        planned_start_at, planned_end_at, planned_duration_minutes,
        kolicina, planned_done, planned_done_at, planned_done_by,
        created_by, updated_by)
      SELECT o.id, o.work_order_id, o.line_id,
             o.planned_start_at, o.planned_end_at, o.planned_duration_minutes,
             wo.piece_count, o.planned_done, o.planned_done_at, o.planned_done_by,
             ${email}, ${email}
        FROM plan_proizvodnje_overlays o
        LEFT JOIN work_orders wo ON wo.id = o.work_order_id
       WHERE (o.work_order_id, o.line_id) IN (${this.pairsSql(parovi)})
         AND o.planned_start_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM plan_proizvodnje_termini t2 WHERE t2.overlay_id = o.id)`);

    // (e) odgovor iz RETURNING-a + hash POSLE (računa se u JS-u, bez trećeg upita).
    return this.chainResponse(plan2, delta, updated);
  }

  /**
   * Zatvorenje SLEDBENIKA sidra (rekurzivni CTE), BEZ ijedne brave — brave uzima
   * pozivalac zasebnim iskazom (v. `applyShiftChain` korak b).
   *
   * 🔴 DVA PONAŠANJA KOJA SE NAJLAKŠE POBRKAJU: **hod** (rekurzija) prolazi KROZ svaki
   * čvor bez obzira na klasu; **preskok** se odnosi ISKLJUČIVO na upis. Da se hod
   * zaustavljao na bezterminskom čvoru, lanac bi tiho pucao na 4 mesta i planer to
   * nigde ne bi video.
   *
   * `LEFT JOIN` ka `work_order_operations`/`work_orders`/`operations` je namerno LEFT:
   * orfan overlay (veza na operaciju koja više ne postoji) mora da OSTANE u rezultatu i
   * da se KLASIFIKUJE, a ne da tiho ispadne iz oba skupa.
   *
   * 🔴 ALIASI PODUPITA SU UGOVOR, NE STIL: `IS_COMPLETED_EFFECTIVE` je jedan izraz
   * deljen sa read slojem, pa OVDE moraju da postoje TAČNO oni aliasi koje on pominje —
   * danas `base` (uz `base.ov_planned_done`), `tr` i `tp`.
   *
   * 08.08.2026 je taj ugovor prekršen i posledica je bila TIHA i POTPUNA: izraz je
   * 07.08. prešao na `tp.planned_done`, a ovaj upit nema alias `tp` — Postgres baca
   * „missing FROM-clause entry for table tp", pa je `POST /overlays/shift-chain` pucao
   * na SVAKI poziv, uključujući `dryRun`. To je jedini put prevlačenja bara na gantu,
   * dakle planer je na svako prevlačenje dobijao grešku. Nijedan test to nije uhvatio
   * jer `plan-proizvodnje.mutations.spec.ts` mokuje `$queryRaw` — SQL se nikad ne
   * izvršava. Zato ovde stoji i test koji EXPLAIN-uje izraz nad pravom bazom nije
   * moguć bez nje; jedina brana je ovaj komentar + provera aliasa pri svakoj izmeni
   * deljenog izraza.
   *
   * ⚠️ ODSTUPANJE OD SPECIFIKACIJE (izmereno, ne pretpostavljeno): specifikacija je
   * tražila `GROUP BY` + `(array_agg(putanja_txt ORDER BY …))[1]`. Oba dela tog izraza
   * su neispravna u PostgreSQL-u i provereno na produkciji 06.08.2026:
   *   1. `(array_agg(text[]))[1]` vraća **NULL** (jedan indeks nad 2-D nizom), pa
   *      prijava ciklusa nikad ne bi nosila putanju;
   *   2. `array_agg` nad putanjama RAZLIČITE dužine je tvrda greška
   *      („cannot accumulate arrays of different dimensionality") — a različite dužine
   *      pravi TAČNO ciklus, tj. jedini slučaj zbog kog izraz i postoji. Umesto čistog
   *      422 `predecessor_cycle` planer bi dobio 500.
   * Zamena je `DISTINCT ON (work_order_id, line_id)` + prozorske `min`/`bool_or`:
   * `min(dubina)` i `bool_or(je_ciklus)` su identični, a putanja dolazi iz izabranog
   * reda (ciklični prvi, inače najplići) i stvarno je popunjena.
   *
   * ⚠️ Prozorski `min` se zove `dubina_min`, NE `dubina`: golo ime u `ORDER BY` se prvo
   * razrešava kao IZLAZNI alias, pa bi `ORDER BY … dubina ASC` sortirao po
   * `min() OVER (…)` — konstanti unutar particije, tj. MRTAV izraz koji ne bira najplići
   * red. Sa `dubina_min` se `dubina` razrešava kao ULAZNA kolona `succ.dubina` i izbor
   * putanje je stvaran.
   *
   * 🔴 KAPA DUBINE MORA DA SE ČUJE: rekurzija ide do `CASCADE_MAX_DEPTH + 1` (`<=`), pa
   * se posle materijalizacije baca `cascade_too_deep`. Sa `<` bi se lanac dublji od kape
   * TIHO prepolovio: server bi mirno pomerio prvih 51 poziciju i javio „Pomereno 51", a
   * rep bi ostao na starim terminima — čime bi se trajno pokvarili baš oni razmaci koje
   * funkcija obećava da čuva.
   */
  private async collectChain(
    db: ChainDb,
    wo: number,
    line: number,
    delta: number,
  ): Promise<ChainPlan> {
    const rows = await db.$queryRaw<ChainRow[]>(Prisma.sql`
      WITH RECURSIVE succ AS (
        SELECT o.work_order_id, o.line_id, 0 AS dubina,
               ARRAY[o.work_order_id || ':' || o.line_id] AS putanja_txt
          FROM plan_proizvodnje_overlays o
         WHERE o.work_order_id = ${wo} AND o.line_id = ${line}
        UNION ALL                                 -- CYCLE klauzula TRAŽI UNION ALL
        SELECT n.work_order_id, n.line_id, s.dubina + 1,
               s.putanja_txt || (n.work_order_id || ':' || n.line_id)
          FROM plan_proizvodnje_overlays n
          JOIN succ s ON n.predecessor_work_order_id = s.work_order_id
                     AND n.predecessor_line          = s.line_id
         WHERE s.dubina <= ${CASCADE_MAX_DEPTH}
      ) CYCLE work_order_id, line_id SET je_ciklus USING pg_putanja
      , cvor AS (
        SELECT DISTINCT ON (work_order_id, line_id)
               work_order_id, line_id,
               min(dubina)        OVER (PARTITION BY work_order_id, line_id) AS dubina_min,
               bool_or(je_ciklus) OVER (PARTITION BY work_order_id, line_id) AS ciklus,
               putanja_txt
          FROM succ
         ORDER BY work_order_id, line_id, je_ciklus DESC, dubina ASC
      )
      SELECT c.work_order_id::text AS work_order_id,
             c.line_id::text       AS line_id,
             c.dubina_min AS dubina, c.ciklus, c.putanja_txt,
             base.planned_start_at, base.planned_end_at,
             ${this.shiftExpr(Prisma.raw("base.planned_start_at"), delta)} AS novi_start,
             ${this.shiftEndExpr(
               Prisma.raw("base.planned_start_at"),
               Prisma.raw("base.planned_end_at"),
               delta,
             )} AS novi_end,
             (base.line_id_raw IS NULL)     AS orfan,
             (base.archived_at IS NOT NULL) AS arhivirano,
             base.rn_ident_broj, base.operacija, base.broj_crteza, base.effective_machine_code,
             COALESCE(${IS_COMPLETED_EFFECTIVE}, false) AS zavrseno
        FROM cvor c
        JOIN LATERAL (
          SELECT o.id AS overlay_id,
                 o.planned_start_at, o.planned_end_at, o.planned_done, o.archived_at,
                 -- 🔴 078/26: IS_COMPLETED_EFFECTIVE od 07.08. čita ov_planned_done
                 -- (override sa overlay-a) kao REZERVU ispod termina. Bez ovog aliasa
                 -- ceo shift-chain puca sa „missing FROM-clause entry".
                 o.planned_done AS ov_planned_done,
                 l.id AS line_id_raw, l.work_order_id AS wo_raw,
                 l.operation_number AS operacija,
                 COALESCE(o.assigned_machine_code, NULLIF(BTRIM(l.work_center_code), '')) AS effective_machine_code,
                 wo.piece_count AS komada_total,
                 COALESCE(NULLIF(BTRIM(wo.ident_number), ''), '(no-' || wo.id || ')') AS rn_ident_broj,
                 NULLIF(BTRIM(wo.drawing_number), '') AS broj_crteza,
                 COALESCE(m.without_process, false) AS is_non_machining
            FROM plan_proizvodnje_overlays o
            LEFT JOIN work_order_operations l ON l.work_order_id = o.work_order_id AND l.id = o.line_id
            LEFT JOIN work_orders wo ON wo.id = l.work_order_id
            LEFT JOIN operations m  ON m.work_center_code = l.work_center_code
           WHERE o.work_order_id = c.work_order_id AND o.line_id = c.line_id
        ) base ON true
        -- 🔴 078/26: IS_COMPLETED_EFFECTIVE je deljen sa read slojem i od 07.08.
        -- traži alias tp (termin). Bez njega ceo shift-chain pada na
        -- „missing FROM-clause entry for table tp" — dakle prevlačenje bara na gantu
        -- prestaje da radi, i to NA SVAKI POZIV, uključujući dryRun.
        -- Isto pravilo kao u čitanju: NAJRANIJI NEZAVRŠEN termin.
        LEFT JOIN LATERAL (
          SELECT t.planned_done
            FROM plan_proizvodnje_termini t
           WHERE t.overlay_id = base.overlay_id
           ORDER BY COALESCE(t.planned_done, false) ASC, t.planned_start_at ASC, t.id ASC
           LIMIT 1
        ) tp ON TRUE
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(t.piece_count) FILTER (WHERE t.quality_type_id = 0), 0) AS good_done,
                 bool_or(COALESCE(t.is_process_finished, false)) AS is_done
            FROM tech_processes t
           WHERE t.work_order_id = base.wo_raw AND t.operation_number = base.operacija
        ) tr ON true
       ORDER BY c.dubina_min, c.work_order_id, c.line_id`);

    if (rows.length === 0) {
      throw new NotFoundException({
        message: "overlay_not_found",
        code: "overlay_not_found",
      });
    }

    const ciklicni = rows.filter((r) => r.ciklus);
    if (ciklicni.length > 0) {
      const putanja = ciklicni[0].putanja_txt ?? [];
      const ivica =
        putanja.length >= 2
          ? `${putanja[putanja.length - 2]} -> ${putanja[putanja.length - 1]}`
          : (putanja[0] ?? `${wo}:${line}`);
      return {
        ciklus: { putanja, ivica },
        sidro: rows[0],
        moved: [],
        skipped: [],
        dubinaMax: 0,
        zahvat: rows.length,
      };
    }

    // KAPA DUBINE JE DODIRNUTA (rekurzija je puštena JEDAN nivo preko kape baš da bi se
    // to videlo). Tiho sečenje repa je gore od odbijanja: pomerila bi se glava lanca, a
    // rep bi ostao — tj. pokvarili bi se razmaci koje ova funkcija čuva.
    const najdublji = rows.reduce((m, r) => Math.max(m, Number(r.dubina) || 0), 0);
    if (najdublji > CASCADE_MAX_DEPTH) {
      throw new UnprocessableEntityException({
        message: "cascade_too_deep",
        code: "cascade_too_deep",
        dubina: najdublji,
        cap: CASCADE_MAX_DEPTH,
      });
    }

    if (rows.length > CASCADE_MAX_NODES) {
      throw new UnprocessableEntityException({
        message: "cascade_too_large",
        code: "cascade_too_large",
        zahvat: rows.length,
        cap: CASCADE_MAX_NODES,
      });
    }

    const sidro = rows[0]; // dubina 0, uvek tačno jedan
    // 🔴 SIDRO JE IZUZETO SAMO OD `zavrseno` (presuđena odluka — koren izmerenog lanca
    // 3.40 JESTE završen). Mrtva veza i arhivirana pozicija se sude ISTO i nad sidrom:
    // inače isti red dobija dve suprotne presude — kao sidro se pomeri, a kao TUĐ
    // sledbenik se preskoči uz obrazloženje „pozicija je arhivirana".
    if (sidro.orfan) {
      throw new UnprocessableEntityException({
        message: "anchor_orphan",
        code: "anchor_orphan",
      });
    }
    if (sidro.arhivirano) {
      throw new UnprocessableEntityException({
        message: "anchor_archived",
        code: "anchor_archived",
      });
    }
    if (sidro.planned_start_at == null) {
      throw new UnprocessableEntityException({
        message: "anchor_without_terms",
        code: "anchor_without_terms",
      });
    }

    const moved: ChainRow[] = [];
    const skipped: SkippedRow[] = [];
    const skip = (r: ChainRow, kod: SkipKod) =>
      skipped.push({ ...r, razlog_kod: kod, razlog: SKIP_RAZLOZI[kod] });
    for (const r of rows) {
      // SIDRO SE NE PRESKAČE NIKAD — izričita radnja planera (a orfan/arhivirano su
      // već presuđeni gore, pa ovde ostaje samo `zavrseno` kao izuzetak).
      if (Number(r.work_order_id) === wo && Number(r.line_id) === line) {
        moved.push(r);
        continue;
      }
      if (r.orfan) skip(r, "orfan");
      else if (r.arhivirano) skip(r, "arhivirano");
      else if (r.planned_start_at == null) skip(r, "bez_termina");
      else if (r.zavrseno) skip(r, "zavrseno");
      else moved.push(r);
    }

    return {
      ciklus: null,
      sidro,
      moved,
      skipped,
      dubinaMax: najdublji,
      zahvat: rows.length,
    };
  }

  /**
   * Kanonski otisak STANJA lanca (skup + termini + klasifikacija) — ne zahteva.
   *
   * Koristi se na tačno dva mesta i ni na jednom više:
   *  • interno: `hash(plan1) !== hash(plan2)` POD BRAVOM → `409 chain_changed`
   *    (strože je i jeftinije od poređenja samih ključeva);
   *  • kao `expectedHash` kad je planer potvrdio listu u dijalogu ili kliknuo „Poništi".
   *
   * `posle` (opciono) zamenjuje termine pomerenih redova — tako se `hash_after` računa
   * bez trećeg upita u bazu.
   */
  private chainHash(
    plan: ChainPlan,
    posle?: Map<string, { start: Date | null; end: Date | null }>,
  ): string {
    const t = (d: Date | null) => (d ? String(new Date(d).getTime()) : "-");
    const stavke: { kljuc: string; klasa: string; start: Date | null; end: Date | null }[] = [
      ...plan.moved.map((r) => ({
        kljuc: `${r.work_order_id}:${r.line_id}`,
        klasa: KLASA_SLOVO.moved,
        start: r.planned_start_at,
        end: r.planned_end_at,
      })),
      ...plan.skipped.map((r) => ({
        kljuc: `${r.work_order_id}:${r.line_id}`,
        klasa: KLASA_SLOVO[r.razlog_kod],
        start: r.planned_start_at,
        end: r.planned_end_at,
      })),
    ];
    const red = stavke
      .map((s) => {
        const n = posle?.get(s.kljuc);
        return n ? { ...s, start: n.start, end: n.end } : s;
      })
      .sort((a, b) => a.kljuc.localeCompare(b.kljuc))
      .map((s) => `${s.kljuc}|${s.klasa}|${t(s.start)}|${t(s.end)}`)
      .join(";");
    return createHash("sha256").update(red).digest("hex").slice(0, 16);
  }

  /**
   * Telo odgovora kaskade.
   *
   * 🔴 JSON-STABILNOST JE USLOV, NE KOZMETIKA: `IdempotencyService` čuva
   * `JSON.stringify(result)` u `jsonb`, pa PONOVLJEN poziv vraća ISO **stringove**.
   * Zato se termini ovde već pretvaraju u `.toISOString()` — inače bi prvi poziv vraćao
   * `Date`, a retry string, i FE ušivanje bi puklo tek na ponavljanju.
   *
   * Razlike po režimu:
   *  • pregled (`updated === null`): `stavke[].planned_*` nose STARO stanje, a
   *    `new_start`/`new_end` NOVO (izračunato ISTIM SQL izrazom kao UPDATE);
   *  • upis: `stavke[].planned_*` nose NOVO stanje iz `RETURNING`, `new_*` su `null`.
   */
  private chainResponse(
    plan: ChainPlan,
    delta: number,
    updated:
      | {
          work_order_id: string;
          line_id: string;
          planned_start_at: Date | null;
          planned_end_at: Date | null;
        }[]
      | null,
  ) {
    const iso = (d: Date | null | undefined) =>
      d ? new Date(d).toISOString() : null;
    const posle = updated
      ? new Map(
          updated.map((u) => [
            `${u.work_order_id}:${u.line_id}`,
            { start: u.planned_start_at, end: u.planned_end_at },
          ]),
        )
      : null;

    const stavke = plan.moved.map((r) => {
      const n = posle?.get(`${r.work_order_id}:${r.line_id}`);
      return {
        work_order_id: r.work_order_id,
        line_id: r.line_id,
        dubina: Number(r.dubina) || 0,
        rn_ident_broj: r.rn_ident_broj,
        operacija: r.operacija,
        broj_crteza: r.broj_crteza,
        machine: r.effective_machine_code,
        planned_start_at: iso(n ? n.start : r.planned_start_at),
        planned_end_at: iso(n ? n.end : r.planned_end_at),
        new_start: posle ? null : iso(r.novi_start),
        new_end: posle ? null : iso(r.novi_end),
      };
    });
    const preskoceno = plan.skipped.map((r) => ({
      work_order_id: r.work_order_id,
      line_id: r.line_id,
      dubina: Number(r.dubina) || 0,
      rn_ident_broj: r.rn_ident_broj,
      operacija: r.operacija,
      broj_crteza: r.broj_crteza,
      machine: r.effective_machine_code,
      razlog_kod: r.razlog_kod,
      razlog: r.razlog,
    }));
    const zavrsenih = plan.skipped.filter(
      (r) => r.razlog_kod === "zavrseno",
    ).length;

    return jsonSafe({
      sidro: plan.sidro
        ? {
            work_order_id: plan.sidro.work_order_id,
            line_id: plan.sidro.line_id,
            rn_ident_broj: plan.sidro.rn_ident_broj,
            operacija: plan.sidro.operacija,
            machine: plan.sidro.effective_machine_code,
          }
        : null,
      delta_dana: delta,
      zahvat: plan.zahvat,
      dubina_max: plan.dubinaMax,
      hash: this.chainHash(plan),
      hash_after: posle ? this.chainHash(plan, posle) : null,
      /**
       * 🔴 NAMERNO NIJE `preskoceno > 0`: bezterminski list je TRAJNO svojstvo lanca
       * (na 3.40 vise na dubinama 3 i 4), pa bi se dijalog otvarao na SVAKI potez i
       * naučio planera da klikće naslepo.
       */
      needs_confirm: stavke.length > 8 || zavrsenih > 0,
      totals: {
        pomereno: stavke.length,
        preskoceno: preskoceno.length,
        preskoceno_zavrsenih: zavrsenih,
      },
      stavke,
      preskoceno,
      ciklus: plan.ciklus,
    });
  }

  /**
   * KANON ZAKLJUČAVANJA `plan_proizvodnje_overlays`: `(work_order_id, line_id)` RASTUĆE.
   * Svaki pisac koji uzima više od jednog reda ove tabele mora da poštuje isti kanon.
   *
   * 🔴 DOMET OVE BRAVE JE OGRANIČEN, I TO SE MORA ZNATI: `SELECT … FOR UPDATE` zaključava
   * SAMO REDOVE KOJI POSTOJE. Izmereno na produkciji: od 217.732 operacija samo 242 ima
   * overlay red. Za pisce koji rade `upsert` (`reorderOverlays`, `bulkReassign`) to znači
   * da je za 217.490 parova ovaj poziv no-op, a stvarnu bravu uzme tek INSERT na unique
   * indeksu `uq_…_wo_line` — redosledom kojim petlja ide. Zato oba ta pisca SORTIRAJU
   * ulaz po `(wo, line)` pre petlje; ova brava je dopuna (postojeći redovi, jedan iskaz,
   * odmah na početku transakcije), ne zamena za kanonski redosled upisa.
   *
   * Kaskada (`shiftChain`) je jedini potrošač kom je brava dovoljna sama: ona radi
   * isključivo `UPDATE` nad redovima koje je `collectChain` već našao, dakle nad
   * postojećim redovima.
   *
   * Zašto ne advisory lock po mašini (iako je danas 34/34 veza unutar iste mašine): to
   * je svojstvo PODATAKA, ne modela. Gest bar-na-bar dozvoljava vezu preko mašina, a
   * `reassign` iz dijaloga ume postojeću vezu tiho da učini međumašinskom — ključ po
   * mašini bi tada propustio da serijalizuje baš onaj slučaj zbog kog brava postoji.
   */
  private async lockOverlays(
    tx: Tx,
    parovi: { wo: number; line: number }[],
  ): Promise<void> {
    if (parovi.length === 0) return;
    await tx.$queryRaw(Prisma.sql`
      SELECT work_order_id, line_id
        FROM plan_proizvodnje_overlays
       WHERE (work_order_id, line_id) IN (${this.pairsSql(parovi)})
       ORDER BY work_order_id, line_id
       FOR UPDATE`);
  }

  /** `VALUES (a::int, b::int), …` za `IN`-listu parova (uvek neprazna kod pozivaoca). */
  private pairsSql(parovi: { wo: number; line: number }[]): Prisma.Sql {
    return Prisma.sql`VALUES ${Prisma.join(
      parovi.map((p) => Prisma.sql`(${p.wo}::int, ${p.line}::int)`),
      ", ",
    )}`;
  }

  /**
   * Pomak termina za CELE KALENDARSKE DANE u zoni plana. Isti izraz koristi i pregled
   * (`novi_start`/`novi_end`) i UPDATE — zato pregled ne može da se razidje sa upisom.
   * `::int` na delti je obavezan: Prisma parametar nije nužno `integer`, a
   * `make_interval(days => …)` ne prima bigint kroz implicitni cast.
   */
  private shiftExpr(col: Prisma.Sql, delta: number): Prisma.Sql {
    return Prisma.sql`CASE WHEN ${col} IS NULL THEN NULL
             ELSE ((${col} ${AT_PLAN_TZ} + make_interval(days => ${delta}::int)) ${AT_PLAN_TZ}) END`;
  }

  /**
   * Isto kao `shiftExpr`, ali KRAJ ne sme da padne pre POČETKA.
   *
   * 🔴 PRELAZ NA LETNJE VREME PRAVI KRAJ PRE POČETKA: pozicija koja traje `02:30 → 03:00`
   * pomerena NA dan prelaska (npr. 2027-03-28, kad lokalnog sata 02:30 nema) dobija
   * početak koji „preskoči" u 03:30, a kraj ostane 03:00. To je stanje koje redovan upis
   * odbija sa 422 (`assertPlanConsistent` → `planned_end_before_start`), a kaskada ga
   * upisuje jer tu proveru ne zove. `GREATEST` je najjeftinija brana koja to ne dozvoljava.
   *
   * Spoljni `CASE` je OBAVEZAN: `GREATEST` u PostgreSQL-u IGNORIŠE `NULL`, pa bi red bez
   * `planned_end_at` (izveden kraj iz tehnologije) dobio kraj = novi početak i time bi se
   * „auto iz tehnologije" TIHO ugasilo.
   */
  private shiftEndExpr(
    startCol: Prisma.Sql,
    endCol: Prisma.Sql,
    delta: number,
  ): Prisma.Sql {
    return Prisma.sql`CASE WHEN ${endCol} IS NULL THEN NULL
             ELSE GREATEST(${this.shiftExpr(endCol, delta)}, ${this.shiftExpr(startCol, delta)}) END`;
  }

  // ==========================================================================
  // Urgency (HITNO) — set/clear, DELETE nikad
  // ==========================================================================

  /** HITNO set (merge upsert; reset cleared_*). Unique work_order_id, DELETE nikad. */
  async setUrgent(email: string, workOrderId: string, dto: SetUrgentDto) {
    const wo = Number(workOrderId);
    const reason = (dto.reason ?? "").trim() || null;
    const row = await this.prisma.planProizvodnjeUrgency.upsert({
      where: { workOrderId: wo },
      create: { workOrderId: wo, isUrgent: true, reason, setBy: email },
      update: {
        isUrgent: true,
        reason,
        setBy: email,
        setAt: new Date(),
        clearedAt: null,
        clearedBy: null,
      },
    });
    return { data: jsonSafe(row) };
  }

  /** HITNO clear = flag off + cleared_* (NE briše red; paritet 1.0 clearUrgent). */
  async clearUrgent(email: string, workOrderId: string) {
    const wo = Number(workOrderId);
    const row = await this.prisma.planProizvodnjeUrgency.upsert({
      where: { workOrderId: wo },
      create: {
        workOrderId: wo,
        isUrgent: false,
        clearedAt: new Date(),
        clearedBy: email,
      },
      update: { isUrgent: false, clearedAt: new Date(), clearedBy: email },
    });
    return { data: jsonSafe(row) };
  }

  // ==========================================================================
  // Reassign (port sy15 reassign_production_line)
  // ==========================================================================

  /**
   * Reassign jedne linije (verni port RPC-a). `canForce` = da li korisnik ima
   * `plan_proizvodnje.force` (kontroler računa iz role) — BE je konačni gate.
   * group-mismatch bez force → 422; force bez prava → 403; force_reason<3 → 422.
   */
  async reassign(email: string, dto: ReassignDto, canForce: boolean) {
    const cev = dto.clientEventId ?? randomUUID();
    return this.prisma.$transaction((tx) =>
      this.reassignOne(
        tx,
        email,
        canForce,
        Number(dto.workOrderId),
        Number(dto.lineId),
        dto.targetMachine ?? null,
        !!dto.force,
        dto.reason ?? null,
        cev,
      ),
    );
  }

  /**
   * Bulk reassign (JEDAN client_event_uuid za ceo bulk; paritet 1.0).
   *
   * 🔴 075/26 (treći krug): KANONSKI REDOSLED UPISA + pre-lock, iz istog razloga i sa
   * istim merenjem kao u `reorderOverlays` — 217.490 od 217.732 parova NEMA overlay red,
   * pa `FOR UPDATE` nad njima ne uzima ništa i brava ostaje ona koju INSERT uzme na
   * unique indeksu. `reassign-dialog.tsx` šalje parove redom kako stoje NA EKRANU (hala /
   * mašina / `shift_sort_order`), a kaskada i reorder idu po `(work_order_id, line_id)`.
   * Oba gesta se pokreću sa ISTOG ekrana („Po mašini": prevlačenje redosleda + „Premesti"
   * nad izborom), pa je bez sortiranja par (reorder ↔ bulkReassign) živ `40P01` posle
   * `deadlock_timeout = 1 s` — planeru vidljiv kao 500.
   *
   * Redosled parova ovde NE nosi značenje (svi idu na istu ciljnu mašinu, sa istim
   * `client_event_uuid`), pa se sortira sam ulaz.
   */
  async bulkReassign(email: string, dto: BulkReassignDto, canForce: boolean) {
    const cev = dto.clientEventId ?? randomUUID();
    const parovi = dto.pairs
      .map((p) => ({ wo: Number(p.workOrderId), line: Number(p.lineId) }))
      .sort((a, b) => a.wo - b.wo || a.line - b.line);
    return this.prisma.$transaction(async (tx) => {
      await this.lockOverlays(tx, parovi);
      let count = 0;
      for (const p of parovi) {
        await this.reassignOne(
          tx,
          email,
          canForce,
          p.wo,
          p.line,
          dto.targetMachine ?? null,
          !!dto.force,
          dto.reason ?? null,
          cev,
        );
        count += 1;
      }
      return { data: { updated_count: count } };
    });
  }

  /** Jedan reassign u tx — overlay upsert + (ako forsiran) audit ON CONFLICT DO NOTHING. */
  private async reassignOne(
    tx: Tx,
    email: string,
    canForce: boolean,
    wo: number,
    line: number,
    targetRaw: string | null,
    force: boolean,
    reason: string | null,
    cev: string,
  ) {
    const rows = await tx.$queryRaw<
      { original_machine: string | null; source_machine: string | null }[]
    >(Prisma.sql`
      SELECT NULLIF(BTRIM(l.work_center_code), '') AS original_machine,
             COALESCE(o.assigned_machine_code, NULLIF(BTRIM(l.work_center_code), '')) AS source_machine
        FROM work_order_operations l
        LEFT JOIN plan_proizvodnje_overlays o
          ON o.work_order_id = l.work_order_id AND o.line_id = l.id
       WHERE l.work_order_id = ${wo} AND l.id = ${line} LIMIT 1`);
    const original = rows[0]?.original_machine ?? null;
    const source = rows[0]?.source_machine ?? null;
    if (original === null) {
      throw new UnprocessableEntityException("operation_not_found");
    }

    let target: string | null = (targetRaw ?? "").trim() || null;
    // Izbor originalne mašine = „vrati na original" = NULL overlay.
    if (target !== null && target === original) target = null;

    let sourceGroup: string;
    let targetGroup: string;
    let forced = false;

    if (target !== null) {
      const exists = await tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`
        SELECT EXISTS (SELECT 1 FROM operations m WHERE m.work_center_code = ${target}) AS ok`);
      if (!exists[0]?.ok) {
        throw new UnprocessableEntityException("target_machine_not_found");
      }
      sourceGroup = machineGroupSlug(source);
      targetGroup = machineGroupSlug(target);
      if (sourceGroup !== targetGroup) {
        if (!force) {
          throw new UnprocessableEntityException("machine_group_mismatch");
        }
        if (!canForce) {
          throw new ForbiddenException("force_reassign_forbidden");
        }
        if (reason === null || reason.trim().length < 3) {
          throw new UnprocessableEntityException("force_reason_required");
        }
        forced = true;
      }
    } else {
      sourceGroup = machineGroupSlug(source);
      targetGroup = machineGroupSlug(original);
    }

    await tx.planProizvodnjeOverlay.upsert({
      where: { workOrderId_lineId: { workOrderId: wo, lineId: line } },
      create: {
        workOrderId: wo,
        lineId: line,
        assignedMachineCode: target,
        createdBy: email,
        updatedBy: email,
      },
      update: { assignedMachineCode: target, updatedBy: email },
    });

    if (forced) {
      // Idempotencija po (client_event_uuid, line_id) — paritet sy15
      // `ON CONFLICT (client_event_uuid, line_id) DO NOTHING`.
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO plan_proizvodnje_reassign_audit
          (work_order_id, line_id, actor_email, from_machine_code, to_machine_code,
           source_group, target_group, forced, force_reason, client_event_uuid)
        VALUES (${wo}, ${line}, ${email}, ${source}, ${target},
                ${sourceGroup}, ${targetGroup}, true, ${reason!.trim()}, ${cev}::uuid)
        ON CONFLICT (client_event_uuid, line_id) DO NOTHING`);
    }

    return {
      data: {
        work_order_id: String(wo),
        line_id: String(line),
        assigned_machine_code: target,
        source_group: sourceGroup,
        target_group: targetGroup,
        forced,
      },
    };
  }

  // ==========================================================================
  // Kooperacija — auto grupe (admin; DELETE nikad, soft removed_at)
  // ==========================================================================

  /** Upsert auto-koop grupe (ON CONFLICT rj_group_code; restore = removed_at→NULL). */
  async upsertCooperationGroup(email: string, dto: CooperationGroupUpsertDto) {
    const rows = await this.prisma.$queryRaw(Prisma.sql`
      INSERT INTO plan_proizvodnje_auto_cooperation_groups
          (rj_group_code, group_label, notes, added_by, added_at)
        VALUES (${dto.rjGroupCode}, ${dto.groupLabel}, ${dto.notes ?? null}, ${email}, now())
        ON CONFLICT (rj_group_code) DO UPDATE SET
          group_label = EXCLUDED.group_label,
          notes = EXCLUDED.notes,
          removed_at = NULL, removed_by = NULL
        RETURNING rj_group_code, group_label, notes, added_at, added_by, removed_at, removed_by`);
    return { data: jsonSafe((rows as unknown[])[0] ?? null) };
  }

  /** Izmena/soft-remove/restore auto-koop grupe. */
  async patchCooperationGroup(
    email: string,
    code: string,
    dto: CooperationGroupPatchDto,
  ) {
    const sets: Prisma.Sql[] = [];
    if (dto.groupLabel !== undefined)
      sets.push(Prisma.sql`group_label = ${dto.groupLabel}`);
    if (dto.notes !== undefined) sets.push(Prisma.sql`notes = ${dto.notes}`);
    if (dto.removed !== undefined) {
      sets.push(
        dto.removed
          ? Prisma.sql`removed_at = now(), removed_by = ${email}`
          : Prisma.sql`removed_at = NULL, removed_by = NULL`,
      );
    }
    if (!sets.length)
      throw new BadRequestException("Nema polja za izmenu grupe.");
    const rows = await this.prisma.$queryRaw<unknown[]>(Prisma.sql`
      UPDATE plan_proizvodnje_auto_cooperation_groups
        SET ${Prisma.join(sets, ", ")}
        WHERE rj_group_code = ${code}
        RETURNING rj_group_code, group_label, notes, added_at, added_by, removed_at, removed_by`);
    if (!rows.length)
      throw new NotFoundException(`Koop grupa ${code} ne postoji`);
    return { data: jsonSafe(rows[0]) };
  }

  // ==========================================================================
  // Skice (plan_proizvodnje_drawings) — bytea (M1)
  // ==========================================================================

  /**
   * Upload skice (bytea u bazi, M1 — nema object storage). Format presuđuje SADRŽAJ
   * (`assertAttachment` iz `common/attachments`; JPG/PNG/PDF), pa se u `content_type`
   * upisuje kanonska vrednost — ne ono što je klijent prijavio. Autorizacija =
   * kontroler `plan_proizvodnje.edit`. Vraća meta bez binarnog sadržaja.
   */
  async uploadDrawing(
    email: string,
    workOrder: string,
    line: string,
    file?: Express.Multer.File,
  ) {
    if (!file?.buffer?.length) {
      throw new UnprocessableEntityException("Očekivan fajl (multipart `file`)");
    }
    const { contentType } = assertAttachment(file);
    const row = await this.prisma.planProizvodnjeDrawing.create({
      data: {
        workOrderId: Number(workOrder),
        lineId: Number(line),
        fileName: file.originalname,
        contentType,
        pdfBinary: new Uint8Array(file.buffer),
        sizeBytes: file.size ? BigInt(file.size) : null,
        uploadedBy: email,
      },
      select: {
        id: true,
        workOrderId: true,
        lineId: true,
        fileName: true,
        contentType: true,
        sizeBytes: true,
        uploadedAt: true,
        uploadedBy: true,
      },
    });
    return {
      data: jsonSafe({
        id: String(row.id),
        workOrderId: String(row.workOrderId),
        lineId: row.lineId != null ? String(row.lineId) : null,
        storagePath: null,
        fileName: row.fileName,
        mimeType: row.contentType,
        sizeBytes: row.sizeBytes != null ? Number(row.sizeBytes) : null,
        uploadedAt: row.uploadedAt,
        uploadedBy: row.uploadedBy,
      }),
    };
  }

  /** Soft-delete skice (deleted_at/by). Idempotentno (već obrisano → 200). */
  async deleteDrawing(email: string, id: string) {
    const idNum = Number(id);
    const d = await this.prisma.planProizvodnjeDrawing.findUnique({
      where: { id: idNum },
      select: { deletedAt: true },
    });
    if (!d) throw new NotFoundException(`Skica ${id} ne postoji`);
    await this.prisma.planProizvodnjeDrawing.updateMany({
      where: { id: idNum, deletedAt: null },
      data: { deletedAt: new Date(), deletedBy: email },
    });
    return { data: { id } };
  }

  // ---------- interno ----------

  /** 'YYYY-MM-DD' → Date za @db.Date (undefined = ne diraj, null = obriši). */
  private toDbDate(v?: string | null): Date | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    return new Date(`${v.slice(0, 10)}T00:00:00Z`);
  }

  /** ISO string → Date za @db.Timestamptz (undefined = ne diraj, null/'' = obriši). */
  private toDbTs(v?: string | null): Date | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      throw new UnprocessableEntityException("invalid_timestamp");
    }
    return d;
  }

  // ==========================================================================
  // Šifrarnik hala (zahtev 046/26 F0) — mašina → hala, ručno
  // ==========================================================================

  /**
   * Dodela hale mašini (upsert po `machine_code`). Mašina mora postojati u `operations`
   * (šifarnik radnih mesta) — inače 422 `machine_not_found`. Prazan `hall` NIJE dozvoljen;
   * uklanjanje dodele ide kroz `deleteMachineHall` (mašina tad pada u grupu „Bez hale").
   */
  async upsertMachineHall(
    email: string,
    machineCode: string,
    dto: MachineHallUpsertDto,
  ) {
    const code = (machineCode ?? "").trim();
    const hall = (dto.hall ?? "").trim();
    if (!code) throw new BadRequestException("Nedostaje šifra mašine.");
    if (!hall) throw new UnprocessableEntityException("hall_required");
    const exists = await this.prisma.$queryRaw<{ ok: boolean }[]>(Prisma.sql`
      SELECT EXISTS (SELECT 1 FROM operations m WHERE m.work_center_code = ${code}) AS ok`);
    if (!exists[0]?.ok) {
      throw new UnprocessableEntityException("machine_not_found");
    }
    const row = await this.prisma.planProizvodnjeMachineHall.upsert({
      where: { machineCode: code },
      create: {
        machineCode: code,
        hall,
        sortOrder: dto.sortOrder ?? null,
        note: dto.note ?? null,
        updatedBy: email,
      },
      update: {
        hall,
        sortOrder: dto.sortOrder ?? null,
        note: dto.note ?? null,
        updatedBy: email,
      },
    });
    return { data: jsonSafe(row) };
  }

  /** Skidanje dodele (mašina → „Bez hale"). Idempotentno (nema reda → 200). */
  async deleteMachineHall(_email: string, machineCode: string) {
    const code = (machineCode ?? "").trim();
    if (!code) throw new BadRequestException("Nedostaje šifra mašine.");
    await this.prisma.planProizvodnjeMachineHall.deleteMany({
      where: { machineCode: code },
    });
    return { data: { machineCode: code } };
  }
// ═══════════════════════ TERMINI (078/26 Faza B) ═══════════════════════════
  //
  // Ista operacija sme da stoji u planu VIŠE PUTA. `overlays` ostaje za STANJE
  // operacije; ovde je vremenska osa, jedan red po terminu.

  /**
   * Nov termin za operaciju.
   *
   * Overlay se po potrebi PRAVI (pozicija ne mora ranije biti dirana), jer termin
   * visi o njemu. Količina se ne ograničava na plan operacije — planer sme da
   * isplanira i više (dorada, škart) i manje (deo serije ide kasnije); jedina
   * brana je da je pozitivna, iz DTO-a.
   *
   * 🔴 Dok traje Faza A/B-priprema, jedinstveni indeks `uq_..._termini_overlay_faza_a`
   * dozvoljava SAMO JEDAN termin po operaciji, pa drugi poziv pada na P2002. To je
   * NAMERNO: ruta postoji i testirana je, ali se stvarno otvara tek kad se indeks
   * skine. Greška se prevodi u 409 sa jasnim tekstom umesto sirovog 500.
   */
  async createTermin(email: string, dto: TerminCreateDto) {
    const wo = Number(dto.workOrderId);
    const line = Number(dto.lineId);
    const start = this.toDbTs(dto.plannedStartAt);
    const end = this.toDbTs(dto.plannedEndAt);
    if (start && end && end < start)
      throw new UnprocessableEntityException(
        "planned_end_before_start: kraj termina je pre početka.",
      );
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const overlay = await tx.planProizvodnjeOverlay.upsert({
        where: { workOrderId_lineId: { workOrderId: wo, lineId: line } },
        create: { workOrderId: wo, lineId: line, createdBy: email, updatedBy: email },
        update: { updatedBy: email, updatedAt: now },
      });
      const plan = await tx.workOrder.findUnique({
        where: { id: wo },
        select: { pieceCount: true },
      });
      try {
        const red = await tx.planProizvodnjeTermin.create({
          data: {
            overlayId: overlay.id,
            workOrderId: wo,
            lineId: line,
            plannedStartAt: start!,
            plannedEndAt: end,
            plannedDurationMinutes: dto.plannedDurationMinutes ?? null,
            // Izostavljena količina = pun plan operacije (ponašanje pre 078/26).
            kolicina: dto.kolicina ?? plan?.pieceCount ?? null,
            assignedMachineCode: this.praznoUNull(dto.assignedMachineCode),
            createdBy: email,
            updatedBy: email,
          },
        });
        return { data: jsonSafe(red) };
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002"
        )
          throw new ConflictException(
            "Ova operacija već ima termin. Više termina po operaciji još nije uključeno.",
          );
        throw e;
      }
    });
  }

  /** Izmena JEDNOG termina — merge-patch, validacija nad SPOJENIM stanjem. */
  async patchTermin(email: string, id: number, dto: TerminPatchDto) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const zatecen = await tx.planProizvodnjeTermin.findUnique({ where: { id } });
      if (!zatecen) throw new NotFoundException(`Termin ${id} ne postoji.`);

      const patch: Record<string, unknown> = {};
      if (dto.plannedStartAt !== undefined)
        patch.plannedStartAt = this.toDbTs(dto.plannedStartAt);
      if (dto.plannedEndAt !== undefined)
        patch.plannedEndAt = this.toDbTs(dto.plannedEndAt);
      if (dto.plannedDurationMinutes !== undefined)
        patch.plannedDurationMinutes = dto.plannedDurationMinutes;
      if (dto.kolicina !== undefined) patch.kolicina = dto.kolicina;
      if (dto.assignedMachineCode !== undefined)
        patch.assignedMachineCode = this.praznoUNull(dto.assignedMachineCode);
      if (dto.plannedDone !== undefined) {
        patch.plannedDone = dto.plannedDone;
        patch.plannedDoneAt = dto.plannedDone === null ? null : now;
        patch.plannedDoneBy = dto.plannedDone === null ? null : email;
      }

      // 🔴 Nad SPOJENIM stanjem, ne nad patch-om: FE resize bara šalje SAMO kraj,
      // pa bi provera nad patch-om propustila svaki naopak interval (ista zamka
      // koju `assertPlanConsistent` već čuva za overlay).
      const start = (patch.plannedStartAt ?? zatecen.plannedStartAt) as Date | null;
      const end = (patch.plannedEndAt ?? zatecen.plannedEndAt) as Date | null;
      if (start && end && end < start)
        throw new UnprocessableEntityException(
          "planned_end_before_start: kraj termina je pre početka.",
        );

      const red = await tx.planProizvodnjeTermin.update({
        where: { id },
        data: { ...patch, updatedBy: email, updatedAt: now },
      });
      return { data: jsonSafe(red) };
    });
  }

  /** Brisanje jednog termina (pozicija ostaje, samo silazi sa te tačke ose). */
  async deleteTermin(email: string, id: number) {
    return this.prisma.$transaction(async (tx) => {
      const red = await tx.planProizvodnjeTermin.findUnique({ where: { id } });
      if (!red) throw new NotFoundException(`Termin ${id} ne postoji.`);
      await tx.planProizvodnjeTermin.delete({ where: { id } });

      // 🔴 DUH-BAR: čitanje ima rezervu `COALESCE(termin, overlay)` — uvedena je da
      // pozicija bez termina ne izgubi ručne override-e. Ali ista rezerva znači da
      // brisanjem POSLEDNJEG termina bar NE nestaje: vrati se na stari datum sa
      // overlay-a, i planer vidi bar koji je upravo obrisao. Zato se, kad je obrisan
      // poslednji, čisti i overlay — tek tada je pozicija stvarno skinuta sa ose.
      //
      // Ostali override-i (`planned_duration_minutes`) se NE diraju: oni su podešavanje
      // pozicije, ne termina, i imaju smisla i kad pozicija nije na gantu (v. regresija
      // od 07.08. kad su baš takvi override-i tiho izgubljeni).
      const preostalo = await tx.planProizvodnjeTermin.count({
        where: { overlayId: red.overlayId },
      });
      if (preostalo === 0) {
        await tx.planProizvodnjeOverlay.update({
          where: { id: red.overlayId },
          data: {
            plannedStartAt: null,
            plannedEndAt: null,
            updatedBy: email,
            updatedAt: new Date(),
          },
        });
      }
      return { data: { id, obrisao: email, poslednji: preostalo === 0 } };
    });
  }

  /** Prazan string NIJE mašina — COALESCE u čitanju bi ga uzeo kao vrednost. */
  private praznoUNull(v: string | null | undefined): string | null | undefined {
    if (v === undefined) return undefined;
    const t = (v ?? "").trim();
    return t.length === 0 ? null : t;
  }
}
