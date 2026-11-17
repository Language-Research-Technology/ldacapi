import * as z from 'zod';

type Env = Record<string, string | undefined>;

type NodeEnv = 'development' | 'test' | 'production';

export const parseNodeEnv = (env: Env): NodeEnv => z.enum(['development', 'test', 'production']).default('development').parse(env.NODE_ENV);

export const databaseUrlSetting = (nodeEnv: NodeEnv) =>
  nodeEnv === 'production' ? z.string() : z.string().default(`postgresql://ldacapi:ldacapi@localhost:5432/ldacapi${nodeEnv === 'test' ? '_test' : ''}`);

/** `DATABASE_URL` alone, for Prisma's CLI, which needs none of the rest of the configuration */
export const loadDatabaseUrl = (env: Env) => {
  const result = databaseUrlSetting(parseNodeEnv(env)).safeParse(env.DATABASE_URL || undefined);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}\n  → at DATABASE_URL`);
  }
  return result.data;
};
