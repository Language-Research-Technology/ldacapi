import { defineConfig, env } from "prisma/config";
import { loadEnvFile } from 'node:process';
try {
  loadEnvFile();
} catch (error) {  
  process.env.DATABASE_URL = 'postgresql://ldacapi:ldacapi@localhost:5432/ldacapi?schema=public';
}
export default defineConfig({
  schema: "prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});