import { defineConfig } from "prisma/config";
import { loadEnvFile, env } from 'node:process';
try {
  const prefix = env.NODE_ENV ? `.${env.NODE_ENV}` : '';
  loadEnvFile(`./.env${prefix}`);
} catch (error) {
  console.log(error);  
  env.DATABASE_URL = 'postgresql://ldacapi:ldacapi@localhost:5432/ldacapi?schema=public';
}
export default defineConfig({
  schema: "prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env.DATABASE_URL || '',
  },
});