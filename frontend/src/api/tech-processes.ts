'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/** Bezbedan podskup radnika (backend nikad ne vraća lozinke). */
export interface WorkerRef {
  id: number;
  fullName: string | null;
  username: string;
}

/**
 * Tehnolog autor TP-a (sa RN-a) — Paket A t.6a. `username` je ovde nullable
 * (za razliku od `WorkerRef`) jer backend ugovor tako definiše polje.
 */
export interface TechnologistRef {
  id: number;
  fullName: string | null;
  username: string | null;
}

export interface TechProcess {
  id: number;
  workerId: number;
  projectId: number;
  identNumber: string;
  variant: number;
  operationNumber: number;
  workCenterCode: string;
  identMark: string;
  pieceCount: number;
  enteredAt: string;
  finishedAt: string | null;
  isProcessFinished: boolean | null;
  workOrderId: number;
  /**
   * Kvalitet otkucanih komada (`part_quality_types`): 0=dobar, 1=dorada, 2=škart.
   * Backend ga vraća oduvek (`list()` select + `findOne`) — samo nije bio deklarisan.
   * Kolona „Status" ga čita da bi škart pregazio „Završen" (zahtev 033/26).
   */
  qualityTypeId: number;
  /** Razrešen naziv kvaliteta; vraća ga lista, ne i `findOne` detalj. */
  qualityType?: { id: number; name: string } | null;
  signature: string | null;
  note: string | null;
  /** Radnik koji je otkucao red (postojeće polje — NE tehnolog). */
  worker: WorkerRef | null;
  /**
   * Tehnolog autor TP-a (sa RN-a) — Paket A t.6a. Opciono/defanzivno: polje
   * stiže sa novim backendom; stariji backend ga ne vraća (undefined).
   */
  technologist?: TechnologistRef | null;
  /**
   * Crtež sa RN-a (work_orders.drawing_number) — kolona „Crtež" u listi kucanja.
   * Opciono/defanzivno: novo backend polje (lista); stariji backend / findOne
   * detalj ga ne vraća (undefined), a null kad RN nije razrešen (workOrderId=0).
   */
  drawingNumber?: string | null;
}

export interface TechProcessDocument {
  id: number;
  fileLink: string;
  fileName: string;
}

export interface TechProcessDetail extends TechProcess {
  documents: TechProcessDocument[];
}

export interface Paginated<T> {
  data: T[];
  meta: {
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  };
}

interface TpListParams {
  page?: number;
  q?: string;
}

/** Paginirana lista tehnoloških postupaka (+ pretraga po RN / crtežu / nazivu). */
export function useTechProcesses(params: TpListParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  // `q` = široka pretraga (RN / crtež / naziv) — backend gleda `q` pre `identNumber`.
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({
    queryKey: ['tech-processes', params],
    queryFn: () =>
      apiFetch<Paginated<TechProcess>>(
        `/v1/tech-processes${query ? `?${query}` : ''}`,
      ),
  });
}

/** Jedan TP sa radnikom + dokumentacijom (učitava se pri otvaranju reda). */
export function useTechProcess(id: number | null) {
  return useQuery({
    queryKey: ['tech-processes', 'detail', id],
    queryFn: () => apiFetch<{ data: TechProcessDetail }>(`/v1/tech-processes/${id}`),
    enabled: id != null,
  });
}

/** Vrste kvaliteta delova (`part_quality_types`) — 0=dobar, 1=dorada, 2=škart. */
export const PART_QUALITY = { GOOD: 0, REWORK: 1, SCRAP: 2 } as const;

// ------------------------------------------------------------------ KARTICA TP (/card)

/** Operacija (radni centar) razrešena iz šifre — deo kartice / kritičnih. */
export interface OperationRef {
  workCenterCode: string;
  workCenterName: string;
  workUnitCode: string;
}

/** Jedan red kartice tehnološkog postupka (operacija postupka). */
export interface TechProcessCardRow {
  id: number;
  workerId: number;
  projectId: number;
  identNumber: string;
  variant: number;
  operationNumber: number;
  workCenterCode: string;
  identMark: string;
  pieceCount: number;
  enteredAt: string;
  finishedAt: string | null;
  isProcessFinished: boolean | null;
  qualityTypeId: number;
  note: string | null;
  documents: TechProcessDocument[];
  worker: WorkerRef | null;
  operation: OperationRef | null;
  qualityType: { id: number; name: string } | null;
}

