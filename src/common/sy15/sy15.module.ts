import { Global, Module } from "@nestjs/common";
import { Sy15Service } from "./sy15.service";

/** Globalni provajder sy15 (1.0) datasource-a — koriste ga 3.0 pilot moduli (Reversi). */
@Global()
@Module({
  providers: [Sy15Service],
  exports: [Sy15Service],
})
export class Sy15Module {}
