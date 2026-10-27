import type { FastifyPluginAsync, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import Provider, { type ClientMetadata, type Configuration, errors, type InteractionResults, type KoaContextWithOIDC } from 'oidc-provider';
import type { AuthConfig, OidcClient } from '../configuration.ts';
import { logger } from '../logger.ts';
import { deleteExpired, PrismaAdapter } from './adapter.ts';
import { createUpstream, type UpstreamChecks } from './upstream.ts';
import { findAccount, saveUser } from './users.ts';

const log = logger.child({ module: 'oidc' });

const routes = {
  authorization: '/oauth/authorize',
  token: '/oauth/token',
  jwks: '/oauth/jwks',
  revocation: '/oauth/token/revocation',
} satisfies Configuration['routes'];

const DAY = 24 * 60 * 60;
const epochTime = () => Math.floor(Date.now() / 1000);
const SCOPES = 'openid profile email';
const SIGN_IN_EXPIRED = 'Sign-in has expired or was started elsewhere';

const interactionPath = (uid: string) => `/oauth/interaction/${uid}`;

// Clients come only from our configuration, so they get every scope they ask for that we support, without a consent screen
const loadExistingGrant = (audience: string) => async (ctx: KoaContextWithOIDC) => {
  const { client, session, provider } = ctx.oidc;
  if (!client || !session?.accountId) {
    return undefined;
  }
  const grantId = session.grantIdFor(client.clientId);
  const existing = grantId ? await provider.Grant.find(grantId) : undefined;
  const grant = existing ?? new provider.Grant({ clientId: client.clientId, accountId: session.accountId });
  const scopes = () => [grant.getOIDCScope(), grant.getResourceScope(audience)].join('|');
  const granted = scopes();
  const requested = SCOPES.split(' ')
    .filter((scope) => ctx.oidc.requestParamScopes.has(scope))
    .join(' ');
  grant.addOIDCScope(requested);
  grant.addResourceScope(audience, requested);
  if (!existing || scopes() !== granted) {
    await grant.save();
  }
  return grant;
};

const toClientMetadata = (client: OidcClient): ClientMetadata => (client.client_secret ? client : { ...client, token_endpoint_auth_method: 'none' });

const createProvider = ({ issuer, audience, clients, signingKeys, cookieKeys }: AuthConfig) => {
  const provider = new Provider(issuer, {
    adapter: PrismaAdapter,
    clients: clients.map(toClientMetadata),
    clientDefaults: { grant_types: ['authorization_code', 'refresh_token'] },
    jwks: { keys: signingKeys },
    cookies: { keys: cookieKeys },
    routes,
    findAccount,
    loadExistingGrant: loadExistingGrant(audience),
    claims: {
      profile: ['name', 'given_name', 'family_name'],
      email: ['email'],
    },
    // ID tokens carry the profile and email claims even though an access token is issued too
    conformIdTokenClaims: false,
    // Refresh tokens without `offline_access`, which would need `prompt=consent`
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    // Every use issues a new refresh token, so its TTL is an idle timeout
    rotateRefreshToken: true,
    ttl: {
      Session: (_ctx, session) => Math.max(1, (session.loginTs ?? epochTime()) + 30 * DAY - epochTime()),
      Grant: 30 * DAY,
      RefreshToken: 14 * DAY,
    },
    interactions: {
      url: (_ctx, interaction) => interactionPath(interaction.uid),
    },
    features: {
      devInteractions: { enabled: false },
      // ID tokens carry the claims, and access tokens are for the API, not userinfo
      userinfo: { enabled: false },
      revocation: { enabled: true },
      // Oni signs out locally; no client sends users to end_session
      rpInitiatedLogout: { enabled: false },
      resourceIndicators: {
        enabled: true,
        // Clients such as Oni send no `resource`, and should still get tokens for the API
        defaultResource: () => audience,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, resourceIndicator) => {
          if (resourceIndicator !== audience) {
            throw new errors.InvalidTarget();
          }
          return { scope: SCOPES, audience, accessTokenFormat: 'jwt', accessTokenTTL: 15 * 60 };
        },
      },
    },
  });
  provider.proxy = true;
  provider.on('server_error', (_ctx, err) => log.error({ err }, 'OIDC provider error'));

  return provider;
};

const HOUR_MS = 60 * 60 * 1000;

