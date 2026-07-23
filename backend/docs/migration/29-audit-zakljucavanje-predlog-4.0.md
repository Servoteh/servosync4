# Audit („ko je uneo/menjao") + zaključavanje — stanje i PREDLOG za 4.0

> **Status:** ANALIZA + PREDLOG (2026-07-18). Nenad traži audit „na još većem nivou" + zaključavanje,
> i poziva na predlog šta uraditi bolje. Zaključak: **2.0 već ima kosti (AuditLog + interceptor +
> identitet) — ovo je NADOGRADNJA, ne greenfield.**

## A) BigBit stanje (šta imamo da nadmašimo)

**Audit = „poslednji potpis" (overwrite), NEMA istorije.** Polja `Potpis Text` + `DatumIVreme` na
zaglavljima; svako potpisivanje prepisuje prethodno. Tri nekonzistentna obrasca:
1. jedan potpis (najčešće) — `T_Robna dokumenta`, `T_Nalozi`, `T_Trebovanja`, `T_Proizvodnja`…
2. unos+ispravka (magacin/KEPU) — `PotpisUnosa`/`PotpisIspravke` + dva vremena
3. unos+odobrenje (samo carina) — `Potpis`/`Odobreno`/`OdobrioPotpis`
- **Stavke uglavnom BEZ audita** (nasleđuju zaglavlje); brisanje je fizičko bez traga (izuzev
  `T_MPStavke_Obrisane` koja pamti samo vreme, ne ko).
- **Identitet slab:** Access workgroup `CurrentUser()` iz deljene `.MDW`, kratke/deljene lozinke,
  „Potpis" je običan tekst bez kriptografije.

**Zaključavanje = bool `Zakljucano` + soft brava (samo VBA na formi).** Nivoi: po slogu
(`ZakOtkDok`), po periodu (`Z_Zakljucaj*ZaPeriod`), auto po starosti (`StartnoZakljucavanje*`, >N dana,
**bez zapisa ko/kada**), po godini/OJ (`BBDefUser.Unlock*`). Role-gate preko grupa (`Zakljucavanje`/
`Otkljucavanje`/`Potpisivanje`/`Admins`). UI: `AllowEdits/Deletions=False` + `C_LockColor`.
**Ograničenje: nije DB-constraint** — ovlašćen korisnik (`ZakOtkDok(...,False)`) ili direktan pristup
skida bravu **bez traga**; otključavanje se NE loguje. `Level`/`NivoBaze` = soft nivo proknjiženosti
(dokumenti ≤ nivoa = read-only sloj), takođe samo VBA.

**7 ograničenja koja 4.0 treba da prevaziđe:** (1) nema field-level istorije, (2) nema „ko obrisao",
(3) slab identitet, (4) audit samo na zaglavlju, (5) imutabilnost „soft" (nema DB-nivoa), (6) tri
nekonzistentna obrasca, (7) auto-lock menja podatke bez zapisa.

## B) 2.0 stanje (kosti postoje)

- ✅ **`AuditLog` tabela (`audit_log`) + globalni `AuditInterceptor`** — jedan red po svakoj mutaciji
  (POST/PUT/PATCH/DELETE), `actorUserId`, `action`, `entityType`, `afterData`. Append-only, indeksiran.
- ✅ **Identitet stiže do write-sloja** — `req.user` = `{userId, workerId}` (JWT), prosleđuje se kao
  `actor` u servise; `createdBy*` se već puni iz JWT-a u kvalitet/cnc/handovers/work-orders.
- ⚠️ **Nezreo:** `beforeData` se **NIKAD ne puni** → nema old→new diff-a; nema read UI; upis
  fire-and-forget (van transakcije, može tiho pasti); `entityType/Id` iz URL-a (grubo).
- ❌ **Nema generičkog `updatedById`** (samo ad-hoc `createdBy`); **nema soft-delete u core-u**
  (samo `sy15`); **zaključavanje ad-hoc po modulu** (handovers `isLocked`+status, RN approval/launch
  tabele, TP `isProcessFinished`, kvalitet status-int) — nema deljenog modela ni `*.lock` permisija;
  `AUTHZ_ENFORCE` u **shadow** modu (permisije deklarisane, ne forsirane).

## C) PREDLOG za 4.0 (7 komponenti)

Cilj: **jedan jedinstven, automatski, DB-podržan sloj** umesto 3 BigBit obrasca i 4 ad-hoc 2.0 obrasca.

### 1. Field-level audit (najveća vrednost — BigBit to nema)
Prisma **client extension** koji na svaki `update/delete` u ISTOJ transakciji učita staro stanje reda
i upiše `audit_log` red sa **`beforeData` + `afterData` → izračunat `changedFields` diff** (koje polje
`old→new`, ko, kad). Popunjava upravo ono što interceptor danas ostavlja prazno. Odgovara na „ko je
stavku sa 5 promenio na 8 i kad" — što BigBit **strukturno ne može**. Dodati **read UI: timeline po
entitetu** (`GET /audit?entityType&entityId`) + permisija `audit.read`.

### 2. Automatski actor-context (CLS) — nema više ručnog prosleđivanja
`AsyncLocalStorage`/`nestjs-cls` middleware puni `{userId, workerId}` po zahtevu; Prisma extension čita
iz CLS-a i **sam stampuje** `updatedById`/`createdById` + audit actor. Uklanja ad-hoc obrazac (danas
svaki servis ručno prosleđuje `actor`) → nemoguće „zaboraviti da upišeš ko".

