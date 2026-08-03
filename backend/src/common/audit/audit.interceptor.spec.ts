import { CallHandler, ExecutionContext } from "@nestjs/common";
import { firstValueFrom, of } from "rxjs";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditInterceptor } from "./audit.interceptor";

/** Minimalan `ExecutionContext` — interceptor iz njega čita samo HTTP zahtev. */
function ctx(method: string, url: string, body: unknown): ExecutionContext {
  const req = {
    method,
    originalUrl: url,
    url,
    ip: "10.0.0.1",
    headers: { "user-agent": "jest" },
    user: { userId: 42, email: "agent@servoteh.com" },
    body,
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const next: CallHandler = { handle: () => of({ ok: true }) };

describe("AuditInterceptor — šta sme, a šta NE sme u audit_log", () => {
  let prisma: { auditLog: { create: jest.Mock } };
  let interceptor: AuditInterceptor;

  beforeEach(() => {
    prisma = { auditLog: { create: jest.fn().mockResolvedValue({ id: 1 }) } };
    interceptor = new AuditInterceptor(prisma as unknown as PrismaService);
  });

  /** `afterData` iz jedinog upisa koji je interceptor napravio. */
  function afterData(): Record<string, unknown> {
    const calls = prisma.auditLog.create.mock.calls as unknown as [
      { data: { afterData?: Record<string, unknown> } },
    ][];
    return calls[0][0].data.afterData ?? {};
  }

  it("🔴 DIKTAT: tekst NIKAD ne ulazi u audit — ostaje samo dokaz i dužina", async () => {
    // Spec modula tvrdi „tekst diktata se nikad ne loguje", ali je globalni audit do
    // sada uz svaki POST /v1/dictation-inbox upisivao CEO tekst u `after_data`
    // (potvrđeno na produkciji). Sanduče je komandni kanal i tekst ume da nosi
    // poslovne podatke — u audit sme samo trag da je nešto poslato.
    const tajna = "cena za Milanović doo je 1.240.000 dinara";
    await firstValueFrom(
      interceptor.intercept(
        ctx("POST", "/api/v1/dictation-inbox", { text: tajna }),
        next,
      ),
    );

    expect(afterData().text).toBe("[redacted]");
    expect(afterData().text_len).toBe(tajna.length);
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain(
      "Milanović",
    );
  });

  it("🔴 REFINE: sirov transkript kroz /ai/refine curio bi kroz susednu rutu", async () => {
    // Telefon isti tekst prvo provuče kroz doterivanje, pa ga tek onda odloži u
    // sanduče. Da je redigovan samo `dictation-inbox`, tekst bi i dalje završio u
    // auditu — samo jednu rutu ranije.
    const tajna = "otkazujemo ugovor sa dobavljačem Petrović";
    await firstValueFrom(
      interceptor.intercept(
        ctx("POST", "/api/v1/ai/refine", {
          tekst: tajna,
          profil: "napomena",
        }),
        next,
      ),
    );

    expect(afterData().tekst).toBe("[redacted]");
    expect(afterData().tekst_len).toBe(tajna.length);
    expect(afterData().profil).toBe("napomena"); // metapodatak ostaje — koristan je
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain(
      "Petrović",
    );
  });

  it("OSTALE RUTE se NE diraju — `text` drugde i dalje ide u audit u celosti", async () => {
    // Redakcija je namerno po resursu: audit ostalih modula je koristan baš zato
    // što se u njemu vidi šta je tačno promenjeno.
    await firstValueFrom(
      interceptor.intercept(
        ctx("PATCH", "/api/v1/work-orders/123", { text: "napomena o nalogu" }),
        next,
      ),
    );

    expect(afterData().text).toBe("napomena o nalogu");
    expect(afterData().text_len).toBeUndefined();
  });

  it("tajne (password/token/secret) ostaju redigovane na SVIM rutama", async () => {
    await firstValueFrom(
      interceptor.intercept(
        ctx("POST", "/api/v1/podesavanja/users", {
          email: "novi@servoteh.com",
          password: "Tajna123!",
          apiToken: "abc",
        }),
        next,
      ),
    );

    expect(afterData().password).toBe("[redacted]");
    expect(afterData().apiToken).toBe("[redacted]");
    expect(afterData().email).toBe("novi@servoteh.com");
  });

  it("GET se ne audituje uopšte (samo mutirajuće operacije)", async () => {
    await firstValueFrom(
      interceptor.intercept(
        ctx("GET", "/api/v1/dictation-inbox/last-claimed", {}),
        next,
      ),
    );
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("pad audit upisa NE obara zahtev (fire-and-forget)", async () => {
    prisma.auditLog.create.mockRejectedValue(new Error("audit down"));
    await expect(
      firstValueFrom(
        interceptor.intercept(
          ctx("POST", "/api/v1/dictation-inbox", { text: "x" }),
          next,
        ),
      ),
    ).resolves.toEqual({ ok: true });
  });
});
