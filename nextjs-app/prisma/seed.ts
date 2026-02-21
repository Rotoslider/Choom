/**
 * Prisma seed script — creates a starter Choom so the app works immediately.
 * Run: npx prisma db push && npx prisma db seed
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.choom.findFirst();
  if (existing) {
    console.log(`Database already has a Choom ("${existing.name}"). Skipping seed.`);
    return;
  }

  const choom = await prisma.choom.create({
    data: {
      name: 'Choom',
      description: 'Your AI companion',
      systemPrompt: [
        'You are a helpful, friendly AI companion.',
        'You have access to tools for weather, web search, file management, image generation, and more.',
        'Be conversational and natural. Use your tools when they would help answer the user\'s questions.',
        'Keep responses concise unless asked for detail.',
      ].join('\n'),
      voiceId: 'sophie',
    },
  });

  console.log(`Created starter Choom: "${choom.name}" (${choom.id})`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
