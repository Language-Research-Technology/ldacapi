import { afterEach, describe, expect, it } from 'vitest';
import { startFakeUpstream } from '../../test/fake-upstream.ts';
import { createUpstream } from './upstream.ts';

const CLIENT = { clientId: 'ldacapi', clientSecret: 'upstream-secret' };
const ALICE = { sub: 'alice@upstream', name: 'Alice Example' };

let upstream: Awaited<ReturnType<typeof startFakeUpstream>> | undefined;

afterEach(async () => {
  await upstream?.close();
  upstream = undefined;
});

const start = async (tokenEndpointAuthMethod: 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt') => {
  upstream = await startFakeUpstream({ ...CLIENT, tokenEndpointAuthMethod });
  return createUpstream({ issuer: upstream.issuer, ...CLIENT, redirectUri: 'http://localhost:8080/oauth/callback', scope: 'openid profile' });
};

describe('authenticating at the upstream token endpoint', () => {
  it.each(['client_secret_basic', 'client_secret_post'] as const)('signs a user in at an upstream provider that only supports %s', async (method) => {
    const client = await start(method);
    const checks = client.newChecks('state');
    const callback = new URL(upstream?.signIn((await client.authorizationUrl(checks)).toString(), ALICE) ?? '');

    const { claims } = await client.tokens(Object.fromEntries(callback.searchParams), checks);

    expect(claims).toMatchObject(ALICE);
  });

  it('names the methods an upstream provider supports when it supports neither client secret method', async () => {
    const client = await start('private_key_jwt');

    await expect(client.discover()).rejects.toThrow(/only: private_key_jwt/);
  });
});
