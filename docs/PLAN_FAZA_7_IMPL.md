
## Dodatak (19.07): prave ZR AOP formule — čeka mdb-tools

`BalanceFormulaDefinition` seed (`prisma/seed/balance-formulas.sql`) je REKONSTRUKCIJA — bruto bilans i osnovne
AOP pozicije rade, ali prave BigBit AOP formule (`ZR_AOP_Modla.Definicija`, `ZR_BS`/`ZR_BU` upiti) su BINARNE
u `.mdb` i traže `mdb-tools` za izvlačenje. Pokušaj instalacije pao: `sudo apt install mdbtools` na Ubuntu traži
lozinku (ne-interaktivni SSH). **Da se izvuku prave formule:** (a) `sudo apt-get install -y mdbtools` na Ubuntu
(Nenad unese lozinku), pa `mdb-export BB_FIT.mdb ZR_AOP_Modla` → seed; ILI (b) knjigovođa da AOP→formula mapu.
Do tada bilans radi na rekonstrukciji (dovoljno za bruto bilans i pregled; NE za regulatorni izlaz).
