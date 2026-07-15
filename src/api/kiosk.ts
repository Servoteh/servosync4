'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBlob, apiFetch } from './client';
import type { TechProcess } from './tech-processes';

/**
 * Barkod kiosk (prijava rada u pogonu) — write-path tehnoloških postupaka
 * (backend/src/modules/tech-processes). Radnik skenira DVA barkoda:
 *   - nalog     `RNZ:projectId:identNumber:variant:revision`
 *   - operacija `S:operationNumber:workCenterCode:0:revision`
 * `revision` (polje 5) = provera „isti otisak" (ista u oba barkoda). Verzioni pečat je
 * `variant` (nalog polje 4): pri izmeni tehnologije/crteža varijanta raste kroz KLON —
 * „Prepiši isti postupak" (POST /work-orders/:id/clone-variant) pravi NOVI RN red sa istim
 * identom i `variant = MAX+1`; kiosk razrešava TEKUĆI RN (najviša varijanta), pa scan sa
 * starim otiskom (manja varijanta) vraća `staleWorkOrder` upozorenje. Rute:
 *   POST /v1/tech-processes/barcode/decode  { barcode }
 *   POST /v1/tech-processes/scan            { orderBarcode, operationBarcode, pieceCount }
 *   POST /v1/tech-processes/:id/finish      { pieceCount?, note? }
 * Sve traže JWT (guard je V1 no-op); komponente zovu samo ove hook-ove.
 */

const BASE = '/v1/tech-processes';

/**
 * Otvori uskladišten PDF crteža sa RN-a u novom tabu — kiosk ruta
 * (GET /tech-processes/drawings/:id/pdf/content, dostupna kiosk roli). Isti
 * mehanizam kao `pdm.openDrawingPdf`, samo druga ruta; `apiBlob` nosi JWT terminala.
 */
