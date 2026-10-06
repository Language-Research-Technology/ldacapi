import { homedir } from 'node:os';
import { join } from 'node:path';
import { env, loadEnvFile } from 'node:process';
import { defineConfig } from 'prisma/config';
import packageJson from './package.json' with { type: 'json' };

const _name = packageJson.name;
let paths = [join(homedir(), '.env'), './.env'];

if (env.NODE_ENV) {
  paths = [join(homedir(), `.env.${env.NODE_ENV}`), join(homedir(), '.env'), `./.env.${env.NODE_ENV}`, './.env'];
}
for (const path of paths) {
  try {
    loadEnvFile(path);
    break;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') throw error;
  }
}
export default defineConfig({
  schema: 'prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env.DATABASE_URL || 'postgresql://ldacapi:ldacapi@localhost:5432/ldacapi?schema=public',
  },
});
