import { type LoggerOptions, pino } from 'pino';
import { config } from './configuration.ts';

const resolvePinoPretty = () => import.meta.resolve('pino-pretty');

const installed = (resolve: () => unknown) => {
  try {
    resolve();
    return true;
  } catch {
    return false;
  }
};

/** Pretty-prints in development, when pino-pretty (a dev dependency) is installed */
export const loggerOptions = ({ logLevel, isDev }: Pick<typeof config, 'logLevel' | 'isDev'>, resolvePrettyPrinter = resolvePinoPretty): LoggerOptions => ({
  level: logLevel,
  ...(isDev &&
    installed(resolvePrettyPrinter) && {
      transport: {
        target: 'pino-pretty',
        options: { messageFormat: '{if module}[{module}] {end}{msg}', ignore: 'pid,module,hostname' },
      },
    }),
});

export const logger = pino(loggerOptions(config));
