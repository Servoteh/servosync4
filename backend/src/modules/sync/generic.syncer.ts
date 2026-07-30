import { PrismaService } from '../../prisma/prisma.service';
import { MssqlClient } from './mssql.client';
import {
  ColumnMapping,
  EntitySyncer,
  SyncCursor,
  SyncEntityResult,
  SyncStrategy,
  TableMapping,
} from './sync.types';
import {
  additiveDedupFieldFor,
  hasNativeColumns,
  hasNativeIdRange,
  isAdditiveRefreshTable,
  isNativeRow,
  isOwnedProductionTable,
  NATIVE_ID_BASE,
  sourceFkFiltersFor,
  sourceUniqueFieldFor,
} from './table-ownership';

/**
 * Data-driven syncer for one QBigTehn table -> one Prisma model.
 *
 * Column names, types, PK and the incremental watermark all come from
 * `sync-map.generated.ts` (built from docs/schema-rename-map.md + Prisma DMMF),
 * so a single implementation covers every mapped table.
 *
 * - full_refresh: `deleteMany` + chunked `createMany`, wrapped in a transaction
 *   with `session_replication_role = replica` so FK constraints don't block the
 *   bulk load (order-independent; the source is the single source of truth).
 *   For ADDITIVE_REFRESH_TABLES (e.g. `projects`) the wipe is narrowed to only
 *   the ids the source returned, so 2.0-native rows the source never sends are
 *   preserved (see `isAdditiveRefreshTable`).
 *   For NATIVE_ID_RANGE_TABLES (`items`, `customers`) the wipe is narrowed to the
 *   BigBit key space (`id < NATIVE_ID_BASE`), pa 4.0-native red ne može da nestane
 *   ni noćnim poslom ni ručnim `POST /sync/run` (v. `hasNativeIdRange`).
 * - incremental: per-row `upsert` filtered by `PoslednjaIzmena > cursor`.
 */
export class GenericSyncer implements EntitySyncer {
  readonly entity: string;
  readonly defaultStrategy: SyncStrategy;
  private readonly delegateName: string;

  constructor(
    private readonly mapping: TableMapping,
    private readonly mssql: MssqlClient,
    private readonly prisma: PrismaService,
  ) {
    this.entity = mapping.targetDb;
    this.defaultStrategy = mapping.watermark ? 'incremental' : 'full_refresh';
    // Prisma client delegate = model name with a lower-cased first letter.
    this.delegateName = mapping.model[0].toLowerCase() + mapping.model.slice(1);
  }

