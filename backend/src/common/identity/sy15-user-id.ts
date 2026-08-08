import { UnprocessableEntityException } from "@nestjs/common";

/**
 * PREVOD IDENTITETA sy15 -> 3.0.
 *
 * 🔴 ZAŠTO OVAJ FAJL POSTOJI (i zašto je u `common`, a ne u modulu)
 *
 * U sy15 se čovek nosi kao `auth.users.id` (**uuid**); u 3.0 je isti pojam
 * `users.id` (**Int** — BACKEND_RULES §2.1: „ID-jevi NISU UUID"). Isti DTO
 * opslužuje oba položaja prekidača izvora, pa svaki modul koji se seli mora da
 * prevede uuid iz zahteva u 3.0 `users.id`. Do migracije
 * `20260808100000_users_sy15_user_id_prevod_identiteta` to NIJE bilo moguće —
 * `users` nije imao NIJEDNU kolonu sa sy15 uuid-om, pa je jedini pošten ishod bio
 * 422 (tiho `null` bi značilo „nalog sačuvan, dodela nestala").
 *
 * Sada prevod ima na čemu da stoji: `users.sy15_user_id` (nullable, UNIQUE).
 * Održavanje je prvi potrošač; ostali moduli sa istim šavom (`locations.moved_by`,
 * `pb_*`/`sastanci` kolone, `moj-profil`) mogu da koriste OVE funkcije umesto da
 * pišu svoju kopiju — pravilo „jedan izvor" iz memorije (RN brojevi) važi i za
 * prevodioce identiteta.
 */

/**
 * Kanonski uuid oblik. Namerno NE proverava verziju/varijantu: sy15 sadrži i
 * sintetičke uuid-e koji nisu v4 (npr. sistemski nalog ugašenog BIGTEHN mosta
 * `00000000-0000-0000-0000-000000000099`), a i oni su legitimni ulaz — samo se
 * ne poklope sa nijednim 3.0 nalogom, što je odvojena, prijavljena situacija.
 */
export const SY15_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function jeSy15Uuid(v: string): boolean {
  return SY15_UUID_RE.test(v);
}

/**
 * Minimalni ugovor prema 3.0 Prisma klijentu (i prema transakcionom klijentu).
 * Namerno uzak: prevod sme da pročita SAMO `users` po `sy15_user_id`, pa se ovaj
 * helper može proslediti i unutar tuđe transakcije bez ikakvog dodatnog prava.
 */
export interface Sy15IdentitetCitac {
  user: {
    findFirst(args: {
      where: { sy15UserId: string };
      select: { id: true };
    }): Promise<{ id: number } | null>;
  };
}

/**
 * sy15 `auth.users.id` (uuid) -> 3.0 `users.id` (Int).
 *
 * 🔴 KAD PARNJAKA NEMA, PADA — i to GLASNO, sa imenovanim uuid-om.
 * `null` bi prošao kroz Prisma sloj bez ijedne greške i upisao red u kome je
 * dodela ISPRAŽNJENA: nalog bi bio sačuvan, a čovek koji ga treba odraditi bi
 * nestao. Baš to je 422 sprečavao pre nego što je prevod postojao, i baš to
 * ostaje sprečeno posle njega. (Nullable kolona znači da 10 od 71 3.0 naloga
 * legitimno nema sy15 parnjaka — ali to je stanje NALOGA, ne dozvola da dodela
 * tiho ispari.)
 */
export async function prevediSy15UuidUId30(
  db: Sy15IdentitetCitac,
  uuid: string,
  polje: string,
): Promise<number> {
  // 🔴 `findFirst`, ne `findUnique`: Prisma NE stavlja NULLABLE unique kolone u
  // `WhereUniqueInput`, pa `findUnique({ where: { sy15UserId } })` ne prolazi ni
  // prevod. Jedinstvenost i dalje sprovodi baza (`uq_users_sy15_user_id`), tako da
  // „first" ovde znači „jedini" — nije to labavo poređenje nego ograničenje tipa.
  const nalog = await db.user.findFirst({
    where: { sy15UserId: uuid },
    select: { id: true },
  });
  if (!nalog) {
    throw new UnprocessableEntityException(
      `Polje „${polje}" nosi sy15 nalog ${uuid}, a taj nalog NIJE povezan sa nijednim ` +
        "korisnikom 3.0 baze (`users.sy15_user_id`) — dodela bi tiho nestala, pa je " +
        "odbijena. Poveži nalog (scripts/povezi-identitet-sy15.ts) ili izaberi drugog korisnika.",
    );
  }
  return nalog.id;
}
