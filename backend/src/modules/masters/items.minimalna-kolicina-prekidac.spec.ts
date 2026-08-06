import "reflect-metadata";
import { SYNC_MAP } from "../sync/sync-map.generated";
import {
  assertMinQuantityWriteAllowed,
  ITEM_FIELDS_OWNED_BY_40,
  minimalnaKolicinaMoraBitiUSyncMapi,
  minimalnuKolicinuUnosiAplikacija,
  MIN_QUANTITY_BIGBIT_OWNED_MESSAGE,
  razilazenjeVlasnistvaMinimalne,
  syncMapaSadrziMinimalnu,
  VLASNIK_MINIMALNE_KOLICINE,
  type VlasnikMinimalneKolicine,
} from "./items.write-policy";

/**
 * PREKIDAČ VLASNIŠTVA NAD `items.min_quantity` — BRANA ZA OBA SMERA.
 * =============================================================================
 * Ovaj spec postoji zato što je JEDNA odluka razbacana na DVA mesta koja se ne vide
 * jedno iz drugog: prekidač `VLASNIK_MINIMALNE_KOLICINE` (`items.write-policy.ts`) i
 * kolona `Minimalna kolicina` u sync mapi (`sync/sync-map.generated.ts`). Kad se
 * raziđu, NIŠTA NE PUKNE — podatak samo prestane da bude istinit:
 *
 *   • prekidač „BigBit" + kolona VAN mape (stanje koje je commit `b2d11e8c`
 *     napravio 06.08.2026): uvoz je prestao da puni kolonu, a unos je odbijen, pa je
 *     NE PUNI NIKO. Ostala bi zamrznuta na 162 vrednosti (mereno na produkciji
 *     06.08.2026: 162 ≠ 0, 92.460 nula, 3 prazno, od 92.625) i tiho zastarevala.
 *   • prekidač „4.0" + kolona U mapi: unos prolazi, pa ga uvoz u 03:45 prepiše
 *     BigBit-ovom vrednošću. Bez greške i bez traga u logu.
 *
 * Taj razred kvara je 06.08.2026. dva puta ujeo ovaj projekat (podaci firme i ova
 * kolona), pa se ne čuva komentarom nego testom.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * KAKO JE FAJL PODELJEN — I ŠTA SE MENJA 01.04.2027
 * ─────────────────────────────────────────────────────────────────────────────
 *   1) „ZATEČENO STANJE" — jedine tvrdnje o DANAŠNJEM izboru. Na dan prelaska se
 *      menjaju SVE ZAJEDNO, i to je namerno: ako neko prevrne prekidač a ostavi
 *      mapu (ili obrnuto), ovde puca odmah, sa uputstvom šta fali.
 *   2) „IZVEDENA PONAŠANJA" — ne zavise od izabranog stanja; puštaju se nad OBA
 *      (`SVA_STANJA`) i posle prelaska ostaju nepromenjene. Test koji tvrdi samo
 *      ono što danas jeste ne bi pao kad se pokvari polovina odluke.
 */

/** Oba stanja prekidača — nijedno se ne testira samo. */
const SVA_STANJA: VlasnikMinimalneKolicine[] = ["BigBit", "4.0"];

/** Vraća bačenu grešku ili `null` ako je upis prošao. */
function odbijenica(vlasnik: VlasnikMinimalneKolicine): unknown {
  try {
    assertMinQuantityWriteAllowed(vlasnik);
  } catch (e) {
    return e;
  }
  return null;
}

// ═════════════════════════════════════════════════════════ 1) ZATEČENO STANJE

