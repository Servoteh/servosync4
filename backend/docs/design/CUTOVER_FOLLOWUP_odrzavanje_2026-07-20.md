# Cutover follow-up: Održavanje (CMMS) — 2026-07-20

> Nastavak posle GO-uz-uslove (`CUTOVER_AUDIT_odrzavanje_2026-07-17.md`, 1.0 repo).
> Modul je ŽIV na 3.0 od 17.07 (cutover `c533b56`). Ovaj dokument zatvara preostale
> uslove iz §3 tog audita. Statusi provereni **uživo na produ** 20.07.

## Rezime stanja

| Stavka (iz GO audita §3–§4) | Status 20.07 | Dokaz |
|---|---|---|
| A. `GET /documents/:id/url` → 422 | ✅ **REŠENO** | živ probe: 2/2 dokumenta sign → 200; mašine/settings/me → 200. S0 storage-URL fix (20.07) pokrio uzrok. |
| B. Živi smoke #48 (pun ciklus) | 🟡 **delom dokazan podacima; scenario spreman** | vidi §2 |
| C. Live-RLS matrica (#45/#46) | ⏸ **čeka odluku** (kreiranje test-profila na produ) | §3 |
| D. Note soft-delete RLS | ✅ odluka: paritet, higijena 42501→403 živa (`bf61cf8`) | nasleđeni 1.0 defekt, 0 redova |
| E. Mobilni `/m/odrzavanje` (APK) ostaje 1.0 | ✅ svesno (zajednička mobilna seoba kasnije) | 3.0 ima pun mobilni paritet iz browsera |
| F. Higijena docs (tracker/spec statusi) | ✅ 1.0 tracker red ažuriran (`a0088f0` na main) + spec §5 banner | §4 |

## 1. Živa verifikacija A — potpisivanje dokumenata (REŠENO)

Probe (admin nalog, `api.servosync2.servoteh.com/api`; login token = TOP-LEVEL `accessToken`):
- `GET /v1/maintenance/documents` → 200, 2 reda; `…/:id/url` → **200 za oba** (nema više 422).
- `GET /v1/maintenance/machines` → 200 (87 mašina); `/me` → 200 (erpAdmin=true, svi gates=true);
  `/settings` → 200 (autoCreateWo major/critical=true, defaultWoPriority=p4_planirano,
  majorWoDueHours=48, criticalWoDueHours=8, notify major/critical=true, kanali=[in_app]).

Zaključak: storage sign radi na svim putanjama posle S0 fiksa. Nema koda za promenu.

## 2. Živi smoke #48 — šta je već dokazano, šta ostaje

### 2.1 Već dokazano ŽIVIM PODACIMA (bez potrebe za novim upisom)
Produkcija na 20.07: **134 WO** (`WO-2026-00134` najnoviji), **16 incidenata**, 6 assignable chief-ova.
Distribucija incidenata potvrđuje **auto-WO trigger kroz 3.0 put**:
- svaki `major`/`critical` incident ima `workOrderId`;
- svaki `minor` ima `workOrderId=null`.
To je tačno ponašanje `maint_incidents_autocreate_work_order` trigera + `maint_settings` pravila
(critical→p1/8h, major→p2/48h, minor→bez WO). `wo_number` kontinuitet (…132→133→134) dokazuje da
counter-trigger radi iz 3.0 upisa. WO↔sredstvo join živ (WO nosi `asset.assetCode`, npr `10.4`, `3.14`).

### 2.2 OSTAJE da se dokaže jednim kontrolisanim ciklusom
Jedini deo koji podaci NE pokazuju (magacin prazan, 0 delova): **deo na WO → skida zalihu atomski**.
Kod je potvrđen (`odrzavanje.service.ts:2544` `createWoPart` — WO-part + `out` kretanje + user_note
u ISTOJ transakciji), ali nikad izvršen uživo jer nema kataloškog dela sa stanjem.

⚠️ **Trag koji smoke OSTAVLJA (ledger je INSERT-only, bez DELETE politike — skriveno pravilo 16):**
- Kretanja zaliha se NE MOGU obrisati — samo kompenzovati `in` kretanjem. Net-zero po stanju,
  ali 2 reda u `maint_part_stock_movements` ostaju trajno.
- Incident troši 1 auto-WO broj (nepovratno) — zato se prijava kvara u smoke-u radi JEDNOM.

### 2.3 Predloženi scenario (net-zero po stanju; radi se JEDNOM, uz komandu)
Redosled (svaki korak = jedan REST poziv, admin nalog, `clientEventId` = svež uuid):
1. **Kreiraj kataloški deo** `POST /parts` (partCode `SMOKE-<ts>`, currentStock=10, unitCost=100).
2. **Prijava kvara** `POST /incidents` (severity=`major`, machineCode=neka `down`/test mašina,
   title `SMOKE #48 <ts>`) → očekivano: auto-WO (p2, due +48h), `workOrderId` popunjen.
3. **Pročitaj WO** `GET /incidents/:id` → uzmi `workOrder.woId`, potvrdi `wo_number`=…135.
4. **Dodela** `PATCH /work-orders/:woId {assignedTo: <chief uuid>, status: 'dodeljen'}`.
5. **Deo na WO** `POST /work-orders/:woId/parts {partId, quantity:2}` → očekivano: `out` kretanje,
   stanje dela 10→8, user_note event. **← ovo je jedini nedokazani deo.**
6. **Rad** `POST /work-orders/:woId/labor {minutes:30}`.
7. **Zatvori** `PATCH /work-orders/:woId {status:'zavrsen', closureComment:'smoke'}`.
8. **Izveštaj** `GET /reports/work-orders?period=30` → potvrdi partsCost/laborMinutes uključuju smoke WO.
9. **Kompenzacija zalihe** `POST /parts/:partId/stock-movements {movementType:'in', quantity:2}` → 8→10.
10. **Deaktiviraj deo** `PATCH /parts/:partId {active:false}` (ne može delete — ledger ga drži).
11. **Notif provera** `GET /notifications?incidentId=:id` → potvrdi 1 enqueue (NE duplo; dispatch ŽIV).

Ostaje trajno: 1 incident (major, resolved), 1 WO (zavrsen), 1 neaktivan deo, 2+ ledger reda.
Sve jasno obeleženo `SMOKE`. Alternativa bez ikakvog traga = sintetički nalog na DEV bazi, ali DEV
nema sy15 podatke (prazna šema) pa ne testira žive trigere — zato je prod smoke jedini pravi dokaz.

**Odluka 20.07: PRESKAČEMO smoke zasad** (auto-WO/counter/join dokazani živim podacima; deo→zaliha
ostaje kod-verifikovan). Izvesti tek na eksplicitan zahtev.

## 3. Live-RLS matrica (C) — čeka odluku
Za dokaz row-scope-a (operator vidi samo `assigned_machine_codes`, chief-bez-ERP-role, magacioner
širi krug) treba upisati 2–3 sintetička `maint_user_profiles` reda na produ (auth.uid()-vezano).
Prethodnih 5 cutovera pušteno bez ove matrice (paritet po konstrukciji — iste 102 RLS politike kroz
`withUserRls`). Predlog: izvesti tek ako se javi konkretna sumnja; inače zabeležiti kao svestан prag.

## 4. Higijena (F) — URAĐENO
- 1.0 tracker (`docs/MIGRACIJA_3.0_PLAYBOOK.md`, red „Održavanje (CMMS)") ažuriran sa zaostalog spec
  statusa 12.07 na **„Cutover 17.07 (F2 P0–P5 pun, GO-uz-uslove; 104 gapa/24 HIGH zatvoreno)"** —
  commit `a0088f0` na 1.0 `main`.
- `MODULE_SPEC_odrzavanje_30.md` §5: dodat banner da su NOT_STARTED statusi zastareli (sve živo);
  autoritet za „šta radi danas" = ovaj follow-up.
