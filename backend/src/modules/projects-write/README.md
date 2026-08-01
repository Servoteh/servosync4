# Modul `projects-write` — zahtevi za ponudu + zatvoren upis u predmete

> **Odluka vlasnika 26.07.2026:** komitenti i predmeti (brojevi predmeta) se **više ne unose u
> ServoSync**. Podaci se čitaju isključivo iz BigBit-a i stižu uvozom. Time je pregažena ranija
> odluka **N3** („dvostruki unos predmeta: prvo 3.0, pa isti broj u BigBit", 22.07.2026).

## Šta je ugašeno

| Ruta | Ranije | Sada |
|---|---|---|
| `POST /api/v1/projects` | kreirala predmet (numeracija `MAX+1`) | **409** `BIGBIT_OWNED_READ_ONLY` + uputstvo |
| `PATCH /api/v1/projects/:id` | menjala predmet | **409** + uputstvo |
| `POST /api/v1/rfqs/:id/create-project` | „Napravi predmet iz zahteva" | **409** + uputstvo |

Obrisani fajlovi (mrtav kod, ne komentarisan): `projects-write.service.ts`,
`project-numbering.service.ts`, `dto/create-project.dto.ts`, `dto/update-project.dto.ts`.
Permisija `projects.write` je uklonjena iz `common/authz/permissions.ts`, `role-permissions.ts`
(role `NABAVKA_VIEW` i `MENADZMENT`) i iz `frontend/src/lib/permissions.ts`.

Poruke i tip greške žive u [`../directory/bigbit-owned.ts`](../directory/bigbit-owned.ts) —
jedini izvor teksta za backend; frontend ekrani nose isti sadržaj svojim rečima.

## Šta ostaje živo

- **CustomerRfq (zahtevi kupaca za ponudu)** — 4.0-native tabela, puni CRUD (`RFQ_READ`/`RFQ_WRITE`).
  Zahtev referiše komitenta i predmet **mekim ref-om** i oba samo čita.
- **Vezivanje predmeta na zahtev** — zamena za ugašeni „Napravi predmet iz zahteva":

  ```
  1. prodavac otvori predmet u BigBit-u
  2. predmet stigne u ServoSync sledećim uvozom
  3. PATCH /api/v1/rfqs/:id  { "projectId": <id iz ServoSync-a> }
  ```

  Servis proverava da predmet **postoji** (404 ako ne) i da nije već vezan za drugi zahtev
  (409 — `uq_customer_rfqs_project` je 1:1). Predmet se nikad ne kreira. `projectId: null` odvezuje.

## Zašto rute nisu obrisane

Obrisana ruta vraća 404 iz kog se ne vidi razlog. Ovako svaki klijent (uključujući stari FE keš i
integracije) dobija 409 sa srpskom porukom koja kaže gde se podatak unosi i kada stiže.
