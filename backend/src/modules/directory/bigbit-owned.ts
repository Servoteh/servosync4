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
 * NAPOMENA O TEKSTU (druga ispravka, reopen 061/26 04.08.2026): tekst od
 * 04.08. ujutru je upućivao na dugme „Pokreni sync" (/syncs) — i to je bilo
 * POGREŠNO. Taj sync čita QBigTehn MSSQL kopiju koja je ZAMRZNUTA od
 * 22.07.2026 (BigBit→QBigTehn prenos ugašen; izmereno: MSSQL staje na predmetu
 * 10005, BigBit je tada bio na 10014), pa dugme NE MOŽE doneti nov komitent ni
 * predmet — Igor Voštić je 04.08. tačno tako i naleteo (pritisnuo sync, dobio
 * grešku, podatak nije stigao). Jedini kanal koji prati BigBit je NOĆNI .mdb
 * uvoz (`BigbitMdbImportService`, uvoz oko 03:45 — od 30.07. uvozi i komitente
 * i predmete; izvoz iz BigBita je prethodni dan u 17:30). Zato poruke sada kažu
 * istinu: podatak stiže automatski PREKO NOĆI, vidljiv je sutra ujutru.
 *
 * Ako se kanal ikad ubrza (npr. češći izvoz), OVDE se menja jedna rečenica i
 * nigde više — ovo je jedini izvor teksta i za backend i za ekrane
 * (`frontend/src/app/artikli/_forma/pravila.ts` drži presliku — menja se istim
 * PR-om).
 */

/** Šta korisnik radi kad mu treba NOV komitent. */
export const BIGBIT_CUSTOMERS_READ_ONLY_MESSAGE =
  "Komitente vodi BigBit — u ServoSync-u se ne unose ni ne menjaju (odluka 26.07.2026). " +
  "Novog komitenta unesite u BigBit — ovde stiže automatski noćnim uvozom i vidljiv je " +
  "sutra ujutru; ako ne može da čeka, obratite se administratoru.";

/** Šta korisnik radi kad mu treba NOV predmet (broj predmeta). */
export const BIGBIT_PROJECTS_READ_ONLY_MESSAGE =
  "Predmete i brojeve predmeta vodi BigBit — u ServoSync-u se ne otvaraju ni ne menjaju " +
  "(odluka 26.07.2026). Otvorite predmet u BigBit-u — ovde stiže automatski noćnim uvozom " +
  "i vidljiv je sutra ujutru; ako ne može da čeka, obratite se administratoru.";

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
