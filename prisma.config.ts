import { env, loadEnvFile } from 'node:process';
import { defineConfig } from 'prisma/config';

const paths = ['./.env'];
if (env.NODE_ENV) {
  paths.unshift(`./.env${env.NODE_ENV}`);
}

for (const path of paths) {
  try {
    loadEnvFile(path);
    break;
  } catch (error) {
    if (error instanceof Error && error.code !== 'ENOENT') throw error;
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
