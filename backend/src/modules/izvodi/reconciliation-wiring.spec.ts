import "reflect-metadata";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { SaldakontiModule } from "../saldakonti/saldakonti.module";
import { ReconciliationService } from "../saldakonti/reconciliation.service";
import { BankStatementService } from "./bank-statement.service";

/**
 * VEZA IZVODI → RECONCILIATION SE RAZREŠAVA U TRENUTKU POZIVA, PA JE TREBA DOKAZATI.
 * =============================================================================
 * `BankStatementService.postStatement` posle knjiženja zatvara uparenu stavku kroz
 * `ReconciliationService.autoReconcile` (ono nosi sve provere i pravi `ReconciliationGroup`
 * koji „Razveži" ume da vrati). Modul se NE uvozi — `SaldakontiModule` već uvozi
 * `IzvodiModule` (kursna lista), pa bi obrnut uvoz bio ciklus. Instanca se zato vadi
 * `moduleRef.get(ReconciliationService, { strict: false })`.
 *
 * ZAŠTO OVAJ TEST POSTOJI: takva pretraga se razrešava PRI POZIVU, ne pri boot-u. Ni
 * `nest build` ni boot smoke je ne proveravaju — ako `ReconciliationService` ikad prestane
 * da bude provider u grafu aplikacije, sve nastavi da radi do prvog knjiženja uplate, gde
 * `resolveReconciliationService` vrati `null`, `reconciled_at` se ne postavi, i vrati se
 * TIHO stanje pre ispravke: uplata proknjižena, stavka ostala otvorena za kamatu i opomenu.
 *
 * Test je nad METAPODACIMA modula (bez boot-a i baze) — isti obrazac kao
 * `test/route-permission-coverage.e2e-spec.ts`.
 */
describe("izvodi → saldakonti: ReconciliationService mora biti u grafu aplikacije", () => {
  it("SaldakontiModule ga drži kao provider (inače ModuleRef pretraga vraća null)", () => {
    const providers =
      (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SaldakontiModule) as unknown[]) ?? [];
    expect(providers).toContain(ReconciliationService);
  });

  it("i izvozi ga — da veza ostane namerna, a ne slučajna posledica `strict: false`", () => {
    const exports =
      (Reflect.getMetadata(MODULE_METADATA.EXPORTS, SaldakontiModule) as unknown[]) ?? [];
    expect(exports).toContain(ReconciliationService);
  });

  it("BankStatementService i dalje prima ModuleRef (put razrešavanja postoji)", () => {
    const deps =
      (Reflect.getMetadata("design:paramtypes", BankStatementService) as Array<{
        name?: string;
      }>) ?? [];
    expect(deps.some((d) => d?.name === "ModuleRef")).toBe(true);
  });
});
