# Schema rename map (Serbian → English)

Ova tabela mapira **stare** (srpske) nazive tabela i kolona — onako kako su postojale u izvornoj MSSQL bazi (BigBit) i kako su bile prepisane u prvoj verziji `prisma/schema.prisma` — na **nove** engleske nazive korišćene u trenutnoj `prisma/schema.prisma` + `prisma/migrations/20260104120000_baseline/migration.sql`.

Konvencije:

- **DB tabele**: `snake_case`, plural (`customers`, `work_orders`).
- **DB kolone**: `snake_case` (`first_name`, `customer_id`).
- **Prisma modeli**: `PascalCase`, singular (`Customer`, `WorkOrder`).
- **Prisma polja**: `camelCase` (`firstName`, `customerId`).
- **Constraints**: `pk_<table>`, `fk_<table>_<ref>`, `uq_<table>_<cols>`.
- Prefiksi sa starog modela (`BB`, `CFG_`, `MRP_`, `PDM_`, `R_`, `T_`, `t`, `_Reg`) su **uklonjeni** kako bi imena bila pura-semantička.
- Legacy `legacy/schema-baseline-from-mssql.sql` i `docs/ServoSync-specification.md` namerno **ostaju** na srpskom — oni opisuju izvorni BigBit sistem, ne ovu ciljnu bazu.

> Za živu (trenutnu) sliku šeme uvek pogledati `prisma/schema.prisma`. Ovaj dokument je orijentir za migraciju i grep-friendly lookup za stare nazive.

---

## Pregled tabela

| Stari naziv (MSSQL / Prisma 1) | Novi DB naziv | Novi Prisma model |
|---|---|---|
| `BBDefUser` | `default_users` | `DefaultUser` |
| `BBOdeljenja` | `departments` | `Department` |
| `BBOrgJedinice` | `organizational_units` | `OrganizationalUnit` |
| `BBPravaPristupa` | `access_rights` | `AccessRight` |
| `CFG_Global` | `global_config` | `GlobalConfig` |
| `CFG_Sys` | `system_config` | `SystemConfig` |
| `Cenovnik` | `price_list_entries` | `PriceListEntry` |
| `Info` | `notifications` | `Notification` |
| `Komitenti` | `customers` | `Customer` |
| `KomponentePDMCrteza` | `drawing_components` | `DrawingComponent` |
| `MRP_Potrebe` | `mrp_demands` | `MrpDemand` |
| `MRP_PotrebeStavke` | `mrp_demand_items` | `MrpDemandItem` |
| `MRP_StanjeArtikala` | `mrp_item_stock` | `MrpItemStock` |
| `MRP_StanjeArtikala_TMP` | `mrp_item_stock_tmp` | `MrpItemStockTmp` |
| `MRP_SyncStatus` | `mrp_sync_status` | `MrpSyncStatus` |
| `Magacini` | `warehouses` | `Warehouse` |
| `NacrtPrimopredaje` | `handover_drafts` | `HandoverDraft` |
| `NacrtPrimopredajeStavke` | `handover_draft_items` | `HandoverDraftItem` |
| `Nalepnice` | `labels` | `Label` |
| `PDMCrtezi` | `drawings` | `Drawing` |
| `PDMXMLImportLog` | `drawing_import_log` | `DrawingImportLog` |
| `PDM_PDFCrtezi` | `drawing_pdfs` | `DrawingPdf` |
| `PDM_Planiranje` | `drawing_plans` | `DrawingPlan` |
| `PDM_PlaniranjeStavke` | `drawing_plan_items` | `DrawingPlanItem` |
| `Parametri za rad` | `work_parameters` | `WorkParameter` |
| `Predmeti` | `projects` | `Project` |
| `PredmetiVrstaPosla` | `project_work_types` | `ProjectWorkType` |
| `PrimopredajaCrteza` | `drawing_handovers` | `DrawingHandover` |
| `PrimopredajaPDFCrteza` | `drawing_handover_pdfs` | `DrawingHandoverPdf` |
| `Prodavci` | `salespeople` | `Salesperson` |
| `R_Artikli` | `items` | `Item` |
| `R_Grupa` | `item_groups` | `ItemGroup` |
| `R_Podgrupa` | `item_subgroups` | `ItemSubgroup` |
| `R_Poreklo` | `item_origins` | `ItemOrigin` |
| `R_Tarife` | `tax_rates` | `TaxRate` |
| `R_Vrste dokumenata` | `document_types` | `DocumentType` |
| `Radni fajlovi` | `companies` | `Company` |
| `RobnaDokumentaMirror` | `goods_documents_mirror` | `GoodsDocumentMirror` |
| `RobneStavkeMirror` | `goods_document_items_mirror` | `GoodsDocumentItemMirror` |
| `SklopoviPDMCrteza` | `drawing_assemblies` | `DrawingAssembly` |
| `StatusiCrteza` | `drawing_statuses` | `DrawingStatus` |
| `StatusiNacrtaPrimopredaje` | `handover_draft_statuses` | `HandoverDraftStatus` |
| `StatusiPrimopredaje` | `handover_statuses` | `HandoverStatus` |
| `T_Planer` | `planner_entries` | `PlannerEntry` |
| `T_PlanerGrupeUsera` | `planner_user_groups` | `PlannerUserGroup` |
| `T_Robna dokumenta` | `goods_documents` | `GoodsDocument` |
| `T_Robne stavke` | `goods_document_items` | `GoodsDocumentItem` |
| `UplatniRacuni` | `payment_accounts` | `PaymentAccount` |
| `VrednostiZaKombo` | `combo_values` | `ComboValue` |
| `Vrsta naloga` | `order_types` | `OrderType` |
| `Vrste sifara` | `code_types` | `CodeType` |
| `_Dnevnik` | `journal` | `Journal` |
| `_RegAccess` | `app_access_log` | `AppAccessLog` |
| `_RegApps` | `registered_apps` | `RegisteredApp` |
| `_RegAppsFiles` | `registered_app_files` | `RegisteredAppFile` |
| `_RegUsers` | `registered_users` | `RegisteredUser` |
| `_RegUsersApps` | `registered_user_apps` | `RegisteredUserApp` |
| `_Rev` | `app_revisions` | `AppRevision` |
| `tLansiranRN` | `work_order_launches` | `WorkOrderLaunch` |
| `tLokacijeDelova` | `part_locations` | `PartLocation` |
| `tOperacije` | `operations` | `Operation` |
| `tOperacijeFix` | `operations_fix` | `OperationFix` |
| `tPDM` | `work_order_machined_parts` | `WorkOrderMachinedPart` |
| `tPLP` | `work_order_blanks` | `WorkOrderBlank` |
| `tPND` | `work_order_nonstandard_parts` | `WorkOrderNonstandardPart` |
| `tPozicije` | `positions` | `Position` |
| `tPristupMasini` | `machine_access` | `MachineAccess` |
| `tRN` | `work_orders` | `WorkOrder` |
| `tRNKomponente` | `work_order_components` | `WorkOrderComponent` |
| `tRNNDKomponente` | `work_order_item_components` | `WorkOrderItemComponent` |
| `tR_Grupa` | `production_item_groups` | `ProductionItemGroup` |
| `tRadneJedinice` | `work_units` | `WorkUnit` |
| `tRadnici` | `workers` | `Worker` |
| `tSaglasanRN` | `work_order_approvals` | `WorkOrderApproval` |
| `tStavkeRN` | `work_order_operations` | `WorkOrderOperation` |
| `tStavkeRNSlike` | `work_order_operation_images` | `WorkOrderOperationImage` |
| `tTehPostupak` | `tech_processes` | `TechProcess` |
| `tTehPostupakBackup` | `tech_processes_backup` | `TechProcessBackup` |
| `tTehPostupakDokumentacija` | `tech_process_documents` | `TechProcessDocument` |
| `tVrsteKvalitetaDelova` | `part_quality_types` | `PartQualityType` |
| `tVrsteRadnika` | `worker_types` | `WorkerType` |
| `tmp_T_KontroleNaFormi` | `tmp_form_controls` | `TmpFormControl` |

---

## Domenski rečnik (srpski → engleski)

Mali rečnik koji je primenjen *konzistentno* u svim tabelama. Korisno za grep prilikom ServoSync sync mapiranja BigBit → ova baza.

