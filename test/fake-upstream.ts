import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export type UpstreamUser = { sub: string; name?: string; email?: string; given_name?: string; family_name?: string };

type PendingCode = { redirectUri: string; nonce: string | undefined; codeChallenge: string; user: UpstreamUser };

/** A minimal upstream OIDC provider on localhost: discovery, JWKS and a token endpoint */
export const startFakeUpstream = async ({ clientId, clientSecret }: { clientId: string; clientSecret: string }) => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'fake', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, PendingCode>();
  let issuer = '';

  const issueTokens = async (body: URLSearchParams, authorization = '') => {
    const [id, secret] = Buffer.from(authorization.replace(/^Basic /, ''), 'base64')
      .toString()
      .split(':');
    const presented = {
      id: decodeURIComponent(id ?? '') || body.get('client_id'),
      secret: decodeURIComponent(secret ?? '') || body.get('client_secret'),
    };
    if (presented.id !== clientId || presented.secret !== clientSecret) {
      return { status: 401, json: { error: 'invalid_client' } };
    }
    const pending = codes.get(body.get('code') ?? '');
    codes.delete(body.get('code') ?? '');
    const challenge = createHash('sha256')
      .update(body.get('code_verifier') ?? '')
      .digest('base64url');
    if (!pending || pending.redirectUri !== body.get('redirect_uri') || pending.codeChallenge !== challenge) {
      return { status: 400, json: { error: 'invalid_grant' } };
    }
    const { sub, ...claims } = pending.user;
    const idToken = await new SignJWT({ ...claims, nonce: pending.nonce })
      .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    return { status: 200, json: { access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken } };
  };

  const server = createServer(async (req, res) => {
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.url === '/.well-known/openid-configuration') {
      return send(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (req.url === '/jwks') {
      return send(200, { keys: [jwk] });
    }
    if (req.url === '/token' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      const { status, json } = await issueTokens(new URLSearchParams(body), req.headers.authorization);
      return send(status, json);
    }
    return send(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    /** Signs `user` in at the authorisation URL we were sent to, and returns where the upstream sends the browser back to */
    signIn(authorizationUrl: string, user: UpstreamUser) {
      const params = new URL(authorizationUrl).searchParams;
      const code = randomBytes(16).toString('hex');
      codes.set(code, {
        redirectUri: params.get('redirect_uri') ?? '',
        nonce: params.get('nonce') ?? undefined,
        codeChallenge: params.get('code_challenge') ?? '',
        user,
      });
      const callback = new URL(params.get('redirect_uri') ?? '');
      callback.search = new URLSearchParams({ code, state: params.get('state') ?? '' }).toString();
      return callback.toString();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
