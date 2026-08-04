import { ConflictException } from "@nestjs/common";

/**
 * ODLUKA VLASNIKA 26.07.2026 — komitenti i predmeti se VIŠE NE UNOSE u ServoSync.
 *
 * Kontekst: završni račun za 2026. ostaje u BigBit-u, a prelazak na 4.0 se dokazuje
 * uporednim PDV obračunima. Da bi poređenje uopšte imalo smisla, šifarnici moraju
 * imati JEDNOG pisca — BigBit. Time je pregažena ranija odluka N3 („dvostruki unos
 * predmeta: prvo 3.0, pa isti broj u BigBit", 22.07.2026): 3.0 više nije master za
 * predmete i nema sopstvenu numeraciju (`ProjectNumberingService` je obrisan).
 *
 * Posledice u kodu:
 *   • `customers` i `projects` su READ-ONLY za celu aplikaciju; jedini pisac je sync
 *     modul (`src/modules/sync/`) — vidi „legitimni izuzeci" ispod.
 *   • Aplikativne write rute nad ta dva resursa se NE brišu nego odbijaju zahtev sa
 *     porukom koja korisniku kaže ŠTA DA RADI (410/404 bi bili nemi).
 *
 * LEGITIMNI IZUZECI (NISU ugašeni, namerno):
 *   1. `CustomerSyncer` (sync modul) — upsert komitenata iz BigBit-a; to JESTE uvoz.
 *   2. `GenericSyncer` + `ADDITIVE_REFRESH_TABLES`/`ADDITIVE_DEDUP_FIELDS` za
 *      `projects` — uvoz predmeta iz BigBit-a; additive režim i paritet-guard po
 *      `projectNumber` ostaju jer u bazi i dalje postoje ranije nastali 3.0-native
 *      predmeti koje pun `deleteMany` ne sme da obriše.
 */

/*
 * NAPOMENA O TEKSTU (ispravka 26.07.2026 posle recenzije): poruke su ranije
 * govorile „stiže sledećim uvozom iz BigBit-a", što je korisnika ostavljalo da
 * čeka proces koji ne postoji. Šifarnički (MSSQL) sync komitenata i predmeta
 * NIJE zakazan — pokreće se isključivo rutom `POST /api/v1/sync/run` sa ekrana
 * `/syncs`. Permisiju `sync.run` od 04.08.2026 (zahtev 061/26, odluka Nenad)
 * imaju tehnolozi + planeri + admin (role: tehnolog/menadzment/admin), pa tekst
 * više ne upućuje isključivo na administratora. Noćni .mdb kanal je druga stvar
 * i NE uvozi komitente ni predmete.
 *
 * Kad se šifarnički sync zakaže (posao u scheduler-u), OVDE se menja jedna
 * rečenica i nigde više — ovo je jedini izvor teksta i za backend i za ekrane.
 */

/** Šta korisnik radi kad mu treba NOV komitent. */
export const BIGBIT_CUSTOMERS_READ_ONLY_MESSAGE =
  "Komitente vodi BigBit — u ServoSync-u se ne unose ni ne menjaju (odluka 26.07.2026). " +
  "Novog komitenta unesite u BigBit, pa pokrenite uvoz (Sinhronizacije → Pokreni sync) " +
  "ili to zatražite od tehnologa/planera/administratora; tek tada se komitent vidi ovde.";

/** Šta korisnik radi kad mu treba NOV predmet (broj predmeta). */
export const BIGBIT_PROJECTS_READ_ONLY_MESSAGE =
  "Predmete i brojeve predmeta vodi BigBit — u ServoSync-u se ne otvaraju ni ne menjaju " +
  "(odluka 26.07.2026). Otvorite predmet u BigBit-u, pa pokrenite uvoz (Sinhronizacije → " +
  "Pokreni sync) ili to zatražite od tehnologa/planera/administratora; tek tada se broj " +
  "predmeta vidi ovde.";

/**
 * Poslovna greška: pokušaj upisa u tabelu čiji je vlasnik BigBit.
 *
 * 409 (a ne 403) je namerno — nije stvar prava korisnika nego stanja sistema; 403 bi
 * korisnika poslao da traži dozvolu koja ne postoji. `code` je stabilan za frontend.
 */
export class BigBitOwnedDataException extends ConflictException {
  constructor(message: string) {
    super({
      statusCode: 409,
      error: "Conflict",
      code: "BIGBIT_OWNED_READ_ONLY",
      message,
    });
  }
}

/** Odbij upis u `customers`. */
export function rejectCustomerWrite(): never {
  throw new BigBitOwnedDataException(BIGBIT_CUSTOMERS_READ_ONLY_MESSAGE);
}

/** Odbij upis u `projects`. */
export function rejectProjectWrite(): never {
  throw new BigBitOwnedDataException(BIGBIT_PROJECTS_READ_ONLY_MESSAGE);
}