| Srpski | Engleski |
|---|---|
| Sifra (PK) | `id` |
| Sifra prodavca / Sifra komitenta / Sifra artikla | `salesperson_id` / `customer_id` / `item_id` |
| SifraRadnika | `worker_id` |
| ID + ime entiteta (npr. IDPredmet, IDDok) | `<entity>_id` (npr. `project_id`, `document_id`) |
| Naziv / NazivDela | `name` / `part_name` |
| Opis / OpisRada | `description` / `work_description` |
| Datum, DatumIVreme, DIVUnos, DIVUnosa | `*_at` (`created_at`, `entered_at`, ...) |
| DIVIspravke, DIVIzmena, PoslednjaIzmena | `updated_at` |
| PrviUnos | `created_at` |
| Korisnik / KorisnikUnosa | `username` / `created_by` |
| Vrsta | `type` |
| Tip | `type` |
| Vrednost | `value` |
| Komitent / Komitenti | `customer` / `customers` |
| Predmet / Predmeti | `project` / `projects` |
| Radnik / Radnici | `worker` / `workers` |
| Prodavac / Prodavci | `salesperson` / `salespeople` |
| Artikl / Artikli | `item` / `items` |
| Magacin / Magacini | `warehouse` / `warehouses` |
| Cenovnik / Cena | `price_list_entry` / `price` |
| Tarifa | `tax_rate` |
| Grupa / Podgrupa | `group` / `subgroup` |
| Poreklo | `origin` |
| Dokument / Vrsta dokumenta | `document` / `document_type` |
| Stavka / Stavke | `item` (line item) |
| Crtez / Crtezi | `drawing` / `drawings` |
| BrojCrteza | `drawing_number` |
| Revizija | `revision` |
| Operacija / Operacije | `operation` / `operations` |
| RJgrupaRC | `work_center_code` |
| RadnaJedinica / RadneJedinice | `work_unit` / `work_units` |
| Pozicija / Pozicije | `position` / `positions` |
| Lokacija / LokacijeDelova | `location` / `part_locations` |
| Komponenta / Komponente | `component` / `components` |
| Sklop / Sklopovi | `assembly` / `drawing_assemblies` |
| Plan / Planiranje | `plan` / `drawing_plans` |
| TehPostupak | `tech_process` |
| Lansiranje / Lansiran | `launch` / `is_launched` |
| Saglasan / Saglasnost | `is_approved` / `approval` |
| Zakljucano | `is_locked` |
| Aktivan | `active` |
| Napomena / Komentar / Memo | `note` / `comment` / `memo` |
| Status | `status` |
| Firma | `company` |
| Banka | `bank` |
| ZiroRacun / Bank Account | `bank_account` |
| UplatniRacun | `account_number` (na `payment_accounts`) |
| Postanski broj | `postal_code` |
| Adresa / Mesto / Drzava | `address` / `city` / `country` |
| Telefon / Mobilni / Fax / Email / Web | `phone` / `mobile` / `fax` / `email` / `web_address` |
| PIB | `tax_id` |
| MaticniBroj | `registration_number` |
| Komada / Kolicina | `piece_count` / `quantity` |
| Jedinica mere | `unit` |
| Pakovanje | `packaging` |
| Cena / CenaSaPDV / CenaBezPDV | `price` / `price_with_vat` / `price_without_vat` |
| PDV / Tarifa | `vat` / `tax_rate` |
| Carina / Spedicija / Prevoz | `customs` / `forwarding` / `transport` |
| Akciza | `excise` |
| Kasa | `cash_register` / `pos_*` |
| VP (Veleprodaja) | `wholesale` |
| MP (Maloprodaja) | `retail` |
| Devizna / Valuta / Kurs | `fx_*` / `currency` / `exchange_rate` |
| Vozac | `driver` |
| Ruta | `route` |
| Forma / Kontrola | `form` / `control` |
| Korisnik (login) / UserName / Username | `username` |
| Potpis / PotpisSlika | `signature` / `signature_image` |
| BrLk (broj lične karte) | `id_number` |
| Nalog / Vrsta naloga | `order` / `order_type` |
| RN / IDRN (Radni Nalog) | `work_order` / `work_order_id` |
| ND (NestandardniDelovi) | `nonstandard_parts` |
| PDM (Predmer Delova Mašinske obrade — work order context) | `machined_parts` |
| PLP (Predmer Lima i Polufabrikata — work order context) | `blanks` |
| PND (Predmer Nestandardnih Delova — work order context) | `nonstandard_parts` |

> **Napomena o domenu PDM:** u kontekstu `PDMCrtezi` / `KomponentePDMCrteza` / `SklopoviPDMCrteza`, "PDM" se tretira kao centralni registar crteža (Product Data Management) — zato je preveden u **`drawings`** familiju. U kontekstu `tPDM` / `tPLP` / `tPND` (deo radnog naloga) odnosi se na konkretne predmere delova/limova/nestandardnih delova **unutar radnog naloga** — zato je preveden u **`work_order_machined_parts`** / **`work_order_blanks`** / **`work_order_nonstandard_parts`**.

---

## Detaljno: kolona po kolona

Za svaku tabelu navedene su kolone u istom redosledu kao u staroj `schema.prisma`.

### `BBDefUser` → `default_users`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `UserName` | `username` | `username` |
| `DefaultGodina` | `default_year` | `defaultYear` |
| `DefaultOJ` | `default_org_unit_id` | `defaultOrgUnitId` |
| `DefaultOD` | `default_department_id` | `defaultDepartmentId` |
| `UnlockGodina` | `unlock_year` | `unlockYear` |
| `UnlockOJ` | `unlock_org_unit` | `unlockOrgUnit` |
| `UnlockOD` | `unlock_department` | `unlockDepartment` |
| `Level` | `level` | `level` |
| `MaxLevel` | `max_level` | `maxLevel` |

### `BBOdeljenja` → `departments`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `OD` | `id` | `id` |
| `OznakaOD` | `code` | `code` |
| `OpisOD` | `description` | `description` |

### `BBOrgJedinice` → `organizational_units`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `OJ` | `id` | `id` |
| `OznakaOJ` | `code` | `code` |
| `OpisOJ` | `description` | `description` |

### `BBPravaPristupa` → `access_rights`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `ID` | `id` | `id` |
| `ImeUsera` | `username` | `username` |
| `ImeForme` | `form_name` | `formName` |
| `ImeKontrole` | `control_name` | `controlName` |
| `Visible` | `visible` | `visible` |
| `Locked` | `locked` | `locked` |
| `Enabled` | `enabled` | `enabled` |
| `Vrednost` | `value` | `value` |
| `RecordSource` | `record_source` | `recordSource` |
| `Filter` | `filter` | `filter` |

### `CFG_Global` → `global_config`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDFirma` | `company_id` | `companyId` |
| `Parametar` | `parameter` | `parameter` |
| `Vrednost` | `value` | `value` |
| `Tip` | `type` | `type` |
| `Opis` | `description` | `description` |

### `CFG_Sys` → `system_config`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `Parametar` | `parameter` | `parameter` |
| `Vrednost` | `value` | `value` |
| `Tip` | `type` | `type` |
| `Opis` | `description` | `description` |
| `DIVUnos` | `created_at` | `createdAt` |

### `Cenovnik` → `price_list_entries`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `ID` | `id` | `id` |
| `Sifra artikla` | `item_id` | `itemId` |
| `Vrsta dokumenta` | `document_type_code` | `documentTypeId` |
| `Cena` | `price` | `price` |
| `Tarifa` | `tax_rate_code` | `taxRateCode` |
| `CenaBezPDV` | `price_without_vat` | `priceWithoutVat` |
| `Taksa` | `fee` | `fee` |
| `Prn` | `print` | `print` |
| `CenaSaPDV` | `price_with_vat` | `priceWithVat` |
| `CheckCenaSaPDV` | `check_price_with_vat` | `checkPriceWithVat` |
| `ZakCen` | `is_locked` | `isLocked` |

### `Info` → `notifications`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `ID` | `id` | `id` |
| `DatumIVremeSlanja` | `sent_at` | `sentAt` |
| `KoJePoslao` | `sent_by` | `sentBy` |
| `Prijem` | `received` | `received` |
| `DatumIVremePrijema` | `received_at` | `receivedAt` |
| `KoJePrimio` | `received_by` | `receivedBy` |

### `Komitenti` → `customers`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `Sifra` | `id` | `id` |
| `Naziv` | `name` | `name` |
| `Poslovnica` | `branch` | `branch` |
| `Mesto` | `city` | `city` |
| `Adresa` | `address` | `address` |
| `Postanski broj` | `postal_code` | `postalCode` |
| `Ziro racun_1` | `bank_account_1` | `bankAccount1` |
| `Ziro racun_2` | `bank_account_2` | `bankAccount2` |
| `Ziro racun_3` | `bank_account_3` | `bankAccount3` |
| `Telefon` | `phone` | `phone` |
| `Fax` | `fax` | `fax` |
| `Kontakt` | `contact` | `contact` |
| `Napomena` | `note` | `note` |
| `Drzava` | `country` | `country` |
| `Region` | `region` | `region` |
| `Vrsta sifre` | `code_type_code` | `codeTypeCode` |
| `Email` | `email` | `email` |
| `Mobilni` | `mobile` | `mobile` |
| `Datum rodjenja` | `birth_date` | `birthDate` |
| `Web adresa` | `web_address` | `webAddress` |
| `Sifra prodavca` | `salesperson_id` | `salespersonId` |
| `RabatKomitenta` | `customer_discount` | `customerDiscount` |
| `ZastKodKupca` | `buyer_protection_code` | `buyerProtectionCode` |
| `PIB` | `tax_id` | `taxId` |
| `PDVStatus` | `vat_status` | `vatStatus` |
| `MSifra` | `external_code` | `externalCode` |
| `Odlozeno` | `payment_term_days` | `paymentTermDays` |
| `IDRuta` | `route_id` | `routeId` |
| `IDVozac` | `driver_id` | `driverId` |
| `IDUplatniRacun` | `payment_account_id` | `paymentAccountId` |
| `FakturisanjePoMestimaIsporuke` | `invoice_per_delivery_address` | `invoicePerDeliveryAddress` |
| `Cenovnik` | `price_list_code` | `priceListCode` |
| `PrviUnos` | `created_at` | `createdAt` |
| `PoslednjaIzmena` | `updated_at` | `updatedAt` |
| `PrviUnosUser` | `created_by` | `createdBy` |
| `PoslednjaIzmenaUser` | `updated_by` | `updatedBy` |
| `ProcenatProvizije` | `commission_percent` | `commissionPercent` |
| `FiktRabatKomitenta` | `fictitious_discount` | `fictitiousDiscount` |
| `KomitentiNacinPlacanja` | `payment_method` | `paymentMethod` |
| `PotpisKom` | `signature` | `signature` |
| `SkraceniNaziv` | `short_name` | `shortName` |
| `DatumIVremeKom` | `record_created_at` | `recordCreatedAt` |
| `ProveraDuga` | `check_debt` | `checkDebt` |
| `KreditLimit` | `credit_limit` | `creditLimit` |
| `NeProveravajPIB` | `skip_tax_id_validation` | `skipTaxIdValidation` |
| `IDPantheon` | `pantheon_id` | `pantheonId` |
| `NewsLetter` | `newsletter` | `newsletter` |
| `PostaNaDruguAdresu` | `mail_to_different_address` | `mailToDifferentAddress` |
| `GLN` | `gln` | `gln` |
| `KLRucProc` | `manual_markup_percent` | `manualMarkupPercent` |
| `NapomenaZaSalda` | `balance_note` | `balanceNote` |
| `NePrikazatiUPregledu` | `hide_in_overview` | `hideInOverview` |
| `JBKJS` | `public_sector_id` | `publicSectorId` |
| `MaticniBroj` | `registration_number` | `registrationNumber` |
| `ER_XMLSaPopustomPoArtiklu` | `einvoice_xml_per_item_discount` | `einvoiceXmlPerItemDiscount` |
| `CRF` | `central_invoice_registry` | `centralInvoiceRegistry` |

### `KomponentePDMCrteza` → `drawing_components`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDKomponenteCrteza` | `id` | `id` |
| `ZaIDCrtez` | `parent_drawing_id` | `parentDrawingId` |
| `TrebaIDCrtez` | `child_drawing_id` | `childDrawingId` |
| `PotrebnoKomada` | `required_quantity` | `requiredQuantity` |

