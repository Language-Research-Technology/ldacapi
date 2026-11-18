import { PrismaPg } from '@prisma/adapter-pg';
import { config } from './configuration.ts';
import { PrismaClient } from './generated/prisma/client.ts';

export const prisma = new PrismaClient({
  // Without JIT: every query here is short, and Postgres can overestimate one's cost (such as Oni's aggregates read, with no
  // statistics or many aggregate rows for an entity), then spend longer compiling it than running it
  adapter: new PrismaPg({ connectionString: config.databaseUrl, options: '-c jit=off' }),
});
