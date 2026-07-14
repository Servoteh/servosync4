import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { DocumentMetaDto } from "./kadrovska-mutation.dto";

/**
 * CRITICAL #1 (T2/T3 review 14.07): employee-document upload je multipart/form-data,
 * pa `queueEmail` uvek stiže kao STRING. @Transform pre @IsBoolean mora da koeruje
 * 'true'/'false' u boolean — inače ValidationPipe 400-uje ceo auto-save+mejl tok.
 * Ovaj test vozi TAČNO isto što global ValidationPipe radi (plainToInstance transform
 * → validateSync) sa istom konfiguracijom (whitelist ne utiče na transform).
 */
describe("DocumentMetaDto — multipart boolean koercija (queueEmail)", () => {
  const build = (raw: Record<string, unknown>) => {
    const dto = plainToInstance(DocumentMetaDto, raw);
    const errors = validateSync(dto as object, { whitelist: true });
    return { dto, errors };
  };

  it("string 'true' → boolean true, bez validacione greške", () => {
    const { dto, errors } = build({ docType: "aneks", queueEmail: "true" });
    expect(errors).toHaveLength(0);
    expect(dto.queueEmail).toBe(true);
  });

  it("string 'false' → boolean false (ne truthy string)", () => {
    const { dto, errors } = build({ docType: "aneks", queueEmail: "false" });
    expect(errors).toHaveLength(0);
    expect(dto.queueEmail).toBe(false);
  });

  it("native boolean true (JSON put) i dalje prolazi", () => {
    const { dto, errors } = build({ docType: "ugovor", queueEmail: true });
    expect(errors).toHaveLength(0);
    expect(dto.queueEmail).toBe(true);
  });

  it("izostavljen queueEmail je validan (undefined)", () => {
    const { dto, errors } = build({ docType: "karnet" });
    expect(errors).toHaveLength(0);
    expect(dto.queueEmail).toBeUndefined();
  });
});
