import { hkdfSync } from 'node:crypto';
import type { AuthConfig } from '../configuration.ts';

export const ADMIN_PATH = '/admin';

export const derivedKey = (cookieKey: string, purpose: string) => Buffer.from(hkdfSync('sha256', cookieKey, '', `ldacapi ${purpose}`, 32));

export const adminRedirectUri = (adminOrigin: string) => `${adminOrigin}${ADMIN_PATH}/callback`;

export const adminPostLogoutRedirectUri = (adminOrigin: string) => `${adminOrigin}${ADMIN_PATH}/`;

/** The admin pages' own client of our provider, which needs no configuration */
export const adminClient = ({ cookieKeys }: AuthConfig, adminOrigin: string) => ({
  client_id: 'ldacapi-admin',
  client_secret: derivedKey(cookieKeys[0] ?? '', 'admin client secret').toString('base64url'),
  redirect_uris: [adminRedirectUri(adminOrigin)],
  post_logout_redirect_uris: [adminPostLogoutRedirectUri(adminOrigin)],
  grant_types: ['authorization_code'],
  scope: 'openid profile',
});