  async sync(options: {
    strategy: SyncStrategy;
    cursor: SyncCursor | null;
    force?: boolean;
  }): Promise<SyncEntityResult> {
    const errors: string[] = [];
    const incremental =
      options.strategy === 'incremental' &&
      !!this.mapping.watermark &&
      !!options.cursor?.lastModifiedAt;

    // Protect ServoSync-owned production tables: a full refresh would delete +
    // reinsert, wiping anything a technologist entered after the initial import.
    // Skip (never delete) once such a table has rows, unless the run is forced.
    if (!incremental && isOwnedProductionTable(this.entity) && !options.force) {
      const existing = await this.delegate().count();
      if (existing > 0) {
        return {
          entity: this.entity,
          rowsFetched: 0,
          rowsUpserted: 0,
          rowsSkipped: 0,
          newCursor: options.cursor ?? { strategy: 'full_refresh' },
          errors: [],
          note: `Preskočeno (zaštita): ${existing} redova već postoji u ServoSync-owned tabeli. Prosledi force:true za ponovni uvoz.`,
        };
      }
    }

    // Select only the mapped columns (bracket-quoted; QBigTehn names have spaces).
    const cols = this.mapping.columns.map((c) => `[${c.src}]`).join(', ');
    const where = incremental ? 'WHERE [PoslednjaIzmena] > @cursor' : '';
    // Redosled je DEO UGOVORA za tabele sa `SOURCE_UNIQUE_FIELDS`: dedup zadržava
    // PRVI red po ključu, pa bez `ORDER BY` (MSSQL ne garantuje redosled bez
    // njega) sledeći sync sme da izabere DRUGI red kao pobednika — isti kataloški
    // broj, drugi `id`, a sve meke reference pokazuju na stari. Review 26.07 [1].
    const order = this.mapping.watermark
      ? 'ORDER BY [PoslednjaIzmena] ASC'
      : sourceUniqueFieldFor(this.entity)
        ? this.pkOrderBy()
        : '';
    const rows = await this.mssql.query<Record<string, unknown>>(
      `SELECT ${cols} FROM [dbo].[${this.mapping.source}] ${where} ${order}`,
      incremental ? { cursor: new Date(options.cursor!.lastModifiedAt!) } : {},
    );

    let data = rows.map((r) => this.mapRow(r));

    let rowsUpserted = 0;
    let rowsSkipped = 0;
    /** Poruke za `note` (za razliku od `errors`, `note` STIŽE u `bb_sync_log`). */
    const notes: string[] = [];

    // ── REZERVISAN OPSEG KLJUČEVA (adversarni pregled 28.07.2026, nalaz [1]/[2]) ──
    // Izvorni red čiji `id` upada u 4.0-native opseg NE SME da uđe ni jednom
    // granom: u full refresh-u bi `createMany` pao na `chk_*_native_id_range`
    // (i oborio CEO chunk), a u inkrementalnoj/upsert grani bi PREGAZIO
    // 4.0-native red tuđim podacima — tiho, jer upsert ne razlikuje poreklo.
    // Filtrira se PRE računanja watermark-a, da preskočen red ne pomeri kursor.
    const nativeRange = hasNativeIdRange(this.entity);
    if (nativeRange) {
      this.assertSingleIdPk('Zaštita rezervisanog opsega ključeva');
      const kept: typeof data = [];
      for (const d of data) {
        if (isNativeRow(this.entity, d.id as number)) {
          rowsSkipped++;
          if (errors.length < 20)
            errors.push(
              `${this.pkLabel(d)}: id je u rezervisanom 4.0 opsegu (≥ ${NATIVE_ID_BASE}) — BigBit red PRESKOČEN da ne pregazi 4.0-native red (28.07)`,
            );
          continue;
        }
        kept.push(d);
      }
      if (kept.length !== data.length) {
        notes.push(
          `⚠️ ${data.length - kept.length} izvornih redova ima id iz rezervisanog 4.0 opsega (≥ ${NATIVE_ID_BASE}) — PRESKOČENI (BigBit tu šifru ne sme da koristi).`,
        );
        data = kept;
      }
    }

    // Track the newest watermark seen so the next run can go incremental.
    let maxModified: Date | null = options.cursor?.lastModifiedAt
      ? new Date(options.cursor.lastModifiedAt)
      : null;
    if (this.mapping.watermark) {
      for (const d of data) {
        const v = d[this.mapping.watermark] as Date | null;
        if (v && (!maxModified || v > maxModified)) maxModified = v;
      }
    }

    if (incremental) {
      const delegate = this.delegate();
      for (const d of data) {
        try {
          await delegate.upsert({
            where: this.pkWhere(d),
            create: d,
            update: d,
          });
          rowsUpserted++;
        } catch (err) {
          rowsSkipped++;
          const message = err instanceof Error ? err.message : String(err);
          if (errors.length < 20) errors.push(`${this.pkLabel(d)}: ${message}`);
        }
      }
    } else if (hasNativeColumns(this.entity)) {
      // TABELA SA 3.0-NATIVE KOLONAMA (npr. `companies.iban`/`swift`): full refresh
      // bi ih obrisao bez traga, jer `createMany` vraća samo MAPIRANE kolone.
      // Zato: upsert red-po-red, `update` samo nad mapiranim poljima — sve što izvor
      // ne zna ostaje netaknuto. Nikad `deleteMany`. (v. `NATIVE_COLUMN_TABLES`)
      const delegate = this.delegate();
      for (const d of data) {
        try {
          await delegate.upsert({
            where: this.pkWhere(d),
            create: d,
            update: d,
          });
          rowsUpserted++;
        } catch (err) {
          rowsSkipped++;
          const message = err instanceof Error ? err.message : String(err);
          if (errors.length < 20) errors.push(`${this.pkLabel(d)}: ${message}`);
        }
      }
    } else {
      // Full refresh: wipe + bulk insert with FK enforcement disabled.
      // Binary (Bytes) columns can be many MB each; a big chunk would serialize
      // into a query string past V8's max length, so cap those tables hard.
      const hasBytes = this.mapping.columns.some((c) => c.type === 'Bytes');
      const chunkSize = hasBytes
        ? 5
        : Math.max(
            1,
            Math.min(5000, Math.floor(60000 / Math.max(1, this.mapping.columns.length))),
          );
      // Additive refresh (e.g. projects): the source (BigBit) still owns and
      // updates its rows, but 2.0 also creates NATIVE rows in the same table.
      // A blind deleteMany({}) would wipe those native rows on every run, so we
      // delete ONLY the ids the source returned and re-insert them — an upsert
      // of the whole source set that never touches ids the source didn't send.
      const additive = isAdditiveRefreshTable(this.entity);
      const sourceIds = additive ? this.collectSourceIds(data) : null;
      // Id-jevi koje brisanje sme da dohvati. Po pravilu = svi izvorni, ali se
      // sužava za app-owned redove koji sede na id-u iz BigBit prostora (dole).
      let deleteIds = sourceIds;

      // Number-parity guard (Nenad 2026-07-22, projects): the same predmet is
      // entered manually in BOTH systems with the SAME number. Skip any source
      // row whose dedup-field value already lives on a row the source does NOT
      // own (id not in the source set = a 3.0-native row) — inserting it would
      // create a duplicate number. The source id still gets deleted above, so a
      // previously-inserted duplicate self-heals on the next run.
      let insertData = data;
      const dedupField = additive ? additiveDedupFieldFor(this.entity) : null;
      if (dedupField && data.length) {
        const norm = (v: unknown): string => String(v ?? "").trim();
        const values = [
          ...new Set(data.map((d) => norm(d[dedupField])).filter(Boolean)),
        ];
        // Jedan upit za OBA slučaja: postojeći red sa istom VREDNOŠĆU (paritet
        // brojeva) i postojeći red na istom ID-u (kolizija id prostora, dole).
        const existing: { id: number; [k: string]: unknown }[] =
          values.length || sourceIds!.length
            ? await this.delegate().findMany({
                where: {
                  OR: [
                    { [dedupField]: { in: values } },
                    { id: { in: sourceIds } },
                  ],
                },
                select: { id: true, [dedupField]: true },
              })
            : [];
        const sourceIdSet = new Set(sourceIds!);
        const sourceValueSet = new Set(values);
        const nativeByValue = new Map<string, number>();
        // KOLIZIJA ID PROSTORA (review 26.07 [0]): PG sekvenca ne prati BigBit
        // id prostor, pa 4.0-seedovan red (npr. document_types VISAR/MANJR/NIV,
        // migracija 20260724160000) može da sedi na id-u koji BigBit takođe
        // koristi. Slepi `delete id IN (izvor)` bi ga obrisao. Takav red se
        // prepoznaje po tome što njegova dedup-vrednost NE POSTOJI nigde u
        // izvoru — dakle nije BigBit red. Tada: id se izuzima iz brisanja, a
        // izvorni red sa tim id-em se PRESKAČE (inače bi `createMany` pao na PK).
        // Svesna posledica: ako BigBit PREIMENUJE šifru postojećeg reda, ovde se
        // to vidi kao kolizija i tok se prijavi umesto da tiho prepiše 4.0 red.
        const squatterIds = new Map<number, string>();
        for (const e of existing) {
          const value = norm(e[dedupField]);
          if (!sourceIdSet.has(e.id)) {
            if (sourceValueSet.has(value)) nativeByValue.set(value, e.id);
          } else if (!sourceValueSet.has(value)) {
            squatterIds.set(e.id, value);
          }
        }
        if (squatterIds.size) {
          deleteIds = sourceIds!.filter((id) => !squatterIds.has(id));
        }
        if (nativeByValue.size || squatterIds.size) {
          insertData = [];
          for (const d of data) {
            const squatterValue = squatterIds.get(Number(d.id));
            if (squatterValue !== undefined) {
              rowsSkipped++;
              if (errors.length < 20)
                errors.push(
                  `${this.pkLabel(d)}: id je zauzet app-owned redom (${dedupField}=${squatterValue}) koji izvor ne poznaje — BigBit red preskočen, postojeći red NIJE obrisan (kolizija id prostora, 26.07)`,
                );
              continue;
            }
            const nativeId = nativeByValue.get(norm(d[dedupField]));
            if (nativeId !== undefined) {
              rowsSkipped++;
              if (errors.length < 20)
                errors.push(
                  `${this.pkLabel(d)}: ${dedupField}=${String(d[dedupField])} već postoji na 3.0-native redu id=${nativeId} — BigBit kopija preskočena (paritet brojeva, 22.07)`,
                );
            } else insertData.push(d);
          }
        }
      }

      // JEDINSTVENOST U IZVORNOM SKUPU (DB-081, npr. items.catalogNumber):
      // zadrži PRVI red po ključu, ostale preskoči uz zapis u sync log. Radi se
      // PRE upisa jer bi tvrd UNIQUE oborio ceo `createMany` chunk (full refresh
      // ide pod `session_replication_role='replica'`, gde UNIQUE i dalje važi).
      const uniqueField = sourceUniqueFieldFor(this.entity);
      if (uniqueField && insertData.length) {
        const seen = new Map<string, unknown>();
        const kept: typeof insertData = [];
        for (const d of insertData) {
          const key = String(d[uniqueField] ?? "")
            .trim()
            .toLowerCase();
          if (key === "") {
            kept.push(d);
            continue;
          }
          const first = seen.get(key);
          if (first !== undefined) {
            rowsSkipped++;
            if (errors.length < 20)
              errors.push(
                `${this.pkLabel(d)}: ${uniqueField}="${String(d[uniqueField])}" već donet u ovom sync-u (izvor: ${String(first)}) — duplikat kataloškog broja PRESKOČEN (DB-081; očisti izvor u BigBit-u)`,
              );
            continue;
          }
          seen.set(key, this.pkLabel(d));
          kept.push(d);
        }
        insertData = kept;
      }

      // FK PRE-FILTER (review 26.07 [3]): pod `session_replication_role='replica'`
      // FK trigeri NE RADE, pa bi prekršilac tiho ušao kao siroče. Radi se samo u
      // full-refresh grani — inkrementalni put ide kroz `upsert` (FK se poštuje,
      // red se skip-uje uz poruku).
      for (const fk of sourceFkFiltersFor(this.entity)) {
        if (!insertData.length) break;
        const wanted = [
          ...new Set(
            insertData.map((d) => d[fk.field]).filter((v) => v != null),
          ),
        ];
        if (!wanted.length) continue;
        const refRows: Record<string, unknown>[] = await (
          this.prisma as unknown as Record<string, any>
        )[fk.refDelegate].findMany({
          where: { [fk.refField]: { in: wanted } },
          select: { [fk.refField]: true },
        });
        const present = new Set(refRows.map((r) => r[fk.refField]));
        const kept: typeof insertData = [];
        for (const d of insertData) {
          const value = d[fk.field];
          if (value != null && !present.has(value)) {
            rowsSkipped++;
            if (errors.length < 20)
              errors.push(
                `${this.pkLabel(d)}: ${fk.field}=${String(value)} — ${fk.reason}; red PRESKOČEN (FK pre-filter)`,
              );
            continue;
          }
          kept.push(d);
        }
        insertData = kept;
      }

      // Koliko 4.0-native redova brisanje NEĆE dohvatiti — broji se PRE upisa da
      // bi ušlo u `bb_sync_log` kao dokaz da je zaštita radila, a ne ćutala.
      let nativeProtected = 0;
      if (nativeRange) {
        nativeProtected = await this.delegate().count({
          where: { id: { gte: NATIVE_ID_BASE } },
        });
        if (nativeProtected > 0)
          notes.push(
            `Zaštićeno ${nativeProtected} 4.0-native redova (id ≥ ${NATIVE_ID_BASE}) — brisanje ih nije dohvatilo.`,
          );
      }

      // ╔═══════════════════════════════════════════════════════════════════════╗
      // ║  PRAZAN IZVOR NIKAD NE BRIŠE (odluka vlasnika O-2, 30.07.2026:         ║
      // ║  „kada obrišemo predmet u BigBitu da ne obrišemo u ServoSync-u da nam  ║
      // ║  ne pukne baza")                                                       ║
      // ║                                                                        ║
      // ║  Pun refresh je „obriši pa vrati". Ako izvor vrati NULA redova, prvi    ║
      // ║  deo se izvrši a drugi nema šta da vrati — tabela ostane prazna, i to   ║
      // ║  uz status „uspešno". Nula redova nikad nije poslovna činjenica nego     ║
      // ║  kvar izvora: prazna kopija baze, oborena veza, pogrešna baza u URL-u.  ║
      // ║                                                                        ║
      // ║  Ovo NIJE teorijski rizik: QBigTehn je 22.07.2026 prestao da se puni i  ║
      // ║  osam dana je vraćao zamrznute podatke. Da je vratio prazno, jedan      ║
      // ║  `POST /sync/run` obrisao bi 92.511 artikala — sa svom decom u          ║
      // ║  cenovnicima i sastavnicama.                                            ║
      // ║                                                                        ║
      // ║  DVE ISPRAVKE POSLE PADA POSTOJEĆIH TESTOVA (oba su bila u pravu):      ║
      // ║                                                                        ║
      // ║  1. Brana važi SAMO za grane koje PRAZNE tabelu (`nativeRange` i slepa). ║
      // ║     Aditivna grana (predmeti) briše isključivo id-jeve koje je izvor     ║
      // ║     poslao, pa je prazan izvor tamo bezopasan „nema šta da se radi" —    ║
      // ║     obarati ga značilo bi pretvoriti bezopasnu ništicu u kvar.           ║
      // ║                                                                        ║
      // ║  2. Meri se SIROVI izvor (`data`), ne `insertData`. `insertData` je već   ║
      // ║     prošao dedup po broju/šifri, pa izvor koji JESTE poslao redove — a    ║
      // ║     svi su preskočeni paritet-guardom — ima `insertData.length === 0`.    ║
      // ║     To nije prazan izvor nego uspešno odrađen guard.                     ║
      // ╚═══════════════════════════════════════════════════════════════════════╝
      if (!additive && data.length === 0) {
        throw new Error(
          `Sync „${this.entity}" ZAUSTAVLJEN: izvor je vratio 0 redova, a strategija je ` +
            "pun refresh (obriši pa vrati). Nastavak bi ISPRAZNIO tabelu i prijavio uspeh. " +
            "Nula redova nije poslovno stanje nego kvar izvora — prazna kopija BigBit baze, " +
            "oborena veza ili pogrešna baza u konfiguraciji. Postojeći podaci su NETAKNUTI. " +
            "Proveri izvor pa ponovi.",
        );
      }

      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            "SET LOCAL session_replication_role = 'replica'",
          );
          const del = (tx as Record<string, any>)[this.delegateName];
          if (additive) {
            // Empty source set -> nothing to delete (and Prisma `in: []` matches
            // nothing anyway); never fall back to wiping everything.
            if (deleteIds!.length > 0) {
              await del.deleteMany({ where: { id: { in: deleteIds } } });
            }
          } else if (nativeRange) {
            // REZERVISAN OPSEG: obriši SAMO BigBit prostor ključeva. Izvor i dalje
            // vlada svojim redovima (pun refresh ispod granice), a 4.0-native red
            // (id ≥ NATIVE_ID_BASE) brisanje ni ne vidi — ni noću, ni na ručni
            // `POST /sync/run`, ni sa `force: true`.
            await del.deleteMany({ where: { id: { lt: NATIVE_ID_BASE } } });
          } else {
            await del.deleteMany({});
          }
          for (let i = 0; i < insertData.length; i += chunkSize) {
            await del.createMany({ data: insertData.slice(i, i + chunkSize) });
          }
          // KLAMP SEKVENCE (review 26.07 [0]): `createMany` sa eksplicitnim `id`
          // NE pomera PG sekvencu, pa bi sledeći 4.0-native unos (npr. nova vrsta
          // dokumenta) dobio id koji BigBit već koristi → 23505 na PK. Posle
          // aditivnog prolaza sekvenca se podiže na max(id). `setval` je STRICT:
          // ako tabela nema serial/identity, `pg_get_serial_sequence` vrati NULL
          // i poziv tiho vrati NULL (bez greške).
          if (additive) await this.bumpIdSequence(tx);
        },
        { timeout: 20 * 60 * 1000, maxWait: 30 * 1000 },
      );
      rowsUpserted = insertData.length;
    }

    const newCursor: SyncCursor = this.mapping.watermark
      ? { lastModifiedAt: (maxModified ?? new Date()).toISOString() }
      : { strategy: 'full_refresh' };

    return {
      entity: this.entity,
      rowsFetched: rows.length,
      rowsUpserted,
      rowsSkipped,
      newCursor,
      errors,
      // `errors` NE stižu u `bb_sync_log.metadata` (SyncService prenosi samo
      // brojeve i `note`), pa zaštita native redova mora da izveštava kroz `note`.
      ...(notes.length ? { note: notes.join(" ") } : {}),
    };
  }

  private delegate(): any {
    return (this.prisma as unknown as Record<string, any>)[this.delegateName];
  }

  /**
   * Ids the source returned, for the additive full-refresh delete. The additive
   * path assumes a single-field `id` PK (an `id: { in: [...] }` delete); guard
   * against a config mistake that would otherwise silently wipe or under-delete.
   */
  private collectSourceIds(data: Record<string, unknown>[]): number[] {
    this.assertSingleIdPk('Additive refresh');
    const ids: number[] = [];
    for (const d of data) {
      const v = d.id;
      if (typeof v === 'number') ids.push(v);
      else if (v != null) ids.push(Number(v));
    }
    return ids;
  }

  /**
   * Obe uže grane brisanja (`id IN (...)` za aditivne, `id < BASE` za tabele sa
   * rezervisanim opsegom) pretpostavljaju jednostavan `id` PK. Bez ove provere
   * greška u mapiranju bi značila TIHO pogrešno brisanje.
   */
  private assertSingleIdPk(what: string): void {
    const pk = this.mapping.pk;
    if (!pk || pk.kind !== 'single' || pk.field !== 'id') {
      throw new Error(
        `${what} for ${this.entity} requires a single-field "id" PK`,
      );
    }
  }

  /**
   * `ORDER BY` po IZVORNOJ koloni primarnog ključa — stabilan redosled za dedup
   * (v. `SOURCE_UNIQUE_FIELDS`). Ako se izvorna kolona ne da razrešiti, vraća
   * prazno (bolje bez sortiranja nego neispravan SQL).
   */
  private pkOrderBy(): string {
    const pk = this.mapping.pk;
    if (!pk) return '';
    const fields = pk.kind === 'single' ? [pk.field] : pk.fields;
    const srcCols: string[] = [];
    for (const f of fields) {
      const col = this.mapping.columns.find((c) => c.field === f);
      if (!col) return '';
      srcCols.push(`[${col.src}] ASC`);
    }
    return srcCols.length ? `ORDER BY ${srcCols.join(', ')}` : '';
  }

  /** Podigni PG sekvencu `id` kolone na max(id) posle aditivnog refresh-a. */
  private async bumpIdSequence(tx: unknown): Promise<void> {
    // `this.entity` dolazi iz naše generisane mape, ali identifikator ipak
    // proveravamo pre interpolacije (raw SQL ne prima ime tabele kao parametar).
    if (!/^[a-z_][a-z0-9_]*$/.test(this.entity)) return;
    await (tx as { $executeRawUnsafe(sql: string): Promise<number> })
      .$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('${this.entity}', 'id'),
                GREATEST((SELECT COALESCE(MAX(id), 0) FROM "${this.entity}"), 1), true)`,
      );
  }

  /** Build the Prisma `where` for an upsert from the mapped row's PK field(s). */
  private pkWhere(d: Record<string, unknown>): Record<string, unknown> {
    const pk = this.mapping.pk;
    if (!pk) throw new Error(`No primary key mapped for ${this.entity}`);
    if (pk.kind === 'single') return { [pk.field]: d[pk.field] };
    const composite: Record<string, unknown> = {};
    for (const f of pk.fields) composite[f] = d[f];
    return { [pk.name]: composite };
  }

  private pkLabel(d: Record<string, unknown>): string {
    const pk = this.mapping.pk;
    if (!pk) return '?';
    const fields = pk.kind === 'single' ? [pk.field] : pk.fields;
    return fields.map((f) => `${f}=${String(d[f])}`).join(',');
  }

  /** Map + type-coerce a single source row into the Prisma shape. */
  private mapRow(r: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const c of this.mapping.columns) out[c.field] = this.coerce(r[c.src], c);
    return out;
  }

  private coerce(value: unknown, col: ColumnMapping): unknown {
    if (value === null || value === undefined) return null;
    switch (col.type) {
      case 'Int':
        return typeof value === 'number' ? Math.trunc(value) : Number(value);
      case 'BigInt':
        return typeof value === 'bigint' ? value : BigInt(value as never);
      case 'Float':
        return Number(value);
      case 'Decimal':
        // Prisma accepts number | string | Decimal; pass through.
        return value;
      case 'Boolean':
        return typeof value === 'boolean' ? value : Boolean(value);
      case 'DateTime':
        return value instanceof Date ? value : new Date(value as string);
      case 'String':
        return typeof value === 'string' ? value : String(value);
      case 'Bytes':
      case 'Json':
      default:
        return value;
    }
  }
}
