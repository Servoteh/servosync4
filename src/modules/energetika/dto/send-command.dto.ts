import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

/**
 * DTO slanja SCADA komande (MODULE_SPEC_scada_30.md §3, R2). Ogledalo 1.0
 * `insertCommand({ siteKey, target, op='set', value })` + opcioni `clientEventId`.
 *
 * ⚠️ KOMANDNA SEMANTIKA JE ZAMRZNUTA (doktrina §C, spec §7): validacija je NAMERNO
 * tanka — DTO NE gate-uje allowlist targeta. **Bridge je jedini autoritet allowlist-a**
 * (spec §2 skriveno pravilo t.6); van-allowlist target (npr. kot2 `Web_Estop`) MORA da
 * prođe DTO i uđe u outbox kao `pending`, pa ga bridge odbije BEZ dodira PLC-a. Zato
 * `target` NEMA `@IsIn(...)` — svaki neprazan string je dozvoljen na BE sloju.
 */
export class SendCommandDto {
  /** Sistem (FK scada_sites.key): 'kot1'|'kot2'|'kot3'|'solar-kaco'|'solar-sigen'. */
  @IsString()
  @IsNotEmpty()
  siteKey!: string;

  /** Tag/komanda za bridge allowlist (npr. 'SP_CNC','Zeljena_temperatura','room:<k>'). */
  @IsString()
  @IsNotEmpty()
  target!: string;

  /**
   * 'set'|'toggle'|'pulse'|'mode' — metapodatak; bridge allowlist ga NE čita (paritet
   * 1.0). Bez `@IsIn` da se ne uvede restrikcija koje 1.0 DB nema (kolona bez CHECK).
   * Default 'set' primenjuje servis kad se izostavi.
   */
  @IsOptional()
  @IsString()
  op?: string;

  /**
   * jsonb payload koji allowlist čita: `{"v":22}` / `{"v":1}` /
   * `{"systemId":"...","mode":5}` / roomtemp `{"v":22,"mode":"heat"}`. Kolona je
   * nullable — opcion (paritet: 1.0 shim uvek šalje objekat, ali reset targeti ga
   * ne koriste). Servis izostavljen `value` upisuje kao SQL NULL.
   */
  @IsOptional()
  @IsObject()
  value?: Record<string, unknown>;

  /**
   * Idempotency ključ (NATIVNI `idempotency_key`, partial unique u bazi) — 1.0 format
   * `ui-<ts>-<rand>`. **NIJE uuid** (za razliku od rev_api_idempotency `clientEventId`)
   * pa je `@IsString`, ne `@IsUUID`. Izostavljen → servis generiše `ui-<ts>-<rand>`.
   * Ponovljen ključ → 23505 → 409 (dupli klik/retry ne pravi dupli upis na PLC).
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  clientEventId?: string;
}
