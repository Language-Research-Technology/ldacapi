import middie from '@fastify/middie';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import Provider, { type Account, type Configuration, errors, type InteractionResults, type KoaContextWithOIDC } from 'oidc-provider';
import type { IDToken } from 'openid-client';
import { config } from '../configuration.ts';
import { logger } from '../logger.ts';
import { prisma } from '../prisma.ts';
import { PrismaAdapter } from './adapter.ts';
import { loadSigningKeys } from './keys.ts';
import { createUpstream, type UpstreamChecks } from './upstream.ts';

const log = logger.child({ module: 'oidc' });

const routes = {
  authorization: '/oauth/authorize',
  token: '/oauth/token',
  jwks: '/oauth/jwks',
  userinfo: '/oauth/userinfo',
  end_session: '/oauth/session/end',
  revocation: '/oauth/token/revocation',
} satisfies Configuration['routes'];

const providerPaths = ['/.well-known/openid-configuration', ...Object.values(routes)];

const isProviderPath = (url = '') => {
  const [path = ''] = url.split('?');
  return providerPaths.some((providerPath) => path === providerPath || path.startsWith(`${providerPath}/`));
};

const DAY = 24 * 60 * 60;
const epochTime = () => Math.floor(Date.now() / 1000);
const SCOPES = 'openid profile email offline_access';

const findAccount = async (_ctx: KoaContextWithOIDC, sub: string): Promise<Account | undefined> => {
  const user = await prisma.user.findUnique({ where: { sub } });
  if (!user) {
    return undefined;
  }
  return {
    accountId: sub,
    claims: () => ({
      sub,
      name: user.name ?? undefined,
      email: user.email ?? undefined,
      given_name: user.givenName ?? undefined,
      family_name: user.familyName ?? undefined,
    }),
  };
};

const str = (value: unknown) => (typeof value === 'string' ? value : null);

const saveUser = ({ sub, ...claims }: IDToken) => {
  const details = {
    name: str(claims.name),
    email: str(claims.email),
    givenName: str(claims.given_name),
    familyName: str(claims.family_name),
  };
  return prisma.user.upsert({ where: { sub }, create: { sub, ...details }, update: details });
};

// Clients come only from our configuration, so they get every scope they ask for without a consent screen
const loadExistingGrant = async (ctx: KoaContextWithOIDC) => {
  const { client, session, provider } = ctx.oidc;
  if (!client || !session?.accountId) {
    return undefined;
  }
  const grantId = ctx.oidc.result?.consent?.grantId || session.grantIdFor(client.clientId);
  const grant = (grantId && (await provider.Grant.find(grantId))) || new provider.Grant({ clientId: client.clientId, accountId: session.accountId });
  grant.addOIDCScope(SCOPES);
  grant.addResourceScope(config.auth.audience, SCOPES);
  await grant.save();
  return grant;
};

const createProvider = async () => {
  const { audience } = config.auth;
  const provider = new Provider(config.auth.issuer, {
    adapter: PrismaAdapter,
    clients: config.auth.clients,
    jwks: (await loadSigningKeys(prisma)) as Configuration['jwks'],
    routes,
    findAccount,
    loadExistingGrant,
    claims: {
      openid: ['sub'],
      profile: ['name', 'given_name', 'family_name'],
      email: ['email'],
    },
    // ID tokens carry the profile and email claims even though an access token is issued too
    conformIdTokenClaims: false,
    // Oni gets refresh tokens without having to send `prompt=consent` for `offline_access`
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    ttl: {
      Interaction: 60 * 60,
      Session: (_ctx, session) => Math.max(1, (session.loginTs ?? epochTime()) + 30 * DAY - epochTime()),
      Grant: 30 * DAY,
      RefreshToken: 14 * DAY,
    },
    interactions: {
      url: (_ctx, interaction) => `/oauth/interaction/${interaction.uid}`,
    },
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
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

const queryOf = (url: string) => new URL(url, 'http://localhost').searchParams;

export const oidcProvider: FastifyPluginAsync = fp(async (fastify) => {
  const provider = await createProvider();
  const callback = provider.callback();
  const upstream = createUpstream({ ...config.auth.upstream, redirectUri: `${config.auth.issuer}/oauth/callback` });
  const upstreamChecks = new PrismaAdapter('UpstreamChecks');

  fastify.addHook('onReady', (done) => {
    upstream.discover().catch((err: unknown) => {
      log.error(
        { err },
        `Can't fetch the upstream provider's discovery document from OIDC_UPSTREAM_ISSUER (${config.auth.upstream.issuer}); sign-in will fail until it can`,
      );
    });
    done();
  });

  await fastify.register(middie);
  fastify.use((req, res, next) => (isProviderPath(req.url) ? callback(req, res) : next()));

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

  fastify.get<{ Params: { uid: string } }>('/oauth/interaction/:uid', async (request, reply) => {
    const interaction = await interactionFor(request, reply);
    if (!interaction) {
      return reply.badRequest('Sign-in has expired or was started elsewhere');
    }
    const { url, checks } = await upstream.authorizationUrl(interaction.uid);
    await upstreamChecks.upsert(interaction.uid, { checks }, interaction.exp - epochTime());
    return reply.redirect(url.toString(), 303);
  });

  // The upstream provider's redirect URI is fixed, so send the browser on to the interaction it belongs to
  fastify.get<{ Querystring: { state?: string } }>('/oauth/callback', async (request, reply) => {
    const { state } = request.query;
    if (!state) {
      return reply.badRequest('Missing state');
    }
    return reply.redirect(`/oauth/interaction/${encodeURIComponent(state)}/callback?${queryOf(request.url)}`, 303);
  });

  fastify.get<{ Params: { uid: string } }>('/oauth/interaction/:uid/callback', async (request, reply) => {
    const interaction = await interactionFor(request, reply);
    const checks = interaction && ((await upstreamChecks.find(interaction.uid))?.checks as UpstreamChecks | undefined);
    if (!interaction || !checks) {
      return reply.badRequest('Sign-in has expired or was started elsewhere');
    }
    await upstreamChecks.destroy(interaction.uid);

    let result: InteractionResults;
    try {
      const user = await saveUser(await upstream.claims(queryOf(request.url), checks));
      result = { login: { accountId: user.sub } };
    } catch (err) {
      log.warn({ err }, 'Sign-in at the upstream provider failed');
      result = { error: 'access_denied', error_description: 'Sign-in at the upstream provider failed' };
    }
    reply.hijack();
    await provider.interactionFinished(request.raw, reply.raw, result, { mergeWithLastSubmission: false });
  });
});
