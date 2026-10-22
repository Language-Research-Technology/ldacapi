import {
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  type Configuration,
  calculatePKCECodeChallenge,
  discovery,
  type IDToken,
  randomNonce,
  randomPKCECodeVerifier,
} from 'openid-client';

type UpstreamOptions = { issuer: string; clientId: string; clientSecret: string; redirectUri: string };

/** What the callback needs to check the upstream provider's response against */
export type UpstreamChecks = { state: string; codeVerifier: string; nonce: string };

/** Signs users in at the upstream provider with the authorisation code flow and PKCE */
export const createUpstream = ({ issuer, clientId, clientSecret, redirectUri }: UpstreamOptions) => {
  let discovered: Promise<Configuration> | undefined;

  const configuration = () => {
    const server = new URL(issuer);
    discovered ??= discovery(server, clientId, clientSecret, undefined, {
      // An operator who sets an http issuer has chosen to go without TLS
      execute: server.protocol === 'http:' ? [allowInsecureRequests] : [],
    }).catch((error: unknown) => {
      discovered = undefined;
      throw error;
    });
    return discovered;
  };

  return {
    async authorizationUrl(state: string): Promise<{ url: URL; checks: UpstreamChecks }> {
      const codeVerifier = randomPKCECodeVerifier();
      const nonce = randomNonce();
      const url = buildAuthorizationUrl(await configuration(), {
        redirect_uri: redirectUri,
        scope: 'openid profile email',
        code_challenge: await calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state,
        nonce,
      });
      return { url, checks: { state, codeVerifier, nonce } };
    },

    /** Exchanges the code in the callback's query for the user's validated ID token claims */
    async claims(query: URLSearchParams, checks: UpstreamChecks): Promise<IDToken> {
      const currentUrl = new URL(redirectUri);
      currentUrl.search = query.toString();
      const tokens = await authorizationCodeGrant(await configuration(), currentUrl, {
        pkceCodeVerifier: checks.codeVerifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
      return tokens.claims() as IDToken;
    },
  };
};
