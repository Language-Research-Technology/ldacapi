import { dirname, join, resolve } from 'node:path';
import * as z from 'zod';

type Env = Record<string, string | undefined>;

const openLicenses = [
  'https://creativecommons.org/licenses/by/3.0/au/',
  'https://creativecommons.org/licenses/by/4.0/',
  'https://creativecommons.org/licenses/by-nc/4.0/',
  'https://creativecommons.org/licenses/by-nd/3.0/au/',
];

const indexType = {
  RepositoryCollection: 'https://w3id.org/ldac/profile#Collection',
  RepositoryObject: 'https://w3id.org/ldac/profile#Object',
  File: '',
  Person: 'https://w3id.org/ldac/profile#Person',
  Organization: 'https://w3id.org/ldac/profile#Organization',
  SoftwareApplication: 'https://w3id.org/ldac/profile#SoftwareApplication',
};

export function loadConfig(processEnv: Env) {
  const nodeEnv = z.enum(['development', 'test', 'production']).default('development').parse(processEnv.NODE_ENV);
  const isDev = nodeEnv === 'development';

  const devDefault = (value: string) => (nodeEnv === 'production' ? z.string() : z.string().default(value));
  const optional = z.string().default('');

  const result = z
    .object({
      DATABASE_URL: devDefault(`postgresql://ldacapi:ldacapi@localhost:5432/ldacapi${nodeEnv === 'test' ? '_test' : ''}`),
      OPENSEARCH_URL: devDefault('http://localhost:9200'),
      TOKEN_ADMIN: devDefault('1234-1234-1234-1234'),
      OCFL_ROOT: devDefault('storage/ocfl'),
      OCFL_SCRATCH: z.string().optional(),
      LDACAPI_PORT: z.coerce.number().int().default(8080),
      LDACAPI_HOST: z.string().default('localhost'),
      LDACAPI_MAX_PARAM_LENGTH: z.coerce.number().int().default(500),
      LOG_LEVEL: z.string().default(isDev ? 'debug' : 'info'),
      ENTITY_INDEX: z.string().default(nodeEnv === 'test' ? 'entities_test' : 'entities'),
      DEFAULT_LICENSE: optional,
      DEFAULT_METADATA_LICENSE: optional,
      REMS_USER: optional,
      REMS_KEY: optional,
      REMS_ENDPOINT: optional,
      ENROLLMENT_URL: optional,
      OIDC_ENDPOINT: optional,
      OIDC_CLIENT_ID: optional,
      OIDC_CLIENT_SECRET: optional,
    })
    // Treat empty values (e.g. `FOO=` in .env) as unset
    .safeParse(Object.fromEntries(Object.entries(processEnv).filter(([, value]) => value !== '')));
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  const env = result.data;

  return {
    isDev,
    databaseUrl: env.DATABASE_URL,
    opensearchUrl: env.OPENSEARCH_URL,
    port: env.LDACAPI_PORT,
    host: env.LDACAPI_HOST,
    logLevel: env.LOG_LEVEL,
    maxParamLength: env.LDACAPI_MAX_PARAM_LENGTH,
    tokenAdmin: env.TOKEN_ADMIN,
    ocfl: {
      root: resolve(env.OCFL_ROOT),
      scratch: resolve(env.OCFL_SCRATCH ?? join(dirname(env.OCFL_ROOT), 'scratch')),
    },
    defaultLicense: env.DEFAULT_LICENSE,
    defaultMetadataLicense: env.DEFAULT_METADATA_LICENSE,
    openLicenses,
    prefix: '/api',
    prefixAuth: '',
    rems: {
      user: env.REMS_USER,
      key: env.REMS_KEY,
      endpoint: env.REMS_ENDPOINT,
    },
    enrollmentUrl: env.ENROLLMENT_URL,
    oidc: {
      endpoint: env.OIDC_ENDPOINT,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      userinfoEndpoint: '',
    },
    indexType,
    search: { entityIndex: env.ENTITY_INDEX },
  };
}

export const config = loadConfig(process.env);