export async function openKioskDrawingPdf(id: number): Promise<void> {
  const blob = await apiBlob(`${BASE}/drawings/${id}/pdf/content`);
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Polja nalog-barkoda (`RNZ:projectId:identNumber:variant:revision`). */
export interface OrderBarcodeFields {
  projectId: number;
  identNumber: string;
  variant: number;
  /** Revizija RN-a (verzioni pečat; legacy: PrnTimer). */
  revision: string;
}

/** Polja operacija-barkoda (`S:operationNumber:workCenterCode:0:revision`). */
export interface OperationBarcodeFields {
  /** null ako polje „Operacija" nije ceo broj. */
  operationNumber: number | null;
  operationRaw: string;
  workCenterCode: string;
  identMark: string;
  /** Revizija RN-a (verzioni pečat, ista kao nalog; legacy: PrnTimer). */
  revision: string;
}

/** RN razrešen iz nalog-barkoda (podskup `work_orders` koji vraća decode). */
export interface KioskWorkOrder {
  id: number;
  projectId: number;
  identNumber: string;
  variant: number;
  partName: string;
  drawingNumber: string;
  pieceCount: number;
  productionDeadline: string | null;
  handoverStatusId: number;
  status: boolean | null;
}

export type DecodedBarcode =
  | {
      type: 'nalog';
      marker: 'RNZ';
      fields: OrderBarcodeFields;
      workOrder: KioskWorkOrder | null;
      techProcess: { operationCount: number };
      /**
       * Routing RN-a (work_order_operations) — operacija JESTE u nalogu i kad
       * `tech_processes` red još ne postoji (create-on-scan za RN kreiran u 2.0).
       */
      routing: { operationNumber: number; workCenterCode: string }[];
    }
  | {
      type: 'operacija';
      marker: 'S';
      fields: OperationBarcodeFields;
      /**
       * Razrešen radni centar iz šifarnika. `significantForFinishing = true` →
       * operacija je ZAVRŠNA KONTROLA → kiosk grana u KONTROLA režim (MODULE_SPEC_kontrola §1).
       * `null` ako RC nije u šifarniku `operations`.
       */
      operation: {
        workCenterName: string;
        significantForFinishing: boolean;
        /** true = operacija bez postupka (opšti nalog / RC without_process) — uvek otvorena, nikad „Zatvorena". */
        withoutProcess: boolean;
      } | null;
    };

export interface ScanInput {
  orderBarcode: string;
  operationBarcode: string;
  /** Broj napravljenih komada u OVOJ prijavi (akumulira se; ceo broj ≥ 1). */
  pieceCount: number;
  /** ID kartica radnika (audit ko je radio) — opciono. */
  workerCard?: string;
  /** Napomena radnika uz prijavu (opciono; upisuje se u tech_processes.note). */
  note?: string;
}

export interface ScanResult {
  techProcess: TechProcess;
  reportedPieces: number;
  plannedPieces: number | null;
  operationFinished: boolean;
  operationsPrioritized: number;
  workOrderCompleted: boolean;
  workOrder: KioskWorkOrder | null;
  /** true = skenirani otisak je starije VARIJANTE od tekućeg RN-a (upozorenje, ne blokada). */
  staleWorkOrder: boolean;
  /** Varijanta sa skeniranog barkoda (otisak). */
  printedVariant: number;
  /** Tekuća varijanta RN-a u bazi. */
  currentVariant: number;
}

export interface FinishInput {
  id: number;
  /** Konačan broj komada; bez njega → zatvara sa trenutnom evidentiranom količinom. */
  pieceCount?: number;
  note?: string;
  /** ID kartica radnika (audit ko+kada) — opciono. */
  workerCard?: string;
}

export interface FinishResult {
  techProcess: TechProcess;
  finishedPieces: number;
  plannedPieces: number | null;
  operationsPrioritized: number;
  workOrderCompleted: boolean;
  workOrder: KioskWorkOrder | null;
}

/** Parsira/validira JEDAN skenirani barkod (nalog ili operacija). 400 na nevalidan ulaz. */
export function useDecodeBarcode() {
  return useMutation({
    mutationFn: (barcode: string) =>
      apiFetch<{ data: DecodedBarcode }>(`${BASE}/barcode/decode`, {
        method: 'POST',
        body: JSON.stringify({ barcode }),
      }),
  });
}

/** Prijava rada — akumulira napravljene komade na operaciji (nalog + operacija barkod). */
export function useScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ScanInput) =>
      apiFetch<{ data: ScanResult }>(`${BASE}/scan`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tech-processes'] }),
  });
}

/** Zatvaranje operacije. Bez `pieceCount` → zatvara sa trenutnom količinom. */
export function useFinish() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, pieceCount, note, workerCard }: FinishInput) =>
      apiFetch<{ data: FinishResult }>(`${BASE}/${id}/finish`, {
        method: 'POST',
        body: JSON.stringify({ pieceCount, note, workerCard }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tech-processes'] }),
  });
}

// ------------------------------------------------------------------ START/STOP (A-4: evidencija vremena, „dva skena")

export interface StartWorkInput {
  orderBarcode: string;
  operationBarcode: string;
  /** ID kartica radnika (obavezno — identitet ključa sesiju). */
  workerCard: string;
}

export interface StartWorkResult {
  session: { id: number; startedAt: string; techProcessId: number };
  techProcess: TechProcess;
  workOrder: KioskWorkOrder | null;
  staleWorkOrder: boolean;
  printedVariant: number;
  currentVariant: number;
  machineAccessWarning: string | null;
  /** Upozorenje: radnik već ima otvorenu sesiju na drugoj operaciji (rad svejedno započet). */
  multitaskingWarning: string | null;
}

export interface StopWorkInput {
  orderBarcode: string;
  operationBarcode: string;
  workerCard: string;
  /** Broj napravljenih komada u OVOJ sesiji (ceo broj ≥ 1). */
  pieceCount: number;
  note?: string;
}

