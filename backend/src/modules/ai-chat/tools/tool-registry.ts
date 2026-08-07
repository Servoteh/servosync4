import { OdrzavanjeSourceService } from "../../../common/sy15/odrzavanje-source.service";
import type { OdrzavanjeFnService } from "../../odrzavanje/odrzavanje-fn.service";
import type { ToolDef } from "../../../common/ai/ai-provider.service";
import type { AiCallContext } from "../../../common/ai/ai-usage.service";
import type { PermissionKey } from "../../../common/authz/permissions";
import type { AiProviderService } from "../../../common/ai/ai-provider.service";
import type { Sy15Service } from "../../../common/sy15/sy15.service";
import type { PrismaService } from "../../../prisma/prisma.service";
import type { KadrovskaService } from "../../kadrovska/kadrovska.service";

/**
 * TALAS AI-1, tačka 3 — KONSOLIDOVAN REGISTAR ALATA.
 *
 * Do sada su definicija (`TOOL_DEFS` u ai-tools.ts) i izvršenje (`execTool` +
 * `rpcSql` switch u ai-chat.service.ts) živeli u DVA fajla bez ijedne provere
 * poklapanja: alat je mogao da postoji u šemi a da nema handler (model ga zove
 * → `nepoznat_alat` u produkciji) ili obrnuto (mrtav kod). Sada je jedan alat =
 * JEDAN objekat (`AiTool`) sa imenom, opisom, šemom, handlerom, read/write
 * oznakom i potrebnom permisijom; nepoklapanje više nije moguće po konstrukciji,
 * a `tool-registry.spec.ts` to i pinuje.
 *
 * ── Zašto permisija na alatu (plan §7, AI-1) ────────────────────────────────
 * Postojećih 20 sy15 alata izvršava BAZA pod identitetom korisnika
 * (`withUserRls` → RLS presuđuje svaki red), pa oni NEMAJU `requiredPermission`
 * — njihovo ponašanje ostaje 1:1 kao pre ovog talasa. Novi alati čitaju GLAVNU
 * bazu, gde RLS NE POSTOJI (0 politika na 176 tabela) — tamo je permisija
 * korisnika JEDINA brana i zato je obavezna, i pri nuđenju modelu i pri
 * izvršenju (`isToolAllowed`, poziva ga `AiChatService.execTool`).
 */

export type ToolScope = "personal" | "project";

/** `read` = samo čita; `write` = menja podatke (UI potvrda — plan §7, Talas AI-4). */
export type ToolKind = "read" | "write";

/** Servisi koje alati smeju da koriste (ubrizgava ih `AiChatService`). */
export interface ToolDeps {
  sy15: Sy15Service;
  ai: AiProviderService;
  /** Glavna baza (proizvodno jezgro) — samo za `kind: "read"` alate. */
  prisma: PrismaService;
  /** Postojeći servis kadrovske (prisustvo) — logika se NE duplira (plan §2.4). */
  kadrovska: KadrovskaService;
  /**
   * Prekidač izvora ODRŽAVANJA (`ODRZAVANJE_IZVOR`, korak 2 gašenja sy15).
   *
   * 🔴 Zašto je AI-chat uopšte pod tuđim prekidačem: pet alata ovde radi nad
   * `maint_*` podacima, a `prijavi_kvar` (`ai_chat_prijavi_kvar`) radi
   * `INSERT INTO maint_incidents`. Kad održavanje pređe na 3.0, prijava kvara
   * kroz asistenta bi i dalje pisala u sy15 — dve baze bi se razišle, i to se
   * NE BI VIDELO dok se brojevi ne raziđu. Zato ti alati pod `3.0` padaju sa 503.
   *
   * Opciono: kad ga nema (npr. u testovima), brana ne radi ništa → ponašanje je
   * kao `sy15`, tj. izostanak prekidača nikad ne prebacuje alat na 3.0.
   */
  odrzavanjeIzvor?: OdrzavanjeSourceService;
  /**
   * Prepis DEFINER logike održavanja nad 3.0 bazom (korak 2 seobe).
   * Koristi ga SAMO `prijavi_kvar` i SAMO pod `ODRZAVANJE_IZVOR=3.0` — jedini
   * upis AI-chata u tuđi domen. Opciono iz istog razloga kao prekidač: kad ga
   * nema, alat pada na 503 umesto da tiho piše u sy15 (bezbedan smer).
   */
  odrzavanjeFn?: OdrzavanjeFnService;
}

export interface ToolCtx {
  /** Identitet pozivaoca — sy15 alati ga šalju u GUC (RLS), audit ga beleži. */
  email: string;
  /** Merni kontekst gateway-a (za `embed` pozive unutar alata). */
  call?: AiCallContext;
  /**
   * Efektivne permisije pozivaoca — za alate koji vraćaju podatke IZ VIŠE
   * domena. Ulazna permisija alata pokriva samo njegov „glavni" domen; sekcija
   * iz tuđeg domena mora da se proveri posebno, inače alat postaje zaobilaznica
   * (npr. `stanje_predmeta` sa `directory.read` ne sme da izlista radne naloge
   * korisniku kome je `rn.read` izričito oduzet).
   */
  permissions: PermissionSet;
  deps: ToolDeps;
}

export interface AiTool {
  name: string;
  description: string;
  /** JSON šema argumenata — ide modelu kao `ToolDef.input`. */
  schema: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolCtx): Promise<unknown>;
  kind: ToolKind;
  /** Bez nje alat gate-uje baza (sy15 RLS); sa njom je ona jedina brana. */
  requiredPermission?: PermissionKey;
  /** U kojim nitima se alat nudi. Deljena projektna nit vidi samo `project`. */
  scopes: readonly ToolScope[];
}

/** Skup permisija korisnika; `undefined` = nepoznato → fail-closed. */
export type PermissionSet = ReadonlySet<string> | undefined;

/** Alat → oblik koji gateway šalje modelu (ime/opis/šema). */
export function toToolDef(tool: AiTool): ToolDef {
  return { name: tool.name, description: tool.description, input: tool.schema };
}

/**
 * Sme li korisnik ovaj alat? Dva nezavisna uslova:
 *  1. scope niti (deljena projektna nit nema lične/HR alate — §2 pravilo 11),
 *  2. permisija, ako je alat traži (nepoznat skup = odbij, ne pretpostavljaj).
 */
export function isToolAllowed(
  tool: AiTool,
  scope: ToolScope,
  permissions: PermissionSet,
): boolean {
  if (!tool.scopes.includes(scope)) return false;
  if (!tool.requiredPermission) return true;
  return permissions ? permissions.has(tool.requiredPermission) : false;
}

/** Fabrika registra — `AI_TOOLS` se sklapa u `index.ts` (izbegava ciklus). */
export function makeRegistry(tools: readonly AiTool[]) {
  const byName = new Map<string, AiTool>();
  for (const t of tools) {
    if (byName.has(t.name)) {
      throw new Error(`Duplo ime alata u registru: ${t.name}`);
    }
    byName.set(t.name, t);
  }
  return {
    all: tools,
    find: (name: string): AiTool | undefined => byName.get(name),
    allowed: (scope: ToolScope, permissions: PermissionSet): AiTool[] =>
      tools.filter((t) => isToolAllowed(t, scope, permissions)),
  };
}
