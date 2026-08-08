import { ValidationPipe } from "@nestjs/common";
import {
  CreateMachineDto,
  UpdateIncidentDto,
  UpdateMachineDto,
  UpdateWorkOrderDto,
  PatchAssetCoreDto,
} from "./odrzavanje-mutation.dto";

/**
 * 🔴 ZAŠTO OVAJ SPEC POSTOJI — i zašto ide kroz PRAVI `ValidationPipe`.
 *
 * PR #144 je uveo prevod identiteta (sy15 uuid → 3.0 `users.id`) i imao test
 * „numerička vrednost prolazi kao danas". Taj test je zvao SERVIS DIREKTNO i
 * time zaobišao `ValidationPipe` — pa je davao lažnu sigurnost baš za oblik koji
 * 3.0 jedini i šalje.
 *
 * Izmereno: pod `ODRZAVANJE_IZVOR=3.0` birač vraća BROJ, ne uuid
 * (`odrzavanje-fn.service.ts` → `assignableUsers()` čita `maint_user_profiles.user_id`,
 * koji je u 3.0 `Int`), a frontend ga doslovno stavlja u polje
 * (`wo-detail-dialog.tsx`, `masine-tab.tsx`, `masina-karton.tsx`,
 * `incident-detail-dialog.tsx`). Globalni pipe u `main.ts` je `@IsUUID()` polje
 * odbijao sa **400 pre servisa** — dakle prevod je pokrivao smer koji 3.0 UI
 * nikad ne pošalje, a stvarni smer je i dalje padao.
 *
 * Ista klasa greške kao „`@Body()` DTO kao `import type`": kvar živi u SLOJU
 * VALIDACIJE, pa ga test koji taj sloj preskoči ne može videti.
 */
const pipe = new ValidationPipe({ transform: true, whitelist: true });

const UUID = "434475f1-1111-4222-8333-444444444444";

async function prolazi(
  metatype: new () => object,
  telo: Record<string, unknown>,
): Promise<boolean> {
  try {
    await pipe.transform(telo, { type: "body", metatype });
    return true;
  } catch {
    return false;
  }
}

describe("🔴 šav seobe: polja identiteta primaju OBA oblika kroz pravi ValidationPipe", () => {
  const SLUCAJEVI: [string, new () => object, string][] = [
    ["CreateMachineDto.responsibleUserId", CreateMachineDto, "responsibleUserId"],
    ["UpdateMachineDto.responsibleUserId", UpdateMachineDto, "responsibleUserId"],
    ["UpdateIncidentDto.assignedTo", UpdateIncidentDto, "assignedTo"],
    ["UpdateWorkOrderDto.assignedTo", UpdateWorkOrderDto, "assignedTo"],
    ["PatchAssetCoreDto.responsibleUserId", PatchAssetCoreDto, "responsibleUserId"],
  ];

  it.each(SLUCAJEVI)(
    "%s prima BROJ (oblik koji 3.0 UI stvarno šalje)",
    async (_ime, dto, polje) => {
      const telo: Record<string, unknown> = { [polje]: "2" };
      if (dto === CreateMachineDto) {
        telo.machineCode = "M-1";
        telo.name = "Presa";
        telo.clientEventId = UUID;
      }
      expect(await prolazi(dto, telo)).toBe(true);
    },
  );

  it.each(SLUCAJEVI)(
    "%s i dalje prima uuid (oblik koji šalje sy15)",
    async (_ime, dto, polje) => {
      const telo: Record<string, unknown> = { [polje]: UUID };
      if (dto === CreateMachineDto) {
        telo.machineCode = "M-1";
        telo.name = "Presa";
        telo.clientEventId = UUID;
      }
      expect(await prolazi(dto, telo)).toBe(true);
    },
  );

  it.each(SLUCAJEVI)(
    "%s ODBIJA smeće (brana nije samo skinuta)",
    async (_ime, dto, polje) => {
      const telo: Record<string, unknown> = { [polje]: "nije-ni-uuid-ni-broj" };
      if (dto === CreateMachineDto) {
        telo.machineCode = "M-1";
        telo.name = "Presa";
        telo.clientEventId = UUID;
      }
      expect(await prolazi(dto, telo)).toBe(false);
    },
  );

  it("broj van opsega int4 pada VEĆ na DTO-u (ne stiže do Prisme kao 500)", async () => {
    // `Number.isInteger(1e20)` je `true` — bez gornje granice bi prošlo do baze.
    expect(
      await prolazi(UpdateWorkOrderDto, { assignedTo: "99999999999999999999" }),
    ).toBe(false);
  });
});