export interface StopWorkResult extends ScanResult {
  session: {
    id: number;
    startedAt: string;
    stoppedAt: string;
    /** Trajanje sesije (sekunde). */
    elapsedSeconds: number;
    /** true = trenutna sesija (nije bilo START skena — jednokratni fallback). */
    instant: boolean;
  };
}

export interface OpenSessionResult {
  /** null = red operacije još ne postoji (otvoriće ga START skena — create-on-scan). */
  techProcessId: number | null;
  operationFinished: boolean;
  open: boolean;
  session: { id: number; startedAt: string } | null;
  worker: { id: number; fullName: string | null };
}

/** START skena — otvara vremensku sesiju za (radnik, operacija). */
export function useStartWork() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StartWorkInput) =>
      apiFetch<{ data: StartWorkResult }>(`${BASE}/work/start`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tech-processes'] }),
  });
}

/** STOP skena — zatvara sesiju + akumulira komade (isti efekat kao scan). */
export function useStopWork() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StopWorkInput) =>
      apiFetch<{ data: StopWorkResult }>(`${BASE}/work/stop`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tech-processes'] }),
  });
}

export interface StopWorkByIdInput {
  /** tp.id iz liste „Moji otvoreni". */
  id: number;
  /** ID kartica radnika (audit) — opciono za lični nalog (backend čita JWT). */
  workerCard?: string;
  /** Broj napravljenih komada u OVOJ sesiji (ceo broj ≥ 0; 0 = samo vreme). */
  pieceCount: number;
}

/**
 * „Kraj rada" po tp.id — završava sesiju radnika na postupku iz liste
 * „Moji otvoreni" (bez skena oba barkoda). Backend vraća isti oblik kao STOP
 * skena (`operationFinished`, `reportedPieces`…). Poništava keš postupaka
 * (lista „Moji otvoreni" deli prefiks `['tech-processes']`).
 */
export function useStopWorkById() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, workerCard, pieceCount }: StopWorkByIdInput) =>
      apiFetch<{ data: StopWorkResult }>(`${BASE}/${id}/stop-work`, {
        method: 'POST',
        body: JSON.stringify({ workerCard, pieceCount }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tech-processes'] }),
  });
}

/**
 * Stanje sesije za (radnik, operacija) razrešeno iz barkodova — vodi kiosk
 * START/STOP režim. `enabled=false` isključuje upit (npr. dok nema oba barkoda).
 */
export function useOpenSession(params: {
  orderBarcode?: string;
  operationBarcode?: string;
  workerCard?: string;
  enabled: boolean;
}) {
  const qs = new URLSearchParams();
  if (params.orderBarcode) qs.set('orderBarcode', params.orderBarcode);
  if (params.operationBarcode) qs.set('operationBarcode', params.operationBarcode);
  if (params.workerCard) qs.set('workerCard', params.workerCard);
  return useQuery({
    queryKey: [
      'tech-processes',
      'work-open',
      params.orderBarcode,
      params.operationBarcode,
      params.workerCard,
    ],
    queryFn: () =>
      apiFetch<{ data: OpenSessionResult }>(`${BASE}/work/open?${qs.toString()}`),
    enabled: params.enabled,
  });
}

// ------------------------------------------------------------------ KONTROLA (završna kontrola)

/** Radnik razrešen iz ID kartice (kiosk login karticom — GET /worker?card=…). */
export interface KioskWorker {
  id: number;
  fullName: string | null;
  username: string;
  workerTypeId: number;
  workerType: string | null;
  /** Tip radnika sa dodatnim ovlašćenjima = kontrolor (legacy DodatnaOvlascenja). */
  isController: boolean;
}

