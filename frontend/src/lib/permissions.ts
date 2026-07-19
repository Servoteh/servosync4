// Permission keys — MIRROR of backend `src/common/authz/permissions.ts`.
// Single source of the string values; the backend `GET /auth/me/permissions`
// returns the subset the logged-in user's role grants (AUTHZ_UNIFIED.md §8 Faza 2).
// Keep in sync with the backend catalog; a key here that the backend doesn't emit
// simply never matches (fail-closed).

export const PERMISSIONS = {
  TEHNOLOGIJA_READ: 'tehnologija.read',
  TEHNOLOGIJA_WRITE: 'tehnologija.write',
  TEHNOLOGIJA_APPROVE: 'tehnologija.approve',
  TEHNOLOGIJA_REPORT_WORK: 'tehnologija.report_work',
  // CAM redosled (per-user grant) — samo tehnolozi kojima je dodeljen
  // ređaju CAM listu prevlačenjem; CNC programeri vide redosled read-only.
  CAM_PRIORITET: 'tehnologija.cam_prioritet',
  RN_READ: 'rn.read',
  RN_WRITE: 'rn.write',
  RN_APPROVE: 'rn.approve',
  RN_LAUNCH: 'rn.launch',
  // Prinudno brisanje RN-a sa evidentiranim radom (admin/šef) — DELETE /:id/force.
  RN_DELETE_FORCE: 'rn.delete.force',
  PDM_READ: 'pdm.read',
  PDM_IMPORT: 'pdm.import',
  // Kontrola kvaliteta (evidencija škart/dorada) — MODULE_SPEC_kontrola_kvaliteta.md §7.
  // read = KONTROLOR/ŠEF/MENADZMENT/ADMIN + TEHNOLOG (uvid); write = unos/izmena/potvrda
  // izveštaja (KONTROLOR/ŠEF/MENADZMENT/ADMIN). Proizvodni radnik svoje vidi kroz Moj profil.
  KVALITET_READ: 'kvalitet.read',
  KVALITET_WRITE: 'kvalitet.write',
  STRUKTURE_READ: 'strukture.read',
  STRUKTURE_WRITE: 'strukture.write',
  PRIMOPREDAJE_READ: 'primopredaje.read',
  PRIMOPREDAJE_WRITE: 'primopredaje.write',
  PRIMOPREDAJE_APPROVE: 'primopredaje.approve',
  LOKACIJE_READ: 'lokacije.read',
  LOKACIJE_WRITE: 'lokacije.write',
  // Lokacije delova — 3.0 Talas A (fizičke lokacije loc_*; MODULE_SPEC_lokacije_30.md §2).
  // `lokacije.read` je DELJEN sa 2.0-native part-locations (ista SELECT baseline);
  // move/manage/admin/labels su NOVI za fizičke lokacije (loc_can_create_movement /
  // loc_can_manage_locations / loc_is_admin / canPrintLocLabels — row-odluka u DB fn).
  LOKACIJE_MOVE: 'lokacije.move',
  LOKACIJE_MANAGE: 'lokacije.manage',
  LOKACIJE_ADMIN: 'lokacije.admin',
  LOKACIJE_LABELS: 'lokacije.labels',
  MRP_READ: 'mrp.read',
  // Nabavka — 4.0 Traka B (mirror backend kataloga)
  NABAVKA_READ: 'nabavka.read',
  NABAVKA_WRITE: 'nabavka.write',
  NABAVKA_APPROVE: 'nabavka.approve',
  // Robno / magacin — 4.0 Faza 3 (robni dokumenti, kalkulacija landed cost, knjiženje).
  // read = uvid; write = kreiranje/kalkulacija; post = knjiženje u GK. Mirror BE kataloga.
  ROBNO_READ: 'robno.read',
  ROBNO_WRITE: 'robno.write',
  ROBNO_POST: 'robno.post',
  // Izvodi (bankovni izvodi) — 4.0 Faza 4 §B (uvoz TXT → uparivanje → auto-knjiženje).
  // read = uvid; import = upload/parse + uparivanje; post = auto-knjiženje u GK. Mirror BE kataloga.
  IZVODI_READ: 'izvodi.read',
  IZVODI_IMPORT: 'izvodi.import',
  IZVODI_POST: 'izvodi.post',
  // Saldakonti — 4.0 Faza 4 (otvorene stavke/aging, uparivanje). Mirror BE kataloga.
  SALDAKONTI_READ: 'saldakonti.read',
  SALDAKONTI_RECONCILE: 'saldakonti.reconcile',
  // Priprema plaćanja / virmani — 4.0 Faza 4 §C (dospele obaveze → nalog → FX TXT).
  // read = uvid; prepare = kreiranje/potpis; export = izvoz u banku. Mirror BE kataloga.
  PLACANJA_READ: 'placanja.read',
  PLACANJA_PREPARE: 'placanja.prepare',
  PLACANJA_EXPORT: 'placanja.export',
  // Fakturisanje / prodaja — 4.0 Faza 5 §A (izlazni računi: predračun → carry-over → knjiženje).
  // read = uvid; write = predračun + prepis PROF→IFR; post = knjiženje u GK; approve = odobrenje.
  SALES_READ: 'sales.read',
  SALES_WRITE: 'sales.write',
  SALES_POST: 'sales.post',
  SALES_APPROVE: 'sales.approve',
  // SEF e-fakture (izlazne) — 4.0 Faza 5 §B. read = uvid u outbox; send = slanje UBL-a na SEF;
  // cancel = storno/otkazivanje na SEF-u. Mirror BE kataloga.
  SEF_READ: 'sef.read',
  SEF_SEND: 'sef.send',
  SEF_CANCEL: 'sef.cancel',
  // PDV / POPDV — 4.0 Faza 6 (KIF/KUF knjige, POPDV obračun, PPDV prijava).
  // read = uvid u KIF/KUF + PDV obračune; compute = pokretanje POPDV obračuna. Mirror BE kataloga.
  PDV_READ: 'pdv.read',
  PDV_COMPUTE: 'pdv.compute',
  // Završni račun / bilansi — 4.0 Faza 7 (bruto bilans, bilans stanja/uspeha, APR).
  // read = uvid u bruto bilans i sačuvane obračune; compute = pokretanje obračuna. Mirror BE kataloga.
  ZR_READ: 'zr.read',
  ZR_COMPUTE: 'zr.compute',
  DIRECTORY_READ: 'directory.read',
  // Predmeti write-path + RFQ kupca — 4.0 Traka B (mirror backend kataloga)
  PROJECTS_WRITE: 'projects.write',
  RFQ_READ: 'rfq.read',
  RFQ_WRITE: 'rfq.write',
  SYNC_RUN: 'sync.run',
  SYNC_READ: 'sync.read',
  // Reversi — 3.0 pilot (2.0 backend docs/design/MODULE_SPEC_reversi.md §3)
  REVERSI_READ: 'reversi.read',
  REVERSI_MANAGE: 'reversi.manage',
  // Rezervisano za „Moj tim" pogled (TL/šef) — UI još nije priključen; vidi TODO u api/reversi.ts.
  REVERSI_TEAM_READ: 'reversi.team_read',
  // Talas C — Proizvodnja (Plan montaže + Plan proizvodnje + Praćenje).
  // MODULE_SPEC_planovi_pracenje_30.md §2; mirror BE common/authz/permissions.ts.
  MONTAZA_READ: 'montaza.read',
  MONTAZA_EDIT: 'montaza.edit',
  MONTAZA_IZVESTAJI: 'montaza.izvestaji',
  MONTAZA_AI_ADMIN: 'montaza.ai_admin',
  PLAN_PROIZVODNJE_READ: 'plan_proizvodnje.read',
  PLAN_PROIZVODNJE_EDIT: 'plan_proizvodnje.edit',
  PLAN_PROIZVODNJE_FORCE: 'plan_proizvodnje.force',
  PLAN_PROIZVODNJE_KOOP_ADMIN: 'plan_proizvodnje.koop_admin',
  PRACENJE_READ: 'pracenje.read',
  PRACENJE_EDIT: 'pracenje.edit',
  PRACENJE_MANAGE: 'pracenje.manage',
  PRACENJE_PRIORITET: 'pracenje.prioritet',
  // Projektni biro — 3.0 TALAS D (MODULE_SPEC_pb_profil_podesavanja_30.md §2.5).
  // read = svi prijavljeni; comment = edit-krug ∪ inzenjer; edit = admin/hr/menadzment/pm/
  // leadpm/poslovni_admin/projektant_vodja; progress = inzenjer restriktovani edit (+edit);
  // reports_all = admin/leadpm/pm/menadzment; reports_own = svako svoje (row u DB);
  // tips_write = edit-krug ∪ inzenjer/projektant_vodja; admin = notif config + kategorije.
  PB_READ: 'pb.read',
  PB_COMMENT: 'pb.comment',
  PB_EDIT: 'pb.edit',
  PB_PROGRESS: 'pb.progress',
  PB_REPORTS_ALL: 'pb.reports_all',
  PB_REPORTS_OWN: 'pb.reports_own',
  PB_TIPS_WRITE: 'pb.tips_write',
  PB_ADMIN: 'pb.admin',
  // Moj profil — self-service za sve (agregator). self = svaki prijavljen; team = menadžerske sekcije.
  PROFILE_SELF: 'profile.self',
  PROFILE_TEAM: 'profile.team',
  // Podešavanja (RBAC admin konzola + matični + sistem) — TALAS D §3.3.
  // users = admin (korisnici/uloge-dozvole/grid urednici/struktura); org_profile = admin/
  // menadzment/pm/leadpm (vrednosti firme/opisi/očekivanja/kompetence); predmet_aktivacija =
  // admin/menadzment; audit + system = admin.
  SETTINGS_USERS: 'settings.users',
  SETTINGS_ORG_PROFILE: 'settings.org_profile',
  SETTINGS_PREDMET_AKTIVACIJA: 'settings.predmet_aktivacija',
  SETTINGS_AUDIT: 'settings.audit',
  SETTINGS_SYSTEM: 'settings.system',
  // Održavanje / CMMS — 3.0 TALAS F (backend docs/design/MODULE_SPEC_odrzavanje_30.md §3, presuda F8).
  // Dvoslojni authz: ove permisije = COARSE kapija (read/report/write = sve aktivne uloge,
  // row-scope presuđuje 102 sy15 RLS politike). FINU odluku UI donosi preko `/maintenance/me`
  // (maintRole operator/technician/chief/management/admin + gates). `admin_ui` je restriktivan
  // (admin/menadzment/magacioner) — SAMO za prikaz admin ekrana, NIJE bezbednosna granica.
  ODRZAVANJE_READ: 'odrzavanje.read',
  ODRZAVANJE_REPORT: 'odrzavanje.report',
  ODRZAVANJE_WRITE: 'odrzavanje.write',
  ODRZAVANJE_ADMIN_UI: 'odrzavanje.admin_ui',
  // Kadrovska (HR) — 3.0 TALAS G (MODULE_SPEC_kadrovska_30.md §2.4 / presuda §7).
  // `kadrovska.read` = KANON vidljivosti modula (paritet 1.0 canAccessKadrovska).
  // Stroža prava po ekranu/akciji: pii (admin∨poslovni_admin — HR NEMA PII!),
  // salary (SAMO admin), contracts_read, grid_edit, vacation_edit, vacreq_manage/admin,
  // attendance (view-only), attendance_shadow, dev_manage. `profile.self` = svaki zaposleni
  // (samo-podnošenje GO/korekcija/„upoznat sam"/samoprocena). Backend guard presuđuje;
  // FE ovim SAMO krije afordanse (zarade/PII se NE prikazuju ulozi bez ključa).
  KADROVSKA_READ: 'kadrovska.read',
  KADROVSKA_EDIT: 'kadrovska.edit',
  KADROVSKA_MANAGE: 'kadrovska.manage',
  KADROVSKA_ADMIN: 'kadrovska.admin',
  KADROVSKA_PII: 'kadrovska.pii',
  KADROVSKA_SALARY: 'kadrovska.salary',
  KADROVSKA_CONTRACTS_READ: 'kadrovska.contracts_read',
  KADROVSKA_GRID_EDIT: 'kadrovska.grid_edit',
  KADROVSKA_VACATION_EDIT: 'kadrovska.vacation_edit',
  KADROVSKA_VACREQ_MANAGE: 'kadrovska.vacreq_manage',
  KADROVSKA_VACREQ_ADMIN: 'kadrovska.vacreq_admin',
  KADROVSKA_ATTENDANCE: 'kadrovska.attendance',
  KADROVSKA_ATTENDANCE_SHADOW: 'kadrovska.attendance_shadow',
  KADROVSKA_DEV_MANAGE: 'kadrovska.dev_manage',
  // Imenik (telefoni) — 1.0 canViewPhoneDirectory krug (admin/menadzment/hr/
  // poslovni_admin); P1a dodaje ključ u BE katalog. Nijedna postojeća permisija
  // ne poklapa taj skup (manage nema menadžment) — zato poseban ključ.
  KADROVSKA_IMENIK: 'kadrovska.imenik',
  // Sastanci + AI asistent — 3.0 TALAS B (backend docs/design/MODULE_SPEC_sastanci_ai_30.md §2).
  // Paritet backend role-permissions: read = canAccessSastanci (admin/leadpm/pm/menadzment/hr/viewer);
  // edit = has_edit_role (+poslovni_admin); manage/weekly_move = admin/menadzment; ai_model = admin.
  // sastanci.weekly_move je SAMO vidljivost dugmadi — pravu odluku presuđuje tabela sast_weekly_movers.
  SASTANCI_READ: 'sastanci.read',
  SASTANCI_EDIT: 'sastanci.edit',
  SASTANCI_MANAGE: 'sastanci.manage',
  SASTANCI_WEEKLY_MOVE: 'sastanci.weekly_move',
  SASTANCI_AI_MODEL: 'sastanci.ai_model',
  // AI asistent = SVE aktivne uloge (1.0 „/ai za sve").
  AI_CHAT: 'ai.chat',
  // Energetika / SCADA — 3.0 TALAS E (backend docs/design/MODULE_SPEC_scada_30.md §2).
  // Paritet žive 1.0 politike: SAMO admin + menadzment (BEZ viewer baseline). U kodu su
  // read/control NAMERNO odvojeni ključevi (ista dodela u v1) — control gate-uje komandni
  // tok (POST /commands + cancel), read sve GET-ove. Presuda E5: `energetika.*`, ne `scada.*`.
  ENERGETIKA_READ: 'energetika.read',
  ENERGETIKA_CONTROL: 'energetika.control',
  // Razvojna faza 2.0 — indeks-stranica WIP modula (Talasi B–G) za testiranje pre
  // promocije u stalni 1.0 hub. Dodeljeno: admin + menadzment + hr/poslovni_admin.
  RAZVOJ_READ: 'razvoj.read',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