### `MRP_Potrebe` → `mrp_demands`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDPotreba` | `id` | `id` |
| `IDPredmet` | `project_id` | `projectId` |
| `IDCrtezRoot` | `root_drawing_id` | `rootDrawingId` |
| `SifraRadnika` | `worker_id` | `workerId` |
| `Izvor` | `source` | `source` |
| `TipEksplozije` | `explosion_type` | `explosionType` |
| `Status` | `status` | `status` |
| `DatumPotrebe` | `demand_date` | `demandDate` |
| `Napomena` | `note` | `note` |
| `DIVUnosa` | `created_at` | `createdAt` |
| `DIVUnosaKorisnik` | `created_by` | `createdBy` |
| `DIVIzmena` | `updated_at` | `updatedAt` |
| `DIVIzmenaKorisnik` | `updated_by` | `updatedBy` |
| `PlaniranaKolicina` | `planned_quantity` | `plannedQuantity` |
| `IDPlan` | `plan_id` | `planId` |

### `MRP_PotrebeStavke` → `mrp_demand_items`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDPotrebaStavka` | `id` | `id` |
| `IDPotreba` | `demand_id` | `demandId` |
| `IDCrtezIzvora` | `source_drawing_id` | `sourceDrawingId` |
| `IDCrtezNabavke` | `procurement_drawing_id` | `procurementDrawingId` |
| `SifraArtikla` | `item_id` | `itemId` |
| `KataloskiBrojStavka` | `item_catalog_number` | `itemCatalogNumber` |
| `NazivArtiklaStavka` | `item_name` | `itemName` |
| `JedinicaMereStavka` | `item_unit` | `itemUnit` |
| `IzvorStavke` | `item_source` | `itemSource` |
| `KolicinaPotrebna` | `required_quantity` | `requiredQuantity` |
| `DatumPotrebe` | `demand_date` | `demandDate` |
| `VremeIsporukeDana` | `lead_time_days` | `leadTimeDays` |
| `DatumNabavke` | `procurement_date` | `procurementDate` |
| `Napomena` | `note` | `note` |
| `DIVUnosa` | `created_at` | `createdAt` |
| `DIVUnosaKorisnik` | `created_by` | `createdBy` |
| `DIVIzmena` | `updated_at` | `updatedAt` |
| `DIVIzmenaKorisnik` | `updated_by` | `updatedBy` |
| `DobavljacID` | `supplier_id` | `supplierId` |
| `StatusStavke` | `item_status` | `itemStatus` |
| `KolicinaRezervisano` | `reserved_quantity` | `reservedQuantity` |
| `KolicinaZaNabavku` | `to_procure_quantity` | `toProcureQuantity` |

### `MRP_StanjeArtikala` / `MRP_StanjeArtikala_TMP` → `mrp_item_stock` / `mrp_item_stock_tmp`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `SifraArtikla` | `item_id` | `itemId` |
| `Zalihe` | `in_stock` | `inStock` |
| `Rezervisane` | `reserved` | `reserved` |
| `Naziv` | `name` | `name` |
| `KataloskiBroj` | `catalog_number` | `catalogNumber` |
| `JedinicaMere` | `unit` | `unit` |
| `PoslednjaIzmena` | `updated_at` | `updatedAt` |

### `MRP_SyncStatus` → `mrp_sync_status`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `SyncKey` | `sync_key` | `syncKey` |
| `PoslednjiSync` | `last_synced_at` | `lastSyncedAt` |
| `PoslednjiSyncKorisnik` | `last_synced_by` | `lastSyncedBy` |
| `Napomena` | `note` | `note` |

### `Magacini` → `warehouses`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDFirma` | `company_id` | `companyId` |
| `IDMagacin` | `id` | `id` |
| `Magacin` | `name` | `name` |
| `UlicaIBroj` | `street` | `street` |
| `Mesto` | `city` | `city` |
| `ProsecneCene` | `average_prices` | `averagePrices` |
| `VrstaMag` | `warehouse_type` | `warehouseType` |
| `KontoMag` | `account` | `account` |
| `ImeMagacionera` | `manager_name` | `managerName` |
| `BrLkMagacionera` | `manager_id_number` | `managerIdNumber` |
| `PotpisSlika` | `signature_image_path` | `signatureImagePath` |

### `NacrtPrimopredaje` → `handover_drafts`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDNacrtPrim` | `id` | `id` |
| `IDProjektant` | `designer_id` | `designerId` |
| `DatumNacrta` | `draft_date` | `draftDate` |
| `IDPredmet` | `project_id` | `projectId` |
| `BrojKomada` | `piece_count` | `pieceCount` |
| `IDStatusNacrtaPrimopredaje` | `status_id` | `statusId` |
| `Napomena` | `note` | `note` |
| `Potpis` | `signature` | `signature` |
| `PrviUnos` | `created_at` | `createdAt` |
| `PoslednjaIzmena` | `updated_at` | `updatedAt` |
| `BrojNacrta` | `draft_number` | `draftNumber` |
| `Zakljucano` | `is_locked` | `isLocked` |
| `TipNacrta` | `draft_type` | `draftType` |
| `IDGlavniCrtez` | `main_drawing_id` | `mainDrawingId` |

### `NacrtPrimopredajeStavke` → `handover_draft_items`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDNacrtStavka` | `id` | `id` |
| `IDNacrtPrim` | `draft_id` | `draftId` |
| `IDCrtez` | `drawing_id` | `drawingId` |
| `Napomena` | `note` | `note` |
| `Potpis` | `signature` | `signature` |
| `PrviUnos` | `created_at` | `createdAt` |
| `PoslednjaIzmena` | `updated_at` | `updatedAt` |
| `KolicinaZaIzradu` | `quantity_to_produce` | `quantityToProduce` |
| `IDGlavniCrtez` | `main_drawing_id` | `mainDrawingId` |
| `IsGlavni` | `is_main` | `isMain` |
| `PredProveraDuplikat` | `pre_check_duplicate` | `preCheckDuplicate` |
| `PredProveraIDNacrtPrim` | `pre_check_draft_id` | `preCheckDraftId` |
| `PredProveraIDRN` | `pre_check_work_order_id` | `preCheckWorkOrderId` |
| `IskljuciPrimopredaju` | `exclude_from_handover` | `excludeFromHandover` |
| `OdlukaAkcija` | `decision_action` | `decisionAction` |
| `DIVOdluke` | `decision_date_time` | `decisionDateTime` |
| `KolicinaDefinisanaUCrtezu` | `quantity_defined_in_drawing` | `quantityDefinedInDrawing` |

### `Nalepnice` → `labels`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `ID` | `id` | `id` |
| `IDRN` | `work_order_id` | `workOrderId` |
| `IDPostupka` | `tech_process_id` | `techProcessId` |
| `IdentBroj` | `ident_number` | `identNumber` |
| `BarKod` | `bar_code` | `barCode` |
| `NazivPredmeta` | `project_name` | `projectName` |
| `Komitent` | `customer` | `customer` |
| `NazivDela` | `part_name` | `partName` |
| `BrojCrteza` | `drawing_number` | `drawingNumber` |
| `Materijal` | `material` | `material` |
| `DatumUnosa` | `entered_at` | `enteredAt` |
| `Kolicina` | `quantity` | `quantity` |
| `UkupnaKolicina` | `total_quantity` | `totalQuantity` |
| `PRN` | `print` | `print` |

### `PDMCrtezi` → `drawings`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDCrtez` | `id` | `id` |
| `pdmWeID` | `external_id` | `externalId` |
| `TransactionDate` | `transaction_date` | `transactionDate` |
| `DesignDate` | `design_date` | `designDate` |
| `DesignBy` | `designed_by` | `designedBy` |
| `ApprovedDate` | `approved_date` | `approvedDate` |
| `ApprovedBy` | `approved_by` | `approvedBy` |
| `BrojCrteza` | `drawing_number` | `drawingNumber` |
| `Revizija` | `revision` | `revision` |
| `Kolicina` | `quantity` | `quantity` |
| `KataloskiBroj` | `catalog_number` | `catalogNumber` |
| `Naziv` | `name` | `name` |
| `Materijal` | `material` | `material` |
| `RN` | `work_order_ref` | `workOrderRef` |
| `Dimenzije` | `dimensions` | `dimensions` |
| `Oznaka` | `marking` | `marking` |
| `Tezina` | `weight` | `weight` |
| `Naziv fajla` | `file_name` | `fileName` |
| `PDMStatusCrteza` | `pdm_status` | `pdmStatus` |
| `Comment` | `comment` | `comment` |
| `WhereUsed` | `where_used` | `whereUsed` |
| `Naziv_projekta` | `project_name` | `projectName` |
| `DIVUnosa` | `created_at` | `createdAt` |
| `Potpis` | `signature` | `signature` |
| `IDStatusCrteza` | `status_id` | `statusId` |
| `Nabavka` | `is_procurement` | `isProcurement` |

### `PDMXMLImportLog` → `drawing_import_log`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDLog` | `id` | `id` |
| `NazivFajla` | `file_name` | `fileName` |
| `PutanjaFajla` | `file_path` | `filePath` |
| `ImportTimestamp` | `imported_at` | `importedAt` |
| `Uspesno` | `success` | `success` |
| `StatusPoruka` | `status_message` | `statusMessage` |
| `Kriticno` | `is_critical` | `isCritical` |

### `PDM_PDFCrtezi` → `drawing_pdfs`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `BrojCrteza` | `drawing_number` | `drawingNumber` |
| `Revizija` | `revision` | `revision` |
| `NazivFajla` | `file_name` | `fileName` |
| `DatumUnosa` | `uploaded_at` | `uploadedAt` |
| `VelicinaKB` | `size_kb` | `sizeKb` |
| `KorisnikUnosa` | `uploaded_by` | `uploadedBy` |
| `PDFBinary` | `pdf_binary` | `pdfBinary` |

