import formbody from '@fastify/formbody';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { config } from '../configuration.ts';
import { log as plog } from '../utils.ts';

const log = plog.child({ module: 'auth' });

/**
 * This module implements the OpenID Connect (OIDC) authentication standard minimally by acting as a thin proxy for the actual OIDC provider.
 * The only main thing this module does is to inject the client_secret token avoiding having to expost it in the client side application.
 * This is only useful for the backing OIDC provider that artificially limit functionality when using public client mode such as CILogon.
 * The OIDC configuration is fetched from the OIDC provider and cached in memory.
 * The /authorize, /token, and /jwks endpoints are implemented to proxy the corresponding endpoints of the OIDC provider.
 * @param fastify
 * @param _opts
 */
export const auth: FastifyPluginAsync = async (fastify, _opts) => {
  let openidConfig: Record<string, string>;
  let modifiedOpenidConfig: Record<string, string>;
  if (config.oidc.endpoint) {
    const openidConfigUrl = `${config.oidc.endpoint}/.well-known/openid-configuration`;
    fetch(openidConfigUrl)
      .then(async (response) => {
        if (response.ok) {
          openidConfig = await response.json();
          config.oidc.userinfoEndpoint = openidConfig.userinfo_endpoint ?? '';
        } else {
          throw new Error(`Failed to fetch ${openidConfigUrl}: ${response.statusText}`);
        }
      })
      .catch((error) => {
        log.error(error);
      });
  }

  //let openidConfig: Record<string, string>;
  //console.log(opts);
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.register(formbody);

  app.get('/.well-known/openid-configuration', async (request, reply) => {
    if (openidConfig) {
      //const baseUrl = `${request.protocol}://${request.host}${config.prefix}`;
      const baseUrl = `${request.protocol}://${request.host}${config.prefixAuth || config.prefix || ''}`;
      if (!modifiedOpenidConfig) {
        modifiedOpenidConfig = {
          ...openidConfig,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          jwks_uri: `${baseUrl}/jwks`,
        };
      }
      return reply.send(modifiedOpenidConfig);
    } else {
      return reply.notFound();
    }
  });

  app.get('/authorize', async (request, reply) =>
    openidConfig?.authorization_endpoint
      ? reply.redirect(openidConfig.authorization_endpoint + request.url.slice(request.url.indexOf('?')), 301)
      : reply.notFound(),
  );

  app.get('/jwks', async (_request, reply) => {
    if (!openidConfig?.jwks_uri) {
      return reply.notFound();
    }
    try {
      const result = await fetch(openidConfig.jwks_uri);
      reply.header('content-type', result.headers.get('content-type'));
      return reply.code(result.status).send(result.body);
    } catch (error) {
      return reply.internalServerError((error as Error).message);
    }
  });

  app.post('/token', async (request, reply) => {
    if (!openidConfig?.token_endpoint) {
      return reply.notFound();
    }
    const incoming = request.body as Record<string, string>;
    incoming.client_secret = config.oidc.clientSecret;
    //console.log(incoming);
    if (incoming.client_id !== config.oidc.clientId) {
      return reply.badRequest('Invalid client_id');
    }
    try {
      const result = await fetch(openidConfig.token_endpoint, {
        method: 'POST',
        body: new URLSearchParams(incoming),
      });
      //result.headers.forEach((value, key) => { reply.header(key, value) });
      reply.header('pragma', result.headers.get('pragma') || 'no-cache');
      reply.header('date', result.headers.get('date'));
      reply.header('set-cookie', result.headers.get('set-cookie'));
      const body = await result.json();
      /** 
       * example:
          {
            access_token: 'NB2H...',
            refresh_token: 'NB2H...',
            refresh_token_lifetime: 2592000,
            id_token: 'eyJraWQ...(JWT)',
            token_type: 'Bearer',
            expires_in: 900,
            refresh_token_iat: 1780982488
          }      
       */
      return reply.code(result.status).send(body);
    } catch (error) {
      return reply.internalServerError((error as Error).message);
    }
  });
};
