/**
 * `POST /tech-processes/labels/print` — RAW TSPL2 štampa na mrežni termalni štampač.
 * DTO + validacija su izdvojeni u deljeni `common/printing` modul (reuse: isti
 * transport koriste i Lokacije, MODULE_SPEC_lokacije_30.md §3 t.12). Ovaj fajl
 * re-eksportuje simbole radi paritet putanja postojećih importa.
 */
export {
  type PrintLabelDto,
  validatePrintLabel,
} from "../../../common/printing/print-label.dto";
