// Instalira "Kotlarnica SCADA" kao Windows servis (node-windows).
// Pokrenuti iz PowerShell-a KAO ADMINISTRATOR:  npm run service:install
// (obrazac preuzet iz servoteh-bridge)
const path = require('path');
const { Service } = require('node-windows');

const ROOT = path.resolve(__dirname, '..');

// Env vrednosti se "peku" u servis. Pre instalacije ih postavi u PowerShell-u, npr:
//   $env:SIMULATE="false"; $env:PLC_IP="192.168.75.25"
// ili ostavi prazno pa koristi default-e ispod.
const E = (name, def) => ({ name, value: process.env[name] || def });

const svc = new Service({
  name: 'Kotlarnica SCADA',
  description: 'Servoteh kotlarnica SCADA — PCOM most ka Unitronics JZ20-J-T40 + web UI.',
  script: path.join(ROOT, 'server.js'),
  workingDirectory: ROOT,
  nodeOptions: ['--enable-source-maps'],
  env: [
    { name: 'NODE_ENV', value: 'production' },
    E('SIMULATE', 'false'),
    E('PLC_IP', '192.168.75.25'),
    E('PLC_PORT', '502'),
    E('PLC_UNIT', '1'),
    E('HTTP_PORT', '3000'),
    E('ALERT_TELEGRAM_BOT_TOKEN', ''),
    E('ALERT_TELEGRAM_CHAT_ID', ''),
  ],
});

svc.on('install', () => { console.log('[install] Servis registrovan. Startujem…'); svc.start(); });
svc.on('alreadyinstalled', () => {
  console.log('[install] Vec instaliran. Da reinstaliras: npm run service:uninstall pa npm run service:install');
  process.exit(1);
});
svc.on('start', () => console.log('[install] OK — servis "Kotlarnica SCADA" radi. Provera: Get-Service "Kotlarnica SCADA"'));
svc.on('error', (e) => { console.error('[install] greska:', e); process.exit(1); });

console.log('[install] Entry:', path.join(ROOT, 'server.js'));
console.log('[install] Mod:', process.env.SIMULATE === 'true' ? 'SIMULACIJA' : `PRAVI PLC ${process.env.PLC_IP || '192.168.75.25'}`);
svc.install();
