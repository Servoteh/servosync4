# Modul Nabavka — NACRT (Traka B §B)

> **Status:** skele spremne, **NIJE aktivirano.** Svi fajlovi imaju ekstenziju `*.ts.nacrt` →
> van TypeScript kompilacije (`npm run build` ih ignoriše), da referentna implementacija ne obori
> build dok Prisma modeli nisu u `schema.prisma`. Ne zavisi od GL/konto mapa — **sprint kandidat.**

## Šta je ovde

| Fajl | Uloga |
|---|---|
| `nabavka.controller.ts.nacrt` | REST rute (`/api/v1/nabavka/*`), JWT + PermissionsGuard |
| `nabavka.service.ts.nacrt` | status-mašina, numeracija, auto-mail RFQ, prijem (3-way match) |
| `purchase-numbering.service.ts.nacrt` | `NNNN/god` (zahtev/narudžbenica) + `predmet-N` (upit); advisory lock |
| `nabavka.module.ts.nacrt` | wiring (PrismaModule + MailModule) |
| `dto/create-purchase-request.dto.ts.nacrt` | interface + ručna `validate*()` (kao handovers/kvalitet) |
| `../../prisma/_nacrt-4.0-trakaB-nabavka.prisma` | Prisma modeli (6 tabela) |

## Tok (operativni, Nenad)

```
inženjer:  zahtev (DRAFT) ──submit──> SUBMITTED
nabavka:   SUBMITTED ──approve──> APPROVED
nabavka:   APPROVED ──send-rfq──> upit dobavljaču (auto-mail, sentAt) ──> ponuda
           ──> narudžbenica (cena!) ──> prijem (receivedQuantity default=ordered) ──> faktura (Faza 5)
```

- **Zahtev preuzimaju/klikću** administratori nabavke i prodaje + njihovi šefovi + admin;
  **nabavka posle odobrava** → zato posebna permisija `NABAVKA_APPROVE` na `approve` ruti.
- **Quick-win MVP:** `send-rfq` = napravi upit + auto-mail dobavljaču (PDF/HTML preko Resend).
  Slanje NIKAD ne obara radnju (`MailService` ne baca; bez `RESEND_API_KEY` → DRY-RUN, ostaje `DRAFT`).
- **3-way match:** prijem upisuje `receivedQuantity` (default = `orderedQuantity`, BigBit `IsporucenaKolicina`);
  veza sa robnim ulazom (Faza 3) i ulaznom fakturom (Faza 5) je meki ref, dodaje se kad ti modeli dođu.

## Aktivacija (checklist — kad baza + N3 potvrda budu spremni)

1. **Rebaza** nakon tuđeg `pracenje` commita (schema.prisma bez konflikta).
2. Prepiši modele iz `_nacrt-4.0-trakaB-nabavka.prisma` u `schema.prisma`; upiši `/// Was:` u `docs/schema-rename-map.md`.
3. `npm run migrate:dev` na **dev bazi** (Ubuntu, ne prod) → testiraj.
4. Preimenuj sve `*.ts.nacrt` → `*.ts` (i ovaj README u `README.md`).
5. Dodaj u `src/common/authz/permissions.ts`:
   ```ts
   NABAVKA_READ: "nabavka.read",
   NABAVKA_WRITE: "nabavka.write",
   NABAVKA_APPROVE: "nabavka.approve",
   ```
   + role mapiranje (`role-permissions.ts`) + **mirror** u `frontend/src/lib/permissions.ts`.
6. Registruj `NabavkaModule` u `app.module.ts` imports.
7. Napiši testove (obrazac: `handovers.service.spec.ts` — Prisma-mock).
8. Frontend: otključaj modul „Nabavka" u `navigation.ts` (`prodaja-nabavka` domen, C→A).

## Otvorena pitanja (Traka B §Odluke)

- **N3** (predmeti master vs ogledalo) — preporuka: 2.0 MASTER; write-path čeka potvrdu Negovana.
- **Numeracija tokom dual-run** — 2.0 preuzima na cutover.
- **MRP demand → zahtev za nabavku** — postoji `MrpDemand`, mapirati (mi-tehnički).