/** Polja + RNZ barkod za termalnu nalepnicu (GET /label; i deo control odgovora). */
export interface LabelData {
  workOrderId: number;
  /** RNZ payload (kiosk-dekodabilan): `RNZ:projectId:identNumber:variant:revision`. */
  barcode: string;
  plannedPieces: number;
  quantity: number;
  fields: {
    brojPredmeta: string;
    komitent: string;
    nazivPredmeta: string;
    nazivDela: string;
    brojCrteza: string;
    materijal: string;
    kolicina: string;
  };
}

/** Jedan raspored po polici (zbir svih = pieceCount). */
export interface ControlLocationInput {
  positionId: number;
  quantity: number;
}

export interface ControlInput {
  /** Nalog barkod: `RNZ:projectId:identNumber:variant:revision`. */
  orderBarcode: string;
  /** Operacija (završne kontrole) barkod: `S:operationNumber:workCenterCode:0:revision`. */
  operationBarcode: string;
  /** ID kartica kontrolora (obavezno). */
  workerCard: string;
  /** Ukupno iskontrolisano (= zbir locations[].quantity). */
  pieceCount: number;
  /** 0=dobar (P1), 1=dorada, 2=škart. */
  qualityTypeId: number;
  locations: ControlLocationInput[];
  note?: string;
  /**
   * true = kontrolor je potvrdio prekoračenje plana (ukupno iskontrolisano > lansirano).
   * Bez ovoga backend odbija overshoot (422 „premašuje planirano"). Odluka Nenad 15.07.
   */
  confirmOvershoot?: boolean;
}

export interface ControlResult {
  techProcess: TechProcess;
  controlledPieces: number;
  /** true = operacija je ovom kontrolom dostigla plan i zatvorena; false = kontrola snimljena, operacija još otvorena. */
  operationFinished: boolean;
  /** Ukupno iskontrolisano na operaciji (akumulirano kroz sve kontrole), ne samo u ovom pozivu. */
  controlledCumulative: number;
  plannedPieces: number | null;
  qualityTypeId: number;
  locationsBooked: number;
  operationsPrioritized: number;
  /** Neotkucane/otvorene operacije RN-a zatvorene ovom završnom kontrolom (Nesa 2026-07-10). */
  confirmedOperations: number;
  workOrderCompleted: boolean;
  /** true = red kontrole je otvoren u ovom pozivu (create-on-scan). */
  techProcessOpened: boolean;
  workOrder: KioskWorkOrder | null;
  label: LabelData;
  /** true = dorada/škart — child RN (-D/-S) je P2 (još se ne kreira). */
  childOrderPending: boolean;
  /**
   * true = kontrola sa kvalitetom dorada/škart je otvorila DRAFT izveštaj o neusaglašenosti
   * (auto-nacrt; kontrolor ga dopunjava/potvrđuje u kartici „Kontrola kvaliteta"). MODULE_SPEC §5.
   */
  nonconformityDraftCreated?: boolean;
  /**
   * A-5 (shadow): upozorenja o ovlašćenju kontrolora / razdvajanju dužnosti — null ako je
   * sve u redu. Dok je AUTHZ_ENFORCE isključen, kontrola prolazi uz upozorenje (ne blokira).
   */
  controllerWarnings: string[] | null;
}

// ------------------------------------------------------------------ MOJI OTVORENI (runda 2 t.3)

/**
 * Crtež sa RN-a + revizioni signal (kiosk kartica `card().drawing` i „Moji
 * otvoreni" red). `hasPdf` = postoji uskladišten PDF (drawing_pdfs). Revizija
 * crteža (MAX semantika kao PDM, normalizacija prazno→'A', uppercase):
 * `revision` = revizija na koju je RN vezan, `latestRevision` = najnovija u bazi;
 * `revisionStale = true` → RN koristi STARIJU reviziju od najnovije — UPOZORENJE
 * (ne blokira rad, odluka Nenad 15.07).
 */
export interface KioskDrawingRef {
  id: number;
  hasPdf: boolean;
  revision: string | null;
  latestRevision: string | null;
  revisionStale: boolean;
}

