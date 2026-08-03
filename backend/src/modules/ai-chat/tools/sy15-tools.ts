import { Prisma } from "@prisma-sy15/client";
import { AI_MODULE } from "../../../common/ai/ai-limits.service";
import type { AiCallContext } from "../../../common/ai/ai-usage.service";
import type { AiTool, ToolCtx, ToolScope } from "./tool-registry";

/**
 * 20 postojećih alata nad sy15 bazom — VERBATIM tekst iz 1.0 edge-a
 * (`supabase/functions/ai-chat/index.ts`), sada sa handlerom UZ definiciju
 * (Talas AI-1, tačka 2). Ponašanje je NEPROMENJENO:
 *   • isti `ai_chat_*` RPC-ovi, isti pozicioni parametri, isti redosled u nizu,
 *   • izvršenje i dalje kroz `withUserRls` (GUC identitet → RLS presuđuje red),
 *   • `requiredPermission` NAMERNO izostaje: pravo presuđuje BAZA, kao i pre;
 *     uvođenje app-permisije ovde bi promenilo ponašanje 20 živih alata.
 * (Backtick literali — da se sačuvaju svi navodnici/dijakritika 1:1 sa 1.0, §C.)
 */

const LICNI: readonly ToolScope[] = ["personal"];
/** §2 pravilo 11 — deljena projektna nit vidi SAMO ovih 6 (poruke vide svi!). */
const DELJENI: readonly ToolScope[] = ["personal", "project"];

/* ── zajednički pomoćnici (preseljeni iz AiChatService, bez izmene) ────────── */

