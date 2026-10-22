import { generateCookieKey, generateSigningKey } from '../src/oidc/keys.ts';

console.log(`OIDC_SIGNING_KEYS='${JSON.stringify({ keys: [generateSigningKey()] })}'`);
console.log(`OIDC_COOKIE_KEYS='${generateCookieKey()}'`);