### `PDM_Planiranje` → `drawing_plans`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDPlan` | `id` | `id` |
| `IDPredmet` | `project_id` | `projectId` |
| `IDCrtezSklopa` | `assembly_drawing_id` | `assemblyDrawingId` |
| `KolicinaZaIzradu` | `quantity_to_produce` | `quantityToProduce` |
| `StatusPlaniranja` | `planning_status` | `planningStatus` |
| `DatumPlaniranja` | `planning_date` | `planningDate` |
| `SifraRadnikaPlaniranja` | `planning_worker_id` | `planningWorkerId` |
| `Napomena` | `note` | `note` |
| `Potpis` | `signature` | `signature` |
| `PrviUnos` | `created_at` | `createdAt` |
| `PoslednjaIzmena` | `updated_at` | `updatedAt` |
| `Zakljucano` | `is_locked` | `isLocked` |
| `BrojPlana` | `plan_number` | `planNumber` |
| `BrojCrtezaPlana` | `plan_drawing_number` | `planDrawingNumber` |
| `RevizijaPlana` | `plan_revision` | `planRevision` |

### `PDM_PlaniranjeStavke` → `drawing_plan_items`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDPlanStavka` | `id` | `id` |
| `IDPlan` | `plan_id` | `planId` |
| `IDCrtezNabavke` | `procurement_drawing_id` | `procurementDrawingId` |
| `SifraArtikla` | `item_id` | `itemId` |
| `KolicinaPoSklopu` | `quantity_per_assembly` | `quantityPerAssembly` |
| `PotrebnoUkupno` | `total_required` | `totalRequired` |
| `PredProveraIDPlan` | `prev_check_plan_id` | `prevCheckPlanId` |
| `OdlukaAkcija` | `decision_action` | `decisionAction` |
| `RucnaKolicina` | `manual_quantity` | `manualQuantity` |
| `Rezervisano` | `reserved` | `reserved` |
| `ZaNabavku` | `to_procure` | `toProcure` |
| `Zalihe` | `in_stock` | `inStock` |
| `NazivArtiklaStavke` | `item_name` | `itemName` |
| `KataloskiBrojStavke` | `item_catalog_number` | `itemCatalogNumber` |
| `JMStavke` | `item_unit` | `itemUnit` |
| `JeRucnaStavka` | `is_manual_item` | `isManualItem` |
| `IskljuciNabavku` | `exclude_from_procurement` | `excludeFromProcurement` |

### `Parametri za rad` → `work_parameters`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `Korisnik` | `username` | `username` |
| `VrstaDokumenta` | `document_type` | `documentType` |
| `Telefon` | `phone` | `phone` |
| `Poslednji broj fakture` | `last_invoice_number` | `lastInvoiceNumber` |
| `Poslednji broj profakture` | `last_proforma_number` | `lastProformaNumber` |
| `Faktura kroz` | `invoice_through` | `invoiceThrough` |
| `Profaktura kroz` | `proforma_through` | `proformaThrough` |
| `Faktura prefix` | `invoice_prefix` | `invoicePrefix` |
| `Profaktura prefix` | `proforma_prefix` | `proformaPrefix` |

### `Predmeti` → `projects`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDPredmet` | `id` | `id` |
| `BrojPredmeta` | `project_number` | `projectNumber` |
| `Opis` | `description` | `description` |
| `DatumOtvaranja` | `opened_at` | `openedAt` |
| `IDProdavac` | `salesperson_id` | `salespersonId` |
| `IDKomitent` | `customer_id` | `customerId` |
| `NextAction` | `next_action` | `nextAction` |
| `DatumZakljucenja` | `closed_at` | `closedAt` |
| `Memo` | `memo` | `memo` |
| `Status` | `status` | `status` |
| `NasaRef` | `our_ref` | `ourRef` |
| `NasKontakt1` | `our_contact_1` | `ourContact1` |
| `NasKontakt2` | `our_contact_2` | `ourContact2` |
| `NasTel1` | `our_phone_1` | `ourPhone1` |
| `NasTel2` | `our_phone_2` | `ourPhone2` |
| `VasaRef` | `their_ref` | `theirRef` |
| `VasKontakt1` | `their_contact_1` | `theirContact1` |
| `VasKontakt2` | `their_contact_2` | `theirContact2` |
| `VasTel1` | `their_phone_1` | `theirPhone1` |
| `VasTel2` | `their_phone_2` | `theirPhone2` |
| `NabavnaVrednost` | `procurement_value` | `procurementValue` |
| `Carina` | `customs` | `customs` |
| `Spedicija` | `forwarding` | `forwarding` |
| `Prevoz` | `transport` | `transport` |
| `Ostalo` | `other` | `other` |
| `InoDobavljac` | `foreign_supplier_id` | `foreignSupplierId` |
| `RJ` | `work_unit_code` | `workUnitCode` |
| `devvaluta` | `currency` | `currency` |
| `kurs` | `exchange_rate` | `exchangeRate` |
| `IDVrstaPosla` | `work_type_id` | `workTypeId` |
| `NazivPredmeta` | `project_name` | `projectName` |
| `RokZavrsetka` | `deadline` | `deadline` |
| `Potpis` | `signature` | `signature` |
| `DatumIVreme` | `created_at` | `createdAt` |
| `BrojUgovora` | `contract_number` | `contractNumber` |
| `DatumUgovora` | `contract_date` | `contractDate` |
| `BrojNarudzbenice` | `order_number` | `orderNumber` |
| `DatumNarudzbenice` | `order_date` | `orderDate` |

### `PrimopredajaCrteza` → `drawing_handovers`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDPrimopredaje` | `id` | `id` |
| `IDCrtez` | `drawing_id` | `drawingId` |
| `DatumPredaje` | `handover_date` | `handoverDate` |
| `IDRadnikPredaje` | `handover_worker_id` | `handoverWorkerId` |
| `IDStatusPrimopredaje` | `status_id` | `statusId` |
| `DatumPromeneStatusa` | `status_changed_at` | `statusChangedAt` |
| `IDRadnikPromeneStatusa` | `status_changed_by_id` | `statusChangedById` |
| `KomentarPromeneStatusa` | `status_change_comment` | `statusChangeComment` |
| `DatumLansiranja` | `launched_at` | `launchedAt` |
| `IDRadnikLansiranja` | `launched_by_id` | `launchedById` |
| `Napomena` | `note` | `note` |
| `Potpis` | `signature` | `signature` |
| `PrviUnos` | `created_at` | `createdAt` |
| `PoslednjaIzmena` | `updated_at` | `updatedAt` |
| `Zakljucano` | `is_locked` | `isLocked` |
| — *(nema legacy izvora)* | `technologist_id` | `technologistId` |

> **App-only kolona 2.0** (migracija `20260710090000_technologist_and_status_seeds`): `technologist_id`
> = tehnolog koga šef tehnologije dodeljuje pri odobravanju primopredaje (piše TP). Legacy
> `PrimopredajaCrteza` je prazna i tabela na cutover-u prelazi u ServoSync vlasništvo, pa je
> odstupanje od pravila „sync tabele su cache" svesno i dokumentovano. `0` = nije dodeljen.

### `Prodavci` → `salespeople`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `Sifra prodavca` | `id` | `id` |
| `Prodavac` | `name` | `name` |
| `Region` | `region` | `region` |
| `ProcenatZaObracun` | `commission_percent` | `commissionPercent` |
| `DeljivoUGrupi` | `split_in_team` | `splitInTeam` |
| `ImeProdavca` | `first_name` | `firstName` |
| `BrLkProdavca` | `id_number` | `idNumber` |
| `LogAcc` | `login_account` | `loginAccount` |
| `Password` | `password` | `password` |
| `Aktivan` | `active` | `active` |
| `NefiskalniRN` | `non_fiscal_work_order` | `nonFiscalWorkOrder` |
| `Storniranje` | `can_cancel` | `canCancel` |
| `PotpisSlika` | `signature_image` | `signatureImage` |
| `OznakaTima` | `team_code` | `teamCode` |
| `Telefon` | `phone` | `phone` |
| `Email` | `email` | `email` |

### `R_Artikli` → `items`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `Sifra artikla` | `id` | `id` |
| `Kataloski broj` | `catalog_number` | `catalogNumber` |
| `BarKod` | `bar_code` | `barCode` |
| `PLU` | `plu` | `plu` |
| `ExtSifra` | `external_code` | `externalCode` |
| `Naziv` | `name` | `name` |
| `Jedinica mere` | `unit` | `unit` |
| `Pakovanje` | `packaging` | `packaging` |
| `InoJm` | `foreign_unit` | `foreignUnit` |
| `Kutija` | `box` | `box` |
| `Transportno pakovanje` | `transport_packaging` | `transportPackaging` |
| `Poreklo` | `origin_code` | `originCode` |
| `Grupa` | `group_code` | `groupCode` |
| `Podgrupa` | `subgroup_code` | `subgroupCode` |
| `Tarifa robe` | `goods_tax_rate_code` | `goodsTaxRateCode` |
| `Tarifa usluga` | `service_tax_rate_code` | `serviceTaxRateCode` |
| `Uvek porez na robu` | `always_tax_goods` | `alwaysTaxGoods` |
| `Uvek porez na usluge` | `always_tax_services` | `alwaysTaxServices` |
| `VP cena` | `wholesale_price` | `wholesalePrice` |
| `MP cena` | `retail_price` | `retailPrice` |
| `NabDevCena` | `fx_purchase_price` | `fxPurchasePrice` |
| `ProdDevCena` | `fx_sale_price` | `fxSalePrice` |
| `Minimalna kolicina` | `min_quantity` | `minQuantity` |
| `ArtTaksa` | `item_fee` | `itemFee` |
| `Odlozeno` | `payment_term_days` | `paymentTermDays` |
| `Neoporezivi deo` | `non_taxable_part` | `nonTaxablePart` |
| `MaxRabatProc` | `max_discount_percent` | `maxDiscountPercent` |
| `Memo` | `memo` | `memo` |
| `KngSifra` | `accounting_code` | `accountingCode` |
| `ArtAkciza` | `item_excise` | `itemExcise` |
| `KngSifra_2` | `accounting_code_2` | `accountingCode2` |
| `ZavTrosProiz` | `final_processing_cost` | `finalProcessingCost` |
| `CarStopa` | `customs_rate` | `customsRate` |
| `IDRaster` | `raster_id` | `rasterId` |
| `CarTarifa` | `customs_tariff` | `customsTariff` |
| `ZemljaPorekla` | `origin_country` | `originCountry` |
| `Polica` | `shelf` | `shelf` |
| `INONaziv` | `foreign_name` | `foreignName` |
| `SifDob` | `supplier_id` | `supplierId` |
| `WebOpis` | `web_description` | `webDescription` |
| `OpisArtikla` | `item_description` | `itemDescription` |
| `Tezina` | `weight` | `weight` |
| `PDFLink` | `pdf_link` | `pdfLink` |
| `ZaBrisanje` | `to_delete` | `toDelete` |
| `Aktivan` | `active` | `active` |
| `CenaZaUpisUCen` | `price_to_write_pricelist` | `priceToWritePricelist` |
| `IDMestoIzdavanja` | `issue_place_id` | `issuePlaceId` |
| `Proizvodjac` | `manufacturer` | `manufacturer` |
| `HPS` | `hps` | `hps` |
| `PotpisArt` | `signature` | `signature` |
| `DatumIVremeArt` | `created_at` | `createdAt` |
| `KolUPak` | `quantity_in_package` | `quantityInPackage` |
| `KLRucProc` | `manual_markup_percent` | `manualMarkupPercent` |
| `OsnJM` | `base_unit` | `baseUnit` |
| `SlikaSimbolaLink` | `symbol_image_link` | `symbolImageLink` |
| `MPKaloProc` | `retail_loss_percent` | `retailLossPercent` |
| `WordLokacija` | `word_location` | `wordLocation` |
| `VPKaloProc` | `wholesale_loss_percent` | `wholesaleLossPercent` |
| `NeVodiZalihe` | `not_stock_tracked` | `notStockTracked` |
| `TezinaKg` | `weight_kg` | `weightKg` |
| `Zapremina` | `volume` | `volume` |
| `Povrsina` | `area` | `area` |
| `RSort` | `sort_order` | `sortOrder` |
| `AkcijskiRabat` | `promotion_discount` | `promotionDiscount` |
| `Napomena2` | `note_2` | `note2` |
| `IDKvalitetArtikla` | `quality_type_id` | `qualityTypeId` |
| `Debljina` | `thickness` | `thickness` |
| `BBSifra artikla` | `external_item_id` | `externalItemId` |

