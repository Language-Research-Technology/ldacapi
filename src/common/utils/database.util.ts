import { PrismaClient } from '@prisma/client';
import { isDevelopment } from '../config';

let prisma: PrismaClient;

export const getPrismaClient = (): PrismaClient => {
  if (!prisma) {
    prisma = new PrismaClient({
      log: isDevelopment ? ['query', 'info', 'warn', 'error'] : ['error'],
    });
  }
  return prisma;
};

export const disconnectPrisma = async (): Promise<void> => {
  if (prisma) {
    await prisma.$disconnect();
  }
};
