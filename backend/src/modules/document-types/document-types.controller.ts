import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  DocumentTypesService,
  type ListDocumentTypesQuery,
} from "./document-types.service";

/**
 * Registar vrsta dokumenata (PLAN_UNOS_DOKUMENATA §5.7):
 *
 *   GET /api/v1/document-types            — ceo registar (filteri: code, group, screenKind,
 *                                            inbound, configured, q)
 *   GET /api/v1/document-types/:code      — jedna vrsta (ekran je zove pri otvaranju)
 *
 * PERMISIJA: samo `JwtAuthGuard`, kao `LookupsController` — registar je konfiguracija
 * ekrana bez ijednog poslovnog podatka, a čitaju ga SVI dokumentski ekrani (prodaja,
 * robno, nabavka). Vezivanje za npr. `sales.read` bi oborilo robni i nabavni ekran.
 * Upis u registar ovde ne postoji (read-only modul).
 */
@UseGuards(JwtAuthGuard)
@Controller({ path: "document-types", version: "1" })
export class DocumentTypesController {
  constructor(private readonly documentTypes: DocumentTypesService) {}

  @Get()
  list(
    @Query()
    query: {
      code?: string;
      group?: string;
      screenKind?: string;
      inbound?: string;
      configured?: string;
      q?: string;
    },
  ) {
    return this.documentTypes.list(normalizeListQuery(query ?? {}));
  }

  @Get(":code")
  byCode(@Param("code") code: string) {
    return this.documentTypes.byCode(code);
  }
}

/** Query stiže kao string (URI) — normalizacija na tipove servisa. */
export function normalizeListQuery(raw: {
  code?: string;
  group?: string;
  screenKind?: string;
  inbound?: string;
  configured?: string;
  q?: string;
}): ListDocumentTypesQuery {
  const bool = (v?: string) =>
    v === undefined || v === "" ? undefined : v === "true" || v === "1";
  return {
    code: raw.code || undefined,
    numberingGroup: raw.group || undefined,
    screenKind: raw.screenKind || undefined,
    isInbound: bool(raw.inbound),
    configuredOnly: bool(raw.configured) === true,
    q: raw.q || undefined,
  };
}
