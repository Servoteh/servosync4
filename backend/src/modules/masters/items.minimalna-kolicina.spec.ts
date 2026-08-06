import "reflect-metadata";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ItemsService } from "./items.service";
import { ITEM_FIELDS_OWNED_BY_40 } from "./items.write-policy";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * UNOS MINIMALNE KOLIČINE — USKA RUTA KOJA SME I NAD BigBit-ovim ARTIKLOM.
 * =============================================================================
 * ODLUKA VLASNIKA 06.08.2026: „ISPOD MINIMALNE KOLIČINE UNOSE MAGACIONERI."
 *
 * Ovaj spec NAMERNO NE MOKUJE `items.write-policy` (za razliku od `items.write.spec.ts`,
 * koji simulira dan kad se otvori pun unos). Razlog: najvažnija tvrdnja ove rute je
 * da 409 brana `assertItemWritesAllowed()` NE sme da je zaustavi — a mok bi tu
 * tvrdnju pretvorio u tautologiju. Ovde je politika STVARNA, sa `ITEMS_WRITE_OPEN =
 * false`, tačno kao na produkciji.
 *
 * Zašto je to bezbedno: kolona `min_quantity` je istog dana izbačena iz sync mape,
 * pa je uvoz više ne prepisuje (brana: `sync/bigbit-mdb-import.items.spec.ts`).
 * Bez tog koraka bi ova ruta bila tih gubitak podatka — unos preko dana, brisanje
 * u 03:45.
 *
 * IZMERENO 06.08.2026: od 92.625 artikala samo 3 su 4.0-native, pa bi ruta koja
 * traži native red bila mrtvo slovo — 92.622 artikla bi vraćalo 409.
 */

const MAGACIONER: AuthUser = {
  userId: 51,
  email: "radisav.radevic@servoteh.com",
  role: "magacioner",
  workerId: null,
};

/** BigBit-origin artikal (id ispod native opsega) — tipičan slučaj na produkciji. */
const BIGBIT_ARTIKAL = {
  id: 12_640,
  catalogNumber: "R900407394",
  name: "Razvodni blok, 4-položajni",
  minQuantity: 2,
};

function makeService(zatecen: Record<string, unknown> | null = BIGBIT_ARTIKAL) {
  const update = jest.fn(
    (args: { where: { id: number }; data: Record<string, unknown> }) =>
      Promise.resolve({
        ...(zatecen ?? {}),
        id: args.where.id,
        minQuantity: args.data.minQuantity,
      }),
  );
  const prisma = {
    item: {
      findUnique: jest.fn(() => Promise.resolve(zatecen)),
      update,
    },
  };
  return {
    update,
    prisma: prisma as unknown as PrismaService,
    service: new ItemsService(prisma as unknown as PrismaService),
  };
}

function porukeOf(e: unknown): string[] {
  const body = (e as BadRequestException).getResponse() as {
    message: string[];
  };
  return body.message;
}

describe("ItemsService.setMinQuantity — minimalna količina nad BigBit artiklom", () => {
  it("MENJA minimalnu na BigBit-origin redu (409 brana se NE okida)", async () => {
    const { service, update } = makeService();

    const res = await service.setMinQuantity(
      BIGBIT_ARTIKAL.id,
      { minQuantity: 5 },
      MAGACIONER,
    );

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].where).toEqual({ id: BIGBIT_ARTIKAL.id });
    expect(update.mock.calls[0][0].data.minQuantity).toBe(5);
    expect(res.minQuantity).toBe(5);
    // Poruka na ekranu kaže ŠTA se promenilo, ne samo „sačuvano".
    expect(res.previousMinQuantity).toBe(2);
    expect(res.catalogNumber).toBe("R900407394");
  });

  it("dira ISKLJUČIVO minimalnu + trag izmene — nijednu BigBit kolonu", async () => {
    const { service, update } = makeService();

    await service.setMinQuantity(BIGBIT_ARTIKAL.id, { minQuantity: 5 }, MAGACIONER);

    const data = update.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual([
      "minQuantity",
      "updatedAt",
      "updatedBy",
    ]);
    // `signature` (BigBit `PotpisArt`) se NE prepisuje: menja se naša kolona, ne slog.
    expect(data).not.toHaveProperty("signature");
    expect(data).not.toHaveProperty("catalogNumber");
    // Trag nosi potpis korisnika (`signatureFor` = e-mail, isečen na 50 znakova).
    expect(data.updatedBy).toBe("radisav.radevic@servoteh.com");
    expect(data.updatedAt).toBeInstanceOf(Date);
  });

  it("`null` briše prag; `0` je prag nula — dve različite stvari", async () => {
    const { service, update } = makeService();

    await service.setMinQuantity(BIGBIT_ARTIKAL.id, { minQuantity: null }, MAGACIONER);
    expect(update.mock.calls[0][0].data.minQuantity).toBeNull();

    await service.setMinQuantity(BIGBIT_ARTIKAL.id, { minQuantity: 0 }, MAGACIONER);
    expect(update.mock.calls[1][0].data.minQuantity).toBe(0);
  });

  it("srpski decimalni zarez prolazi (magacioner kuca 2,5)", async () => {
    const { service, update } = makeService();
    await service.setMinQuantity(BIGBIT_ARTIKAL.id, { minQuantity: "2,5" }, MAGACIONER);
    expect(update.mock.calls[0][0].data.minQuantity).toBe(2.5);
  });

  it("negativna vrednost → 400 sa srpskom porukom, bez dodira baze", async () => {
    const { service, update } = makeService();
    await expect(
      service.setMinQuantity(BIGBIT_ARTIKAL.id, { minQuantity: -1 }, MAGACIONER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("smeće umesto broja → 400", async () => {
    const { service } = makeService();
    await expect(
      service.setMinQuantity(BIGBIT_ARTIKAL.id, { minQuantity: "abc" }, MAGACIONER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("telo sa DRUGIM poljem se ODBIJA, ne prećutkuje", async () => {
    // Najopasniji tihi kvar uske rute: klijent pošalje i `name`, ruta ga ignoriše,
    // korisnik veruje da je sačuvano. Ovde to pada sa imenom odbijenog polja.
    const { service, update } = makeService();
    let thrown: unknown;
    try {
      await service.setMinQuantity(
        BIGBIT_ARTIKAL.id,
        { minQuantity: 5, name: "podmetnuto" } as never,
        MAGACIONER,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(porukeOf(thrown)[0]).toContain("name");
    expect(update).not.toHaveBeenCalled();
  });

  it("prazno telo → 400 = Minimalna količina je obavezna", async () => {
    const { service } = makeService();
    let thrown: unknown;
    try {
      await service.setMinQuantity(BIGBIT_ARTIKAL.id, {} as never, MAGACIONER);
    } catch (e) {
      thrown = e;
    }
    expect(porukeOf(thrown)).toContain("Minimalna količina je obavezna.");
  });

  it("nepostojeći artikal → 404, ne tihi no-op", async () => {
    const { service } = makeService(null);
    await expect(
      service.setMinQuantity(999_999, { minQuantity: 5 }, MAGACIONER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("kolona je na spisku 4.0-owned — ruta i vlasništvo su jedna odluka", () => {
    // Ako neko ikad skine `minQuantity` sa tog spiska (jer je vratio kolonu u sync
    // mapu), ova ruta postaje tih gubitak podatka. Spisak i ruta zato padaju zajedno.
    expect([...ITEM_FIELDS_OWNED_BY_40]).toContain("minQuantity");
  });
});
