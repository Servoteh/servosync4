// Uklanja "Kotlarnica SCADA" Windows servis.  PowerShell kao Administrator:
//   npm run service:uninstall
const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'Kotlarnica SCADA',
  script: path.join(path.resolve(__dirname, '..'), 'server.js'),
});
svc.on('uninstall', () => console.log('[uninstall] Servis uklonjen.'));
svc.on('error', (e) => { console.error('[uninstall] greska:', e); process.exit(1); });
console.log('[uninstall] Uklanjam servis "Kotlarnica SCADA"…');
svc.uninstall();