describe("ZATEČENO STANJE — do prelaska (01.04.2027) kolonu drži BigBit", () => {
  it("prekidač stoji na „BigBit”", () => {
    // Vlasnik, 06.08.2026: „ovde nema UNOSA dok ne krenemo da radimo sa APP.
    // Rekli smo da ćemo samo čitati podatke iz BigBita."
    expect(VLASNIK_MINIMALNE_KOLICINE).toBe("BigBit");
  });

  it("`minQuantity` JE u sync mapi `items` — noćni uvoz nastavlja da je puni", () => {
    // Ako ovo padne, kolonu ne puni niko: uvoz je izbačen, a unos je odbijen.
    expect(syncMapaSadrziMinimalnu(SYNC_MAP)).toBe(true);

    const artikli = SYNC_MAP.find((m) => m.source === "R_Artikli");
    const kolona = artikli?.columns.find((c) => c.field === "minQuantity");
    expect(kolona?.src).toBe("Minimalna kolicina");
    expect(kolona?.type).toBe("Float");
    expect(kolona?.nullable).toBe(true);
  });

  it("spisak 4.0-owned kolona je PRAZAN — 4.0 matične podatke samo čita", () => {
    expect([...ITEM_FIELDS_OWNED_BY_40]).toEqual([]);
  });

  it("🔴 prekidač i sync mapa se SLAŽU", () => {
    // OVO JE TEST KOJI PADA na dan kad neko uradi POLA posla — prebaci prekidač a
    // ostavi kolonu u mapi, ili obriše kolonu a ostavi prekidač. Poruka razilaženja
    // nabraja šta treba uraditi, pa se ne mora tražiti po fajlovima.
    const razilazenje = razilazenjeVlasnistvaMinimalne(
      VLASNIK_MINIMALNE_KOLICINE,
      syncMapaSadrziMinimalnu(SYNC_MAP),
    );
    expect(razilazenje).toBeNull();
  });
});

// ══════════════════════════════════════════════════════ 2) IZVEDENA PONAŠANJA

describe("izvedena ponašanja — važe za OBA stanja prekidača", () => {
  it("„unosi aplikacija” i „stoji u mapi” su uvek OBRNUTI", () => {
    // Srž prekidača: nikad oboje `true` (uvoz gazi unos) ni oboje `false` (kolonu ne
    // puni niko). Oba kvara su tiha, pa se ovde zabranjuju po konstrukciji.
    for (const vlasnik of SVA_STANJA)
      expect(minimalnuKolicinuUnosiAplikacija(vlasnik)).toBe(
        !minimalnaKolicinaMoraBitiUSyncMapi(vlasnik),
      );
  });

  it("`ITEM_FIELDS_OWNED_BY_40` je IZVEDEN iz prekidača, ne zapisan rukom", () => {
    // Da je spisak pisan rukom, mogao bi da tvrdi da je kolona naša dok je prekidač
    // kaže BigBitovom — i uska ruta upisa bi postala tih gubitak podatka.
    expect(ITEM_FIELDS_OWNED_BY_40.length).toBe(
      minimalnuKolicinuUnosiAplikacija(VLASNIK_MINIMALNE_KOLICINE) ? 1 : 0,
    );
  });

  it("upis i mapa su IZVEDENI iz istog prekidača — nikad saglasni", () => {
    // Kad bi se ijedno od dva izvelo iz svoje konstante, ovde bi se pojavilo stanje
    // u kome i uvoz i korisnik pišu istu kolonu.
    for (const vlasnik of SVA_STANJA) {
      const upisProlazi = odbijenica(vlasnik) === null;
      const mapaTrazi = minimalnaKolicinaMoraBitiUSyncMapi(vlasnik);
      expect(upisProlazi).toBe(!mapaTrazi);
      // Slaganje prekidača i mape nikad ne prijavljuje razilaženje.
      expect(razilazenjeVlasnistvaMinimalne(vlasnik, mapaTrazi)).toBeNull();
    }
  });
});

// ───────────────────────────────────────────────── SMER 1: prekidač na „BigBit"

