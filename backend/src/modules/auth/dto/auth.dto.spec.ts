import { ArgumentMetadata, ValidationPipe } from "@nestjs/common";
import { ChangePasswordDto, LoginDto, SsoDto } from "./auth.dto";

/**
 * Vozi TAČNO ono što globalni pipe iz `main.ts` radi (`transform: true, whitelist: true`)
 * nad auth telima. E2E brana (`test/auth-body-validation.e2e-spec.ts`) meri HTTP status;
 * ovaj spec meri šta od tela PREŽIVI — jedino mesto gde se `whitelist` vidi golim okom,
 * jer kontroler auth telo čita polje-po-polje pa nepoznato polje ionako ne prosleđuje.
 */
const pipe = new ValidationPipe({ transform: true, whitelist: true });

const meta = (metatype: unknown): ArgumentMetadata => ({
  type: "body",
  metatype: metatype as ArgumentMetadata["metatype"],
});

/**
 * Spojene poruke odbijanja, ili `null` ako je telo prošlo.
 *
 * ⚠️ NE koristi `expect(...).rejects.toThrow(/tekst/)`: `BadRequestException.message` je
 * generičko „Bad Request Exception", a srpske poruke žive u `getResponse().message`
 * (niz, jedan unos po prekršaju) — isto telo koje klijent stvarno dobije preko HTTP-a.
 */
async function odbijanje(dto: unknown, telo: unknown): Promise<string | null> {
  try {
    await pipe.transform(telo, meta(dto));
    return null;
  } catch (e) {
    const r = (e as { getResponse?: () => unknown }).getResponse?.() as
      | { message?: unknown }
      | undefined;
    const m = r?.message;
    return Array.isArray(m) ? m.join(" | ") : String(m ?? e);
  }
}

/** Telo koje je PREŽIVELO pipe (`ValidationPipe.transform` je tipizovan kao `any`). */
async function prosao(dto: unknown, telo: unknown): Promise<unknown> {
  return (await pipe.transform(telo, meta(dto))) as unknown;
}

describe("LoginDto", () => {
  it("propušta ispravno telo i trimuje e-poštu", async () => {
    const out = await prosao(LoginDto, {
      email: "  Ko@servoteh.com ",
      password: "tajna",
    });
    expect(out).toEqual({ email: "Ko@servoteh.com", password: "tajna" });
  });

  it("🔴 odbacuje nepoznato polje (whitelist) — ne stiže do servisa", async () => {
    const out = await prosao(LoginDto, {
      email: "ko@servoteh.com",
      password: "tajna",
      role: "admin",
    });
    expect(out).not.toHaveProperty("role");
    expect(out).toEqual({ email: "ko@servoteh.com", password: "tajna" });
  });

  it("odbija objekat umesto e-pošte (ranije je pucao u AuthService kao 500)", async () => {
    expect(
      await odbijanje(LoginDto, { email: { $ne: null }, password: "x" }),
    ).not.toBeNull();
  });

  it("odbija e-poštu pogrešnog oblika JEDNOM srpskom porukom o OBLIKU", async () => {
    const poruka = await odbijanje(LoginDto, {
      email: "nije-eposta",
      password: "x",
    });
    // Tačno jedna poruka: unos sa tastature je uvek string, pa `@IsString`/`@MaxLength`
    // ne pucaju uz nju. Gomila poruka bi na ekranu za prijavu bila nečitljiva.
    expect(poruka).toBe("E-pošta nije ispravnog oblika.");
  });

  it("🔴 ne otkriva da li nalog postoji — poruka govori samo o obliku unosa", async () => {
    const poruka = await odbijanje(LoginDto, {
      email: "nepostojeci@servoteh.com",
      password: "x",
    });
    // Ispravan oblik → validacija ga PUŠTA dalje; o postojanju naloga presuđuje
    // AuthService neutralnom 401. Validacija tu ne sme ništa da kaže.
    expect(poruka).toBeNull();
  });

  it("poruka o dužini kaže i da mora biti TEKST (inače bi broj dao: predugačka)", async () => {
    const poruka = await odbijanje(LoginDto, {
      email: "ko@servoteh.com",
      password: 12345,
    });
    expect(poruka).toMatch(/mora biti tekst/i);
    expect(poruka).not.toMatch(/predugačka/i);
  });

  it("🔴 NE postavlja minimum na lozinku za prijavu (dužina postojećih je nemerljiva)", async () => {
    const out = await prosao(LoginDto, {
      email: "ko@servoteh.com",
      password: "abc",
    });
    expect(out).toEqual({ email: "ko@servoteh.com", password: "abc" });
  });

  it("odbija ne-string lozinku", async () => {
    expect(
      await odbijanje(LoginDto, { email: "ko@servoteh.com", password: 12345 }),
    ).not.toBeNull();
  });
});

describe("SsoDto", () => {
  it("propušta token i odbacuje nepoznato polje", async () => {
    const out = await prosao(SsoDto, {
      token: "eyJhbGciOiJIUzI1NiJ9.e30.sig",
      role: "admin",
    });
    expect(out).toEqual({ token: "eyJhbGciOiJIUzI1NiJ9.e30.sig" });
  });

  it("odbija ne-string i prazan token", async () => {
    expect(await odbijanje(SsoDto, { token: 42 })).not.toBeNull();
    expect(await odbijanje(SsoDto, { token: "" })).not.toBeNull();
  });
});

describe("ChangePasswordDto", () => {
  it("propušta kratku TRENUTNU lozinku (nalozi stariji od pravila od 8 znakova)", async () => {
    const out = await prosao(ChangePasswordDto, {
      currentPassword: "abc",
      newPassword: "novaLozinka1",
    });
    expect(out).toEqual({
      currentPassword: "abc",
      newPassword: "novaLozinka1",
    });
  });

  it("odbija kratku NOVU lozinku jednom srpskom porukom", async () => {
    const poruka = await odbijanje(ChangePasswordDto, {
      currentPassword: "staraLozinka",
      newPassword: "kratka",
    });
    expect(poruka).toBe("Nova lozinka mora imati najmanje 8 karaktera.");
  });

  it("odbacuje nepoznato polje", async () => {
    const out = await prosao(ChangePasswordDto, {
      currentPassword: "staraLozinka",
      newPassword: "novaLozinka1",
      userId: 1,
    });
    expect(out).not.toHaveProperty("userId");
  });
});
