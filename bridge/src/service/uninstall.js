/**
 * Uklanja Servoteh Bridge Windows servis.
 * Pokrenuti SAMO iz administratorskog PowerShell-a:
 *   npm run service:uninstall
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
  script: ENTRY_SCRIPT,
});

svc.on('uninstall', () => {
  console.log('[uninstall] Servis uklonjen.');
  console.log('[uninstall] Provera: services.msc → "Servoteh Bridge" više ne postoji.');
});

svc.on('alreadyuninstalled', () => {
  console.log('[uninstall] Servis nije instaliran (ništa za skinuti).');
});

svc.on('error', (err) => {
  console.error('[uninstall] node-windows error:', err);
  process.exit(1);
});

console.log('[uninstall] Skidam servis…');
svc.uninstall();
