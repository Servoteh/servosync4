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

interface RunSyncBody {
  entities?: string[];
  strategy?: SyncStrategy;
  /** Allow destructive re-import of protected ServoSync-owned tables. */
  force?: boolean;
}

/**
 * On-demand ("na dugme") sync of master data from QBigTehn (MSSQL) into Postgres.
 *
 * TODO(auth): once the auth module exists, guard POST /sync/run with an
 * ADMIN role guard. Left open for now since auth is not yet implemented.
 */
@UseGuards(JwtAuthGuard)
@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('run')
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
  state() {
    return this.syncService.getState();
  }

  @Get('state/:entity')
  entityState(@Param('entity') entity: string) {
    return this.syncService.getEntityState(entity);
  }

  @Get('log')
  logs(@Query('limit') limit?: string) {
    return this.syncService.getLogs(limit ? Number(limit) : undefined);
  }

  @Get('log/:id')
  log(@Param('id', ParseIntPipe) id: number) {
    return this.syncService.getLog(id);
  }

  @Get('health')
  health() {
    return this.syncService.health();
  }
}
