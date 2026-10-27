import type { LightMyRequestResponse } from 'fastify';
import { calculatePKCECodeChallenge, randomPKCECodeVerifier } from 'openid-client';
import type { TestApp } from './app.ts';

/** A browser's cookies, sent with every request to the app */
export class Browser {
  private readonly cookies = new Map<string, string>();
  private readonly app: TestApp;
  private readonly origin: string;

  constructor(app: TestApp, origin: string) {
    this.app = app;
    this.origin = origin;
  }

  async get(url: string, app = this.app) {
    const { pathname, search, host } = new URL(url, this.origin);
    const response = await app.inject({ method: 'GET', url: `${pathname}${search}`, headers: { host, cookie: this.cookieHeader() } });
    this.store(response);
    return response;
  }

  async post(url: string, form: Record<string, string>) {
    const { pathname, search, host } = new URL(url, this.origin);
    const response = await this.app.inject({
      method: 'POST',
      url: `${pathname}${search}`,
      headers: { host, cookie: this.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(form).toString(),
    });
    this.store(response);
    return response;
  }

  /** Follows redirects within the app, returning the first response that leaves it */
  async follow(url: string) {
    let response = await this.get(url);
    let location = response.headers.location as string | undefined;
    while (response.statusCode >= 300 && response.statusCode < 400 && location && new URL(location, this.origin).origin === this.origin) {
      response = await this.get(location);
      location = response.headers.location as string | undefined;
    }
    return response;
  }

  private cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  private store(response: LightMyRequestResponse) {
    for (const { name, value, expires, maxAge } of response.cookies as { name: string; value: string; expires?: Date; maxAge?: number }[]) {
      if (maxAge === 0 || (expires && expires.getTime() <= Date.now()) || !value) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }
}

/** An authorisation request with PKCE, and the verifier that redeems its code */
export const authorizationRequest = async (params: Record<string, string>, endpoint = '/oauth/authorize') => {
  const verifier = randomPKCECodeVerifier();
  const query = new URLSearchParams({
    response_type: 'code',
    code_challenge: await calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    ...params,
  });
  return { url: `${endpoint}?${query}`, verifier };
};
