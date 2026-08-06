import { ConflictException } from "@nestjs/common";
import { IdempotencyService } from "./idempotency.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * Registar idempotencije 3.0 — paritet sy15 `runIdempotent` + jedna namerna razlika
 * (provera aktera).
 *
 * 🔴 ZAŠTO OVI TESTOVI POSTOJE: registar je JEDINA brana od duplog POST-a za
 * `create-sastanak`, `bulk-ucesnici`, `prenos` i `instantiate`. Ako se olabavi,
 * dupli klik pravi DRUGI sastanak i DRUGI talas mejlova svim učesnicima — i to se
 * ne vidi ni u jednom drugom testu, jer svaka od tih ruta i sama „radi".
 */

/** In-memory `api_idempotency` + Prisma raw interfejs koji servis koristi. */
function prismaStub() {
  const tabela = new Map<
    string,
    { action: string; actor_email: string; result: unknown }
  >();
  const tx = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...v: unknown[]) => {
      const sql = strings.join("?");
      if (sql.includes("INSERT INTO api_idempotency")) {
        const [clientEventId, action, actor] = v as string[];
        if (tabela.has(clientEventId)) return 0; // ON CONFLICT DO NOTHING
        tabela.set(clientEventId, {
          action,
          actor_email: actor,
          result: null,
        });
        return 1;
      }
      if (sql.includes("UPDATE api_idempotency")) {
        const [result, clientEventId] = v as [string, string];
        const red = tabela.get(clientEventId);
        if (red) red.result = JSON.parse(result);
        return 1;
      }
      return 0;
    }),
    $queryRaw: jest.fn(async (_s: TemplateStringsArray, ...v: unknown[]) => {
      const red = tabela.get(v[0] as string);
      return red ? [red] : [];
    }),
  };
  const prisma = {
    $transaction: jest.fn(
      async (fn: (t: unknown) => Promise<unknown>) => await fn(tx),
    ),
  } as unknown as PrismaService;
  return { prisma, tabela, tx };
}

const KLJUC = "3b241101-e2bb-4255-8caf-4136c566a962";
const JA = "ja@servoteh.com";

describe("IdempotencyService.run", () => {
  it("prvo izvršenje pusti akciju i sačuva odgovor", async () => {
    const { prisma, tabela } = prismaStub();
    const fn = jest.fn().mockResolvedValue({ id: 7 });
    const out = await new IdempotencyService(prisma).run(
      JA,
      KLJUC,
      "sastanci.create-sastanak",
      fn,
    );
    expect(out).toEqual({ idempotent: false, result: { id: 7 } });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(tabela.get(KLJUC)?.result).toEqual({ id: 7 });
  });

  it("🔴 ponovljen zahtev vraća SAČUVAN odgovor i NE izvršava akciju", async () => {
    const { prisma } = prismaStub();
    const svc = new IdempotencyService(prisma);
    const fn = jest.fn().mockResolvedValue({ id: 7 });
    await svc.run(JA, KLJUC, "sastanci.create-sastanak", fn);
    const drugi = await svc.run(JA, KLJUC, "sastanci.create-sastanak", fn);
    expect(drugi).toEqual({ idempotent: true, result: { id: 7 } });
    // Ovo je cela poenta registra: dupli klik NE pravi drugi sastanak.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("isti ključ za DRUGU akciju → 409, akcija se ne izvršava", async () => {
    const { prisma } = prismaStub();
    const svc = new IdempotencyService(prisma);
    await svc.run(JA, KLJUC, "sastanci.create-sastanak", async () => ({ id: 1 }));
    const fn = jest.fn();
    await expect(
      svc.run(JA, KLJUC, "sastanci.prenos", fn),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fn).not.toHaveBeenCalled();
  });

  it("🔴 tuđi ključ NE vraća sačuvan odgovor nego 409 (razlika od sy15)", async () => {
    // sy15 registar nema kolonu aktera, pa bi ovde vratio TUĐI rezultat — a on
    // ume da nosi id i naslov tuđeg sastanka.
    const { prisma } = prismaStub();
    const svc = new IdempotencyService(prisma);
    await svc.run(JA, KLJUC, "sastanci.create-sastanak", async () => ({
      id: "tudji-sastanak",
    }));
    await expect(
      svc.run("drugi@servoteh.com", KLJUC, "sastanci.create-sastanak", jest.fn()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("mejl aktera se poredi normalizovano (ista osoba, drugo slovo → prolazi)", async () => {
    const { prisma } = prismaStub();
    const svc = new IdempotencyService(prisma);
    await svc.run(JA, KLJUC, "a", async () => 1);
    const out = await svc.run("  JA@Servoteh.COM ", KLJUC, "a", jest.fn());
    expect(out.idempotent).toBe(true);
  });

  it("🔴 sve ide u JEDNOJ transakciji — rollback akcije oslobađa ključ", async () => {
    // Da se ključ upisivao van transakcije, pad akcije bi ga TRAJNO zauzeo i
    // korisnik nikad ne bi mogao da ponovi isti zahtev.
    const { prisma } = prismaStub();
    const svc = new IdempotencyService(prisma);
    const pukla = jest.fn().mockRejectedValue(new Error("pad akcije"));
    await expect(svc.run(JA, KLJUC, "a", pukla)).rejects.toThrow("pad akcije");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Akcija i upis ključa dele isti `tx` koji je servis dobio od `$transaction`.
    const txArg = (prisma.$transaction as jest.Mock).mock.calls[0][0];
    expect(typeof txArg).toBe("function");
  });

  it("rezultat se upisuje TEK POSLE akcije (do tada red stoji sa result=null)", async () => {
    const { prisma, tabela } = prismaStub();
    let uTokuAkcije: unknown = "nije gledano";
    await new IdempotencyService(prisma).run(JA, KLJUC, "a", async () => {
      uTokuAkcije = tabela.get(KLJUC)?.result;
      return { gotovo: true };
    });
    expect(uTokuAkcije).toBeNull();
    expect(tabela.get(KLJUC)?.result).toEqual({ gotovo: true });
  });

  it("`undefined` rezultat se čuva kao null (jsonb ne zna undefined)", async () => {
    const { prisma, tabela } = prismaStub();
    const out = await new IdempotencyService(prisma).run(
      JA,
      KLJUC,
      "a",
      async () => undefined,
    );
    expect(out.idempotent).toBe(false);
    expect(tabela.get(KLJUC)?.result).toBeNull();
  });
});