/** Agregat jedne operacije kartice — grupa kucanja po (operationNumber, workCenterCode). */
export interface CardOperation {
  operationNumber: number;
  workCenterCode: string;
  /** Isti resolved oblik kao rows[].operation. */
  operation: OperationRef | null;
  /** Broj kucanja (redova) u grupi — storno i KOM=0 ulaze. */
  entryCount: number;
  /** Σ pieceCount: total = SVI redovi; good/rework/scrap po qualityTypeId 0/1/2; storno se netuje. */
  pieces: { total: number; good: number; rework: number; scrap: number };
  /** Bar jedan red grupe je zatvoren. */
  isFinished: boolean;
  /** Min enteredAt grupe (ISO). */
  firstEnteredAt: string;
  /** Max finishedAt grupe (ISO); null ako nijedan red nije završen. */
  lastFinishedAt: string | null;
  /**
   * Σ (finishedAt−enteredAt) u minutima, SAMO za prijave koje liče na rad
   * (1 min ≤ Δ ≤ 24 h — 036/26); null dok nijedan red grupe ne prođe prag.
   */
  elapsedMinutes: number | null;
  /** Zatvoreni redovi grupe izuzeti iz vremena. Stariji backend polje ne vraća. */
  excludedRowCount?: number;
}

/**
 * Jedna operacija iz routinga RN-a (work_order_operations) — paritet QBigTehn
 * kartice: prikaz i operacija koja NEMA nijedno kucanje. `workCenterName` je null
 * kad je RC nerazrešiv (orphan).
 */
export interface CardRoutingOperation {
  operationNumber: number;
  workCenterCode: string;
  workCenterName: string | null;
}

/** „Kartica tehnološkog postupka": redovi + sume (komadi po kvalitetu, vreme). */
export interface TechProcessCard {
  projectId: number;
  identNumber: string;
  variant: number;
  /**
   * HITNO oznaka sa primopredaje (Paket A t.10) — badge u zaglavlju kartice.
   * Opciono/defanzivno: stariji backend polje ne vraća (undefined = nije hitno).
   */
  isUrgent?: boolean;
  /**
   * Crtež sa RN-a za dugme „PDF crteža" u zaglavlju kartice; `hasPdf` govori da
   * li postoji uskladišten PDF (drawing_pdfs). Opciono/defanzivno: stariji
   * backend polje ne vraća (undefined), a null kad RN nema razrešen crtež.
   */
  drawing?: { id: number; hasPdf: boolean } | null;
  /** Broj DISTINCT (operationNumber, workCenterCode) parova — NE broj redova/kucanja. */
  operationCount: number;
  /** Broj distinct parova sa bar jednim završenim redom — NE broj zatvorenih redova. */
  finishedCount: number;
  summary: {
    totalPieces: number;
    piecesByQuality: { good: number; rework: number; scrap: number };
    /** Ukupan broj redova (kucanja) — stara semantika operationCount-a. */
    entryCount: number;
    /**
     * Izvedeno (entered→finished) uz higijenski prag 036/26: sabiraju se samo
     * prijave od 1 min do 24 h — jedna zaboravljena prijava (270 h) je inače
     * pravila „275 h" na delu na kom se radilo ~4 h 50 min.
     * null ako nijedna prijava ne prođe prag.
     */
    totalElapsedMinutes: number | null;
    /** Nefiltrirani zbir — dijagnostika „gde je nestalo vreme". Opciono. */
    totalElapsedMinutesRaw?: number | null;
    /** Broj zatvorenih prijava izuzetih iz zbira (< 1 min ili > 24 h). Opciono. */
    excludedRowCount?: number;
  };
  /** Agregati po operaciji, redosled pojavljivanja (OP asc, id asc). */
  operations: CardOperation[];
  /**
   * Routing tekućeg RN-a — SVE operacije postupka (i one bez ijednog kucanja).
   * UI merge-uje sa `operations`/`rows` (neotkucane = prazne grupe). Opciono/
   * defanzivno: stariji backend polje ne vraća (undefined = samo otkucane grupe).
   */
  routing?: CardRoutingOperation[];
  rows: TechProcessCardRow[];
}

