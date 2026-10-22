import middie from '@fastify/middie';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import Provider, { type Configuration, errors } from 'oidc-provider';
import { config } from '../configuration.ts';
import { logger } from '../logger.ts';
import { prisma } from '../prisma.ts';
import { PrismaAdapter } from './adapter.ts';
import { loadSigningKeys } from './keys.ts';

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

const createProvider = async () => {
  const { audience } = config.auth;
  const provider = new Provider(config.auth.issuer, {
    adapter: PrismaAdapter,
    clients: config.auth.clients,
    jwks: (await loadSigningKeys(prisma)) as Configuration['jwks'],
    routes,
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
          return { scope: 'openid profile email offline_access', audience, accessTokenFormat: 'jwt', accessTokenTTL: 15 * 60 };
        },
      },
    },
  });
  provider.proxy = true;
  provider.on('server_error', (_ctx, err) => log.error({ err }, 'OIDC provider error'));

  return provider;
};

export const oidcProvider: FastifyPluginAsync = fp(async (fastify) => {
  const provider = await createProvider();
  const callback = provider.callback();

  await fastify.register(middie);
  fastify.use((req, res, next) => (isProviderPath(req.url) ? callback(req, res) : next()));

  fastify.get<{ Params: { uid: string } }>('/oauth/interaction/:uid', async (_request, reply) =>
    reply.notImplemented('Sign-in at the upstream provider is not available yet'),
  );
});
