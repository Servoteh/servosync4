import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';

import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const logDir = path.isAbsolute(config.logger.dir)
  ? config.logger.dir
  : path.resolve(REPO_ROOT, config.logger.dir);

try {
  fs.mkdirSync(logDir, { recursive: true });
} catch (err) {
  console.error('[logger] Ne mogu da kreiram log folder:', logDir, err);
}

const today = new Date().toISOString().slice(0, 10);
const logFile = path.join(logDir, `bridge-${today}.log`);

/**
 * Kombinovani transport:
 *  - JSON u fajl (jednog dana, append) — uvek
 *  - Pretty u stdout — samo ako LOG_PRETTY=true
 *
 * Napomena: pino transport spawn-uje child proces. To radi i pod node-windows
 * servisom, ali stdout u service mode-u nigde ne ide — zato je file log primaran.
 */
const targets = [
  {
    target: 'pino/file',
    level: config.logger.level,
    options: { destination: logFile, mkdir: true },
  },
];

if (config.logger.pretty) {
  targets.push({
    target: 'pino-pretty',
    level: config.logger.level,
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname',
    },
  });
}

export const logger = pino(
  {
    level: config.logger.level,
    base: { instance: config.instanceName },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.transport({ targets }),
);

export function logJob(name) {
  return logger.child({ job: name });
}