### 3. Bazne audit-kolone (mixin) na app-tabelama
Jedinstveno: `createdAt`/`createdById`, `updatedAt`/`updatedById` (server-stampovano, ne iz body-ja),
na svim app-owned modelima. Migracija dodaje kolone; extension ih puni. (Sync-cache tabele ostaju kako
jesu — one nose legacy `createdBy` string iz BigBit-a.)

### 4. Soft-delete u core-u + UNDO (Nenad: BigBit nije imao undo na obrisanu stavku!)
`deletedAt`/`deletedById` na app-tabelama + Prisma extension koji pretvara `delete`→`update{deletedAt}`
i default-filtrira obrisane. **„Ko je obrisao" se čuva** (BigBit i 2.0 core to danas gube). Hard-delete
samo uz `*.delete.force` permisiju, i uvek auditovan.
- **UNDO obrisane stavke (izričit zahtev):** posle brisanja stavke → „Poništi" toast (par sekundi) +
  server `restore` endpoint (obriši `deletedAt`). BigBit je brisao stavku nepovratno — 4.0 mora imati
  vraćanje. Važi za SVE dokumente/stavke (UX-standard, kao grid akcije doc 28). Vidi [36 §2](36-4.0-poboljsanja-preko-accessa.md).

### 5. Jedinstven document-lifecycle (umesto 4 ad-hoc lock obrasca)
Deljeni mixin: `status` (`draft`→`posted`→`locked`) + `postedAt/postedById` + `lockedAt/lockedById` +
`lockReason`. Pravila **server-side (guard), ne samo UI**:
- **posted = immutable** kroz normalan UI; ispravka samo **storno-dokumentom** (kao BigBit `MinusKolicine`,
  doc 27) — čuva revizorski trag umesto tihe izmene.
- **period-lock** (mesec/godina) — knjigovođa; auto-lock po starosti = **sistemski akter `system` u
  audit-u** (BigBit to ne beleži).
- **otključavanje UVEK ostavlja audit red** (ko, kad, zašto) — BigBit rupa.
- Odbrana u dubinu: opciono Postgres trigger/constraint da posted red ne može UPDATE bez `unlock` puta
  (DB-nivo, ne samo app) — rešava BigBit „soft brava se skida bez traga".

### 6. Optimistic concurrency (web-specifično, BigBit nije imao)
`version Int` kolona; update proverava verziju → „dvoje menja isti dokument" daje jasan 409, ne tihi
overwrite. (Access single-file ovo nije trebao; web višekorisnički mora.)

### 7. RBAC dovršetak
Dodati `*.lock`/`*.unlock`/`*.post` permisije; prebaciti `AUTHZ_ENFORCE` iz shadow u enforce; aktivirati
`definesApproval`/`definesLaunch` gate (danas TODO/V2).

## D) Zašto je ovo bolje od BigBit-a (sažeto)

| Aspekt | BigBit | 4.0 predlog |
|---|---|---|
| Istorija izmene | samo poslednji potpis | **pun old→new lanac po polju** |
| Ko obrisao | fizičko brisanje, bez traga | **soft-delete + deletedById** |
| Identitet | workgroup string, deljen | JWT, server-stampovan |
| Stavke | uglavnom bez audita | jedinstven audit zaglavlje+stavka |
| Imutabilnost | soft (VBA na formi) | **server-side + opciono DB-constraint** |
| Otključavanje | neaudito | **uvek auditovano (ko/zašto)** |
| Auto-lock | menja bez zapisa | sistemski akter u audit-u |
| Konkurencija | (single-file) | optimistic version |

## E) Procena (nadogradnja, ne greenfield)

| Komponenta | AI-dani | 1-dev dani |
|---|---|---|
| CLS actor-context + Prisma extension (auto-stamp + beforeData capture) | 2–3 | 5–8 |
| Bazne audit-kolone mixin + migracija (app-tabele) | 1–2 | 3–5 |
| Soft-delete u core-u (extension + filter + force-delete gate) | 1–2 | 3–4 |
| Jedinstven document-lifecycle (status/post/lock modul + guard, storno-put) | 2–3 | 5–7 |
| Audit read UI (timeline po entitetu) + permisija | 1–2 | 3–4 |
| Optimistic concurrency (version) | 0.5–1 | 1.5–2 |
| RBAC dovršetak (*.lock/*.post + enforce flip + approval gate) | 1–2 | 3–5 |
| **Ukupno (foundational, radi se JEDNOM pa reuse svuda)** | **~9–15 AI-dana** | **~24–35 dev-dana** |

**Preporuka redosleda:** #2 (CLS) → #1 (field-level audit) → #3 (mixin) → #4 (soft-delete) → #5
(lifecycle) → #6/#7. Prve tri su temelj koji odmah diže SVE module (i postojeće 2.0 i buduće 4.0), pa
ih raditi **pre** finansijskih modula — GL/plaćanja/fakture ionako zahtevaju tvrd audit i lock.

**Ključna poruka:** ovo NIJE modul nego **presečna infrastruktura** — kao carry-over (doc 27) i skriveni
UI (doc 28). Uradi se jednom kroz Prisma extension + deljeni mixin, i svaki dokument u sistemu dobija
pun audit i lock „besplatno". To je upravo ono „na još većem nivou" — BigBit ima potpis, mi imamo
kompletnu, tamper-otporniju istoriju.
