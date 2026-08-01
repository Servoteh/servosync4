/**
 * Instalira Servoteh Bridge kao Windows Service preko `node-windows`.
 * Pokrenuti SAMO iz administratorskog PowerShell-a:
 *   npm run service:install
 *
 * Posle instalacije servis se zove "Servoteh Bridge" i auto-startuje na boot.
 *
 * Logovi servisa idu u 2 mesta:
 *  - Windows Event Viewer → Applications and Services Logs → "Servoteh Bridge"
 *  - logs/bridge-YYYY-MM-DD.log (naš pino fajl)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Service } = require('node-windows');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENTRY_SCRIPT = path.join(REPO_ROOT, 'src', 'index.js');

const svc = new Service({
  name: 'Servoteh Bridge',
  description:
    'Servoteh Bridge: BigTehn (SQL Server, QBigTehn) -> Supabase cache. Read-only sync.',
  script: ENTRY_SCRIPT,
  nodeOptions: ['--enable-source-maps'],
  workingDirectory: REPO_ROOT,
  // Servis čita .env iz workingDirectory, ali node-windows ne forwarduje
  // process env automatski. Bezbednije je staviti env vars u system/user
  // environment kroz Windows ("Edit the system environment variables").
  // Vidi README.md → "Deployment".
  env: [
    { name: 'NODE_ENV', value: 'production' },
  ],
});

svc.on('install', () => {
  console.log('[install] Servis registrovan. Startujem…');
  svc.start();
});

svc.on('alreadyinstalled', () => {
  console.log('[install] Servis je već instaliran. Da reinstaliraš:');
  console.log('  1) npm run service:uninstall');
  console.log('  2) npm run service:install');
  process.exit(1);
});

svc.on('start', () => {
  console.log('[install] Servis je startovan. Status: services.msc → "Servoteh Bridge"');
  console.log('[install] Logovi: logs/bridge-YYYY-MM-DD.log');
});

svc.on('error', (err) => {
  console.error('[install] node-windows error:', err);
  process.exit(1);
});

console.log('[install] Instaliram servis…');
console.log('[install] Entry script:', ENTRY_SCRIPT);
console.log('[install] Working dir :', REPO_ROOT);
svc.install();
