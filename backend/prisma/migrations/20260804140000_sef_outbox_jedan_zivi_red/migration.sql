-- ============================================================================
-- SEF outbox: NAJVIŠE JEDAN ŽIV RED PO FAKTURI
-- ============================================================================
--
-- ZAŠTO
-- `SefService.enqueue` je pravio nov `sef_outbox` red bez ijedne provere postojećeg.
-- Deklarisana „idempotencija po `requestId`" ne može da radi jer je `requestId`
-- `randomUUID()` PO REDU, ne po dokumentu — dva poziva daju dva različita UUID-a i dva
-- PENDING reda, oba prohodna kroz `send()`. Ista faktura tako ode kupcu i Poreskoj
-- upravi DVAPUT, a ispravka duplikata na SEF-u je vanjska procedura sa kupcem i PU:
-- to je jedina posledica u ovoj reviziji koja se NE MOŽE poništiti unutar sistema.
--
-- KOJI STATUSI SU „ŽIVI"
-- Brava mora da dozvoli LEGITIMAN ponovni red i da blokira drugi živi:
--   PENDING · SENT · DELIVERED · CANCEL_PENDING  → ŽIVI (blokiraju nov red)
--   CANCELLED · REJECTED                          → ne blokiraju
-- `REJECTED` je namerno izuzet: SEF je odbio dokument, ispravka i ponovno slanje su
-- normalan tok. `CANCEL_PENDING` je namerno UKLJUČEN — to je „storniran kod nas, SEF
-- nije potvrdio otkazivanje", jedino stanje u kome se naša evidencija i SEF svesno
-- razilaze; nov red bi kupcu poslao drugu e-fakturu za dokument koji je kod nas storniran.
--
-- ZAŠTO PARCIJALNI INDEKS, A NE PROVERA SAMO U KODU
-- Provera u kodu je dodata (`enqueue` odbija sa 409), ali dva paralelna klika mogu da
-- prođu proveru pre nego što ijedan upiše red. Bravu koja to zaustavlja može da drži
-- samo baza. Kod hvata `P2002` i vraća istu 409 poruku.
--
-- 🔴 PRED-POLETNA PROVERA JE OBAVEZNA, PRE DEPLOY-A
-- Isti rizik kao svaka unique migracija: nad tabelom sa zatečenim duplikatima `CREATE UNIQUE
-- INDEX` pada i obara CEO deploy. Produkcija u trenutku pisanja NIJE bila dohvatljiva
-- (ssh reset), pa broj duplikata NIJE izmeren. Pre deploy-a pokrenuti:
--   ssh ubuntusrv 'bash -s' < backend/scripts/preflight-unique-migrations.sh
--
-- ⚠️ AKO OVA MIGRACIJA PADNE
-- Znači da na toj bazi VEĆ postoje duplikati i to nije stvar za tiho čišćenje — koji je
-- red merodavan zna samo čovek koji vidi stanje na SEF portalu. Blok ispod zato prijavi
-- TAČNE fakture umesto golog „could not create unique index". Pregled:
--   SELECT invoice_id, array_agg(id ORDER BY id), array_agg(status ORDER BY id)
--   FROM sef_outbox WHERE status NOT IN ('CANCELLED','REJECTED')
--   GROUP BY invoice_id HAVING COUNT(*) > 1;
-- ============================================================================

DO $$
DECLARE
  dup RECORD;
  msg TEXT := '';
BEGIN
  FOR dup IN
    SELECT invoice_id, COUNT(*) AS c, array_agg(id ORDER BY id) AS ids
    FROM sef_outbox
    WHERE status NOT IN ('CANCELLED', 'REJECTED')
    GROUP BY invoice_id
    HAVING COUNT(*) > 1
  LOOP
    msg := msg || format('faktura %s: %s živa reda (id: %s); ', dup.invoice_id, dup.c, dup.ids);
  END LOOP;

  IF msg <> '' THEN
    RAISE EXCEPTION
      'Ne mogu da postavim uq_sef_outbox_live jer duplikati VEĆ postoje: %  Proveri na SEF portalu koji je red merodavan, ostale prevedi u CANCELLED, pa ponovi migraciju.',
      msg;
  END IF;
END $$;

CREATE UNIQUE INDEX "uq_sef_outbox_live"
  ON "sef_outbox" ("invoice_id")
  WHERE "status" NOT IN ('CANCELLED', 'REJECTED');

COMMENT ON INDEX "uq_sef_outbox_live" IS
  'Najvise jedan ziv outbox red po fakturi (zivi = PENDING/SENT/DELIVERED/CANCEL_PENDING). '
  'CANCELLED i REJECTED ne blokiraju, jer je ponovno slanje posle njih normalan tok. '
  'Kod hvata P2002 i vraca 409 — v. SefService.enqueue.';
