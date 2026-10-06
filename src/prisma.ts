import { PrismaPg } from '@prisma/adapter-pg';
import { config } from './configuration.ts';
import { PrismaClient } from './generated/prisma/client.ts';

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.databaseUrl }),
});
