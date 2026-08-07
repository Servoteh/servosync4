import { OdrzavanjeService } from "./odrzavanje.service";
import { Sy15Service } from "../../common/sy15/sy15.service";
import type { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import type { MasinaOtpisNotifyService } from "./masina-otpis-notify.service";

/**
 * 🔴 ZATEČEN KVAR: modul „Objekti" NIKAD nije radio na produkciji.
 *
 * Merenje 06.08.2026 (`pg_attribute` nad ŽIVOM sy15): `maint_facility_details`
 * ima TAČNO 14 kolona i `cadastral_parcels` NIJE među njima. `prisma/sy15.prisma`
 * ju je ipak deklarisao, pa je Prisma slala nepostojeću kolonu i u SELECT
 * (`findUnique`) i u INSERT/UPDATE (`upsert`); baza je vraćala 42703, a
 * `rethrowSy15` taj SQLSTATE ne mapira → 500. Posledica na produkciji:
 * `maint_assets` tipa `facility` = 0 redova, `maint_facility_details` = 0 redova.
 *
 * Popravka ima DVA dela i oba su ovde pinovana:
 *   1. polje je uklonjeno iz `prisma/sy15.prisma` (leči i ČITANJE);
 *   2. upis pod `sy15` više ne pominje parcele.
 * U 3.0 šemi kolona POSTOJI, pa preklop taj ekran popravlja u punom obimu.
 */
describe("Objekti — `cadastral_parcels` se pod sy15 NE ŠALJE u bazu", () => {
  function napravi() {
    const upsert = jest.fn().mockResolvedValue({ assetId: "A1" });
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ uid: 7 }]),
      maintFacilityDetails: { upsert },
    };
    const sy15 = {
      withUserRls: async (_e: string, fn: (t: unknown) => Promise<unknown>) =>
        fn(tx),
    } as unknown as Sy15Service;
    const svc = new OdrzavanjeService(
      sy15,
      {} as unknown as Sy15StorageService,
      { notifyOtpis: jest.fn() } as unknown as MasinaOtpisNotifyService,
    );
    return { svc, upsert };
  }

  it("🔴 ni `create` ni `update` ne nose `cadastralParcels` (bio 42703 → 500)", async () => {
    const { svc, upsert } = napravi();
    await svc.upsertFacilityDetails("n@x", "A1", {
      details: {
        facility_type: "hala",
        floor_area_m2: 120,
        cadastral_parcels: "1234/5, 1234/6",
        notes: "test",
      },
    } as never);

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(arg.create).not.toHaveProperty("cadastralParcels");
    expect(arg.update).not.toHaveProperty("cadastralParcels");
  });

  it("ostala polja objekta se i dalje upisuju (popravka ne sme da pojede ekran)", async () => {
    const { svc, upsert } = napravi();
    await svc.upsertFacilityDetails("n@x", "A1", {
      details: {
        facility_type: "hala",
        floor_area_m2: 120,
        floor_or_zone: "prizemlje",
        criticality: "high",
        service_provider: "Firma d.o.o.",
        notes: "test",
      },
    } as never);
    const arg = upsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(arg.update).toMatchObject({
      facilityType: "hala",
      floorAreaM2: 120,
      floorOrZone: "prizemlje",
      criticality: "high",
      serviceProvider: "Firma d.o.o.",
      notes: "test",
      updatedBy: 7,
    });
  });
});
