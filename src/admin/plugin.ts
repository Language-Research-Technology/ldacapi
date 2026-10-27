import { fileURLToPath } from 'node:url';
import formBody from '@fastify/formbody';
import secureSession, { type Session, type SessionData } from '@fastify/secure-session';
import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { decodeJwt } from 'jose';
import type { AuthConfig } from '../configuration.ts';
import { logger } from '../logger.ts';
import { derivedKey } from './client.ts';
import { type Html, html } from './html.ts';
import { layout } from './layout.ts';
import { createSignIn, type SignInTransaction } from './sign-in.ts';

const log = logger.child({ module: 'admin' });

type AdminSession = { sub: string; signedInAt: number; idToken: string };

declare module '@fastify/secure-session' {
  interface SessionData {
    admin: AdminSession;
    transaction: SignInTransaction;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    signIn: Session<SessionData>;
  }
}

const SESSION_SECONDS = 8 * 60 * 60;
const SIGN_IN_SECONDS = 10 * 60;

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const send = (reply: FastifyReply, page: Html, status = 200) => reply.code(status).type('text/html; charset=utf-8').send(page.toString());

const displayName = (idToken: string) => {
  const { name, sub } = decodeJwt(idToken);
  return typeof name === 'string' && name ? name : sub;
};

type AdminOptions = { auth: AuthConfig; adminUsers: string[] };

/** The admin pages, for users whose `sub` is in `adminUsers` */
export const adminPages: FastifyPluginAsync<AdminOptions> = async (fastify, { auth, adminUsers }) => {
  const issuer = new URL(auth.issuer);
  const signIn = createSignIn(fastify, auth);
  const admins = new Set(adminUsers);
  const cookie = { path: '/admin', httpOnly: true, secure: issuer.protocol === 'https:', sameSite: 'lax' } as const;
  const keys = (purpose: string) => auth.cookieKeys.map((key) => derivedKey(key, purpose));

  fastify.register(formBody);
  fastify.register(fastifyStatic, { root: fileURLToPath(new URL('public', import.meta.url)), decorateReply: false, index: false });
  fastify.register(secureSession, [
    {
      sessionName: 'session',
      cookieName: 'admin_session',
      key: keys('admin session'),
      expiry: SESSION_SECONDS,
      cookie: { ...cookie, maxAge: SESSION_SECONDS },
    },
    { sessionName: 'signIn', cookieName: 'admin_sign_in', key: keys('admin sign-in'), expiry: SIGN_IN_SECONDS, cookie: { ...cookie, maxAge: SIGN_IN_SECONDS } },
  ]);

  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('content-security-policy', CSP).header('x-frame-options', 'DENY');
    if (request.method === 'POST' && request.headers.origin !== issuer.origin) {
      return reply.forbidden('Cross-origin request refused');
    }
  });

  fastify.get<{ Querystring: Record<string, string> }>('/callback', async (request, reply) => {
    const transaction = request.signIn.get('transaction');
    request.signIn.delete();
    if (!transaction || request.query.state !== transaction.state) {
      return reply.badRequest('Sign-in has expired or was started elsewhere');
    }
    let signedIn: Awaited<ReturnType<typeof signIn.finish>>;
    try {
      signedIn = await signIn.finish(request.query, transaction);
    } catch (err) {
      log.warn({ err }, 'Sign-in to the admin pages failed');
      return reply.badRequest('Sign-in failed');
    }
    request.session.set('admin', { ...signedIn, signedInAt: Date.now() });
    return reply.redirect(transaction.returnTo, 303);
  });

  fastify.post('/sign-out', async (request, reply) => {
    const session = request.session.get('admin');
    request.session.delete();
    return reply.redirect(session ? signIn.signOutUrl(session.idToken).toString() : '/admin/', 303);
  });

  // Every page below needs a current session belonging to an admin
  fastify.register(async (pages) => {
    pages.addHook('onRequest', async (request, reply) => {
      const session = request.session.get('admin');
      if (!session || Date.now() - session.signedInAt >= SESSION_SECONDS * 1000) {
        const { url, transaction } = await signIn.start(request.url);
        request.signIn.set('transaction', transaction);
        return reply.redirect(url.toString(), 303);
      }
      if (!admins.has(session.sub)) {
        const body = html`<div class="max-w-2xl space-y-4 rounded-lg border border-red-200 bg-white p-6 shadow-sm">
      <p class="font-medium text-red-700">You are signed in, but you are not an admin.</p>
      <p>To be given access, ask an operator to add this <code class="font-mono text-sm">sub</code> to <code class="font-mono text-sm">ADMIN_USERS</code>:</p>
      <p><code class="block select-all rounded bg-zinc-100 px-3 py-2 font-mono text-sm break-all">${session.sub}</code></p>
    </div>`;
        return send(reply, layout({ title: 'Not an admin', user: displayName(session.idToken), body }), 403);
      }
    });

    pages.get('/', async (request, reply) => {
      const user = displayName(request.session.get('admin')?.idToken ?? '');
      return send(reply, layout({ title: 'Admin', user, body: html`<p>You are signed in as ${user}, and you are an admin.</p>` }));
    });
  });
};
