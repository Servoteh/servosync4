import { BadRequestException } from "@nestjs/common";

/**
 * Filteri liste artikala (`GET /api/v1/artikli`). Query stiže kao stringovi —
 * parsiranje/validacija je ovde, servis dobija čiste vrednosti.
 *
 * Obrazac: interface + ručna `parse*()` (kao `nabavka/dto/*` — class-validator
 * se u ovom repou još ne koristi za query stringove; BACKEND_RULES §6).
 */
export interface ListItemsQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga: naziv / kataloški broj / barkod (case-insensitive `contains`). */
  q?: string;
  /** Šifra grupe (`R_Grupa.Grupa` → `items.group_code`) — tačno poklapanje. */
  groupCode?: string;
  /** `true` / `false`; izostavljeno = i aktivni i neaktivni. */
  active?: string;
}

/**
 * `?active=true|false` → boolean; odsutno/prazno → `undefined` (bez filtera).
 * Bilo šta drugo je 400, ne tiho ignorisanje — inače korisnik dobija listu koju
 * nije tražio i misli da filter radi.
 */
export function parseBoolParam(
  value: string | undefined,
  name: string,
): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new BadRequestException(
    `Parametar '${name}' mora biti 'true' ili 'false'.`,
  );
}
