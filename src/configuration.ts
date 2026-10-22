import { dirname, join, resolve } from 'node:path';
import type { ClientMetadata } from 'oidc-provider';
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

const oidcClient = z.strictObject({
  client_id: z.string().min(1),
  client_secret: z.string().min(1).optional(),
  redirect_uris: z.array(z.url()).min(1),
  post_logout_redirect_uris: z.array(z.url()).optional(),
});

const isJson = (value: string) => {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
};

const oidcClients = z
  .string()
  .refine(isJson, 'Invalid JSON')
  .transform((value) => JSON.parse(value))
  .pipe(z.array(oidcClient))
  .transform((clients) =>
    clients.map(
      (client): ClientMetadata => ({
        ...client,
        grant_types: ['authorization_code', 'refresh_token'],
        ...(client.client_secret ? {} : { token_endpoint_auth_method: 'none' }),
      }),
    ),
  );

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
      LOG_LEVEL: z.string().default({ development: 'debug', test: 'silent', production: 'info' }[nodeEnv]),
      ENTITY_INDEX: z.string().default(nodeEnv === 'test' ? 'entities_test' : 'entities'),
      DEFAULT_LICENSE: optional,
      DEFAULT_METADATA_LICENSE: optional,
      REMS_USER: optional,
      REMS_KEY: optional,
      REMS_ENDPOINT: optional,
      ENROLLMENT_URL: optional,
      OIDC_ISSUER: nodeEnv === 'production' ? z.url().optional() : z.url().default('http://localhost:8080'),
      OIDC_CLIENTS: oidcClients.default([]),
      OIDC_UPSTREAM_ISSUER: z.url().optional(),
      OIDC_UPSTREAM_CLIENT_ID: optional,
      OIDC_UPSTREAM_CLIENT_SECRET: optional,
    })
    .superRefine((env, ctx) => {
      if (!env.OIDC_UPSTREAM_ISSUER) {
        return;
      }
      for (const key of ['OIDC_ISSUER', 'OIDC_UPSTREAM_CLIENT_ID', 'OIDC_UPSTREAM_CLIENT_SECRET'] as const) {
        if (!env[key]) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'Required when OIDC_UPSTREAM_ISSUER is set' });
        }
      }
    })
    // Treat empty values (e.g. `FOO=` in .env) as unset
    .safeParse(Object.fromEntries(Object.entries(processEnv).filter(([, value]) => value !== '')));
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  const env = result.data;
  const prefix = '/api';
  const issuer = (env.OIDC_ISSUER ?? '').replace(/\/$/, '');

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
    prefix,
    rems: {
      user: env.REMS_USER,
      key: env.REMS_KEY,
      endpoint: env.REMS_ENDPOINT,
    },
    enrollmentUrl: env.ENROLLMENT_URL,
    auth: {
      enabled: Boolean(env.OIDC_UPSTREAM_ISSUER),
      issuer,
      audience: `${issuer}${prefix}`,
      clients: env.OIDC_CLIENTS,
      upstream: {
        issuer: env.OIDC_UPSTREAM_ISSUER ?? '',
        clientId: env.OIDC_UPSTREAM_CLIENT_ID,
        clientSecret: env.OIDC_UPSTREAM_CLIENT_SECRET,
      },
    },
    indexType,
    search: { entityIndex: env.ENTITY_INDEX },
  };
}

export const config = loadConfig(process.env);