export const oidcProvider: FastifyPluginAsync<{ auth: AuthConfig }> = async (fastify, { auth }) => {
  const provider = createProvider(auth);
  const callback = provider.callback();
  const upstream = createUpstream({ ...auth.upstream, redirectUri: `${auth.issuer}/oauth/callback`, scope: SCOPES });
  const upstreamChecks = new PrismaAdapter('UpstreamChecks');
  const issuer = new URL(auth.issuer);

  // Endpoint URLs and cookie security follow our issuer, not the Host or X-Forwarded-* a request claims
  fastify.addHook('onRequest', async (request) => {
    request.raw.headers['x-forwarded-host'] = issuer.host;
    request.raw.headers['x-forwarded-proto'] = issuer.protocol.slice(0, -1);
  });

  fastify.addHook('onReady', (done) => {
    upstream.discover().catch((err: unknown) => {
      log.error(
        { err },
        `Can't fetch the upstream provider's discovery document from OIDC_UPSTREAM_ISSUER (${auth.upstream.issuer}); sign-in will fail until it can`,
      );
    });
    done();
  });

  const cleanup = setInterval(() => {
    deleteExpired().catch((err: unknown) => log.error({ err }, "Can't delete expired OIDC provider state"));
  }, HOUR_MS).unref();
  fastify.addHook('onClose', async () => clearInterval(cleanup));

  // Hands the request to oidc-provider before Fastify reads its body
  const handOff: onRequestHookHandler = async (request, reply) => {
    reply.hijack();
    await callback(request.raw, reply.raw);
  };
  for (const path of ['/.well-known/openid-configuration', ...Object.values(routes)]) {
    for (const url of [path, `${path}/*`]) {
      fastify.route({ method: ['GET', 'POST'], url, onRequest: handOff, handler: async () => {} });
    }
  }

  // The interaction cookie is only sent to the interaction's own path, which proves the browser started it
  const interactionFor = async (request: FastifyRequest<{ Params: { uid: string } }>, reply: FastifyReply) => {
    try {
      const interaction = await provider.interactionDetails(request.raw, reply.raw);
      return interaction.uid === request.params.uid ? interaction : undefined;
    } catch (err) {
      if (err instanceof errors.SessionNotFound) {
        return undefined;
      }
      throw err;
    }
  };

  fastify.get<{ Params: { uid: string } }>(interactionPath(':uid'), async (request, reply) => {
    const interaction = await interactionFor(request, reply);
    if (!interaction) {
      return reply.badRequest(SIGN_IN_EXPIRED);
    }
    // A reload or second tab reuses the checks, so whichever upstream response arrives still matches
    const stored = await upstreamChecks.findOrInsert(interaction.uid, { checks: upstream.newChecks(interaction.uid) }, interaction.exp - epochTime());
    const checks = stored?.checks as UpstreamChecks | undefined;
    if (!checks) {
      return reply.badRequest(SIGN_IN_EXPIRED);
    }
    return reply.redirect((await upstream.authorizationUrl(checks)).toString(), 303);
  });

  // The upstream provider's redirect URI is fixed, so send the browser on to the interaction it belongs to
  fastify.get<{ Querystring: Record<string, string> }>('/oauth/callback', async (request, reply) => {
    const { state } = request.query;
    if (!state) {
      return reply.badRequest('Missing state');
    }
    return reply.redirect(`${interactionPath(encodeURIComponent(state))}/callback?${new URLSearchParams(request.query)}`, 303);
  });

  fastify.get<{ Params: { uid: string }; Querystring: Record<string, string> }>(`${interactionPath(':uid')}/callback`, async (request, reply) => {
    const interaction = await interactionFor(request, reply);
    const checks = interaction && ((await upstreamChecks.find(interaction.uid))?.checks as UpstreamChecks | undefined);
    if (!interaction || !checks) {
      return reply.badRequest(SIGN_IN_EXPIRED);
    }
    await upstreamChecks.destroy(interaction.uid);

    let result: InteractionResults;
    try {
      const user = await saveUser(await upstream.claims(request.query, checks));
      result = { login: { accountId: user.sub } };
    } catch (err) {
      log.warn({ err }, 'Sign-in at the upstream provider failed');
      result = { error: 'access_denied', error_description: 'Sign-in at the upstream provider failed' };
    }
    reply.hijack();
    await provider.interactionFinished(request.raw, reply.raw, result, { mergeWithLastSubmission: false });
  });
};
