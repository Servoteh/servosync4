# Dizajn i specifikacije — indeks

> Autoritativni dizajn/implementacioni dokumenti za ServoSync 2.0 (i pripremni za 4.0). Redosled važenja:
> [BACKEND_RULES](../BACKEND_RULES.md) + kod → [ROADMAP](../ROADMAP.md) → ovi dokumenti.
> Analiza legacy izvora (kod, UI, uputstva) je u [migration/](../migration/README.md).

## Arhitektura i pravila
| Dokument | Sadržaj |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Lukin strateški draft (maj 2026); mestimično pregažen — odstupanja u [BACKEND_RULES §2](../BACKEND_RULES.md) |
| [MODULI-MASTER-PLAN.md](MODULI-MASTER-PLAN.md) | Master plan svih modula 3.0→4.0 na 2.0 temelju (presečni sloj, domeni, konektori, redosled) |
| [AUTHZ_UNIFIED.md](AUTHZ_UNIFIED.md) | **IZVOR ISTINE za role i autorizaciju** — objedinjeni katalog (1.0+2.0+3.0), RLS-ready blueprint, lowercase konvencija; materijalizovan u `src/common/authz/` |
| [RBAC_RLS_PREDLOG.md](RBAC_RLS_PREDLOG.md) | Predlog RBAC/RLS modela (role, permisije, scope, matrica prava po modulu) — **§2 katalog prevaziđen** AUTHZ_UNIFIED-om; matrica prava i dalje važi |
| [sql/authz_rls_ready.skeleton.sql](sql/authz_rls_ready.skeleton.sql) | Skelet „RLS-ready" migracije (GUC `app.user_id`, `user_roles`, FK-ovi, predikat-funkcije) — primeniti kroz `migrate:dev` kad DB bude gore |
| [QBIGTEHN_UI_REFERENCE.md](QBIGTEHN_UI_REFERENCE.md) | **UI referenca** — 163 ekrana QBigTehn-a (dugmad/polja/layout) po domenu, za 2.0 build |

## Module specifikacije (implementacioni)
| Dokument | Faza | Sadržaj |
|---|---|---|
| [MODULE_SPEC_bigbit_sync.md](MODULE_SPEC_bigbit_sync.md) | 2.0 | BigBit master-data sync (Sprint 1) |
| [MODULE_SPEC_tehnologija.md](MODULE_SPEC_tehnologija.md) | 2.0 | **Tehnologija/TP — pilot modul** (barkod, finish/rework, machine_access) |
| [MODULE_SPEC_radni_nalozi.md](MODULE_SPEC_radni_nalozi.md) | 2.0 | Radni nalozi (state machine saglasnost→lansiranje, 6 tipova stavki) |
| [MODULE_SPEC_pdm.md](MODULE_SPEC_pdm.md) | 2.0 | PDM/crteži/BOM |
| [MODULE_SPEC_nacrti_primopredaje.md](MODULE_SPEC_nacrti_primopredaje.md) | 2.0 | Nacrti i primopredaje |
| [MODULE_SPEC_structures.md](MODULE_SPEC_structures.md) | 2.0 | Proizvodne strukture (radnici/mašine/operacije) |
| [MODULE_SPEC_mrp.md](MODULE_SPEC_mrp.md) | 2.0 | MRP/nabavka (decision engine, BOM eksplozija) |
| [MODULE_SPEC_lokacije.md](MODULE_SPEC_lokacije.md) | 2.0 | Lokacije delova (ledger; §8 = usklađivanje sa živim 1.0 loc modulom) |
| [MODULE_SPEC_sef.md](MODULE_SPEC_sef.md) | 4.0 | **SEF eFaktura** (kod-verifikovan iz izvučenog BigBit VBA) |

## Kako se koriste
- **Novi 2.0 domenski modul:** čitaj `MODULE_SPEC_<domen>` (implementacija) + `QBIGTEHN_UI_REFERENCE` (ekrani) +
  [migration/08](../migration/08-qbigtehn-vba-domain-map.md) (logika) + [migration/11](../migration/11-bb-tehnologija-uputstvo.md) (prioriteti/šta izbaciti).
- **Otvorene odluke** (blokiraju) su u [BACKEND_RULES §11](../BACKEND_RULES.md) i u „Otvorena pitanja" svakog speca.
