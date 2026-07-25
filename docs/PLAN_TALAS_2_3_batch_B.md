# PLAN — Talas 2 + Talas 3, Batch B

> **Autor:** Opus 5 (25.07.2026). Nastavak [PLAN_TALAS_2_3_batch_A.md](PLAN_TALAS_2_3_batch_A.md) §3.
> Isti protokol (fan-out → integracija → smoke → adversarial review → PR → deploy → verify).

## Kriterijum izbora za Batch B

Iz §3 ostatka biram stavke koje: (a) nemaju otvorenu odluku, (b) su S/M/L ali sa jasnim ugovorom,
(c) rade posao koji knjigovođa/komercijala oseti svaki dan. **Van Batch B ostaje** (traži odluku ili
je XL): avansni računi AVR · 3-way match · Payment Run F110 · EBS fuzzy match · dimenzije knjiženja ·
POPDV legacy VBA formule · devizne otvorene stavke · rezervacija zaliha.

## 1. Batch B — 12 stavki kroz 6 agenata

| Agent | Talas | Stavke |
|---|---|---|
| **B1 Carry-over robno** | T2 | **PO → Primka** (prepis narudžbenice u robni ulaz: stavke, količine, cene; anti-duplo preko `copiedFromDocId`) · **Profaktura → Izdatnica** (rezervacija van opsega — samo prepis) |
| **B2 GK dubina** | T2 | **Početno stanje / carry-over naloga** (prenos salda na novu godinu: zatvaranje klase 6/5 → rezultat, otvaranje 1/2/3/4 kao PS nalog) · **Salda po poslovima** (`costCenter` se puni pri ručnom nalogu + filter u kartici konta) |
| **B3 Izvodi/banka** | T2 | **Kontrola prometa i salda banke na formi izvoda** (opening/closing vs Σ stavki, upozorenje na razliku) · **Zaključavanje virmana** (ruta + masovno po datumu + guard na izmenu/export) |
| **B4 PDV most** | T2 | **PDV stavke naloga — dvosmerni bruto↔neto most** (pri ručnom GK nalogu na PDV kontu: unos bruta izvodi osnovicu+PDV i obrnuto) · **KUF „van PDV" tok** (ulazni račun bez prava odbitka → evidencija bez pretporeza) |
| **B5 Soft-delete infra** | T3 | **Generički soft-delete + Undo toast + audit** (`deletedAt/deletedByUserId` na stavkama dokumenata; primeni na robno stavke, GK linije draft naloga, izvod stavke; lista krije obrisano, „Poništi" u 30 s) — jedan obrazac, tri primene |
| **B6 Dunning** | T3 | **Automatske opomene** (nivoi 1/2/3 po dospelosti iz aging-a, tekst po nivou, mail sa PDF pregledom otvorenih stavki, evidencija poslatih opomena da se ne šalje dvaput) |

**Šema (glavna petlja, pre fan-out-a):** `deletedAt/deletedByUserId` na 3 tabele stavki (B5) ·
`DunningNotice` tabela (B6) · `costCenter` provera (B2 — polje verovatno postoji). Sve aditivno.

## 2. Definicije gotovog (smoke)

- **B1**: PO sa 2 stavke → Primka nosi iste stavke/količine; drugi prepis istog PO → 409
- **B2**: PS nalog za 2027 iz salda 2026 — ΣDuguje=ΣPotražuje, klase 6/5 nula posle prenosa;
  costCenter filter u kartici vraća podskup
- **B3**: izvod sa closing ≠ opening+Σ → upozorenje; zaključan virman → izmena/export 409
- **B4**: unos bruta 1200 na 20% → osnovica 1000 + PDV 200 (i obrnuto); KUF van-PDV red bez pretporeza u POPDV
- **B5**: obrisana stavka nestaje iz liste, „Poništi" je vraća, audit red postoji
- **B6**: komitent sa dospelim 45 dana → nivo 2; ponovno slanje istog nivoa istog dana → preskočeno

## 3. Protokol

Nepromenjen (Batch A §4): granice fajlova stroge, registracije/nav radi glavna petlja, migracije aditivne
na dev pre fan-out-a, smoke po §2, adversarial review pre PR-a, deploy uz `post-deploy-verify` 🟢.
