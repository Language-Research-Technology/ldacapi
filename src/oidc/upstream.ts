import {
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  ClientSecretBasic,
  ClientSecretPost,
  Configuration,
  calculatePKCECodeChallenge,
  discovery,
  type IDToken,
  randomNonce,
  randomPKCECodeVerifier,
  type ServerMetadata,
} from 'openid-client';

type UpstreamOptions = { issuer: string; clientId: string; clientSecret: string; redirectUri: string; scope: string };

/** What the callback needs to check the upstream provider's response against */
export type UpstreamChecks = { state: string; codeVerifier: string; nonce: string };

// Prefers Basic, which OIDC makes the default when the provider lists no methods
const clientAuth = ({ token_endpoint_auth_methods_supported: supported }: ServerMetadata, clientSecret: string) => {
  if (!supported || supported.includes('client_secret_basic')) {
    return ClientSecretBasic(clientSecret);
  }
  if (supported.includes('client_secret_post')) {
    return ClientSecretPost(clientSecret);
  }
  throw new Error(`The upstream provider supports none of client_secret_basic or client_secret_post at its token endpoint, only: ${supported.join(', ')}`);
};

/** Signs users in at the upstream provider with the authorisation code flow and PKCE */
export const createUpstream = ({ issuer, clientId, clientSecret, redirectUri, scope }: UpstreamOptions) => {
  let discovered: Promise<Configuration> | undefined;
  const configuration = () => {
    const server = new URL(issuer);
    // Configuration only allows an http issuer outside production
    const execute = server.protocol === 'http:' ? [allowInsecureRequests] : [];
    discovered ??= discovery(server, clientId, undefined, undefined, { execute })
      .then((found) => {
        const configured = new Configuration(found.serverMetadata(), clientId, undefined, clientAuth(found.serverMetadata(), clientSecret));
        for (const apply of execute) {
          apply(configured);
        }
        return configured;
      })
      .catch((error: unknown) => {
        discovered = undefined;
        throw error;
      });
    return discovered;
  };

  return {
    /** Fetches the upstream discovery document, which sign-ins then reuse; a failure is retried at the next sign-in */
    async discover() {
      await configuration();
    },

    newChecks(state: string): UpstreamChecks {
      return { state, codeVerifier: randomPKCECodeVerifier(), nonce: randomNonce() };
    },

    async authorizationUrl({ state, codeVerifier, nonce }: UpstreamChecks) {
      return buildAuthorizationUrl(await configuration(), {
        redirect_uri: redirectUri,
        scope,
        code_challenge: await calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state,
        nonce,
      });
    },

    /** Exchanges the code in the callback's query for the user's validated ID token claims */
    async claims(query: Record<string, string>, checks: UpstreamChecks): Promise<IDToken> {
      const currentUrl = new URL(redirectUri);
      currentUrl.search = new URLSearchParams(query).toString();
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
