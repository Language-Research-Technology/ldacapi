import Fastify from 'fastify';
import { config } from './configuration.ts';

const hasPinoPretty = (() => {
  try {
    import.meta.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
})();

export const fastify = Fastify({
  routerOptions: {
    maxParamLength: config.maxParamLength,
  },
  logger: {
    level: config.logLevel,
    ...(config.isDev &&
      hasPinoPretty && {
        transport: {
          target: 'pino-pretty',
          options: { messageFormat: '[{module}] {msg}', ignore: 'pid,module,hostname' },
        },
      }),
  },
  trustProxy: true, // this is required for auth module to work corractly when the app is behind a reverse proxy. The proxy must set the X-Forwarded-* headers correctly.
});

export const log = fastify.log;

export function firstStringOrId(values: unknown[]): string | undefined {
  for (const value of values || []) {
    if (typeof value === 'string') {
      return value;
    } else if (typeof value === 'object' && value !== null && '@id' in value && typeof value['@id'] === 'string') {
      return value['@id'];
    }
    //return typeof value === 'string' ? value : (value as { '@id'?: string })?.['@id'];
  }
}
