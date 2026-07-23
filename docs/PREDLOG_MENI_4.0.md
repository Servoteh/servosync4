# Predlog navigacije 4.0 — integracija u postojeći meni

> **Datum:** 2026-07-19. Vizuelni pregled varijanti: https://claude.ai/code/artifact/222ed583-ab5e-4752-9dd1-6414376b0e0c
> Polazište: `frontend/src/lib/navigation.ts` (9 domena, pod-grupe, RBAC `requires`, crosslisting — reorg 18.07).
> Nazivi po [doc 38](../backend/docs/migration/38-terminologija-pantheon-sap-predlog.md) (Pantheon/SAP, ne BigBit žargon).

## Šta 4.0 dodaje (~12 modula)

| Modul (ruta) | Šta je | Faza |
|---|---|---|
| Predračuni & računi `/fakturisanje` | izlazni računi dom+izvoz, predračun, avans, revers | F5 |
| Nabavka `/nabavka` | zahtev→upit(auto-mail)→ponuda→narudžbenica→prijem |