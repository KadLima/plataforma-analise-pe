const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main(){
  const sessions = await prisma.scanSession.findMany();
  console.log('ScanSessions:', sessions.length);
  const links = await prisma.link.findMany({ take: 3 });
  console.log('Exemplo links:', links);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); prisma.$disconnect(); });
