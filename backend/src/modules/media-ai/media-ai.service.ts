import { BadRequestException, Injectable } from "@nestjs/common";
import { AiProviderService } from "../../common/ai/ai-provider.service";
import type { RefineDto, SttMetaDto } from "./dto/media-ai.dto";

/**
 * Zajednički media/AI servis (presuda B4/H3): STT (Whisper) + „✨ doterivanje"
 * (ai-refine). Presečna infra — zapisnik i chat gube diktiranje bez ovoga; C/D/G
 * je kasnije reuse-uju. Guard = bilo koji ulogovan (`ai.chat`). Sav rad ide kroz
 * AiProviderService (jedini izlaz ka OpenAI; boot-safe 503 bez ključa).
 */

const REFINE_BASE_RULES =
  "Vrati ISKLJUCIVO doteran tekst — bez uvoda, naslova, navodnika ni komentara. " +
  "NE izmisljaj podatke: koristi samo ono sto je u ulazu; ako je ulaz kratak, i izlaz je kratak. " +
  "Zadrzi brojeve, oznake, predmete i radne naloge TACNO (npr. 9400/2, TP 1/430, presa 350t). " +
  "Pisi srpskim jezikom, LATINICOM, ekavica. Bez emojija. Zadrzi imena ljudi.";

const REFINE_PROFILES: Record<string, string> = {
  montaza_opis:
    "Ti sredjujes OPIS IZVEDENIH RADOVA u servisnom izvestaju montera/servisera. " +
    "Pretvori sirov, telegrafski diktat u jasan, profesionalan opis u proslom vremenu, " +
    "strucnim montaznim recnikom. Konkretno i sazeto, bez vode.",
  montaza_problem:
    "Sredjujes deo izvestaja o PROBLEMIMA / ODSTUPANJIMA. Jasno navedi problem i, ako se " +
    "iz teksta vidi, uzrok i posledicu. Bez izmisljanja i bez preterivanja.",
  montaza_napomena:
    "Sredjujes OTVORENE STAVKE / NAPOMENE u izvestaju. Kratke, jasne stavke — sta preostaje " +
    "da se uradi ili na sta obratiti paznju.",
  zapisnik:
    "Sredjujes ZAPISNIK SA SASTANKA. Sazmi u jasne, formalne recenice ili tacke. Obavezno " +
    "zadrzi SVE odluke, zadatke, rokove i imena. Ne menjaj znacenje niti dodaj zakljucke.",
  zadatak:
    "Sredjujes opis JEDNOG ZADATKA / AKCIJE. Vrati JEDNU jasnu recenicu, glagol na pocetku " +
    "(Naruciti…, Proveriti…), konkretno i merljivo koliko je moguce iz ulaza.",
  napomena:
    "Doteraj gramatiku, interpunkciju i jasnocu kratke napomene, menjajuci sto je manje moguce.",
};

const REFINE_DEFAULT =
  "Doteraj tekst da bude jasan, gramaticki ispravan i profesionalan, menjajuci sadrzaj sto je manje moguce.";

@Injectable()
export class MediaAiService {
  constructor(private readonly ai: AiProviderService) {}

  /** Govor → tekst (Whisper) — multipart `audio`. Paritet stt-transcribe. */
  async transcribe(dto: SttMetaDto, file?: Express.Multer.File) {
    if (!file?.buffer?.length) {
      throw new BadRequestException("Nema audio snimka (multipart `audio`).");
    }
    if (file.buffer.length < 200) {
      throw new BadRequestException("Snimak je prazan/prekratak.");
    }
    if (file.buffer.length > 15 * 1024 * 1024) {
      throw new BadRequestException(
        "Snimak je predugacak — snimi krace deonice.",
      );
    }
    const out = await this.ai.transcribe({
      bytes: new Uint8Array(file.buffer),
      mime: file.mimetype || "audio/webm",
      lang: dto.lang,
      context: dto.context,
    });
    return { data: { ok: true, ...out } };
  }

  /** „✨ Dotera tekst" po profilu dokumenta. Paritet ai-refine. */
  async refine(dto: RefineDto) {
    const tekst = String(dto.tekst ?? "").trim();
    if (!tekst) throw new BadRequestException("Nema teksta za doterivanje.");
    const system =
      (REFINE_PROFILES[dto.profil ?? ""] || REFINE_DEFAULT) +
      "\n\n" +
      REFINE_BASE_RULES;
    const out = await this.ai.refine(tekst, system);
    return { data: { ok: true, ...out } };
  }
}
