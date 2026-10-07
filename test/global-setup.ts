import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Client } from '@opensearch-project/opensearch';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadConfig } from '../src/configuration.ts';
import { PrismaClient } from '../src/generated/prisma/client.ts';

// Each run gets its own database and index so runs never share or destroy each other's data
export default async function setup() {
  const config = loadConfig({ ...process.env, NODE_ENV: 'test' });
  const suffix = `${process.pid}_${randomBytes(3).toString('hex')}`;

  const databaseUrl = new URL(config.databaseUrl);
  const database = `${databaseUrl.pathname.slice(1)}_${suffix}`;
  databaseUrl.pathname = `/${database}`;
  const entityIndex = `${config.search.entityIndex}_${suffix}`;

  const maintenanceUrl = new URL(config.databaseUrl);
  maintenanceUrl.pathname = '/postgres';
  const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: maintenanceUrl.toString() }) });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);

  process.env.DATABASE_URL = databaseUrl.toString();
  process.env.ENTITY_INDEX = entityIndex;
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { stdio: 'ignore', env: process.env });

  return async () => {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.$disconnect();
    const opensearch = new Client({ node: config.opensearchUrl });
    await opensearch.indices.delete({ index: entityIndex, ignore_unavailable: true });
  };
}
