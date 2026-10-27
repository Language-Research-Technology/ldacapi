import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import * as z from 'zod';
import { generateCookieKey, generateSigningKey, type Jwk, SIGNING_ALG } from './oidc/keys.ts';

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

export type OidcClient = z.infer<typeof oidcClient>;

const json = z.string().transform((value, ctx) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid JSON' });
    return z.NEVER;
  }
});

const oidcClients = json.pipe(z.array(oidcClient));

const privateRsaJwk = z.looseObject({ kty: z.literal('RSA'), kid: z.string().min(1), alg: z.literal(SIGNING_ALG) }).refine((jwk) => {
  try {
    const key = createPrivateKey({ key: jwk, format: 'jwk' });
    const probe = Buffer.from('probe');
    return verify('sha256', probe, createPublicKey(key), sign('sha256', probe, key));
  } catch {
    return false;
  }
}, 'Not a valid RSA private key');

const signingKeys = json.pipe(z.object({ keys: z.array(privateRsaJwk).min(1, 'Needs at least one key') }));

const cookieKeys = z
  .string()
  .transform((value) => value.split(',').map((key) => key.trim()))
  .pipe(z.array(z.string().min(32, 'Each key must be at least 32 characters')));

const REQUIRED_WITH_UPSTREAM = 'Required when OIDC_UPSTREAM_ISSUER is set';

const requiredWithUpstream = (production: boolean) => {
  // Throwaway keys outside production, so sign-in works with no configuration
  const key = <T extends object>(generate: () => T) => {
    const required = z.custom<T>((value) => value !== undefined, 'Required in production when OIDC_UPSTREAM_ISSUER is set');
    return production ? required : required.default(generate);
  };
  return z.object({
    OIDC_ISSUER: z.string(REQUIRED_WITH_UPSTREAM),
    OIDC_CLIENTS: z.array(oidcClient).min(1, 'Needs at least one client when OIDC_UPSTREAM_ISSUER is set'),
    OIDC_UPSTREAM_CLIENT_ID: z.string(REQUIRED_WITH_UPSTREAM),
    OIDC_UPSTREAM_CLIENT_SECRET: z.string(REQUIRED_WITH_UPSTREAM),
    OIDC_SIGNING_KEYS: key<{ keys: Jwk[] }>(() => ({ keys: [generateSigningKey()] })),
    OIDC_COOKIE_KEYS: key<string[]>(() => [generateCookieKey()]),
  });
};

export function loadConfig(processEnv: Env) {
  const nodeEnv = z.enum(['development', 'test', 'production']).default('development').parse(processEnv.NODE_ENV);
  const isDev = nodeEnv === 'development';

  const devDefault = (value: string) => (nodeEnv === 'production' ? z.string() : z.string().default(value));
  const optional = z.string().default('');
  const url = nodeEnv === 'production' ? z.url({ protocol: /^https$/, error: 'Must be an https URL in production' }) : z.url();
  const origin = url.transform((value, ctx) => {
    const { origin, pathname, search, hash } = new URL(value);
    if (pathname !== '/' || search || hash) {
      ctx.addIssue({ code: 'custom', message: 'Must be an origin, with no path, query or hash' });
      return z.NEVER;
    }
    return origin;
  });
  const prefix = '/api';

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
      OIDC_ISSUER: nodeEnv === 'production' ? origin.optional() : origin.default('http://localhost:8080'),
      OIDC_CLIENTS: oidcClients.default([]),
      OIDC_UPSTREAM_ISSUER: url.optional(),
      OIDC_UPSTREAM_CLIENT_ID: z.string().optional(),
      OIDC_UPSTREAM_CLIENT_SECRET: z.string().optional(),
      OIDC_SIGNING_KEYS: signingKeys.optional(),
      OIDC_COOKIE_KEYS: cookieKeys.optional(),
    })
    .transform((env, ctx) => {
      const {
        OIDC_ISSUER,
        OIDC_CLIENTS,
        OIDC_UPSTREAM_ISSUER,
        OIDC_UPSTREAM_CLIENT_ID,
        OIDC_UPSTREAM_CLIENT_SECRET,
        OIDC_SIGNING_KEYS,
        OIDC_COOKIE_KEYS,
        ...rest
      } = env;
      if (!OIDC_UPSTREAM_ISSUER) {
        return { ...rest, auth: undefined };
      }
      const required = requiredWithUpstream(nodeEnv === 'production').safeParse(env);
      if (!required.success) {
        for (const issue of required.error.issues) {
          ctx.addIssue({ ...issue });
        }
        return z.NEVER;
      }
      const { data } = required;
      const auth = {
        issuer: data.OIDC_ISSUER,
        audience: `${data.OIDC_ISSUER}${prefix}`,
        clients: data.OIDC_CLIENTS,
        upstream: { issuer: OIDC_UPSTREAM_ISSUER, clientId: data.OIDC_UPSTREAM_CLIENT_ID, clientSecret: data.OIDC_UPSTREAM_CLIENT_SECRET },
        signingKeys: data.OIDC_SIGNING_KEYS.keys,
        cookieKeys: data.OIDC_COOKIE_KEYS,
      };
      return { ...rest, auth };
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
    prefix,
    rems: {
      user: env.REMS_USER,
      key: env.REMS_KEY,
      endpoint: env.REMS_ENDPOINT,
    },
    enrollmentUrl: env.ENROLLMENT_URL,
    auth: env.auth,
    indexType,
    search: { entityIndex: env.ENTITY_INDEX },
  };
}

export const config = loadConfig(process.env);

export type AuthConfig = NonNullable<typeof config.auth>;
