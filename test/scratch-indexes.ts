import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@opensearch-project/opensearch';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { deleteSearchIndex } from '../src/search-backend.ts';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const prismaFor = (url: URL) => new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });

/**
 * A new database, migrated, and a search index name, each named apart from the configured ones by `suffix`, so runs never
 * share or destroy each other's data. `drop` removes both
 */
export async function createScratchIndexes(
  { databaseUrl, opensearchUrl, entityIndex }: { databaseUrl: string; opensearchUrl: string; entityIndex: string },
  suffix: string,
) {
  const scratchUrl = new URL(databaseUrl);
  const database = `${scratchUrl.pathname.slice(1)}_${suffix}`;
  scratchUrl.pathname = `/${database}`;
  const scratchIndex = `${entityIndex}_${suffix}`;

  const maintenanceUrl = new URL(databaseUrl);
  maintenanceUrl.pathname = '/postgres';
  const admin = prismaFor(maintenanceUrl);
  const opensearch = new Client({ node: opensearchUrl });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);

  const drop = async () => {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await deleteSearchIndex(opensearch, scratchIndex);
    await opensearch.indices.deleteIndexTemplate({ name: scratchIndex }).catch(() => {});
    await Promise.all([admin.$disconnect(), opensearch.close()]);
  };

  try {
    await promisify(execFile)('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DATABASE_URL: scratchUrl.toString() },
    });
  } catch (error) {
    await drop();
    throw error;
  }
  return { databaseUrl: scratchUrl, entityIndex: scratchIndex, drop };
}
