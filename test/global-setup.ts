import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

// Each run gets its own database and index so runs never share or destroy each other's data
export default async function setup() {
  // The admin pages link the stylesheet; tests only need it to exist
  if (!existsSync('src/admin/public/admin.css')) {
    execFileSync('pnpm', ['build'], { stdio: 'ignore' });
  }

  process.env.OPEN_LICENSES = 'https://creativecommons.org/licenses/by/4.0/';
  // Configuration is read on import, so only once the environment is complete
  const { loadConfig } = await import('../src/configuration.ts');
  const config = loadConfig({ ...process.env, NODE_ENV: 'test' });
  const { createScratchIndexes } = await import('./scratch-indexes.ts');
  const { databaseUrl, entityIndex, drop } = await createScratchIndexes(
    { databaseUrl: config.databaseUrl, opensearchUrl: config.opensearchUrl, entityIndex: config.search.entityIndex },
    `${process.pid}_${randomBytes(3).toString('hex')}`,
  );
  process.env.DATABASE_URL = databaseUrl.toString();
  process.env.ENTITY_INDEX = entityIndex;
  return drop;
}
