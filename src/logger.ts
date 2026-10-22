import { pino } from 'pino';
import { config } from './configuration.ts';

const hasPinoPretty = (() => {
  try {
    import.meta.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
})();

export const logger = pino({
  level: config.logLevel,
  ...(config.isDev &&
    hasPinoPretty && {
      transport: {
        target: 'pino-pretty',
        options: { messageFormat: '{if module}[{module}] {end}{msg}', ignore: 'pid,module,hostname' },
      },
    }),
});