export interface CardKey {
  projectId: number;
  identNumber: string;
  variant: number;
}

/**
 * Kartica jednog postupka (trojka projectId + identNumber + variant).
 * Sume računa API (DESIGN_SYSTEM/spec — ne u UI). Učitava se pri expand-u reda.
 */
export function useTechProcessCard(key: CardKey | null) {
  return useQuery({
    queryKey: ['tech-processes', 'card', key],
    queryFn: () => {
      const qs = new URLSearchParams({
        projectId: String(key!.projectId),
        identNumber: key!.identNumber,
        variant: String(key!.variant),
      });
      return apiFetch<{ data: TechProcessCard }>(
        `/v1/tech-processes/card?${qs.toString()}`,
      );
    },
    enabled: key != null,
  });
}

// ------------------------------------------------------------------ PONOVO OTVORI OPERACIJU (/reopen)

/**
 * PONOVO OTVORI završenu operaciju za DORADU (POST /:id/reopen). Backend nalazi
 * operaciju kojoj `id` (jedan red postupka) pripada i sve njene završene redove
 * vraća u rad (`is_process_finished` → false), pa kiosk ponovo dozvoljava
 * prijavu rada. Iza `tehnologija.write`. Po uspehu poništava keš postupaka
 * (lista + kartica dele prefiks `['tech-processes']`).
 */
export function useReopenTechProcess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ data: { id: number; reopened: number } }>(
        `/v1/tech-processes/${id}/reopen`,
        { method: 'POST' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tech-processes'] }),
  });
}

// ------------------------------------------------------------------ OBRIŠI KUCANJE (DELETE /:id)

/** Cilj brisanja jednog kucanja — id reda + opciona napomena (audit). */
export interface DeleteTechEntryInput {
  id: number;
  /** Napomena uz brisanje (opciono; upisuje se u audit_log.metadata). */
  note?: string;
}

/**
 * AUDITED brisanje jednog kucanja (DELETE /:id) — backend snimi snapshot reda u
 * `audit_log` pa ga obriše (ne može se opozvati). Iza `tehnologija.write`. Telo
 * `{ note }` je opciono. Po uspehu poništava keš postupaka (lista + kartica dele
 * prefiks `['tech-processes']`).
 */
export function useDeleteTechEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: DeleteTechEntryInput) =>
      apiFetch<{ data: { id: number; deleted: boolean; backedUpTo: string } }>(
        `/v1/tech-processes/${id}`,
        {
          method: 'DELETE',
          body: JSON.stringify({ note: note?.trim() || undefined }),
        },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tech-processes'] }),
  });
}

// ------------------------------------------------------------------ KRITIČNI (/critical)

/** severity: 3=rok probijen (crveno) · 2=≤2 dana (narandžasto) · 1=≤7 dana (žuto). */
export type CriticalSeverity = 1 | 2 | 3;

export interface CriticalTechProcess {
  id: number;
  projectId: number;
  identNumber: string;
  variant: number;
  operationNumber: number;
  workCenterCode: string;
  pieceCount: number;
  enteredAt: string;
  workerId: number;
  worker: WorkerRef | null;
  operation: OperationRef | null;
  productionDeadline: string;
  daysRemaining: number;
  severity: CriticalSeverity;
}

export interface CriticalResponse {
  data: CriticalTechProcess[];
  meta: {
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
    severityCounts: { yellow: number; orange: number; red: number };
    thresholds: { redWhenOverdue: boolean; orangeMaxDays: number; yellowMaxDays: number };
  };
}

/** Kritični postupci — nezavršeni čiji RN rok ističe (severity 1/2/3). */
export function useCriticalTechProcesses(params: { page?: number }) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  const query = qs.toString();
  return useQuery({
    queryKey: ['tech-processes', 'critical', params],
    queryFn: () =>
      apiFetch<CriticalResponse>(
        `/v1/tech-processes/critical${query ? `?${query}` : ''}`,
      ),
  });
}

