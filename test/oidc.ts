import type { LightMyRequestResponse } from 'fastify';
import { calculatePKCECodeChallenge, randomPKCECodeVerifier } from 'openid-client';
import type { TestApp } from './app.ts';

/** A browser's cookies, kept per host and sent with every request to the app at any of its origins */
export class Browser {
  private readonly cookies = new Map<string, Map<string, string>>();
  private readonly app: TestApp;
  /** Where relative URLs go */
  private readonly origin: string;
  private readonly origins: Set<string>;
  /** Where the last `follow` ended */
  url = '';

  constructor(app: TestApp, origin: string, ...otherOrigins: string[]) {
    this.app = app;
    this.origin = origin;
    this.origins = new Set([origin, ...otherOrigins]);
  }

  async get(url: string, app = this.app) {
    const target = new URL(url, this.origin);
    const response = await app.inject({
      method: 'GET',
      url: `${target.pathname}${target.search}`,
      headers: { host: target.host, cookie: this.cookieHeader(target) },
    });
    this.store(target, response);
    return response;
  }

  /** Posts `form` with the `Origin` a browser sends from a page at `url`'s origin, unless `headers` say otherwise */
  async post(url: string, form: Record<string, string>, headers?: Record<string, string>) {
    const target = new URL(url, this.origin);
    const response = await this.app.inject({
      method: 'POST',
      url: `${target.pathname}${target.search}`,
      headers: {
        host: target.host,
        cookie: this.cookieHeader(target),
        'content-type': 'application/x-www-form-urlencoded',
        ...(headers ?? { origin: target.origin }),
      },
      payload: new URLSearchParams(form).toString(),
    });
    this.store(target, response);
    return response;
  }

  /** Follows redirects within the app's origins, returning the first response that leaves them */
  async follow(url: string) {
    this.url = url;
    let current = new URL(url, this.origin);
    let response = await this.get(current.toString());
    let location = response.headers.location as string | undefined;
    while (response.statusCode >= 300 && response.statusCode < 400 && location && this.origins.has(new URL(location, current).origin)) {
      this.url = location;
      current = new URL(location, current);
      response = await this.get(current.toString());
      location = response.headers.location as string | undefined;
    }
    return response;
  }

  /** The cookie `name` for the host relative URLs go to */
  cookie(name: string) {
    return this.jar(new URL(this.origin)).get(name);
  }

  setCookie(name: string, value: string) {
    this.jar(new URL(this.origin)).set(name, value);
  }

  private jar({ hostname }: URL) {
    let jar = this.cookies.get(hostname);
    if (!jar) {
      jar = new Map();
      this.cookies.set(hostname, jar);
    }
    return jar;
  }

  private cookieHeader(url: URL) {
    return [...this.jar(url)].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
  }

  private store(url: URL, response: LightMyRequestResponse) {
    const jar = this.jar(url);
    for (const { name, value, expires, maxAge } of response.cookies as { name: string; value: string; expires?: Date; maxAge?: number }[]) {
      if (maxAge === 0 || (expires && expires.getTime() <= Date.now()) || !value) {
        jar.delete(name);
      } else {
        jar.set(name, value);
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
