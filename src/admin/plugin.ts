import { fileURLToPath } from 'node:url';
import formBody from '@fastify/formbody';
import secureSession, { type Session, type SessionData } from '@fastify/secure-session';
import fastifyStatic from '@fastify/static';
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply } from 'fastify';
import type { AuthConfig } from '../configuration.ts';
import { logger } from '../logger.ts';
import type { Repository } from '../repository.ts';
import { deleteIndexes, type Flash, indexCrates } from './actions.ts';
import { ADMIN_HOME, ADMIN_PATH, ADMIN_SIGNED_OUT, derivedKey } from './client.ts';
import { cratesPage } from './crates.ts';
import { type Html, html } from './html.ts';
import { layout } from './layout.ts';
import { createSignIn, type SignInTransaction } from './sign-in.ts';

const log = logger.child({ module: 'admin' });

type AdminSession = { sub: string; name: string; signedInAt: number; idToken: string };

declare module '@fastify/secure-session' {
  interface SessionData {
    admin: AdminSession;
    transaction: SignInTransaction;
    flash: Flash;
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

type AdminOptions = { auth: AuthConfig; origin: string; adminUsers: string[]; repository: Repository };

/** The admin pages, for users whose `sub` is in `adminUsers` */
export const adminPages: FastifyPluginAsync<AdminOptions> = async (fastify, { auth, origin, adminUsers, repository }) => {
  const { host, protocol } = new URL(origin);
  const signInFlow = createSignIn(fastify, auth, origin);
  const admins = new Set(adminUsers);
  const cookie = { path: ADMIN_PATH, httpOnly: true, secure: protocol === 'https:', sameSite: 'lax' } as const;
  const sessionOptions = (sessionName: string, cookieName: string, purpose: string, seconds: number) => ({
    sessionName,
    cookieName,
    key: auth.cookieKeys.map((key) => derivedKey(key, purpose)),
    expiry: seconds,
    cookie: { ...cookie, maxAge: seconds },
  });
  const actions = {
    index: (log: FastifyBaseLogger, crateId: string | undefined, force: boolean) => indexCrates(repository, log, crateId, force),
    delete: (log: FastifyBaseLogger, crateId: string | undefined) => deleteIndexes(repository, log, crateId),
  };

  fastify.addHook('onRoute', (route) => {
    route.constraints = { ...route.constraints, host };
  });

  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('content-security-policy', CSP).header('x-frame-options', 'DENY');
    if (request.method === 'POST' && request.headers.origin !== origin) {
      return reply.forbidden('Cross-origin request refused');
    }
  });

  fastify.register(fastifyStatic, { root: fileURLToPath(new URL('public', import.meta.url)), decorateReply: false, index: false });

  fastify.register(async (sessions) => {
    sessions.register(formBody);
    sessions.register(secureSession, [
      sessionOptions('session', 'admin_session', 'admin session', SESSION_SECONDS),
      sessionOptions('signIn', 'admin_sign_in', 'admin sign-in', SIGN_IN_SECONDS),
    ]);

    sessions.get<{ Querystring: Record<string, string> }>('/callback', async (request, reply) => {
      const transaction = request.signIn.get('transaction');
      request.signIn.delete();
      if (!transaction || request.query.state !== transaction.state) {
        return reply.badRequest('Sign-in has expired or was started elsewhere');
      }
      let signedIn: Awaited<ReturnType<typeof signInFlow.finish>>;
      try {
        signedIn = await signInFlow.finish(request.query, transaction);
      } catch (err) {
        log.warn({ err }, 'Sign-in to the admin pages failed');
        return reply.badRequest('Sign-in failed');
      }
      const { sub, name = sub, idToken } = signedIn;
      request.session.set('admin', { sub, name, idToken, signedInAt: Date.now() });
      return reply.redirect(transaction.returnTo, 303);
    });

    sessions.post('/sign-out', async (request, reply) => {
      const admin = request.session.get('admin');
      request.session.delete();
      return reply.redirect(admin ? signInFlow.signOutUrl(admin.idToken).toString() : ADMIN_SIGNED_OUT, 303);
    });

    sessions.get('/signed-out', async (_request, reply) => {
      const body = html`<p>You have signed out. <a href="${ADMIN_HOME}" class="font-medium text-amber-700 underline hover:text-amber-900">Sign in</a></p>`;
      return send(reply, layout({ title: 'Signed out', body }));
    });

    // Every page below needs a current session belonging to an admin
    sessions.register(async (pages) => {
      pages.addHook('onRequest', async (request, reply) => {
        const admin = request.session.get('admin');
        if (!admin || Date.now() - admin.signedInAt >= SESSION_SECONDS * 1000) {
          // Only a GET can be repeated after sign-in
          const { url, transaction } = await signInFlow.start(request.method === 'GET' ? request.url : ADMIN_HOME);
          request.signIn.set('transaction', transaction);
          return reply.redirect(url.toString(), 303);
        }
        if (!admins.has(admin.sub)) {
          const body = html`<div class="max-w-2xl space-y-4 rounded-lg border border-red-200 bg-white p-6 shadow-sm">
      <p class="font-medium text-red-700">You are signed in, but you are not an admin.</p>
      <p>To be given access, ask an operator to add this <code class="font-mono text-sm">sub</code> to <code class="font-mono text-sm">ADMIN_USERS</code>:</p>
      <p><code class="block select-all rounded bg-zinc-100 px-3 py-2 font-mono text-sm break-all">${admin.sub}</code></p>
    </div>`;
          return send(reply, layout({ title: 'Not an admin', user: admin.name, body }), 403);
        }
      });

      pages.get('/', async (request, reply) => {
        const flash = request.session.get('flash');
        if (flash) {
          request.session.set('flash', undefined);
        }
        const objects = await Array.fromAsync(repository.objects());
        return send(reply, layout({ title: 'Crates', user: request.session.get('admin')?.name, flash, ...cratesPage(objects) }));
      });

      for (const [action, run] of Object.entries(actions)) {
        pages.post<{ Body: { crateId?: string; force?: string } }>(`/${action}`, async (request, reply) => {
          const crateId = request.body?.crateId || undefined;
          const force = Boolean(request.body?.force);
          const flash = await run(request.log, crateId, force);
          request.log.info({ sub: request.session.get('admin')?.sub, action, crateId: crateId ?? 'all', force, accepted: flash.accepted }, flash.message);
          request.session.set('flash', flash);
          return reply.redirect(ADMIN_HOME, 303);
        });
      }
    });
  });
};
