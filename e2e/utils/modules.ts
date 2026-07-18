// Katalog modula (rute sa frontend origin/main). Desktop moduli; /m/* mobilni i
// /kiosk* fullscreen kiosk namerno izostavljeni iz osnovnog smoke prolaza.
export interface ModuleDef {
  key: string; // stabilan id
  name: string; // srpski naziv
  route: string; // putanja
  group: string; // domen
}

export const MODULES: ModuleDef[] = [
  // Proizvodnja
  { key: 'work-orders', name: 'Radni nalozi (RN)', route: '/work-orders', group: 'Proizvodnja' },
  { key: 'tech-processes', name: 'Tehnološki postupci (TP)', route: '/tech-processes', group: 'Proizvodnja' },
  { key: 'kvalitet', name: 'Kontrola kvaliteta', route: '/kvalitet', group: 'Proizvodnja' },
  { key: 'completed-orders', name: 'Završeni nalozi', route: '/completed-orders', group: 'Proizvodnja' },
  { key: 'operations-queue', name: 'Red operacija', route: '/operations-queue', group: 'Proizvodnja' },
  { key: 'plan-proizvodnje', name: 'Plan proizvodnje', route: '/plan-proizvodnje', group: 'Proizvodnja' },
  { key: 'pracenje-proizvodnje', name: 'Praćenje proizvodnje', route: '/pracenje-proizvodnje', group: 'Proizvodnja' },
  { key: 'montaza', name: 'Plan montaže', route: '/montaza', group: 'Proizvodnja' },
  // Projektovanje
  { key: 'pdm', name: 'PDM / Crteži', route: '/pdm', group: 'Projektovanje' },
  { key: 'nacrti', name: 'Nacrti', route: '/nacrti', group: 'Projektovanje' },
  { key: 'handovers', name: 'Primopredaje', route: '/handovers', group: 'Projektovanje' },
  { key: 'pb', name: 'Projektni biro', route: '/pb', group: 'Projektovanje' },
  { key: 'cnc-programs', name: 'CNC programi', route: '/cnc-programs', group: 'Projektovanje' },
  // Logistika
  { key: 'reversi', name: 'Reversi', route: '/reversi', group: 'Logistika' },
  { key: 'part-locations', name: 'Lokacije delova (2.0)', route: '/part-locations', group: 'Logistika' },
  { key: 'lokacije', name: 'Lokacije (1.0)', route: '/lokacije', group: 'Logistika' },
  { key: 'mrp', name: 'Materijali / MRP', route: '/mrp', group: 'Logistika' },
  // Kadrovska / lično
  { key: 'kadrovska', name: 'Kadrovska', route: '/kadrovska', group: 'Kadrovska' },
  { key: 'profil', name: 'Moj profil', route: '/profil', group: 'Kadrovska' },
  // Saradnja
  { key: 'sastanci', name: 'Sastanci', route: '/sastanci', group: 'Saradnja' },
  { key: 'ai', name: 'AI asistent', route: '/ai', group: 'Saradnja' },
  // Oprema / energija
  { key: 'energetika', name: 'Energetika / SCADA', route: '/energetika', group: 'Oprema' },
  { key: 'odrzavanje', name: 'Održavanje (CMMS)', route: '/odrzavanje', group: 'Oprema' },
  { key: 'odrzavanje-masine', name: 'Održavanje — Mašine', route: '/odrzavanje/masine', group: 'Oprema' },
  { key: 'odrzavanje-sredstva', name: 'Održavanje — Sredstva', route: '/odrzavanje/sredstva', group: 'Oprema' },
  { key: 'odrzavanje-vozila', name: 'Održavanje — Vozila', route: '/odrzavanje/vozila', group: 'Oprema' },
  // Šifarnici / master data
  { key: 'customers', name: 'Komitenti', route: '/customers', group: 'Šifarnici' },
  { key: 'projects', name: 'Predmeti', route: '/projects', group: 'Šifarnici' },
  { key: 'structures', name: 'Proizvodne strukture', route: '/structures', group: 'Šifarnici' },
  // Sistem
  { key: 'pocetna', name: 'Početna (HUB)', route: '/pocetna', group: 'Sistem' },
  { key: 'podesavanja', name: 'Podešavanja', route: '/podesavanja', group: 'Sistem' },
  { key: 'syncs', name: 'Sinhronizacije', route: '/syncs', group: 'Sistem' },
  { key: 'session-analytics', name: 'Analitika sesija', route: '/session-analytics', group: 'Sistem' },
  { key: 'production-log', name: 'Evidencija rada', route: '/production-log', group: 'Sistem' },
];