/**
 * Otvoren tehnološki postupak radnika — red iz GET /worker/open (runda 2 t.3).
 * Lista svih operacija koje je radnik započeo/prijavljivao a nije zatvorio, da
 * ih može zatvoriti bez ponovnog skeniranja oba barkoda.
 */
export interface MyOpenRow {
  id: number;
  projectId: number;
  identNumber: string;
  variant: number;
  operationNumber: number;
  workCenterCode: string;
  operation: { workCenterName: string } | null;
  /** Napravljeno (akumulirano) na operaciji. */
  pieceCount: number;
  /** Planirano (potrebno) — null ako nije poznato. */
  plannedPieces: number | null;
  enteredAt: string;
  /** true = radnik ima OTVORENU vremensku sesiju (A-4) na ovoj operaciji. */
  hasOpenSession: boolean;
  /**
   * Crtež sa RN-a za dugme „PDF crteža" u redu (+ revizioni signal, v.
   * `KioskDrawingRef`). Opciono/defanzivno: null kad RN nema razrešen crtež,
   * undefined kad stariji backend polje ne vraća.
   */
  drawing?: KioskDrawingRef | null;
}

/**
 * „Moji otvoreni" — operacije koje je prijavljeni radnik započeo a nije zatvorio
 * (runda 2 t.3). `card` je OPCION: lični nalozi rade i bez kartice (backend čita
 * `worker_id` iz JWT-a); deljeni terminal-nalozi šalju karticu. `enabled` gasi
 * upit dok radnik nije prijavljen.
 */
export function useMyOpen(card: string | null, enabled: boolean) {
  const qs = card ? `?card=${encodeURIComponent(card)}` : '';
  return useQuery({
    queryKey: ['tech-processes', 'worker-open', card],
    queryFn: () =>
      apiFetch<{ data: MyOpenRow[]; meta: { workerId: number; workerCard: string | null } }>(
        `${BASE}/worker/open${qs}`,
      ),
    enabled,
    staleTime: 10_000,
  });
}

/** Razreši radnika iz ID kartice (kiosk login). 404 ako kartica nije poznata. */
export function useIdentifyWorker() {
  return useMutation({
    mutationFn: (cardId: string) =>
      apiFetch<{ data: KioskWorker }>(
        `${BASE}/worker?card=${encodeURIComponent(cardId)}`,
      ),
  });
}

/** Radnik vezan za LIČNI nalog (users.worker_id) + njegova kartica. */
export type KioskWorkerMe = KioskWorker & { cardId: string };

/**
 * Auto-identifikacija iz prijavljenog naloga — kiosk preskače skeniranje kartice kad je
 * ulogovan lični nalog kontrolora/radnika (npr. marina.mutic@ na telefonu). Deljeni
 * terminal-nalozi (kontrola@, tehnologija@) vraćaju `data: null` → kartica obavezna.
 */
export function useWorkerMe() {
  return useQuery({
    queryKey: ['kiosk', 'worker-me'],
    queryFn: () => apiFetch<{ data: KioskWorkerMe | null }>(`${BASE}/worker/me`),
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Podaci za nalepnicu (GET /label) — za DOŠTAMPAVANJE kad je završna kontrola već
 * urađena (kiosk nudi samo štampu; ne dira evidenciju).
 */
export function useLabelData() {
  return useMutation({
    mutationFn: ({ workOrderId, quantity }: { workOrderId: number; quantity: number }) =>
      apiFetch<{ data: LabelData }>(
        `${BASE}/label?workOrderId=${workOrderId}&quantity=${quantity}`,
      ),
  });
}

/** Završna kontrola — kvalitet + raspored po policama + zatvaranje (jedna transakcija). */
export function useControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ControlInput) =>
      apiFetch<{ data: ControlResult; meta?: { note: string } }>(
        `${BASE}/control`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tech-processes'] });
      qc.invalidateQueries({ queryKey: ['part-locations'] });
    },
  });
}
