import { hkdfSync } from 'node:crypto';
import type { AuthConfig } from '../configuration.ts';

export const derivedKey = (cookieKey: string, purpose: string) => Buffer.from(hkdfSync('sha256', cookieKey, '', `ldacapi ${purpose}`, 32));

/** The admin pages' own client of our provider, which needs no configuration */
export const adminClient = ({ issuer, cookieKeys }: AuthConfig) => ({
  client_id: 'ldacapi-admin',
  client_secret: derivedKey(cookieKeys[0] ?? '', 'admin client secret').toString('base64url'),
  redirect_uris: [`${issuer}/admin/callback`],
  post_logout_redirect_uris: [`${issuer}/admin/`],
  grant_types: ['authorization_code'],
  scope: 'openid profile',
});
