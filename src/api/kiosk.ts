'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { TechProcess } from './tech-processes';

/**
 * Barkod kiosk (prijava rada u pogonu) — write-path tehnoloških postupaka
 * (backend/src/modules/tech-processes). Radnik skenira DVA barkoda:
 *   - nalog     `RNZ:IDPredmet:IdentBroj:Varijanta:PrnTimer`
 *   - operacija `S:Operacija:RJgrupaRC:Toznaka:PrnTimer`
 * `PrnTimer` je vezni ključ (mora biti isti u oba). Rute:
 *   POST /v1/tech-processes/barcode/decode  { barcode }
 *   POST /v1/tech-processes/scan            { orderBarcode, operationBarcode, pieceCount }
 *   POST /v1/tech-processes/:id/finish      { pieceCount?, note? }
 * Sve traže JWT (guard je V1 no-op); komponente zovu samo ove hook-ove.
 */

const BASE = '/v1/tech-processes';

/** Polja nalog-barkoda (`RNZ:IDPredmet:IdentBroj:Varijanta:PrnTimer`). */
export interface OrderBarcodeFields {
  projectId: number;
  identNumber: string;
  variant: number;
  printTimer: number;
}

/** Polja operacija-barkoda (`S:Operacija:RJgrupaRC:Toznaka:PrnTimer`). */
export interface OperationBarcodeFields {
  /** null ako polje „Operacija" nije ceo broj. */
  operationNumber: number | null;
  operationRaw: string;
  workCenterCode: string;
  identMark: string;
  printTimer: number;
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
    }
  | {
      type: 'operacija';
      marker: 'S';
      fields: OperationBarcodeFields;
    };

export interface ScanInput {
  orderBarcode: string;
  operationBarcode: string;
  /** Broj napravljenih komada u OVOJ prijavi (akumulira se; ceo broj ≥ 1). */
  pieceCount: number;
}

export interface ScanResult {
  techProcess: TechProcess;
  reportedPieces: number;
  plannedPieces: number | null;
  operationFinished: boolean;
  operationsPrioritized: number;
  workOrderCompleted: boolean;
  workOrder: KioskWorkOrder | null;
}

export interface FinishInput {
  id: number;
  /** Konačan broj komada; bez njega → zatvara sa trenutnom evidentiranom količinom. */
  pieceCount?: number;
  note?: string;
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
    mutationFn: ({ id, pieceCount, note }: FinishInput) =>
      apiFetch<{ data: FinishResult }>(`${BASE}/${id}/finish`, {
        method: 'POST',
        body: JSON.stringify({ pieceCount, note }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tech-processes'] }),
  });
}
