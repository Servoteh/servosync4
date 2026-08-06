import "reflect-metadata";
import { PrismaService } from "../../prisma/prisma.service";
import { ItemsService } from "./items.service";
import {
  ITEM_FIELDS_OWNED_BY_40,
  MIN_QUANTITY_BIGBIT_OWNED_MESSAGE,
  VLASNIK_MINIMALNE_KOLICINE,
} from "./items.write-policy";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * MINIMALNA KOLIČINA — DANAS SE UNOSI U BigBit-u, RUTA ODBIJA UPIS.
 * =============================================================================
 * ISPRAVKA VLASNIKA 06.08.2026 (istog dana kad je unos bio otvoren commitom
 * `b2d11e8c`): „Ma pazi, ovde nema UNOSA dok ne krenemo da radimo sa APP. Rekli smo
 * da ćemo samo čitati podatke iz BigBita. Neka ti je pripremljeno sve, ali nećemo
 * ga testirati."
 *
 * Ruta `PATCH /v1/artikli/:id/minimalna-kolicina` i pravo `masters.min_quantity`
 * zato OSTAJU — pripremljeni su, i troje imenovanih pravo već nosi na produkciji.
 * Ali dok kolonom vlada BigBit (`VLASNIK_MINIMALNE_KOLICINE = "BigBit"`), upis mora
 * da bude ODBIJEN, i to razumljivom porukom.
 *
 * 🔴 ZAŠTO ODBIJANJE, A NE TIHO PRIHVATANJE: kolona `Minimalna kolicina` je u sync
 * mapi, pa je noćni uvoz u 03:45 prepisuje BigBit-ovom vrednošću. Mereno na
 * produkciji 06.08.2026: `bb_mdb_stage_artikli` ↔ `items` po `external_item_id` daje
 * 0 razlika na 92.623 uparena reda — dakle uvoz drži kolonu u savršenom koraku sa
 * BigBitom i pregazio bi svaki unos, bez greške i bez traga u logu. Prihvatiti izmenu
 * koja će nestati gore je nego odbiti je.
 *
 * PONAŠANJE PRIPREMLJENE RUTE (šta se dešava kad prekidač 01.04.2027 stane na „4.0")
 * pinuje `items.minimalna-kolicina-posle-prelaska.spec.ts` — ovde bi bilo neizvodljivo,
 * jer brana odbija pre nego što se telo zahteva uopšte pogleda.
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

function makeService() {
  const prisma = {
    item: {
      findUnique: jest.fn(() => Promise.resolve(BIGBIT_ARTIKAL)),
      update: jest.fn(() => Promise.resolve(BIGBIT_ARTIKAL)),
    },
  };
  return {
    findUnique: prisma.item.findUnique,
    update: prisma.item.update,
    service: new ItemsService(prisma as unknown as PrismaService),
  };
}

async function uhvati(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return null;
}

function telo(e: unknown): Record<string, unknown> {
  return (e as { getResponse: () => Record<string, unknown> }).getResponse();
}

describe("ItemsService.setMinQuantity — dok kolonom vlada BigBit, upis se ODBIJA", () => {
  it("zatečeno stanje prekidača je „BigBit”", () => {
    expect(VLASNIK_MINIMALNE_KOLICINE).toBe("BigBit");
  });

  it("ispravan upis nad BigBit artiklom → 409, i baza se NE dira", async () => {
    const { service, update, findUnique } = makeService();

    const e = await uhvati(() =>
      service.setMinQuantity(BIGBIT_ARTIKAL.id, { minQuantity: 5 }, MAGACIONER),
    );

    expect(e).not.toBeNull();
    expect(telo(e).statusCode).toBe(409);
    expect(telo(e).code).toBe("BIGBIT_OWNED_READ_ONLY");
    // Ni čitanja ni upisa: odbija se pre nego što se artikal uopšte potraži.
    expect(findUnique).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("poruka objašnjava ZAŠTO — BigBit, noćni uvoz u 03:45, do prelaska", async () => {
    // ⚠️ Ovo je razlog postojanja cele izmene: čovek koji dobije „nije dozvoljeno"
    // bez razloga pokušaće ponovo ili prijaviti kvar. Poruka mora da ga uputi u
    // BigBit i da kaže do kada pravilo važi.
    const { service } = makeService();
    const e = await uhvati(() =>
      service.setMinQuantity(BIGBIT_ARTIKAL.id, { minQuantity: 5 }, MAGACIONER),
    );
    expect(String(telo(e).message)).toBe(MIN_QUANTITY_BIGBIT_OWNED_MESSAGE);
    expect(String(telo(e).message)).toContain("BigBit-u");
    expect(String(telo(e).message)).toContain("03:45");
    expect(String(telo(e).message)).toContain("01.04.2027");
  });

  it("odbija se PRE validacije tela — 409 i za neispravan unos, ne 400", async () => {
    // Da se prvo validiralo telo, magacioner bi po vrsti greške mogao da zaključi da
    // bi „ispravan" broj prošao (400 na zarez, 409 na broj) — pa bi pokušavao dok ne
    // pogodi. Odbijanje mora biti jednako glasno za svaki unos.
    const { service, update } = makeService();
    for (const zahtev of [
      { minQuantity: -1 }, // negativno
      { minQuantity: "abc" }, // smeće
      { minQuantity: 5, name: "podmetnuto" }, // višak polja
      {}, // prazno telo
      { minQuantity: null }, // „obriši prag"
    ]) {
      const e = await uhvati(() =>
        service.setMinQuantity(BIGBIT_ARTIKAL.id, zahtev as never, MAGACIONER),
      );
      expect(telo(e).statusCode).toBe(409);
      expect(telo(e).code).toBe("BIGBIT_OWNED_READ_ONLY");
    }
    expect(update).not.toHaveBeenCalled();
  });

  it("ni 4.0-native artikal ne prolazi — vlasništvo je po KOLONI, ne po redu", async () => {
    // Zamka: „native red je naš, pa valjda sme". Ne sme — kolona je u sync mapi za
    // sve redove, a pravilo mora da bude jedno, inače bi se ista kolona ponašala
    // različito na 3 od 92.625 artikala.
    const { service, update } = makeService();
    const e = await uhvati(() =>
      service.setMinQuantity(900_000_001, { minQuantity: 5 }, MAGACIONER),
    );
    expect(telo(e).statusCode).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it("kolona NIJE 4.0-owned — spisak prati prekidač", () => {
    // Ogledalo tvrdnje iz `items.write-policy.spec.ts`: da je `minQuantity` ostao na
    // spisku dok upis pada, spisak bi lagao o tome ko puni kolonu.
    expect([...ITEM_FIELDS_OWNED_BY_40]).not.toContain("minQuantity");
  });
});
