import type { FastifyInstance } from 'fastify';
import {
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  buildEndSessionUrl,
  Configuration,
  calculatePKCECodeChallenge,
  customFetch,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from 'openid-client';
import type { AuthConfig } from '../configuration.ts';
import { adminClient } from './client.ts';

/** What the callback checks the provider's response against, and where it sends the browser after */
export type SignInTransaction = { state: string; codeVerifier: string; nonce: string; returnTo: string };

/** Signs admins in at our own provider, reaching its token endpoint in-process rather than through our public URL */
export const createSignIn = (fastify: FastifyInstance, auth: AuthConfig) => {
  const client = adminClient(auth);
  const [redirectUri = ''] = client.redirect_uris;
  const [postLogoutRedirectUri = ''] = client.post_logout_redirect_uris;
  const configuration = new Configuration(
    {
      issuer: auth.issuer,
      authorization_endpoint: `${auth.issuer}/oauth/authorize`,
      token_endpoint: `${auth.issuer}/oauth/token`,
      end_session_endpoint: `${auth.issuer}/oauth/session/end`,
    },
    client.client_id,
    client.client_secret,
  );
  if (new URL(auth.issuer).protocol === 'http:') {
    allowInsecureRequests(configuration);
  }
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

  return {
    async start(returnTo: string) {
      const transaction: SignInTransaction = { state: randomState(), codeVerifier: randomPKCECodeVerifier(), nonce: randomNonce(), returnTo };
      const url = buildAuthorizationUrl(configuration, {
        redirect_uri: redirectUri,
        scope: client.scope,
        code_challenge: await calculatePKCECodeChallenge(transaction.codeVerifier),
        code_challenge_method: 'S256',
        state: transaction.state,
        nonce: transaction.nonce,
      });
      return { url, transaction };
    },

    /** The ID token from the callback's query, once it checks out against the transaction */
    async finish(query: Record<string, string>, { state, codeVerifier, nonce }: SignInTransaction) {
      const currentUrl = new URL(redirectUri);
      currentUrl.search = new URLSearchParams(query).toString();
      const tokens = await authorizationCodeGrant(configuration, currentUrl, {
        pkceCodeVerifier: codeVerifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || !tokens.id_token) {
        throw new Error('No ID token');
      }
      return { sub: claims.sub, idToken: tokens.id_token };
    },

    signOutUrl(idToken: string) {
      return buildEndSessionUrl(configuration, { id_token_hint: idToken, post_logout_redirect_uri: postLogoutRedirectUri });
    },
  };
};
