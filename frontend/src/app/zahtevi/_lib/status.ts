import type { Tone } from '@/components/ui-kit/status-badge';
import type { ZahtevStatus } from '@/api/zahtevi';

/**
 * Zahtev status → { tone, label } nad kanonskom mapom (DESIGN_SYSTEM §7, domen
 * „Zahtevi — zahtev"). Tonovi su već presuđeni u §7 (F0); ovde je samo mapiranje
 * u lokalni switch (obrazac nabavka/page.tsx statusMeta). Jedan izvor za sve tri
 * rute (/zahtevi, /zahtevi/novi ne koristi, /zahtevi/[id]).
 */
export function statusMeta(status: string): { tone: Tone; label: string } {
  switch (status as ZahtevStatus) {
    case 'DRAFT':
      return { tone: 'neutral', label: 'Nacrt' };
    case 'SUBMITTED':
      return { tone: 'warn', label: 'Podnet' };
    case 'NEEDS_INFO':
      return { tone: 'warn', label: 'Vraćen na dopunu' };
    case 'ANALYSIS_APPROVED':
      return { tone: 'info', label: 'Odobrena AI analiza' };
    case 'ANALYZED':
      return { tone: 'warn', label: 'AI obrađen — čeka odluku' };
    case 'APPROVED':
      return { tone: 'success', label: 'Odobren za realizaciju' };
    case 'PLANNED':
      return { tone: 'info', label: 'Planiran' };
    case 'IN_PROGRESS':
      return { tone: 'info', label: 'U realizaciji' };
    case 'READY_FOR_TEST':
      return { tone: 'info', label: 'Spreman za test' };
    case 'TESTING':
      return { tone: 'warn', label: 'Na testiranju' };
    case 'DONE':
      return { tone: 'success', label: 'Završen' };
    case 'REJECTED':
      return { tone: 'danger', label: 'Odbijen' };
    case 'MERGED':
      return { tone: 'neutral', label: 'Spojen' };
    case 'DEFERRED':
      return { tone: 'neutral', label: 'Backlog / buduća verzija' };
    case 'ARCHIVED':
      return { tone: 'neutral', label: 'Arhiviran' };
    default:
      return { tone: 'neutral', label: status };
  }
}

/** Labela statusa (bez tona) — za Select filtere/čipove. */
export function statusLabel(status: string): string {
  return statusMeta(status).label;
}

/**
 * Prevod event `type` (change_request_events) na čitljiv srpski za Istoriju.
 * Nepoznat tip → sam tip (fail-open — bolje sirov nego prazan).
 */
export function eventLabel(type: string): string {
  const map: Record<string, string> = {
    CREATED: 'Kreiran nacrt',
    SUBMITTED: 'Podnet',
    RESUBMITTED: 'Ponovo podnet (dopuna)',
    TRIAGED: 'AI trijaža završena',
    TRIAGE_FAILED: 'AI trijaža nije uspela',
    AI_REJECTED: 'AI automatski odbio (ocena 0)',
    ANALYSIS_APPROVED: 'Odobrena AI analiza',
    ANALYZED: 'AI analiza završena',
    ANALYSIS_FAILED: 'AI analiza nije uspela',
    COMMENT: 'Komentar',
    NEEDS_INFO: 'Vraćen na dopunu',
    APPROVED: 'Odobren za realizaciju',
    REJECTED: 'Odbijen',
    MERGED: 'Spojen sa drugim zahtevom',
    DEFERRED: 'Prebačen u backlog',
    WITHDRAWN: 'Povučen',
    STATUS_CHANGED: 'Promena statusa',
    LINK_ADDED: 'Dodat link realizacije',
    META_CHANGED: 'Izmena meta podataka',
    SCORE_CONFIRMED: 'Ocena potvrđena',
    REWARD_EXCLUDED: 'Nagrada isključena',
    REWARD_PAID: 'Nagrada isplaćena',
  };
  return map[type] ?? type;
}
