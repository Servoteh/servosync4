import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { LookupsService } from "./lookups.service";

/**
 * Lookup-ovi za biranje iz liste:
 *   GET /api/v1/lookups/projects?q=   — predmeti (id, broj, naziv, komitent)
 *   GET /api/v1/lookups/customers?q=  — komitenti (id, naziv, mesto, PIB)
 */
@UseGuards(JwtAuthGuard)
@Controller({ path: "lookups", version: "1" })
export class LookupsController {
  constructor(private readonly lookups: LookupsService) {}

  @Get("projects")
  projects(@Query("q") q?: string) {
    return this.lookups.projects(q);
  }

  @Get("customers")
  customers(@Query("q") q?: string) {
    return this.lookups.customers(q);
  }
}
