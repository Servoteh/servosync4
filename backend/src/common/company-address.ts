/**
 * ADRESA FIRME-IZDAVAOCA NA PAPIRU — jedno mesto na kom se mesto i poštanski broj spajaju.
 *
 * ZAŠTO POSTOJI (odluka O-F10, 03.08.2026): do razdvajanja je `companies.city` držao
 * „11272 Dobanovci" kao JEDAN string, pa je desetak štampi pisalo
 * `[address, city].filter(Boolean).join(", ")` i time — bez izbora — nosilo poštanski
 * broj svuda. Od kada su to dve kolone (`city` + `postal_code`), svaka štampa bira šta
 * joj treba, ali oblik spajanja mora ostati JEDAN: „Ugrinovačka 163, 11272 Dobanovci",
 * a ne negde „11272, Dobanovci" a negde „Dobanovci 11272".
 *
 * ⚠️ NE KORISTI SE TAMO GDE PAPIR POŠTANSKI BROJ NEMA. Potpisni blok „Preuzeo za prevoz"
 * (`Dobanovci, Ugrinovačka 163`) i adresa magacina (`Ugrinovačka 163, Dobanovci`) na
 * donetim BigBit obrascima idu BEZ broja — one spajaju `address` i `city` direktno.
 * Zato ovde nema funkcije „adresa bez poštanskog broja": kad bi postojala, izbor između
 * dva oblika bi se svodio na to koje ime neko otkuca, umesto na ono što papir traži.
 */

/** Očisti i odbaci prazno — `null`, `undefined` i sami razmaci se ponašaju isto. */
function clean(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

/**
 * Mesto sa poštanskim brojem: `11272 Dobanovci`.
 *
 * Kad jednog od dva podatka nema, vraća se onaj drugi sam — nikad „11272" bez mesta uz
 * zarez ni prazan razmak koji na papiru izgleda kao izgubljen podatak.
 */
export function companyPlace(
  postalCode: string | null | undefined,
  city: string | null | undefined,
): string {
  return [clean(postalCode), clean(city)].filter(Boolean).join(" ");
}

/**
 * Pun adresni red izdavaoca: `Ugrinovačka 163, 11272 Dobanovci`.
 *
 * Ulica i mesto su odvojeni zarezom, poštanski broj i mesto razmakom — tako stoji u
 * memorandumu svih pet donetih papira. Prazni delovi se izostavljaju, pa firma bez
 * upisane adrese dobija samo mesto (i obrnuto), umesto reda koji počinje zarezom.
 */
export function companyAddressLine(
  address: string | null | undefined,
  postalCode: string | null | undefined,
  city: string | null | undefined,
): string {
  return [clean(address), companyPlace(postalCode, city)]
    .filter(Boolean)
    .join(", ");
}
