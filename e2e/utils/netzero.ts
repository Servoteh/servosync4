import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const NETZERO_NDJSON = path.resolve(__dirname, '../report/netzero.ndjson');

export interface ProbeResult {
  module: string;
  probe: string;
  kind: 'create-delete' | 'edit-revert';
  status: 'PASS' | 'FAIL' | 'RESIDUE' | 'SKIP';
  writeVerified: boolean; // upis se stvarno desio (mutacioni zahtev 2xx)
  reverted: boolean; // vraćanje pokušano i uspelo
  verifiedGone: boolean; // create-delete: red nema · edit-revert: vrednost vraćena
  residue: string | null; // ako je nešto ostalo na produkciji → opis za ručno čišćenje
  writes: string[]; // svi mutacioni zahtevi (status method path)
  notes: string[];
}

export function recordProbe(r: ProbeResult): void {
  fs.mkdirSync(path.dirname(NETZERO_NDJSON), { recursive: true });
  fs.appendFileSync(NETZERO_NDJSON, JSON.stringify(r) + '\n');
}

export function resetProbeLog(): void {
  fs.mkdirSync(path.dirname(NETZERO_NDJSON), { recursive: true });
  fs.writeFileSync(NETZERO_NDJSON, '');
}

/** Hvata sve mutacione zahteve (POST/PATCH/PUT/DELETE) + statuse — dokaz upisa i vraćanja. */
export function captureWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on('response', (res) => {
    const m = res.request().method();
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(m)) return;
    const u = res.url();
    if (/\/auth\/(login|refresh|me|sso)/.test(u)) return;
    try {
      writes.push(`${res.status()} ${m} ${new URL(u).pathname}`);
    } catch {
      writes.push(`${res.status()} ${m} ${u}`);
    }
  });
  return writes;
}

/** Jedinstven test-tag za lako prepoznavanje/čišćenje rezidua na produkciji. */
export function testTag(prefix = 'E2E'): string {
  // bez Date.now varijacija u nazivu testa — koristimo kratki random iz crypto
  const rnd = Math.floor(Math.random() * 1e6)
    .toString()
    .padStart(6, '0');
  return `${prefix}-TEST-${rnd}`;
}