// ------------------------------------------------------------- UČINAK RADNIKA (/worker-performance)

export interface WorkerPerformance {
  workerId: number;
  worker: WorkerRef | null;
  processCount: number;
  finishedCount: number;
  totalPieces: number;
  piecesByQuality: { good: number; rework: number; scrap: number };
  /** Isti higijenski prag kao kartica RN-a (1 min ≤ Δ ≤ 24 h, 036/26). */
  totalElapsedSeconds: number;
  totalElapsedMinutes: number;
  /** Prijave radnika izuzete iz vremena (< 1 min ili > 24 h). Opciono. */
  excludedRowCount?: number;
}

export interface WorkerPerformanceResponse {
  data: WorkerPerformance[];
  meta: { from: string | null; to: string | null; workerCount: number };
}

/** Učinak po radniku u periodu (from/to po datumu evidentiranja). */
export function useWorkerPerformance(params: { from?: string; to?: string }) {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  const query = qs.toString();
  return useQuery({
    queryKey: ['tech-processes', 'worker-performance', params],
    queryFn: () =>
      apiFetch<WorkerPerformanceResponse>(
        `/v1/tech-processes/worker-performance${query ? `?${query}` : ''}`,
      ),
  });
}

// ------------------------------------------------------------------ GOTOVOST RN (/rn-progress)

export interface RnProgress {
  workOrderId: number;
  projectId: number;
  identNumber: string;
  variant: number;
  partName: string;
  drawingNumber: string;
  productionDeadline: string | null;
  handoverStatusId: number;
  handoverStatus: { id: number; name: string } | null;
  workerId: number;
  worker: WorkerRef | null;
  plannedPieces: number;
  /**
   * OVERENO napravljeno (036/26): završnom kontrolom naloga, a ako je ruting nema —
   * uskim grlom (najslabijom operacijom). Nikad „bilo kojom operacijom". Ovo NIJE
   * isto što i `completionPercent` — v. `completionSource`.
   */
  madeGoodPieces: number;
  madeGoodSource: 'zavrsna-kontrola' | 'usko-grlo' | 'nema-rutinga';
  /** Broj redova kucanja (ne operacija) — istorijska semantika, ostavljena netaknuta. */
  operationCount: number;
  finishedOperationCount: number;
  /** Operacija u RUTINGU naloga (isto što tab „Kucanja" vidi) — bez `withoutProcess`. */
  routingOperationCount: number;
  /** Koliko tih operacija je otkucano u punoj planiranoj količini. */
  routingOperationsCompleted: number;
  /**
   * KOLIKO JE POSLA URAĐENO (036/26) = veći od dva broja: napredak kroz ruting
   * (prosek urađenog po operacijama — deo sa 8 od 14 otkucanih je 61%, ne 0% ni
   * 100%) i overa sa završne kontrole (overen nalog je 100% i kad međufaze nikad
   * nisu kucane — legacy). null kada planirano = 0 (nedefinisan procenat).
   */
  completionPercent: number | null;
  /**
   * Koja je strana dala procenat: `ruting` (put kroz operacije) ili
   * `zavrsna-kontrola` (overa je veća — tipično legacy nalog bez kucanih međufaza).
   * Opciono/defanzivno: stariji backend polje ne vraća.
   */
  completionSource?: 'ruting' | 'zavrsna-kontrola';
  /** OVERA gotovosti (završna kontrola) — NIJE izvedeno iz `completionPercent`. */
  isCompleted: boolean;
  /**
   * Datum realizacije RN-a (zahtev 023/26): poslednji DOBAR završetak =
   * max(tech_processes.finished_at) FILTER (is_process_finished AND GOOD).
   * null dok nijedna operacija nije zatvorena sa dobrim komadima.
   */
  completedAt: string | null;
}

/** Pregled gotovosti RN — planirano vs napravljeno (dobar komad) + procenat. */
export function useRnProgress(params: { page?: number; q?: string }) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({
    queryKey: ['tech-processes', 'rn-progress', params],
    queryFn: () =>
      apiFetch<Paginated<RnProgress>>(
        `/v1/tech-processes/rn-progress${query ? `?${query}` : ''}`,
      ),
  });
}