### `R_Tarife` → `tax_rates`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `ID` | `id` | `id` |
| `Tarifa` | `code` | `code` |
| `Osnovna stopa` | `base_rate` | `baseRate` |
| `Zeleznica stopa` | `railway_rate` | `railwayRate` |
| `Gradska stopa` | `city_rate` | `cityRate` |
| `Ratna stopa` | `war_rate` | `warRate` |
| `Posebna stopa` | `special_rate` | `specialRate` |
| `Opis` | `description` | `description` |
| `Vazi od` | `valid_from` | `validFrom` |
| `Vazi do` | `valid_to` | `validTo` |
| `PDVGrupa` | `vat_group` | `vatGroup` |

### `R_Vrste dokumenata` → `document_types`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `ID` | `id` | `id` |
| `Vrsta dokumenta` | `code` | `code` |
| `Opis` | `description` | `description` |
| `Ulazni` | `is_inbound` | `isInbound` |
| `Analiticki konto` | `analytical_account` | `analyticalAccount` |
| `Knjiziti analitiku` | `post_analytical` | `postAnalytical` |
| `Sema za kontiranje` | `posting_template` | `postingTemplate` |
| `Knjiziti sintetiku` | `post_synthetic` | `postSynthetic` |
| `Prodaja sa PPP` | `sale_with_ppp` | `saleWithPpp` |
| `Prodaja sa PPU` | `sale_with_ppu` | `saleWithPpu` |
| `KnjizitiTKZad` | `post_retail_charge` | `postRetailCharge` |
| `KnjizitiTKRazd` | `post_retail_discharge` | `postRetailDischarge` |
| `TextZaReport` | `report_text` | `reportText` |
| `KnjizitiUPDVEvidenciju` | `post_in_vat_ledger` | `postInVatLedger` |
| `KEPUDefZaduzenje` | `kepu_default_charge` | `kepuDefaultCharge` |
| `KEPUDefRazduzenje` | `kepu_default_discharge` | `kepuDefaultDischarge` |
| `InterniDokument` | `is_internal_document` | `isInternalDocument` |
| `NumeracijaOd` | `numbering_start` | `numberingStart` |
| `KOTP` | `is_fiscal` | `isFiscal` |
| `PrefiksBrojaDok` | `document_number_prefix` | `documentNumberPrefix` |
| `IDMagacinZaVrstuDok` | `default_warehouse_id` | `defaultWarehouseId` |
| `KODJ` | `is_departmental` | `isDepartmental` |
| `FR` | `is_fr` | `isFr` |
| `UticeNaZalihe` | `affects_stock` | `affectsStock` |

### `Radni fajlovi` → `companies`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDBaze` | `id` | `id` |
| `Firma` | `company_name` | `companyName` |
| `Naziv baze` | `database_name` | `databaseName` |
| `Logo` | `logo` | `logo` |
| `Mesto` | `city` | `city` |
| `Adresa` | `address` | `address` |
| `Telefon` | `phone` | `phone` |
| `Fax` | `fax` | `fax` |
| `Ziro racun` | `bank_account` | `bankAccount` |
| `Delatnost` | `business_activity` | `businessActivity` |
| `Sifra delatnosti` | `business_activity_code` | `businessActivityCode` |
| `Opstina` | `municipality` | `municipality` |
| `Napomena` | `note` | `note` |
| `Specijal` | `variant` | `variant` |
| `e-mail` | `email` | `email` |
| `Maticni broj` | `registration_number` | `registrationNumber` |
| `Registarski broj` | `registry_number` | `registryNumber` |
| `Podracuni` | `sub_accounts` | `subAccounts` |
| `Kasa_ProdavnicaID` | `pos_store_id` | `posStoreId` |
| `Kasa_KupacID` | `pos_buyer_id` | `posBuyerId` |
| `Kasa_VrstaDokumenta` | `pos_document_type_code` | `posDocumentTypeCode` |
| `Kasa_RadniNalogID` | `pos_work_order_id` | `posWorkOrderId` |
| `BrDecUlKl` | `inbound_decimal_places` | `inboundDecimalPlaces` |
| `BrDecIzKl` | `outbound_decimal_places` | `outboundDecimalPlaces` |
| `KursDeli` | `split_exchange_rate` | `splitExchangeRate` |
| `ProveraZalihaMag` | `check_warehouse_stock` | `checkWarehouseStock` |
| `AutoPodelaPrihoda` | `auto_split_revenue` | `autoSplitRevenue` |
| `FakturnaJeVPZaUlKl` | `inbound_is_wholesale` | `inboundIsWholesale` |
| `KepuPoNabavnojCeni` | `kepu_at_purchase_price` | `kepuAtPurchasePrice` |
| `TrgovackaPoKursu` | `retail_by_exchange_rate` | `retailByExchangeRate` |
| `KepuPoKursu` | `kepu_by_exchange_rate` | `kepuByExchangeRate` |
| `GKPoKursu` | `gk_by_exchange_rate` | `gkByExchangeRate` |
| `KontoKupac` | `customer_account` | `customerAccount` |
| `KontoDobavljac` | `supplier_account` | `supplierAccount` |
| `KnjiziRazlikeNaTK` | `post_retail_differences` | `postRetailDifferences` |
| `KnjiziRazlikeNaKEPU` | `post_kepu_differences` | `postKepuDifferences` |
| `KnjiziRazlikeNaMPKEPU` | `post_retail_kepu_differences` | `postRetailKepuDifferences` |
| `GKPoKursuObrnuto` | `gk_by_exchange_rate_reverse` | `gkByExchangeRateReverse` |
| `AutoZakRoba` | `auto_lock_goods` | `autoLockGoods` |
| `AutoZakGK` | `auto_lock_gk` | `autoLockGk` |
| `StarijeOdDanaRoba` | `older_than_days_goods` | `olderThanDaysGoods` |
| `StarijeOdDanaGk` | `older_than_days_gk` | `olderThanDaysGk` |
| `ProveraPorukaInterval` | `notification_check_interval` | `notificationCheckInterval` |
| `DekodirajBarKod` | `decode_barcode` | `decodeBarcode` |
| `PIB` | `tax_id` | `taxId` |
| `Garancija` | `warranty` | `warranty` |
| `KEPUPoKNGCeni` | `kepu_at_cost_accounting_price` | `kepuAtCostAccountingPrice` |
| `PEPDV` | `pepdv` | `pepdv` |
| `Vlasnik` | `owner` | `owner` |
| `PoreskaSifra` | `tax_code` | `taxCode` |
| `Galeb` | `galeb` | `galeb` |
| `Raster` | `raster` | `raster` |
| `PG_Naziv baze` | `pg_database_name` | `pgDatabaseName` |
| `ServerZaGaleb` | `is_galeb_server` | `isGalebServer` |
| `KlijentZaGaleb` | `is_galeb_client` | `isGalebClient` |
| `FP_ImeStampaca` | `fiscal_printer_name` | `fiscalPrinterName` |
| `MestoIzdavanjaRacuna` | `invoice_issuing_place` | `invoiceIssuingPlace` |
| `Kasa_KasaID` | `pos_cash_register_id` | `posCashRegisterId` |
| `WebAdresa` | `web_address` | `webAddress` |
| `APRText` | `apr_text` | `aprText` |
| `SaljiBosson` | `send_bosson` | `sendBosson` |
| `Kasa_Cenovnik` | `pos_price_list_code` | `posPriceListCode` |
| `VPCenovnik` | `wholesale_price_list_code` | `wholesalePriceListCode` |
| `FooterText` | `footer_text` | `footerText` |
| `Logo_Footer` | `logo_footer` | `logoFooter` |
| `RPT_Memorandum_Header` | `report_header` | `reportHeader` |
| `RPT_Memorandum_Footer` | `report_footer` | `reportFooter` |
| `LogoFontSize` | `logo_font_size` | `logoFontSize` |
| `PDVStatus` | `vat_status` | `vatStatus` |
| `JBKJS` | `public_sector_id` | `publicSectorId` |
| `ER_ApiKey` | `einvoice_api_key` | `einvoiceApiKey` |
| `NazivFirmeNezvanicno` | `unofficial_company_name` | `unofficialCompanyName` |

### `RobnaDokumentaMirror` → `goods_documents_mirror`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDDok` | `id` | `id` |
| `VrstaDokumenta` | `document_type` | `documentType` |
| `DatumDokumenta` | `document_date` | `documentDate` |

