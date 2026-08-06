import "reflect-metadata";

/**
 * MINIMALNA KOLIČINA POSLE PRELASKA — PREKIDAČ NA „4.0", UPIS MORA DA PROĐE.
 * =============================================================================
 * Vlasnik je 06.08.2026. rekao: „Neka ti je PRIPREMLJENO SVE, ali nećemo ga
 * testirati." Ruta i pravo zato postoje, a upis danas pada na 409 (v.
 * `items.minimalna-kolicina.spec.ts`). Ovaj spec pinuje ŠTA SE TAČNO DEŠAVA kad
 * prekidač 01.04.2027 stane na „4.0" — bez njega bi pripremljena ruta bila kod koji
 * nikad nije radio, a na dan prelaska se ne otkrivaju bagovi.
 *
 * 🔴 MOKUJE SE SAMO PREKIDAČ, NE I BRANA. `assertMinQuantityWriteAllowed` dolazi iz
 * `requireActual` i stvarno se izvršava — samo dobija drugu vrednost prekidača. Da
 * je mokovana i brana, tvrdnja „upis prolazi" bila bi tautologija (mok uvek prolazi),
 * pa test ne bi primetio branu koja odbija u oba stanja.
 *
 * ⚠️ Sync mapa se OVDE NE MOKUJE i zato se ne dodiruje: odnos prekidača i mape čuva
 * `items.minimalna-kolicina-prekidac.spec.ts`, koji poredi oba smera nad stvarnom
 * mapom. Ovde je predmet isključivo ponašanje servisa.
 */
jest.mock("./items.write-policy", () => ({
  ...jest.requireActual<typeof import("./items.write-policy")>(
    "./items.write-policy",
  ),
  // Jedina izmena: dan posle prelaska. Sve ostalo je stvarno.
  VLASNIK_MINIMALNE_KOLICINE: "4.0",
}));

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ItemsService } from "./items.service";
import { VLASNIK_MINIMALNE_KOLICINE } from "./items.write-policy";
import type { AuthUser } from "../auth/jwt.strategy";

const MAGACIONER: AuthUser = {
  userId: 51,
  email: "radisav.radevic@servoteh.com",
  role: "magacioner",
  workerId: null,
};

/** BigBit-origin artikal (id ispod native opsega) — 92.622 od 92.625 su takvi. */
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
    service: new ItemsService(prisma as unknown as PrismaService),
  };
}

function porukeOf(e: unknown): string[] {
  const body = (e as BadRequestException).getResponse() as { message: string[] };
  return body.message;
}

describe("ItemsService.setMinQuantity — posle prelaska (prekidač = „4.0”)", () => {
  it("mok je stvarno prevrnuo prekidač (inače ceo spec ništa ne dokazuje)", () => {
    // Bez ove provere bi loše postavljen mok tiho pretvorio ceo fajl u testiranje
    // današnjeg stanja — i „upis prolazi" bi počeo da laže.
    expect(VLASNIK_MINIMALNE_KOLICINE).toBe("4.0");
  });

  it("MENJA minimalnu na BigBit-origin redu — 409 brana kartice se NE okida", async () => {
    // Cela poenta uske rute: da radi nad artiklom koji je došao iz BigBita. Da traži
    // 4.0-native red, pravo bi bilo mrtvo slovo za 92.622 od 92.625 artikala.
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
    // `signature` (BigBit `PotpisArt`) se NE prepisuje: menja se jedna kolona, ne slog.
    expect(data).not.toHaveProperty("signature");
    expect(data).not.toHaveProperty("catalogNumber");
    // Trag nosi potpis korisnika (`signatureFor` = e-mail, isečen na 50 znakova).
    expect(data.updatedBy).toBe("radisav.radevic@servoteh.com");
    expect(data.updatedAt).toBeInstanceOf(Date);
  });

  it("`null` briše prag; `0` je prag nula — dve različite stvari", async () => {
    // Mereno na produkciji 06.08.2026: 92.460 artikala ima 0, a 3 imaju prazno.
    const { service, update } = makeService();

    await service.setMinQuantity(
      BIGBIT_ARTIKAL.id,
      { minQuantity: null },
      MAGACIONER,
    );
    expect(update.mock.calls[0][0].data.minQuantity).toBeNull();

    await service.setMinQuantity(BIGBIT_ARTIKAL.id, { minQuantity: 0 }, MAGACIONER);
    expect(update.mock.calls[1][0].data.minQuantity).toBe(0);
  });

  it("srpski decimalni zarez prolazi (magacioner kuca 2,5)", async () => {
    const { service, update } = makeService();
    await service.setMinQuantity(
      BIGBIT_ARTIKAL.id,
      { minQuantity: "2,5" },
      MAGACIONER,
    );
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
});
