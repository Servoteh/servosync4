import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { MssqlClient } from './mssql.client';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { CustomerSyncer } from './syncers/customer.syncer';

@Module({
  imports: [PrismaModule],
  controllers: [SyncController],
  providers: [MssqlClient, SyncService, CustomerSyncer],
  exports: [SyncService],
})
export class SyncModule {}