### `RobneStavkeMirror` → `goods_document_items_mirror`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDStavke` | `id` | `id` |
| `IDDok` | `document_id` | `documentId` |
| `SifraArtikla` | `item_id` | `itemId` |
| `KataloskiBroj` | `catalog_number` | `catalogNumber` |
| `IDMagacin` | `warehouse_id` | `warehouseId` |
| `KolicinaUlaz` | `quantity_in` | `quantityIn` |
| `KolicinaIzlaz` | `quantity_out` | `quantityOut` |
| `PoslednjaIzmena` | `updated_at` | `updatedAt` |

### `SklopoviPDMCrteza` → `drawing_assemblies`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDSklopoviCrteza` | `id` | `id` |
| `IDCrtez` | `child_drawing_id` | `childDrawingId` |
| `KoristiSeUIDCrteza` | `parent_drawing_id` | `parentDrawingId` |
| `KoristiSeBrojKomada` | `quantity` | `quantity` |

### `StatusiCrteza` / `StatusiNacrtaPrimopredaje` / `StatusiPrimopredaje`

Sve tri tabele imaju isti pattern:

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDStatusCrteza` / `IDStatusNacrtaPrimopredaje` / `IDStatusPrimopredaje` | `id` | `id` |
| `NazivStatusa` / `StatusNacrtaPrimopredaje` / `NazivStatusa` | `name` | `name` |

### `T_Planer` → `planner_entries`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `ID` | `id` | `id` |
| `IDFirma` | `company_id` | `companyId` |
| `KadaDatum` | `scheduled_date` | `scheduledDate` |
| `KadaVreme` | `scheduled_time` | `scheduledTime` |
| `OdKoga` | `from_user` | `fromUser` |
| `ZaKoga` | `to_user` | `toUser` |
| `Subject` | `subject` | `subject` |
| `Prioritet` | `priority` | `priority` |
| `Poruka` | `message` | `message` |
| `RepeatCode` | `repeat_code` | `repeatCode` |
| `CheckUradjeno` | `is_done` | `isDone` |
| `KadaJeUradjeno` | `done_at` | `doneAt` |
| `KoJeUradio` | `done_by` | `doneBy` |
| `IDProgToExecute` | `program_to_execute` | `programToExecute` |
| `AutoExec` | `auto_exec` | `autoExec` |
| `DIVPrviUnos` | `created_at` | `createdAt` |
| `DIVPoslednjaIzmena` | `updated_at` | `updatedAt` |

### `T_PlanerGrupeUsera` → `planner_user_groups`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `ID` | `id` | `id` |
| `NazivGrupe` | `group_name` | `groupName` |
| `UserName` | `username` | `username` |

### `T_Robna dokumenta` → `goods_documents`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDDok` | `id` | `id` |
| `IDFirma` | `company_id` | `companyId` |
| `Ulaz` | `is_inbound` | `isInbound` |
| `Broj naloga` | `order_number` | `orderNumber` |
| `Vrsta naloga` | `order_type` | `orderType` |
| `Broj dokumenta` | `document_number` | `documentNumber` |
| `Vrsta dokumenta` | `document_type` | `documentType` |
| `Sifra komitenta` | `customer_id` | `customerId` |
| `Datum dokumenta` | `document_date` | `documentDate` |
| `Datum knjizenja` | `posting_date` | `postingDate` |
| `Datum valute` | `due_date` | `dueDate` |
| `Opis` | `description` | `description` |
| `Nacin otpreme` | `shipment_method` | `shipmentMethod` |
| `Fco` | `fco` | `fco` |
| `Broj izjave` | `statement_number` | `statementNumber` |
| `Datum izjave` | `statement_date` | `statementDate` |
| `Sifra prodavca` | `salesperson_id` | `salespersonId` |
| `Nacin placanja` | `payment_method` | `paymentMethod` |
| `IDTrebZaProizvodnju` | `production_request_id` | `productionRequestId` |
| `IDMagacinDOK` | `warehouse_id` | `warehouseId` |
| `Memo` | `memo` | `memo` |
| `Kurs` | `exchange_rate` | `exchangeRate` |
| `IDRadniNalog` | `work_order_id` | `workOrderId` |
| `ObrKurs` | `accounting_exchange_rate` | `accountingExchangeRate` |
| `Carina` | `customs` | `customs` |
| `Spedicija` | `forwarding` | `forwarding` |
| `OstaliZavTros` | `other_dependent_costs` | `otherDependentCosts` |
| `DevVredFak` | `fx_invoice_value` | `fxInvoiceValue` |
| `Level` | `level` | `level` |
| `IDPredmet` | `project_id` | `projectId` |
| `Zakljucano` | `is_locked` | `isLocked` |
| `IDDokUF` | `linked_inbound_doc_id` | `linkedInboundDocId` |
| `IDDokIF` | `linked_invoice_doc_id` | `linkedInvoiceDocId` |
| `Rezervisi` | `reserve_stock` | `reserveStock` |
| `CarKurs` | `customs_exchange_rate` | `customsExchangeRate` |
| `IDDokUSL` | `linked_service_doc_id` | `linkedServiceDocId` |
| `PovCarOsn` | `customs_refund_base` | `customsRefundBase` |
| `DevValuta` | `currency` | `currency` |
| `IDMestoIsporuke` | `delivery_place_id` | `deliveryPlaceId` |
| `IDRuta` | `route_id` | `routeId` |
| `IDVozac` | `driver_id` | `driverId` |
| `OJ` | `org_unit_id` | `orgUnitId` |
| `Potpisano` | `is_signed` | `isSigned` |
| `OD` | `department_id` | `departmentId` |
| `Potpis` | `signature` | `signature` |
| `DatumIVreme` | `created_at` | `createdAt` |
| `Godina` | `year` | `year` |
| `DatIVreme` | `registered_at` | `registeredAt` |
| `IDKontaktOsobe` | `contact_person_id` | `contactPersonId` |
| `PrimljenNovac` | `cash_received` | `cashReceived` |
| `UsloviPlacanja` | `payment_terms` | `paymentTerms` |
| `PrimljeniCekovi` | `checks_received` | `checksReceived` |
| `PrimljenaKartica` | `card_received` | `cardReceived` |
| `IDKasa` | `cash_register_id` | `cashRegisterId` |
| `StampanFiskalno` | `fiscal_printed` | `fiscalPrinted` |
| `PrimljeniVirmani` | `bank_transfer_received` | `bankTransferReceived` |
| `IDDokExtBaza` | `external_db_doc_id` | `externalDbDocId` |
| `DokBarKod` | `document_bar_code` | `documentBarCode` |
| `DokBrojKutija` | `document_box_count` | `documentBoxCount` |

### `T_Robne stavke` → `goods_document_items`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDStavke` | `id` | `id` |
| `IDDok` | `document_id` | `documentId` |
| `Sifra artikla` | `item_id` | `itemId` |
| `Kolicina` | `quantity` | `quantity` |
| `KG_Kolicina` | `kg_quantity` | `kgQuantity` |
| `Nabavna cena - neto` | `purchase_price_net` | `purchasePriceNet` |
| `Zavisni trosak - sopstveni` | `dependent_cost_own` | `dependentCostOwn` |
| `Zavisni trosak - dobavljac` | `dependent_cost_supplier` | `dependentCostSupplier` |
| `Kalkulativna VP cena` | `calculated_wholesale_price` | `calculatedWholesalePrice` |
| `Kalkulativna MP cena` | `calculated_retail_price` | `calculatedRetailPrice` |
| `Stvarna VP cena` | `actual_wholesale_price` | `actualWholesalePrice` |
| `Stvarna MP cena` | `actual_retail_price` | `actualRetailPrice` |
| `Taksa` | `fee` | `fee` |
| `Obracunat porez na ulazu - roba` | `inbound_tax_calculated` | `inboundTaxCalculated` |
| `Tarifa - roba - ulaz` | `inbound_goods_tax_rate` | `inboundGoodsTaxRate` |
| `Obracunat porez na usluge` | `services_tax_calculated` | `servicesTaxCalculated` |
| `Tarifa - usluge - izlaz` | `outbound_services_tax_rate` | `outboundServicesTaxRate` |
| `Obracunat  porez na robu` | `goods_tax_calculated` | `goodsTaxCalculated` |
| `Tarifa - roba - Izlaz` | `outbound_goods_tax_rate` | `outboundGoodsTaxRate` |
| `RabatProc` | `discount_percent` | `discountPercent` |
| `KasaProc` | `cash_discount_percent` | `cashDiscountPercent` |
| `Odlozeno` | `payment_term_days` | `paymentTermDays` |
| `Neoporezivi deo` | `non_taxable_part` | `nonTaxablePart` |
| `Akciza` | `excise` | `excise` |
| `FiksniPorez` | `fixed_tax` | `fixedTax` |
| `DevNabCena` | `fx_purchase_price` | `fxPurchasePrice` |
| `IDMagacin` | `warehouse_id` | `warehouseId` |
| `KNGCena` | `accounting_price` | `accountingPrice` |
| `CarStopa` | `customs_rate` | `customsRate` |
| `IDPredmetStavka` | `project_item_id` | `projectItemId` |
| `OpisStavke` | `item_description` | `itemDescription` |
| `ID_PO` | `purchase_order_id` | `purchaseOrderId` |
| `PakPoOsnJM` | `package_per_base_unit` | `packagePerBaseUnit` |
| `IDPrepisaneStavke` | `copied_from_item_id` | `copiedFromItemId` |
| `ProknjizenoIzProfUIF` | `posted_from_proforma_to_invoice` | `postedFromProformaToInvoice` |
| `IDStavkeTrebovanja` | `requisition_item_id` | `requisitionItemId` |

### `UplatniRacuni` → `payment_accounts`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDFirma` | `company_id` | `companyId` |
| `ID` | `id` | `id` |
| `UplatniRacun` | `account_number` | `accountNumber` |
| `NazivBanke` | `bank_name` | `bankName` |
| `Default` | `is_default` | `isDefault` |
| `Rbr` | `sort_order` | `sortOrder` |
| `KodZemlje` | `country_code` | `countryCode` |
| `OznakaBanke` | `bank_code` | `bankCode` |

### `Vrste sifara` → `code_types`, `Vrsta naloga` → `order_types`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `Vrsta sifre` / `Vrsta naloga` | `code` | `code` |
| `Opis` | `description` | `description` |

