import { Global, Module } from "@nestjs/common";
import { Sy15Service } from "./sy15.service";
import { Sy15StorageService } from "./sy15-storage.service";
import { Sy15AuthAdminService } from "./sy15-auth-admin.service";

/** Globalni provajder sy15 (1.0) datasource-a — koriste ga 3.0 pilot moduli (Reversi, Talas B/D). */
@Global()
@Module({
  providers: [Sy15Service, Sy15StorageService, Sy15AuthAdminService],
  exports: [Sy15Service, Sy15StorageService, Sy15AuthAdminService],
})
export class Sy15Module {}
