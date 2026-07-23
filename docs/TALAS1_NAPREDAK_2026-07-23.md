# Talas 1 (BigBit paritet) — napredak 23.07.2026

> Rad iz gap-audita (`docs/MASTER_PLAN_GRADNJE_4.0_ERP_JEZGRO.md`). Grana `feat/4.0-faza1`,
> **na grani, NIJE deploy-ovano** (po dogovoru: ujutru pregled pa zajedno na prod).
> Sve verifikovano: backend `tsc`+`nest build`+boot 0 grešaka (53 modula), FE `next build`
> 67/67 static export, 4.0 permission matrica čista.

## Urađeno (9 commita, `1a63355`..`9399ca4`)

| # | Stavka | Sloj | Commit |
|---|---|---|---|
| 1 | **Izvodi: ručni unos/korekcija stavke** + per-stavka link na otvorenu stavku | BE+FE | `1a63355` |
| 2-3 | **Virmani: pregled naloga + potpis/plaćanje** (sign/pay/mass-sign) + export guard „samo potpisani"→PAID | BE+FE | `a2a6404` |
| 4-6 | **Nabavka: kreiranje narudžbenice (PO)** + status prelazi (ORDERED/SIGNED/LOCKED) + „Novi zahtev" forma (mrtav hook oživljen) | BE+FE | `30e1443` |
| 9-11 | **GK: ručni unos naloga (temeljnica)** + proknjiži/zaključaj/storno + pretraga kontnog plana + `GL_WRITE` permisija | BE+FE | `ef719be`,`10c7584` |
| 14 | **PDV: seed `vat_account_map`** — koren KIF/KUF/POPDV (20 konta iz BigBit-a); primenjen na dev | BE | `0c66a44` |
| 15 | **Završni: APR eFI XML download** dugme (motor je postojao) | FE | `c035c78` |
| 8 | **Robno: lager lista** (StockLevel + prosečne cene + vrednost) | BE+FE | `c5cff16` |
| 12 | **Fakturisanje: PDF štampa** ruta + „Štampaj" dugme (print servis oživljen kroz kontroler) | BE+FE | `9399ca4` |

**Ključna vrednost:** GK više nije „prazna za korisnika" (auto-nalozi se mogu proknjižiti; ručni nalog
sa balans-kontrolom ΣDug=ΣPot). Virmani i izvodi imaju pun operativni tok. PDV više ne vraća nulu.

## PREOSTALO u Talasu 1 (nije stignuto noćas)

- **#7 Robno: FE forma za kreiranje dokumenta** (UL/IZ/NIV) — L; backend `POST /robno/documents` već prima DTO
- **#13 Fakturisanje: „Novi predračun" forma** — M; `useCreateProforma` hook postoji, fali forma
- **Talas 1B — visok paritet:** prijem-FE wiring (ReceiveOrderDialog mrtav), accept quote (M),
  RFQ lista (M), kompenzacija FE (M), robno negativno stanje guard (S), NIV knjiženje (M)
- **XL (potvrđeno da se koriste — Nenad 23.07):**
  - **Obračun zatezne kamate** (~1140 linija BigBit `Kamate.bas`) — XL
  - **Blagajna** (gotovinski dnevnik: CashJournal/CashEntry, uplatnice/isplatnice, dnevno zaključivanje) — XL
- **#16 Prave ZR formule** iz `ZR_AOP_Modla` — BLOKIRANO (vidi memory `zr-bilans-mdb-pristup`)

## Napomena o testovima

`kadrovska-mutations-permissions` + `kadrovska-permissions` e2e padaju (salary setup u test-bazi) —
**preexisting, pada isto na `origin/main`**, NIJE od 4.0 rada. Sva 4.0 permission matrica prolazi.
Pre merge-a na main razmotriti: ili popraviti kadrovska test-setup, ili merge uz poznati crveni CI
(kao ranije plan-proizvodnje slučaj).