### `_Dnevnik` → `journal`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `ID` | `id` | `id` |
| `Opis` | `message` | `message` |
| `DIV` | `created_at` | `createdAt` |

### `_RegAccess` → `app_access_log`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `ID` | `id` | `id` |
| `HDSn` | `hardware_id` | `hardwareId` |
| `WinUser` | `windows_user` | `windowsUser` |
| `ComputerName` | `computer_name` | `computerName` |
| `IPAdress` | `ip_address` | `ipAddress` |
| `Program_Name` | `program_name` | `programName` |
| `CNNString` | `connection_string` | `connectionString` |
| `Login_Time` | `login_at` | `loginAt` |

### `_RegApps` → `registered_apps`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `DBName` | `database_name` | `databaseName` |
| `AppName` | `app_name` | `appName` |
| `Disabled` | `disabled` | `disabled` |
| `AplFile` | `app_file` | `appFile` |
| `MDWFile` | `mdw_file` | `mdwFile` |
| `ClientDir` | `client_dir` | `clientDir` |
| `DownloadDir` | `download_dir` | `downloadDir` |
| `PrviUnos` | `created_at` | `createdAt` |
| `PoslednjaIzmena` | `updated_at` | `updatedAt` |

### `_RegAppsFiles` → `registered_app_files`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `DBName` | `database_name` | `databaseName` |
| `AppName` | `app_name` | `appName` |
| `AppFileName` | `file_name` | `fileName` |
| `ClientDir` | `client_dir` | `clientDir` |
| `Install` | `install` | `install` |
| `Update` | `update` | `update` |
| `PrviUnos` | `created_at` | `createdAt` |
| `PoslednjaIzmena` | `updated_at` | `updatedAt` |

### `_RegUsers` → `registered_users`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `DBName` | `database_name` | `databaseName` |
| `RegUserID` | `id` | `id` |
| `Disabled` | `disabled` | `disabled` |
| `HDSn` | `hardware_id` | `hardwareId` |
| `WinUser` | `windows_user` | `windowsUser` |
| `ComputerName` | `computer_name` | `computerName` |
| `IPAdress` | `ip_address` | `ipAddress` |
| `Name` | `full_name` | `fullName` |
| `email` | `email` | `email` |
| `Telefon` | `phone` | `phone` |
| `Opis` | `description` | `description` |
| `VaziOdDatuma` | `valid_from` | `validFrom` |
| `VaziDoDatuma` | `valid_to` | `validTo` |
| `PrviUnos` | `created_at` | `createdAt` |
| `PoslednjaIzmena` | `updated_at` | `updatedAt` |

### `_RegUsersApps` → `registered_user_apps`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `DBName` | `database_name` | `databaseName` |
| `RegUserID` | `user_id` | `userId` |
| `AppName` | `app_name` | `appName` |
| `Disabled` | `disabled` | `disabled` |
| `BBUserName` | `bb_user_name` | `bbUserName` |
| `BBPassword` | `bb_password` | `bbPassword` |
| `BBMacroName` | `bb_macro_name` | `bbMacroName` |
| `EXCL` | `excl` | `excl` |
| `RUNTIME` | `runtime` | `runtime` |
| `BBExtraStartUp` | `bb_extra_start_up` | `bbExtraStartUp` |
| `BBCMD` | `bb_cmd` | `bbCmd` |
| `PrviUnos` | `created_at` | `createdAt` |
| `PoslednjaIzmena` | `updated_at` | `updatedAt` |

### `_Rev` → `app_revisions`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `ID` | `id` | `id` |
| `APP` | `app` | `app` |
| `Ver` | `version` | `version` |
| `VerDatum` | `version_date` | `versionDate` |
| `Tema` | `topic` | `topic` |
| `Opis` | `description` | `description` |
| `Uradjeno` | `is_done` | `isDone` |
| `Firma` | `company` | `company` |
| `DIVUnos` | `created_at` | `createdAt` |
| `SubRev` | `sub_revision` | `subRevision` |

### `tLansiranRN` → `work_order_launches`, `tSaglasanRN` → `work_order_approvals`

Obe tabele dele isti audit pattern:

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDLansiran` / `IDSaglasan` | `id` | `id` |
| `IDRN` | `work_order_id` | `workOrderId` |
| `Lansiran` / `Saglasan` | `is_launched` / `is_approved` | `isLaunched` / `isApproved` |
| `DatumUnosa` | `entered_at` | `enteredAt` |
| `DIVUnos` | `created_at` | `createdAt` |
| `SifraRadnikaUnos` | `created_by_worker_id` | `createdByWorkerId` |
| `PotpisUnos` | `created_by_signature` | `createdBySignature` |
| `DIVIspravke` | `updated_at` | `updatedAt` |
| `SifraRadnikaIspravka` | `updated_by_worker_id` | `updatedByWorkerId` |
| `PotpisIspravka` | `updated_by_signature` | `updatedBySignature` |

### `tLokacijeDelova` → `part_locations`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDLokacije` | `id` | `id` |
| `IDRN` | `work_order_id` | `workOrderId` |
| `IDPredmet` | `project_id` | `projectId` |
| `IDVrstaKvaliteta` | `quality_type_id` | `qualityTypeId` |
| `IDPozicija` | `position_id` | `positionId` |
| `SifraRadnika` | `worker_id` | `workerId` |
| `Datum` | `record_date` | `recordDate` |
| `Kolicina` | `quantity` | `quantity` |
| `DatumIVremeUnosa` | `created_at` | `createdAt` |

### `tOperacije` → `operations`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDOperacije` | `id` | `id` |
| `RJgrupaRC` | `work_center_code` | `workCenterCode` |
| `NazivGrupeRC` | `work_center_name` | `workCenterName` |
| `Napomena` | `note` | `note` |
| `IDRadneJedinice` | `work_unit_code` | `workUnitCode` |
| `BezPostupka` | `without_process` | `withoutProcess` |
| `ZnacajneOperacijeZaZavrsen` | `significant_for_finishing` | `significantForFinishing` |
| `KoristiPrioritet` | `uses_priority` | `usesPriority` |
| `PreskocivaOperacija` | `is_skippable` | `isSkippable` |

### `tPDM` / `tPLP` / `tPND` → `work_order_machined_parts` / `work_order_blanks` / `work_order_nonstandard_parts`

Sve tri tabele dele osnovni pattern (vidi schema.prisma za detalje):

| Stara kolona | Nova DB kolona |
|---|---|
| `IDStavkePDM` / `IDStavkePLP` / `IDStavkePND` | `id` |
| `IDRN` | `work_order_id` |
| `PozicijaPDM` / `PozicijaPLP` / `PozicijaPND` | `position` |
| `OperacijaPDM` / `OperacijaPND` | `operation_id` |
| `RJgrupaRC` | `work_center_code` |
| `NazivP` (tPDM) | `part_name` |
| `BrojCrtezaP` (tPDM) | `drawing_number` |
| `NazivDela` (tPND) | `part_name` |
| `Materijal` (tPLP) | `material` |
| `DimenzijaMaterijala` (tPLP) | `material_dimension` |
| `JM` (tPLP) | `unit` |
| `TezinaJed` (tPLP) | `unit_weight` |
| `BrojPozicije` (tPLP) | `position_number` |
| `Komada` | `quantity` |
| `Napomena` (tPND) | `note` |
| `DIVUnosa` | `created_at` |
| `DIVIspravke` | `updated_at` |
| `SifraRadnika` | `worker_id` |

### `tPozicije` → `positions`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDPozicije` | `id` | `id` |
| `Pozicija` | `position_code` | `positionCode` |
| `Opis` | `description` | `description` |

### `tPristupMasini` → `machine_access`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDPristupMasini` | `id` | `id` |
| `SifraRadnika` | `worker_id` | `workerId` |
| `RJgrupaRC` | `work_center_code` | `workCenterCode` |
| `Napomena` | `note` | `note` |

### `tRN` → `work_orders`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDRN` | `id` | `id` |
| `IDPredmet` | `project_id` | `projectId` |
| `IdentBroj` | `ident_number` | `identNumber` |
| `Varijanta` | `variant` | `variant` |
| `BBIDKomitent` | `external_customer_id` | `externalCustomerId` |
| `BBNazivPredmeta` | `external_project_name` | `externalProjectName` |
| `BBDatumOtvaranja` | `external_opened_at` | `externalOpenedAt` |
| `DatumUnosa` | `entered_at` | `enteredAt` |
| `Komada` | `piece_count` | `pieceCount` |
| `BrojCrteza` | `drawing_number` | `drawingNumber` |
| `Proizvod` | `product` | `product` |
| `TezinaNeobrDela` | `unprocessed_part_weight` | `unprocessedPartWeight` |
| `NazivDela` | `part_name` | `partName` |
| `IdentMaterijala` | `material_id` | `materialId` |
| `Materijal` | `material` | `material` |
| `DimenzijaMaterijala` | `material_dimension` | `materialDimension` |
| `JM` | `unit` | `unit` |
| `TezinaObrDela` | `processed_part_weight` | `processedPartWeight` |
| `Napomena` | `note` | `note` |
| `StatusRN` | `status` | `status` |
| `RokIzrade` | `production_deadline` | `productionDeadline` |
| `DIVUnosaRN` | `created_at` | `createdAt` |
| `DIVIspravkeRN` | `updated_at` | `updatedAt` |
| `SifraRadnika` | `worker_id` | `workerId` |
| `Zakljucano` | `is_locked` | `isLocked` |
| `Potpis` | `signature` | `signature` |
| `PrnTimer` | `print_timer` | `printTimer` |
| `VezaSaBrojemCrteza` | `parent_drawing_ref` | `parentDrawingRef` |
| `IDVrstaKvaliteta` | `quality_type_id` | `qualityTypeId` |
| `Revizija` | `revision` | `revision` |
| `IDPrimopredaje` | `drawing_handover_id` | `drawingHandoverId` |
| `IDCrtez` | `drawing_id` | `drawingId` |
| `IDStatusPrimopredaje` | `handover_status_id` | `handoverStatusId` |
| `SifraRadnikaPrimopredaje` | `handover_worker_id` | `handoverWorkerId` |

### `tRNKomponente` → `work_order_components`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDKomponente` | `id` | `id` |
| `IDRN` | `work_order_id` | `workOrderId` |
| `IDRNPodkomponenta` | `component_work_order_id` | `componentWorkOrderId` |
| `BrojKomada` | `quantity` | `quantity` |
| `Napomena` | `note` | `note` |

