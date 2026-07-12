import { Global, Module } from "@nestjs/common";
import { Sy15Service } from "./sy15.service";
import { Sy15StorageService } from "./sy15-storage.service";

/** Globalni provajder sy15 (1.0) datasource-a — koriste ga 3.0 pilot moduli (Reversi, Talas B). */
@Global()
@Module({
  providers: [Sy15Service, Sy15StorageService],
  exports: [Sy15Service, Sy15StorageService],
})
export class Sy15Module {}
