import { Transform } from "class-transformer";
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

/**
 * Tela auth ruta (`/auth/login`, `/auth/sso`, `/auth/change-password`).
 *
 * ═══ KLASE, NE INTERFEJSI (P12, 06.08.2026) ══════════════════════════════════════════
 * Do sada su ovo bili interfejsi u `auth.controller.ts`. Interfejs u runtime-u ne
 * postoji, pa `design:paramtypes` nosi `Object` — a `Object` globalni `ValidationPipe`
 * PRESKAČE u celosti. Telo triju spolja dostupnih ruta (prijava, SSO, promena lozinke)
 * stizalo je do servisa nevalidirano i bez `whitelist`-a: `{"email": {…}}` je ulazio do
 * `AuthService.validate`, gde `email.toLowerCase()` puca → 500 umesto 400.
 *
 * 🔴 UVOZI SE VREDNOSNO (`import { LoginDto }`), NIKAD `import type` — vidi
 * `src/common/controller-body-dto.spec.ts` (kvar od 05.08.2026: klasa uvezena kao tip
 * daje `Function`, pa pipe telo UNIŠTI). Ta brana meri ovaj fajl automatski.
 *
 * ═══ ZAŠTO BAŠ OVA PRAVILA (merenje na produkciji, 06.08.2026) ═══════════════════════
 * `servosync-pg` / tabela `users`, 71 nalog (svi aktivni):
 *   • e-pošta: 71/71 mala slova i standardnog oblika `x@y.z`, dužine 17–34 znaka
 *     → `@IsEmail()` + `@MaxLength(254)` ne zaključavaju NIJEDAN postojeći nalog.
 *   • lozinke: 71/71 bcrypt heš (`$2a$` 55, `$2b$` 16), svi dužine 60 znakova.
 *     🔴 Iz bcrypt heša se DUŽINA SAME LOZINKE NE MOŽE PROČITATI (jednosmerna funkcija).
 *     Zato na lozinkama za PRIJAVU nema `@MinLength`: pravilo „najmanje 8" bi trajno
 *     zaključalo svakoga ko danas ima kraću lozinku, a ne postoji način da se izmeri
 *     koliko je takvih. Minimum se sprovodi SAMO tamo gde se lozinka POSTAVLJA
 *     (`ChangePasswordDto.newPassword`), gde pravilo ionako već važi.
 *
 * ═══ PORUKE ══════════════════════════════════════════════════════════════════════════
 * Sve poruke su srpske i pisane za korisnika na ekranu za prijavu. Govore ISKLJUČIVO o
 * obliku unosa — nikad o tome da li nalog postoji, je li aktivan ili koja je polovina
 * para pogrešna. Neuspela prijava ostaje neutralna 401 iz `AuthService`.
 */

/** Gornja granica dužine lozinke — zaštita od apsurdnog tela, ne bezbednosno pravilo.
 *  1024 je daleko iznad svakog password managera (obično do 64), pa nikoga ne dodiruje.
 *  Namerno NIJE 72 (bcrypt-ova granica) — to bi bilo novo pravilo za korisnike. */
const MAX_LOZINKA = 1024;

/** RFC 5321 gornja granica adrese; izmereni maksimum na produkciji je 34 znaka. */
const MAX_EPOSTA = 254;

/**
 * Trim e-pošte PRE `@IsEmail`. `AuthService.validate` ionako radi `.toLowerCase().trim()`,
 * pa bi validacija bez trima bila STROŽA od današnjeg ponašanja: mobilne tastature rutinski
 * dodaju razmak na kraj, a `/mob/prijava` šalje `email.trim()` dok `pdm-bridge` uzima
 * vrednost iz `.env` bez čišćenja. Ovim ostaje tačno ono što danas prolazi.
 */
