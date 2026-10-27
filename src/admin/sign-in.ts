import type { FastifyInstance } from 'fastify';
import { buildEndSessionUrl, Configuration, customFetch } from 'openid-client';
import type { AuthConfig } from '../configuration.ts';
import { routes } from '../oidc/provider.ts';
import { createUpstream, type UpstreamChecks } from '../oidc/upstream.ts';
import { adminClient, adminPostLogoutRedirectUri, adminRedirectUri } from './client.ts';

/** What the callback checks the provider's response against, and where it sends the browser after */
export type SignInTransaction = UpstreamChecks & { returnTo: string };

/** Signs admins in at our own provider, reaching its token endpoint in-process rather than through our public URL */
export const createSignIn = (fastify: FastifyInstance, auth: AuthConfig) => {
  const { issuer } = auth;
  const client = adminClient(auth);
  const configuration = new Configuration(
    {
      issuer,
      authorization_endpoint: `${issuer}${routes.authorization}`,
      token_endpoint: `${issuer}${routes.token}`,
      end_session_endpoint: `${issuer}${routes.end_session}`,
    },
    client.client_id,
    client.client_secret,
  );
  configuration[customFetch] = async (url, { method, headers, body }) => {
    const { pathname, search } = new URL(url);
    const response = await fastify.inject({
      method: method as 'POST',
      url: `${pathname}${search}`,
      headers,
      ...(body === undefined ? {} : { payload: String(body) }),
    });
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      for (const each of [value ?? []].flat()) {
        responseHeaders.append(name, String(each));
      }
    }
    return new Response(response.body, { status: response.statusCode, headers: responseHeaders });
  };
  const flow = createUpstream({ configuration, redirectUri: adminRedirectUri(issuer), scope: client.scope });

  return {
    async start(returnTo: string) {
      const checks = flow.newChecks();
      return { url: await flow.authorizationUrl(checks), transaction: { ...checks, returnTo } satisfies SignInTransaction };
    },

    /** Who signed in, once the callback's query checks out against the transaction */
    async finish(query: Record<string, string>, transaction: SignInTransaction) {
      const { claims, idToken } = await flow.tokens(query, transaction);
      return { sub: claims.sub, name: typeof claims.name === 'string' && claims.name ? claims.name : undefined, idToken };
    },

    signOutUrl(idToken: string) {
      return buildEndSessionUrl(configuration, { id_token_hint: idToken, post_logout_redirect_uri: adminPostLogoutRedirectUri(issuer) });
    },
  };
};