describe("prekidač = „BigBit” → kolona MORA u mapi, upis MORA da padne", () => {
  it("upis je ODBIJEN sa 409 i stabilnim `code`, ne 403", () => {
    // 409, ne 403: troje imenovanih pravo `masters.min_quantity` STVARNO ima —
    // odbija stanje sistema, ne njihova prava. Da vraća 403, ekran bi im rekao
    // „nemate pristup", što je neistina i vodi na pogrešnu prijavu greške.
    const e = odbijenica("BigBit");
    expect(e).not.toBeNull();
    const body = (e as { getResponse: () => Record<string, unknown> }).getResponse();
    expect(body.statusCode).toBe(409);
    expect(body.code).toBe("BIGBIT_OWNED_READ_ONLY");
  });

  it("poruka kaže i ZAŠTO — ne samo „nije dozvoljeno”", () => {
    // ⚠️ SUŠTINA: tiho prihvatanje izmene koja će nestati gore je od odbijanja, a
    // odbijanje bez razloga je skoro isto tako loše — čovek pokuša ponovo ili
    // prijavi „aplikacija ne radi" umesto da ode u BigBit.
    const poruka = String(MIN_QUANTITY_BIGBIT_OWNED_MESSAGE);
    expect(poruka).toContain("BigBit"); // gde se unosi
    expect(poruka).toContain("03:45"); // ko bi pregazio vrednost
    expect(poruka).toContain("noćni uvoz"); // mehanizam
    expect(poruka).toContain("01.04.2027"); // do kad pravilo važi
    expect(poruka).toMatch(/ne zbog vaših prava/i); // nije stvar prava
    // Ista poruka stiže i iz brane, ne samo iz konstante.
    const body = (
      odbijenica("BigBit") as { getResponse: () => Record<string, unknown> }
    ).getResponse();
    expect(String(body.message)).toBe(poruka);
  });

  it("kolona se traži U mapi", () => {
    expect(minimalnaKolicinaMoraBitiUSyncMapi("BigBit")).toBe(true);
    expect(razilazenjeVlasnistvaMinimalne("BigBit", true)).toBeNull();
    expect(razilazenjeVlasnistvaMinimalne("BigBit", false)).not.toBeNull();
  });
});

// ───────────────────────────────────────── SMER 2: prekidač na „4.0" (01.04.2027)

describe("prekidač = „4.0” → kolona NE SME u mapi, upis MORA da prođe", () => {
  it("upis PROLAZI — brana ne baca ništa", () => {
    // Drugi smer koji test mora da čuva: da je brana napisana kao „uvek odbij", danas
    // bi izgledala ispravno, a 01.04.2027 bi pravo ostalo mrtvo slovo i niko ne bi
    // znao zašto. (Ponašanje same rute pod „4.0" pinuje
    // `items.minimalna-kolicina-posle-prelaska.spec.ts`.)
    expect(() => assertMinQuantityWriteAllowed("4.0")).not.toThrow();
    expect(odbijenica("4.0")).toBeNull();
  });

  it("kolona se traži VAN mape", () => {
    expect(minimalnaKolicinaMoraBitiUSyncMapi("4.0")).toBe(false);
    expect(razilazenjeVlasnistvaMinimalne("4.0", false)).toBeNull();
    expect(razilazenjeVlasnistvaMinimalne("4.0", true)).not.toBeNull();
  });
});

// ─────────────────────────────────────────────── obe odbijenice se IMENUJU

describe("razilaženje se imenuje, u oba smera, sa uputstvom šta uraditi", () => {
  it("„BigBit” + kolona van mape → kolonu ne puni NIKO", () => {
    // Bez ove tvrdnje bi brana mogla da vraća `null` uvek, a testovi slaganja bi i
    // dalje bili zeleni — dakle ne bi vredeli ništa.
    const poruka = razilazenjeVlasnistvaMinimalne("BigBit", false);
    expect(poruka).not.toBeNull();
    expect(poruka).toContain("NIKO");
    expect(poruka).toContain("zastareva");
  });

  it("„4.0” + kolona u mapi → uvoz u 03:45 gazi unos", () => {
    const poruka = razilazenjeVlasnistvaMinimalne("4.0", true);
    expect(poruka).not.toBeNull();
    expect(poruka).toContain("03:45");
    expect(poruka).toMatch(/bez traga/);
  });
});
