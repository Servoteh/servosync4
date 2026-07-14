import {
  BadGatewayException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createConnection } from "node:net";
import { type PrintLabelDto, validatePrintLabel } from "./print-label.dto";

/**
 * Deljeni RAW TSPL2 print transport (TSC ML340P, TCP 9100). Izvorno telo je bilo u
 * `TechProcessesService.printRawLabel` (P4 label-proxy paritet); izdvojeno je u
 * zajednički servis da ga Lokacije (Talas A — štampa nalepnica polica/TP,
 * MODULE_SPEC_lokacije_30.md §3 t.12) i Tehnologija dele bez dupliranja
 * transporta/odbrana. Server je na istom LAN-u kao štampač; browser NE dira
 * localhost (Chrome „Local Network Access" blokira HTTPS→localhost).
 */
@Injectable()
export class LabelPrintService {
  private readonly logger = new Logger(LabelPrintService.name);

  /**
   * RAW TSPL2 → mrežni termalni štampač. Iste odbrane kao 1.0 label-proxy: TSPL2
   * komande koje menjaju KONFIGURACIJU štampača se odbijaju (422) — pogrešan
   * SIZE/GAP ume da „zaglavi" štampač. Printer adresa: env
   * `LABEL_PRINTER_HOST`/`LABEL_PRINTER_PORT` (default 192.168.70.20:9100).
   */
  async printRawTspl(
    dto: PrintLabelDto,
  ): Promise<{ ok: true; bytes: number; printer: string }> {
    validatePrintLabel(dto);
    const tspl2 = dto.tspl2;
    const FORBIDDEN = [
      "SIZE ",
      "GAP ",
      "DENSITY ",
      "SPEED ",
      "CODEPAGE ",
      "SET TEAR",
      "REFERENCE ",
      "OFFSET ",
    ];
    const upper = tspl2.toUpperCase();
    const hit = FORBIDDEN.find((c) => upper.includes(c));
    if (hit)
      throw new UnprocessableEntityException(
        `TSPL2 sadrži zabranjenu komandu '${hit.trim()}' (menja konfiguraciju štampača) — štampa odbijena.`,
      );

    const host = process.env.LABEL_PRINTER_HOST || "192.168.70.20";
    const port =
      Number.parseInt(process.env.LABEL_PRINTER_PORT ?? "", 10) || 9100;

    const bytes = await new Promise<number>((resolve, reject) => {
      const sock = createConnection({ host, port });
      const fail = (msg: string) => {
        sock.destroy();
        reject(new BadGatewayException(`Štampač ${host}:${port} — ${msg}`));
      };
      sock.setTimeout(10_000, () => fail("timeout (10s)"));
      sock.once("error", (e) => fail(e.message));
      sock.once("connect", () => {
        sock.write(tspl2, "binary", (err) => {
          if (err) return fail(err.message);
          const n = Buffer.byteLength(tspl2, "binary");
          sock.end(() => resolve(n));
        });
      });
    });

    this.logger.log(
      `label print: ${bytes} B → ${host}:${port} (copies=${dto.copies ?? "?"})`,
    );
    return { ok: true, bytes, printer: `${host}:${port}` };
  }
}