const trim = Transform(({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value,
);

/**
 * ⚠️ ZAŠTO SU PORUKE OVAKO FORMULISANE: `class-validator` prijavi SVE prekršaje polja
 * odjednom (globalni pipe nema `stopAtFirstError`, a lokalni ga ne može nadjačati —
 * globalni se izvršava prvi). Za `{"password": 12345}` bi se tako okinuo i `@MaxLength`,
 * pa bi korisnik na ekranu za prijavu pročitao „Lozinka je predugačka." — netačno i
 * zbunjujuće. Zato dužinske poruke govore i o TIPU („mora biti tekst, najviše N znakova"),
 * pa su tačne u oba slučaja; a `@IsNotEmpty` i `@IsString` imaju RAZLIČIT tekst da se
 * ista rečenica ne ponovi dvaput. Izmereno: unos sa tastature (uvek string) daje tačno
 * JEDNU poruku; više njih dobija samo klijent koji šalje ne-string, što nijedna forma ne radi.
 */

/** Telo `POST /auth/login` — e-pošta + lozinka. */
export class LoginDto {
  /* Bez `@IsNotEmpty`: prazan string ionako pada na `@IsEmail`, pa bi samo dodao drugu
     poruku o istoj grešci. */
  @trim
  @IsString({ message: "E-pošta je obavezna." })
  @MaxLength(MAX_EPOSTA, {
    message: `E-pošta mora biti tekst, najviše ${MAX_EPOSTA} znakova.`,
  })
  @IsEmail({}, { message: "E-pošta nije ispravnog oblika." })
  email!: string;

  /* Bez `@MinLength` — vidi merenje u zaglavlju: dužina postojećih lozinki je nemerljiva. */
  @IsString({ message: "Lozinka je obavezna." })
  @IsNotEmpty({ message: "Lozinka ne sme biti prazna." })
  @MaxLength(MAX_LOZINKA, {
    message: `Lozinka mora biti tekst, najviše ${MAX_LOZINKA} znakova.`,
  })
  password!: string;
}

/**
 * Telo `POST /auth/sso` — 1.0/1.5 GoTrue access token (HS256), koji `AuthService.ssoLogin`
 * verifikuje deljenim `SY15_JWT_SECRET`.
 *
 * Namerno BEZ `@IsJWT()`: oblik živih GoTrue tokena nije izmeren (za merenje bi trebalo
 * napraviti pravu 1.0 sesiju), a SSO su ulazna vrata iz starog sistema — pravilo koje
 * nije izmereno ovde može da zatvori jedini put u aplikaciju. Potpis/istek i inače
 * proverava servis i vraća neutralnu 401. Ovde se rešava stvarni nalaz: ne-string
 * vrednost je ranije prolazila do `jwt.verifyAsync` i throttle brojača.
 */
export class SsoDto {
  @IsString({ message: "SSO token je obavezan." })
  @IsNotEmpty({ message: "SSO token ne sme biti prazan." })
  @MaxLength(8192, {
    message: "SSO token mora biti tekst, najviše 8192 znaka.",
  })
  token!: string;
}

/** Min. dužina NOVE lozinke — isto pravilo koje `AuthService.changePassword` već sprovodi
 *  (`MIN_PASSWORD_LENGTH`) i koje FE forme (`/promena-lozinke`, `/mob/prijava`) već traže.
 *  Ovde se samo pomera ranije, pa greška stiže pre svakog rada sa bazom. */
export const MIN_NOVA_LOZINKA = 8;

/** Telo `POST /auth/change-password` — self-service promena lozinke (B2). */
export class ChangePasswordDto {
  /* TRENUTNA lozinka NEMA minimum: ona je već postavljena i može biti kraća od 8
     (nalozi stariji od pravila). Minimum bi tu zaključao promenu lozinke baš onima
     kojima je najpotrebnija. */
  @IsString({ message: "Trenutna lozinka je obavezna." })
  @IsNotEmpty({ message: "Trenutna lozinka ne sme biti prazna." })
  @MaxLength(MAX_LOZINKA, {
    message: `Trenutna lozinka mora biti tekst, najviše ${MAX_LOZINKA} znakova.`,
  })
  currentPassword!: string;

  /* `@MinLength` pokriva i prazno i prekratko, pa `@IsNotEmpty` ovde nije potreban. */
  @IsString({ message: "Nova lozinka je obavezna." })
  @MinLength(MIN_NOVA_LOZINKA, {
    message: `Nova lozinka mora imati najmanje ${MIN_NOVA_LOZINKA} karaktera.`,
  })
  @MaxLength(MAX_LOZINKA, {
    message: `Nova lozinka mora biti tekst, najviše ${MAX_LOZINKA} znakova.`,
  })
  newPassword!: string;
}
