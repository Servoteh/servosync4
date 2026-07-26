import { SY15_TOOLS } from "./sy15-tools";
import { CORE_TOOLS } from "./core-tools";
import {
  makeRegistry,
  toToolDef,
  type AiTool,
  type PermissionSet,
  type ToolScope,
} from "./tool-registry";
import type { ToolDef } from "../../../common/ai/ai-provider.service";

export * from "./tool-registry";
export { SY15_TOOLS } from "./sy15-tools";
export { CORE_TOOLS } from "./core-tools";

/**
 * JEDINI registar alata asistenta (Talas AI-1, tačka 2). Redosled je značajan —
 * 20 sy15 alata ide PRVIH i istim redosledom kao u 1.0 edge-u (opisi i položaj
 * su „load-bearing" za ponašanje modela, vidi ai-tools.spec.ts), pa tek onda 6
 * novih alata nad glavnom bazom.
 */
export const AI_TOOLS: readonly AiTool[] = [...SY15_TOOLS, ...CORE_TOOLS];

const REGISTRY = makeRegistry(AI_TOOLS);

/** Alat po imenu — `undefined` za nepoznato ime (model ume da halucinira alat). */
export function findTool(name: string): AiTool | undefined {
  return REGISTRY.find(name);
}

/** Alati koje pozivalac SME u ovoj niti (scope + permisije) — puni objekti. */
export function allowedTools(
  scope: ToolScope,
  permissions: PermissionSet,
): AiTool[] {
  return REGISTRY.allowed(scope, permissions);
}

/**
 * Šeme koje idu modelu. `permissions` je skup efektivnih permisija korisnika
 * (isti izvor kao `GET /auth/me/permissions`); bez njega se nude SAMO alati bez
 * `requiredPermission` — tj. tačno onih 20 sy15 alata koji su i pre postojali.
 * Time stari put (i svi postojeći testovi) ostaje bit-identičan.
 */
export function toolsForScope(
  scope: ToolScope,
  permissions?: PermissionSet,
): ToolDef[] {
  return allowedTools(scope, permissions).map(toToolDef);
}

/** Sve definicije (bez filtriranja) — koriste testovi i pregled registra. */
export const TOOL_DEFS: ToolDef[] = AI_TOOLS.map(toToolDef);