### `tRNNDKomponente` → `work_order_item_components`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDNDKomponente` | `id` | `id` |
| `IDRN` | `work_order_id` | `workOrderId` |
| `SifraArtikla` | `item_id` | `itemId` |
| `BrojKomada` | `quantity` | `quantity` |
| `Napomena` | `note` | `note` |

### `tR_Grupa` → `production_item_groups`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `ID` | `id` | `id` |
| `Grupa` | `code` | `code` |
| `Opis` | `description` | `description` |

### `tRadneJedinice` → `work_units`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `ID` | `id` | `id` |
| `IDRadneJedinice` | `code` | `code` |
| `RadnaJedinica` | `name` | `name` |

### `tRadnici` → `workers`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `SifraRadnika` | `id` | `id` |
| `Radnik` | `username` | `username` |
| `ProcenatZaObracun` | `commission_percent` | `commissionPercent` |
| `ImeIPrezime` | `full_name` | `fullName` |
| `BrLkRadnika` | `id_number` | `idNumber` |
| `Password` | `password` | `password` |
| `Aktivan` | `active` | `active` |
| `IDRadneJedinice` | `work_unit_code` | `workUnitCode` |
| `IDKartice` | `card_id` | `cardId` |
| `LogAcc` | `login_account` | `loginAccount` |
| `IDVrsteRadnika` | `worker_type_id` | `workerTypeId` |
| `PotpisSlika` | `signature_image` | `signatureImage` |
| `DefiniseSaglasan` | `defines_approval` | `definesApproval` |
| `DefiniseLansiran` | `defines_launch` | `definesLaunch` |
| `MultiNalog` | `multi_account` | `multiAccount` |
| `PasswordRadnika` | `worker_password` | `workerPassword` |

### `tStavkeRN` → `work_order_operations`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDStavkeRN` | `id` | `id` |
| `IDRN` | `work_order_id` | `workOrderId` |
| `Operacija` | `operation_number` | `operationNumber` |
| `RJgrupaRC` | `work_center_code` | `workCenterCode` |
| `OpisRada` | `work_description` | `workDescription` |
| `AlatPribor` | `tools_fixtures` | `toolsFixtures` |
| `Tpz` | `setup_time` | `setupTime` |
| `Tk` | `cycle_time` | `cycleTime` |
| `TezinaTO` | `tool_weight` | `toolWeight` |
| `SifraRadnika` | `worker_id` | `workerId` |
| `DIVUnosa` | `created_at` | `createdAt` |
| `DIVIspravke` | `updated_at` | `updatedAt` |
| `Prioritet` | `priority` | `priority` |

### `tStavkeRNSlike` → `work_order_operation_images`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `ID` | `id` | `id` |
| `IDStavkeRN` | `work_order_operation_id` | `workOrderOperationId` |
| `LinkSlika` | `image_link` | `imageLink` |
| `ImeFajla` | `file_name` | `fileName` |

### `tTehPostupak` → `tech_processes`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDPostupka` | `id` | `id` |
| `SifraRadnika` | `worker_id` | `workerId` |
| `IDPredmet` | `project_id` | `projectId` |
| `IdentBroj` | `ident_number` | `identNumber` |
| `Varijanta` | `variant` | `variant` |
| `PrnTimer` | `print_timer` | `printTimer` |
| `DatumIVremeUnosa` | `entered_at` | `enteredAt` |
| `Operacija` | `operation_number` | `operationNumber` |
| `RJgrupaRC` | `work_center_code` | `workCenterCode` |
| `Toznaka` | `ident_mark` | `identMark` |
| `Komada` | `piece_count` | `pieceCount` |
| `Potpis` | `signature` | `signature` |
| `SimbolRadnik` | `worker_symbol` | `workerSymbol` |
| `SimbolPostupak` | `process_symbol` | `processSymbol` |
| `SimbolOperacija` | `operation_symbol` | `operationSymbol` |
| `DatumIVremeZavrsetka` | `finished_at` | `finishedAt` |
| `ZavrsenPostupak` | `is_process_finished` | `isProcessFinished` |
| `Napomena` | `note` | `note` |
| `IDRN` | `work_order_id` | `workOrderId` |
| `IDVrstaKvaliteta` | `quality_type_id` | `qualityTypeId` |
| `DoradaOperacije` | `rework_operation_id` | `reworkOperationId` |

### `tTehPostupakDokumentacija` → `tech_process_documents`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `ID` | `id` | `id` |
| `IDPostupka` | `tech_process_id` | `techProcessId` |
| `LinkFajla` | `file_link` | `fileLink` |
| `ImeFajla` | `file_name` | `fileName` |

### `tVrsteKvalitetaDelova` → `part_quality_types`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDVrstaKvaliteta` | `id` | `id` |
| `VrstaKvaliteta` | `name` | `name` |

### `tVrsteRadnika` → `worker_types`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `IDVrsteRadnika` | `id` | `id` |
| `VrstaRadnika` | `name` | `name` |
| `DodatnaOvlascenja` | `additional_privileges` | `additionalPrivileges` |

### `tmp_T_KontroleNaFormi` → `tmp_form_controls`

| Stara kolona | Nova DB kolona | Prisma polje |
|---|---|---|
| `ImeForme` | `form_name` | `formName` |
| `ImeKontrole` | `control_name` | `controlName` |
| `TipKontrole` | `control_type` | `controlType` |

---

## Application auth & audit (post-baseline)

Sledeće tabele **ne dolaze iz BigBit-a** i nisu deo baseline migracije. Vlasnik im je NestJS aplikacioni sloj. Dodate su u migraciji `20260511160000_auth_and_audit`:

| Tabela | Svrha | Ključni detalji |
|---|---|---|
| `users` | Aplikacioni nalozi (email + password) za NestJS auth | `email` unique; `role` slobodan string (default `'USER'`), bez enum-a da nove role ne traže migraciju; `password_hash` u VARCHAR(255) — dovoljno i za argon2 i bcrypt |
| `refresh_tokens` | JWT refresh token store sa rotacijom | `token_hash` unique (nikad ne čuvati sirov token); `replaced_by_token_id` self-FK (SET NULL na delete); FK na `users` je CASCADE — logout korisnika briše sve aktivne tokene; indexi na `user_id` i `expires_at` za brz cleanup |
| `audit_log` | Append-only audit trail | `actor_user_id` FK SetNull + denormalizovan snapshot `actor_username` da log preživi brisanje korisnika; `entity_id` je `VARCHAR(100)` da pokrije i numeric i string PK-ove (npr. `code` u `tax_rates`); JSONB `before_data` / `after_data` / `metadata`; composite index `(entity_type, entity_id)` |

**Eksplicitno razdvajanje od domena:**

- `users` nije isto što i `workers` (proizvodno-pogonsko osoblje, `tRadnici` u legacy) niti `registered_users` (legacy desktop app registry, `_RegUsers`).
- `audit_log` čuva `actor_username` čak i kad se user obriše — namera je *forever append-only* tabela, nikad se ne ažurira.

**Šta i dalje nije u šemi (svesno van ovog PR-a):**

- `notification_outbox` — kada email/notifikacije uđu u skop.
- `operation_clock_ins` / `daily_activity_summary` (bar-kod stanice) — ako budu deo V1.
- File storage strategija (S3 vs lokalni FS) — odluka pre implementacije; tabele i dalje drže samo `file_link` string.

---

## BigBit sync (Sprint 1)

**Odluka:** pristup **B** — NestJS servis se na dugme / endpoint povezuje na SQL Server (BigBit) read-only klijentom (npr. `mssql` / tedious), povlači delte, upsert-uje u Postgres preko Prisma. **Nije** FDW (A) u Sprintu 1; **nije** outbound queue (C) za smer BigBit → PG (taj pattern je primarno za slanje *iz* naše baze napolje).

Tabele su dodate migracijom `20260512120000_bb_sync_tables`:

| Tabela | Svrha |
|--------|--------|
| `bb_sync_log` | **Istorija svakog sync run-a** — `started_at` / `finished_at`, `status` (`running` \| `success` \| `failed` \| `partial`), `trigger` (`manual` \| `cron` \| `api`), opcioni `triggered_by_user_id` → `users`, `entity_scope` (npr. `customers`), brojači redova, `error_message`, `metadata` (JSONB). |
| `bb_sync_state` | **Bookmark po entitetu** — PK je `entity` (stabilan string ključ, npr. `customers`, `items`). Polje `cursor` je **JSONB** (fleksibilno: `lastModifiedAt`, `lastId`, `rowversion`, … zavisi od BigBit tabele). `last_success_at`, `last_attempt_at`, `last_error_message`, opcioni `last_success_sync_log_id` → poslednji uspešan red u logu. |

**Za tim / review (kratko u Slack/PR):**  
*Sprint 1 sync: pristup B (Nest + SQL Server read, upsert u PG). Stanje cursora u `bb_sync_state.cursor` (JSON po entitetu). Istorija run-ova u `bb_sync_log`. FDW i queue kasnije ako zatreba.*

---

## Ono što nije pokriveno ovom migracijom

Da bude jasno gde je granica:

1. **`legacy/schema-baseline-from-mssql.sql`** ostaje na srpskom. To je snapshot izvornog BigBit MSSQL sistema i ne menja se zajedno sa nama.
2. **`legacy/tools/mssql_to_pg_schema.py`** ostaje kakav je — one-off konverzioni alat.
3. **`docs/ServoSync-specification.md`** ostaje na srpskom. Tu se opisuje *legacy* sync ponašanje i koristi originalne BigBit nazive (Komitenti, Predmeti, ...). ServoSync v2 mapping (BigBit srpski → ova baza engleski) treba dodati kao zaseban dokument kada se ServoSync modul implementira.
4. **`prisma/migrations/migration_lock.toml`** nije menjan; provider ostaje `postgresql`.
5. Constraint-i `pk_*` / `fk_*` / `uq_*` su preimenovani u snake_case da prate iste konvencije kao tabele/kolone.

## Provera

Posle pulla:

```bash
npm install
npm run docker:db:fresh   # ako lokalni Postgres volume ima staru srpsku šemu
npm run migrate:prod      # baseline + auth_and_audit + bb_sync_tables
npm run prisma:generate
npm run build
```
