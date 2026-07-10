import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  NotEquals,
} from "class-validator";

/**
 * DTO-ovi transakcionih Reversi akcija (MODULE_SPEC_reversi.md §5).
 * `clientEventId` je OBAVEZAN na svim mutacijama — idempotency ključ
 * (Sy15Service.runIdempotent); generiše ga klijent po korisničkoj akciji.
 * `payload` za issue/return ide pass-through u postojeće DB funkcije
 * (iste jsonb strukture koje 1.0 front već gradi) — DB fn validira i gate-uje.
 */
export class TxBaseDto {
  @IsUUID()
  clientEventId!: string;
}

export class JsonPayloadTxDto extends TxBaseDto {
  @IsObject()
  payload!: Record<string, unknown>;
}

export class StockDeltaDto extends TxBaseDto {
  @IsInt()
  @NotEquals(0)
  delta!: number;

  /** RECEIPT / RETURN / ADJUST / WRITE_OFF / ISSUE — ledger reason (1.0 paritet). */
  @IsString()
  reason!: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class SeedStockDto extends TxBaseDto {
  /** Ako se izostavi, backend koristi magacin ALAT-MAG-01 (paritet 1.0 seed). */
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsNumber()
  @IsPositive()
  qty!: number;
}

export class WriteOffDto extends TxBaseDto {
  @IsOptional()
  @IsString()
  razlog?: string;

  @IsOptional()
  @IsDateString()
  datum?: string;

  @IsOptional()
  @IsIn(["scrapped", "lost"])
  status?: string;
}
