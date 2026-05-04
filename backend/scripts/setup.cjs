/**
 * Local DB bootstrap: Docker Postgres (healthy), Prisma migrate deploy, generate.
 * Run from backend/ (package.json root): npm run setup (after npm install) or npm run bootstrap.
 */
const { copyFileSync, existsSync } = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');
const envExamplePath = path.join(root, '.env.example');

function run(cmd, opts = {}) {
  execSync(cmd, {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, ...opts.env },
    ...opts,
  });
}

function main() {
  if (!existsSync(envExamplePath)) {
    console.error('Missing .env.example. Cannot create .env.');
    process.exit(1);
  }

  if (!existsSync(envPath)) {
    copyFileSync(envExamplePath, envPath);
    console.log('Created .env from .env.example (edit if needed).\n');
  } else {
    console.log('Using existing .env\n');
  }

  console.log('Starting PostgreSQL (docker compose, wait until healthy)...\n');
  try {
    run('docker compose up -d --wait db');
  } catch {
    console.error(
      '\nDocker failed. Is Docker running? Try: docker compose up -d db\n',
    );
    process.exit(1);
  }

  console.log('\nApplying Prisma migrations...\n');
  try {
    run('npm run migrate:prod');
  } catch {
    console.error(
      '\nMigration failed. Common fixes:\n' +
        '  - P3005 / non-empty DB: npm run docker:db:fresh  then  npm run migrate:prod\n' +
        '  - P3009 failed migration: npm run docker:db:fresh  then  npm run migrate:prod\n' +
        'See README.md → Troubleshooting.\n',
    );
    process.exit(1);
  }

  console.log('\nGenerating Prisma Client...\n');
  run('npm run prisma:generate');

  console.log(
    '\nSetup finished. Start the API:\n  npm run start:dev\n' +
      'Health check: GET http://localhost:3000/api/health (or your PORT from .env)\n',
  );
}

main();
