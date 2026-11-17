import { loadEnvFile } from 'node:process';
import { defineConfig } from 'prisma/config';
import { loadDatabaseUrl } from './src/database-url.ts';

try {
  loadEnvFile('.env');
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
    throw error;
  }
}

export default defineConfig({
  schema: 'prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: loadDatabaseUrl(process.env),
  },
});
