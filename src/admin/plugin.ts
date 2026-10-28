import { fileURLToPath } from 'node:url';
import formBody from '@fastify/formbody';
import secureSession, { type Session, type SessionData } from '@fastify/secure-session';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply } from 'fastify';
import type { AuthConfig } from '../configuration.ts';
import { logger } from '../logger.ts';
import type { Repository } from '../repository.ts';
import { deleteIndexes, type Flash, indexCrates } from './actions.ts';
import { ADMIN_HOME, ADMIN_PATH, ADMIN_SIGNED_OUT, derivedKey } from './client.ts';
import { cratesPage } from './crates.ts';
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

/** What the layout shows around every page */
type Frame = { title: string; user?: string | undefined; flash?: Flash | undefined; refresh?: number | undefined };

/** Each page's template and the data it needs */
type Pages = {
  crates: Frame & ReturnType<typeof cratesPage>;
  'not-an-admin': Frame & { sub: string };
  'signed-out': Frame;
};

const render = <Page extends keyof Pages>(reply: FastifyReply, page: Page, data: Pages[Page], status = 200) => reply.code(status).view(page, data);

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

  fastify.register(fastifyView, {
    engine: { eta: new Eta() },
    root: fileURLToPath(new URL('views', import.meta.url)),
    layout: 'layout',
    defaultContext: { adminPath: ADMIN_PATH },
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
      return render(reply, 'signed-out', { title: 'Signed out' });
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
          return render(reply, 'not-an-admin', { title: 'Not an admin', user: admin.name, sub: admin.sub }, 403);
        }
      });

      pages.get('/', async (request, reply) => {
        const flash = request.session.get('flash');
        if (flash) {
          request.session.set('flash', undefined);
        }
        const objects = await Array.fromAsync(repository.objects());
        return render(reply, 'crates', { title: 'Crates', user: request.session.get('admin')?.name, flash, ...cratesPage(objects) });
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
