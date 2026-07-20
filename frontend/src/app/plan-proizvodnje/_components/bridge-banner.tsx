// Bridge sync banner — UKLONJEN (F5b / odluka M4, PLAN_F5_GASENJE_MOSTA.md §8).
//
// Plan proizvodnje čita native glavnu bazu; nema više sy15 feed lanca ni
// `GET /v1/plan-proizvodnje/bridge-status` rute da bi baner imao šta da pokaže.
// Zdravlje native sloja ide u postojeći monitoring, ne u ekranski baner.
//
// Komponenta `BridgeBanner` (useBridgeStatus + pragovi zastarelosti) i njena
// upotreba u `page.tsx` su uklonjeni; fajl je namerno ostavljen kao trag odluke.
// Nema exporta — nijedan modul ga više ne uvozi.
export {};
