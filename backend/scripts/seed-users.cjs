// Seed two login users (idempotent — upsert by email).
// Run: node scripts/seed-users.cjs
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

const USERS = [
  { email: 'admin@servoteh.local', password: 'Admin123!', fullName: 'Administrator', role: 'ADMIN' },
  { email: 'user@servoteh.local', password: 'User123!', fullName: 'Korisnik', role: 'USER' },
];

(async () => {
  for (const u of USERS) {
    const passwordHash = await bcrypt.hash(u.password, 10);
    const saved = await prisma.user.upsert({
      where: { email: u.email },
      create: { email: u.email, passwordHash, fullName: u.fullName, role: u.role, active: true },
      update: { passwordHash, fullName: u.fullName, role: u.role, active: true },
    });
    console.log(`✓ ${saved.email}  (role ${saved.role}, id ${saved.id})`);
  }
  console.log('\nLozinke:');
  USERS.forEach((u) => console.log(`  ${u.email} / ${u.password}`));
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('Seed error:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
