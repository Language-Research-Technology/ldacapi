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
  randomState,
  type ServerMetadata,
} from 'openid-client';

type Discovered = { issuer: string; clientId: string; clientSecret: string };

/** A provider found by discovery at `issuer`, or one already configured */
type UpstreamOptions = (Discovered | { configuration: Configuration }) & { redirectUri: string; scope: string };

/** What the callback needs to check the upstream provider's response against */
export type UpstreamChecks = { state: string; codeVerifier: string; nonce: string };

// Configuration only allows an http issuer outside production
const insecure = (issuer: string) => (new URL(issuer).protocol === 'http:' ? [allowInsecureRequests] : []);

const allowInsecure = (configuration: Configuration) => {
  for (const apply of insecure(configuration.serverMetadata().issuer)) {
    apply(configuration);
  }
  return configuration;
};

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

const discovered = ({ issuer, clientId, clientSecret }: Discovered) => {
  let found: Promise<Configuration> | undefined;
  return () => {
    found ??= discovery(new URL(issuer), clientId, undefined, undefined, { execute: insecure(issuer) })
      .then((discoveredConfiguration) => {
        const metadata = discoveredConfiguration.serverMetadata();
        return allowInsecure(new Configuration(metadata, clientId, undefined, clientAuth(metadata, clientSecret)));
      })
      .catch((error: unknown) => {
        found = undefined;
        throw error;
      });
    return found;
  };
};

const given = (configuration: Configuration) => {
  const ready = Promise.resolve(allowInsecure(configuration));
  return () => ready;
};

/** Signs users in at a provider with the authorisation code flow and PKCE */
export const createUpstream = (options: UpstreamOptions) => {
  const { redirectUri, scope } = options;
  const configuration = 'configuration' in options ? given(options.configuration) : discovered(options);

  return {
    /** Fetches the upstream discovery document, which sign-ins then reuse; a failure is retried at the next sign-in */
    async discover() {
      await configuration();
    },

    newChecks(state = randomState()): UpstreamChecks {
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

    /** Exchanges the code in the callback's query for the user's ID token and its validated claims */
    async tokens(query: Record<string, string>, checks: UpstreamChecks): Promise<{ claims: IDToken; idToken: string }> {
      const currentUrl = new URL(redirectUri);
      currentUrl.search = new URLSearchParams(query).toString();
      const tokens = await authorizationCodeGrant(await configuration(), currentUrl, {
        pkceCodeVerifier: checks.codeVerifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || !tokens.id_token) {
        throw new Error('No ID token');
      }
      return { claims, idToken: tokens.id_token };
    },
  };
};
