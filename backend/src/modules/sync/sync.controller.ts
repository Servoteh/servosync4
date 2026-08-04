import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SyncService } from './sync.service';
import { SyncStrategy } from './sync.types';
import { NIGHTLY_SYNC_EXCLUDED } from './table-ownership';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser } from '../auth/jwt.strategy';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermission } from '../../common/authz/require-permission.decorator';
import { PERMISSIONS } from '../../common/authz/permissions';
import { ROLES } from '../../common/authz/roles';

interface RunSyncBody {
  entities?: string[];
  strategy?: SyncStrategy;
  /** Allow destructive re-import of protected ServoSync-owned tables. */
  force?: boolean;
}

/**
 * Tehnička zaštita uz širenje `sync.run` (dopuna 061/26, odluka 04.08.2026):
 * isključeni entitet eksplicitno sme da traži samo admin. Danas je jedini
 * isključeni tok `items` — poruka ga zato imenuje (uz spisak za slučaj da se
 * skup ikad proširi, da poruka ne slaže).
 */
export function excludedEntitiesAdminOnlyMessage(blocked: string[]): string {
  const extra = blocked.every((e) => e === 'items')
    ? ''
    : ` (traženo: ${blocked.join(', ')})`;
  return (
    'Artikli su privremeno isključeni iz sinhronizacije dok traje čišćenje ' +
    `kataloga — može ih pokrenuti samo administrator.${extra}`
  );
}

export const FORCE_ADMIN_ONLY_MESSAGE =
  'Prinudni (force) sync preskače zaštitu ServoSync tabela — može ga pokrenuti ' +
  'samo administrator.';

/**
 * On-demand ("na dugme") sync of master data from QBigTehn (MSSQL) into Postgres.
 *
 * `POST /run` = `sync.run` — do 04.08.2026 admin-only; zahtevom 061/26 (Igor
 * Voštić) i odlukom Nenada prošireno na tehnologe + planere + admin (role-mapa:
 * tehnolog + menadzment + admin). Uz širenje ide tehnička zaštita: default run
 * isključuje `NIGHTLY_SYNC_EXCLUDED` (items), eksplicitni items i `force` su
 * samo admin — vidi komentar u `run()`. Reads = `sync.read`
 * (sef/tehnolog/menadzment/admin).
 * Guard je shadow-mode (V1): loguje would-be 403, ne blokira dok `AUTHZ_ENFORCE=true`.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('run')
  @RequirePermission(PERMISSIONS.SYNC_RUN)
  async run(@Body() body: RunSyncBody, @Req() req: { user: AuthUser }) {
    if (body?.strategy && !['incremental', 'full_refresh'].includes(body.strategy)) {
      throw new BadRequestException(
        'strategy must be "incremental" or "full_refresh"',
      );
    }
    if (body?.entities && !Array.isArray(body.entities)) {
      throw new BadRequestException('entities must be an array of strings');
    }

    // Dopuna 061/26 (odluka 04.08.2026, tehnička zaštita uz širenje `sync.run`):
    //  • DEFAULT (bez `entities`) isključuje `NIGHTLY_SYNC_EXCLUDED` — isti skup
    //    kao noćni posao, za SVE role uključujući admina (dugme „Pokreni sync"
    //    šalje prazan body, pa više nikog ne vodi u nenadgledan items prolaz).
    //  • EKSPLICITAN zahtev za isključeni entitet sme SAMO admin (nadgledano
    //    pokretanje, pre-check iz .env.example) — ostali dobijaju 403 sa
    //    porukom šta i zašto.
    //  • `force` (probija zaštitu ServoSync-owned tabela) — takođe samo admin;
    //    do 061/26 je bio admin-only implicitno, jer je ceo `sync.run` bio.
    const isAdmin = req.user.role?.trim().toLowerCase() === ROLES.ADMIN;
    if (body?.force === true && !isAdmin) {
      throw new ForbiddenException(FORCE_ADMIN_ONLY_MESSAGE);
    }
    const requested = body?.entities?.length
      ? body.entities
      : this.syncService.availableEntities.filter(
          (e) => !NIGHTLY_SYNC_EXCLUDED.has(e),
        );
    const blocked = requested.filter((e) => NIGHTLY_SYNC_EXCLUDED.has(e));
    if (blocked.length && !isAdmin) {
      throw new ForbiddenException(excludedEntitiesAdminOnlyMessage(blocked));
    }

    return this.syncService.run({
      entities: requested,
      strategy: body?.strategy,
      force: body?.force === true,
      trigger: 'manual',
      triggeredByUserId: req.user.userId,
    });
  }

  @Get('state')
  @RequirePermission(PERMISSIONS.SYNC_READ)
  state() {
    return this.syncService.getState();
  }

  @Get('state/:entity')
  @RequirePermission(PERMISSIONS.SYNC_READ)
  entityState(@Param('entity') entity: string) {
    return this.syncService.getEntityState(entity);
  }

  @Get('log')
  @RequirePermission(PERMISSIONS.SYNC_READ)
  logs(@Query('limit') limit?: string) {
    return this.syncService.getLogs(limit ? Number(limit) : undefined);
  }

  @Get('log/:id')
  @RequirePermission(PERMISSIONS.SYNC_READ)
  log(@Param('id', ParseIntPipe) id: number) {
    return this.syncService.getLog(id);
  }

  @Get('health')
  @RequirePermission(PERMISSIONS.SYNC_READ)
  health() {
    return this.syncService.health();
  }
}
