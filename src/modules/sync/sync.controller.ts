import {
  BadRequestException,
  Body,
  Controller,
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
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser } from '../auth/jwt.strategy';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermission } from '../../common/authz/require-permission.decorator';
import { PERMISSIONS } from '../../common/authz/permissions';

interface RunSyncBody {
  entities?: string[];
  strategy?: SyncStrategy;
  /** Allow destructive re-import of protected ServoSync-owned tables. */
  force?: boolean;
}

/**
 * On-demand ("na dugme") sync of master data from QBigTehn (MSSQL) into Postgres.
 *
 * `POST /run` = `sync.run` (admin-only per role→permission map); reads = `sync.read`.
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
    return this.syncService.run({
      entities: body?.entities,
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