/** Sigurna koercija args-a modela (string/broj/bool → tekst; objekat → JSON). */
export function str(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
export function strOrNull(v: unknown): string | null {
  const s = str(v);
  return s ? s : null;
}
function uuidOrNull(v: unknown): string | null {
  return strOrNull(v);
}
function intOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Izvrši ai_chat_* RPC kroz withUserRls; vrati `result` polje. */
async function rpc(ctx: ToolCtx, sql: Prisma.Sql): Promise<unknown> {
  return ctx.deps.sy15.withUserRls(ctx.email, async (tx) => {
    const rows = await tx.$queryRaw<{ result: unknown }[]>(sql);
    return rows[0]?.result ?? null;
  });
}

/** Embedding se meri kao zaseban modul (`embed`), ali nosi istog korisnika. */
function embedCtx(ctx: ToolCtx): AiCallContext {
  return { module: AI_MODULE.EMBED, userId: ctx.call?.userId ?? null };
}

/** Backfill embedinga posle dodaj_uputstvo/belesku (BYPASSRLS; best-effort). */
async function backfill(
  ctx: ToolCtx,
  table: "ai_uputstva" | "ai_project_notes",
  out: unknown,
  text: string,
): Promise<void> {
  const o = out as { ok?: boolean; id?: string | number } | null;
  if (!o?.ok || !o.id) return;
  const emb = await ctx.deps.ai.embed(text, embedCtx(ctx));
  if (!emb) return;
  const id = String(o.id);
  const tableSql =
    table === "ai_uputstva"
      ? Prisma.sql`ai_uputstva`
      : Prisma.sql`ai_project_notes`;
  await ctx.deps.sy15
    .withUser(ctx.email, (tx) =>
      tx.$executeRaw(
        Prisma.sql`UPDATE ${tableSql} SET embedding = ${emb}::vector WHERE id = ${id}::uuid`,
      ),
    )
    .catch(() => {
      /* embedding je best-effort — bez njega radi FTS */
    });
}

/* ── go_istorija: sažmi go_ledger izlaz u kompaktan, DD.MM.YYYY oblik za model
   (VERBATIM port edge goDay/goPer/reshapeGoLedger, index.ts:470-500). ── */

type GoPeriod = { od?: string; do?: string; dana?: number };
type GoLedgerBlock = {
  godina?: number;
  pravo?: number;
  iskorisceno?: number;
  planirano?: number;
  preostalo?: number;
  preneto?: number | null;
  zaradjeno_do_danas?: number | null;
  iskorisceno_periodi?: GoPeriod[];
  ranije_evidentirano?: number;
  planirano_periodi?: GoPeriod[];
  istorija_unosi?: {
    days?: number;
    kind?: string;
    dates?: string;
    comment?: string | null;
  }[];
};

function goDay(iso: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}.` : String(iso || "");
}

function goPer(p: GoPeriod): string {
  const od = goDay(p?.od);
  const do_ = goDay(p?.do);
  const lab = !p?.do || p.od === p.do ? od : `${od}–${do_}`;
  return `${lab} (${p?.dana} d)`;
}

export function reshapeGoLedger(blocks: unknown): unknown {
  if (!Array.isArray(blocks)) return blocks;
  return (blocks as GoLedgerBlock[]).map((b) => {
    const o: Record<string, unknown> = {
      godina: b.godina,
      pravo: b.pravo,
      iskorisceno: b.iskorisceno,
      planirano: b.planirano,
      preostalo: b.preostalo,
    };
    if (b.preneto != null) o.preneto = b.preneto;
    if (b.zaradjeno_do_danas != null)
      o.zaradjeno_do_danas = b.zaradjeno_do_danas;
    if (Array.isArray(b.iskorisceno_periodi) && b.iskorisceno_periodi.length)
      o.iskorisceni_dani = b.iskorisceno_periodi.map(goPer);
    if (b.ranije_evidentirano)
      o.ranije_evidentirano_dana = b.ranije_evidentirano;
    if (Array.isArray(b.planirano_periodi) && b.planirano_periodi.length)
      o.planirani_odobreni_dani = b.planirano_periodi.map(goPer);
    const stari = Array.isArray(b.istorija_unosi) ? b.istorija_unosi : [];
    if (stari.length) {
      o.stara_evidencija = stari
        .filter((e) => e?.dates)
        .map((e) => ({
          dana: e.days,
          tip: e.kind,
          datumi: e.dates,
          napomena: e.comment || undefined,
        }));
    }
    return o;
  });
}

/* ── registar: 20 alata, ISTIM redosledom kao 1.0 edge ─────────────────────── */

export const SY15_TOOLS: readonly AiTool[] = [
  {
    name: "trazi_zaposlenog",
    description: `Pronađi zaposlene po delu imena/prezimena, u okviru prava pozivaoca (običan radnik: samo on; rukovodilac: njegovi; admin/HR: svi). Vraća i „ja" (karton pozivaoca). Dijakritici i redosled ime/prezime nisu bitni.`,
    schema: {
      type: "object",
      properties: {
        ime: {
          type: "string",
          description: `deo imena ili prezimena; prazno = samo moj karton`,
        },
      },
      required: [],
    },
    kind: "read",
    scopes: LICNI,
    execute: (a, ctx) =>
      rpc(
        ctx,
        Prisma.sql`SELECT ai_chat_employee_lookup(${strOrNull(a.ime)}) AS result`,
      ),
  },
  {
    name: "go_saldo",
    description: `Saldo godišnjeg odmora za tekuću godinu: godišnje pravo, preneto, iskorišćeno, planirano ubuduće i preostalo (isti broj kao u aplikaciji). Za novozaposlene sa srazmernim sticanjem vraća i zarađeno do danas. Bez employee_id → za pozivaoca.`,
    schema: {
      type: "object",
      properties: {
        employee_id: {
          type: "string",
          description: `UUID iz trazi_zaposlenog; izostavi za sebe`,
        },
      },
      required: [],
    },
    kind: "read",
    scopes: LICNI,
    execute: (a, ctx) =>
      rpc(
        ctx,
        Prisma.sql`SELECT ai_chat_go_saldo(${uuidOrNull(a.employee_id)}::uuid) AS result`,
      ),
  },
  {
    name: "sati_mesec",
    description: `Zbir sati iz evidencije za mesec: redovno, prekovremeno, teren, dve mašine + dani odsustva po tipu. Bez employee_id → pozivalac; bez godina/mesec → tekući mesec.`,
    schema: {
      type: "object",
      properties: {
        employee_id: { type: "string", description: `UUID; izostavi za sebe` },
        godina: { type: "integer" },
        mesec: { type: "integer", description: `1–12` },
      },
      required: [],
    },
    kind: "read",
    scopes: LICNI,
    execute: (a, ctx) =>
      rpc(
        ctx,
        Prisma.sql`SELECT ai_chat_sati(${uuidOrNull(a.employee_id)}::uuid, ${intOrNull(a.godina)}::int, ${intOrNull(a.mesec)}::int) AS result`,
      ),
  },
  {
    name: "moj_tim",
    description: `Lista zaposlenih koje pozivalac sme da vidi (rukovodilac: tim; admin/HR: svi; ostali: samo sebe) sa preostalim danima GO i ko je danas odsutan (šifra odsustva).`,
    schema: { type: "object", properties: {}, required: [] },
    kind: "read",
    scopes: LICNI,
    execute: (_a, ctx) =>
      rpc(ctx, Prisma.sql`SELECT ai_chat_moj_tim() AS result`),
  },
  {
    name: "odsustva_lista",
    description: `Periodi odsustva zaposlenog iz evidencije za godinu (od–do datumi + broj dana). Šifre: go=godišnji, bo=bolovanje, pr=praznik, sp=slobodan dan, np/nop=neplaćeno, sv=slava/verski. Bez employee_id → pozivalac; bez godine → tekuća; tip filtrira po šifri. Svaki period ima „vremenski_status" (iskorisceno/u_toku/planirano) — NIKAD ne opisuj „planirano" period kao već iskorišćen; koristi „ukupno_iskorisceno_po_tipu" za „koliko je iskoristio DO SADA" i „ukupno_planirano_po_tipu" za buduće/zakazano.
PAŽNJA (česta greška): ovi periodi su RADNI DANI istog odsustva RASECENI vikendima/praznicima — NISU zasebna odsustva. Odobren zahtev 04.08–17.08 se ovde vidi kao 04–07.08, 10–14.08 i 17.08. Kad odgovaraš „kada ide na odmor", navedi JEDAN neprekidan raspon (od prvog do poslednjeg dana), a NE listu delova; i NIKAD ne nabrajaj i zahtev i ove periode kao da su različiti odmori. Ako ipak nabrajaš delove, navedi ih SVE — uključujući jednodnevne (npr. 17.08) — jer zbir mora da se poklopi sa „ukupno_planirano_po_tipu".`,
    schema: {
      type: "object",
      properties: {
        employee_id: { type: "string", description: `UUID; izostavi za sebe` },
        godina: { type: "integer" },
        tip: { type: "string", description: `npr. go` },
      },
      required: [],
    },
    kind: "read",
    scopes: LICNI,
    execute: (a, ctx) =>
      rpc(
        ctx,
        Prisma.sql`SELECT ai_chat_odsustva(${uuidOrNull(a.employee_id)}::uuid, ${intOrNull(a.godina)}::int, ${strOrNull(a.tip)}) AS result`,
      ),
  },
  {
    name: "go_zahtevi",
    description: `Zahtevi za godišnji odmor zaposlenog (od–do, broj dana, status odobravanja, napomena). Bez employee_id → pozivalac. Svaki zahtev ima i „vremenski_status" (iskorisceno/u_toku/planirano prema današnjem datumu) — odobren zahtev sa datumom u budućnosti je „planiran", NE „iskorišćen".
OVO JE MERODAVAN IZVOR za pitanje „kada X ide na odmor" — odgovori rasponom iz zahteva (npr. „od 04.08. do 17.08., 10 radnih dana, odobreno"). Periodi iz „odsustva_lista"/„go_pregled" su SAMO radni dani tog istog odmora rasečeni vikendima — ne prikazuj ih kao dodatne/zasebne odmore i ne sabiraj ih sa zahtevom.`,
    schema: {
      type: "object",
      properties: {
        employee_id: { type: "string", description: `UUID; izostavi za sebe` },
        godina: { type: "integer" },
      },
      required: [],
    },
    kind: "read",
    scopes: LICNI,
    execute: (a, ctx) =>
      rpc(
        ctx,
        Prisma.sql`SELECT ai_chat_go_zahtevi(${uuidOrNull(a.employee_id)}::uuid, ${intOrNull(a.godina)}::int) AS result`,
      ),
  },
  {
    name: "go_pregled",
    description: `KOMPLETAN pregled godišnjeg odmora za tekuću godinu U JEDNOM POZIVU — koristi ga za „status/pregled godišnjeg sa danima koje sam koristio". Vraća: godišnje pravo, preneto iz prošle godine, (za novozaposlene sa srazmernim sticanjem) zarađeno do danas, ukupno na raspolaganju, iskorišćeno, planirano, preostalo zaključno sa danas, te odvojene liste „periodi_iskorisceno" i „periodi_planirano" (od–do + broj dana). Bez employee_id → za pozivaoca. Ne treba dodatno zvati go_saldo/odsustva_lista.
PAŽNJA: periodi su RADNI DANI odsustva rasečeni vikendima/praznicima — jedan odobren odmor daje više periodâ (04–07.08, 10–14.08, 17.08 = jedan odmor 04.08–17.08). Ne prikazuj ih kao zasebne odmore; ako ih nabrajaš, nabroj SVE (i jednodnevne) da se zbir poklopi sa poljem „planirano".`,
    schema: {
      type: "object",
      properties: {
        employee_id: { type: "string", description: `UUID; izostavi za sebe` },
      },
      required: [],
    },
    kind: "read",
    scopes: LICNI,
    execute: (a, ctx) =>
      rpc(
        ctx,
        Prisma.sql`SELECT ai_chat_go_pregled(${uuidOrNull(a.employee_id)}::uuid) AS result`,
      ),
  },
  {
    name: "go_istorija",
    description: `ISTORIJA godišnjeg odmora PO SVIM GODINAMA (ne samo tekućoj) — usklađeno sa saldom: za svaku godinu iskorišćeni periodi (konkretni datumi od–do), „ranije evidentirano" (dani pre evidencije po danima), PLANIRANI (odobreni budući) periodi i preostalo. Za starije godine vraća staru evidenciju (datumi + napomene). Koristi za „koje dane sam koristio 2025/ove godine", „istorija mog godišnjeg", „od čega se sastoji iskorišćeno". Bez employee_id → pozivalac.`,
    schema: {
      type: "object",
      properties: {
        employee_id: {
          type: "string",
          description: `UUID iz trazi_zaposlenog; izostavi za sebe`,
        },
      },
      required: [],
    },
    kind: "read",
    scopes: LICNI,
    // Paritet edge: rpcAsUser('go_ledger', {p_employee_id}) pa kompaktor.
    // go_ledger VRAĆA jsonb → $queryRaw (void RPC bi išao kroz $executeRaw).
    execute: async (a, ctx) =>
      reshapeGoLedger(
        await rpc(
          ctx,
          Prisma.sql`SELECT go_ledger(${uuidOrNull(a.employee_id)}::uuid) AS result`,
        ),
      ),
  },
  {
    name: "projekat_info",
    description: `Presek PROJEKTA po broju (npr. 9400/7): osnovno (naziv, status, rok, PM), plan montaže (pozicije, napredak, blokade), poslednji izveštaji montera, otvorene akcije sa sastanaka, stavke projektnih sastanaka i beleške tima. Koristi za svako pitanje „šta se dešava na projektu X".`,
    schema: {
      type: "object",
      properties: {
        projekat: {
          type: "string",
          description: `broj projekta, npr. 9400/7`,
        },
      },
      required: ["projekat"],
    },
    kind: "read",
    scopes: DELJENI,
    execute: (a, ctx) =>
      rpc(
        ctx,
        Prisma.sql`SELECT ai_chat_projekat_info(${str(a.projekat)}) AS result`,
      ),
  },
  {
    name: "pretrazi_znanje",
    description: `Pretraga baze znanja: beleške tima + tekst izveštaja montera, po pojmu (dijakritici nebitni). Opcioni filter po projektu. Koristi za „zašto smo odlučili…", „da li je već bilo problema sa…".`,
    schema: {
      type: "object",
      properties: {
        upit: { type: "string", description: `pojam pretrage` },
        projekat: { type: "string", description: `opciono: broj projekta` },
      },
      required: ["upit"],
    },
    kind: "read",
    scopes: DELJENI,
    execute: (a, ctx) =>
      rpc(
        ctx,
        Prisma.sql`SELECT ai_chat_pretrazi_znanje(${strOrNull(a.projekat)}, ${str(a.upit)}) AS result`,
      ),
  },
  {
    name: "dodaj_belesku",
    description: `Sačuvaj belešku/odluku u bazu znanja projekta. Koristi ISKLJUČIVO kad korisnik izričito traži da se nešto zapiše/sačuva („zapiši ovo", „sačuvaj kao odluku"). Autor se beleži automatski.`,
    schema: {
      type: "object",
      properties: {
        projekat: { type: "string", description: `broj projekta, npr. 9400/7` },
        naslov: { type: "string", description: `kratak naslov beleške` },
        tekst: { type: "string", description: `sadržaj beleške` },
      },
      required: ["projekat", "tekst"],
    },
    kind: "write",
    scopes: DELJENI,
    execute: async (a, ctx) => {
      const out = await rpc(
        ctx,
        Prisma.sql`SELECT ai_chat_dodaj_belesku(${str(a.projekat)},
            ${strOrNull(a.naslov)}, ${str(a.tekst)}) AS result`,
      );
      await backfill(
        ctx,
        "ai_project_notes",
        out,
        `${str(a.naslov)}\n${str(a.tekst)}`,
      );
      return out;
    },
  },
  {
    name: "opis_pozicije",
    description: `Sistematizacija: opis radnog mesta (svrha, odgovornosti, ovlašćenja, KPI, kvalifikacije, kome odgovara). Bez naziva → lista SVIH pozicija sa linijom nadređenosti (za pitanja o organizaciji firme).`,
    schema: {
      type: "object",
      properties: {
        pozicija: {
          type: "string",
          description: `deo naziva pozicije (npr. "monter", "vođa projekta"); prazno = lista svih`,
        },
      },
      required: [],
    },
    kind: "read",
    scopes: DELJENI,
    execute: (a, ctx) =>
      rpc(
        ctx,
        Prisma.sql`SELECT ai_chat_opis_pozicije(${strOrNull(a.pozicija)}) AS result`,
      ),
  },
  {
    name: "pretrazi_uputstva",
    description: `Pretraga BAZE UPUTSTAVA I PRAVILA firme (kako se šta radi u aplikaciji, pravilnici, organizacija, kućna pravila) — tekstualno + semantički. OBAVEZNO pozovi za svako pitanje tipa „kako da…", „gde se nalazi…", „koja su pravila za…". Odgovaraj po koracima iz uputstva.`,
    schema: {
      type: "object",
      properties: {
        upit: {
          type: "string",
          description: `pitanje ili pojam (npr. "zahtev za godišnji odmor")`,
        },
      },
      required: ["upit"],
    },
    kind: "read",
    scopes: DELJENI,
    execute: async (a, ctx) => {
      const upit = str(a.upit);
      const emb = await ctx.deps.ai.embed(upit, embedCtx(ctx));
      return rpc(
        ctx,
        Prisma.sql`SELECT ai_chat_pretrazi_uputstva(${upit}, ${emb}) AS result`,
      );
    },
  },
  {
    name: "dodaj_uputstvo",
    description: `Sačuvaj/ažuriraj UPUTSTVO ili pravilo u bazu znanja firme (radi SAMO administratorima i HR-u; upsert po naslovu). Koristi isključivo kad korisnik izričito traži da se uputstvo sačuva.`,
    schema: {
      type: "object",
      properties: {
        naslov: { type: "string" },
        sadrzaj: {
          type: "string",
          description: `koraci/tekst, srpski latinica`,
        },
        modul: {
          type: "string",
          description: `moj-profil|mobilna-app|montaza|sastanci|odrzavanje|reversi|ai-asistent|organizacija|kadrovska|opste`,
        },
        kljucne_reci: { type: "string", description: `sinonimi za pretragu` },
        vidljivost: {
          type: "string",
          description: `'svi' (default) ili 'admin_hr' (vidljivo samo administraciji/HR-u)`,
        },
      },
      required: ["naslov", "sadrzaj"],
    },
    kind: "write",
    scopes: LICNI,
    execute: async (a, ctx) => {
      const out = await rpc(
        ctx,
        Prisma.sql`SELECT ai_chat_dodaj_uputstvo(${str(a.naslov)}, ${str(a.sadrzaj)},
            ${strOrNull(a.modul)}, ${strOrNull(a.kljucne_reci)},
            ${a.vidljivost === "admin_hr" ? "admin_hr" : null}) AS result`,
      );
      await backfill(
        ctx,
        "ai_uputstva",
        out,
        `${str(a.naslov)}\n${str(a.kljucne_reci)}\n${str(a.sadrzaj)}`,
      );
      return out;
    },
  },
  {
    name: "inzenjering_pretraga",
    description: `Baza znanja INŽENJERINGA (modul Projektovanje): pretraga zadataka inženjera (naziv/opis/problem), komentara i dnevnih radnih izveštaja. Opcioni filter po projektu. Koristi za „da li je neko već radio…", „šta je inženjering rekao o…", „na čemu radi projektni biro".`,
    schema: {
      type: "object",
      properties: {
        upit: { type: "string", description: `pojam pretrage` },
        projekat: {
          type: "string",
          description: `opciono: broj projekta (npr. 9400/7)`,
        },
      },
      required: ["upit"],
    },
    kind: "read",
    scopes: DELJENI,
    execute: (a, ctx) =>
      rpc(
        ctx,
        Prisma.sql`SELECT ai_chat_inzenjering(${str(a.upit)}, ${strOrNull(a.projekat)}) AS result`,
      ),
  },
  {
    name: "masina_info",
    description: `Karton mašine iz Održavanja (naziv, proizvođač, model, lokacija) + otvoreni kvarovi, poslednje kontrole i spisak dostupnih dokumenata (uputstva/šeme). Prima šifru (npr. 8.3) ili deo naziva.`,
    schema: {
      type: "object",
      properties: {
        masina: { type: "string", description: `šifra ili naziv mašine` },
      },
      required: ["masina"],
    },
    kind: "read",
    scopes: LICNI,
    execute: (a, ctx) =>
      rpc(
        ctx,
        Prisma.sql`SELECT ai_chat_masina_info(${str(a.masina)}) AS result`,
      ),
  },
  {
    name: "kvar_istorija",
    description: `Istorija kvarova iz Održavanja — za „da li se sličan problem već dešavao": pretraga prijava (opis + REŠENJE + napomene tehničara). Opcioni filter po mašini i/ili pojmu. Koristi PRE davanja predloga za rešavanje.`,
    schema: {
      type: "object",
      properties: {
        masina: { type: "string", description: `opciono: šifra/naziv mašine` },
        upit: {
          type: "string",
          description: `opciono: pojam (npr. „curi ulje", „ne pali")`,
        },
      },
      required: [],
    },
    kind: "read",
    scopes: LICNI,
    execute: (a, ctx) =>
      rpc(
        ctx,
        Prisma.sql`SELECT ai_chat_kvar_istorija(${strOrNull(a.masina)}, ${strOrNull(a.upit)}) AS result`,
      ),
  },
  {
    name: "masina_uputstvo",
    description: `Pretraga UPUTSTAVA I DOKUMENTACIJE mašine (PDF-ovi otpremljeni u Održavanje) — semantički + tekstualno; vraća odlomke sa nazivom dokumenta i brojem strane. Koristi za „kako se…", „šta znači greška…", „gde je podešavanje…" na konkretnoj mašini.`,
    schema: {
      type: "object",
      properties: {
        masina: { type: "string", description: `šifra ili naziv mašine` },
        pitanje: { type: "string", description: `šta se traži u uputstvu` },
      },
      required: ["masina", "pitanje"],
    },
    kind: "read",
    scopes: LICNI,
    execute: async (a, ctx) => {
      const pitanje = str(a.pitanje);
      const emb = await ctx.deps.ai.embed(pitanje, embedCtx(ctx));
      return rpc(
        ctx,
        Prisma.sql`SELECT ai_chat_masina_uputstvo(${str(a.masina)}, ${pitanje}, ${emb}) AS result`,
      );
    },
  },
  {
    name: "prijavi_kvar",
    description: `Prijavi kvar na mašini u modul Održavanje. PRE poziva prikupi kroz razgovor: mašinu, kratak naslov, opis, ozbiljnost i da li postoji bezbednosni rizik; POKAŽI korisniku rezime i sačekaj izričitu potvrdu, pa pozovi alat. Ako korisnik nema prava, alat vrati nema_prava.`,
    schema: {
      type: "object",
      properties: {
        masina: { type: "string", description: `šifra ili naziv mašine` },
        naslov: { type: "string", description: `kratak opis kvara` },
        opis: {
          type: "string",
          description: `detalji: šta se dešava, kada, simptomi`,
        },
        ozbiljnost: {
          type: "string",
          description: `normal | minor | important | major | critical`,
        },
        bezbednosni_rizik: {
          type: "boolean",
          description: `true ako kvar predstavlja opasnost`,
        },
      },
      required: ["masina", "naslov"],
    },
    kind: "write",
    scopes: LICNI,
    execute: (a, ctx) =>
      rpc(
        ctx,
        Prisma.sql`SELECT ai_chat_prijavi_kvar(${str(a.masina)}, ${str(a.naslov)},
          ${strOrNull(a.opis)}, ${a.ozbiljnost ? str(a.ozbiljnost) : "minor"},
          ${a.bezbednosni_rizik === true}) AS result`,
      ),
  },
  {
    name: "sql_upit",
    description: `SAMO ZA ADMIN/HR (ostali dobiju nema_prava): slobodan READ-ONLY SQL upit nad bazom — jedan SELECT/WITH, bez tačke-zapete i komentara, max 200 redova, timeout 4s; RLS važi kao za pozivaoca. Ako ne znaš šemu, prvo upitaj information_schema.columns (table_schema=public). Na sql_greska ispravi upit i pokušaj ponovo.`,
    schema: {
      type: "object",
      properties: {
        upit: { type: "string", description: `SELECT … (bez ; na kraju)` },
      },
      required: ["upit"],
    },
    kind: "read",
    scopes: LICNI,
    execute: (a, ctx) =>
      rpc(ctx, Prisma.sql`SELECT ai_chat_sql(${str(a.upit)}) AS result`),
  },
  {
    name: "trosak_sredstva",
    description: `Koliko je koštalo održavanje jednog vozila ili mašine — zbir po radnim nalozima + poslednji nalozi sa iznosima. Prima registarsku oznaku (npr. BG2884XA), šifru sredstva ili deo naziva (npr. „Caddy"), opciono broj meseci unazad. Koristi za „koliko me je koštao…", „šta smo dali na servise…", „najskuplji nalog".`,
    schema: {
      type: "object",
      properties: {
        sredstvo: {
          type: "string",
          description: `tablice, šifra ili naziv vozila/mašine`,
        },
        meseci: {
          type: "integer",
          description: `opciono: koliko meseci unazad (podrazumevano sve)`,
        },
      },
      required: ["sredstvo"],
    },
    kind: "read",
    scopes: LICNI,
    // Direktan SELECT kroz withUserRls (RLS presuđuje redove) — namerno BEZ nove DB
    // funkcije: trošak je čitanje, a pravilo „max(delovi, faktura)" već postoji u
    // OdrzavanjeService i ovde se ponavlja kao GREATEST da se dva ekrana ne raziđu.
    execute: async (a, ctx) => {
      const q = `%${str(a.sredstvo)}%`;
      const exact = str(a.sredstvo);
      const meseci = intOrNull(a.meseci);
      return ctx.deps.sy15.withUserRls(ctx.email, async (tx) => {
        const assets = await tx.$queryRaw<
          { asset_id: string; asset_code: string; name: string; asset_type: string }[]
        >(Prisma.sql`
          SELECT a.asset_id, a.asset_code, a.name, a.asset_type::text
            FROM maint_assets a
            LEFT JOIN maint_vehicle_details vd ON vd.asset_id = a.asset_id
           WHERE a.archived_at IS NULL
             AND (a.asset_code ILIKE ${q} OR a.name ILIKE ${q}
                  OR replace(upper(coalesce(vd.registration_plate,'')), ' ', '')
                     LIKE replace(upper(${q}), ' ', ''))
           ORDER BY (upper(a.asset_code) = upper(${exact})) DESC, a.asset_code
           LIMIT 5`);
        if (!assets.length) {
          return {
            error: "nema_sredstva",
            poruka: `Vozilo/mašina „${exact}" nije nađeno — proveri tablice, šifru ili naziv.`,
          };
        }
        if (assets.length > 1 && assets[0].asset_code.toUpperCase() !== exact.toUpperCase()) {
          return {
            error: "vise_pogodaka",
            poruka: "Precizirajte koje sredstvo:",
            pogoci: assets.map((x) => `${x.asset_code} — ${x.name}`),
          };
        }
        const a0 = assets[0];
        const odKad = meseci && meseci > 0 ? Prisma.sql`AND wo.created_at >= now() - make_interval(months => ${meseci})` : Prisma.empty;
        const nalozi = await tx.$queryRaw<
          {
            wo_number: string | null;
            title: string;
            status: string;
            created_at: Date;
            trosak: number;
            servis: string | null;
          }[]
        >(Prisma.sql`
          SELECT wo.wo_number, wo.title, wo.status::text, wo.created_at,
                 GREATEST(
                   COALESCE((SELECT SUM(p.quantity * COALESCE(p.unit_cost, mp.unit_cost, 0))
                               FROM maint_wo_parts p
                               LEFT JOIN maint_parts mp ON mp.part_id = p.part_id
                              WHERE p.wo_id = wo.wo_id), 0),
                   COALESCE(wo.cost_total, 0)
                 )::float8 AS trosak,
                 wo.external_servicer_name AS servis
            FROM maint_work_orders wo
           WHERE wo.asset_id = ${a0.asset_id}::uuid ${odKad}
           ORDER BY wo.created_at DESC
           LIMIT 200`);
        const ukupno = nalozi.reduce((s, n) => s + (Number(n.trosak) || 0), 0);
        const saCenom = nalozi.filter((n) => Number(n.trosak) > 0);
        return {
          sredstvo: `${a0.asset_code} — ${a0.name}`,
          tip: a0.asset_type,
          period: meseci && meseci > 0 ? `poslednjih ${meseci} meseci` : "sve vreme",
          broj_naloga: nalozi.length,
          naloga_sa_cenom: saCenom.length,
          ukupan_trosak_rsd: Math.round(ukupno),
          prosek_po_nalogu_rsd: saCenom.length
            ? Math.round(ukupno / saCenom.length)
            : 0,
          napomena:
            saCenom.length < nalozi.length
              ? `${nalozi.length - saCenom.length} naloga nema upisanu cenu — stvarni trošak je veći.`
              : undefined,
          nalozi: nalozi.slice(0, 20).map((n) => ({
            broj: n.wo_number,
            naslov: n.title,
            status: n.status,
            datum: n.created_at,
            trosak_rsd: Math.round(Number(n.trosak) || 0),
            servis: n.servis,
          })),
        };
      });
    },
  },
];
